import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Uses a fresh project/data folder and a synthetic video. All main-process
// fetches are intercepted before any generation action. No real API key,
// provider request, paid generation, or user project is used.
//   npm run build && node scripts/qa-generation.mjs
//   CUTLINE_PACKAGED=1 node scripts/qa-generation.mjs
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const executable =
  process.env.CUTLINE_EXECUTABLE ??
  path.join(
    root,
    packaged
      ? "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline"
      : "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
const parent = path.resolve(
  process.env.CUTLINE_GENERATION_RESULTS ?? path.join(root, "../qa-generation"),
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "user-data");
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: data,
  CUTLINE_PROJECTS_DIR: path.join(work, "projects"),
};
delete env.ELECTRON_RUN_AS_NODE;
const fakeKey = "cutline-qa-only-never-a-real-provider-key";
const report = {
  work,
  runtime: null,
  checks: [],
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
  network: [],
  failed: null,
};
let app;
let page;
const check = (message, detail) => {
  report.checks.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message);
};
const invoke = (name, args) =>
  page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
    name,
    args,
  });
const project = async () => (await invoke("state")).snapshot.project;
const generateTab = () =>
  page
    .locator(".library-tabs button")
    .filter({ hasText: /^Generate$/ })
    .first();
const panel = () => page.locator(".generation-library");
const storyPanel = () => page.locator(".story-library");
const waitJob = async (predicate, message) => {
  let last;
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await invoke("generation.list");
    const found = last.find(predicate);
    if (found) return found;
    await page.waitForTimeout(100);
  }
  throw Error(`${message}: ${JSON.stringify(last)}`);
};
const screenshot = async (name, width, height) => {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
    },
    { width, height },
  );
  // macOS can constrain a native window to the display's available height.
  // Emulate the requested content viewport so the larger capture is exact.
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(180);
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert.deepEqual(
    viewport,
    { width, height },
    "Requested QA viewport is active",
  );
  const overflow = await page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 1)
      problems.push(
        `document ${document.documentElement.scrollWidth} > ${innerWidth}`,
      );
    for (const element of document.querySelectorAll(
      ".generation-library, .generation-library input, .generation-library textarea, .generation-library select, .generation-library button, .story-library, .story-library input, .story-library textarea, .story-library select, .story-library button",
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
      if (bounds.right > innerWidth + 1 || bounds.left < -1)
        problems.push(
          `${element.tagName}.${element.className} crosses viewport`,
        );
      if (
        element.matches(".generation-library, .story-library") &&
        element.scrollWidth > element.clientWidth + 1
      )
        problems.push(
          `Library panel ${element.scrollWidth} > ${element.clientWidth}`,
        );
    }
    return problems;
  });
  const file = path.join(work, `${width}x${height}-${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push({ name, width, height, viewport, file, overflow });
  assert.deepEqual(
    overflow,
    [],
    `${name}: horizontal overflow at ${width}×${height}`,
  );
};
const captureBoth = async (name) => {
  for (const [width, height] of [
    [1440, 960],
    [1100, 760],
  ])
    await screenshot(name, width, height);
};

try {
  const fixture = path.join(work, "synthetic-fixture.mp4");
  const render = spawnSync(
    path.join(root, "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg"),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x598b7b:s=320x180:r=24:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      fixture,
    ],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, `Synthetic fixture: ${render.stderr}`);
  const videoBase64 = (await readFile(fixture)).toString("base64");
  app = await electron.launch({
    executablePath: executable,
    args: [...(packaged ? [] : [root]), "--force-color-profile=srgb"],
    env,
  });
  report.runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
  }));
  assert.equal(
    report.runtime.userData,
    data,
    "QA uses only the isolated data directory",
  );
  assert.equal(
    report.runtime.packaged,
    packaged,
    "Requested source/installed runtime is active",
  );
  // Fresh credentials are empty at launch. Install a fail-closed fetch before
  // adding our dummy key. Even an unexpected endpoint cannot reach a provider.
  await app.evaluate((_electron, fixtureData) => {
    const qa = { calls: [], submissions: 0, polls: 0, mode: "success" };
    globalThis.__cutlineGenerationQA = qa;
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
        /\/text-to-video$/.test(url.pathname)
      ) {
        qa.submissions++;
        qa.polls = 0;
        return json({
          request_id: `a1111111-1111-4111-8111-${String(qa.submissions).padStart(12, "0")}`,
          status: "queued",
        });
      }
      if (
        url.origin === "https://api.higgsfield.ai" &&
        method === "GET" &&
        /\/requests\/[^/]+\/status$/.test(url.pathname)
      ) {
        qa.polls++;
        if (qa.mode === "delay-queued") {
          qa.pollInFlight = true;
          return new Promise((resolve) => {
            qa.releasePoll = () => resolve(json({ status: "queued" }));
          });
        }
        if (qa.mode === "queued") return json({ status: "queued" });
        if (qa.mode === "pending" || qa.polls === 1)
          return json({ status: "in_progress" });
        return json({
          status: "completed",
          video: { url: "https://example.com/cutline-qa-fixture.mp4" },
        });
      }
      if (
        url.origin === "https://api.higgsfield.ai" &&
        method === "POST" &&
        /\/requests\/[^/]+\/cancel$/.test(url.pathname)
      )
        return new Response(null, { status: 202 });
      if (
        url.href === "https://example.com/cutline-qa-fixture.mp4" &&
        method === "GET"
      ) {
        if (headers.get("authorization"))
          throw Error("Credential leaked to media host");
        return new Response(Buffer.from(fixtureData, "base64"), {
          headers: { "Content-Type": "video/mp4" },
        });
      }
      throw Error(
        `QA blocked unexpected network request: ${method} ${url.href}`,
      );
    };
  }, videoBase64);
  page = await app.firstWindow({ timeout: 90000 });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar", { timeout: 60000 });
  await generateTab().click();
  await expect(panel()).toBeVisible();
  assert.equal((await invoke("generation.settings")).configured, false);
  await captureBoth("disconnected");
  // The key lives in Settings; the panel points there.
  await panel()
    .getByRole("button", { name: "Open Settings", exact: true })
    .click();
  const settingsModal = () => page.locator(".settings-modal");
  await expect(
    settingsModal().getByLabel("Higgsfield API key", { exact: true }),
  ).toHaveAttribute("type", "password");
  await expect(
    settingsModal().getByRole("button", {
      name: "Connect Higgsfield",
      exact: true,
    }),
  ).toBeDisabled();
  await settingsModal()
    .getByLabel("Higgsfield API key", { exact: true })
    .scrollIntoViewIfNeeded();
  await captureBoth("settings-video-generation");
  check(
    "Disconnected Generate panel points to Settings; key masked there, empty connect disabled, responsive at both window sizes",
  );

  const keyField = settingsModal().getByLabel("Higgsfield API key", {
    exact: true,
  });
  await keyField.fill("bad key");
  // Validate at the main-process boundary too; the renderer cannot bypass it.
  await assert.rejects(
    invoke("generation.configure", { key: "bad key" }),
    /key|spaces/i,
  );
  assert.equal((await invoke("generation.settings")).configured, false);
  await keyField.fill(fakeKey);
  await settingsModal()
    .getByRole("button", { name: "Connect Higgsfield", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await invoke("generation.settings")).configured)
    .toBe(true);
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(panel().getByText("Higgsfield connected")).toBeVisible();
  const credentialFile = path.join(data, "higgsfield-credentials.json");
  assert(!(await readFile(credentialFile, "utf8")).includes(fakeKey));
  assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
  await expect(panel().getByLabel("Prompt", { exact: true })).toBeVisible();
  check(
    "Keyboard connection and main-process credential validation passed with a dummy key",
  );

  const prompt = panel().getByLabel("Prompt", { exact: true });
  const submit = panel().getByRole("button", {
    name: "Generate video",
    exact: true,
  });
  await prompt.fill("   ");
  await expect(submit).toBeDisabled();
  await prompt.fill(
    "A slow cinematic push through a sunlit greenhouse. Soft leaves move in the breeze.",
  );
  await prompt.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.tagName),
    "SELECT",
    "Prompt keyboard order reaches the model control",
  );
  await expect(submit).toBeEnabled();
  await captureBoth("ready-to-generate");
  await panel().getByLabel("Model", { exact: true }).selectOption("kling-3");
  await expect(panel().getByLabel("Resolution", { exact: true })).toHaveCount(
    0,
  );
  await panel().getByLabel("Duration", { exact: true }).selectOption("3");
  await captureBoth("kling-settings");
  await panel().getByLabel("Model", { exact: true }).selectOption("seedance-2");
  await expect(panel().getByLabel("Duration", { exact: true })).toHaveValue(
    "4",
  );
  await panel().getByLabel("Duration", { exact: true }).selectOption("5");
  check("Prompt validation and keyboard form controls passed");

  const before = await project();
  await submit.focus();
  await page.keyboard.press("Enter");
  let job = await waitJob(
    (candidate) => !!candidate.requestId,
    "Fixture request was not accepted",
  );
  assert.equal(
    (await project()).assets.length,
    before.assets.length,
    "Submitting does not import media automatically",
  );
  await captureBoth("queued");
  for (let i = 0; i < 3 && job.status !== "completed"; i++) {
    const statusButton = panel().getByRole("button", {
      name: "Check status",
      exact: true,
    });
    if (await statusButton.count()) await statusButton.click();
    job = await waitJob(
      (candidate) =>
        candidate.id === job.id && candidate.status !== "submitting",
      "Fixture status did not update",
    );
    await page.waitForTimeout(150);
  }
  job = await waitJob(
    (candidate) => candidate.id === job.id && candidate.status === "completed",
    "Fixture did not complete",
  );
  assert.equal(job.status, "completed");
  await expect(
    panel().getByRole("button", { name: "Import to media", exact: true }),
  ).toBeVisible();
  await captureBoth("completed");
  assert(
    !JSON.stringify(await invoke("generation.list")).includes(fakeKey),
    "Credentials are absent from public jobs",
  );
  assert(
    !JSON.stringify(await invoke("generation.list")).includes("example.com"),
    "Signed output URLs are absent from public jobs",
  );
  await panel()
    .getByRole("button", { name: "Import to media", exact: true })
    .click();
  await expect
    .poll(async () => (await project()).assets.length, { timeout: 30000 })
    .toBe(before.assets.length + 1);
  const afterImport = await project();
  assert.equal(
    afterImport.clips.length,
    before.clips.length,
    "Import is separate from timeline placement",
  );
  const imported = afterImport.assets.find(
    (asset) => !before.assets.some((previous) => previous.id === asset.id),
  );
  assert.equal(imported.kind, "video");
  assert(
    imported.path.startsWith(data + path.sep),
    "Generated asset stays in isolated QA data",
  );
  await expect(
    panel().getByRole("button", { name: "Add at playhead", exact: true }),
  ).toBeVisible();
  await panel()
    .getByRole("button", { name: "Add at playhead", exact: true })
    .click();
  await expect
    .poll(async () => (await project()).clips.length)
    .toBe(before.clips.length + 1);
  await captureBoth("imported-at-playhead");
  check(
    "Mocked request queued, completed, downloaded, imported, and placed on the editable timeline",
  );
  await app.evaluate(() => {
    globalThis.__cutlineGenerationQA.mode = "delay-queued";
    globalThis.__cutlineGenerationQA.pollInFlight = false;
  });
  await prompt.fill(
    "A gentle ocean wave, held in a queue for the cancellation fixture.",
  );
  await submit.click();
  const queued = await waitJob(
    (candidate) => candidate.id !== job.id && candidate.status === "queued",
    "Cancellation fixture was not queued",
  );
  await expect
    .poll(
      async () =>
        app.evaluate(() => globalThis.__cutlineGenerationQA.pollInFlight),
      { timeout: 15000 },
    )
    .toBe(true);
  // Allow the renderer's five-second polling cycle to join the pending main
  // request, then cancel while that status check is still unresolved.
  await page.waitForTimeout(5200);
  const queuedCard = panel()
    .locator(".generation-job")
    .filter({ hasText: queued.prompt });
  await queuedCard.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    queuedCard.getByRole("button", { name: "Canceling…", exact: true }),
  ).toBeVisible();
  await app.evaluate(() => {
    const qa = globalThis.__cutlineGenerationQA;
    qa.mode = "queued";
    qa.releasePoll();
  });
  await waitJob(
    (candidate) =>
      candidate.id === queued.id && candidate.status === "canceled",
    "Cancel did not execute after polling completed",
  );
  await expect(queuedCard.getByText("Canceled", { exact: true })).toBeVisible();
  await captureBoth("canceled-during-poll");
  check(
    "Queued cancellation remains actionable during an in-flight automatic status poll",
  );

  // The Story workflow submits through its own controller, then the Story UI's
  // ordinary polling attaches finished shots to the saved scene. Keep the same
  // fail-closed transport and dummy credentials for both explicit requests.
  await app.evaluate(() => {
    globalThis.__cutlineGenerationQA.mode = "success";
  });
  const storyBefore = await project();
  const sceneId = "qa-story-ninja";
  await invoke("story.save", {
    projectId: storyBefore.id,
    revision: storyBefore.revision,
    story: {
      brief: "A short silent ninja story for isolated integration QA.",
      style: "Cinematic moonlit blue",
      scenes: [
        {
          id: sceneId,
          title: "Ninja crosses the stream",
          narration: "",
          visualPrompt:
            "A ninja leaps across a stream in a moonlit bamboo forest.",
          duration: 5,
        },
      ],
      captions: false,
    },
  });
  await page
    .locator(".library-tabs button")
    .filter({ hasText: /^Story$/ })
    .first()
    .click();
  await expect(storyPanel()).toBeVisible();
  await storyPanel()
    .getByRole("button", { name: "Produce scenes", exact: true })
    .click();
  const firstShot = storyPanel().getByRole("button", {
    name: "Generate this shot",
    exact: true,
  });
  await expect(firstShot).toBeEnabled();
  const storySubmissionsBefore = await app.evaluate(
    () => globalThis.__cutlineGenerationQA.submissions,
  );
  assert.equal(storySubmissionsBefore, 2);
  await firstShot.click();
  await expect
    .poll(async () =>
      app.evaluate(() => globalThis.__cutlineGenerationQA.submissions),
    )
    .toBe(storySubmissionsBefore + 1);
  await expect
    .poll(
      async () => {
        const p = await project();
        const scene = p.story?.scenes.find((item) => item.id === sceneId);
        return (
          !!scene?.generationId &&
          scene.assetId === scene.generationId &&
          p.assets.some((asset) => asset.id === scene.assetId)
        );
      },
      {
        timeout: 45000,
        message:
          "Story polling automatically imports and links its completed shot",
      },
    )
    .toBe(true);
  const firstStoryProject = await project();
  const firstStoryScene = firstStoryProject.story.scenes[0];
  const firstStoryGeneration = firstStoryScene.generationId;
  assert.equal(firstStoryProject.assets.length, storyBefore.assets.length + 1);
  assert.equal(
    firstStoryProject.clips.length,
    storyBefore.clips.length,
    "Producing a story shot does not assemble the timeline",
  );
  const firstStoryJob = (await invoke("generation.list")).find(
    (item) => item.id === firstStoryGeneration,
  );
  assert.equal(firstStoryJob.status, "completed");
  assert.equal(firstStoryJob.downloaded, true);
  assert.equal(
    firstStoryJob.prompt,
    "Cinematic moonlit blue\n\nA ninja leaps across a stream in a moonlit bamboo forest.",
  );
  await expect(
    storyPanel().getByLabel("Scene visual asset", { exact: true }),
  ).toHaveValue(firstStoryGeneration);
  await captureBoth("story-shot-linked");
  check(
    "Story Produce submitted exactly one shot and automatically downloaded, imported, and linked it to the scene",
  );

  // A replacement is a deliberate second click. The prior media stays usable
  // while the request runs and the automatic poll attaches the new asset only
  // after it has completed; no change to the user's other media or timeline.
  const generator = storyPanel().locator("details.story-shot-generator");
  if (!(await generator.evaluate((element) => element.open)))
    await generator.locator(":scope > summary").click();
  const anotherShot = storyPanel().getByRole("button", {
    name: "Generate another shot",
    exact: true,
  });
  await expect(anotherShot).toBeEnabled();
  await app.evaluate(() => {
    globalThis.__cutlineGenerationQA.mode = "pending";
  });
  await anotherShot.click();
  await expect
    .poll(async () =>
      app.evaluate(() => globalThis.__cutlineGenerationQA.submissions),
    )
    .toBe(storySubmissionsBefore + 2);
  const replacingStory = (await project()).story.scenes[0];
  assert.notEqual(replacingStory.generationId, firstStoryGeneration);
  assert.equal(
    replacingStory.assetId,
    firstStoryGeneration,
    "The previous shot remains selected while its replacement generates",
  );
  const secondStoryGeneration = replacingStory.generationId;
  await app.evaluate(() => {
    globalThis.__cutlineGenerationQA.mode = "success";
  });
  await expect
    .poll(
      async () => {
        const p = await project();
        const scene = p.story?.scenes.find((item) => item.id === sceneId);
        return (
          scene?.generationId === secondStoryGeneration &&
          scene.assetId === secondStoryGeneration &&
          p.assets.some((asset) => asset.id === scene.assetId)
        );
      },
      {
        timeout: 45000,
        message:
          "Story polling replaces an old selected shot after the new generation completes",
      },
    )
    .toBe(true);
  const replacementProject = await project();
  assert.equal(replacementProject.assets.length, storyBefore.assets.length + 2);
  assert(
    replacementProject.assets.some(
      (asset) => asset.id === firstStoryGeneration,
    ),
    "Previous generated media remains in the library",
  );
  assert.deepEqual(
    replacementProject.clips,
    storyBefore.clips,
    "Shot replacement preserves every existing timeline clip",
  );
  const savedSnapshot = (await invoke("state")).snapshot;
  assert(
    savedSnapshot.filePath?.startsWith(path.join(work, "projects") + path.sep),
    "Story project is saved only in the isolated QA project directory",
  );
  const savedDocument = JSON.parse(
    await readFile(savedSnapshot.filePath, "utf8"),
  );
  assert.deepEqual(
    (savedDocument.project ?? savedDocument).story,
    JSON.parse(JSON.stringify(replacementProject.story)),
    "Saved file contains the complete storyline and new generation link",
  );
  await expect(
    storyPanel().getByLabel("Scene visual asset", { exact: true }),
  ).toHaveValue(secondStoryGeneration);
  await captureBoth("story-replacement-linked");
  await page.waitForTimeout(10500);
  assert.equal(
    await app.evaluate(() => globalThis.__cutlineGenerationQA.submissions),
    storySubmissionsBefore + 2,
    "Story background polls never submit additional generation requests",
  );
  check(
    "A deliberate Story replacement kept old media, attached the new shot, persisted the story, and performed no automatic paid retries",
  );

  report.network = await app.evaluate(
    () => globalThis.__cutlineGenerationQA.calls,
  );
  assert.equal(
    await app.evaluate(() => globalThis.__cutlineGenerationQA.submissions),
    4,
    "Exactly four explicitly requested fixture submits; no automatic paid retries",
  );
  assert(
    report.network.some(
      (call) => call.url.includes("example.com") && !call.authenticated,
    ),
  );
  assert.deepEqual(report.pageErrors, [], "No renderer exceptions");
  assert.deepEqual(report.consoleErrors, [], "No renderer console errors");
  check(
    "No page errors, console errors, horizontal overflow, or duplicate submissions",
  );
} catch (error) {
  report.failed = error.stack ?? String(error);
  if (page)
    await page
      .screenshot({ path: path.join(work, "failure.png") })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) {
    report.network = await app
      .evaluate(() => globalThis.__cutlineGenerationQA?.calls ?? [])
      .catch(() => report.network);
    await app.close().catch(() => {});
  }
  await writeFile(
    path.join(work, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
