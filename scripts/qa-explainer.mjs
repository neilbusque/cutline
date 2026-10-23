import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Real local Kokoro + Whisper + MP4 export in a disposable profile. No user
// project, saved provider key, paid request, or model download is used.
// Build first, then: one-at-a-time node scripts/qa-explainer.mjs
// Native Cutline QA fixture only. No paid provider, network, or customer media.
const root = process.cwd();
const packaged =
  process.env.CUTLINE_PACKAGED === "1" || process.env.CUTLINE_INSTALLED === "1";
const parent = path.resolve(
  process.env.CUTLINE_EXPLAINER_RESULTS ?? path.join(root, "../qa-explainer"),
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "user-data");
const projectFile = path.join(work, "explainer.cutline");
const output = path.join(work, "explainer.mp4");
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const run = (bin, args) =>
  execFileSync(bin, args, {
    encoding: "buffer",
    timeout: 120000,
    maxBuffer: 30000000,
  });
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: data,
  CUTLINE_SESSION_ROOT: data,
  CUTLINE_PROJECTS_DIR: path.join(work, "projects"),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CUTLINE_SESSION_ID;
const report = {
  work,
  runtime: null,
  checks: [],
  screenshots: [],
  voices: [],
  styles: [],
  previews: [],
  pageErrors: [],
  consoleErrors: [],
  network: [],
  export: null,
  failed: null,
};
let app, page, mcp, marker;
let closing;
const closeOwnedApp = () =>
  (closing ??= (async () => {
    if (mcp) await mcp.close().catch(() => {});
    if (!app) return;
    const child = app.process();
    let timer;
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("QA app close timed out")),
            15000,
          );
        }),
      ]);
    } catch {
      // Only this runner's disposable process is eligible for the fallback.
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
    void closeOwnedApp().finally(() =>
      process.exit(signal === "SIGINT" ? 130 : 143),
    );
  });
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
const tx = async (commands) => {
  const project = await current();
  return invoke("edit", {
    projectId: project.id,
    revision: project.revision,
    label: "Story QA edit",
    commands,
  });
};
const panel = () => page.locator(".story-library");
const waitProject = async (predicate, message, timeout = 180000) => {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeout) {
    latest = await current();
    if (predicate(latest)) return latest;
    await page.waitForTimeout(150);
  }
  const state = await invoke("state");
  throw Error(
    `${message}: ${JSON.stringify({ project: latest, jobs: state.jobs })}`,
  );
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const guard = (project) => ({
  projectId: project.id,
  revision: project.revision,
});
const script =
  "Start with one clear idea. Make it easy to follow.\n\nAdd your own screen. Then share the finished edit.";
const input = {
  style: "kinetic",
  topic: "Make your next cut",
  script,
  audience: "Creators explaining an idea",
  cta: "Keep creating with Cutline",
};
const styles = ["kinetic", "screen", "diagram", "editorial"];
const stage = (name) =>
  panel()
    .getByRole("navigation", { name: "Story workflow" })
    .getByRole("button", { name: new RegExp(name) })
    .click();
