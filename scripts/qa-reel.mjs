import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

// All fixtures, recovery data, renders, and screenshots stay in a new work folder.
// This script never loads the user's recovery file or source project.
const root = process.cwd();
const parentWork = path.resolve(root, "../../work");
await mkdir(parentWork, { recursive: true });
const work = await mkdtemp(path.join(parentWork, "reel-qa-"));
const ffmpeg =
  process.env.CUTLINE_FFMPEG ||
  path.join(root, "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg");
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const source = path.join(work, "source.mp4");
const cutaway = path.join(work, "cutaway.mp4");
const photo = path.join(work, "photo.png");
const music = path.join(work, "music.wav");
const voice = path.join(work, "voice.aiff");
const output = path.join(work, "cutline-reel-15s.mp4");
const speech =
  "This is Cutline. Turn your footage into a complete story. Start with a strong hook. Add captions that follow your voice. Bring in photos and video cutaways. Finish with color and motion. Your next reel starts here.";
const transcribe = process.env.CUTLINE_QA_TRANSCRIBE === "1";
const run = (bin, args) =>
  execFileSync(bin, args, { stdio: "pipe", timeout: 120000 });
run("/usr/bin/say", ["-r", "170", "-o", voice, speech]);
run(ffmpeg, [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=0x14364d:s=360x640:r=30:d=18",
  "-i",
  voice,
  "-vf",
  "drawbox=x=35:y=80:w=290:h=200:color=0x2a7287:t=fill,drawbox=x=65:y=330:w=230:h=190:color=0x8ec8b0:t=fill",
  "-af",
  "apad",
  "-t",
  "18",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-movflags",
  "+faststart",
  source,
]);
run(ffmpeg, [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=360x640:rate=30:duration=5",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=880:duration=5",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-shortest",
  cutaway,
]);
run(ffmpeg, [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=0xcc8155:s=720x1280",
  "-vf",
  "drawbox=x=65:y=180:w=590:h=590:color=0xf0d2a0:t=fill",
  "-frames:v",
  "1",
  photo,
]);
run(ffmpeg, [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=220:duration=18",
  "-ar",
  "48000",
  music,
]);
const module = await build({
  entryPoints: [path.join(root, "src/shared/model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { newProject, makeClip } = await import(
  `data:text/javascript;base64,${Buffer.from(module.outputFiles[0].text).toString("base64")}`
);
const fixtureFile = path.join(work, "qa.cutline");
const first = newProject();
first.name = "Cutline Reel QA";
await writeFile(
  fixtureFile,
  JSON.stringify({
    project: first,
    past: [],
    future: [],
    filePath: fixtureFile,
  }),
);
const packaged = process.env.CUTLINE_PACKAGED === "1";
const executablePath =
  process.env.CUTLINE_APP_EXECUTABLE ||
  (packaged
    ? path.join(
        root,
        "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline",
      )
    : path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ));
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath,
  args: packaged ? [fixtureFile] : [root, fixtureFile],
  env,
});
const results = [],
  errors = [];
