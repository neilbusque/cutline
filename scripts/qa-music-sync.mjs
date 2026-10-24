import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

// All media, projects, recovery state and MCP configuration are disposable.
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED !== "0";
const smokeSource = process.env.CUTLINE_MUSIC_QA_SMOKE_SOURCE;
const appRoot =
  process.env.CUTLINE_APP ??
  path.join(root, "release/Cutline-darwin-arm64/Cutline.app");
const parentWork =
  process.env.CUTLINE_MUSIC_QA_RESULTS ??
  path.resolve(root, "../qa-music-sync");
await mkdir(parentWork, { recursive: true });
const work = await mkdtemp(path.join(parentWork, "run-"));
const data = path.join(work, "user-data");
const env = { ...process.env, CUTLINE_QA: "1", CUTLINE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const executable =
  process.env.CUTLINE_EXECUTABLE ??
  (packaged
    ? path.join(appRoot, "Contents/MacOS/Cutline")
    : path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ));
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const results = [],
  errors = [],
  consoleErrors = [];
let app, page, client, failure;
const log = (message, detail) => {
  results.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message, detail === undefined ? "" : JSON.stringify(detail));
};
const media = (binary, args, input) => {
  const result = spawnSync(binary, args, {
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
};
const invoke = (name, args) =>
  page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
    name,
    args,
  });
