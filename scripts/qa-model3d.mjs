import { _electron as electron, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createModel3dFixture } from "./fixtures/model3d-fixture.mjs";
import { assertCfrExport } from "./video-qa-timing.mjs";

// Build first, then run through one-at-a-time. One disposable app owns all jobs.
// This does not open a real project or call an assistant/provider/dev server.
const root = process.cwd();
const parent = path.resolve(
  process.env.CUTLINE_MODEL3D_RESULTS ?? path.join(root, "../qa-model3d"),
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "profile");
const fixture = path.join(work, "Models.cutline");
const output = path.join(work, "Models.mp4");
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
  model: null,
  preview: null,
  export: null,
  failed: null,
};
const clean = (value) =>
  String(value).replace(
    /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s"')]+/gu,
    "[local bridge]",
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
    const error = page.locator(".model-error, .scene-error");
    if (await error.count()) throw Error(await error.first().textContent());
    await page.waitForTimeout(250);
  }
  throw Error(message);
};
const reply = (name, args = {}) =>
  client.callTool(
    { name, arguments: { sessionId: "main", ...args } },
    undefined,
    { timeout: 240000 },
  );
const call = async (name, args = {}, expectError = false) => {
  const response = await reply(name, args);
  const body = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (expectError) {
    assert(response.isError, `${name} must reject`);
    return body;
  }
  assert(!response.isError, `${name}: ${clean(body)}`);
  const value = JSON.parse(body);
  if (value?.jobId || value?.pending) {
    const id = value.jobId ?? value.id;
    const end = Date.now() + 300000;
    while (Date.now() < end) {
      const jobs = await call("cutline_jobs", { id, waitSeconds: 10 });
      const job = jobs.find((item) => item.id === id);
      if (job?.state === "done") {
        assert(job.result, "Completed task keeps its result");
        return job.result;
      }
      if (["error", "cancelled"].includes(job?.state)) throw Error(job.message);
    }
    throw Error(`${name} timed out`);
  }
  return value;
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
const captureDialog = async (name) => {
  const screenshots = {};
  for (const [width, height] of [
    [1440, 960],
    [390, 844],
  ]) {
    await resize(width, height);
    const dialog = page.locator(".model-studio");
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    assert(
      bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1,
      `${name} fits ${width}px`,
    );
    const layout = await dialog.evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
    }));
    assert(
      layout.scroll <= layout.width + 1,
      `${name} has no horizontal dialog overflow at ${width}px`,
    );
    const file = path.join(work, `${name}-${width}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    screenshots[width] = { file, layout };
  }
  report.screenshots.push({
    name,
    ...screenshots,
    note: "Actual viewport; full Mac editor still has a desktop minimum width",
  });
  await resize(1440, 960);
};
const frame = (file, seconds, alpha = false) =>
  run(ffmpeg, [
    "-v",
    "error",
    "-threads",
    "2",
    ...(alpha ? ["-c:v", "libvpx-vp9"] : []),
    "-i",
    file,
    "-ss",
    String(seconds),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    alpha ? "rgba" : "rgb24",
    "pipe:1",
  ]);
const pixel = (bytes, x, y) => [
  ...bytes.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3),
];
const differentPixels = (first, second, threshold = 30) => {
  assert.equal(first.length, second.length);
  let count = 0;
  for (let i = 0; i < first.length; i += 3)
    if (
      Math.abs(first[i] - second[i]) +
        Math.abs(first[i + 1] - second[i + 1]) +
        Math.abs(first[i + 2] - second[i + 2]) >
      threshold
    )
      count++;
  return count;
};
const managedFile = (asset) =>
  path.resolve(
    path.dirname(asset.composition.entry),
    asset.composition.model3d.file,
  );

try {
  const modelDir = path.join(work, "input-model");
  const generated = await createModel3dFixture(modelDir);
  const originalHash = hash(await readFile(generated.glbPath));
  const textureHash = hash(
    await readFile(path.join(modelDir, "textures/barrel-grain.png")),
  );
  const bufferHash = hash(
    await readFile(path.join(modelDir, "precision-lens.bin")),
  );
  const bundled = await build({
    stdin: {
      contents:
        'export {newProject, validateProject} from "./src/shared/model.ts";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, validateProject } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  const initial = validateProject({
    ...newProject(),
    name: "Generated 3D models QA",
    width: 640,
    height: 360,
    fps: 30,
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
  client = new Client({ name: "model3d-qa", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${connection.base}/mcp`)),
  );
  assert(
    (await client.listTools()).tools.some(
      (tool) => tool.name === "cutline_model3d",
    ),
  );
  check("The running app exposes the generated-model assistant tool");

  const invalidMedia = path.join(work, "bad.mp4");
  await writeFile(invalidMedia, "This is an intentionally invalid media fixture.\n");
  const beforeMixedImport = await current();
  const mixed = await invoke("import", {
    paths: [generated.glbPath, invalidMedia],
  });
  assert.deepEqual(mixed.modelPaths, [generated.glbPath]);
  assert(
    Array.isArray(mixed.importWarnings) &&
      mixed.importWarnings.some((warning) => warning.includes("bad.mp4")),
    "A failed regular media item is reported without dropping the valid model path",
  );
  const afterMixedImport = await current();
  assert.equal(afterMixedImport.id, beforeMixedImport.id);
  assert.equal(afterMixedImport.revision, beforeMixedImport.revision);
  assert.equal(afterMixedImport.assets.length, 0);
  assert.equal(afterMixedImport.clips.length, 0);
  assert.equal(await page.locator(".model-studio").count(), 0);
  check(
    "Mixed generic import returns the valid GLB path and invalid-media warning without mutating the empty project",
  );

  // Stub only this disposable app's native file chooser, then use the real UI.
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, generated.glbPath);
  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import 3D model", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "Import 3D model",
    exact: true,
  });
  await expect(modal).toBeVisible();
  await modal.getByLabel("Name", { exact: true }).fill("Precision lens");
  await modal.getByLabel("Duration (s)", { exact: true }).fill("1.2");
  await modal.getByLabel("Movement", { exact: true }).selectOption("static");
  await modal.getByLabel("Angle (degrees)", { exact: true }).fill("35");
  await modal.getByLabel("Height (degrees)", { exact: true }).fill("18");
  await modal.getByLabel("Playback speed", { exact: true }).fill("4");
  await captureDialog("model-import");
  await modal
    .getByRole("button", { name: "Add to timeline", exact: true })
    .click();
  let project = await waitProject(
    (p) => p.assets.length === 1 && p.clips.length === 1,
    "3D import did not reach the timeline",
  );
  await expect(page.locator(".model-studio")).toBeHidden({ timeout: 10000 });
  const before = project.assets[0];
  assert.equal(before.composition.model3d.format, "glb");
  assert.deepEqual(before.composition.model3d.animations, ["Focus pull"]);
  assert.equal(before.composition.model3d.settings.motion, "static");
  assert.equal(hash(await readFile(managedFile(before))), originalHash);
  assert((await stat(before.path)).size > 1000);
  const animationPixels = differentPixels(
    frame(before.path, 0.03),
    frame(before.path, 0.75),
  );
  assert(
    animationPixels > 150,
    `Embedded model animation changes visible pixels with a still camera (${animationPixels})`,
  );
  check(
    "Native GLB import creates an editable timeline scene and its embedded animation visibly moves with a still camera",
  );

  const read = await call("cutline_model3d", {
    ...guard(await current()),
    action: "read",
    assetId: before.id,
  });
  assert(
    JSON.stringify(read).includes("Focus pull"),
    "Assistant read reports embedded animations",
  );
  assert(
    JSON.stringify(read).includes("cameraAzimuth"),
    "Assistant read reports editable camera settings",
  );
  await rm(generated.glbPath);
  await page
    .getByRole("button", { name: "Edit 3D scene", exact: true })
    .first()
    .click();
  const edit = page.getByRole("dialog", { name: "Edit 3D scene", exact: true });
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel("Animation", { exact: true })).toContainText(
    "Focus pull",
  );
  // There is no asset-rename edit command. Load a QA-only concurrent snapshot
  // with the same project/source identity while the existing form stays open.
  const concurrentName = "Precision lens renamed elsewhere";
  const live = await current();
  const renamed = validateProject({
    ...live,
    revision: live.revision + 1,
    assets: live.assets.map((asset) =>
      asset.id === before.id ? { ...asset, name: concurrentName } : asset,
    ),
  });
  await writeFile(
    fixture,
    JSON.stringify({
      project: renamed,
      past: [],
      future: [],
      filePath: fixture,
    }),
  );
  await invoke("test.load", { path: fixture });
  const concurrent = await waitProject(
    (p) => p.assets.find((asset) => asset.id === before.id)?.name === concurrentName,
    "Concurrent rename fixture did not load",
  );
  assert.equal(concurrent.id, live.id);
  assert.equal(
    concurrent.assets.find((asset) => asset.id === before.id).composition.sourceHash,
    before.composition.sourceHash,
  );
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(before.name);
  await edit.getByLabel("Movement", { exact: true }).selectOption("turntable");
  await edit.getByLabel("Angle (degrees)", { exact: true }).fill("60");
  await edit.getByLabel("Travel (degrees)", { exact: true }).fill("90");
  await captureDialog("model-edit");
  await edit
    .getByRole("button", { name: "Render changes", exact: true })
    .click();
  project = await waitProject(
    (p) =>
      p.assets[0]?.composition?.sourceHash !== before.composition.sourceHash,
    "Camera update did not commit",
  );
  await expect(page.locator(".model-studio")).toBeHidden({ timeout: 10000 });
  const after = project.assets[0];
  assert.equal(after.id, before.id);
  assert.equal(
    after.name,
    concurrentName,
    "Rendering camera changes must preserve a newer external asset name when the form name was untouched",
  );
  assert.notEqual(after.path, before.path);
  assert.equal(after.composition.model3d.settings.cameraAzimuth, 60);
  assert.equal(hash(await readFile(managedFile(after))), originalHash);
  assert.equal(
    await readFile(before.composition.entry, "utf8"),
    before.composition.source,
  );
  await invoke("undo");
  assert.equal((await current()).assets[0].path, before.path);
  await invoke("redo");
  assert.equal((await current()).assets[0].path, after.path);
  await invoke("save");
  await invoke("test.load", { path: fixture });
  assert.deepEqual(
    (await current()).assets[0].composition.model3d,
    after.composition.model3d,
  );
  assert.equal((await current()).assets[0].name, concurrentName);
  check(
    "An open 3D form preserves a newer external asset name when only camera and motion settings are rendered",
  );
  check(
    "Camera edits use retained model bytes after original deletion, preserve earlier versions and survive Undo/Redo and save/reopen",
  );
  const stale = await call(
    "cutline_model3d",
    {
      ...guard(await current()),
      action: "update",
      assetId: after.id,
      expectedSourceHash: before.composition.sourceHash,
      settings: { cameraAzimuth: 10 },
    },
    true,
  );
  assert.match(stale, /changed|source|version/iu);
  assert.equal((await current()).assets[0].path, after.path);
  check("A stale source hash rejects without replacing the model scene");

  // Exercise assistant import separately, including external local dependencies.
  const imported = await call("cutline_model3d", {
    ...guard(await current()),
    action: "import",
    path: generated.gltfPath,
    name: "Lens over footage",
    transparent: true,
    at: { frame: 36 },
    settings: {
      durationSeconds: 1.8,
      motion: "orbit",
      rotationDegrees: 45,
      cameraAzimuth: 20,
      cameraElevation: 18,
      animationSpeed: 2,
    },
  });
  const alpha = (await current()).assets.find(
    (asset) => asset.id === imported.assetId,
  );
  assert(alpha?.composition?.model3d && alpha.composition.transparent);
  assert.equal(alpha.composition.model3d.format, "gltf");
  const localModel = JSON.parse(await readFile(managedFile(alpha), "utf8"));
  const localRoot = path.dirname(managedFile(alpha));
  assert.equal(
    hash(await readFile(path.resolve(localRoot, localModel.buffers[0].uri))),
    bufferHash,
  );
  assert.equal(
    hash(await readFile(path.resolve(localRoot, localModel.images[0].uri))),
    textureHash,
  );
  await rm(modelDir, { recursive: true });
  const rgba = frame(alpha.path, 0.6, true);
  assert.equal(rgba.length, 640 * 360 * 4);
  assert(
    rgba[(10 * 640 + 10) * 4 + 3] < 5,
    "Overlay corner is genuinely transparent",
  );
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 200) opaque++;
  assert(opaque > 1000, "Model remains visible in the transparent scene");
  check(
    "Assistant glTF import retains its local buffer/texture and renders real alpha around visible geometry",
  );

  // A hand-edited wrapper becomes a normal source scene, with Undo restoring controls.
  await invoke("hyperframes.render", {
    ...guard(await current()),
    action: "update",
    assetId: after.id,
    expectedSourceHash: after.composition.sourceHash,
    html: `${after.composition.source}\n<!-- QA source edit -->`,
  });
  assert.equal(
    (await current()).assets.find((asset) => asset.id === after.id).composition
      .model3d,
    undefined,
  );
  await invoke("undo");
  assert.deepEqual(
    (await current()).assets.find((asset) => asset.id === after.id).composition
      .model3d,
    after.composition.model3d,
  );
  check(
    "Hand-edited HTML detaches generated-model controls, and Undo restores them with the original source",
  );

  // Native renderer and export run only after all model render jobs have finished.
  const preview = await reply("cutline_preview", {
    frame: 60,
    image: true,
    width: 640,
  });
  assert(
    !preview.isError,
    clean(
      JSON.stringify(preview.content.filter((item) => item.type === "text")),
    ),
  );
  const picture = preview.content.find((item) => item.type === "image");
  assert(picture, "Native preview returns rendered model pixels");
  const previewFile = path.join(
    work,
    `native-alpha-preview.${picture.mimeType === "image/png" ? "png" : "jpg"}`,
  );
  await writeFile(previewFile, Buffer.from(picture.data, "base64"));
  const previewPixels = run(ffmpeg, [
    "-v",
    "error",
    "-i",
    previewFile,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
  const previewCorner = pixel(previewPixels, 10, 10);
  assert(
    previewCorner.every((value, i) => Math.abs(value - [38, 76, 114][i]) < 14),
    `Native preview shows the timeline background through alpha: ${previewCorner}`,
  );
  report.preview = { path: previewFile, frame: 60, corner: previewCorner };
  await invoke("save");
  project = await current();
  const expectedFrames = Math.max(
    ...project.clips.map((clip) => clip.start + clip.duration),
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
  assert.equal(exported?.state, "done", "Combined model export finishes");
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
  run(ffmpeg, [
    "-v",
    "error",
    "-threads",
    "2",
    "-i",
    output,
    "-f",
    "null",
    "-",
  ]);
  const timing = assertCfrExport(ffprobe, output, {
    fps: 30,
    frames: expectedFrames,
  });
  const exportedCorner = pixel(frame(output, 2), 10, 10);
  assert(
    exportedCorner.every((value, i) => Math.abs(value - [38, 76, 114][i]) < 14),
    `Export composites alpha over the timeline background: ${exportedCorner}`,
  );
  const sample = path.join(work, "Precision-lens-sample.mp4");
  await copyFile(after.path, sample);
  for (const [seconds, name] of [
    [0.4, "lens"],
    [2, "overlay"],
  ])
    await writeFile(
      path.join(work, `${name}-export.png`),
      run(ffmpeg, [
        "-v",
        "error",
        "-i",
        output,
        "-ss",
        String(seconds),
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "pipe:1",
      ]),
    );
  report.model = {
    originalHash,
    format: "glb",
    animation: "Focus pull",
    animationPixels,
    sample,
    alphaPixels: opaque,
  };
  report.export = {
    path: output,
    timing,
    width: video.width,
    height: video.height,
    background: exportedCorner,
    audio: "silent fixture",
  };
  check(
    "Native preview and the fully decoded 640x360 / 30 fps export preserve transparent compositing and exact frame count",
  );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.consoleErrors, []);
  check("The exercised editor flows produce no renderer or console errors");
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
    `3D model QA: ${report.failed ? "FAILED" : "passed"}. Report: ${path.join(work, "report.json")}`,
  );
  if (report.failed) console.error(report.failed);
}
