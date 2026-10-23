import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Disposable UI + real local render coverage. All provider traffic is blocked.
// The original Cutline product artwork and local soundtrack may be shared.
// npm run build && node scripts/qa-product-film.mjs
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const parent = path.resolve(
  process.env.CUTLINE_PRODUCT_RESULTS ?? path.join(root, "../qa-product-film"),
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "user-data");
const projectFile = path.join(work, "Cutline-Product-Film.cutline");
const output = path.join(work, "Cutline-Product-Film.mp4");
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const run = (binary, args) =>
  execFileSync(binary, args, {
    encoding: "buffer",
    timeout: 240000,
    maxBuffer: 64000000,
  });
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: data,
  CUTLINE_PROJECTS_DIR: path.join(work, "projects"),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  work,
  runtime: null,
  checks: [],
  screenshots: [],
  typography: [],
  parity: [],
  pageErrors: [],
  consoleErrors: [],
  network: [],
  export: null,
  audioMix: null,
  assets: [],
  failed: null,
};
let app, page, mcp;
const check = (message, detail) => {
  report.checks.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message);
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const invoke = (name, args) =>
  page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
    name,
    args,
  });
const current = async () => (await invoke("state")).snapshot.project;
const guard = (project) => ({
  projectId: project.id,
  revision: project.revision,
});
const tx = async (commands) =>
  invoke("edit", {
    ...guard(await current()),
    label: "Product film QA",
    commands,
  });
const panel = () => page.locator(".story-library");
const stage = async (name) =>
  panel()
    .getByRole("navigation", { name: "Story workflow" })
    .getByRole("button", { name: new RegExp(name) })
    .click();
const call = async (name, args = {}, expectError = false) => {
  const reply = await mcp.callTool({ name, arguments: args });
  const body = reply.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (expectError) {
    assert(reply.isError, `${name} should reject`);
    return body;
  }
  assert(!reply.isError, `${name}: ${body}`);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};
const waitProject = async (predicate, message, timeout = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const project = await current();
    if (predicate(project)) {
      await page.waitForTimeout(120);
      return project;
    }
    await page.waitForTimeout(80);
  }
  const alerts = await page.getByRole("alert").allTextContents();
  throw Error(`${message}: ${alerts.join(" ")}`);
};
const saveStory = async () => {
  const before = (await current()).revision;
  await panel()
    .getByRole("button", { name: "Save storyline", exact: true })
    .click();
  return waitProject(
    (project) => project.revision > before,
    "Story draft did not save",
  );
};
const recipe = async (name) => {
  await stage("Story");
  const summary = panel().locator(".story-product-film > summary");
  if (!(await summary.evaluate((element) => element.parentElement.open)))
    await summary.click();
  await panel()
    .getByRole("button", { name: `Use ${name} recipe`, exact: true })
    .click();
  const confirm = panel().getByRole("button", {
    name: "Replace storyline with recipe",
    exact: true,
  });
  if (await confirm.isVisible()) await confirm.click();
  return saveStory();
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
    await panel().evaluate((element) => {
      element.scrollTop = 0;
    });
    if (target) await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => {
      const problems = [];
      if (document.documentElement.scrollWidth > innerWidth + 1)
        problems.push("document horizontal overflow");
      for (const element of document.querySelectorAll(
        ".story-library,.story-library input,.story-library textarea,.story-library select,.story-library button",
      )) {
        const box = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        if (
          !box.width ||
          !box.height ||
          style.display === "none" ||
          style.visibility === "hidden"
        )
          continue;
        if (box.left < -1 || box.right > innerWidth + 1)
          problems.push(
            `${element.tagName}.${element.className} crosses viewport`,
          );
        if (
          element.matches(".story-library") &&
          element.scrollWidth > element.clientWidth + 1
        )
          problems.push("Story panel horizontal overflow");
      }
      return { width: innerWidth, height: innerHeight, problems };
    });
    assert.equal(layout.width, width);
    assert.equal(layout.height, height);
    assert.deepEqual(layout.problems, []);
    const file = path.join(work, `${width}x${height}-${name}.png`);
    await page.screenshot({ path: file });
    report.screenshots.push({ name, file, layout });
  }
};
const seek = async (frame) => {
  await call("cutline_preview", {
    ...guard(await current()),
    frame,
    playing: false,
  });
  await page.waitForTimeout(250);
};
const pixels = (file, frame = 0) =>
  run(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `select=eq(n\\,${frame}),scale=320:180`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
const difference = (a, b) => {
  assert.equal(a.length, b.length);
  assert(a.length);
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
};
const loudness = (file) => {
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "loudnorm=I=-18:TP=-1:LRA=11:print_format=json",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", timeout: 120000, maxBuffer: 4000000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const match = result.stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/u);
  assert(match, "Loudness analysis returns measured values");
  const value = JSON.parse(match[0]);
  return {
    integratedLUFS: Number(value.input_i),
    truePeakDBTP: Number(value.input_tp),
    loudnessRangeLU: Number(value.input_lra),
  };
};
const inspectTypography = async (frame) => {
  const layers = await page
    .locator('.canvas [data-motion-type="text"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent,
        width: node.clientWidth,
        height: node.clientHeight,
        scrollWidth: node.scrollWidth,
        scrollHeight: node.scrollHeight,
        lines: [...node.querySelectorAll("[data-motion-line] span")].map(
          (line) => {
            const range = document.createRange();
            range.selectNodeContents(line);
            return {
              text: line.textContent,
              fragments: range.getClientRects().length,
            };
          },
        ),
      })),
    );
  assert(layers.length, `Frame ${frame} must contain editable text`);
  const errors = layers.flatMap((layer) => [
    ...(layer.scrollWidth > layer.width + 1
      ? [`Horizontal overflow: ${layer.text}`]
      : []),
    ...(layer.scrollHeight > layer.height + 1
      ? [`Vertical overflow: ${layer.text}`]
      : []),
    ...layer.lines
      .filter((line) => line.fragments > 1)
      .map((line) => `Unexpected wrapping: ${line.text}`),
  ]);
  assert.deepEqual(errors, [], `Typography frame ${frame}`);
  report.typography.push({ frame, layers });
};

