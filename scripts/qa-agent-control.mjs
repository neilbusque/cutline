import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

// This exercises the same stdio MCP endpoint used by external clients. It uses
// disposable media, project files and app data. A signed-in model smoke is
// opt-in through CUTLINE_TEST_CODEX=1.
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED !== "0";
const appRoot = process.env.CUTLINE_APP ?? path.join(root, "release/Cutline-darwin-arm64/Cutline.app");
const outputParent = process.env.CUTLINE_AGENT_QA_RESULTS ?? path.resolve(root, "../qa-agent-control");
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, "run-"));
const data = path.join(work, "user-data");
await mkdir(data, { recursive: true });
const connectionFile = path.join(data, "connection.json");
const executable = process.env.CUTLINE_EXECUTABLE ?? (packaged
  ? path.join(appRoot, "Contents/MacOS/Cutline")
  : path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
const ffmpeg = path.join(root, "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg");
const ffprobe = path.join(root, "node_modules/@ffprobe-installer/darwin-arm64/ffprobe");
const env = { ...process.env, CUTLINE_QA: "1", CUTLINE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const results = [];
const rendererErrors = [];
const consoleErrors = [];
const calls = [];
let app;
let page;
let client;
let transport;
let httpClient;
let failure;
let privateSource;
const log = (message, detail) => {
  results.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message, detail === undefined ? "" : JSON.stringify(detail));
};
const media = (binary, args) => {
  const result = spawnSync(binary, args, { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
};
const invoke = (name, args) => page.evaluate(
  ({ name, args }) => window.cutline.invoke(name, args), { name, args },
);
const call = async (name, args = {}, expectError = false) => {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  calls.push({ name, isError: Boolean(response.isError) });
  if (expectError) {
    assert(response.isError, `${name} should reject this request`);
    return text;
  }
  assert(!response.isError, `${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};
// Full detail returns every clip field; the default summary is for reading.
const inspect = async () => call("cutline_inspect", { detail: "full" });
const edit = async (label, actions, extra = {}) => {
  const p = await inspect();
  return call("cutline_edit", { projectId: p.id, revision: p.revision, label, actions, ...extra });
};
const revision = (p) => ({ projectId: p.id, revision: p.revision });
const snapshot = (p) => JSON.parse(JSON.stringify(p));
const noPrivateSource = (value) => {
  const text = JSON.stringify(value);
  assert(!text.includes(privateSource), "Read tools must not expose a local source media path");
  for (const asset of value?.assets ?? value?.project?.assets ?? []) {
    for (const key of ["path", "proxy", "thumbnail"])
      assert(!(key in asset), `Public assets must omit ${key}`);
  }
};
const waitFile = async (file) => {
  for (let i = 0; i < 100; i++) {
    try { await stat(file); return; } catch { await page.waitForTimeout(50); }
  }
  throw Error("Isolated MCP connection file was not created");
};
const waitJob = async (id) => {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const list = await call("cutline_jobs");
    noPrivateSource(list);
    const jobs = Array.isArray(list) ? list : list.jobs;
    const job = jobs.find((item) => item.id === id);
    if (job?.state === "done") return { job, seconds: (Date.now() - started) / 1000 };
    if (job?.state === "error") throw Error(job.message);
    await page.waitForTimeout(500);
  }
  throw Error("Agent-controlled export did not finish within three minutes");
};

try {
  const bundle = await build({
    stdin: {
      contents: 'export {newProject,makeClip} from "./src/shared/model.ts";',
      resolveDir: root, sourcefile: "qa-agent-fixture.ts", loader: "ts",
    }, bundle: true, format: "esm", platform: "node", write: false,
  });
  const { newProject, makeClip } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`,
  );
  const p = newProject();
  Object.assign(p, { name: "Agent control QA", width: 640, height: 360, fps: 30 });
  privateSource = path.join(work, "private-source-canary.mp4");
  media(ffmpeg, [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=#17334d:s=640x360:r=30:d=3",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", privateSource,
  ]);
  const privateThumbnail = path.join(work, "private-thumbnail-canary.png");
  media(ffmpeg, ["-v", "error", "-y", "-i", privateSource, "-frames:v", "1", privateThumbnail]);
  p.assets = [{ id: "qa-private-asset", name: "QA blue source.mp4", kind: "video",
    path: privateSource, thumbnail: privateThumbnail, proxy: privateSource,
    width: 640, height: 360, duration: 3, fps: 30, hasAudio: true }];
  p.clips = [{ ...makeClip(p, "video", "video", 0, p.assets[0]),
    id: "qa-video", duration: 90, width: 640, height: 360 }];
  const initialFile = path.join(work, "Agent control QA.cutline");
  await writeFile(initialFile, JSON.stringify({ project: p, past: [], future: [] }));
  app = await electron.launch({ executablePath: executable,
    args: packaged ? [initialFile] : [root, initialFile], env });
  page = await app.firstWindow();
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // A failed load names its address, so a 404 says what was missing.
    const where = message.location()?.url;
    consoleErrors.push(where ? `${message.text()} (${where})` : message.text());
  });
  await page.waitForSelector(".titlebar");
  await waitFile(connectionFile);
  client = new Client({ name: "cutline-agent-control-qa", version: "1.0" });
  const settings = (await invoke("state")).settings;
  const launcher = settings.mcpLauncher;
  assert.equal(typeof launcher, "string", "Cutline must provide a bundled-runtime MCP launcher");
  assert.equal((await stat(launcher)).mode & 0o777, 0o700, "MCP launcher should be owner-only");
  assert.equal((await stat(connectionFile)).mode & 0o777, 0o600, "MCP capability file should be owner-only");
  transport = new StdioClientTransport({ command: launcher, args: [],
    env: { ...env, CUTLINE_CONNECTION: connectionFile }, stderr: "pipe" });
  await client.connect(transport);
  const toolList = await client.listTools();
  await writeFile(path.join(work, "tools.json"), JSON.stringify(toolList, null, 2));
  // Session-wrapped external list: 52,000 since cutline_reference and cutline_style_reel (0.30, 0.31).
  assert(JSON.stringify(toolList).length < 52000, "Tool definitions must stay within their 52,000 character budget");
  const names = new Set(toolList.tools.map((tool) => tool.name));
  for (const name of ["cutline_inspect", "cutline_edit", "cutline_editing_schema", "cutline_jobs", "cutline_undo", "cutline_redo"])
    assert(names.has(name), `Missing agent tool ${name}`);
  assert(toolList.tools.every((tool) => tool.name.startsWith("cutline_")));
  assert(!names.has("test.export") && !names.has("test.load"));
  const initial = await inspect();
  assert.equal(initial.id, p.id);
  assert.equal(initial.clips.length, 1);
  noPrivateSource(initial);
  const schema = await call("cutline_editing_schema");
  noPrivateSource(schema);
  assert(JSON.stringify(schema).includes("clip.trim"));
  assert(JSON.stringify(schema).length < 20000, "The default editing guide must be short");
  const clipSection = await call("cutline_editing_schema", { section: "clip" });
  assert(clipSection.schema.properties.cameraMotion, "Schema sections return one validator");
  const summary = await call("cutline_inspect");
  assert.equal(summary.detail, "summary");
  assert.equal(summary.clips[0].id, "qa-video");
  noPrivateSource(summary);
  log("Real packaged stdio MCP initializes, lists editor tools and reads a path-free project", { tools: toolList.tools.length });

  const bridgeStatus = await call("cutline_connection_status");
  assert.equal(bridgeStatus.ready, true);
  assert.equal(bridgeStatus.launcherReady, true);
  assert.equal(bridgeStatus.tools, toolList.tools.length);
  assert(bridgeStatus.protocols.includes("stdio") && bridgeStatus.protocols.includes("streamable-http"));
  noPrivateSource(bridgeStatus);
  assert(!JSON.stringify(bridgeStatus).includes(connectionFile));
  await page.getByRole("button", { name: "Settings & connections", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsDialog.getByRole("button", { name: "Test local connection", exact: true }).click();
  await settingsDialog.getByText("Local connection tested. Ask your assistant to inspect the project to confirm its connection.", { exact: true }).waitFor();
  assert(await settingsDialog.getByText("Local bridge ready", { exact: true }).isVisible());
  // Settings opens on the built-in assistants (Claude and Codex inside Cutline).
  assert(await settingsDialog.getByRole("tab", { name: "In Cutline", exact: true }).getAttribute("aria-selected") === "true");
  assert(await settingsDialog.getByRole("button", { name: "Sign in with ChatGPT", exact: true }).isVisible());
  assert(await settingsDialog.getByLabel("Claude model for the assistant", { exact: true }).isVisible());
  await settingsDialog.getByRole("tab", { name: "Claude Desktop", exact: true }).click();
  const claudeFixture = path.join(data, "test-claude-config.json");
  await writeFile(claudeFixture, JSON.stringify({ mcpServers: { keep: { command: "existing-server" } }, preference: "preserve" }));
  await settingsDialog.getByRole("button", { name: "Install Claude Desktop connection", exact: true }).click();
  await settingsDialog.getByText("Cutline connection installed. Restart Claude Desktop to load its tools.", { exact: true }).waitFor();
  const installed = JSON.parse(await readFile(claudeFixture, "utf8"));
  assert.equal(installed.preference, "preserve");
  assert.equal(installed.mcpServers.keep.command, "existing-server");
  assert.equal(installed.mcpServers.cutline.command, launcher);
  assert.equal(installed.mcpServers.cutline.env.CUTLINE_CONNECTION, connectionFile);
  const claudeBackup = (await readdir(data)).find((file) => file.startsWith("test-claude-config.json.cutline-backup-"));
  assert(claudeBackup, "Claude setup should back up an existing config");
  assert.equal(JSON.parse(await readFile(path.join(data, claudeBackup), "utf8")).preference, "preserve");
  await page.screenshot({ path: path.join(work, "connection-claude-desktop.png") });
  await settingsDialog.getByRole("tab", { name: "Claude Code", exact: true }).click();
  assert(await settingsDialog.getByRole("button", { name: "Add to Claude Code", exact: true }).isVisible());
  assert((await settingsDialog.locator(".ac-code").textContent()).includes("claude mcp add --scope user"));
  await settingsDialog.getByRole("tab", { name: "Codex", exact: true }).click();
  assert((await settingsDialog.locator(".ac-code").first().innerText()).includes("codex mcp add"));
  const codexFixture = path.join(data, "test-codex-config.toml");
  const codexOriginal = 'model = "preserve-model"\n\n[mcp_servers.keep]\ncommand = "existing-server"\n\n[mcp_servers.cutline]\ncommand = "outdated-cutline"\n\n[mcp_servers.cutline.env]\nOLD = "outdated-env"\n\n[profiles.keep]\nmodel = "preserve-profile"\n';
  await writeFile(codexFixture, codexOriginal);
  await settingsDialog.getByRole("button", { name: "Install Codex connection", exact: true }).click();
  await settingsDialog.getByText("Cutline connection installed. Start a new Codex chat or reconnect MCP to load its tools.", { exact: true }).waitFor();
  const codexInstalled = await readFile(codexFixture, "utf8");
  assert(codexInstalled.includes('model = "preserve-model"'));
  assert(codexInstalled.includes('[mcp_servers.keep]\ncommand = "existing-server"'));
  assert(codexInstalled.includes('[profiles.keep]\nmodel = "preserve-profile"'));
  assert.equal((codexInstalled.match(/\[mcp_servers\.cutline\]/g) ?? []).length, 1);
  assert.equal((codexInstalled.match(/\[mcp_servers\.cutline\.env\]/g) ?? []).length, 1);
  assert(codexInstalled.includes(launcher));
  assert(codexInstalled.includes(connectionFile));
  assert(!codexInstalled.includes("outdated-cutline") && !codexInstalled.includes("outdated-env"));
  const codexBackup = (await readdir(data)).find((file) => file.startsWith("test-codex-config.toml.cutline-backup-"));
  assert(codexBackup, "Codex setup should back up an existing config");
  assert.equal(await readFile(path.join(data, codexBackup), "utf8"), codexOriginal);
  await page.screenshot({ path: path.join(work, "connection-codex.png") });
  await settingsDialog.getByRole("tab", { name: "ChatGPT web", exact: true }).click();
  assert((await settingsDialog.innerText()).includes("Secure MCP Tunnel"));
  await page.screenshot({ path: path.join(work, "connection-chatgpt.png") });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }));
  await page.waitForTimeout(150);
  const connectionLayout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
  assert(connectionLayout.scrollWidth <= connectionLayout.width + 1);
  assert(connectionLayout.scrollHeight <= connectionLayout.height + 1);
  await page.screenshot({ path: path.join(work, "connection-minimum-window.png") });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }));
  await settingsDialog.getByRole("button", { name: "Close settings", exact: true }).click();
  log("Connection UI tests the bundled launcher, preserves isolated Claude/Codex configs and distinguishes local clients from ChatGPT cloud");

  const dryRun = await edit("Preview a split without committing", [{ type: "clip.split", clipId: "qa-video", at: { frame: 45 }, rightRef: "right" }], { dryRun: true });
  assert.equal((await inspect()).revision, initial.revision);
  assert.equal((await inspect()).clips.length, 1);
  assert(JSON.stringify(dryRun).includes("right"));
  noPrivateSource(dryRun);
  log("High-level edit dry-run plans a split without changing the project or undo history");

  const split = await edit("Split, trim and close the gap", [
    { type: "clip.split", clipId: "qa-video", at: { frame: 45 }, rightRef: "tail" },
    { type: "clip.trim", clipId: "$tail", start: { frame: 55 }, end: { frame: 80 } },
    { type: "clip.move", clipId: "$tail", at: { seconds: 1.5 } },
  ]);
  noPrivateSource(split);
  let current = await inspect();
  assert.equal(current.clips.length, 2);
  const tail = current.clips.find((clip) => clip.id !== "qa-video");
  assert.equal(tail.start, 45);
  assert.equal(tail.duration, 25);
  assert(Math.abs(tail.sourceIn - 55 / 30) < 0.0001);
  assert.equal(tail.animationOffset, 55);
  assert.equal(current.clips.find((clip) => clip.id === "qa-video").duration, 45);
  log("One atomic high-level transaction splits, trims and moves a referenced clip in frames/seconds");

  const beforeConflict = snapshot(current);
  await call("cutline_edit", { ...revision(initial), label: "Reject stale revision",
    actions: [{ type: "clip.update", clipId: "qa-video", patch: { opacity: 0.1 } }] }, true);
  assert.deepEqual(await inspect(), beforeConflict);
  await call("cutline_edit", { ...revision(current), label: "Reject invalid second action",
    actions: [
      { type: "clip.update", clipId: "qa-video", patch: { opacity: 0.1 } },
      { type: "clip.update", clipId: "missing-clip", patch: { opacity: 0.2 } },
    ] }, true);
  assert.deepEqual(await inspect(), beforeConflict);
  log("Stale revisions and a failing second action reject atomically without partial edits");

  await edit("Create editable motion scene and line", [
    { type: "motion.scene", scene: "orbit-logo", at: { frame: 0 }, ref: "scene" },
    { type: "clip.update", clipId: "$scene", patch: { duration: 60 } },
    { type: "motion.shape", shape: "line", at: { frame: 0 }, ref: "line" },
    { type: "clip.update", clipId: "$line", patch: { duration: 60 } },
  ]);
  current = await inspect();
  const lineClip = current.clips.find((clip) => clip.text === "Line");
  assert(lineClip, "Shape creation should produce an editable line clip");
  const lineMotionId = lineClip.motionId;
  await edit("Style and animate a motion layer", [
    { type: "motion.layer.update", motionId: lineMotionId, layer: 0,
      patch: { stroke: "#67e8f9", strokeWidth: 9, glow: 12 } },
    { type: "motion.keyframe", motionId: lineMotionId, layer: 0,
      property: "trim", frame: 0, value: 0, easing: "spring" },
    { type: "motion.keyframe", motionId: lineMotionId, layer: 0,
      property: "trim", frame: 20, value: 1, easing: "linear" },
  ]);
  current = await inspect();
  const lineLayer = current.motions.find((motion) => motion.id === lineMotionId).layers[0];
  assert.equal(lineLayer.stroke, "#67e8f9");
  assert.equal(lineLayer.strokeWidth, 9);
  assert.equal(lineLayer.glow, 12);
  assert(lineLayer.keyframes.some((key) => key.frame === 0 && key.trim === 0 && key.easing === "spring"));
  assert(lineLayer.keyframes.some((key) => key.frame === 20 && key.trim === 1));
  noPrivateSource(current);
  log("An external agent creates full motion scenes/shapes and styles/keyframes their editable layers");

  const srt = "1\n00:00:00,000 --> 00:00:02,000\nFULL AGENT CONTROL\n";
  await edit("Import editable captions", [{ type: "caption.import", srt, at: { frame: 0 } }]);
  current = await inspect();
  const captions = current.clips.filter((clip) => clip.kind === "caption");
  assert.equal(captions.length, 1);
  await edit("Correct and style captions", [
    { type: "caption.update", clipId: captions[0].id, text: "EDITED THROUGH MCP" },
    { type: "caption.style", clipIds: [captions[0].id],
      patch: { captionStyle: "karaoke", color: "#ffffff", fontSize: 34 } },
  ]);
  current = await inspect();
  const corrected = current.clips.find((clip) => clip.id === captions[0].id);
  assert.equal(corrected.text, "EDITED THROUGH MCP");
  assert.equal(corrected.captionStyle, "karaoke");
  assert.equal(corrected.fontSize, 34);
  const writtenSrt = await call("cutline_get_srt");
  noPrivateSource(writtenSrt);
  assert(writtenSrt.srt.replace(/\s+/g, " ").includes("EDITED THROUGH MCP"));
  const editedClips = snapshot(current.clips);
  await call("cutline_undo", revision(current));
  current = await inspect();
  assert.equal(current.clips.find((clip) => clip.id === captions[0].id).text, "FULL AGENT CONTROL");
  await call("cutline_redo", revision(current));
  current = await inspect();
  assert.deepEqual(current.clips, editedClips);
  const extraCaption = await call("cutline_caption_srt", { ...revision(current),
    srt: "1\n00:00:02,000 --> 00:00:02,300\nDedicated SRT tool\n" });
  assert.equal(extraCaption.captionIds.length, 1);
  assert.equal((await inspect()).clips.filter((clip) => clip.kind === "caption").length, 2);
  await call("cutline_undo", revision(await inspect()));
  current = await inspect();
  assert.deepEqual(current.clips, editedClips);
  log("Caption import/correction/style/SRT export and guarded undo/redo work over real MCP");

  const imported = await call("cutline_import_media", { ...revision(current), paths: [privateSource] });
  noPrivateSource(imported);
  current = await inspect();
  assert.equal(current.assets.length, 2);
  const savedFile = path.join(work, "Agent edited project.cutline");
  await call("cutline_save_project", { ...revision(current), path: savedFile });
  const saved = JSON.parse(await readFile(savedFile, "utf8")).project;
  assert.deepEqual(saved.clips, current.clips);
  assert.deepEqual(saved.motions, current.motions);
  await call("cutline_new_project", { ...revision(await inspect()), name: "Disposable new project" });
  current = await inspect();
  assert.equal(current.clips.length, 0);
  assert.equal(current.name, "Disposable new project");
  await call("cutline_open_project", { ...revision(current), path: savedFile });
  current = await inspect();
  assert.deepEqual(current.clips, saved.clips);
  assert.deepEqual(current.motions, saved.motions);
  noPrivateSource(current);
  log("Agent-controlled media import, save, new project and reopen preserve editable project data");

  const preview = await client.callTool({ name: "cutline_preview", arguments: {
    ...revision(current), frame: 20, clipId: lineClip.id, playing: false, image: true,
  } });
  assert(
    !preview.isError,
    `Agent preview should succeed: ${preview.content?.map((item) => item.text ?? "").join(" ")}`,
  );
  const previewText = preview.content.find((item) => item.type === "text");
  assert(previewText, "Preview includes editor state");
  const previewState = JSON.parse(previewText.text);
  assert.equal(previewState.frame, 20);
  assert.equal(previewState.playing, false);
  assert.equal(previewState.selectedClipId, lineClip.id);
  // Rendered by the export renderer, not captured from the editor view.
  assert.equal(previewState.renderer, "export");
  assert.equal(previewState.layout, "single");
  noPrivateSource(previewState);
  const previewImage = preview.content.find((item) => item.type === "image");
  assert(previewImage?.data.length > 100, "Agent preview must return rendered image pixels");
  await writeFile(path.join(work, "agent-preview.jpg"), Buffer.from(previewImage.data, "base64"));
  await page.screenshot({ path: path.join(work, "agent-controlled-editor.png") });
  const sheet = await client.callTool({ name: "cutline_preview", arguments: { frames: [0, 10, 20, 40] } });
  assert(!sheet.isError, "Contact sheet preview should succeed");
  const sheetState = JSON.parse(sheet.content.find((item) => item.type === "text").text);
  assert.equal(sheetState.layout, "sheet");
  assert.deepEqual(sheetState.frames.map((item) => item.frame), [0, 10, 20, 40]);
  const sheetImages = sheet.content.filter((item) => item.type === "image");
  assert.equal(sheetImages.length, 1);
  await writeFile(path.join(work, "agent-contact-sheet.jpg"), Buffer.from(sheetImages[0].data, "base64"));
  log("MCP preview seeks/selects the clip and returns real rendered image content; several frames come as one contact sheet");

  const connection = JSON.parse(await readFile(connectionFile, "utf8"));
  assert.equal(new URL(connection.mcpUrl).hostname, "127.0.0.1");
  httpClient = new Client({ name: "cutline-agent-http-qa", version: "1.0" });
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(connection.mcpUrl)));
  const httpTools = await httpClient.listTools();
  assert.equal(httpTools.tools.length, toolList.tools.length);
  const httpInspect = await httpClient.callTool({ name: "cutline_inspect", arguments: {} });
  const httpProject = JSON.parse(httpInspect.content[0].text);
  assert.equal(httpProject.id, current.id);
  noPrivateSource(httpProject);
  const deniedUrl = new URL(connection.mcpUrl);
  deniedUrl.pathname = "/mcp";
  const denied = await fetch(deniedUrl, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  assert.equal(denied.status, 403, "Requests without the local capability must be denied");
  const deniedOrigin = await fetch(connection.mcpUrl, { method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://untrusted.invalid" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  assert.equal(deniedOrigin.status, 403, "Remote browser origins must not reach the local MCP endpoint");
  log("The same authenticated tool surface works through SDK Streamable HTTP; missing capability is rejected");

  const out = path.join(work, "Agent controlled export.mp4");
  const exportStarted = await call("cutline_export", { ...revision(current), path: out });
  const exported = await waitJob(exportStarted.id);
  const metadata = JSON.parse(media(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", out]).toString());
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assertCfrExport(ffprobe, out, { fps: 30, frames: Math.max(...current.clips.map((clip) => clip.start + clip.duration)) });
  const expectedDuration = Math.max(...current.clips.map((clip) => clip.start + clip.duration)) / current.fps;
  assert(Math.abs(Number(metadata.format.duration) - expectedDuration) < 0.1);
  await writeFile(path.join(work, "export-metadata.json"), JSON.stringify(metadata, null, 2));
  for (const frame of [0, 20, 55]) media(ffmpeg, ["-v", "error", "-y", "-i", out,
    "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", path.join(work, `agent-export-frame-${frame}.png`)]);
  log("Agent-controlled MP4 export completes through the public export/job tools", {
    seconds: exported.seconds, width: video.width, height: video.height, duration: Number(metadata.format.duration),
  });
  const cancellable = await call("cutline_export", { ...revision(await inspect()),
    path: path.join(work, "Cancelled agent export.mp4") });
  const cancelled = await call("cutline_cancel_job", { id: cancellable.id });
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await call("cutline_jobs")).find((job) => job.id === cancellable.id).state, "cancelled");
  log("An external agent can cancel a running render job");

  if (process.env.CUTLINE_TEST_CODEX === "1") {
    // Only retain tool/event types. Never log account identity, auth data or the
    // full connect response from the user's locally signed-in Codex instance.
    const connected = await invoke("codex.connect");
    if (!connected?.account) {
      log("Built-in Codex model smoke is unverified because no signed-in account is available");
    } else {
      const modelEvents = [];
      await page.exposeFunction("recordAgentQAModelEvent", (event) => {
        modelEvents.push({ type: event.type, name: event.name, status: event.status });
      });
      await page.evaluate(() => window.cutline.on("assistant", window.recordAgentQAModelEvent));
      const baseline = await inspect();
      await page.getByRole("button", { name: "Assistant", exact: true }).click();
      await invoke("codex.send", { text:
        'Use only Cutline tools for this isolated connection check. Inspect the project and read cutline_editing_schema. In exactly one cutline_edit transaction add one new text clip at frame 0, duration 30 frames, text exactly "Agent connected", preset "none". Preserve all existing clips, assets, captions and motions. Read back the project after the edit. Call cutline_preview on the new clip with frame=15, playing=false and image=true to inspect its rendered image. Do not export or make any other change. Reply briefly.',
      });
      const modelStarted = Date.now();
      while (!modelEvents.some((event) => event.type === "completed" || event.type === "error")) {
        if (Date.now() - modelStarted > 180000) {
          await invoke("codex.stop").catch(() => {});
          throw Error("Signed-in Codex model smoke did not complete within three minutes");
        }
        await page.waitForTimeout(500);
      }
      assert(!modelEvents.some((event) => event.type === "error"), "Signed-in Codex model smoke encountered a connection error");
      const modelProject = await inspect();
      const previousIds = new Set(baseline.clips.map((clip) => clip.id));
      assert.deepEqual(modelProject.clips.filter((clip) => previousIds.has(clip.id)), baseline.clips,
        "Built-in assistant must preserve existing clips");
      assert.deepEqual(modelProject.assets, baseline.assets, "Built-in assistant must preserve imported assets");
      assert.deepEqual(modelProject.motions, baseline.motions, "Built-in assistant must preserve existing motions");
      const added = modelProject.clips.filter((clip) => !previousIds.has(clip.id));
      assert.equal(added.length, 1);
      assert.equal(added[0].kind, "text");
      assert.equal(added[0].text, "Agent connected");
      assert.equal(added[0].start, 0);
      assert.equal(added[0].duration, 30);
      assert(modelEvents.some((event) => event.type === "tool" && event.name === "cutline_edit"));
      assert(modelEvents.some((event) => event.type === "tool" && event.name === "cutline_preview"));
      await page.screenshot({ path: path.join(work, "builtin-agent-proof.png") });
      await call("cutline_undo", revision(modelProject));
      assert.deepEqual((await inspect()).clips, baseline.clips,
        "The model's edit must undo in one step");
      log("A signed-in built-in Codex model performs and visually reviews a real editable clip addition; one undo restores the baseline", {
        seconds: (Date.now() - modelStarted) / 1000,
        tools: modelEvents.filter((event) => event.type === "tool").map((event) => event.name),
      });
    }
  } else {
    log("Built-in model smoke was not requested for this deterministic MCP run");
  }

  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(consoleErrors, []);
  log("No renderer exceptions or console errors during agent control QA");
} catch (error) {
  failure = error.stack ?? String(error);
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(work, "failure.png") }).catch(() => {});
} finally {
  await writeFile(path.join(work, "results.json"), JSON.stringify({
    passed: !failure, work, packaged, results, calls, rendererErrors, consoleErrors,
    ...(failure ? { failure } : {}),
  }, null, 2));
  await client?.close();
  await httpClient?.close();
  if (app) await app.close();
  console.log(`Agent control QA artifacts: ${work}`);
}
if (failure) throw Error(failure);
