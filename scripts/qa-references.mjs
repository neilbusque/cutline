import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import sharp from "sharp";

// Disposable native IPC/UI integration. Every main-process fetch is replaced
// before configuring a dummy credential; unexpected traffic fails closed.
// Uses actual PNG/JPEG/WebP files and native picker IPC with a stubbed dialog.
// npm run build && node scripts/qa-references.mjs
// CUTLINE_PACKAGED=1 CUTLINE_EXECUTABLE=/Applications/Cutline.app/Contents/MacOS/Cutline node scripts/qa-references.mjs
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const parent = path.resolve(
  process.env.CUTLINE_REFERENCE_RESULTS ?? path.join(root, "../qa-references"),
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "user-data");
const projectFile = path.join(work, "reference-story.cutline");
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: data,
  CUTLINE_PROJECTS_DIR: path.join(work, "projects"),
};
delete env.ELECTRON_RUN_AS_NODE;
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const fakeKey = "cutline-reference-qa-not-a-real-key";
const report = {
  work,
  runtime: null,
  checks: [],
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
  network: [],
  requests: [],
  dialogs: [],
  blocked: [],
  failed: null,
};
let app, page;
const check = (message, detail) => {
  report.checks.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message);
};
const invoke = (name, args) =>
  page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
    name,
    args,
  });
const current = async () => (await invoke("state")).snapshot.project;
const guard = async () => {
  const p = await current();
  return { projectId: p.id, revision: p.revision };
};
const panel = () => page.locator(".generation-library");
const story = () => page.locator(".story-library");
const tab = (label) =>
  page
    .locator(".library-tabs button")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first();
const queueFiles = (files, canceled = false) =>
  app.evaluate(
    (_electron, selection) => {
      globalThis.__cutlineReferencesQA.picks.push(selection);
    },
    { filePaths: files, canceled },
  );
const transport = () =>
  app.evaluate(() => {
    const qa = globalThis.__cutlineReferencesQA;
    return {
      calls: qa.calls,
      requests: qa.requests,
      uploads: qa.uploads,
      dialogs: qa.dialogs,
      blocked: qa.blocked,
    };
  });
const generationInput = async (extra = {}) => ({
  clientId: randomUUID(),
  projectId: (await current()).id,
  prompt:
    "The first image guides the character, the second the setting. Slow cinematic movement.",
  model: "seedance-2",
  duration: 5,
  resolution: "720p",
  aspectRatio: "9:16",
  audio: false,
  ...extra,
});
const referenceNames = async (list) =>
  list.locator(".reference-description > span").allTextContents();
const validThumbnails = async (list, count) => {
  await expect(list.locator("img")).toHaveCount(count);
  await list.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      list
        .locator("img")
        .evaluateAll((images) =>
          images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true);
};
const waitJob = async (id) => {
  await expect
    .poll(
      async () => {
        const job = (await invoke("generation.list")).find(
          (item) => item.id === id,
        );
        if (job && job.status !== "completed")
          await invoke("generation.refresh", { id });
        return (await invoke("generation.list")).find((item) => item.id === id)
          ?.downloaded;
      },
      { timeout: 30000 },
    )
    .toBe(true);
};
const captureBoth = async (name, target) => {
  for (const [width, height] of [
    [1440, 960],
    [1100, 760],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(
          size.width,
          size.height,
        ),
      { width, height },
    );
    await page.setViewportSize({ width, height });
    if (target) await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(180);
    const layout = await page.evaluate(() => {
      const overflow = [];
      if (document.documentElement.scrollWidth > innerWidth + 1)
        overflow.push("document horizontal overflow");
      for (const element of document.querySelectorAll(
        ".generation-library, .story-library, .generation-library :is(input,textarea,select,button), .story-library :is(input,textarea,select,button), .reference-images",
      )) {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          !bounds.width ||
          !bounds.height ||
          style.display === "none" ||
          style.visibility === "hidden"
        )
          continue;
        if (bounds.left < -1 || bounds.right > innerWidth + 1)
          overflow.push(
            `${element.tagName}.${element.className} crosses viewport`,
          );
        if (
          element.matches(
            ".generation-library,.story-library,.reference-images",
          ) &&
          element.scrollWidth > element.clientWidth + 1
        )
          overflow.push(`${element.className} horizontal overflow`);
      }
      return { width: innerWidth, height: innerHeight, overflow };
    });
    assert.deepEqual(
      { width: layout.width, height: layout.height },
      { width, height },
    );
    const file = path.join(work, `${width}x${height}-${name}.png`);
    await page.screenshot({ path: file });
    report.screenshots.push({ name, width, height, file, layout });
    assert.deepEqual(layout.overflow, [], `${name} fits ${width}×${height}`);
  }
};

