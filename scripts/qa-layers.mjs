import { _electron as electron } from "@playwright/test";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
// Generate all fixtures locally in a disposable directory. Never reuse recovery data.
const root = process.cwd();
const parent = path.resolve(root, "../qa-layers");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const media = (args) => {
  const result = spawnSync(ffmpeg, ["-y", "-v", "error", ...args], {
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
};
const ocean = path.join(work, "Layer one.mp4");
for (const [file, color] of [
  [ocean, "0x204b69"],
  [path.join(work, "qa-second.mp4"), "0xc78b50"],
])
  media([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=360x640:r=30:d=8`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
for (const [name, frequency] of [
  ["a", 330],
  ["b", 660],
])
  media([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=8`,
    "-af",
    "volume=3",
    "-ar",
    "48000",
    path.join(work, `layer-tone-${name}.wav`),
  ]);
const module = await build({
  entryPoints: [path.join(root, "src/shared/model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { newProject } = await import(
  `data:text/javascript;base64,${Buffer.from(module.outputFiles[0].text).toString("base64")}`
);
const fixture = { project: newProject(), past: [], future: [] };
fixture.project.name = "Layered mix QA";
const file = path.join(work, "qa-layers.cutline");
await writeFile(file, JSON.stringify(fixture));
const packaged = process.env.CUTLINE_PACKAGED === "1",
  env = {
    ...process.env,
    CUTLINE_QA: "1",
    CUTLINE_DATA_DIR: path.join(work, "qa-layers-data"),
  };
delete env.ELECTRON_RUN_AS_NODE;
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
  args: packaged ? [file] : [root, file],
  env,
});
const results = [],
  errors = [];
const log = (s) => {
  results.push(s);
  console.log(s);
};
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
  const tx = async (commands) => {
    const p = await state();
    return invoke("edit", {
      projectId: p.id,
      revision: p.revision,
      label: "QA layer edit",
      commands,
    });
  };
  await invoke("import", {
    paths: [
      ocean,
      path.join(work, "qa-second.mp4"),
      path.join(work, "layer-tone-a.wav"),
      path.join(work, "layer-tone-b.wav"),
    ],
  });
  const imported = await state();
  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Media", exact: true })
    .click();
  assert.equal(imported.assets.length, 4);
  assert.equal(
    imported.assets.filter((asset) => asset.kind === "audio").length,
    2,
  );
  assert(
    imported.assets
      .filter((a) => a.kind === "audio")
      .every((a) => Math.max(...a.waveform) > 0.1),
  );
  const library = await page
    .locator(".library-content:visible")
    .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert(library.scroll <= library.width + 1);
  log(
    "Audio waveforms retain audible tone peaks; the library does not overflow",
  );
  for (const a of (await state()).assets)
    await page.getByLabel(`Select ${a.name}`, { exact: true }).check();
  await page.getByRole("button", { name: "Stack selected as layers" }).click();
  await page.waitForTimeout(150);
  let p = await state();
  assert.equal(p.clips.length, 4);
  assert.equal(new Set(p.clips.map((c) => c.trackId)).size, 4);
  assert(p.clips.every((c) => c.start === 0));
  await invoke("undo");
  assert.equal((await state()).clips.length, 0);
  await invoke("redo");
  log(
    "Stack two video files and two audio files on four independent layers; one-step undo/redo",
  );
  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Motion", exact: true })
    .click();
  await page.getByRole("tab", { name: "Text", exact: true }).click();
  await page
    .getByRole("button", { name: "Add plain text", exact: true })
    .click();
  await page.waitForTimeout(100);
  await page
    .getByRole("button", { name: "Add plain text", exact: true })
    .click();
  await page.waitForTimeout(100);
  p = await state();
  const titles = p.clips.filter((c) => c.kind === "text");
  assert.equal(titles.length, 2);
  assert.notEqual(titles[0].trackId, titles[1].trackId);
  log("Overlapping titles automatically use independent text layers");
  await page.getByLabel("New layer type").selectOption("audio");
  await page.getByRole("button", { name: "Add track", exact: true }).click();
  await page.waitForTimeout(100);
  p = await state();
  const empty = p.tracks.find(
    (t) =>
      t.kind === "audio" &&
      !p.clips.some((c) => c.trackId === t.id) &&
      t.id !== "audio",
  );
  assert(empty);
  await page
    .getByLabel(`Rename ${empty.name}`, { exact: true })
    .fill("Voiceover");
  await page.getByLabel(`Rename ${empty.name}`, { exact: true }).press("Enter");
  await page.waitForTimeout(100);
  assert((await state()).tracks.some((t) => t.name === "Voiceover"));
  await page
    .getByRole("button", { name: "Move Voiceover up", exact: true })
    .click();
  await page.waitForTimeout(100);
  assert.equal((await state()).tracks.at(-2).name, "Voiceover");
  await invoke("undo");
  log("Typed layer creation, rename, ordering and undo");
  p = await state();
  const videos = p.clips.filter((c) => c.kind === "video"),
    audio = p.clips.filter((c) => c.kind === "audio");
  await tx([
    ...videos.map((c, i) => ({
      type: "clip.update",
      id: c.id,
      patch: {
        duration: 120,
        volume: 0,
        ...(i === 1 ? { x: 560, y: 120, width: 420, height: 740 } : {}),
      },
    })),
    ...audio.map((c) => ({
      type: "clip.update",
      id: c.id,
      patch: { volume: 0.2, duration: 120 },
    })),
    ...titles.map((c, i) => ({
      type: "clip.update",
      id: c.id,
      patch: {
        text: i ? "Two audio tracks. One mix." : "Built in layers.",
        y: i ? 1450 : 1050,
        fontSize: i ? 55 : 86,
        duration: 120,
      },
    })),
  ]);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(1000);
  const start = Date.now();
  const before = await page
    .locator(".canvas video")
    .first()
    .evaluate((v) => ({
      time: v.currentTime,
      quality: v.getVideoPlaybackQuality().droppedVideoFrames,
    }));
  await page.waitForTimeout(1500);
  const after = await page
    .locator(".canvas video")
    .first()
    .evaluate((v) => ({
      time: v.currentTime,
      quality: v.getVideoPlaybackQuality().droppedVideoFrames,
    }));
  const wall = (Date.now() - start) / 1000;
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  assert(Math.abs(after.time - before.time - wall) < 0.5);
  log(
    `Six-layer playback: ${(after.time - before.time).toFixed(2)}s media / ${wall.toFixed(2)}s wall; ${after.quality - before.quality} dropped frames on sampled video`,
  );
  await page.getByRole("button", { name: "Media", exact: true }).focus();
  await page.keyboard.press("Space");
  assert.equal(
    await page.getByRole("button", { name: "Pause", exact: true }).count(),
    0,
  );
  log(
    "Space activates a focused button without unexpectedly starting playback",
  );
  await page.screenshot({ path: path.join(work, "layered-editor.png") });
  const saved = await state();
  await invoke("test.load", { path: file });
  assert.deepEqual(
    (await state()).clips,
    JSON.parse(JSON.stringify(saved.clips)),
  );
  log("Layered project survives save/reopen");
  const render = async (name) => {
    const out = path.join(work, name);
    const job = await invoke("test.export", { path: out });
    const start = Date.now();
    while (Date.now() - start < 180000) {
      const current = (await invoke("state")).jobs.find((j) => j.id === job.id);
      if (current?.state === "done")
        return { out, seconds: (Date.now() - start) / 1000 };
      if (current?.state === "error") throw Error(current.message);
      await page.waitForTimeout(1000);
    }
    throw Error("Export timeout");
  };
  const mixed = await render("layered-demo.mp4");
  const tone = (file, hz) => {
    const result = spawnSync(
      path.join(root, "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg"),
      [
        "-v",
        "error",
        "-ss",
        "0.5",
        "-i",
        file,
        "-t",
        "2",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { maxBuffer: 1000000 },
    );
    assert.equal(result.status, 0);
    const n = result.stdout.length / 4;
    let a = 0,
      b = 0;
    for (let i = 0; i < n; i++) {
      const v = result.stdout.readFloatLE(i * 4);
      a += v * Math.cos((2 * Math.PI * hz * i) / 8000);
      b += v * Math.sin((2 * Math.PI * hz * i) / 8000);
    }
    return (2 * Math.hypot(a, b)) / n;
  };
  media(["-i", mixed.out, "-f", "null", "-"]);
  assert(tone(mixed.out, 330) > 0.01);
  assert(tone(mixed.out, 660) > 0.01);
  log(
    `Six-layer 1080p export: ${mixed.seconds.toFixed(1)}s; both independent audio tones verified in the mix`,
  );
  await tx([
    { type: "track.update", id: audio[1].trackId, patch: { muted: true } },
  ]);
  const muted = await render("layered-muted.mp4");
  media(["-i", muted.out, "-f", "null", "-"]);
  assert(tone(muted.out, 330) > 0.01);
  assert(tone(muted.out, 660) < 0.001);
  log("Muting one audio layer removes only its tone from the exported mix");
  assert.deepEqual(errors, []);
  log("No uncaught renderer errors");
  await writeFile(
    path.join(work, "qa-layers-results.json"),
    JSON.stringify(
      { date: new Date().toISOString(), packaged, results, errors },
      null,
      2,
    ),
  );
} catch (e) {
  await (
    await app.firstWindow()
  ).screenshot({ path: path.join(work, "qa-layers-error.png") });
  throw e;
} finally {
  await app.close();
  console.log(`Layers QA artifacts: ${work}`);
}
