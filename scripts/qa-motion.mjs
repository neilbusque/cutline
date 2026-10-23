import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

// Always use a disposable project and userData directory. This script never
// touches the user's installed Cutline or its recovery project.
const root = process.cwd();
const parentWork = path.resolve(root, "../qa-motion");
await mkdir(parentWork, { recursive: true });
const work = await mkdtemp(path.join(parentWork, "run-"));
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const executable =
  process.env.CUTLINE_EXECUTABLE ??
  path.join(
    root,
    process.env.CUTLINE_PACKAGED === "1"
      ? "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline"
      : "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
const packaged = process.env.CUTLINE_PACKAGED === "1";
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "user-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const results = [];
const errors = [];
const consoleErrors = [];
let app;
let page;
let failure;
const log = (message, detail) => {
  results.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message, detail === undefined ? "" : JSON.stringify(detail));
};
const invoke = (name, args) =>
  page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
    name,
    args,
  });
const state = async () => (await invoke("state")).snapshot.project;
const waitProject = async (predicate, message) => {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const project = await state();
    if (predicate(project)) {
      // IPC state is authoritative, but React still needs to consume its state
      // event before a second edit captures the next revision.
      await page.waitForTimeout(80);
      return project;
    }
    await page.waitForTimeout(50);
  }
  throw Error(message);
};
const launch = async (file) => {
  app = await electron.launch({
    executablePath: executable,
    args: packaged
      ? ["--force-color-profile=srgb", file]
      : [root, "--force-color-profile=srgb", file],
    env,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar");
  await waitProject((project) => Boolean(project.id), "Project did not open");
};
const number = async (label, value, scope = page) => {
  const field = scope.getByLabel(label, { exact: true });
  if (Number(await field.inputValue()) === value) return;
  const revision = (await state()).revision;
  await field.fill(String(value));
  await field.press("Enter");
  await waitProject(
    (project) => project.revision > revision,
    `${label} did not commit`,
  );
};
const color = async (label, value, scope = page) => {
  const revision = (await state()).revision;
  await scope.getByLabel(label, { exact: true }).evaluate((input, next) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await waitProject(
    (project) => project.revision > revision,
    `${label} did not commit`,
  );
};
const choose = async (label, value, scope = page) => {
  const field = scope.getByLabel(label, { exact: true });
  if ((await field.inputValue()) === value) return;
  const revision = (await state()).revision;
  await field.selectOption(value);
  await waitProject(
    (project) => project.revision > revision,
    `${label} did not commit`,
  );
};
const motionPlayhead = async (frame) => {
  await page
    .getByLabel("Motion playhead", { exact: true })
    .evaluate((input, next) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, String(next));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, frame);
  await page.waitForTimeout(100);
};
const openDetails = async (label, scope = page) => {
  const summary = scope.locator("summary").filter({ hasText: label }).first();
  const open = await summary.evaluate((element) => element.parentElement.open);
  if (!open) await summary.click();
  return summary.locator("..");
};
const seek = async (frame) => {
  await page.getByRole("button", { name: "Go to start", exact: true }).click();
  // Buttons retain focus; clear it so timeline shortcuts reach the player.
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < Math.floor(frame / 10); i++)
    await page.keyboard.press("Shift+ArrowRight");
  for (let i = 0; i < frame % 10; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(180);
};
const runMedia = (command, args, input) => {
  const result = spawnSync(command, args, {
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
};
const rawFrame = (file, frame) =>
  runMedia(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `select=eq(n\\,${frame}),scale=96:54`,
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
  assert(a.length > 0, "Decoded frame must contain pixels");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};
const exportVideo = async (file) => {
  const job = await invoke("test.export", { path: file });
  const started = Date.now();
  while (Date.now() - started < 600000) {
    const current = (await invoke("state")).jobs.find(
      (item) => item.id === job.id,
    );
    if (current?.state === "done") return (Date.now() - started) / 1000;
    if (current?.state === "error") throw Error(current.message);
    await page.waitForTimeout(750);
  }
  throw Error("Motion export did not complete within 10 minutes");
};

try {
  const bundle = await build({
    stdin: {
      contents:
        'export { newProject } from "./src/shared/model.ts"; export { createMotionDemoProject, createMotionScene, createShapeLayer } from "./src/shared/motion-presets.ts";',
      resolveDir: root,
      sourcefile: "qa-motion-fixtures.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, createMotionDemoProject } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const empty = newProject();
  Object.assign(empty, {
    name: "Motion editing QA",
    width: 1920,
    height: 1080,
    fps: 30,
  });
  const editFile = path.join(work, "Motion editing QA.cutline");
  const demoFile = path.join(work, "Motion Graphics Demo.cutline");
  const demo = createMotionDemoProject(1920, 1080);
  await writeFile(
    editFile,
    JSON.stringify({ project: empty, past: [], future: [] }),
  );
  await writeFile(
    demoFile,
    JSON.stringify({ project: demo, past: [], future: [] }),
  );
  assert.equal(demo.width, 1920);
  assert.equal(demo.height, 1080);
  assert(demo.clips.length >= 4);
  await launch(editFile);

  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Motion", exact: true })
    .click();
  await page.getByRole("tab", { name: "Shapes", exact: true }).click();
  await page
    .getByLabel("Search motion library", { exact: true })
    .fill("rectangle");
  assert.equal(await page.locator(".mg-shape").count(), 1);
  await page
    .getByRole("button", { name: "Add Rectangle shape", exact: true })
    .click();
  let project = await waitProject(
    (p) => p.clips.length === 1 && p.motions.length === 1,
    "Shape library did not add a motion clip",
  );
  const shapeMotionId = project.clips[0].motionId;
  const shapeMotion = (p) =>
    p.motions.find((motion) => motion.id === shapeMotionId);
  assert.equal(shapeMotion(project).layers[0].type, "rectangle");
  await page.getByLabel("Select motion layer 1", { exact: true }).click();
  await choose("Layer type", "line");
  assert.equal(
    shapeMotion(await state()).layers[0].strokeWidth,
    8,
    "Converting a fill-only shape to a line gives it a visible stroke",
  );
  await choose("Layer type", "star");
  await color("Layer fill", "#f97316");
  await color("Layer stroke", "#67e8f9");
  await number("Layer stroke width", 7);
  await choose("Fill style", "gradient");
  await color("Gradient color", "#a855f7");
  await number("Gradient angle", 45);
  const transform = await openDetails("Transform & effects");
  await number("Layer glow", 16, transform);
  await number("Layer blur", 2, transform);
  await number("Stroke reveal", 0.7, transform);
  project = await state();
  const styled = shapeMotion(project).layers[0];
  assert.equal(styled.type, "star");
  assert.equal(styled.background, "#f97316");
  assert.equal(styled.stroke, "#67e8f9");
  assert.equal(styled.strokeWidth, 7);
  assert.equal(styled.fillStyle, "gradient");
  assert.equal(styled.gradientColor, "#a855f7");
  assert.equal(styled.gradientAngle, 45);
  assert.equal(styled.glow, 16);
  assert.equal(styled.blur, 2);
  assert.equal(styled.trim, 0.7);
  const fillRevision = project.revision;
  await page.getByLabel("No shape fill", { exact: true }).click();
  await waitProject(
    (p) => p.revision > fillRevision,
    "No-fill style did not commit",
  );
  assert(await page.getByLabel("No shape fill", { exact: true }).isChecked());
  assert.equal(shapeMotion(await state()).layers[0].background, "transparent");
  await invoke("undo");
  assert.equal(shapeMotion(await state()).layers[0].background, "#f97316");
  log(
    "Library shape creation, shape type, gradient fill, stroke, glow, blur and stroke reveal",
  );

  await page
    .getByLabel("Layer animated property", { exact: true })
    .selectOption("x");
  await motionPlayhead(0);
  await page
    .getByRole("button", { name: "Add layer keyframe", exact: true })
    .click();
  await waitProject(
    (p) =>
      shapeMotion(p).layers[0].keyframes.some(
        (key) => key.frame === 0 && key.x !== undefined,
      ),
    "Add keyframe button did not create a starting X key",
  );
  await number("Layer keyframe value", -120);
  await choose("Layer easing", "spring");
  await motionPlayhead(30);
  await page
    .getByRole("button", { name: "Add layer keyframe", exact: true })
    .click();
  await waitProject(
    (p) =>
      shapeMotion(p).layers[0].keyframes.some(
        (key) => key.frame === 30 && key.x !== undefined,
      ),
    "Add keyframe button did not create an ending X key",
  );
  await number("Layer keyframe value", 120);
  await choose("Layer easing", "back");
  await choose("Layer loop", "ping-pong");
  await number("Loop (frames)", 30);
  project = await state();
  const animated = shapeMotion(project).layers[0];
  assert(
    animated.keyframes.some(
      (key) => key.frame === 0 && key.x === -120 && key.easing === "spring",
    ),
  );
  assert(
    animated.keyframes.some(
      (key) => key.frame === 30 && key.x === 120 && key.easing === "back",
    ),
  );
  assert.equal(animated.loop, "ping-pong");
  assert.equal(animated.loopFrames, 30);
  assert(
    await page
      .getByRole("img", { name: "Move X animation curve", exact: true })
      .isVisible(),
  );
  log(
    "Playhead keyframes with spring/back easing, visible curve and ping-pong looping",
  );

  await choose("Layer loop", "cycle");
  await page
    .getByRole("button", { name: "◆ 30 · 120 · Back", exact: true })
    .click();
  await number("Layer keyframe value", 175);
  const cycle = shapeMotion(await state()).layers[0];
  assert(
    cycle.keyframes.some((key) => key.frame === 30 && key.x === 175),
    "Selecting a cycle endpoint must edit that endpoint",
  );
  assert(
    cycle.keyframes.some((key) => key.frame === 0 && key.x === -120),
    "Editing a cycle endpoint must preserve the beginning key",
  );
  await choose("Layer loop", "ping-pong");
  log(
    "Cycle endpoint selection edits the selected key without overwriting its beginning",
  );

  const addLayer = await openDetails("Add a layer");
  await addLayer.getByRole("button", { name: "Triangle", exact: true }).click();
  await waitProject(
    (p) => shapeMotion(p).layers.length === 2,
    "Triangle layer was not added",
  );
  await color("Layer fill", "#22c55e");
  await page
    .getByRole("button", { name: "Duplicate motion layer", exact: true })
    .click();
  await waitProject(
    (p) => shapeMotion(p).layers.length === 3,
    "Motion layer did not duplicate",
  );
  await color("Layer fill", "#ff00aa");
  await page
    .getByRole("button", { name: "Move layer backward", exact: true })
    .click();
  await waitProject(
    (p) => shapeMotion(p).layers[1].background === "#ff00aa",
    "Layer did not move backward",
  );
  await page
    .getByRole("button", { name: "Move layer forward", exact: true })
    .click();
  await waitProject(
    (p) => shapeMotion(p).layers[2].background === "#ff00aa",
    "Layer did not move forward",
  );
  const beforeDelete = structuredClone(shapeMotion(await state()).layers);
  await page
    .getByRole("button", { name: "Remove motion layer", exact: true })
    .click();
  await waitProject(
    (p) => shapeMotion(p).layers.length === 2,
    "Layer did not delete",
  );
  await invoke("undo");
  assert.deepEqual(shapeMotion(await state()).layers, beforeDelete);
  await invoke("redo");
  assert.equal(shapeMotion(await state()).layers.length, 2);
  await invoke("undo");
  assert.deepEqual(shapeMotion(await state()).layers, beforeDelete);
  log(
    "Add, duplicate, reorder and remove motion layers with exact undo/redo restoration",
  );

  await page.getByRole("button", { name: "Go to start", exact: true }).click();
  await page.getByRole("tab", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page
    .getByRole("button", { name: "Add Kinetic title scene", exact: true })
    .click();
  project = await waitProject(
    (p) => p.clips.length === 2 && p.motions.length === 2,
    "Motion scene library did not add an editable scene",
  );
  const sceneClip = project.clips.find(
    (clip) => clip.motionId !== shapeMotionId,
  );
  const sceneMotion = (p) =>
    p.motions.find((motion) => motion.id === sceneClip.motionId);
  const textIndex = sceneMotion(project).layers.findIndex(
    (layer) => layer.type === "text",
  );
  assert(textIndex >= 0, "Scene must contain editable text");
  await page
    .getByLabel(`Select motion layer ${textIndex + 1}`, { exact: true })
    .click();
  const textRevision = (await state()).revision;
  await page
    .getByLabel("Layer text", { exact: true })
    .fill("CREATE. ANIMATE. EXPORT.");
  await page.getByLabel("Layer text", { exact: true }).press("Tab");
  await waitProject(
    (p) => p.revision > textRevision,
    "Animated text did not commit",
  );
  await choose("Text reveal", "word-rise");
  await number("Stagger (frames)", 4);
  await number("Layer font size", 94);
  const text = sceneMotion(await state()).layers[textIndex];
  assert.equal(text.text, "CREATE. ANIMATE. EXPORT.");
  assert.equal(text.textAnimation, "word-rise");
  assert.equal(text.staggerFrames, 4);
  assert.equal(text.fontSize, 94);
  log("Complete editable scene creation and animated text with word stagger");
  await motionPlayhead(45);
  await page.screenshot({ path: path.join(work, "motion-editing.png") });

  const edited = await state();
  await invoke("save");
  const saved = JSON.parse(await readFile(editFile, "utf8")).project;
  const serializableEdited = JSON.parse(JSON.stringify(edited));
  assert.deepEqual(saved.clips, serializableEdited.clips);
  assert.deepEqual(saved.motions, serializableEdited.motions);
  await app.close();
  app = undefined;
  await launch(editFile);
  const reopened = await state();
  const serializableReopened = JSON.parse(JSON.stringify(reopened));
  assert.deepEqual(serializableReopened.clips, saved.clips);
  assert.deepEqual(serializableReopened.motions, saved.motions);
  log("Project edits survive save and a full app relaunch");

  await invoke("test.load", { path: demoFile });
  await waitProject(
    (project) => project.id === demo.id,
    "Motion demo did not load",
  );
  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Motion", exact: true })
    .click();
  const canvasHashes = [];
  const previewPixels = new Map();
  for (const frame of [0, 15, 45, 75, 135, 195]) {
    await seek(frame);
    const screenshot = await page.locator(".canvas").screenshot({
      path: path.join(
        work,
        `preview-frame-${String(frame).padStart(3, "0")}.png`,
      ),
    });
    canvasHashes.push(createHash("sha256").update(screenshot).digest("hex"));
    previewPixels.set(
      frame,
      runMedia(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          "pipe:0",
          "-vf",
          "scale=96:54",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        screenshot,
      ),
    );
  }
  assert(
    new Set(canvasHashes).size >= 4,
    "Preview scenes should visibly animate",
  );
  await seek(15);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const before = await page.locator(".timecode").innerText();
  await page.waitForTimeout(900);
  const after = await page.locator(".timecode").innerText();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  assert.notEqual(after, before, "Motion preview playhead must advance");
  log("Motion preview seeks across six sampled frames and plays continuously");
  await page.screenshot({ path: path.join(work, "motion-editor.png") });

  await page.locator(".timeline-clip").first().click();

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 });
  });
  await page.waitForTimeout(250);
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
  assert(layout.scrollHeight <= layout.height + 1, JSON.stringify(layout));
  await page.screenshot({ path: path.join(work, "motion-minimum-window.png") });
  log("Motion workspace remains inside the supported minimum window", layout);

  const video = path.join(work, "Motion Graphics Demo.mp4");
  const seconds = await exportVideo(video);
  const metadata = JSON.parse(
    runMedia(ffprobe, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      video,
    ]).toString(),
  );
  const stream = metadata.streams.find((item) => item.codec_type === "video");
  assert(stream, "MP4 contains video");
  assert.equal(stream.codec_name, "h264");
  assert.equal(stream.width, 1920);
  assert.equal(stream.height, 1080);
  assertCfrExport(ffprobe, video, { fps: 30, frames: 240 });
  assert(Math.abs(Number(metadata.format.duration) - 8) < 0.1);
  const sampled = [0, 15, 45, 75, 135, 195, 225].map((frame) => ({
    frame,
    pixels: rawFrame(video, frame),
  }));
  const frameDifferences = sampled.slice(1).map((item, i) => ({
    from: sampled[i].frame,
    to: item.frame,
    meanPixelDifference: difference(sampled[i].pixels, item.pixels),
  }));
  assert(
    frameDifferences.filter((item) => item.meanPixelDifference > 1).length >= 4,
    `Rendered motion should visibly change: ${JSON.stringify(frameDifferences)}`,
  );
  const previewExportDifferences = sampled
    .filter((item) => previewPixels.has(item.frame))
    .map((item) => ({
      frame: item.frame,
      meanPixelDifference: difference(
        previewPixels.get(item.frame),
        item.pixels,
      ),
    }));
  assert(
    previewExportDifferences.every((item) => item.meanPixelDifference < 18),
    `Preview/export should match within antialiasing/compression tolerance: ${JSON.stringify(previewExportDifferences)}`,
  );
  for (const frame of [15, 75, 135, 195])
    runMedia(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-i",
      video,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      path.join(work, `export-frame-${String(frame).padStart(3, "0")}.png`),
    ]);
  await writeFile(
    path.join(work, "export-metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  log(
    "Cutline renders a playable 8-second 1080p H.264 MP4 with changing motion frames",
    {
      seconds,
      video,
      frameDifferences,
      previewExportDifferences,
    },
  );
  assert.deepEqual(errors, [], "Renderer must have no uncaught errors");
  assert.deepEqual(consoleErrors, [], "Renderer must have no console errors");
  log("No renderer exceptions or console errors");
} catch (error) {
  failure = error.stack ?? String(error);
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(work, "failure.png") })
      .catch(() => {});
} finally {
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(
      {
        passed: !failure,
        work,
        executable,
        packaged,
        results,
        errors,
        consoleErrors,
        ...(failure ? { failure } : {}),
      },
      null,
      2,
    ),
  );
  if (app) await app.close();
  console.log(`Motion QA artifacts: ${work}`);
}
if (failure) throw Error(failure);