const call = async (name, args = {}, expectError = false) => {
  const reply = await mcp.callTool({ name, arguments: args }, undefined, {
    timeout: 240000,
  });
  const body = reply.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (expectError) {
    assert(reply.isError, name + " must reject");
    return body;
  }
  assert(!reply.isError, name + ": " + body);
  const value = JSON.parse(body);
  if (value?.jobId) {
    const until = Date.now() + 300000;
    while (Date.now() < until) {
      const jobs = await call("cutline_jobs", {
        id: value.jobId,
        waitSeconds: 10,
      });
      const job = jobs.find((item) => item.id === value.jobId);
      if (job?.state === "done") {
        assert(job.result, "Completed agent task has a result");
        return job.result;
      }
      if (["error", "cancelled"].includes(job?.state)) throw Error(job.message);
    }
    throw Error(name + " timed out");
  }
  return value;
};
const resize = async (width, height) => {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(390, 600);
      win.setContentSize(size.width, size.height);
      if (size.width >= 1100) win.setMinimumSize(1100, 760);
    },
    { width, height },
  );
  await page.setViewportSize({ width, height });
};
const capture = async (name, anchor = ".story-explainer") => {
  await resize(1440, 960);
  await panel().locator(anchor).scrollIntoViewIfNeeded();
  const desktop = path.join(work, name + "-1440.png");
  await page.screenshot({ path: desktop, animations: "disabled" });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Desktop has no horizontal overflow",
  );
  await resize(390, 844);
  const isolated = await page.addStyleTag({
    content:
      "body{min-width:0!important}body *{visibility:hidden}.story-library,.story-library *{visibility:visible}.story-library{position:fixed!important;inset:0!important;width:390px!important;height:844px!important;box-sizing:border-box!important;z-index:99999;background:#141417}",
  });
  try {
    await panel().locator(anchor).scrollIntoViewIfNeeded();
    const layout = await panel().evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    assert(
      layout.scroll <= layout.width + 1,
      name + " panel overflows: " + JSON.stringify(layout),
    );
    const narrow = path.join(work, name + "-390.png");
    await page.screenshot({ path: narrow, animations: "disabled" });
    report.screenshots.push({
      name,
      desktop,
      narrow,
      layout,
      note: "Actual Story panel isolated at 390px. Full desktop editor retains its 1100px minimum.",
    });
  } finally {
    await isolated.evaluate((element) => element.remove());
    await resize(1440, 960);
  }
};
const saveDraft = async () => {
  const revision = (await current()).revision;
  await panel()
    .getByRole("button", { name: "Save storyline", exact: true })
    .click();
  return waitProject(
    (project) => project.revision > revision,
    "Story draft did not save",
  );
};
const createOutline = async (style) => {
  await stage("Story");
  const summary = panel().locator(".story-explainer > summary");
  if (!(await summary.evaluate((element) => element.parentElement.open)))
    await summary.click();
  const radio = panel().locator(
    "input[name=explainer-style][value=" + style + "]",
  );
  await radio.press("Space");
  await expect(radio).toBeChecked();
  await panel()
    .getByRole("button", { name: "Create outline", exact: true })
    .click();
  const confirm = panel().getByRole("button", {
    name: "Replace outline",
    exact: true,
  });
  if (await confirm.isVisible()) await confirm.click();
  await expect(
    panel().getByRole("region", { name: "Create your explainer", exact: true }),
  ).toBeVisible();
};
const produceUI = async () => {
  const before = (await current()).story?.assembly?.clipIds ?? [];
  await panel()
    .getByRole("button", { name: "Create explainer", exact: true })
    .click();
  const project = await waitProject(
    (project) =>
      project.story?.assembly?.clipIds.length &&
      project.story.assembly.clipIds.every((id) => !before.includes(id)),
    "One-click explainer did not assemble",
    300000,
  );
  await expect(
    panel().getByText("Your video is on the timeline", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  return project;
};
const preserveMarker = (project) =>
  assert.deepEqual(
    clone(project.clips.find((clip) => clip.id === marker.id)),
    clone(marker),
    "Unrelated edited clip remains intact",
  );
const validateStory = (project, style, voiceIds) => {
  preserveMarker(project);
  assert.equal(project.story.explainer.style, style);
  assert.equal(
    project.story.scenes.map((scene) => scene.narration).join("\n\n"),
    script,
  );
  assert.equal(project.story.assembly.startFrame, marker.duration);
  assert.equal(project.story.scenes.length, 2);
  const ids = project.story.scenes.map((scene) => scene.voiceAssetId);
  if (voiceIds)
    assert.deepEqual(
      ids,
      voiceIds,
      "Unchanged narration is reused across styles and rebuilds",
    );
  const owned = new Set(project.story.assembly.clipIds);
  const clips = project.clips.filter((clip) => owned.has(clip.id));
  assert.equal(clips.filter((clip) => clip.kind === "audio").length, 2);
  assert.equal(project.story.assembly.motionIds.length, 2);
  assert(
    project.motions
      .filter((motion) => project.story.assembly.motionIds.includes(motion.id))
      .every((motion) => motion.layers.length > 1),
    "Native designs have editable layers",
  );
  const captions = clips.filter((clip) => clip.kind === "caption");
  assert(
    captions.length >= 2 && captions.every((clip) => clip.words?.length > 0),
  );
  for (const caption of captions) {
    assert(
      clips.some(
        (clip) => clip.id === caption.captionSourceId && clip.kind === "audio",
      ),
    );
    assert(
      caption.x >= 0 &&
        caption.y >= 0 &&
        caption.x + caption.width <= project.width + 1 &&
        caption.y + caption.height <= project.height + 1,
      "Caption bounds stay in canvas",
    );
  }
  return ids;
};
const saveReopen = async (name) => {
  await invoke("save");
  const saved = JSON.parse(await readFile(projectFile, "utf8")).project;
  await writeFile(
    path.join(work, name + ".cutline"),
    JSON.stringify({
      project: saved,
      past: [],
      future: [],
      filePath: projectFile,
    }),
  );
  await invoke("test.load", { path: projectFile });
  const reopened = await current();
  assert.deepEqual(clone(reopened.story), saved.story);
  assert.deepEqual(clone(reopened.clips), saved.clips);
  assert.deepEqual(clone(reopened.motions), saved.motions);
  return reopened;
};
const renderSamples = async (project, style, orientation) => {
  const voices = project.clips
    .filter(
      (clip) =>
        project.story.assembly.clipIds.includes(clip.id) &&
        clip.kind === "audio",
    )
    .sort((a, b) => a.start - b.start);
  const frames = [
    ...new Set(
      voices.flatMap((clip) => [
        clip.start + 5,
        clip.start + Math.min(Math.floor(clip.duration / 2), 45),
        clip.start + clip.duration - 2,
      ]),
    ),
  ];
  const reply = await mcp.callTool(
    {
      name: "cutline_preview",
      arguments: {
        ...guard(project),
        frames,
        image: true,
        width: 480,
        layout: "sheet",
      },
    },
    undefined,
    { timeout: 240000 },
  );
  assert(
    !reply.isError,
    JSON.stringify(reply.content.filter((item) => item.type === "text")),
  );
  const pictures = reply.content.filter((item) => item.type === "image");
  assert(pictures.length > 0, "Native composition returned rendered images");
  const files = [];
  for (const [index, picture] of pictures.entries()) {
    const file = path.join(
      work,
      style +
        "-" +
        orientation +
        "-" +
        (index + 1) +
        "." +
        (picture.mimeType === "image/png" ? "png" : "jpg"),
    );
    await writeFile(file, Buffer.from(picture.data, "base64"));
    files.push(file);
  }
  report.previews.push({
    style,
    orientation,
    frames,
    files,
    width: project.width,
    height: project.height,
  });
  await writeFile(
    path.join(work, style + "-" + orientation + "-preview.json"),
    JSON.stringify(
      reply.content.filter((item) => item.type === "text"),
      null,
      2,
    ),
  );
};
const samples = (file) => {
  const bytes = run(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vn",
    "-ar",
    "8000",
    "-ac",
    "1",
    "-f",
    "s16le",
    "-",
  ]);
  return Float64Array.from(
    { length: Math.floor(bytes.length / 2) },
    (_, index) => bytes.readInt16LE(index * 2) / 32768,
  );
};
const rms = (values) =>
  Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0) / values.length,
  );
