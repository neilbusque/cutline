import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  parentWork = path.resolve("../../work"),
  ffmpeg = path.join(
    root,
    "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
  );
await mkdir(parentWork, { recursive: true });
const work = await mkdtemp(path.join(parentWork, "transitions-qa-"));
const run = (args, input) => {
  const r = spawnSync(ffmpeg, ["-v", "error", ...args], {
    input,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr?.toString());
  return r.stdout;
};
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
const fixture = { project: newProject(), past: [], future: [] };
const template = makeClip(fixture.project, "video", "video");
fixture.project.width = 640;
fixture.project.height = 360;
fixture.project.fps = 30;
fixture.project.name = "Transitions QA";
fixture.past = [];
fixture.future = [];
fixture.project.assets = [];
fixture.project.clips = [];
for (const [i, color] of ["red", "blue"].entries()) {
  const file = path.join(work, `transition-${color}.mp4`);
  run([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=640x360:r=30:d=4`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${i ? 660 : 330}:duration=4`,
    "-vf",
    "scale=in_color_matrix=bt601:out_color_matrix=bt709",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  fixture.project.assets.push({
    id: `asset-${color}`,
    name: `${color}.mp4`,
    kind: "video",
    path: file,
    duration: 4,
    hasAudio: true,
    width: 640,
    height: 360,
  });
  fixture.project.clips.push({
    ...template,
    id: color,
    assetId: `asset-${color}`,
    trackId: "video",
    start: i * 60,
    duration: 60,
    sourceIn: 0,
    speed: 1,
    width: 640,
    height: 360,
    x: 0,
    y: 0,
    opacity: 1,
    rotation: 0,
    look: "none",
    brightness: 1,
    contrast: 1,
    saturation: 1,
    blur: 0,
    vignette: 0,
    cameraMotion: "none",
    fadeIn: 0,
    fadeOut: 0,
    volume: 0.4,
  });
}
const file = path.join(work, "qa-transitions.cutline");
await writeFile(file, JSON.stringify(fixture));
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "qa-transitions-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.CUTLINE_PACKAGED === "1";
const app = await electron.launch({
  executablePath: packaged
    ? path.join(
        root,
        "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline",
      )
    : path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
  args: packaged
    ? ["--force-color-profile=srgb", file]
    : [root, "--force-color-profile=srgb", file],
  env,
});
const results = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = async () => (await invoke("state")).snapshot.project;
  const exportVideo = async (out) => {
    const job = await invoke("test.export", { path: out });
    const started = Date.now();
    while (Date.now() - started < 90000) {
      const j = (await invoke("state")).jobs.find((x) => x.id === job.id);
      if (j?.state === "error") throw Error(j.message);
      if (j?.state === "done") return (Date.now() - started) / 1000;
      await page.waitForTimeout(500);
    }
    throw Error("export timeout");
  };
  const inspectFrames = (out) => {
    const raw = run([
      "-i",
      out,
      "-vf",
      "scale=64:36",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const stride = 64 * 36 * 3;
    assert.equal(raw.length % stride, 0);
    return Array.from({ length: raw.length / stride }, (_, f) => {
      let red = 0,
        blue = 0;
      for (let i = f * stride; i < (f + 1) * stride; i += 3) {
        red += raw[i];
        blue += raw[i + 2];
      }
      return { red: red / (64 * 36), blue: blue / (64 * 36) };
    });
  };
  const rgb = (raw, x) => {
    const i = (90 * 320 + x) * 3;
    return [...raw.subarray(i, i + 3)];
  };
  for (const kind of [
    "crossfade",
    "black",
    "slide-left",
    "slide-right",
    "wipe",
  ]) {
    await page
      .getByRole("button", { name: "video clip blue.mp4", exact: true })
      .click();
    await page.getByLabel("Transition", { exact: true }).selectOption(kind);
    await page.waitForTimeout(150);
    assert.equal((await state()).clips[1].start, 45);
    await page
      .getByRole("button", { name: "Go to start", exact: true })
      .click();
    await page.keyboard.press("Escape");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
    for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(600);
    const screenshot = await page.locator(".canvas").screenshot();
    await writeFile(path.join(work, `preview-${kind}.png`), screenshot);
    const preview = run(
      [
        "-i",
        "pipe:0",
        "-vf",
        "scale=320:180",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      screenshot,
    );
    const out = path.join(work, `qa-transition-${kind}.mp4`);
    const exportSeconds = await exportVideo(out);
    const allFrames = inspectFrames(out);
    assert.equal(
      allFrames.length,
      105,
      "Transitions must use the existing source overlap without adding frames",
    );
    const minimumColorEnergy = Math.min(
      ...allFrames.map((f) => f.red + f.blue),
    );
    if (kind !== "black")
      assert(
        minimumColorEnergy > 230,
        `${kind}: a frame dipped toward black (${minimumColorEnergy})`,
      );
    else
      assert(
        minimumColorEnergy < 8,
        "Fade through black must retain its intentional black midpoint",
      );
    if (kind === "crossfade") {
      assert(
        allFrames[46].blue - allFrames[45].blue < 10,
        "Crossfade must ease into its first source frames",
      );
      assert(
        allFrames[59].blue - allFrames[58].blue < 10,
        "Crossfade must settle gently on its last source frames",
      );
      assert(
        allFrames[52].blue - allFrames[51].blue > 15,
        "Crossfade must still complete through the midpoint",
      );
    }
    const exported = run([
      "-i",
      out,
      "-vf",
      "select=eq(n\\,52),scale=320:180",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const samples = [80, 240].map((x) => ({
      preview: rgb(preview, x),
      export: rgb(exported, x),
    }));
    for (const s of samples)
      for (let i = 0; i < 3; i++)
        assert(
          Math.abs(s.preview[i] - s.export[i]) < 18,
          `${kind}: preview/export mismatch ${JSON.stringify(samples)}`,
        );
    if (kind === "crossfade")
      assert(samples.every((s) => s.export[0] > 100 && s.export[2] > 100));
    if (kind === "black")
      assert(samples.every((s) => Math.max(...s.export) < 8));
    if (kind === "slide-left")
      assert(samples[0].export[0] > 220 && samples[1].export[2] > 220);
    if (kind === "slide-right" || kind === "wipe")
      assert(samples[0].export[2] > 220 && samples[1].export[0] > 220);
    results.push({
      kind,
      samples,
      exportSeconds,
      frames: allFrames.length,
      minimumColorEnergy,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  await page
    .getByRole("button", { name: "video clip blue.mp4", exact: true })
    .click();
  await page.getByLabel("Transition duration (s)").fill("0.8");
  await page.getByLabel("Transition duration (s)").press("Enter");
  await page.waitForTimeout(100);
  assert.equal((await state()).clips[1].start, 36);
  await invoke("undo");
  assert.equal((await state()).clips[1].start, 45);
  await invoke("redo");
  assert.equal((await state()).clips[1].start, 36);
  await invoke("save");
  const saved = await state();
  await invoke("test.load", { path: file });
  assert.deepEqual((await state()).clips, saved.clips);
  await page
    .getByRole("button", { name: "video clip blue.mp4", exact: true })
    .click();
  await page.getByLabel("Transition", { exact: true }).selectOption("none");
  await page.waitForTimeout(100);
  assert.equal((await state()).clips[1].start, 60);
  await page
    .getByLabel("Transition", { exact: true })
    .selectOption("crossfade");
  await page.waitForTimeout(100);
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/transitions-qa.png" });
  // Automatic Reels keep their source picture and narration continuous beneath
  // cutaways. Check actual encoded frames, including a deliberately short shot.
  const overlayFixture = structuredClone(fixture);
  overlayFixture.project.name = "Overlay dissolve QA";
  overlayFixture.project.tracks.unshift({
    id: "b-roll",
    name: "B-roll",
    kind: "video",
    muted: true,
    hidden: false,
  });
  overlayFixture.project.clips = [
    { ...fixture.project.clips[0], duration: 120 },
    {
      ...fixture.project.clips[1],
      id: "cutaway",
      trackId: "b-roll",
      start: 30,
      duration: 60,
      volume: 0,
      fadeIn: 8,
      fadeOut: 8,
    },
    {
      ...fixture.project.clips[1],
      id: "short-cutaway",
      trackId: "b-roll",
      start: 100,
      duration: 6,
      volume: 0,
      fadeIn: 20,
      fadeOut: 20,
    },
  ];
  const overlayFile = path.join(work, "qa-overlay.cutline");
  await writeFile(overlayFile, JSON.stringify(overlayFixture));
  await invoke("test.load", { path: overlayFile });
  const overlayOut = path.join(work, "qa-overlay.mp4");
  const overlaySeconds = await exportVideo(overlayOut);
  const overlayFrames = inspectFrames(overlayOut);
  assert.equal(
    overlayFrames.length,
    120,
    "B-roll must not change Reel duration",
  );
  const minimumColorEnergy = Math.min(
    ...overlayFrames.map((f) => f.red + f.blue),
  );
  assert(
    minimumColorEnergy > 230,
    `Overlay produced a dark frame (${minimumColorEnergy})`,
  );
  for (const f of [29, 30, 89, 90, 99, 100, 105, 106])
    assert(
      overlayFrames[f].red > 240 && overlayFrames[f].blue < 10,
      `Overlay endpoint frame ${f} must reveal the original picture`,
    );
  assert(
    overlayFrames.slice(38, 82).every((f) => f.blue > 240 && f.red < 10),
    "Cutaway must hold fully visible between dissolves",
  );
  assert(
    overlayFrames[103].blue > 240 && overlayFrames[103].red < 10,
    "A short cutaway with oversized fade requests must reach full visibility",
  );
  assert(
    overlayFrames[31].blue - overlayFrames[30].blue < 15,
    "Overlay entry must ease in gently",
  );
  assert(
    overlayFrames[88].blue - overlayFrames[89].blue < 15,
    "Overlay exit must ease out gently",
  );
  const audioBytes = run([
    "-i",
    overlayOut,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "f32le",
    "pipe:1",
  ]);
  const rms = (start, end) => {
    let sum = 0;
    const lo = Math.round(start * 8000),
      hi = Math.round(end * 8000);
    for (let i = lo; i < hi; i++) sum += audioBytes.readFloatLE(i * 4) ** 2;
    return Math.sqrt(sum / (hi - lo));
  };
  const narrationRms = [
    [0.3, 0.8],
    [1.1, 1.4],
    [1.7, 2.3],
    [2.8, 3.1],
    [3.6, 3.9],
  ].map(([a, b]) => rms(a, b));
  assert(
    Math.min(...narrationRms) > 0.02,
    "Original narration must remain audible",
  );
  assert(
    Math.max(...narrationRms) / Math.min(...narrationRms) < 1.08,
    "Visual dissolves must not fade or dip the continuous narration",
  );
  results.push({
    kind: "overlay",
    frames: overlayFrames.length,
    minimumColorEnergy,
    narrationRms,
    exportSeconds: overlaySeconds,
  });
  console.log(JSON.stringify(results.at(-1)));
  assert.deepEqual(errors, []);
  results.push(
    "Duration, undo/redo, save/reopen, removal restore original cut; no renderer errors",
  );
  const report = JSON.stringify(
    { packaged, work, date: new Date().toISOString(), results, errors },
    null,
    2,
  );
  await writeFile("qa-transitions-results.json", report);
  await writeFile(path.join(work, "results.json"), report);
  console.log(`Transition QA passed: ${work}`);
} finally {
  await app.close();
}