try {
  // A purpose-made product workspace illustration, not a screen copied from any reference video.
  const screenshot = path.join(work, "Cutline-Workspace.png");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#10131a"/><rect x="0" y="0" width="1920" height="74" fill="#181d26"/><text x="48" y="48" font-family="Arial" font-weight="700" font-size="31" fill="#ecf3f6">CUTLINE</text><text x="390" y="45" font-family="Arial" font-size="24" fill="#8591a2">A story worth sharing</text><rect x="1650" y="18" width="210" height="40" rx="12" fill="#d4ff72"/><text x="1701" y="46" font-family="Arial" font-size="23" fill="#10131a">Export video</text><rect x="24" y="98" width="375" height="637" rx="18" fill="#1b212c"/><text x="50" y="144" font-family="Arial" font-size="22" fill="#d4ff72">STORYBOARD</text>${["The spark", "See the possibility", "Make it yours", "Ready to share"].map((s, i) => `<rect x="48" y="${174 + i * 126}" width="327" height="103" rx="14" fill="${i === 1 ? "#313e36" : "#242d3a"}"/><rect x="66" y="${195 + i * 126}" width="62" height="61" rx="9" fill="${["#80a79b", "#d4ff72", "#e6ad84", "#939ce3"][i]}"/><text x="148" y="${216 + i * 126}" font-family="Arial" font-size="20" fill="#f5f7f9">${s}</text><text x="148" y="${244 + i * 126}" font-family="Arial" font-size="16" fill="#a1aec0">Scene ${i + 1} · 4 seconds</text>`).join("")}<rect x="425" y="98" width="1070" height="601" rx="18" fill="#d4ff72"/><circle cx="1160" cy="312" r="200" fill="#c0eb60"/><circle cx="1390" cy="520" r="280" fill="#b4e350"/><text x="500" y="250" font-family="Arial" font-size="23" fill="#263916">YOUR NEXT CHAPTER</text><text x="500" y="360" font-family="Arial" font-weight="700" font-size="85" fill="#142014">Make your</text><text x="500" y="456" font-family="Arial" font-weight="700" font-size="85" fill="#142014">ideas move.</text><text x="500" y="525" font-family="Arial" font-size="28" fill="#3a4f27">Story. Motion. A little magic.</text><rect x="1521" y="98" width="375" height="637" rx="18" fill="#1b212c"/><text x="1548" y="145" font-family="Arial" font-size="22" fill="#f5f7f9">Scene design</text><text x="1548" y="206" font-family="Arial" font-size="17" fill="#a1aec0">HEADLINE</text><rect x="1548" y="226" width="321" height="70" rx="10" fill="#252f3d"/><text x="1570" y="268" font-family="Arial" font-size="21" fill="#f5f7f9">Make your ideas move.</text><text x="1548" y="349" font-family="Arial" font-size="17" fill="#a1aec0">MOTION</text><rect x="1548" y="369" width="321" height="54" rx="10" fill="#252f3d"/><text x="1570" y="402" font-family="Arial" font-size="21" fill="#f5f7f9">Smooth reveal</text><text x="1548" y="477" font-family="Arial" font-size="17" fill="#a1aec0">YOUR PALETTE</text>${["#d4ff72", "#f4f6f8", "#718bdf", "#e3a178"].map((c, i) => `<circle cx="${1580 + i * 77}" cy="530" r="25" fill="${c}"/>`).join("")}<rect x="24" y="765" width="1872" height="289" rx="18" fill="#181e28"/><text x="50" y="808" font-family="Arial" font-size="18" fill="#a1aec0">TIMELINE</text>${[0, 1, 2, 3, 4].map((i) => `<text x="${315 + i * 302}" y="809" font-family="Arial" font-size="16" fill="#7b8b9d">00:${String(i * 4).padStart(2, "0")}</text>`).join("")}<text x="51" y="873" font-family="Arial" font-size="19" fill="#a1aec0">Story visuals</text>${["THE SPARK", "SEE THE POSSIBILITY", "MAKE IT YOURS", "READY TO SHARE"].map((s, i) => `<rect x="${284 + i * 394}" y="838" width="377" height="61" rx="10" fill="${["#496e62", "#b5d96e", "#9b6d52", "#6269a1"][i]}"/><text x="${305 + i * 394}" y="875" font-family="Arial" font-weight="700" font-size="19" fill="#fafef6">${s}</text>`).join("")}<text x="51" y="947" font-family="Arial" font-size="19" fill="#a1aec0">Original music</text><rect x="284" y="918" width="1559" height="47" rx="10" fill="#254854"/>${Array.from({ length: 145 }, (_, i) => `<rect x="${297 + i * 10.5}" y="${929 + (i % 4) * 2}" width="3" height="${23 - (i % 4) * 4}" fill="#84b9c4"/>`).join("")}<line x1="902" y1="789" x2="902" y2="1020" stroke="#f7fcf5" stroke-width="3"/><circle cx="902" cy="789" r="7" fill="#f7fcf5"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(screenshot);
  const module = await build({
    stdin: {
      contents:
        'export {newProject,makeClip,MotionSchema,validateProject} from "./src/shared/model.ts";export {createProductStory} from "./src/shared/story.ts";export {productLayouts} from "./src/shared/product-scenes.ts";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const {
    newProject,
    makeClip,
    MotionSchema,
    validateProject,
    productLayouts,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(module.outputFiles[0].text).toString("base64")}`
  );
  const initial = newProject();
  Object.assign(initial, {
    name: "Cutline — Make your ideas move",
    width: 1920,
    height: 1080,
    fps: 30,
    background: "#10131a",
  });
  const markerTrack = initial.tracks.find((track) => track.kind === "text");
  markerTrack.hidden = true;
  const markerMotion = MotionSchema.parse({
    id: "unrelated-motion",
    name: "Preserved unrelated graphic",
    layers: [
      {
        type: "text",
        text: "Keep this original motion",
        width: 900,
        height: 120,
      },
    ],
  });
  const marker = {
    ...makeClip(initial, "text", markerTrack.id, 0),
    id: "unrelated-clip",
    text: "Keep my original",
    motionId: markerMotion.id,
    duration: 1,
  };
  initial.clips = [marker];
  initial.motions = [markerMotion];
  validateProject(initial);
  await writeFile(
    projectFile,
    JSON.stringify({
      project: initial,
      past: [],
      future: [],
      filePath: projectFile,
    }),
  );
  app = await electron.launch({
    executablePath:
      process.env.CUTLINE_EXECUTABLE ??
      path.join(
        root,
        packaged
          ? "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline"
          : "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    args: [
      ...(packaged ? [] : [root]),
      projectFile,
      "--force-color-profile=srgb",
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
  await app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.__productFilmNetwork = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(
        typeof input === "string" ? input : (input.url ?? String(input)),
      );
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        globalThis.__productFilmNetwork.push({
          origin: url.origin,
          pathname: url.pathname,
          method: options?.method ?? "GET",
        });
        throw Error("External network blocked during local product QA");
      }
      return original(input, options);
    };
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar");
  const state = await invoke("state");
  mcp = new Client({ name: "Cutline Product Film QA", version: "1.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(state.settings.mcpUrl)),
  );
  const schema = await call("cutline_editing_schema", { section: "story" });
  assert(
    JSON.stringify(schema).includes("design") &&
      JSON.stringify(schema).includes("brand"),
  );
  check(
    "The live story schema exposes editable product design and brand fields",
  );
  await page
    .locator(".library-tabs button")
    .filter({ hasText: /^Story$/ })
    .click();
  for (const name of [
    "Launch film",
    "Product walkthrough",
    "Type-led teaser",
  ]) {
    const project = await recipe(name);
    assert(project.story.scenes.length >= 3);
    assert(
      project.story.scenes.every((scene) => scene.design && !scene.narration),
    );
    check(`${name} recipe creates editable silent scenes`);
  }
  await stage("Produce");
  await expect(
    panel().getByText("Graphics ready", { exact: true }).first(),
  ).toBeVisible();
  await captureBoth("graphics-ready");
  await stage("Finish");
  await panel()
    .getByRole("button", { name: "Build video on timeline", exact: true })
    .click();
  let project = await waitProject(
    (p) => !!p.story?.assembly?.clipIds.length,
    "Native product graphics were not built",
  );
  assert(project.story.assembly.motionIds.length >= 3);
  assert.equal(project.assets.length, 0);
  assert.deepEqual(
    clone(project.clips.find((clip) => clip.id === marker.id)),
    clone(marker),
  );
  assert.deepEqual(
    clone(project.motions.find((motion) => motion.id === markerMotion.id)),
    clone(markerMotion),
  );
  const nativeIds = [...project.story.assembly.clipIds],
    nativeMotions = [...project.story.assembly.motionIds];
  await assert.rejects(
    () =>
      invoke("story.generate", {
        ...guard(project),
        sceneId: project.story.scenes[0].id,
      }),
    /editable graphics/,
  );
  check(
    "Native product graphics assemble without media or voiceover, and cannot submit paid generation",
  );

  const visual = await invoke("test.import", { path: screenshot });
  const music = await call("cutline_music_create", {
    ...guard(await current()),
    style: "clean",
    seconds: 24,
    startFrame: 0,
  });
  await tx([{ type: "clip.delete", id: music.musicClipId }]);
  const rawSoundtrack = (await current()).assets.find(
    (asset) => asset.id === music.assetId,
  );
  const soundtrackFile = path.join(work, "Cutline-Original-Soundtrack.wav");
  run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    rawSoundtrack.path,
    "-af",
    "loudnorm=I=-18:TP=-1:LRA=11",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s24le",
    soundtrackFile,
  ]);
  await writeFile(
    `${soundtrackFile}.credits.txt`,
    "Original local instrumental composed with Cutline's clean music generator. No samples or external services. Loudness normalized for this music-led demonstration.\n",
  );
  const soundtrack = await invoke("test.import", { path: soundtrackFile });
  report.audioMix = {
    before: loudness(rawSoundtrack.path),
    normalized: loudness(soundtrackFile),
    clipVolume: 1,
  };
  project = await current();
  const story = {
    ...project.story,
    brief:
      "An original product film showing Cutline’s editable story, motion and export workflow.",
    style: "Product film",
    captions: false,
    brand: {
      name: "CUTLINE",
      accent: "#d4ff72",
      background: "#10131a",
      foreground: "#f4f6f8",
    },
    musicAssetId: soundtrack.id,
    scenes: [
      {
        id: "product-hook",
        title: "The idea",
        duration: 4,
        design: {
          layout: "title",
          eyebrow: "MEET CUTLINE",
          headline: "Make your ideas move.",
          body: "A whole story. One creative workspace.",
          motion: "smooth",
        },
      },
      {
        id: "product-screen",
        title: "The workspace",
        duration: 4,
        assetId: visual.id,
        design: {
          layout: "screen",
          eyebrow: "FROM FIRST THOUGHT",
          headline: "See the whole story.",
          body: "Plan every scene. Keep every detail editable.",
          motion: "smooth",
        },
      },
      {
        id: "product-split",
        title: "Your creative direction",
        duration: 4,
        assetId: visual.id,
        design: {
          layout: "split",
          eyebrow: "MAKE IT YOURS",
          headline: "Your story.\nYour style.",
          body: "Shape the words, brand colors and motion around your idea.",
          motion: "smooth",
        },
      },
      {
        id: "product-features",
        title: "The complete workflow",
        duration: 4,
        design: {
          layout: "features",
          eyebrow: "ALL IN ONE PLACE",
          headline: "From spark to screen.",
          body: "Build the film, scene by scene.",
          points: [
            "Plan your storyline",
            "Create the visuals",
            "Add voice and captions",
          ],
          motion: "snappy",
        },
      },
      {
        id: "product-quote",
        title: "Keep creating",
        duration: 4,
        design: {
          layout: "quote",
          eyebrow: "BUILT FOR THE NEXT IDEA",
          headline: "Less friction.\nMore creating.",
          body: "Your story stays editable, all the way to the final frame.",
          motion: "minimal",
        },
      },
      {
        id: "product-close",
        title: "Start your next story",
        duration: 4,
        design: {
          layout: "cta",
          eyebrow: "CUTLINE",
          headline: "Your next story\nstarts here.",
          body: "Plan. Create. Make it move.",
          motion: "smooth",
        },
      },
    ].map((scene) => ({ narration: "", visualPrompt: "", ...scene })),
  };
  await call("cutline_story", { ...guard(project), story });
  await stage("Story");
  const productSummary = panel().locator(".story-product-film > summary");
  if (!(await productSummary.evaluate((element) => element.parentElement.open)))
    await productSummary.click();
  await panel()
    .getByLabel("Product brand name", { exact: true })
    .fill("CUTLINE STUDIO");
  await panel()
    .getByLabel("Product accent color", { exact: true })
    .fill("#cdfa70");
  await panel()
    .getByLabel("Product background color", { exact: true })
    .fill("#10131a");
  await panel()
    .getByLabel("Product text color", { exact: true })
    .fill("#f4f6f8");
  await panel().locator(".story-scene-select").nth(0).click();
  const featureName = productLayouts.find(
    (layout) => layout.id === "features",
  ).name;
  await panel()
    .getByRole("radio", { name: `Use ${featureName} layout`, exact: true })
    .press("Space");
  await panel()
    .getByLabel("Feature point 1", { exact: true })
    .fill("An editable first idea");
  await panel()
    .getByLabel("Scene motion pace", { exact: true })
    .selectOption("snappy");
  project = await saveStory();
  assert.equal(project.story.brand.name, "CUTLINE STUDIO");
  assert.equal(
    project.story.scenes[0].design.points[0],
    "An editable first idea",
  );
  assert.equal(project.story.scenes[0].design.motion, "snappy");
  await panel()
    .getByLabel("Product brand name", { exact: true })
    .fill("CUTLINE");
  await panel()
    .getByLabel("Product accent color", { exact: true })
    .fill("#d4ff72");
  const titleName = productLayouts.find((layout) => layout.id === "title").name;
  await panel()
    .getByRole("radio", { name: `Use ${titleName} layout`, exact: true })
    .press("Space");
  await panel()
    .getByLabel("On-screen headline", { exact: true })
    .fill("Make your ideas move.");
  await panel()
    .getByLabel("On-screen eyebrow", { exact: true })
    .fill("MEET CUTLINE");
  await panel()
    .getByLabel("On-screen supporting text", { exact: true })
    .fill("A whole story. One creative workspace.");
  await panel()
    .getByLabel("Scene motion pace", { exact: true })
    .selectOption("smooth");
  project = await saveStory();
  await captureBoth("product-design");
  await captureBoth(
    "scene-design-controls",
    panel().getByLabel("On-screen headline", { exact: true }),
  );
  check(
    "Brand palette, layout, headline, supporting copy, feature points and motion pace save through the real UI",
  );
  await stage("Produce");
  await panel()
    .getByLabel("Scene to produce", { exact: true })
    .selectOption("product-screen");
  await panel()
    .getByLabel("Scene visual asset", { exact: true })
    .selectOption("");
  await saveStory();
  await stage("Finish");
  await expect(
    panel().getByRole("button", {
      name: "Rebuild story sequence",
      exact: true,
    }),
  ).toBeDisabled();
  await stage("Produce");
  await panel()
    .getByLabel("Scene visual asset", { exact: true })
    .selectOption(visual.id);
  project = await saveStory();
  await captureBoth("screen-selection");
  check(
    "A screen layout requires real media, and choosing an imported screenshot restores readiness through the UI",
  );
  await invoke("save");
  const saved = JSON.parse(await readFile(projectFile, "utf8")).project;
  await invoke("test.load", { path: projectFile });
  project = await current();
  assert.deepEqual(clone(project.story), saved.story);
  check(
    "Product design, selected screenshot, brand colors and local music survive save and reopen",
  );
  await stage("Finish");
  await panel()
    .getByRole("button", { name: "Rebuild story sequence", exact: true })
    .click();
  project = await waitProject(
    (p) => p.story.assembly.clipIds.every((id) => !nativeIds.includes(id)),
    "Mixed product sequence did not rebuild",
  );
  assert(
    nativeIds.every((id) => !project.clips.some((clip) => clip.id === id)),
  );
  assert(
    nativeMotions.every(
      (id) => !project.motions.some((motion) => motion.id === id),
    ),
  );
  assert.deepEqual(
    clone(project.clips.find((clip) => clip.id === marker.id)),
    clone(marker),
  );
  assert.deepEqual(
    clone(project.motions.find((motion) => motion.id === markerMotion.id)),
    clone(markerMotion),
  );
  assert.equal(project.story.assembly.motionIds.length, 6);
  assert.equal(
    project.clips.filter((clip) => clip.assetId === visual.id).length,
    2,
  );
  const firstIds = [...project.story.assembly.clipIds],
    firstMotionIds = [...project.story.assembly.motionIds];
  await tx([
    {
      type: "motion.put",
      motion: { ...markerMotion, name: "Keep my edited original motion" },
    },
  ]);
  await panel()
    .getByRole("button", { name: "Rebuild story sequence", exact: true })
    .click();
  project = await waitProject(
    (p) => p.story.assembly.clipIds.every((id) => !firstIds.includes(id)),
    "Second product rebuild did not complete",
  );
  assert(firstIds.every((id) => !project.clips.some((clip) => clip.id === id)));
  assert(
    firstMotionIds.every(
      (id) => !project.motions.some((motion) => motion.id === id),
    ),
  );
  assert.equal(
    project.motions.find((motion) => motion.id === markerMotion.id).name,
    "Keep my edited original motion",
  );
  assert(project.clips.some((clip) => clip.id === marker.id));
  assert.equal(project.motions.length, 7);
  const musicClips = project.clips.filter(
    (clip) => clip.assetId === soundtrack.id,
  );
  assert(musicClips.length);
  await tx(
    musicClips.map((clip) => ({
      type: "clip.update",
      id: clip.id,
      patch: { volume: 1, fadeIn: 6, fadeOut: 24 },
    })),
  );
  project = await current();
  validateProject(project);
  await seek(project.story.assembly.startFrame + 75);
  await captureBoth("assembled-product-film");
  check(
    "Mixed screenshot and native graphic scenes rebuild cleanly while preserving unrelated clips and an edited motion",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator(".stage").click({ position: { x: 4, y: 4 } });
  const frames = project.story.scenes.map(
    (_scene, index) => project.story.assembly.startFrame + index * 120 + 75,
  );
  const animatedFrames = [0, 1, 2, 3].map(
    (index) => project.story.assembly.startFrame + index * 120 + 8,
  );
  const sampleFrames = [...frames, ...animatedFrames];
  const previews = new Map();
  for (const frame of sampleFrames) {
    await seek(frame);
    await inspectTypography(frame);
    const file = path.join(work, `preview-${frame}.png`);
    await page.locator(".canvas").screenshot({ path: file });
    previews.set(frame, pixels(file));
  }
  await invoke("save");
  const started = Date.now(),
    job = await invoke("test.export", { path: output });
  let done;
  while (Date.now() - started < 600000) {
    done = (await invoke("state")).jobs.find((item) => item.id === job.id);
    if (done?.state === "done") break;
    if (["error", "cancelled"].includes(done?.state)) throw Error(done.message);
    await page.waitForTimeout(400);
  }
  assert.equal(done?.state, "done", "Product film export completed");
  const probe = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      output,
    ]).toString(),
  );
  const video = probe.streams.find((stream) => stream.codec_type === "video"),
    audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assertCfrExport(ffprobe, output, {
    fps: 30,
    frames: Math.max(
      ...project.clips.map((clip) => clip.start + clip.duration),
    ),
  });
  assert.equal(audio.codec_name, "aac");
  const duration =
    Math.max(...project.clips.map((clip) => clip.start + clip.duration)) /
    project.fps;
  assert(Math.abs(Number(probe.format.duration) - duration) < 0.15);
  assert(duration >= 20 && duration <= 30);
  run(ffmpeg, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
  const pcm = run(ffmpeg, [
    "-v",
    "error",
    "-i",
    output,
    "-vn",
    "-ar",
    "8000",
    "-ac",
    "1",
    "-f",
    "s16le",
    "-",
  ]);
  let squares = 0;
  for (let i = 0; i < pcm.length - 1; i += 2)
    squares += (pcm.readInt16LE(i) / 32768) ** 2;
  const rms = Math.sqrt(squares / Math.floor(pcm.length / 2));
  assert(rms > 0.005, "Original music is audible");
  report.parity = sampleFrames.map((frame) => ({
    phase: animatedFrames.includes(frame) ? "entrance" : "hold",
    frame,
    meanPixelDifference: difference(previews.get(frame), pixels(output, frame)),
  }));
  assert(
    report.parity.every((sample) => sample.meanPixelDifference < 5),
    `Preview/export parity: ${JSON.stringify(report.parity)}`,
  );
  const stills = [];
  for (const frame of sampleFrames) {
    const file = path.join(work, `export-${frame}.png`);
    run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-i",
      output,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      file,
    ]);
    if (frames.includes(frame)) stills.push(file);
  }
  const contact = path.join(work, "product-film-contact-sheet.png");
  const thumbs = await Promise.all(
    stills.map((file) => sharp(file).resize(640, 360).png().toBuffer()),
  );
  await sharp({
    create: { width: 1920, height: 720, channels: 3, background: "#10131a" },
  })
    .composite(
      thumbs.map((input, index) => ({
        input,
        left: (index % 3) * 640,
        top: Math.floor(index / 3) * 360,
      })),
    )
    .png()
    .toFile(contact);
  report.audioMix.export = loudness(output);
  assert(
    report.audioMix.export.integratedLUFS > -20 &&
      report.audioMix.export.integratedLUFS < -16.5,
    "Music-led film is near -18 LUFS",
  );
  assert(
    report.audioMix.export.truePeakDBTP <= -1,
    "Soundtrack stays below -1 dBTP",
  );
  report.export = {
    output,
    projectFile,
    contact,
    width: video.width,
    height: video.height,
    fps: video.avg_frame_rate,
    duration,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    rms,
    fullDecode: true,
    renderSeconds: (Date.now() - started) / 1000,
  };
  report.assets = project.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    path: asset.path,
    kind: asset.kind,
  }));
  await writeFile(
    path.join(work, "project-snapshot.json"),
    JSON.stringify(project, null, 2),
  );
  await writeFile(
    path.join(work, "export-metadata.json"),
    JSON.stringify(probe, null, 2),
  );
  check(
    "Six original product scenes export to 1920×1080 H.264/AAC with local music and matching preview frames",
    report.export,
  );
  report.network = await app.evaluate(() => globalThis.__productFilmNetwork);
  assert.deepEqual(report.network, []);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  check(
    "Both viewport sizes fit without renderer errors or external provider requests",
  );
} catch (error) {
  report.failed = error.stack ?? String(error);
  await page
    ?.screenshot({ path: path.join(work, "failure.png") })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (mcp) await mcp.close().catch(() => {});
  if (app) {
    report.network = await app
      .evaluate(() => globalThis.__productFilmNetwork ?? [])
      .catch(() => report.network);
    await app.close().catch(() => {});
  }
  await writeFile(
    path.join(work, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
