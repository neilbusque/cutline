import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Run after building. The source can stay in Documents while CUTLINE_APP points
// at an isolated /tmp build. Every project, connection and recovery file here
// lives in a new disposable directory; the installed user's app is untouched.
// CUTLINE_APP=/tmp/cutline-promo-build node scripts/qa-promo.mjs
// Optional: CUTLINE_EXECUTABLE, CUTLINE_PACKAGED=1, CUTLINE_PROMO_RESULTS.
const root = process.cwd();
const appRoot = path.resolve(process.env.CUTLINE_APP || root);
const packaged = process.env.CUTLINE_PACKAGED === "1";
const executable = process.env.CUTLINE_EXECUTABLE || path.join(
  appRoot, packaged
    ? "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline"
    : "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const parent = path.resolve(process.env.CUTLINE_PROMO_RESULTS || path.join(root, "../qa-promo"));
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "user-data");
const env = { ...process.env, CUTLINE_QA: "1", CUTLINE_DATA_DIR: data,
  CUTLINE_PROJECTS_DIR: path.join(work, "projects") };
delete env.ELECTRON_RUN_AS_NODE;
const ffmpeg = path.join(root, "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg");
const ffprobe = path.join(root, "node_modules/@ffprobe-installer/darwin-arm64/ffprobe");
const ids = ["promo-punch", "promo-stack", "promo-invert", "promo-zoom"];
const report = { work, appRoot, runtime: [], checks: [], typography: [], parity: [],
  screenshots: [], pageErrors: [], consoleErrors: [], export: null, failed: null };