const append = results.push.bind(results);
results.push = (...items) => {
  for (const item of items) console.log(item);
  return append(...items);
};
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = async () => await invoke("state");
  const project = async () => (await state()).snapshot.project;
  const tx = async (commands) => {
    const p = await project();
    return invoke("edit", {
      projectId: p.id,
      revision: p.revision,
      label: "QA edit",
      commands,
    });
  };
  const imported = [];
  for (const file of [source, cutaway, photo, music])
    imported.push(await invoke("test.import", { path: file }));
  results.push("Local video, image, and music import completes");
  let p = await project();
  const sourceAsset = p.assets.find((a) => a.path === source);
  const cutawayAsset = p.assets.find((a) => a.path === cutaway);
  const photoAsset = p.assets.find((a) => a.path === photo);
  const musicAsset = p.assets.find((a) => a.path === music);
  if (!transcribe) {
    const words = speech.split(/\s+/);
    sourceAsset.words = words.map((text, i) => ({
      text,
      start: i * 0.34,
      end: i * 0.34 + 0.29,
    }));
  }
  // Keep an unused missing library asset to prove it cannot block export when
  // no clip references it. The original timeline itself stays playable.
  const missing = {
    id: "qa-unused-missing",
    name: "Old offline clip.mp4",
    path: path.join(work, "never-created.mp4"),
    kind: "video",
    duration: 3,
    hasAudio: false,
  };
  p.assets.push(missing);
  const track = p.tracks.find((t) => t.kind === "video");
  p.clips = [makeClip(p, "video", track.id, 0, sourceAsset)];
  const oldClipId = p.clips[0].id;
  await writeFile(
    fixtureFile,
    JSON.stringify({ project: p, past: [], future: [], filePath: fixtureFile }),
  );
  await invoke("test.load", { path: fixtureFile });
  await page.screenshot({ path: path.join(work, "reel-initial.png") });
  const options = {
    sources: [{ assetId: sourceAsset.id }],
    targetSeconds: 15,
    mode: "replace",
    style: "bold",
    captions: true,
    hook: "A complete story.",
    cta: "Make your next Reel.",
    brollAssetIds: [photoAsset.id, cutawayAsset.id],
    musicAssetId: musicAsset.id,
    musicVolume: 0.12,
  };

  if (transcribe) {
    // Start an asynchronous build, wait for real local speech work, then change
    // the project. Neither the stale build nor cancellation may replace clips.
    const startPending = async (buildOptions = options) => {
      const p = await project();
      await page.evaluate(
        (args) => {
          window.__reelQA = window.cutline.invoke("reel.create", args).then(
            (value) => ({ value }),
            (e) => ({ error: e.message }),
          );
        },
        { projectId: p.id, revision: p.revision, options: buildOptions },
      );
    };
    const awaitSpeech = async () => {
      for (let i = 0; i < 80; i++) {
        const s = await state();
        if (
          s.jobs.some((j) => j.kind === "transcribe" && j.state === "running")
        )
          return;
        await page.waitForTimeout(50);
      }
      throw Error("Speech job did not start");
    };
    await startPending();
    await awaitSpeech();
    await tx([
      {
        type: "project.update",
        patch: { name: "Changed during Reel preparation" },
      },
    ]);
    const stale = await page.evaluate(() => window.__reelQA);
    assert(stale.error?.includes("Project changed"), JSON.stringify(stale));
    assert.equal((await project()).clips[0].id, oldClipId);
    results.push("Stale Reel revision rejects without replacing timeline");
    // A completed stale build caches its transcript. Use a separate source to
    // exercise cancellation during real speech work rather than a cache hit.
    const cancelSource = path.join(work, "cancel-input.mp4");
    await copyFile(source, cancelSource);
    await invoke("test.import", { path: cancelSource });
    const cancelAsset = (await project()).assets.find(
      (asset) => asset.path === cancelSource,
    );
    assert(cancelAsset);
    await startPending({ ...options, sources: [{ assetId: cancelAsset.id }] });
    await awaitSpeech();
    const reelJob = (await state()).jobs.find(
      (j) => j.kind === "reel" && j.state === "running",
    );
    assert(reelJob);
    await invoke("job.cancel", { id: reelJob.id });
    const cancelled = await page.evaluate(() => window.__reelQA);
    assert(
      cancelled.error?.toLowerCase().includes("cancel"),
      JSON.stringify(cancelled),
    );
    assert.equal((await project()).clips[0].id, oldClipId);
    results.push("Cancelling Reel speech work preserves the original timeline");
  }

  // Complete the happy path through the actual three-stage wizard.
  await tx([
    { type: "project.update", patch: { name: "Cutline · complete Reel QA" } },
  ]);
  await page.getByRole("button", { name: "Reel", exact: true }).click();
  await page
    .getByRole("button", { name: "Build manually", exact: true })
    .click();
  const wizard = page.locator(".reel-builder");
  await wizard
    .locator(".reel-source")
    .filter({ hasText: "source.mp4" })
    .getByRole("checkbox")
    .check();
  await wizard
    .getByRole("button", { name: "Continue to style", exact: false })
    .click();
  await wizard.getByLabel("Target length").selectOption("15");
  await wizard.getByLabel("Opening hook").fill(options.hook);
  await wizard.getByLabel("Closing line").fill(options.cta);
  await wizard
    .getByRole("button", { name: "Continue to finishing", exact: false })
    .click();
  await wizard
    .locator(".reel-details summary")
    .filter({ hasText: "B-roll overlays" })
    .click();
  await wizard
    .getByRole("checkbox", { name: "photo.png", exact: true })
    .check();
  await wizard
    .getByRole("checkbox", { name: "cutaway.mp4", exact: true })
    .check();
  await wizard.getByLabel("Background music").selectOption(musicAsset.id);
  await wizard.getByLabel("Timeline").selectOption("replace");
  await wizard.getByRole("button", { name: "Build Reel", exact: true }).click();
  await wizard
    .getByText("Your montage edit is ready", { exact: true })
    .waitFor({ timeout: 120000 });
  p = await project();
  const summary = {
    durationFrames: Math.max(...p.clips.map((c) => c.start + c.duration)),
    captionCount: p.clips.filter((c) => c.kind === "caption").length,
    brollCount: p.clips.filter(
      (c) => p.tracks.find((t) => t.id === c.trackId)?.name === "Reel · B-roll",
    ).length,
  };
  results.push(
    "Actual Footage → Style → Finish wizard builds the Reel and shows its review result",
  );
  assert.equal(summary.durationFrames, 450);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert(summary.captionCount > 0);
  assert(summary.brollCount >= 2);
  assert(!p.clips.some((c) => c.id === oldClipId));
  assert(p.assets.some((a) => a.id === missing.id));
  assert(
    p.clips
      .filter((c) => c.kind === "caption")
      .every(
        (c) =>
          c.start + c.duration <= 450 &&
          c.words.every(
            (w) => w.start >= 0 && w.end <= c.duration / p.fps + 1e-6,
          ),
      ),
  );
  const brollTrack = p.tracks.find((t) => t.name === "Reel · B-roll");
  assert(brollTrack.muted);
  assert(
    p.clips
      .filter((c) => c.trackId === brollTrack.id)
      .every((c) => c.volume === 0),
  );
  if (transcribe)
    assert(p.assets.find((a) => a.id === sourceAsset.id).words.length > 10);
  results.push(
    `Builds 15-second portrait Reel: ${summary.captionCount} captions, ${summary.brollCount} muted cutaways, music, hook, CTA`,
  );
  const created = structuredClone(p);
  await invoke("undo");
  assert.equal((await project()).clips[0].id, oldClipId);
  await invoke("redo");
  assert.deepEqual((await project()).clips, created.clips);
  results.push(
    "One Undo restores the previous timeline; Redo restores the complete Reel",
  );
  const footage = p.clips.find((c) => c.assetId === sourceAsset.id);
  await tx([
    {
      type: "clip.update",
      id: footage.id,
      patch: { overlay: "film-grain", overlayAmount: 0.15 },
    },
    ...p.clips
      .filter((c) => c.kind === "caption")
      .map((c) => ({
        type: "clip.update",
        id: c.id,
        patch: { captionStyle: "karaoke" },
      })),
  ]);
  await page.getByRole("button", { name: "Go to start", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(2200);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.screenshot({ path: path.join(work, "reel-editor.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  await page.waitForTimeout(200);
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    footer: document.querySelector(".statusbar").getBoundingClientRect().bottom,
    tabs: [...document.querySelectorAll(".library-tabs button")].map((e) => ({
      text: e.textContent,
      right: e.getBoundingClientRect().right,
    })),
  }));
  assert(layout.scrollWidth <= layout.width + 1);
  assert(layout.footer <= layout.height + 1);
  assert(
    await page
      .getByRole("button", { name: "Captions", exact: true })
      .isVisible(),
  );
  await page.screenshot({ path: path.join(work, "reel-minimum-window.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 960),
  );
  results.push(
    "1100×760 window retains visible caption navigation and in-bounds timeline/footer",
  );
  const job = await invoke("test.export", { path: output });
  let finished;
  const started = Date.now();
  while (Date.now() - started < 360000) {
    finished = (await state()).jobs.find((j) => j.id === job.id);
    if (finished?.state === "done") break;
    if (["error", "cancelled"].includes(finished?.state))
      throw Error(finished.message);
    await page.waitForTimeout(500);
  }
  assert.equal(finished?.state, "done", "Render did not complete");
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
  const video = probe.streams.find((s) => s.codec_type === "video"),
    audio = probe.streams.find((s) => s.codec_type === "audio");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(video.codec_name, "h264");
  assert(audio);
  assert.equal(audio.codec_name, "aac");
  assert(Math.abs(Number(probe.format.duration) - 15) < 0.15);
  const samples = (file) => {
    const bytes = run(ffmpeg, [
      "-v",
      "error",
      "-i",
      file,
      "-t",
      "15",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "s16le",
      "-",
    ]);
    return Array.from(
      { length: Math.floor(bytes.length / 2) },
      (_, i) => bytes.readInt16LE(i * 2) / 32768,
    );
  };
  const originalAudio = samples(source),
    renderedAudio = samples(output);
  let correlation = 0,
    bestLag = 0;
  for (let lag = -40; lag <= 40; lag++) {
    let cross = 0,
      a2 = 0,
      b2 = 0;
    for (
      let i = 80;
      i < Math.min(originalAudio.length, renderedAudio.length) - 80;
      i += 4
    ) {
      const a = originalAudio[i],
        b = renderedAudio[i + lag];
      cross += a * b;
      a2 += a * a;
      b2 += b * b;
    }
    const value = cross / Math.sqrt(a2 * b2);
    if (value > correlation) {
      correlation = value;
      bestLag = lag;
    }
  }
  assert(
    correlation > 0.85,
    `Narration correlation unexpectedly low: ${correlation}`,
  );
  results.push(
    `Narration remains audible beneath cutaways/music: source correlation ${correlation.toFixed(4)}, timing offset ${bestLag / 8}ms`,
  );
  for (const [name, time] of [
    ["hook", 1.3],
    ["cutaway", 4.3],
    ["closing", 13.4],
  ])
    run(ffmpeg, [
      "-y",
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "scale=432:768",
      path.join(work, `${name}.png`),
    ]);
  results.push(
    `1080×1920 H.264/AAC export verified at ${probe.format.duration}s; unused missing library media does not block it`,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        packaged,
        transcribe,
        output,
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ work, output, results }, null, 2));
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(work, "failure.png") })
      .catch(() => {});
  await writeFile(
    path.join(work, "failure.json"),
    JSON.stringify(
      { message: error.message, stack: error.stack, results, errors },
      null,
      2,
    ),
  );
  console.error("QA artifacts:", work);
  throw error;
} finally {
  await app.close();
}