const correlation = (source, rendered, offset) => {
  let best = -1,
    bestLag = 0;
  for (let lag = -80; lag <= 80; lag++) {
    let aa = 0,
      bb = 0,
      ab = 0;
    for (let index = 160; index < source.length - 160; index += 2) {
      const a = source[index],
        b = rendered[offset + index + lag];
      if (b === undefined) continue;
      aa += a * a;
      bb += b * b;
      ab += a * b;
    }
    const score = ab / Math.sqrt(aa * bb);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  return { correlation: best, lagSeconds: bestLag / 8000 };
};
const exportComplete = async (project) => {
  const started = Date.now(),
    job = await invoke("test.export", { path: output });
  let done;
  while (Date.now() - started < 600000) {
    done = (await invoke("state")).jobs.find((item) => item.id === job.id);
    if (["error", "cancelled"].includes(done?.state)) throw Error(done.message);
    if (done?.state === "done") break;
    await page.waitForTimeout(300);
  }
  assert.equal(done?.state, "done", "Complete explainer export finishes");
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
  assert.equal(audio.codec_name, "aac");
  assert.equal(video.width, project.width);
  assert.equal(video.height, project.height);
  const timing = assertCfrExport(ffprobe, output, {
    fps: project.fps,
    frames: Math.max(
      ...project.clips.map((clip) => clip.start + clip.duration),
    ),
  });
  run(ffmpeg, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
  const decoded = samples(output),
    volume = rms(decoded);
  assert(volume > 0.005, "Exported narration is audible");
  const alignment = project.clips
    .filter(
      (clip) =>
        clip.kind === "audio" &&
        project.story.assembly.clipIds.includes(clip.id),
    )
    .map((clip) => {
      const source = project.assets.find((asset) => asset.id === clip.assetId);
      const compared = correlation(
        samples(source.path),
        decoded,
        Math.round((clip.start / project.fps) * 8000),
      );
      assert(
        compared.correlation > 0.95,
        "Export retains source narration timing: " + JSON.stringify(compared),
      );
      return { clipId: clip.id, ...compared };
    });
  const contact = path.join(work, "export-contact.png");
  run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-i",
    output,
    "-vf",
    "fps=1,scale=240:-1,tile=6x2",
    "-frames:v",
    "1",
    contact,
  ]);
  report.export = {
    output,
    contact,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    width: video.width,
    height: video.height,
    timing,
    rms: volume,
    alignment,
    fullDecode: true,
    seconds: (Date.now() - started) / 1000,
  };
  check(
    "Complete narrated explainer exports and fully decodes with measured source-audio alignment",
    report.export,
  );
};

