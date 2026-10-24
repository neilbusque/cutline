import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  parentWork = path.resolve(root, "../../work");
await mkdir(parentWork, { recursive: true });
const work = await mkdtemp(path.join(parentWork, "auto-reel-qa-"));
const voice = process.env.CUTLINE_QA_VOICE;
assert(
  voice,
  "Provide CUTLINE_QA_VOICE with the Kokoro coffee/ocean narration WAV.",
);
const run = (bin, args) =>
  execFileSync(bin, args, { stdio: "pipe", timeout: 180000 });
const ffmpeg = path.join(
    root,
    "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
  ),
  ffprobe = path.join(
    root,
    "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
  );
const probe = (file) =>
  JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      file,
    ]).toString(),
  );
const seconds = Number(probe(voice).format.duration);
const source = path.join(work, "A better morning.mp4"),
  output = path.join(work, "Automatic Reel.mp4");
const footage = path.join(
  root,
  "sample-project/media/commons-video-81916645-86f3449d-18a4-480e-911b-f99e4c24df01.webm",
);
run(ffmpeg, [
  "-y",
  "-v",
  "error",
  "-stream_loop",
  "-1",
  "-i",
  footage,
  "-i",
  voice,
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-vf",
  "scale=360:640:force_original_aspect_ratio=increase,crop=360:640",
  "-t",
  String(seconds),
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  source,
]);
const built = await build({
  entryPoints: [path.join(root, "src/shared/model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { newProject, makeClip } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`
);
const p = newProject();
p.name = "Automatic Reel QA";
const sentinel = makeClip(
  p,
  "text",
  p.tracks.find((t) => t.kind === "text").id,
  0,
);
sentinel.text = "Previous edit";
p.clips.push(sentinel);
const fixture = path.join(work, "Automatic Reel.cutline");
await writeFile(
  fixture,
  JSON.stringify({ project: p, past: [], future: [], filePath: fixture }),
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
  args: packaged ? [fixture] : [root, fixture],
  env,
});
const errors = [],
  results = [];
let page;
const record = (value) => {
  results.push(value);
  console.log(value);
};
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = () => invoke("state");
  // Exercise the real primary CTA; stub only the native file picker.
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, source);
  // Cutline opens on Story; Auto edit lives in Reel.
  await page
    .locator(".library-tabs button")
    .filter({ hasText: /^Reel$/ })
    .click();
  await page.getByLabel("Automatic caption style").selectOption("karaoke");
  await page.getByLabel("Automatic edit pacing").selectOption("natural");
  await page
    .getByRole("button", { name: "Upload & auto edit", exact: false })
    .click();
  await page.locator(".auto-progress").waitFor({ timeout: 10000 });
  record("One Upload & auto edit action starts the complete pipeline");
  await page
    .getByText("Your Reel is ready", { exact: true })
    .waitFor({ timeout: 240000 });
  let current = (await state()).snapshot.project;
  const duration =
    Math.max(...current.clips.map((c) => c.start + c.duration)) / current.fps;
  const captions = current.clips.filter((c) => c.kind === "caption");
  const cutaways = current.clips.filter(
    (c) =>
      current.tracks.find((t) => t.id === c.trackId)?.muted &&
      current.assets.find((a) => a.id === c.assetId)?.origin,
  );
  const bed = current.clips.find((c) =>
    current.assets
      .find((a) => a.id === c.assetId)
      ?.name.startsWith("Original music"),
  );
  assert(captions.length >= 5);
  assert(
    captions.every(
      (c) => c.x + c.width / 2 === current.width / 2 && c.align === "center",
    ),
    "Automatic captions must be centered on the video",
  );
  assert(
    captions.every(
      (c) =>
        c.captionLayout === "balanced" &&
        c.captionStyle === "karaoke" &&
        c.captionSourceId,
    ),
  );
  assert(
    !current.clips.some((c) => c.kind === "text"),
    "Opening title is optional and off by default",
  );
  assert(
    cutaways.length >= 1,
    "Live transcript topics must produce at least one relevant cutaway",
  );
  assert(bed);
  assert.equal(current.width, 1080);
  assert.equal(current.height, 1920);
  assert(duration > 10 && duration <= seconds + 0.1);
  assert(
    captions.every((c) => c.start + c.duration <= duration * current.fps + 0.1),
  );
  assert(
    cutaways.every(
      (c) =>
        c.volume === 0 && current.tracks.find((t) => t.id === c.trackId).muted,
    ),
  );
  assert(bed.keyframes.some((k) => k.property === "volume" && k.value < 0.1));
  assert(
    current.clips
      .filter((c) => c.kind === "video" && !cutaways.includes(c))
      .some((c) => c.keyframes.some((k) => k.property === "scale")),
  );
  for (const shot of cutaways) {
    const base = current.clips.find(
      (c) =>
        c.kind === "video" &&
        !cutaways.includes(c) &&
        c.start <= shot.start &&
        c.start + c.duration > shot.start,
    );
    assert(base, "A continuous base video must remain below each dissolve");
    assert.equal(
      shot.fadeIn,
      Math.min(
        Math.round(current.fps * 0.27),
        Math.floor((shot.duration - 1) * 0.2),
      ),
    );
    assert.equal(shot.fadeOut, shot.fadeIn);
    assert(
      shot.fadeIn + shot.fadeOut < shot.duration / 2,
      "Most of each cutaway must be fully visible",
    );
    assert.deepEqual(
      [shot.look, shot.effectAmount],
      [base.look, base.effectAmount],
      "Source and stock share a consistent grade",
    );
  }
  record(
    "B-roll has bounded eased dissolves over continuous narration and consistent color finishing",
  );
  const credits = cutaways.map(
    (c) => current.assets.find((a) => a.id === c.assetId).origin,
  );
  assert(credits.every((c) => c?.page && c?.creator && c?.license));
  record(
    `Actual Whisper + live stock + local music: ${duration.toFixed(2)}s, ${captions.length} captions, ${cutaways.length} cutaways`,
  );
  const created = structuredClone(current);
  await invoke("undo");
  await page
    .getByText("Your Reel is ready", { exact: true })
    .waitFor({ state: "hidden" });
  assert.deepEqual(
    (await state()).snapshot.project.clips,
    JSON.parse(JSON.stringify(p.clips)),
  );
  await invoke("redo");
  assert.deepEqual((await state()).snapshot.project.clips, created.clips);
  await page.getByText("Your Reel is ready", { exact: true }).waitFor();
  record(
    "Single Undo/Redo restores the entire project including media and result state",
  );
  await page
    .getByRole("button", { name: "Refine captions", exact: true })
    .click();
  await page.locator(".caption-studio").waitFor({ state: "visible" });
  const sourceClip = current.clips.find(
    (c) => current.assets.find((a) => a.id === c.assetId)?.path === source,
  );
  const regen = await invoke("transcribe", {
    projectId: current.id,
    revision: (await state()).snapshot.project.revision,
    clipId: sourceClip.id,
  });
  const regenerated = (await state()).snapshot.project;
  assert.equal(
    regenerated.clips.filter((c) => c.kind === "caption").length,
    captions.length,
  );
  assert(
    regenerated.clips
      .filter((c) => c.kind === "caption")
      .every((c) => c.captionStyle === "karaoke"),
  );
  await invoke("undo");
  assert.deepEqual((await state()).snapshot.project.clips, created.clips);
  record(
    "Refine captions opens Caption Studio; regenerating replaces linked captions without duplicates and keeps the style",
  );
  await page.getByRole("button", { name: "Reel", exact: true }).click();

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.screenshot({ path: path.join(work, "auto-editor.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    nav: document.querySelector(".library-tabs").getBoundingClientRect().right,
    tabs: [...document.querySelectorAll(".library-tabs button")].map((e) => ({
      text: e.textContent,
      right: e.getBoundingClientRect().right,
    })),
  }));
  assert(layout.scroll <= layout.width + 1);
  assert(layout.tabs.every((t) => t.right <= layout.nav + 1));
  assert.equal(layout.tabs.length, 9);
  await page.screenshot({ path: path.join(work, "auto-minimum-window.png") });
  record(
    "Nine editing tabs and automatic result fit the 1100×760 minimum window",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 960),
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
  assert.equal(finished?.state, "done");
  const info = probe(output),
    video = info.streams.find((s) => s.codec_type === "video"),
    audio = info.streams.find((s) => s.codec_type === "audio");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(video.codec_name, "h264");
  assert.equal(audio.codec_name, "aac");
  assert(Math.abs(Number(info.format.duration) - duration) < 0.1);
  // Compare each retained speech segment at its new position against the input.
  const samples = (file, start, length) => {
    const b = run(ffmpeg, [
      "-v",
      "error",
      "-ss",
      String(start),
      "-i",
      file,
      "-t",
      String(length),
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
      { length: b.length / 2 },
      (_, i) => b.readInt16LE(i * 2) / 32768,
    );
  };
  const main = current.clips.filter(
    (c) => current.assets.find((a) => a.id === c.assetId)?.path === source,
  );
  const correlations = main.map((c) => {
    const a = samples(source, c.sourceIn, c.duration / current.fps),
      b = samples(output, c.start / current.fps, c.duration / current.fps);
    let cross = 0,
      a2 = 0,
      b2 = 0;
    for (let i = 80; i < Math.min(a.length, b.length) - 80; i++) {
      cross += a[i] * b[i];
      a2 += a[i] * a[i];
      b2 += b[i] * b[i];
    }
    return cross / Math.sqrt(a2 * b2);
  });
  assert(
    correlations.every((c) => c > 0.8),
    `Narration correlation: ${correlations}`,
  );
  for (const [name, time] of [
    ["opening", 1.2],
    ["broll", cutaways[0].start / current.fps + 0.7],
    ["ending", Math.max(0, duration - 1.2)],
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
      path.join(work, `${name}.jpg`),
    ]);
  assert.deepEqual(errors, []);
  record(
    "Full MP4 export preserves narration after cuts, with captions, stock, motion and music",
  );
  await writeFile(
    path.join(work, "Finished Reel.cutline"),
    JSON.stringify(
      {
        project: current,
        past: [],
        future: [],
        filePath: path.join(work, "Finished Reel.cutline"),
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(
      {
        packaged,
        source,
        voice,
        output,
        fixture,
        seconds,
        duration,
        captionCount: captions.length,
        brollCount: cutaways.length,
        stockPlacements: cutaways.map((c) => ({
          title: current.assets.find((a) => a.id === c.assetId)?.origin?.title,
          kind: c.kind,
          startSeconds: c.start / current.fps,
          durationSeconds: c.duration / current.fps,
          sourceIn: c.sourceIn,
          fadeInSeconds: c.fadeIn / current.fps,
          fadeOutSeconds: c.fadeOut / current.fps,
          look: c.look,
          effectAmount: c.effectAmount,
        })),
        credits,
        correlations,
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ work, output }, null, 2));
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(work, "failure.png") })
      .catch(() => {});
  await writeFile(
    path.join(work, "failure.json"),
    JSON.stringify(
      { error: error.message, stack: error.stack, results, errors },
      null,
      2,
    ),
  );
  console.error("QA folder", work);
  throw error;
} finally {
  await app.close();
}