let app, page, mcp;
const log = (message, detail) => {
  report.checks.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message);
};
const invoke = (name, args) => page.evaluate(({ name, args }) => window.cutline.invoke(name, args), { name, args });
const current = async () => (await invoke("state")).snapshot.project;
const clone = (value) => JSON.parse(JSON.stringify(value));
const waitProject = async (predicate, message) => {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const project = await current();
    if (predicate(project)) { await page.waitForTimeout(100); return project; }
    await page.waitForTimeout(75);
  }
  throw Error(message);
};
const tx = async (commands) => {
  const p = await current();
  const result = await invoke("edit", { projectId: p.id, revision: p.revision, label: "Promo QA arrangement", commands });
  await page.waitForTimeout(120);
  return result;
};
const call = async (name, args = {}) => {
  const reply = await mcp.callTool({ name, arguments: args });
  const text = reply.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert(!reply.isError, `${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};
const seek = async (frame) => {
  const p = await current();
  await call("cutline_preview", { projectId: p.id, revision: p.revision, frame, playing: false });
  await page.waitForTimeout(240);
};
const close = async () => {
  await mcp?.close().catch(() => {}); mcp = undefined;
  if (app) await app.close(); app = undefined;
};
const launch = async (file) => {
  app = await electron.launch({ executablePath: executable,
    args: [...(packaged ? [] : [appRoot]), file, "--force-color-profile=srgb"], env,
    timeout: 45000 });
  const runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), appPath: app.getAppPath(), userData: app.getPath("userData"), packaged: app.isPackaged }));
  assert.equal(runtime.userData, data, "Never run QA against the user's data");
  assert.equal(runtime.packaged, packaged);
  report.runtime.push(runtime);
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") report.consoleErrors.push(entry.text()); });
  // The promo flow is entirely local. Fail rather than contacting a provider.
  await page.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.waitForSelector(".titlebar", { timeout: 45000 });
  await waitProject((p) => Boolean(p.id), "Project did not open");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
  const state = await invoke("state");
  mcp = new Client({ name: "Cutline Promo QA", version: "1.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(state.settings.mcpUrl)));
};
const details = async (name) => {
  const summary = page.locator("summary").filter({ hasText: new RegExp(`^${name}$`) }).first();
  await summary.waitFor();
  if (!(await summary.evaluate((node) => node.parentElement.open))) await summary.click();
  return summary.locator("..");
};
const number = async (label, value, scope = page) => {
  const input = scope.getByLabel(label, { exact: true });
  if (Number(await input.inputValue()) === value) return;
  const before = (await current()).revision;
  await input.fill(String(value)); await input.press("Enter");
  await waitProject((p) => p.revision > before, `${label} did not commit`);
};
const run = (binary, args) => execFileSync(binary, args, { timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
const pixels = (file, frame = 0) => run(ffmpeg, ["-v", "error", "-i", file,
  "-vf", `select=eq(n\\,${frame}),scale=320:180`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
const difference = (a, b) => {
  assert.equal(a.length, b.length); assert(a.length > 0);
  let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};
const inspectText = async (frame, orientation) => {
  await seek(frame);
  const layers = await page.locator('.canvas [data-motion-type="text"]').evaluateAll((nodes) => nodes.map((node) => ({
    text: node.textContent, width: node.clientWidth, height: node.clientHeight,
    scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
  })));
  assert(layers.length, `No native text at ${orientation} frame ${frame}`);
  const overflow = layers.filter((layer) => layer.scrollWidth > layer.width + 2 || layer.scrollHeight > layer.height + 2);
  assert.deepEqual(overflow, [], `${orientation} title overflow at ${frame}`);
  report.typography.push({ orientation, frame, layers });
};
const addScenes = async (catalog) => {
  await page.locator(".library-tabs button").filter({ hasText: /^Motion$/ }).click();
  await page.getByRole("tab", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "Promo", exact: true }).click();
  assert.equal(await page.locator(".mg-scene").count(), 4, "Promo collection should show four scenes");
  const added = [];
  for (const id of ids) {
    const descriptor = catalog.find((scene) => scene.id === id);
    assert(descriptor, `Missing promo catalog entry ${id}`);
    const before = await current();
    await page.getByRole("button", { name: `Add ${descriptor.name} scene`, exact: true }).click();
    const after = await waitProject((p) => p.clips.length === before.clips.length + 1, `${id} not added through UI`);
    const clip = after.clips.find((clip) => !before.clips.some((prior) => prior.id === clip.id));
    const motion = after.motions.find((motion) => motion.id === clip.motionId);
    assert(motion?.layers.some((layer) => layer.type === "text" && layer.name), `${id} must contain named editable text`);
    added.push(clip.id);
  }
  let start = 0;
  const p = await current();
  await tx(added.map((id) => { const clip = p.clips.find((item) => item.id === id); const command = { type: "clip.update", id, patch: { start } }; start += clip.duration; return command; }));
  return added;
};
const load = async (file, id) => {
  await invoke("test.load", { path: file });
  await waitProject((p) => p.id === id, "Disposable fixture did not load");
};

try {
  assert(existsSync(path.join(appRoot, "dist/main/main.cjs")), "Build the app before running promo QA");
  const bundle = await build({ stdin: { contents: 'export { newProject } from "./src/shared/model.ts"; export { motionScenes } from "./src/shared/motion-presets.ts";', resolveDir: root, sourcefile: "qa-promo-fixtures.ts", loader: "ts" }, bundle: true, format: "esm", platform: "node", write: false });
  const { newProject, motionScenes } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const landscape = { ...newProject(), name: "Promo QA landscape", width: 640, height: 360, fps: 30 };
  const portrait = { ...newProject(), name: "Promo QA portrait", width: 360, height: 640, fps: 30 };
  const landscapeFile = path.join(work, "Promo landscape.cutline"), portraitFile = path.join(work, "Promo portrait.cutline");
  for (const [project, file] of [[landscape, landscapeFile], [portrait, portraitFile]])
    await writeFile(file, JSON.stringify({ project, past: [], future: [], filePath: file }));
  await launch(landscapeFile);
  const added = await addScenes(motionScenes);
  log("All four Promo scenes add through the actual Motion library with native editable layers");

  let p = await current();
  const selectedId = added.at(-1), selected = p.clips.find((clip) => clip.id === selectedId);
  const motionId = selected.motionId;
  const textIndex = p.motions.find((motion) => motion.id === motionId).layers.findIndex((layer) => layer.type === "text");
  const originalText = p.motions.find((motion) => motion.id === motionId).layers[textIndex].text;
  await page.getByLabel(`Select motion layer ${textIndex + 1}`, { exact: true }).click();
  assert((await page.getByLabel("Layer name", { exact: true }).inputValue()).length > 0);
  const input = page.getByLabel("Layer text", { exact: true });
  await input.fill("BOLD"); await input.press("Tab");
  await waitProject((p) => p.motions.find((motion) => motion.id === motionId).layers[textIndex].text === "BOLD", "Text edit did not commit");
  await invoke("undo");
  await waitProject((p) => p.motions.find((motion) => motion.id === motionId).layers[textIndex].text === originalText, "Undo did not restore text");
  await invoke("redo");
  await waitProject((p) => p.motions.find((motion) => motion.id === motionId).layers[textIndex].text === "BOLD", "Redo did not restore edit");
  log("Named promo headline edits and undo/redo survive as native motion data");

  const accents = await details("Promo accents");
  await accents.getByRole("button", { name: "Reset promo accents", exact: true }).click();
  await page.waitForTimeout(150);
  await number("RGB split (px)", 8, accents); await number("Invert colors", 0.65, accents);
  let effectClip = (await current()).clips.find((clip) => clip.id === selectedId);
  assert.equal(effectClip.rgbSplit, 8); assert.equal(effectClip.invert, 0.65);
  await accents.getByRole("button", { name: "Reset promo accents", exact: true }).click();
  await waitProject((p) => { const c = p.clips.find((clip) => clip.id === selectedId); return c.rgbSplit === 0 && c.invert === 0; }, "Reset accents did not clear amounts");
  await seek(selected.start);
  const keys = await details("Animate whole clip");
  for (const [property, value] of [["rgbSplit", 7], ["invert", 1]]) {
    await keys.getByLabel("Animated property", { exact: true }).selectOption(property);
    await keys.getByRole("button", { name: "Add at playhead", exact: true }).click();
    await waitProject((p) => p.clips.find((clip) => clip.id === selectedId).keyframes.some((key) => key.property === property && key.frame === 0), `${property} UI key not added`);
    await number("Selected key value", value, keys);
  }
  effectClip = (await current()).clips.find((clip) => clip.id === selectedId);
  assert(effectClip.keyframes.some((key) => key.property === "rgbSplit" && key.value === 7));
  assert(effectClip.keyframes.some((key) => key.property === "invert" && key.value === 1));
  await accents.getByRole("button", { name: "Reset promo accents", exact: true }).click();
  await waitProject((p) => !p.clips.find((clip) => clip.id === selectedId).keyframes.some((key) => ["rgbSplit", "invert"].includes(key.property)), "Reset accents left animation keys");
  await invoke("undo"); await page.waitForTimeout(150);
  effectClip = (await current()).clips.find((clip) => clip.id === selectedId);
  assert(effectClip.keyframes.some((key) => key.property === "rgbSplit" && key.value === 7));
  // Resolve the test pulse after six frames, retaining the two UI-authored keys.
  await tx([{ type: "clip.update", id: selectedId, patch: { keyframes: [...effectClip.keyframes,
    { property: "rgbSplit", frame: 6, value: 0, easing: "hold" },
    { property: "invert", frame: 6, value: 0, easing: "hold" }] } }]);
  log("RGB split and invert controls, keyframe selectors, reset and undo work in the Inspector");
  p = await current();
  await invoke("save");
  const saved = JSON.parse(await readFile(landscapeFile, "utf8")).project;
  assert.deepEqual(saved.clips, clone(p.clips)); assert.deepEqual(saved.motions, clone(p.motions));
  await close(); await launch(landscapeFile);
  const reopened = await current();
  assert.deepEqual(clone(reopened.clips), saved.clips); assert.deepEqual(clone(reopened.motions), saved.motions);
  log("Promo layers and effect keys persist through saving and a full isolated app relaunch");

  for (const clip of reopened.clips) {
    const hold = clip.start + Math.floor(clip.duration * 0.55);
    await inspectText(hold, "landscape");
  }
  await page.locator(".stage").click({ position: { x: 4, y: 4 } });
  const samples = reopened.clips.flatMap((clip) => [clip.start + Math.min(3, clip.duration - 1), clip.start + Math.floor(clip.duration * 0.55), clip.start + clip.duration - 3]);
  const previews = new Map();
  for (const frame of samples) {
    await seek(frame);
    const file = path.join(work, `preview-${frame}.png`);
    await page.locator(".canvas").screenshot({ path: file });
    previews.set(frame, pixels(file));
  }
  const editor = path.join(work, "promo-editor.png"); await page.screenshot({ path: editor }); report.screenshots.push(editor);
  const output = path.join(work, "Promo-QA.mp4");
  const job = await invoke("test.export", { path: output }), started = Date.now();
  let complete;
  while (Date.now() - started < 600000) {
    complete = (await invoke("state")).jobs.find((item) => item.id === job.id);
    if (complete?.state === "done") break;
    if (["error", "cancelled"].includes(complete?.state)) throw Error(complete.message);
    await page.waitForTimeout(500);
  }
  assert.equal(complete?.state, "done", "Promo export timed out");
  const probe = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]).toString());
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const frames = Math.max(...reopened.clips.map((clip) => clip.start + clip.duration));
  assert.equal(video.codec_name, "h264"); assert.equal(video.width, 640); assert.equal(video.height, 360); assertCfrExport(ffprobe, output, { fps: 30, frames: frames });
  assert.equal(Number(video.nb_frames), frames);
  run(ffmpeg, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
  report.export = { output, frames, seconds: frames / 30, width: 640, height: 360, fullDecode: true };
  for (const frame of samples) report.parity.push({ frame, meanPixelDifference: difference(previews.get(frame), pixels(output, frame)) });
  assert(report.parity.every((item) => item.meanPixelDifference < 5), `Preview/export parity exceeded tolerance: ${JSON.stringify(report.parity)}`);
  log("The actual native worker exports every promo frame with full decode and preview/export pixel parity", report.export);

  await load(portraitFile, portrait.id); await addScenes(motionScenes);
  const tall = await current();
  for (const clip of tall.clips) await inspectText(clip.start + Math.floor(clip.duration * 0.55), "portrait");
  await invoke("save");
  const portraitShot = path.join(work, "promo-portrait.png"); await page.screenshot({ path: portraitShot }); report.screenshots.push(portraitShot);
  log("All four promo title holds fit both landscape and portrait without text overflow");
  assert.deepEqual(report.pageErrors, [], "Renderer errors");
} catch (error) {
  report.failed = error.stack || String(error);
  if (page) await page.screenshot({ path: path.join(work, "failure.png") }).catch(() => {});
  console.error(report.failed); process.exitCode = 1;
} finally {
  await close().catch((error) => { report.closeError = String(error); process.exitCode = 1; });
  await writeFile(path.join(work, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Promo QA report: ${path.join(work, "report.json")}`);
}