try {
  const model = await build({
    entryPoints: [path.join(root, "src/shared/model.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, makeClip } = await import(
    "data:text/javascript;base64," +
      Buffer.from(model.outputFiles[0].text).toString("base64")
  );
  const initial = newProject();
  initial.name = "Cutline explainer QA";
  initial.width = 1280;
  initial.height = 720;
  marker = {
    ...makeClip(
      initial,
      "text",
      initial.tracks.find((track) => track.kind === "text").id,
      0,
    ),
    id: "unrelated-explainer-title",
    text: "Original Cutline sample",
    duration: 15,
    x: 80,
    y: 200,
    width: 1000,
    height: 160,
  };
  initial.clips = [marker];
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
      process.env.CUTLINE_APP_EXECUTABLE ??
      (process.env.CUTLINE_INSTALLED === "1"
        ? "/Applications/Cutline.app/Contents/MacOS/Cutline"
        : path.join(
            root,
            packaged
              ? "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline"
              : "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
          )),
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
    globalThis.__explainerQaNetwork = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
        globalThis.__explainerQaNetwork.push({
          origin: url.origin,
          pathname: url.pathname,
          method: options?.method ?? "GET",
        });
        throw Error("External network blocked during explainer QA");
      }
      return original(input, options);
    };
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname))
      return route.continue();
    report.network.push({
      origin: url.origin,
      pathname: url.pathname,
      renderer: true,
    });
    await route.abort();
  });
  await page.waitForSelector(".titlebar", { timeout: 120000 });
  const state = await invoke("state");
  assert.equal(state.snapshot.project.id, initial.id);
  assert.equal(state.snapshot.project.name, initial.name);
  assert.equal(state.snapshot.filePath, projectFile);
  assert.equal(state.snapshot.canUndo, false);
  const startupSessions = await invoke("sessions.list");
  assert.equal(startupSessions.currentId, "main");
  assert.equal(startupSessions.sessions.length, 1);
  const startupSession = startupSessions.sessions.find(
    (session) => session.id === startupSessions.currentId,
  );
  assert(startupSession?.current, "CLI-open project has a current session");
  assert.equal(
    startupSession.projectId,
    initial.id,
    "Session discovery must describe the CLI-open project before any edit",
  );
  assert.equal(startupSession.projectName, initial.name);
  assert.equal(
    state.settings.transcriptionReady,
    true,
    "Whisper is already installed",
  );
  assert.equal(
    (await invoke("tts.status")).ready,
    true,
    "Kokoro is already installed",
  );
  mcp = new Client({ name: "Cutline Explainer QA", version: "1.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(state.settings.mcpUrl)),
  );
  const discovered = await call("cutline_sessions", { action: "list" });
  const currentSession = discovered.sessions.find((session) => session.current);
  assert.equal(currentSession?.id, startupSessions.currentId);
  assert.equal(currentSession.projectId, initial.id);
  assert.equal(currentSession.projectName, initial.name);
  check(
    "CLI-open project identity matches current session in the editor and external MCP before any edit",
    {
      sessionId: currentSession.id,
      projectId: currentSession.projectId,
      projectName: currentSession.projectName,
    },
  );
  const advertised = (await mcp.listTools()).tools;
  for (const name of [
    "cutline_explainer",
    "cutline_story_produce",
    "cutline_story",
    "cutline_preview",
  ])
    assert(
      advertised.some((tool) => tool.name === name),
      name + " is discoverable",
    );
  const schema = JSON.stringify(
    await call("cutline_editing_schema", { section: "explainer" }),
  );
  for (const style of styles) assert(schema.includes(style));
  const beforeInvalid = await current();
  await call(
    "cutline_explainer",
    { ...guard(beforeInvalid), input: { ...input, script: " " } },
    true,
  );
  assert.deepEqual(
    await current(),
    beforeInvalid,
    "Invalid MCP input leaves project untouched",
  );
  check(
    "MCP advertises explainer input/styles and local production; invalid input is atomic",
  );

  await resize(1440, 960);
  const fixture = path.join(work, "Cutline-native-screen-fixture.png");
  await page.screenshot({ path: fixture });
  const visual = await invoke("test.import", { path: fixture });
  report.screenFixture = {
    path: fixture,
    assetId: visual.id,
    note: "Actual isolated Cutline editor screenshot with authored QA sample only.",
  };
  await page
    .locator(".library-tabs button")
    .filter({ hasText: /^Story$/ })
    .click();
  await panel().waitFor({ state: "visible" });
  await expect(
    panel().getByRole("button", { name: "Create outline", exact: true }),
  ).toBeDisabled();
  await panel()
    .getByLabel("Explainer topic", { exact: true })
    .pressSequentially(input.topic, { delay: 12 });
  await expect(
    panel().getByLabel("Explainer topic", { exact: true }),
  ).toHaveValue(input.topic);
  await panel()
    .getByLabel("Explainer script", { exact: true })
    .pressSequentially(script, { delay: 3 });
  await expect(
    panel().getByLabel("Explainer script", { exact: true }),
  ).toHaveValue(script);
  await panel().locator(".explainer-context > summary").click();
  await panel()
    .getByLabel("Explainer audience", { exact: true })
    .pressSequentially(input.audience, { delay: 10 });
  await panel()
    .getByLabel("Explainer closing action", { exact: true })
    .pressSequentially(input.cta, { delay: 10 });
  await expect(
    panel().getByLabel("Explainer audience", { exact: true }),
  ).toHaveValue(input.audience);
  await expect(
    panel().getByLabel("Explainer closing action", { exact: true }),
  ).toHaveValue(input.cta);
  await panel().locator(".explainer-context > summary").click();
  await capture("explainer-inputs");
  await createOutline("kinetic");
  const narrationField = () =>
    panel().getByLabel("Scene narration", { exact: true });
  const explainerField = () =>
    panel().getByLabel("Explainer script", { exact: true });
  const revisedNarration =
    "The newest scene edit must survive every visual style change.";
  await narrationField().fill("");
  await narrationField().pressSequentially(revisedNarration, { delay: 8 });
  await expect(narrationField()).toHaveValue(revisedNarration);
  await expect(explainerField()).toHaveValue(
    revisedNarration + "\n\n" + script.split("\n\n")[1],
  );
  await stage("Produce");
  await createOutline("diagram");
  await expect(narrationField()).toHaveValue(revisedNarration);
  await saveDraft();

  const intentionalScript =
    "This is an intentional explainer form revision.\n\nKeep these exact closing words.";
  await explainerField().fill(intentionalScript);
  await narrationField().fill(
    "A later scene edit must not overwrite my explicit form text.",
  );
  await expect(explainerField()).toHaveValue(intentionalScript);
  await createOutline("editorial");
  await expect(narrationField()).toHaveValue(
    intentionalScript.split("\n\n")[0],
  );
  const savedDraft = await saveDraft();
  const updatedSavedStory = clone(savedDraft.story);
  updatedSavedStory.scenes[0].narration =
    "A saved assistant edit also survives a style-only change.";
  await invoke("story.save", {
    ...guard(savedDraft),
    story: updatedSavedStory,
  });
  await expect(explainerField()).toHaveValue(
    updatedSavedStory.scenes.map((scene) => scene.narration).join("\n\n"),
  );
  await createOutline("kinetic");
  await expect(narrationField()).toHaveValue(
    updatedSavedStory.scenes[0].narration,
  );
  await saveDraft();
  await invoke("save");

  const pendingFirst = "Project one keeps its deliberately pending form text.";
  const pendingSecond = "Project two has a different pending script.";
  await explainerField().fill(pendingFirst);
  const alternate = newProject();
  alternate.name = "Separate explainer form QA";
  const alternateFile = path.join(work, "separate-form.cutline");
  await writeFile(
    alternateFile,
    JSON.stringify({
      project: alternate,
      past: [],
      future: [],
      filePath: alternateFile,
    }),
  );
  await invoke("test.load", { path: alternateFile });
  await expect(explainerField()).toHaveValue("");
  await explainerField().fill(pendingSecond);
  await invoke("test.load", { path: projectFile });
  await expect(explainerField()).toHaveValue(pendingFirst);
  await invoke("test.load", { path: alternateFile });
  await expect(explainerField()).toHaveValue(pendingSecond);
  await invoke("test.load", { path: projectFile });
  await expect(explainerField()).toHaveValue(pendingFirst);
  await explainerField().fill(script);
  await createOutline("kinetic");
  await expect(narrationField()).toHaveValue(script.split("\n\n")[0]);
  check(
    "Scene and assistant edits survive style changes; intentional form edits and per-project drafts stay intact",
  );
  await expect(
    panel().getByLabel("Add timed captions", { exact: true }),
  ).toBeChecked();
  await panel()
    .getByRole("button", { name: "Create explainer", exact: true })
    .click();
  const cancellation = panel().getByRole("button", {
    name: "Cancel explainer",
    exact: true,
  });
  await expect(cancellation).toBeVisible({ timeout: 20000 });
  await cancellation.click();
  const cancelStart = Date.now();
  let cancelled;
  while (Date.now() - cancelStart < 60000) {
    const jobs = (await invoke("state")).jobs;
    cancelled =
      jobs.some(
        (job) => job.kind === "story-produce" && job.state === "cancelled",
      ) && !jobs.some((job) => job.state === "running");
    if (cancelled) break;
    await page.waitForTimeout(150);
  }
  assert(cancelled, "Cancellation stops the batch and its child jobs");
  await expect(
    panel().getByRole("button", { name: "Create explainer", exact: true }),
  ).toBeEnabled({ timeout: 10000 });
  await expect(
    panel().getByText(
      "Explainer cancelled. Finished narration is kept for your next attempt.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Couldn’t complete that action", { exact: true }),
  ).toHaveCount(0);
  let project = await current();
  assert.equal(project.story.assembly, undefined);
  preserveMarker(project);
  check(
    "Stable multi-character inputs, required fields and real cancellation preserve the existing timeline",
  );
  project = await produceUI();
  const voiceIds = validateStory(project, "kinetic");
  for (const id of voiceIds) {
    const voice = project.assets.find((asset) => asset.id === id);
    assert(voice.duration > 1 && voice.hasAudio && voice.words.length >= 4);
    assert(
      voice.words.every(
        (word) =>
          word.start >= 0 &&
          word.end > word.start &&
          word.end <= voice.duration + 1 / project.fps,
      ),
    );
    const volume = rms(samples(voice.path));
    assert(volume > 0.005);
    report.voices.push({
      id,
      duration: voice.duration,
      words: voice.words,
      rms: volume,
    });
  }
  await capture("explainer-created", ".story-batch");
  await tx([
    {
      type: "clip.update",
      id: marker.id,
      patch: { text: "Keep my edited original" },
    },
  ]);
  marker = clone((await current()).clips.find((clip) => clip.id === marker.id));
  check(
    "One click creates real Kokoro narration, measured Whisper captions and native editable scenes",
  );

  for (const style of styles) {
    if (style !== "kinetic") {
      await createOutline(style);
      if (style === "screen") {
        await expect(
          panel().getByRole("button", {
            name: "Create explainer",
            exact: true,
          }),
        ).toBeDisabled();
        project = await saveDraft();
        const before = clone(project);
        await assert.rejects(
          invoke("story.produce", guard(project)),
          /choose a real screenshot or video/i,
        );
        assert.deepEqual(
          clone(await current()),
          before,
          "Missing screen rejection leaves voices and timeline intact",
        );
        await stage("Produce");
        for (const scene of project.story.scenes) {
          await panel()
            .getByLabel("Scene to produce", { exact: true })
            .selectOption(scene.id);
          await panel()
            .getByLabel("Scene visual asset", { exact: true })
            .selectOption(visual.id);
          project = await saveDraft();
        }
        await capture("explainer-screen-assignment", ".story-batch");
      }
      project = await produceUI();
    } else project = await current();
    validateStory(project, style, voiceIds);
    project = await saveReopen(style + "-landscape");
    await renderSamples(project, style, "landscape");
    await tx([{ type: "project.update", patch: { width: 720, height: 1280 } }]);
    const portraitReply = await call(
      "cutline_story_produce",
      guard(await current()),
    );
    assert.equal(portraitReply.voicesCreated, 0);
    assert.equal(portraitReply.voicesReused, 2);
    project = await current();
    validateStory(project, style, voiceIds);
    project = await saveReopen(style + "-portrait");
    await renderSamples(project, style, "portrait");
    if (style === "editorial") await exportComplete(project);
    const prior = [...project.story.assembly.clipIds];
    await tx([{ type: "project.update", patch: { width: 1280, height: 720 } }]);
    const rebuilt = await call("cutline_story_produce", guard(await current()));
    assert.equal(rebuilt.voicesCreated, 0);
    assert.equal(rebuilt.voicesReused, 2);
    project = await current();
    validateStory(project, style, voiceIds);
    assert(
      prior.every((id) => !project.clips.some((clip) => clip.id === id)),
      "Rebuild removes former owned clips",
    );
    assert.equal(
      project.assets.filter((asset) => voiceIds.includes(asset.id)).length,
      2,
    );
    report.styles.push({
      style,
      sceneLayouts: project.story.scenes.map((scene) => scene.design.layout),
      voicesCreated: rebuilt.voicesCreated,
      voicesReused: rebuilt.voicesReused,
      saveReopen: true,
      orientations: ["landscape", "portrait"],
    });
    check(
      style +
        ": native scenes render in landscape and portrait, reopen intact and reuse both voices",
    );
  }
  const beforeMcpPlan = await current();
  await call("cutline_explainer", {
    ...guard(beforeMcpPlan),
    input: { ...input, style: "editorial" },
  });
  project = await current();
  assert.deepEqual(
    project.clips,
    beforeMcpPlan.clips,
    "MCP outline planning preserves timeline work",
  );
  validateStory(project, "editorial", voiceIds);
  await stage("Story");
  await capture("explainer-final", ".story-explainer");
  await invoke("save");
  report.network.push(
    ...(await app.evaluate(() => globalThis.__explainerQaNetwork)),
  );
  assert.deepEqual(
    report.network,
    [],
    "No external provider or model-download calls",
  );
  assert.deepEqual(report.pageErrors, [], "No renderer exceptions");
  assert.deepEqual(report.consoleErrors, [], "No browser console errors");
  check(
    "Four styles, native renders, saved project and complete narrated export pass without external providers",
  );
} catch (error) {
  report.failed = error.stack ?? String(error);
  process.exitCode = 1;
  await page
    ?.screenshot({ path: path.join(work, "failure.png") })
    .catch(() => {});
} finally {
  if (app) {
    const external = await app
      .evaluate(() => globalThis.__explainerQaNetwork ?? [])
      .catch(() => []);
    for (const request of external)
      if (
        !report.network.some(
          (item) => JSON.stringify(item) === JSON.stringify(request),
        )
      )
        report.network.push(request);
  }
  await closeOwnedApp();
  await writeFile(
    path.join(work, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
