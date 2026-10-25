import { _electron as electron, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertCfrExport } from "./video-qa-timing.mjs";

// Build first. Run this one isolated app through one-at-a-time. No assistant,
// stock, paid provider, real project or dev server is used.
const root = process.cwd();
const parent = path.resolve(
  process.env.CUTLINE_HYPERFRAMES_RESULTS ??
    path.join(root, "../qa-hyperframes"),
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "profile"),
  fixture = path.join(work, "Scenes.cutline");
const output = path.join(work, "Scenes.mp4");
const packaged = process.env.CUTLINE_PACKAGED === "1";
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const run = (binary, args) =>
  execFileSync(binary, args, { timeout: 120000, maxBuffer: 32 * 1024 ** 2 });
const report = {
  work,
  packaged,
  runtime: null,
  checks: [],
  screenshots: [],
  errors: [],
  consoleErrors: [],
  export: null,
  failed: null,
};
const clean = (value) =>
  String(value).replace(
    /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s"')]+/gu,
    "[local bridge]",
  );
const check = (message) => {
  report.checks.push(message);
  console.log(message);
};
let app, page, client, closing;
const close = () =>
  (closing ??= (async () => {
    await client?.close().catch(() => {});
    if (!app) return;
    const child = app.process();
    let timer;
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("QA close timed out")), 15000);
        }),
      ]);
    } catch {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    } finally {
      clearTimeout(timer);
    }
  })());
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
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
const waitProject = async (predicate, message, timeout = 300000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const project = await current();
    if (predicate(project)) return project;
    const failure = (await page.locator(".scene-error").count())
      ? await page.locator(".scene-error").textContent()
      : null;
    if (failure) throw Error(failure);
    await page.waitForTimeout(200);
  }
  throw Error(message);
};
const scene = async (args) =>
  invoke("hyperframes.render", { ...guard(await current()), ...args });