try {
  const fixtures = [
    { name: "Ninja-character.png", color: "0x284657", type: "image/png" },
    { name: "Bamboo-setting.jpg", color: "0x386344", type: "image/jpeg" },
    { name: "Amber-lantern.webp", color: "0xce983c", type: "image/webp" },
  ];
  for (const fixture of fixtures) {
    fixture.path = path.join(work, fixture.name);
    await sharp({
      create: {
        width: 240,
        height: 320,
        channels: 3,
        background: fixture.color.replace("0x", "#"),
      },
    }).toFile(fixture.path);
    fixture.base64 = (await readFile(fixture.path)).toString("base64");
  }
  const badImage = path.join(work, "not-an-image.png");
  await writeFile(badImage, "This is not image content.");
  const video = path.join(work, "synthetic-shot.mp4");
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x598b7b:s=180x320:r=24:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  app = await electron.launch({
    executablePath:
      process.env.CUTLINE_EXECUTABLE ??
      process.env.CUTLINE_APP_EXECUTABLE ??
      path.join(
        root,
        packaged
          ? "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline"
          : "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    // A mock keychain: a real one prompts for access and stalls the app.
    args: [
      ...(packaged ? [] : [root]),
      "--force-color-profile=srgb",
      "--use-mock-keychain",
    ],
    env,
  });
  report.runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
  }));
  assert.equal(report.runtime.userData, data);
  assert.equal(report.runtime.packaged, packaged);
  await app.evaluate(
    ({ dialog }, config) => {
      const qa = {
        picks: [],
        dialogs: [],
        calls: [],
        requests: [],
        uploads: [],
        blocked: [],
        nextUpload: 0,
      };
      globalThis.__cutlineReferencesQA = qa;
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        qa.dialogs.push({
          title: options.title,
          properties: options.properties,
          filters: options.filters,
        });
        const selected = qa.picks.shift();
        if (!selected) throw Error("QA picker used without a queued fixture");
        return selected;
      };
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: config.projectFile,
      });
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(
          typeof input === "string" ? input : (input.url ?? String(input)),
        );
        const method = (options.method ?? "GET").toUpperCase();
        const headers = new Headers(options.headers);
        qa.calls.push({
          url: url.href,
          method,
          authenticated: !!headers.get("authorization"),
        });
        const json = (value, status = 200) =>
          new Response(JSON.stringify(value), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        if (
          url.origin === "https://api.higgsfield.ai" &&
          method === "POST" &&
          url.pathname === "/files/generate-upload-url"
        ) {
          const index = ++qa.nextUpload;
          const body = JSON.parse(options.body);
          return json({
            public_url: `https://example.com/references/${index}`,
            upload_url: `https://example.com/uploads/${index}`,
            upload_headers: {
              "Content-Type": body.content_type,
              "x-amz-tagging": "retention=temporary",
              "x-qa-upload": String(index),
            },
          });
        }
        if (
          url.origin === "https://example.com" &&
          method === "PUT" &&
          url.pathname.startsWith("/uploads/")
        ) {
          if (headers.has("authorization") || headers.has("cookie"))
            throw Error("Credential leaked to reference storage");
          if (
            headers.get("x-amz-tagging") !== "retention=temporary" ||
            headers.get("x-qa-upload") !== url.pathname.split("/").at(-1)
          )
            throw Error("A provider upload header was omitted");
          const base64 = Buffer.from(options.body).toString("base64");
          const fixture = config.fixtures.find(
            (item) => item.base64 === base64,
          );
          if (!fixture)
            throw Error("Upload does not match an exact synthetic image");
          if (headers.get("content-type") !== fixture.type)
            throw Error("Upload MIME does not match image bytes");
          qa.uploads.push({
            url: url.href.replace("/uploads/", "/references/"),
            name: fixture.name,
            type: fixture.type,
          });
          return new Response(null, { status: 200 });
        }
        if (
          url.origin === "https://api.higgsfield.ai" &&
          method === "POST" &&
          /^\/bytedance\/seedance-2\.0\/(reference|image|text)-to-video$/.test(
            url.pathname,
          )
        ) {
          const body = JSON.parse(options.body);
          qa.requests.push({
            endpoint: url.pathname,
            body,
            key: headers.get("idempotency-key"),
          });
          const number = qa.requests.length;
          return json({
            request_id: `a1111111-1111-4111-8111-${String(number).padStart(12, "0")}`,
            status: "queued",
          });
        }
        if (
          url.origin === "https://api.higgsfield.ai" &&
          method === "GET" &&
          /^\/requests\/[^/]+\/status$/.test(url.pathname)
        )
          return json({
            status: "completed",
            video: { url: "https://example.com/reference-fixture.mp4" },
          });
        if (
          url.href === "https://example.com/reference-fixture.mp4" &&
          method === "GET"
        ) {
          if (headers.has("authorization") || headers.has("cookie"))
            throw Error("Credential leaked to output storage");
          return new Response(Buffer.from(config.videoBase64, "base64"), {
            headers: { "Content-Type": "video/mp4" },
          });
        }
        qa.blocked.push({ url: url.href, method });
        throw Error(
          `QA blocked unexpected network request: ${method} ${url.href}`,
        );
      };
    },
    {
      projectFile,
      fixtures,
      videoBase64: (await readFile(video)).toString("base64"),
    },
  );
  page = await app.firstWindow({ timeout: 90000 });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar", { timeout: 60000 });
  assert.equal((await invoke("generation.settings")).configured, false);
  await tab("Generate").click();
  await panel()
    .getByRole("button", { name: "Open Settings", exact: true })
    .click();
  const settingsModal = page.locator(".settings-modal");
  await settingsModal
    .getByLabel("Higgsfield API key", { exact: true })
    .fill(fakeKey);
  await settingsModal
    .getByRole("button", { name: "Connect Higgsfield", exact: true })
    .click();
  await expect
    .poll(async () => (await invoke("generation.settings")).configured)
    .toBe(true);
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  check(
    "Disposable profile connected only to a fake credential after fail-closed transport installation",
  );

  await queueFiles([], true);
  assert.equal(await invoke("generation.pickReferences"), null);
  await queueFiles([badImage]);
  await assert.rejects(
    invoke("generation.pickReferences"),
    /image|unsupported/i,
  );
  await queueFiles([fixtures[0].path]);
  const nativeSingle = await invoke("generation.pickReference");
  assert.equal(nativeSingle.name, fixtures[0].name);
  assert(nativeSingle.id && nativeSingle.previewUrl);
  await queueFiles(fixtures.map((item) => item.path));
  const nativeMultiple = await invoke("generation.pickReferences");
  assert.deepEqual(
    nativeMultiple.map((item) => item.name),
    fixtures.map((item) => item.name),
  );
  assert(nativeMultiple.every((item) => item.id && item.previewUrl));
  assert.equal(
    (await transport()).calls.length,
    0,
    "Choosing images performs no upload",
  );
  const singleDialog = (await transport()).dialogs.at(-2);
  const multipleDialog = (await transport()).dialogs.at(-1);
  assert(!singleDialog.properties.includes("multiSelections"));
  assert(multipleDialog.properties.includes("multiSelections"));
  check(
    "Single and multiple native picker IPC return previews; cancellation and bad image bytes are handled without network",
  );

  const input = panel().getByLabel("Visual input", { exact: true });
  const submit = panel().getByRole("button", {
    name: "Generate video",
    exact: true,
  });
  await panel()
    .getByLabel("Prompt", { exact: true })
    .fill(
      "Use image 1 for the setting, image 2 for the character, and image 3 for the lantern. Gentle cinematic tracking shot.",
    );
  await input.selectOption("references");
  await expect(submit).toBeDisabled();
  await queueFiles(fixtures.map((item) => item.path));
  await panel()
    .getByRole("button", { name: "Add reference images", exact: true })
    .click();
  const refs = panel().getByRole("list", {
    name: "Video reference images",
    exact: true,
  });
  await validThumbnails(refs, 3);
  assert.deepEqual(
    await referenceNames(refs),
    fixtures.map((item) => item.name),
  );
  await refs
    .getByRole("button", { name: "Move image 2 earlier", exact: true })
    .click();
  assert.deepEqual(await referenceNames(refs), [
    fixtures[1].name,
    fixtures[0].name,
    fixtures[2].name,
  ]);
  await refs
    .getByRole("button", {
      name: `Remove image 3: ${fixtures[2].name}`,
      exact: true,
    })
    .click();
  await expect(refs.locator("li")).toHaveCount(2);
  await queueFiles([fixtures[2].path]);
  await panel()
    .getByRole("button", { name: "Add reference images", exact: true })
    .click();
  await validThumbnails(refs, 3);
  await panel()
    .getByLabel("Aspect ratio", { exact: true })
    .selectOption("9:16");
  await panel().getByLabel("Generate audio", { exact: true }).uncheck();
  await captureBoth("ordered-generation-references", refs);
  assert.equal((await transport()).requests.length, 0);
  await submit.click();
  await expect.poll(async () => (await transport()).requests.length).toBe(1);
  let net = await transport();
  const request = net.requests[0];
  assert.equal(request.endpoint, "/bytedance/seedance-2.0/reference-to-video");
  assert.deepEqual(
    Object.keys(request.body).sort(),
    [
      "prompt",
      "image_urls",
      "duration",
      "resolution",
      "aspect_ratio",
      "generate_audio",
    ].sort(),
  );
  assert.equal(request.body.aspect_ratio, "9:16");
  assert.equal(request.body.generate_audio, false);
  assert.deepEqual(
    request.body.image_urls.map(
      (url) => net.uploads.find((item) => item.url === url).name,
    ),
    [fixtures[1].name, fixtures[0].name, fixtures[2].name],
  );
  await waitJob(request.key);
  await captureBoth("completed-reference-generation", refs);
  check(
    "References UI renders all three formats, reorders/removes images, and submits the exact displayed ordered image_urls",
  );

  // The legacy singular starting-frame contract must remain distinct.
  await input.selectOption("start");
  await expect(submit).toBeDisabled();
  await queueFiles([fixtures[0].path]);
  await panel()
    .getByRole("button", { name: "Add start image", exact: true })
    .click();
  await validThumbnails(
    panel().getByRole("list", { name: "Starting frame", exact: true }),
    1,
  );
  await expect(panel().getByLabel("Aspect ratio", { exact: true })).toHaveCount(
    0,
  );
  await captureBoth(
    "starting-frame",
    panel().getByRole("list", { name: "Starting frame", exact: true }),
  );
  await submit.click();
  await expect.poll(async () => (await transport()).requests.length).toBe(2);
  net = await transport();
  const legacy = net.requests[1];
  assert.equal(legacy.endpoint, "/bytedance/seedance-2.0/image-to-video");
  assert.equal(
    net.uploads.find((item) => item.url === legacy.body.image_url).name,
    fixtures[0].name,
  );
  assert(!("image_urls" in legacy.body) && !("aspect_ratio" in legacy.body));
  await waitJob(legacy.key);
  await input.selectOption("text");
  await expect(
    panel().getByLabel("Aspect ratio", { exact: true }),
  ).toBeVisible();
  check(
    "Starting-frame UI retains singular image_url and image-derived framing; text mode restores aspect ratio",
  );

  // Boundary rejection happens before any upload or paid model submission.
  const callsBeforeInvalid = (await transport()).calls.length;
  await assert.rejects(
    invoke("generation.submit", await generationInput({ referenceIds: [] })),
    /array|at least|reference|small/i,
  );
  await assert.rejects(
    invoke(
      "generation.submit",
      await generationInput({
        referenceIds: Array.from({ length: 10 }, () => randomUUID()),
      }),
    ),
    /array|9|reference|big/i,
  );
  await assert.rejects(
    invoke(
      "generation.submit",
      await generationInput({
        referenceIds: [nativeSingle.id],
        referenceId: nativeSingle.id,
      }),
    ),
    /starting|reference|both/i,
  );
  await assert.rejects(
    invoke(
      "generation.submit",
      await generationInput({
        referenceIds: [nativeSingle.id, nativeSingle.id],
      }),
    ),
    /once|reference/i,
  );
  await rename(fixtures[2].path, fixtures[2].path + ".missing");
  try {
    await assert.rejects(
      invoke(
        "generation.submit",
        await generationInput({
          referenceIds: nativeMultiple.map((item) => item.id),
        }),
      ),
      /ENOENT|missing|image|file/i,
    );
  } finally {
    await rename(fixtures[2].path + ".missing", fixtures[2].path);
  }
  assert.equal((await transport()).calls.length, callsBeforeInvalid);
  check(
    "Empty, excessive, duplicate, mixed-mode, and missing-file references are rejected before upload or generation",
  );

  const sceneId = "qa-reference-ninja";
  await invoke("story.save", {
    ...(await guard()),
    story: {
      brief: "Keep the ninja, bamboo and lantern consistent.",
      style: "Cinematic blue moonlight",
      scenes: [
        {
          id: sceneId,
          title: "Lantern in the bamboo",
          narration: "",
          visualPrompt:
            "A ninja carries an amber lantern through bamboo. Slow tracking camera.",
          duration: 5,
        },
      ],
      captions: false,
    },
  });
  const beforeImport = await current();
  await queueFiles(fixtures.map((item) => item.path));
  const imported = await invoke("story.importReferences", await guard());
  assert.equal(imported.assets.length, 3);
  assert(imported.assets.every((asset) => asset.kind === "image"));
  assert.deepEqual(
    (await current()).story,
    beforeImport.story,
    "Importing references does not rewrite the story",
  );
  assert.equal((await current()).clips.length, beforeImport.clips.length);
  assert.equal((await transport()).requests.length, 2);
  await queueFiles([], true);
  assert.equal(await invoke("story.importReferences", await guard()), null);
  check(
    "Story native image import adds image assets, preserves the story/timeline, and cancellation is harmless",
  );

  const shared = [imported.assets[0].id, imported.assets[1].id];
  const sceneOnly = [imported.assets[2].id];
  await tab("Story").click();
  await expect(story()).toBeVisible();
  const sharedDetails = story()
    .locator("details.story-reference-section")
    .filter({
      has: page.locator("summary", { hasText: "Shared reference images" }),
    });
  if (!(await sharedDetails.evaluate((element) => element.open)))
    await sharedDetails.locator("summary").click();
  await queueFiles([badImage, video]);
  await story()
    .getByRole("button", {
      name: "Import shared reference images",
      exact: true,
    })
    .click();
  await expect(
    story().getByText(/Some images could not be imported:/),
  ).toContainText(/not-an-image|synthetic-shot/);
  assert.equal(
    (await current()).assets.length,
    beforeImport.assets.length + 3,
    "Invalid reference imports add no assets",
  );
  await story()
    .getByLabel("Add shared image from media", { exact: true })
    .selectOption(shared[0]);
  await story()
    .getByLabel("Add shared image from media", { exact: true })
    .selectOption(shared[1]);
  const sharedList = story().getByRole("list", {
    name: "Shared story reference images",
    exact: true,
  });
  await validThumbnails(sharedList, 2);
  await sharedList
    .getByRole("button", { name: "Move image 2 earlier", exact: true })
    .click();
  assert.deepEqual(await referenceNames(sharedList), [
    fixtures[1].name,
    fixtures[0].name,
  ]);
  await sharedList
    .getByRole("button", { name: "Move image 1 later", exact: true })
    .click();
  await story()
    .getByRole("button", { name: "Save storyline", exact: true })
    .click();
  await expect
    .poll(async () => (await current()).story.referenceAssetIds)
    .toEqual(shared);
  await captureBoth("story-shared-references", sharedList);
  await story()
    .getByRole("button", { name: "Produce scenes", exact: true })
    .click();
  const shotDetails = story().locator("details.story-scene-references");
  if (!(await shotDetails.evaluate((element) => element.open)))
    await shotDetails.locator("summary").click();
  await story()
    .getByLabel("Add scene image from media", { exact: true })
    .selectOption(sceneOnly[0]);
  const shotList = story().getByRole("list", {
    name: "Shot reference images in generation order",
    exact: true,
  });
  await validThumbnails(shotList, 3);
  assert.deepEqual(
    await referenceNames(shotList),
    fixtures.map((item) => item.name),
  );
  await expect(
    shotList.getByRole("button", {
      name: `Remove image 1: ${fixtures[0].name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await shotList
    .getByRole("button", {
      name: `Remove image 3: ${fixtures[2].name}`,
      exact: true,
    })
    .click();
  await expect(shotList.locator("li")).toHaveCount(2);
  await queueFiles([fixtures[2].path]);
  await story()
    .getByRole("button", { name: "Import scene reference images", exact: true })
    .click();
  await validThumbnails(shotList, 3);
  await story()
    .getByRole("button", { name: "Save storyline", exact: true })
    .click();
  await expect
    .poll(async () => (await current()).story.scenes[0].referenceAssetIds)
    .toEqual(sceneOnly);
  await captureBoth("story-scene-references", shotList);
  check(
    "Story UI adds/reorders shared references, adds/removes/imports scene references, and reports invalid file selections",
  );
  await invoke("save");
  const savedSnapshot = (await invoke("state")).snapshot;
  const savedPath = savedSnapshot.filePath;
  assert(
    savedPath && savedPath.startsWith(work + path.sep),
    "Saved reference story stays in isolated directory",
  );
  const savedDocument = JSON.parse(await readFile(savedPath, "utf8"));
  const saved = (savedDocument.project ?? savedDocument).story;
  assert.deepEqual(saved.referenceAssetIds, shared);
  assert.deepEqual(saved.scenes[0].referenceAssetIds, sceneOnly);
  await invoke("test.load", { path: savedPath });
  assert.deepEqual((await current()).story, saved);
  check(
    "Shared and scene reference asset IDs persist through an actual save and reopen",
  );

  // Unsaved reference edits belong to their project and must survive a
  // round-trip to another local project, without rewriting either saved file.
  await story()
    .getByRole("navigation", { name: "Story workflow" })
    .getByRole("button", { name: /Story/ })
    .click();
  await sharedList
    .getByRole("button", {
      name: `Remove image 2: ${fixtures[1].name}`,
      exact: true,
    })
    .click();
  await expect(sharedList.locator("li")).toHaveCount(1);
  const alternatePath = path.join(work, "alternate.cutline");
  const alternate = {
    ...(await current()),
    id: randomUUID(),
    name: "Alternate QA project",
    revision: 0,
    assets: [],
    clips: [],
  };
  delete alternate.story;
  await writeFile(
    alternatePath,
    JSON.stringify({
      project: alternate,
      past: [],
      future: [],
      filePath: alternatePath,
    }),
  );
  await invoke("test.load", { path: alternatePath });
  await expect.poll(async () => (await current()).id).toBe(alternate.id);
  await expect(
    story().getByRole("list", {
      name: "Shared story reference images",
      exact: true,
    }),
  ).toHaveCount(0);
  await invoke("test.load", { path: savedPath });
  await expect.poll(async () => (await current()).id).toBe(beforeImport.id);
  await expect(sharedList.locator("li")).toHaveCount(1);
  assert.deepEqual(await referenceNames(sharedList), [fixtures[0].name]);
  assert.deepEqual(
    (await current()).story.referenceAssetIds,
    shared,
    "Persisted project keeps both images until the restored draft is saved",
  );
  await story()
    .getByLabel("Add shared image from media", { exact: true })
    .selectOption(shared[1]);
  await story()
    .getByRole("button", { name: "Save storyline", exact: true })
    .click();
  await expect
    .poll(async () => (await current()).story.referenceAssetIds)
    .toEqual(shared);
  check(
    "Dirty reference edits survive A to B to A switching without leaking into another project or rewriting saved references",
  );

  // Include the same shared image at scene level to prove unique effective
  // ordering; only the scene-specific third image should add an upload.
  let p = await current();
  await invoke("story.save", {
    ...(await guard()),
    story: {
      ...p.story,
      scenes: p.story.scenes.map((scene) => ({
        ...scene,
        referenceAssetIds: [shared[0], ...sceneOnly],
      })),
    },
  });
  await story()
    .getByRole("navigation", { name: "Story workflow" })
    .getByRole("button", { name: /Produce/ })
    .click();
  await story()
    .getByRole("button", { name: "Generate this shot", exact: true })
    .click();
  await expect.poll(async () => (await transport()).requests.length).toBe(3);
  await expect
    .poll(
      async () => {
        const project = await current();
        const scene = project.story.scenes[0];
        return (
          !!scene.generationId &&
          scene.assetId === scene.generationId &&
          project.assets.some((asset) => asset.id === scene.assetId)
        );
      },
      { timeout: 45000 },
    )
    .toBe(true);
  net = await transport();
  const sceneRequest = net.requests[2];
  assert.equal(
    sceneRequest.endpoint,
    "/bytedance/seedance-2.0/reference-to-video",
  );
  assert.deepEqual(
    sceneRequest.body.image_urls.map(
      (url) => net.uploads.find((item) => item.url === url).name,
    ),
    fixtures.map((item) => item.name),
  );
  assert.equal(sceneRequest.body.generate_audio, false);
  assert.equal((await current()).clips.length, beforeImport.clips.length);
  const linkedGenerator = story().locator("details.story-shot-generator");
  if (!(await linkedGenerator.evaluate((element) => element.open)))
    await linkedGenerator.locator(":scope > summary").click();
  if (!(await shotDetails.evaluate((element) => element.open)))
    await shotDetails.locator("summary").click();
  await captureBoth("story-reference-shot-linked", shotList);
  check(
    "Story generation merges shared + scene references uniquely in order, then automatically imports and links the completed shot",
  );
  await page.waitForTimeout(10500);
  net = await transport();
  assert.equal(
    net.requests.length,
    3,
    "Exactly three explicit mocked generation requests",
  );
  assert.equal(
    net.uploads.length,
    7,
    "Exactly three references, one starting frame, and three merged story references uploaded",
  );
  assert.deepEqual(
    net.blocked,
    [],
    "No unexpected provider/network requests attempted",
  );
  assert.deepEqual(report.pageErrors, [], "No renderer errors");
  assert.deepEqual(report.consoleErrors, [], "No console errors");
  check(
    "No automatic paid retries, credential leaks, unexpected network, overflow, or renderer errors",
  );
} catch (error) {
  report.failed = error.stack ?? String(error);
  await page
    ?.screenshot({ path: path.join(work, "failure.png") })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) {
    const net = await transport().catch(() => null);
    if (net) {
      report.network = net.calls;
      report.requests = net.requests;
      report.dialogs = net.dialogs;
      report.blocked = net.blocked;
    }
    await app.close().catch(() => {});
  }
  await writeFile(
    path.join(work, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
