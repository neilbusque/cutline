import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  parentWork = path.resolve(root, "../../work");
await mkdir(parentWork, { recursive: true });
const work = await mkdtemp(path.join(parentWork, "audio-qa-"));
const model = await build({
  entryPoints: ["src/shared/model.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { newProject } = await import(
  `data:text/javascript;base64,${Buffer.from(model.outputFiles[0].text).toString("base64")}`
);
const projectFile = path.join(work, "audio.cutline"),
  project = newProject();
project.name = "Cutline · Voice Studio";
await writeFile(
  projectFile,
  JSON.stringify({ project, past: [], future: [], filePath: projectFile }),
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
  CUTLINE_SESSION_ROOT: path.join(work, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CUTLINE_SESSION_ID;
const offline = process.env.CUTLINE_QA_OFFLINE === "1";
const offlineLog = path.join(work, "offline.jsonl");
if (offline) {
  env.CUTLINE_OFFLINE_LOG = offlineLog;
}
const app = await electron.launch({
  executablePath,
  args: packaged ? [projectFile] : [root, projectFile],
  env,
});
const results = [],
  errors = [];
const record = (value) => {
  results.push(value);
  console.log(value);
};
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
let page;
try {
  if (offline) {
    // Packaged Electron ignores NODE_OPTIONS. Install the guard in main and
    // explicitly preload it in the isolated child; its worker inherits it.
    await app.evaluate(
      (_electron, guard) => {
        const { createRequire } = process.getBuiltinModule("module");
        const require = createRequire(process.execPath);
        require(guard);
        const childProcess = require("node:child_process");
        const fork = childProcess.fork;
        childProcess.fork = (module, args, options) =>
          fork(module, args, {
            ...options,
            execArgv: module.endsWith("tts-worker.cjs")
              ? ["--require", guard]
              : options?.execArgv,
          });
      },
      path.join(root, "scripts/qa-offline.cjs"),
    );
  }
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".titlebar", { timeout: 120000 });
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = () => invoke("state");
  const getProject = async () => (await state()).snapshot.project;
  assert((await invoke("tts.status")).ready, "Bundled Kokoro model missing");
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  const panel = page.locator(".audio-library");
  assert.equal(
    await panel
      .getByRole("button", { name: "Text to speech", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await panel
    .getByText(/Voices run on this Mac/)
    .first()
    .waitFor();
  await panel
    .getByLabel("Voiceover script")
    .fill(
      "A better morning starts with freshly roasted coffee. Grind the beans just before brewing. Then take your cup outside and enjoy a quiet ocean view. Small routines can change the way your day feels.",
    );
  await page.screenshot({ path: path.join(work, "text-to-speech-1440.png") });
  // Parent cancellation must stop child inference and leave no imported asset.
  await page.evaluate(() => {
    window.__audioQA = window.cutline
      .invoke("tts.generate", {
        text: "This is a cancellation test. ".repeat(15),
        voice: "af_heart",
        speed: 1.08,
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error: error.message }),
      );
  });
  let pending;
  for (let i = 0; i < 100; i++) {
    pending = (await state()).jobs.find(
      (j) => j.kind === "voiceover" && j.state === "running",
    );
    if (pending) break;
    await page.waitForTimeout(50);
  }
  assert(pending);
  if (packaged || process.env.CUTLINE_QA_ACTIVE_CANCEL === "1") {
    // Exercise cancellation after inference has started, not just the queued job.
    let speaking = false;
    for (let i = 0; i < 600; i++) {
      speaking = (await state()).jobs.some(
        (job) =>
          job.kind === "tts" &&
          job.state === "running" &&
          job.message.startsWith("Speaking passage"),
      );
      if (speaking) break;
      await page.waitForTimeout(100);
    }
    assert(speaking, "Kokoro did not enter synthesis");
    await page.waitForTimeout(500);
  }
  const cancelStarted = Date.now();
  await invoke("job.cancel", { id: pending.id });
  const cancelled = await page.evaluate(() => window.__audioQA);
  if (packaged || process.env.CUTLINE_QA_ACTIVE_CANCEL === "1")
    record(
      `In-flight voice cancellation completes in ${((Date.now() - cancelStarted) / 1000).toFixed(2)}s`,
    );
  assert(/cancel/i.test(cancelled.error), JSON.stringify(cancelled));
  assert.equal((await getProject()).assets.length, 0);
  record("Cancel stops local synthesis and leaves the project untouched");
  const wavs = [];
  for (const voice of ["af_heart", "am_michael"]) {
    await panel.getByLabel("Narration voice").selectOption(voice);
    const previous = (await getProject()).assets.length,
      start = Date.now();
    await panel
      .getByRole("button", { name: "Generate voiceover", exact: true })
      .click();
    await page.waitForFunction(
      (count) =>
        Boolean(document.querySelector(".audio-error")?.textContent) ||
        (document.querySelectorAll(".audio-result").length > 0 &&
          document.querySelector(".audio-generate")?.textContent ===
            "Generate voiceover"),
      previous,
      { timeout: 180000 },
    );
    const problem = await panel.evaluate(
      (element) => element.querySelector(".audio-error")?.textContent,
    );
    if (problem) throw Error(problem);
    let p = await getProject();
    // Result of a previous voice may remain visible while a new request runs.
    for (let i = 0; i < 300 && p.assets.length <= previous; i++) {
      await page.waitForTimeout(100);
      p = await getProject();
    }
    assert.equal(p.assets.length, previous + 1);
    const asset = p.assets.at(-1),
      bytes = await readFile(asset.path);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.readUInt32LE(24), 24000);
    const samples = Array.from(
      { length: (bytes.length - 44) / 2 },
      (_, i) => bytes.readInt16LE(44 + i * 2) / 32768,
    );
    const rms = Math.sqrt(
      samples.reduce((sum, v) => sum + v * v, 0) / samples.length,
    );
    assert(rms > 0.005, `Speech is silent: ${rms}`);
    assert(asset.duration > 2 && asset.duration < 30);
    const saved = path.join(work, `${voice}.wav`);
    await copyFile(asset.path, saved);
    wavs.push({
      voice,
      asset,
      samples,
      rms,
      seconds: (Date.now() - start) / 1000,
    });
    record(
      `${voice} produces ${asset.duration.toFixed(2)}s of audible local speech in ${wavs.at(-1).seconds.toFixed(1)}s`,
    );
  }
  assert.notDeepEqual(
    wavs[0].samples.slice(0, 24000),
    wavs[1].samples.slice(0, 24000),
  );
  record("Heart and Michael produce distinct voice waveforms");
  const script = await panel.getByLabel("Voiceover script").inputValue();
  await panel
    .getByLabel("Voiceover script")
    .fill(`${script} One more sentence.`);
  assert(
    await panel
      .getByRole("button", { name: "Add to timeline", exact: true })
      .isDisabled(),
  );
  await panel.getByLabel("Voiceover script").fill(script);
  assert(
    await panel
      .getByRole("button", { name: "Add to timeline", exact: true })
      .isEnabled(),
  );
  record(
    "Editing the script marks the previous take and prevents adding it as the new version",
  );
  if (packaged) {
    const before = (await getProject()).assets.length;
    await page.evaluate(() => {
      window.__audioQA = window.cutline
        .invoke("tts.generate", {
          text: "This is another cancellation test. ".repeat(15),
          voice: "af_heart",
          speed: 1.08,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error: error.message }),
        );
    });
    let voiceover,
      speaking = false;
    for (let i = 0; i < 600; i++) {
      const current = (await state()).jobs;
      voiceover = current.find(
        (job) => job.kind === "voiceover" && job.state === "running",
      );
      speaking = current.some(
        (job) =>
          job.kind === "tts" &&
          job.state === "running" &&
          job.message.startsWith("Speaking passage"),
      );
      if (voiceover && speaking) break;
      await page.waitForTimeout(100);
    }
    assert(voiceover && speaking, "Repeated synthesis did not start");
    await page.waitForTimeout(500);
    await invoke("job.cancel", { id: voiceover.id });
    const cancelledAgain = await page.evaluate(() => window.__audioQA);
    assert(/cancel/i.test(cancelledAgain.error));
    assert.equal((await getProject()).assets.length, before);
    const recovered = await invoke("tts.generate", {
      text: await panel.getByLabel("Voiceover script").inputValue(),
      voice: "af_heart",
      speed: 1.08,
      name: "Recovery narration",
    });
    assert(recovered.duration > 10);
    await copyFile(recovered.path, path.join(work, "retry-heart.wav"));
    assert.equal((await getProject()).assets.length, before + 1);
    record(
      "After both voices, another active cancel and full three-passage retry succeed without losing assets",
    );
  }

  const playback = await panel.locator("audio").evaluate(async (audio) => {
    await audio.play();
    return !audio.paused;
  });
  assert(playback);
  await page.waitForTimeout(700);
  assert(
    await panel.locator("audio").evaluate((audio) => audio.currentTime > 0),
  );
  await panel.locator("audio").evaluate((audio) => audio.pause());
  record("Generated voiceover previews through the editor audio player");
  await panel
    .getByRole("button", { name: "Add to timeline", exact: true })
    .click();
  const added = await getProject();
  assert(
    added.clips.some(
      (c) => c.assetId === wavs[1].asset.id && c.kind === "audio",
    ),
  );
  await invoke("undo");
  assert.equal((await getProject()).clips.length, 0);
  await invoke("redo");
  assert.equal((await getProject()).clips.length, 1);
  await page.locator(".timeline-clip.audio").first().click();
  record("Add to timeline is one undoable audio edit");
  const exported = path.join(work, "saved-voiceover.wav");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, exported);
  await panel.getByRole("button", { name: "Save WAV", exact: true }).click();
  let bytes;
  for (let i = 0; i < 100; i++) {
    try {
      bytes = await readFile(exported);
      break;
    } catch {
      await page.waitForTimeout(100);
    }
  }
  assert(bytes?.length > 5000);
  const probe = JSON.parse(
    execFileSync(ffprobe, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      exported,
    ]),
  );
  assert.equal(probe.streams[0].codec_name, "pcm_s16le");
  assert(
    Math.abs(Number(probe.format.duration) - wavs[1].asset.duration) < 0.05,
  );
  record("Save WAV writes playable PCM audio with the full generated duration");
  await page.screenshot({ path: path.join(work, "voice-studio.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  await page.waitForTimeout(200);
  assert(
    await page.getByRole("button", { name: "Audio", exact: true }).isVisible(),
  );
  assert(
    await page
      .getByRole("button", { name: "Captions", exact: true })
      .isVisible(),
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: path.join(work, "voice-studio-minimum.png") });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(390, 600);
    window.setSize(390, 844);
  });
  const narrow = await page.addStyleTag({
    content:
      "body{min-width:0!important} body *{visibility:hidden} .audio-library,.audio-library *{visibility:visible} .audio-library{position:fixed!important;inset:0!important;width:390px!important;height:844px!important;box-sizing:border-box!important;z-index:99999;background:#141417}",
  });
  assert(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  );
  await panel.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(work, "voice-panel-390.png") });
  await narrow.evaluate((element) => element.remove());
  record(
    "Text-to-speech controls fit a 390px panel; the Mac editor retains its desktop minimum",
  );
  assert(
    !(await readdir(path.join(work, "data/speech"))).some((file) =>
      file.endsWith(".part"),
    ),
  );
  record("Cancelled synthesis leaves no partial WAV files");
  assert.deepEqual(errors, []);
  record("Audio tab fits at 1100×760; no renderer errors");
  if (offline) {
    const events = (await readFile(offlineLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      events.some((event) => event.loaded && event.threadId > 0),
      "Offline guard must run inside the inference worker",
    );
    assert(events.some((event) => event.verified && event.threadId > 0));
    assert(
      !events.some(
        (event) =>
          event.blocked && event.blocked !== "cutline-offline-check.invalid",
      ),
      "Speech attempted an external connection",
    );
    record(
      "Kokoro generated speech with external network access blocked inside its inference worker",
    );
  }
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(
      {
        packaged,
        offline,
        date: new Date().toISOString(),
        work,
        results,
        errors,
        voices: wavs.map(({ voice, asset, rms, seconds }) => ({
          voice,
          duration: asset.duration,
          rms,
          seconds,
        })),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ work, results }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(work, "failure.png") })
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