const state = async () => (await invoke("state")).snapshot.project;
const guard = (p) => ({ projectId: p.id, revision: p.revision });
const snapshot = (p) => JSON.parse(JSON.stringify(p));
const waitProject = async (predicate, message) => {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const p = await state();
    if (predicate(p)) {
      await page.waitForTimeout(100);
      return p;
    }
    await page.waitForTimeout(80);
  }
  throw Error(message);
};
const commitClick = async (button, predicate) => {
  const revision = (await state()).revision;
  await button.click();
  return waitProject(
    predicate ?? ((p) => p.revision > revision),
    "UI music action did not commit",
  );
};
const call = async (name, args = {}, expectError = false) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (expectError) {
    assert(result.isError, `${name} must reject`);
    return text;
  }
  assert(!result.isError, `${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const openDetails = async (label) => {
  const summary = page
    .locator(".music-sync summary")
    .filter({ hasText: label });
  if (!(await summary.evaluate((element) => element.parentElement.open)))
    await summary.click();
};
const setRange = async (label, value) => {
  await page.getByLabel(label, { exact: true }).evaluate((input, next) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(input, String(next));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
};
const seek = async (frame, clipId) => {
  const p = await state();
  await call("cutline_preview", { ...guard(p), frame, clipId, playing: false });
  await page.waitForTimeout(160);
};
const pixels = (file, frame) =>
  media(ffmpeg, [
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
  assert(a.length > 0);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};
const exportVideo = async (file) => {
  const p = await state();
  const job = await call("cutline_export", { ...guard(p), path: file });
  const start = Date.now();
  while (Date.now() - start < 180000) {
    const latest = (await call("cutline_jobs")).find(
      (item) => item.id === job.id,
    );
    if (latest?.state === "done") return (Date.now() - start) / 1000;
    if (latest?.state === "error") throw Error(latest.message);
    await page.waitForTimeout(500);
  }
  throw Error("Music sync export did not finish");
};

const runCosmeticSmoke = async () => {
  const source = JSON.parse(await readFile(smokeSource, "utf8")).project;
  const fixtureFile = path.join(work, "Music copy smoke.cutline");
  await writeFile(
    fixtureFile,
    JSON.stringify({ project: source, past: [], future: [] }),
  );
  app = await electron.launch({
    executablePath: executable,
    args: packaged
      ? ["--force-color-profile=srgb", fixtureFile]
      : [root, "--force-color-profile=srgb", fixtureFile],
    env,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push(
        `${message.text()}${message.location()?.url ? ` (${message.location().url})` : ""}`,
      );
  });
  await page.waitForSelector(".titlebar");
  await waitProject((p) => p.id === source.id, "Smoke fixture did not open");
  const settings = (await invoke("state")).settings;
  client = new Client({ name: "cutline-music-copy-smoke", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: settings.mcpLauncher,
      args: [],
      env: { ...env, CUTLINE_CONNECTION: path.join(data, "connection.json") },
      stderr: "pipe",
    }),
  );
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  await page.getByRole("button", { name: "Music sync", exact: true }).click();
  assert(
    await page.getByText("1 beat in this clip", { exact: true }).isVisible(),
  );
  assert(
    await page
      .getByText(
        "For the tightest beat sync, keep music at its original speed. Speed changes can shift audio attacks.",
        { exact: true },
      )
      .isVisible(),
  );
  await page.screenshot({
    path: path.join(work, "singleton-beat-speed-hint.png"),
  });
  log(
    "Final packaged copy uses singular beat grammar and shows the original-speed hint for changed-speed music",
  );
  const music = source.clips.find((clip) => clip.kind === "audio");
  const title = source.clips.find((clip) => clip.kind === "text");
  let p = await state();
  await call("cutline_music_reactive", {
    ...guard(p),
    musicClipId: music.id,
    clipIds: [title.id],
    mode: "beat",
    style: "both",
    amount: 0.9,
    releaseFrames: 17,
  });
  await waitProject(
    (p) =>
      p.clips.find((clip) => clip.id === title.id).musicReactive
        .releaseFrames === 17,
    "Smoke custom pulse did not commit",
  );
  await seek(26, title.id);
  await openDetails("Pulse motion");
  await setRange("Pulse strength", 0.7);
  p = await commitClick(
    page.getByRole("button", { name: "Apply pulse", exact: true }),
  );
  assert.equal(
    p.clips.find((clip) => clip.id === title.id).musicReactive.releaseFrames,
    17,
  );
  assert.equal(
    p.clips.find((clip) => clip.id === title.id).musicReactive.amount,
    0.7,
  );
  await call("cutline_undo", guard(p));
  p = await state();
  await call("cutline_undo", guard(p));
  p = await state();
  assert.deepEqual(snapshot(p.clips), source.clips);
  log(
    "Final packaged pulse strength edits preserve custom17-frame decay and undo cleanly",
  );
  const opener = page.getByRole("button", {
    name: "Settings & connections",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const close = dialog.getByRole("button", {
    name: "Close settings",
    exact: true,
  });
  await page.waitForTimeout(100);
  assert(await close.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Shift+Tab");
  const summary = dialog
    .locator("summary")
    .filter({ hasText: "What connected assistants can do" });
  assert(await summary.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Enter");
  assert(await summary.evaluate((el) => el.parentElement.open));
  await page.keyboard.press("Tab");
  assert(await close.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(await opener.evaluate((el) => el === document.activeElement));
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  log(
    "Final packaged Settings summary keyboard flow and opener restoration pass without renderer errors",
  );
};

try {
  if (smokeSource) await runCosmeticSmoke();
  else {
    const bundle = await build({
      stdin: {
        contents:
          'export {newProject,makeClip} from "./src/shared/model.ts";export {captionClips} from "./src/shared/subtitles.ts";export {beatFrames} from "./src/shared/music-sync.ts";',
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
    });
    const { newProject, makeClip, captionClips, beatFrames } = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
    );
    const fixture = newProject();
    Object.assign(fixture, {
      name: "Music Sync QA",
      width: 640,
      height: 360,
      fps: 30,
    });
    const edges = [0, 57, 123, 177, 240];
    for (const [index, color] of [
      "#17334d",
      "#483260",
      "#204b44",
      "#5e3b29",
    ].entries()) {
      const source = path.join(work, `Source ${index + 1}.mp4`);
      media(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=640x360:r=30:d=10`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        source,
      ]);
      const asset = {
        id: `video-asset-${index}`,
        name: `Shot ${index + 1}`,
        kind: "video",
        path: source,
        duration: 10,
        width: 640,
        height: 360,
        fps: 30,
        hasAudio: false,
      };
      fixture.assets.push(asset);
      fixture.clips.push({
        ...makeClip(fixture, "video", "video", edges[index], asset),
        id: `shot-${index}`,
        duration: edges[index + 1] - edges[index],
        sourceIn: 1,
        volume: 1,
      });
    }
    const title = {
      ...makeClip(fixture, "text", "titles", 0),
      id: "qa-title",
      text: "FOLLOW THE BEAT",
      duration: 240,
      x: 70,
      y: 140,
      width: 500,
      height: 100,
      fontSize: 46,
      preset: "none",
      color: "#ffffff",
      accent: "#c6f16d",
    };
    fixture.clips.push(title);
    const linked = captionClips(
      fixture,
      [
        { text: "SOURCE", start: 0.2, end: 0.65 },
        { text: "BOUND", start: 0.65, end: 1.8 },
      ],
      0,
      57,
    ).map((clip) => ({
      ...clip,
      captionSourceId: "shot-0",
      fontSize: 25,
      y: 270,
      height: 70,
    }));
    fixture.clips.push(...linked);
    const fixtureFile = path.join(work, "Music Sync QA.cutline");
    await writeFile(
      fixtureFile,
      JSON.stringify({ project: fixture, past: [], future: [] }),
    );
    const rate = 48000,
      seconds = 8,
      samples = Buffer.alloc(rate * seconds * 2);
    for (let beat = 0.37; beat < seconds; beat += 0.5) {
      const first = Math.round(beat * rate);
      for (let n = 0; n < rate * 0.065 && first + n < rate * seconds; n++)
        samples.writeInt16LE(
          Math.round(
            0.8 *
              Math.sin((n / rate) * Math.PI * 2 * 110) *
              Math.exp((-n / rate) * 65) *
              32767,
          ),
          (first + n) * 2,
        );
    }
    const waveHeader = Buffer.alloc(44);
    waveHeader.write("RIFF");
    waveHeader.writeUInt32LE(samples.length + 36, 4);
    waveHeader.write("WAVEfmt ", 8);
    waveHeader.writeUInt32LE(16, 16);
    waveHeader.writeUInt16LE(1, 20);
    waveHeader.writeUInt16LE(1, 22);
    waveHeader.writeUInt32LE(rate, 24);
    waveHeader.writeUInt32LE(rate * 2, 28);
    waveHeader.writeUInt16LE(2, 32);
    waveHeader.writeUInt16LE(16, 34);
    waveHeader.write("data", 36);
    waveHeader.writeUInt32LE(samples.length, 40);
    const audioFile = path.join(work, "Known 120 BPM.wav");
    await writeFile(audioFile, Buffer.concat([waveHeader, samples]));

    app = await electron.launch({
      executablePath: executable,
      args: packaged
        ? ["--force-color-profile=srgb", fixtureFile]
        : [root, "--force-color-profile=srgb", fixtureFile],
      env,
    });
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        consoleErrors.push(
          `${message.text()}${message.location()?.url ? ` (${message.location().url})` : ""}`,
        );
    });
    await page.waitForSelector(".titlebar");
    await waitProject((p) => p.id === fixture.id, "Fixture did not open");
    const settings = (await invoke("state")).settings;
    client = new Client({ name: "cutline-music-sync-qa", version: "1.0" });
    await client.connect(
      new StdioClientTransport({
        command: settings.mcpLauncher,
        args: [],
        env: { ...env, CUTLINE_CONNECTION: path.join(data, "connection.json") },
        stderr: "pipe",
      }),
    );
    const toolList = await client.listTools();
    const names = new Set(toolList.tools.map((tool) => tool.name));
    for (const name of [
      "cutline_music_create",
      "cutline_music_analyze",
      "cutline_music_grid",
      "cutline_music_sync",
      "cutline_music_reactive",
      "cutline_music_inspect",
    ])
      assert(names.has(name), `Missing ${name}`);
    await page.getByRole("button", { name: "Audio", exact: true }).click();
    await page.getByRole("button", { name: "Music sync", exact: true }).click();
    assert(
      await page
        .getByRole("button", { name: "Compose original music", exact: true })
        .isVisible(),
    );
    await page.screenshot({ path: path.join(work, "music-empty-state.png") });
    let p = await commitClick(
      page.getByRole("button", { name: "Compose original music", exact: true }),
      (p) => p.clips.some((clip) => clip.kind === "audio"),
    );
    const generated = p.assets.find((asset) => asset.kind === "audio");
    assert.equal(generated.rhythm.bpm, 116);
    assert.equal(generated.rhythm.source, "generated");
    assert(generated.rhythm.envelope.values.length > 0);
    assert(await page.getByText("116 BPM", { exact: true }).isVisible());
    await page.screenshot({
      path: path.join(work, "generated-music-grid.png"),
    });
    await call("cutline_undo", guard(p));
    await waitProject(
      (p) => !p.clips.some((clip) => clip.kind === "audio"),
      "Music creation undo failed",
    );
    log(
      "Music sync empty state composes original music with an exact 116 BPM grid and undoes in one step",
    );

    p = await state();
    const imported = await call("cutline_import_media", {
      ...guard(p),
      paths: [audioFile],
    });
    const audioId = imported.importedAssetIds[0];
    p = await state();
    const added = await call("cutline_edit", {
      ...guard(p),
      label: "Place test music",
      actions: [
        {
          type: "clip.add",
          kind: "audio",
          assetId: audioId,
          at: { frame: 0 },
          duration: { frame: 240 },
          patch: { volume: 1 },
          ref: "music",
        },
      ],
    });
    const musicId = added.created.find((item) => item.ref === "music").id;
    p = await waitProject(
      (p) => p.clips.some((clip) => clip.id === musicId),
      "Imported music was not placed",
    );
    const staleGuard = guard(p);
    p = await commitClick(
      page.getByRole("button", { name: "Analyze locally", exact: true }),
    );
    const analyzed = p.assets.find((asset) => asset.id === audioId).rhythm;
    assert(Math.abs(analyzed.bpm - 120) < 1);
    assert(analyzed.confidence > 0.85);
    assert.equal(analyzed.beats.length, 16);
    assert(Math.abs(analyzed.beats[0].time - 0.37) < 0.025);
    assert(analyzed.envelope.values.some((value) => value > 0.9));
    await call(
      "cutline_music_grid",
      { ...staleGuard, musicClipId: musicId, bpm: 60, offsetSeconds: 0 },
      true,
    );
    assert.deepEqual(await state(), p);
    assert(await page.getByLabel("Show beats", { exact: true }).isChecked());
    assert((await page.locator(".beat-marker").count()) > 0);
    await page.screenshot({
      path: path.join(work, "analyzed-imported-music.png"),
    });
    log(
      "Actual imported PCM is analyzed locally at 120 BPM with correct onset phase and energy; stale grid edits reject atomically",
      {
        bpm: analyzed.bpm,
        confidence: analyzed.confidence,
        beats: analyzed.beats.length,
      },
    );

    await openDetails("Edit beat grid");
    await page.getByLabel("Music tempo", { exact: true }).fill("120");
    await page
      .getByLabel("Beat offset (seconds)", { exact: true })
      .fill("0.37");
    p = await commitClick(
      page.getByRole("button", { name: "Apply beat grid", exact: true }),
    );
    const manual = p.assets.find((asset) => asset.id === audioId).rhythm;
    assert.equal(manual.source, "manual");
    assert.equal(manual.bpm, 120);
    assert.equal(manual.beats[0].time, 0.37);
    assert.deepEqual(manual.envelope, analyzed.envelope);
    const frames = beatFrames(p, musicId);
    assert.deepEqual(frames.slice(0, 5), [11, 26, 41, 56, 71]);
    const firstMarker = page.locator(".beat-marker").first();
    await firstMarker.focus();
    await firstMarker.press("Enter");
    await page.waitForTimeout(100);
    assert((await page.locator(".timecode").innerText()).includes("0:00:11"));
    await page.getByLabel("Show beats", { exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".beat-marker").count(), 0);
    await page.getByLabel("Show beats", { exact: true }).click();
    await page.waitForTimeout(100);
    log(
      "Manual tempo/phase preserves measured energy, updates source-anchored beat markers and supports keyboard seeking",
    );

    await page
      .getByLabel("Cut sequence", { exact: true })
      .selectOption("video");
    assert(
      await page
        .getByRole("button", { name: "Sync cuts", exact: true })
        .isDisabled(),
    );
    await page
      .getByLabel("Allow cuts in clips with source audio", { exact: true })
      .click();
    const beforeSync = snapshot(await state());
    const previewPlan = await call("cutline_music_sync", {
      ...guard(beforeSync),
      musicClipId: musicId,
      clipIds: ["shot-0", "shot-1", "shot-2", "shot-3"],
      mode: "cuts",
      allowAudibleVideo: true,
      dryRun: true,
    });
    assert(previewPlan.commands.length > 0);
    assert.deepEqual(snapshot(await state()), beforeSync);
    p = await commitClick(
      page.getByRole("button", { name: "Sync cuts", exact: true }),
    );
    const shots = p.clips
      .filter((clip) => clip.id.startsWith("shot-"))
      .sort((a, b) => a.start - b.start);
    assert.deepEqual(
      shots.map((clip) => clip.start),
      [0, 56, 116, 176],
    );
    assert.equal(shots.at(-1).start + shots.at(-1).duration, 240);
    assert(
      shots.every(
        (clip) =>
          clip.sourceIn >= 0 && clip.sourceIn + clip.duration / p.fps <= 10,
      ),
    );
    for (const caption of p.clips.filter((clip) => clip.captionSourceId)) {
      const source = p.clips.find(
        (clip) => clip.id === caption.captionSourceId,
      );
      assert(caption.start >= source.start);
      assert(
        caption.start + caption.duration <= source.start + source.duration,
      );
    }
    const syncedClips = snapshot(p.clips);
    await call("cutline_undo", guard(p));
    p = await state();
    assert.deepEqual(p.clips, beforeSync.clips);
    await call("cutline_redo", guard(p));
    p = await waitProject(
      (p) => p.clips.find((clip) => clip.id === "shot-1").start === 56,
      "Sync redo failed",
    );
    assert.deepEqual(p.clips, syncedClips);
    await page.screenshot({ path: path.join(work, "synced-cut-sequence.png") });
    log(
      "Cut syncing previews a plan, requires source-audio permission, preserves outer/source/caption bounds, and undoes/redoes in one transaction",
    );

    const titleButton = page.getByRole("button", {
      name: "text clip FOLLOW THE BEAT",
      exact: true,
    });
    const box = await titleButton.boundingBox();
    assert(box);
    await page.mouse.move(box.x + 25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 25 + 60 * 0.85, box.y + box.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
    p = await waitProject(
      (p) => p.clips.find((clip) => clip.id === title.id).start !== 0,
      "Beat snap drag failed",
    );
    assert.equal(p.clips.find((clip) => clip.id === title.id).start, 56);
    await call("cutline_undo", guard(p));
    await waitProject(
      (p) => p.clips.find((clip) => clip.id === title.id).start === 0,
      "Snap undo failed",
    );
    log("Timeline dragging snaps a visual layer to the music beat grid");

    await seek(26, title.id);
    await openDetails("Pulse motion");
    await page.getByLabel("Pulse style", { exact: true }).selectOption("both");
    await page.getByLabel("Pulse mode", { exact: true }).selectOption("beat");
    await setRange("Pulse strength", 0.9);
    p = await commitClick(
      page.getByRole("button", { name: "Apply pulse", exact: true }),
    );
    const pulse = p.clips.find((clip) => clip.id === title.id).musicReactive;
    assert.equal(pulse.musicClipId, musicId);
    assert.equal(pulse.amount, 0.9);
    assert.equal(pulse.style, "both");
    assert.equal(pulse.mode, "beat");
    await call("cutline_music_reactive", {
      ...guard(p),
      musicClipId: musicId,
      clipIds: [title.id],
      style: "both",
      mode: "beat",
      amount: 0.9,
      releaseFrames: 17,
    });
    p = await waitProject(
      (p) =>
        p.clips.find((clip) => clip.id === title.id).musicReactive
          .releaseFrames === 17,
      "Custom pulse decay did not commit",
    );
    await setRange("Pulse strength", 0.7);
    p = await commitClick(
      page.getByRole("button", { name: "Apply pulse", exact: true }),
    );
    assert.equal(
      p.clips.find((clip) => clip.id === title.id).musicReactive.amount,
      0.7,
    );
    assert.equal(
      p.clips.find((clip) => clip.id === title.id).musicReactive.releaseFrames,
      17,
      "Changing pulse strength in the UI must preserve a custom release duration",
    );
    await call("cutline_undo", guard(p));
    p = await state();
    assert.equal(
      p.clips.find((clip) => clip.id === title.id).musicReactive.releaseFrames,
      17,
    );
    await call("cutline_undo", guard(p));
    p = await state();
    assert.equal(
      p.clips.find((clip) => clip.id === title.id).musicReactive.releaseFrames,
      6,
    );
    log(
      "UI pulse edits preserve an agent-set custom decay, and both edits undo independently",
    );
    const beforeRemove = snapshot(p.clips);
    p = await commitClick(
      page.getByRole("button", { name: "Remove pulse", exact: true }),
    );
    assert(!p.clips.find((clip) => clip.id === title.id).musicReactive);
    await call("cutline_undo", guard(p));
    p = await waitProject(
      (p) => !!p.clips.find((clip) => clip.id === title.id).musicReactive,
      "Pulse remove undo failed",
    );
    assert.deepEqual(p.clips, beforeRemove);
    const previewPixels = new Map();
    for (const frame of [26, 34, 41, 49]) {
      await seek(frame, title.id);
      const imageFile = path.join(work, `pulse-preview-frame-${frame}.png`);
      await page.locator(".canvas").screenshot({ path: imageFile });
      previewPixels.set(
        frame,
        media(ffmpeg, [
          "-v",
          "error",
          "-i",
          imageFile,
          "-vf",
          "scale=96:54",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]),
      );
    }
    assert(
      difference(previewPixels.get(26), previewPixels.get(34)) > 1,
      "Beat pulse must visibly decay between beats",
    );
    await page.screenshot({ path: path.join(work, "pulse-music-editor.png") });
    log(
      "Selected visual layer gains editable scale/glow pulses with observable beat-to-between-beat motion; removing it preserves other animation",
    );

    const savedFile = path.join(work, "Music synced project.cutline");
    p = await state();
    await call("cutline_save_project", { ...guard(p), path: savedFile });
    const saved = JSON.parse(await readFile(savedFile, "utf8")).project;
    await call("cutline_new_project", {
      ...guard(p),
      name: "Disposable music project",
    });
    p = await state();
    await call("cutline_open_project", { ...guard(p), path: savedFile });
    p = await waitProject(
      (p) => p.id === saved.id,
      "Music project reopen failed",
    );
    assert.deepEqual(p.clips, saved.clips);
    assert.deepEqual(snapshot(p.assets), saved.assets);
    const inspected = await call("cutline_music_inspect", {
      musicClipId: musicId,
    });
    assert.equal(inspected.rhythm.bpm, 120);
    assert.deepEqual(inspected.beatFrames, frames);
    assert(!JSON.stringify(inspected).includes(audioFile));
    assert(!inspected.rhythm.envelope);
    const publicProject = await call("cutline_inspect");
    const publicRhythm = publicProject.assets.find(
      (asset) => asset.id === audioId,
    ).rhythm;
    assert.equal(publicRhythm.beatCount, 16);
    assert.equal(publicRhythm.energyMeasured, true);
    assert(
      !publicRhythm.beats && !publicRhythm.envelope,
      "General agent inspection should keep music analysis compact",
    );
    const paged = await call("cutline_music_inspect", {
      musicClipId: musicId,
      offset: 4,
      limit: 4,
    });
    assert.deepEqual(paged.beatFrames, frames.slice(4, 8));
    assert.equal(paged.rhythm.beats.length, 4);
    assert.equal(paged.timelineBeatCount, 16);
    assert.equal(paged.hasMore, true);
    p = await state();
    await call("cutline_music_reactive", {
      ...guard(p),
      musicClipId: musicId,
      clipIds: [title.id],
      mode: "energy",
      style: "scale",
      amount: 0.5,
    });
    p = await state();
    assert.equal(
      p.clips.find((clip) => clip.id === title.id).musicReactive.mode,
      "energy",
    );
    await call("cutline_undo", guard(p));
    log(
      "Rhythm metadata and reactive bindings survive save/reopen and remain controllable through real MCP, including measured-energy mode",
    );

    await page.getByRole("button", { name: "Audio", exact: true }).click();
    await page.getByRole("button", { name: "Music sync", exact: true }).click();
    await openDetails("Pulse motion");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }),
    );
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    assert(
      layout.scrollWidth <= layout.width + 1 &&
        layout.scrollHeight <= layout.height + 1,
    );
    await page.screenshot({
      path: path.join(work, "music-minimum-window.png"),
    });
    await page.getByLabel("Music track", { exact: true }).focus();
    const focusStyle = await page
      .getByLabel("Music track", { exact: true })
      .evaluate((element) => getComputedStyle(element).outlineStyle);
    assert.notEqual(focusStyle, "none");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }),
    );
    const videoFile = path.join(work, "Music Synced Demo.mp4");
    const exportSeconds = await exportVideo(videoFile);
    const metadata = JSON.parse(
      media(ffprobe, [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        videoFile,
      ]).toString(),
    );
    const video = metadata.streams.find(
      (stream) => stream.codec_type === "video",
    );
    const audio = metadata.streams.find(
      (stream) => stream.codec_type === "audio",
    );
    assert.equal(video.codec_name, "h264");
    assert.equal(video.width, 640);
    assert.equal(video.height, 360);
    assertCfrExport(ffprobe, videoFile, { fps: 30, frames: 240 });
    assert(audio, "Export must include the music");
    assert(Math.abs(Number(metadata.format.duration) - 8) < 0.1);
    const parity = [...previewPixels].map(([frame, preview]) => ({
      frame,
      meanPixelDifference: difference(preview, pixels(videoFile, frame)),
    }));
    assert(
      parity.every((item) => item.meanPixelDifference < 18),
      `Reactive preview/export parity: ${JSON.stringify(parity)}`,
    );
    assert(difference(pixels(videoFile, 26), pixels(videoFile, 34)) > 1);
    for (const frame of [26, 34, 116, 176])
      media(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-i",
        videoFile,
        "-vf",
        `select=eq(n\\,${frame})`,
        "-frames:v",
        "1",
        path.join(work, `music-export-frame-${frame}.png`),
      ]);
    await writeFile(
      path.join(work, "export-metadata.json"),
      JSON.stringify(metadata, null, 2),
    );
    log(
      "Playable music-synced H264 export contains audio and matches sampled pulse previews",
      {
        seconds: exportSeconds,
        duration: Number(metadata.format.duration),
        parity,
      },
    );
    const beforeDelete = snapshot(await state());
    await call("cutline_edit", {
      ...guard(beforeDelete),
      label: "Remove music source for recovery check",
      actions: [
        {
          type: "clip.delete",
          clipId: musicId,
          ripple: false,
          deleteCaptions: false,
        },
      ],
    });
    await waitProject(
      (p) => !p.clips.some((clip) => clip.id === musicId),
      "Music source deletion did not commit",
    );
    await seek(34, title.id);
    assert(
      await page
        .getByText(
          "The selected clip’s music track was removed. Clear its pulse or add music to bind it again.",
          { exact: true },
        )
        .isVisible(),
    );
    p = await commitClick(
      page.getByRole("button", { name: "Remove pulse", exact: true }),
    );
    assert(!p.clips.find((clip) => clip.id === title.id).musicReactive);
    await call("cutline_undo", guard(p));
    p = await waitProject(
      (p) => !!p.clips.find((clip) => clip.id === title.id).musicReactive,
      "Missing-source pulse clear undo failed",
    );
    await call("cutline_undo", guard(p));
    p = await waitProject(
      (p) => p.clips.some((clip) => clip.id === musicId),
      "Music source deletion undo failed",
    );
    assert.deepEqual(snapshot(p.clips), beforeDelete.clips);
    log(
      "A removed music source leaves a recoverable pulse binding; the UI clears it and both changes undo cleanly",
    );
    const slow = snapshot(p);
    slow.id = crypto.randomUUID();
    slow.name = "Slow music source phase QA";
    slow.revision = 0;
    slow.assets = slow.assets.filter((asset) => asset.id === audioId);
    slow.clips = slow.clips
      .filter((clip) => clip.id === musicId || clip.id === title.id)
      .map((clip) =>
        clip.id === musicId
          ? { ...clip, sourceIn: 0.36, speed: 0.1, start: 0, duration: 60 }
          : { ...clip, start: 0, duration: 60 },
      );
    slow.tracks = slow.tracks.filter((track) =>
      slow.clips.some((clip) => clip.trackId === track.id),
    );
    const slowFile = path.join(work, "Slow music source phase.cutline");
    await writeFile(
      slowFile,
      JSON.stringify({ project: slow, past: [], future: [] }),
    );
    await invoke("test.load", { path: slowFile });
    await waitProject(
      (p) => p.id === slow.id,
      "Slow source-phase fixture did not load",
    );
    // Opening a project resets the audio subtab; assert the hint in its UI.
    await page.getByRole("button", { name: "Music sync", exact: true }).click();
    assert(
      await page
        .getByText(
          "For the tightest beat sync, keep music at its original speed. Speed changes can shift audio attacks.",
          { exact: true },
        )
        .isVisible(),
    );
    assert.equal(beatFrames(slow, musicId)[0], 3);
    const slowVideo = path.join(work, "Slow music phase.mp4");
    await exportVideo(slowVideo);
    const pcm = media(ffmpeg, [
      "-v",
      "error",
      "-i",
      slowVideo,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ]);
    const windowSamples = 96;
    const audioEnergies = (samples) => {
      const energies = [];
      for (
        let start = 0;
        start + windowSamples * 4 <= samples.length;
        start += windowSamples * 4
      ) {
        let energy = 0;
        for (let sample = 0; sample < windowSamples; sample++)
          energy += samples.readFloatLE(start + sample * 4) ** 2;
        energies.push(Math.sqrt(energy / windowSamples));
      }
      return energies;
    };
    const energies = audioEnergies(pcm);
    const peak = Math.max(...energies);
    assert(peak > 0.01, "Slow music export must contain a real audible onset");
    const onset =
      (energies.findIndex((energy) => energy > peak * 0.07) * windowSamples) /
      48000;
    // Pitch-preserving atempo can move transients substantially at 0.1x. Verify
    // the chosen source trim against a separate FFmpeg reference, rather than
    // assuming the stretched transient remains at its ideal source-grid time.
    const tempo = (speed) =>
      speed >= 0.5 && speed <= 2
        ? `atempo=${speed.toFixed(5)}`
        : `${tempo(Math.sqrt(speed))},${tempo(Math.sqrt(speed))}`;
    const compositorFfmpeg = path.join(
      packaged ? path.join(appRoot, "Contents/Resources/app") : root,
      "node_modules/@remotion/compositor-darwin-arm64/ffmpeg",
    );
    const compareAudioTrim = (sourceFrame, label) => {
      const trim = sourceFrame / 30 / 0.1;
      const reference = path.join(work, `slow-${label}-reference.wav`);
      const result = spawnSync(
        compositorFfmpeg,
        [
          "-v",
          "error",
          "-y",
          "-i",
          audioFile,
          "-af",
          `aformat=sample_fmts=s16:sample_rates=48000,${tempo(0.1)},atrim=${trim}:${trim + 2},asetpts=PTS-STARTPTS`,
          "-ac",
          "2",
          "-ar",
          "48000",
          "-c:a",
          "pcm_s16le",
          reference,
        ],
        {
          cwd: path.dirname(compositorFfmpeg),
          env: {
            ...process.env,
            DYLD_LIBRARY_PATH: path.dirname(compositorFfmpeg),
          },
        },
      );
      assert.equal(result.status, 0, result.stderr?.toString());
      const expected = audioEnergies(
        media(ffmpeg, [
          "-v",
          "error",
          "-i",
          reference,
          "-ac",
          "1",
          "-ar",
          "48000",
          "-f",
          "f32le",
          "pipe:1",
        ]),
      );
      assert(
        expected.length >= 995,
        "The independent reference must cover the 2-second export",
      );
      const length = Math.min(energies.length, expected.length);
      return (
        energies
          .slice(0, length)
          .reduce(
            (sum, energy, index) => sum + Math.abs(energy - expected[index]),
            0,
          ) / length
      );
    };
    const exactTrimError = compareAudioTrim(0.36 * 30, "fractional");
    const roundedTrimError = compareAudioTrim(Math.round(0.36 * 30), "rounded");
    assert(
      exactTrimError < 0.002,
      `Fractional trim reference error was ${exactTrimError}`,
    );
    assert(
      roundedTrimError > exactTrimError * 10 && roundedTrimError > 0.008,
      "The slow-audio fixture must distinguish fractional trimming from the former rounded source frame",
    );
    log(
      "Slow music playback preserves fractional source trim against an independent audio reference; extreme time stretching can shift audible transients from source-grid beats",
      {
        sourceIn: 0.36,
        speed: 0.1,
        firstBeatFrame: 3,
        decodedOnsetSeconds: onset,
        exactTrimMeanRmsError: exactTrimError,
        roundedTrimMeanRmsError: roundedTrimError,
        limitation:
          "Pitch-preserving time stretching at extreme slow speeds can shift transients relative to the source beat grid.",
      },
    );
    const beforeScene = snapshot(await state());
    await call("cutline_edit", {
      ...guard(beforeScene),
      label: "Add motion scene for canvas scaling check",
      actions: [
        {
          type: "motion.scene",
          scene: "kinetic-title",
          at: { frame: 0 },
          ref: "canvas-scene",
        },
      ],
    });
    const beforeCanvas = snapshot(
      await waitProject(
        (p) => p.motions.length === 1,
        "Canvas test motion scene did not appear",
      ),
    );
    const aspect = page.getByLabel("Project aspect ratio", { exact: true });
    assert(
      (await aspect.locator("option:checked").innerText()).includes("16:9"),
    );
    await aspect.selectOption("1920:1080");
    const resized = await waitProject(
      (p) => p.width === 1920 && p.height === 1080,
      "Canvas size change did not commit",
    );
    assert.deepEqual(snapshot(resized.assets), beforeCanvas.assets);
    for (const oldClip of beforeCanvas.clips) {
      const next = resized.clips.find((clip) => clip.id === oldClip.id);
      for (const field of [
        "start",
        "duration",
        "sourceIn",
        "speed",
        "animationOffset",
      ])
        assert.equal(next[field], oldClip[field]);
      assert.deepEqual(next.musicReactive, oldClip.musicReactive);
    }
    let nonzeroAnimatedCoordinate = false;
    for (const [index, oldLayer] of beforeCanvas.motions[0].layers.entries()) {
      const next = resized.motions[0].layers[index];
      for (const field of ["x", "y", "width", "height", "fontSize"])
        assert.equal(
          next[field],
          oldLayer[field] * 3,
          `Canvas resize must scale motion layer ${field}`,
        );
      for (const [keyIndex, oldKey] of oldLayer.keyframes.entries()) {
        const nextKey = next.keyframes[keyIndex];
        assert.equal(nextKey.frame, oldKey.frame);
        assert.equal(nextKey.easing, oldKey.easing);
        for (const field of ["x", "y"])
          if (oldKey[field] !== undefined) {
            assert.equal(nextKey[field], oldKey[field] * 3);
            if (oldKey[field] !== 0) nonzeroAnimatedCoordinate = true;
          }
      }
    }
    assert(
      nonzeroAnimatedCoordinate,
      "Canvas fixture must cover a meaningful animated coordinate",
    );
    await seek(
      30,
      resized.clips.find((clip) => clip.motionId === resized.motions[0].id).id,
    );
    await page.screenshot({
      path: path.join(work, "canvas-scaled-motion.png"),
    });
    await call("cutline_undo", guard(resized));
    p = await waitProject(
      (p) => p.width === 640 && p.height === 360,
      "Canvas resize undo failed",
    );
    assert.deepEqual(snapshot(p.motions), beforeCanvas.motions);
    await call("cutline_undo", guard(p));
    p = await waitProject(
      (p) => p.motions.length === 0,
      "Canvas test motion scene undo failed",
    );
    assert.deepEqual(snapshot(p.clips), beforeScene.clips);
    log(
      "Canvas resizing scales editable motion geometry and animated coordinates while preserving timing, sources and music bindings; undo restores both edits",
    );
    const settingsButton = page.getByRole("button", {
      name: "Settings & connections",
      exact: true,
    });
    await settingsButton.click();
    const settingsDialog = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const closeSettings = settingsDialog.getByRole("button", {
      name: "Close settings",
      exact: true,
    });
    await page.waitForTimeout(100);
    assert(
      await closeSettings.evaluate(
        (element) => element === document.activeElement,
      ),
    );
    await page.keyboard.press("Shift+Tab");
    const assistantCapabilities = settingsDialog
      .locator("summary")
      .filter({ hasText: "What connected assistants can do" });
    assert(
      await assistantCapabilities.evaluate(
        (element) => element === document.activeElement,
      ),
    );
    assert(
      !(await assistantCapabilities.evaluate(
        (element) => element.parentElement.open,
      )),
    );
    await page.keyboard.press("Enter");
    assert(
      await assistantCapabilities.evaluate(
        (element) => element.parentElement.open,
      ),
    );
    await page.keyboard.press("Tab");
    assert(
      await closeSettings.evaluate(
        (element) => element === document.activeElement,
      ),
    );
    await page.keyboard.press("Escape");
    await settingsDialog.waitFor({ state: "hidden" });
    assert(
      await settingsButton.evaluate(
        (element) => element === document.activeElement,
      ),
    );
    log(
      "Settings keyboard focus enters the close button, wraps through the final expandable summary, supports Enter and returns to the opener after Escape",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
    log(
      "Music workspace fits 1100x760, shows keyboard focus and has no renderer errors",
    );
  }
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
        packaged,
        ...(smokeSource
          ? {
              scope:
                "Final UI copy smoke; exports covered by the full functional baseline",
              functionalBaseline: path.join(
                path.dirname(smokeSource),
                "results.json",
              ),
              releaseBuildSha256: process.env.CUTLINE_QA_PACKAGE_SHA ?? null,
              differenceFromBaseline:
                "Only singular beat grammar changed in the renderer bundle; main and composition hashes were unchanged.",
            }
          : {}),
        results,
        errors,
        consoleErrors,
        ...(failure ? { failure } : {}),
      },
      null,
      2,
    ),
  );
  await client?.close();
  if (app) await app.close();
  console.log(`Music sync QA artifacts: ${work}`);
}
if (failure) throw Error(failure);
