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
// npm run build && node scripts/qa-story.mjs
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const parent = path.resolve(
  process.env.CUTLINE_STORY_RESULTS ?? path.join(root, "../qa-story"),
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "user-data");
const projectFile = path.join(work, "story.cutline");
const output = path.join(work, "story.mp4");
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
  CUTLINE_PROJECTS_DIR: path.join(work, "projects"),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  work,
  runtime: null,
  checks: [],
  screenshots: [],
  voices: [],
  pageErrors: [],
  consoleErrors: [],
  network: [],
  export: null,
  failed: null,
};
let app, page, mcp;
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
    const error = await panel().evaluate((element) =>
      [...element.querySelectorAll("[role=alert]")]
        .map((item) => item.textContent)
        .filter(Boolean)
        .join(" "),
    );
    if (error?.trim()) throw Error(error.trim());
    await page.waitForTimeout(150);
  }
  const state = await invoke("state");
  throw Error(
    `${message}: ${JSON.stringify({ project: latest, jobs: state.jobs })}`,
  );
};
const screenshot = async (name, width, height) => {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height),
    { width, height },
  );
  await page.setViewportSize({ width, height });
  await panel().evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(180);
  const layout = await page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 1)
      problems.push("document horizontal overflow");
    for (const element of document.querySelectorAll(
      ".story-library, .story-library input, .story-library textarea, .story-library select, .story-library button",
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
  assert.deepEqual(layout.problems, [], `${name} layout ${width}×${height}`);
  const file = path.join(work, `${width}x${height}-${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push({ name, width, height, file, layout });
};
const captureBoth = async (name) => {
  for (const [width, height] of [
    [1440, 960],
    [1100, 760],
  ])
    await screenshot(name, width, height);
};

try {
  const fixture = path.join(work, "synthetic-shot.mp4");
  run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=360x640:rate=30:duration=3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    fixture,
  ]);
  const model = await build({
    entryPoints: [path.join(root, "src/shared/model.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, makeClip } = await import(
    `data:text/javascript;base64,${Buffer.from(model.outputFiles[0].text).toString("base64")}`
  );
  const initial = newProject();
  initial.name = "Cutline Story QA";
  initial.width = 720;
  initial.height = 1280;
  const marker = makeClip(
    initial,
    "text",
    initial.tracks.find((track) => track.kind === "text").id,
    0,
  );
  marker.id = "unrelated-opening-title";
  marker.text = "Keep my opening";
  marker.duration = 15;
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
    globalThis.__cutlineStoryNetwork = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(
        typeof input === "string" ? input : (input.url ?? String(input)),
      );
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        globalThis.__cutlineStoryNetwork.push({
          origin: url.origin,
          pathname: url.pathname,
          method: options?.method ?? "GET",
        });
        throw Error("External network is blocked during local story QA");
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
  assert.equal(
    state.settings.transcriptionReady,
    true,
    "Bundled local Whisper is available",
  );
  assert.equal(
    (await invoke("tts.status")).ready,
    true,
    "Bundled local Kokoro is available",
  );
  mcp = new Client({ name: "Cutline Story QA", version: "1.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(state.settings.mcpUrl)),
  );
  const tools = (await mcp.listTools()).tools;
  for (const name of [
    "cutline_story",
    "cutline_story_voice",
    "cutline_story_assemble",
  ])
    assert(
      tools.some((tool) => tool.name === name),
      `${name} is advertised through real MCP`,
    );
  const schemaReply = await mcp.callTool({
    name: "cutline_editing_schema",
    arguments: { section: "story" },
  });
  assert(!schemaReply.isError);
  const schemaText = schemaReply.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert(
    schemaText.includes("narration") &&
      schemaText.includes("voiceAssetId") &&
      schemaText.includes("scenes"),
  );
  check(
    "The live MCP endpoint advertises story planning, local narration, assembly, and the complete story schema",
  );
  await page
    .locator(".library-tabs button")
    .filter({ hasText: /^Story$/ })
    .click();
  await panel().waitFor({ state: "visible" });
  await panel().locator(".story-brief > summary").click();
  await panel().getByLabel("Story brief").fill("Two moonlit ninja moments");
  await panel()
    .getByRole("button", { name: "Plan with assistant", exact: true })
    .click();
  await expect(page.getByLabel("Ask the editing assistant")).toHaveValue(
    /Two moonlit ninja moments/,
  );
  await expect(page.getByLabel("Ask the editing assistant")).toHaveValue(
    /Do not submit paid generation requests/,
  );
  await page.getByRole("button", { name: "Properties", exact: true }).click();
  check("Plan with assistant prepares an editable prompt without sending it");
  await panel().locator(".story-script-entry > summary").click();
  await panel()
    .getByLabel("Story script")
    .fill(
      "A ninja moves quietly through the forest.\n\nAt the stream, the ninja leaps into the moonlight.",
    );
  await panel()
    .getByRole("button", { name: "Split into scenes", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "Save storyline", exact: true })
    .click();
  let project = await waitProject(
    (project) => project.story?.scenes.length === 2,
    "Two scenes were not created",
  );
  assert.equal(
    project.story.scenes[0].narration,
    "A ninja moves quietly through the forest.",
  );
  assert.equal(
    project.story.scenes[1].narration,
    "At the stream, the ninja leaps into the moonlight.",
  );
  await captureBoth("storyline");
  check("The Story UI splits the written script into two editable scenes");

  const visual = await invoke("test.import", { path: fixture });
  await panel()
    .getByRole("navigation", { name: "Story workflow" })
    .getByRole("button", { name: /Produce/ })
    .click();
  const voiceStart = Date.now();
  const scenes = [...project.story.scenes];
  for (const scene of scenes) {
    await panel().getByLabel("Scene to produce").selectOption(scene.id);
    await panel().getByLabel("Scene visual asset").selectOption(visual.id);
    await panel()
      .getByRole("button", { name: "Save storyline", exact: true })
      .click();
    await waitProject(
      (project) =>
        project.story.scenes.find((item) => item.id === scene.id)?.assetId ===
        visual.id,
      "Visual selection was not saved",
    );
    await panel()
      .getByRole("button", { name: "Create scene voiceover", exact: true })
      .click();
    project = await waitProject(
      (project) => {
        const currentScene = project.story.scenes.find(
          (item) => item.id === scene.id,
        );
        return project.assets.find(
          (asset) => asset.id === currentScene.voiceAssetId,
        )?.words?.length;
      },
      "Local narration and word timing did not finish",
      240000,
    );
  }
  for (const scene of project.story.scenes) {
    const voice = project.assets.find(
      (asset) => asset.id === scene.voiceAssetId,
    );
    assert(voice.duration > 1 && voice.hasAudio);
    assert(voice.words.length >= 4);
    assert(
      voice.words.every(
        (word) =>
          word.start >= 0 &&
          word.end > word.start &&
          word.end <= voice.duration + 0.05,
      ),
    );
    const pcm = run(ffmpeg, [
      "-v",
      "error",
      "-i",
      voice.path,
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
    for (let index = 0; index < pcm.length - 1; index += 2)
      squares += (pcm.readInt16LE(index) / 32768) ** 2;
    const rms = Math.sqrt(squares / Math.floor(pcm.length / 2));
    assert(rms > 0.005, "Narration is audible");
    report.voices.push({
      scene: scene.title,
      duration: voice.duration,
      words: voice.words,
      rms,
    });
  }
  await captureBoth("voice-and-captions");
  check("Both scenes receive real Kokoro narration and Whisper word timing", {
    seconds: (Date.now() - voiceStart) / 1000,
  });

  await invoke("save");
  const saved = JSON.parse(await readFile(projectFile, "utf8")).project;
  assert.deepEqual(saved.story, JSON.parse(JSON.stringify(project.story)));
  await invoke("test.load", { path: projectFile });
  project = await current();
  assert.deepEqual(JSON.parse(JSON.stringify(project.story)), saved.story);
  const storyReply = await mcp.callTool({
    name: "cutline_story",
    arguments: {},
  });
  assert(!storyReply.isError);
  const readStory = JSON.parse(
    storyReply.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  );
  assert.deepEqual(readStory.story, saved.story);
  check(
    "Story scenes, narration links, measured transcripts, and voice settings survive save/reload",
  );

  await panel()
    .getByRole("navigation", { name: "Story workflow" })
    .getByRole("button", { name: /Finish/ })
    .click();
  await panel().getByLabel("Story caption style").selectOption("karaoke");
  await panel()
    .getByRole("button", { name: "Save storyline", exact: true })
    .click();
  await waitProject(
    (project) => project.story.captionStyle === "karaoke",
    "Caption styling was not saved",
  );
  await panel()
    .getByRole("button", { name: "Build video on timeline", exact: true })
    .click();
  project = await waitProject(
    (project) => !!project.story?.assembly?.clipIds.length,
    "Story timeline was not built",
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(project.clips.find((clip) => clip.id === marker.id)),
    ),
    JSON.parse(JSON.stringify(marker)),
  );
  assert.equal(project.story.assembly.startFrame, marker.duration);
  assert.equal(project.clips.filter((clip) => clip.kind === "audio").length, 2);
  const captions = project.clips.filter((clip) => clip.kind === "caption");
  assert(captions.length >= 2, "Measured captions were assembled");
  assert(
    captions.every(
      (clip) =>
        clip.words.length &&
        project.clips.some(
          (source) =>
            source.id === clip.captionSourceId && source.kind === "audio",
        ),
    ),
  );
  const oldIds = [...project.story.assembly.clipIds];
  await tx([
    {
      type: "clip.update",
      id: marker.id,
      patch: { text: "Keep my edited opening" },
    },
  ]);
  await panel()
    .getByRole("button", { name: "Rebuild story sequence", exact: true })
    .click();
  project = await waitProject(
    (project) =>
      project.story.assembly.clipIds.every((id) => !oldIds.includes(id)),
    "Story rebuild was not completed",
  );
  assert.equal(
    project.clips.find((clip) => clip.id === marker.id).text,
    "Keep my edited opening",
  );
  assert.equal(project.clips.filter((clip) => clip.kind === "audio").length, 2);
  assert(oldIds.every((id) => !project.clips.some((clip) => clip.id === id)));
  await captureBoth("assembled-story");
  check(
    "Build and rebuild create an editable visual, narration, and caption timeline while retaining an unrelated edited title",
  );

  await page.getByRole("button", { name: "Go to start", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(1400);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await invoke("save");
  const job = await invoke("test.export", { path: output });
  let finalJob;
  const renderStart = Date.now();
  while (Date.now() - renderStart < 360000) {
    finalJob = (await invoke("state")).jobs.find((item) => item.id === job.id);
    if (finalJob?.state === "done") break;
    if (["error", "cancelled"].includes(finalJob?.state))
      throw Error(finalJob.message);
    await page.waitForTimeout(350);
  }
  assert.equal(finalJob?.state, "done", "MP4 export completed");
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
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 720);
  assert.equal(video.height, 1280);
  assert.equal(audio?.codec_name, "aac");
  const duration =
    Math.max(...project.clips.map((clip) => clip.start + clip.duration)) /
    project.fps;
  assert(Math.abs(Number(probe.format.duration) - duration) < 0.15);
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
  for (let index = 0; index < pcm.length - 1; index += 2)
    squares += (pcm.readInt16LE(index) / 32768) ** 2;
  const rms = Math.sqrt(squares / Math.floor(pcm.length / 2));
  assert(rms > 0.005, "Export contains audible narration");
  report.export = {
    output,
    duration,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    rms,
    fullDecode: true,
    renderSeconds: (Date.now() - renderStart) / 1000,
  };
  run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-i",
    output,
    "-vf",
    "fps=1,scale=180:-1,tile=8x1",
    "-frames:v",
    "1",
    path.join(work, "export-contact.png"),
  ]);
  check(
    "The complete story exports as a fully decodable portrait H.264/AAC video with audible narration",
    report.export,
  );
  report.network = await app.evaluate(() => globalThis.__cutlineStoryNetwork);
  assert.deepEqual(
    report.network,
    [],
    "No external requests or paid generation attempts",
  );
  assert.deepEqual(report.pageErrors, [], "No renderer exceptions");
  assert.deepEqual(report.consoleErrors, [], "No console errors");
  check(
    "All three Story stages fit both requested viewport sizes with no renderer errors or external provider calls",
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
      .evaluate(() => globalThis.__cutlineStoryNetwork ?? [])
      .catch(() => report.network);
    await app.close().catch(() => {});
  }
  await writeFile(
    path.join(work, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