const call = async (name, args = {}) => {
  const reply = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 240000,
  });
  const text = reply.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert(!reply.isError, `${name}: ${clean(text)}`);
  return JSON.parse(text);
};
const resize = async (width, height) => {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(390, 600);
      window.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await page.setViewportSize({ width, height });
};
const capture = async (name, modal = false) => {
  await resize(1440, 960);
  const desktop = path.join(work, `${name}-1440.png`);
  await page.screenshot({ path: desktop, animations: "disabled" });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Desktop must fit the window",
  );
  await resize(390, 844);
  const narrow = path.join(work, `${name}-390.png`);
  let isolated;
  if (!modal)
    isolated = await page.addStyleTag({
      content:
        "body{min-width:0!important}body *{visibility:hidden}.library,.library *{visibility:visible}.library{position:fixed!important;inset:0!important;width:390px!important;height:844px!important;z-index:99999;background:#1b1a1f}.library-tabs{overflow-x:auto}",
    });
  try {
    const element = page.locator(modal ? ".hyperframes-studio" : ".library");
    const bounds = await element.boundingBox();
    assert(
      bounds && bounds.x >= -1 && bounds.x + bounds.width <= 391,
      `${name} fits at 390px`,
    );
    const layout = await element.evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
    }));
    assert(
      layout.scroll <= layout.width + 1,
      `${name} has no horizontal panel overflow`,
    );
    await page.screenshot({ path: narrow, animations: "disabled" });
    report.screenshots.push({
      name,
      desktop,
      narrow,
      layout,
      note: modal
        ? "Scene dialog at actual 390px viewport"
        : "Media panel isolated at 390px; full Mac editor retains desktop minimum width",
    });
  } finally {
    await isolated?.evaluate((element) => element.remove());
    await resize(1440, 960);
  }
};
const frame = (file, seconds, decoder = []) =>
  run(ffmpeg, [
    "-v",
    "error",
    ...decoder,
    "-i",
    file,
    "-ss",
    String(seconds),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
const pixel = (bytes, x, y, width = 640) => [
  ...bytes.subarray((y * width + x) * 3, (y * width + x) * 3 + 3),
];

try {
  const bundled = await build({
    stdin: {
      contents:
        'export {newProject, validateProject} from "./src/shared/model.ts"; export {hyperframesStarter} from "./src/shared/hyperframes-starters.ts";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, validateProject, hyperframesStarter } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  const initial = validateProject({
    ...newProject(),
    name: "Editable scenes QA",
    width: 640,
    height: 360,
    fps: 24,
    background: "#264c72",
  });
  await writeFile(
    fixture,
    JSON.stringify({
      project: initial,
      past: [],
      future: [],
      filePath: fixture,
    }),
  );
  const env = {
    ...process.env,
    CUTLINE_QA: "1",
    CUTLINE_DATA_DIR: data,
    CUTLINE_SESSION_ROOT: data,
    CUTLINE_PROJECTS_DIR: path.join(work, "projects"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CUTLINE_SESSION_ID;
  const executablePath =
    process.env.CUTLINE_APP_EXECUTABLE ??
    (packaged
      ? "/Applications/Cutline.app/Contents/MacOS/Cutline"
      : path.join(
          root,
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ));
  app = await electron.launch({
    executablePath,
    args: packaged ? [fixture] : [root, fixture],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(clean(error.message)));
  page.on("console", (message) => {
    if (message.type() === "error")
      report.consoleErrors.push(clean(message.text()));
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.waitForSelector(".titlebar", { timeout: 120000 });
  report.runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
  }));
  assert.equal(report.runtime.packaged, packaged);
  assert.equal(
    report.runtime.version,
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  );
  const connection = JSON.parse(
    await readFile(path.join(data, "connection.json"), "utf8"),
  );
  client = new Client({ name: "hyperframes-qa", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${connection.base}/mcp/local`)),
  );
  assert(
    (await client.listTools()).tools.some(
      (tool) => tool.name === "cutline_hyperframes",
    ),
  );
  check("The installed agent API exposes cutline_hyperframes");

  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await page.getByRole("button", { name: "New scene", exact: true }).click();
  await expect(page.locator("#scene-source")).toBeVisible();
  const source = hyperframesStarter("title", initial)
    .replace('data-duration="6"', 'data-duration="2"')
    .replace("x: 12, duration: 3", "x: 12, duration: 0.5");
  await page.locator("#scene-source").fill(source);
  await capture("scene-editor", true);
  await page
    .getByRole("button", { name: "Add to timeline", exact: true })
    .click();
  let project = await waitProject(
    (p) => p.assets.length === 1 && p.clips.length === 1,
    "New scene did not reach the timeline",
  );
  await expect(page.locator(".hyperframes-studio")).toBeHidden({
    timeout: 10000,
  });
  const before = project.assets[0];
  assert(before.composition?.source.includes("Your next idea"));
  assert.equal(before.composition.engine, "hyperframes");
  assert((await stat(before.path)).size > 1000);
  const openingPixel = pixel(frame(before.path, 0), 10, 350);
  assert(
    openingPixel.every((value) => value < 45),
    `Opening frame retains the full scene background: ${openingPixel}`,
  );
  check(
    "New scene creates real local video and retains editable HTML on the timeline",
  );
  await capture("scene-media");

  await page.getByRole("button", { name: "Edit source", exact: true }).click();
  await page
    .locator("#scene-source")
    .fill(source.replace("Your next idea", "A clearer next step"));
  await page
    .getByRole("button", { name: "Render changes", exact: true })
    .click();
  project = await waitProject(
    (p) =>
      p.assets[0]?.composition?.sourceHash !== before.composition.sourceHash,
    "Source edit did not commit",
  );
  await expect(page.locator(".hyperframes-studio")).toBeHidden({
    timeout: 10000,
  });
  const after = project.assets[0];
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .evaluateAll(
            (videos, hash) =>
              videos.some((video) => video.currentSrc.includes(hash)),
            after.composition.sourceHash,
          ),
      { timeout: 10000 },
    )
    .toBe(true);
  assert.equal(after.id, before.id);
  assert.notEqual(after.path, before.path);
  assert.equal(await readFile(before.composition.entry, "utf8"), source);
  await invoke("undo");
  assert.equal((await current()).assets[0].path, before.path);
  assert.equal(
    (await current()).assets[0].composition.source,
    before.composition.source,
  );
  await invoke("redo");
  assert.equal((await current()).assets[0].path, after.path);
  await invoke("save");
  await invoke("test.load", { path: fixture });
  assert.equal(
    (await current()).assets[0].composition.source,
    after.composition.source,
  );
  check(
    "Source edits preserve asset identity, immutable prior versions, Undo, Redo and save/reopen",
  );
  const inspected = await call("cutline_inspect");
  const publicText = JSON.stringify(inspected);
  assert(
    !publicText.includes("A clearer next step") &&
      !publicText.includes(after.composition.entry),
    "Inspect excludes full HTML and local source paths",
  );
  const read = await call("cutline_hyperframes", {
    ...guard(await current()),
    action: "read",
    assetId: after.id,
    limit: 120,
  });
  assert.equal(read.source, after.composition.source.slice(0, 120));
  assert.equal(read.nextOffset, 120);
  check("MCP inspect redacts scene source and explicit source reads paginate");

  const input = path.join(work, "imported-scene");
  await mkdir(input);
  await writeFile(
    path.join(input, "mark.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#739f82"/></svg>',
  );
  const importedSource =
    '<!doctype html><html><head><style>html,body{margin:0}#scene{width:640px;height:360px}</style></head><body><div id="scene" data-composition-id="scene" data-no-timeline data-start="0" data-duration="1" data-width="640" data-height="360"><img src="./mark.svg" width="640" height="360"></div></body></html>';
  await writeFile(path.join(input, "index.html"), importedSource);
  const imported = await scene({
    action: "import",
    path: path.join(input, "index.html"),
    name: "Copied sidecar",
    at: { frame: 48 },
  });
  await rm(input, { recursive: true });
  await scene({
    action: "update",
    assetId: imported.assetId,
    html: importedSource.replace("<body>", '<body aria-label="updated">'),
  });
  const local = (await current()).assets.find((a) => a.id === imported.assetId);
  assert(
    (
      await readFile(
        path.join(path.dirname(local.composition.entry), "mark.svg"),
        "utf8",
      )
    ).includes("#739f82"),
  );
  const localPixel = pixel(frame(local.path, 0.5), 320, 180);
  assert(
    localPixel[1] > localPixel[0] + 15,
    "The copied green SVG remains visible after original removal",
  );
  const firstSidecar = pixel(frame(local.path, 0), 10, 350);
  assert(
    firstSidecar.every(
      (value, index) => Math.abs(value - [115, 159, 130][index]) < 12,
    ),
    `Imported scenes paint the complete opening frame: ${firstSidecar}`,
  );
  check(
    "Imported local dependencies survive original-folder removal and a subsequent source update",
  );

  const three = await scene({
    action: "import",
    html: hyperframesStarter("three", initial).replace(
      'data-duration="6"',
      'data-duration="1"',
    ),
    name: "Real 3D",
    at: { frame: 72 },
  });
  const threeAsset = (await current()).assets.find(
    (a) => a.id === three.assetId,
  );
  const first = frame(threeAsset.path, 0.05),
    last = frame(threeAsset.path, 0.85);
  let changed = 0;
  for (let i = 0; i < first.length; i += 3)
    if (
      Math.abs(first[i] - last[i]) +
        Math.abs(first[i + 1] - last[i + 1]) +
        Math.abs(first[i + 2] - last[i + 2]) >
      30
    )
      changed++;
  assert(
    changed > 1000,
    "Real 3D object/camera movement changes visible pixels",
  );
  await writeFile(
    path.join(work, "3d-frame.png"),
    run(ffmpeg, [
      "-v",
      "error",
      "-i",
      threeAsset.path,
      "-ss",
      "0.5",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "pipe:1",
    ]),
  );
  check(
    "The Three.js starter renders a lit 3D scene with changing object/camera pixels",
  );

  const alphaSource =
    '<!doctype html><html><head><style>html,body{margin:0;background:transparent}#scene{position:relative;width:640px;height:360px}#tile{position:absolute;left:260px;top:120px;width:120px;height:120px;background:#e0b4ed}</style></head><body><div id="scene" data-composition-id="scene" data-no-timeline data-start="0" data-duration="1" data-width="640" data-height="360"><div id="tile"></div></div></body></html>';
  const alpha = await scene({
    action: "import",
    html: alphaSource,
    name: "Transparent overlay",
    transparent: true,
    at: { frame: 96 },
  });
  const alphaAsset = (await current()).assets.find(
    (a) => a.id === alpha.assetId,
  );
  assert(
    alphaAsset.path.endsWith(".webm") && alphaAsset.composition.transparent,
  );
  const rgba = run(ffmpeg, [
    "-v",
    "error",
    "-c:v",
    "libvpx-vp9",
    "-i",
    alphaAsset.path,
    "-ss",
    "0.5",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "pipe:1",
  ]);
  assert(
    rgba[(10 * 640 + 10) * 4 + 3] < 5,
    "The scene intermediate has genuine transparent pixels",
  );
  project = await current();
  const expectedFrames = Math.max(
    ...project.clips.map((c) => c.start + c.duration),
  );
  const job = await invoke("test.export", { path: output });
  const deadline = Date.now() + 300000;
  let exported;
  while (Date.now() < deadline) {
    exported = (await invoke("state")).jobs.find((item) => item.id === job.id);
    if (exported?.state === "done") break;
    if (["error", "cancelled"].includes(exported?.state))
      throw Error(exported.message);
    await page.waitForTimeout(500);
  }
  assert.equal(exported?.state, "done", "Combined timeline export finishes");
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
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.equal(video.codec_name, "h264");
  run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
  const timing = assertCfrExport(ffprobe, output, {
    fps: 24,
    frames: expectedFrames,
  });
  const background = pixel(frame(output, 4.5), 10, 10);
  assert(
    background.every((value, i) => Math.abs(value - [38, 76, 114][i]) < 12),
    `Transparent overlay preserves Cutline background: ${background}`,
  );
  const center = pixel(frame(output, 4.5), 320, 180);
  assert(
    center[0] > 170 && center[2] > 170,
    "The overlay itself remains visible",
  );
  report.export = {
    path: output,
    timing,
    background,
    center,
    width: video.width,
    height: video.height,
  };
  check(
    "Combined MP4 decodes at 640x360 / 24 fps with exact frame count and transparent overlay compositing",
  );
  const beforeCancel = await current();
  const sceneFolders = (await readdir(path.join(data, "scenes"))).sort();
  const cancelSource = hyperframesStarter("three", initial).replace(
    'data-duration="6"',
    'data-duration="120"',
  );
  await page.getByRole("button", { name: "New scene", exact: true }).click();
  await page.locator("#scene-source").fill(cancelSource);
  await page
    .getByRole("button", { name: "Add to timeline", exact: true })
    .click();
  const cancelDeadline = Date.now() + 120000;
  let renderJob;
  while (Date.now() < cancelDeadline) {
    renderJob = (await invoke("state")).jobs.find(
      (item) => item.kind === "hyperframes" && item.state === "running",
    );
    if (renderJob && renderJob.progress >= 0.25) break;
    await page.waitForTimeout(200);
  }
  assert(
    renderJob && renderJob.state === "running",
    "A real scene render starts before cancellation",
  );
  await page.getByRole("button", { name: "Stop render", exact: true }).click();
  await expect(page.locator(".scene-error")).toContainText("Render stopped", {
    timeout: 30000,
  });
  await expect(page.locator("#scene-source")).toHaveValue(cancelSource);
  await expect(
    page.getByRole("button", { name: "Add to timeline", exact: true }),
  ).toBeEnabled();
  assert.equal((await current()).assets.length, beforeCancel.assets.length);
  assert.deepEqual(
    (await readdir(path.join(data, "scenes"))).sort(),
    sceneFolders,
  );
  check(
    "Cancelling a running 3D render closes its worker and removes the unfinished version without changing the project",
  );
  await page
    .getByRole("button", { name: "Close scene editor", exact: true })
    .click();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.consoleErrors, []);
  check("The tested editor flows produce no renderer or console errors");
} catch (error) {
  report.failed = clean(error.stack ?? error);
  await page
    ?.screenshot({ path: path.join(work, "failure.png") })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await close();
  await writeFile(
    path.join(work, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `HyperFrames QA: ${report.failed ? "FAILED" : "passed"}. Report: ${path.join(work, "report.json")}`,
  );
  if (report.failed) console.error(report.failed);
}
