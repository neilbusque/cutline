import { _electron as electron, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Build first, then run with one-at-a-time. Only disposable synthetic media is
// used. No browser/dev server is left running. The default replaces the hosted
// review response only; native rendering, stems, Whisper and fixes remain real.
// CUTLINE_LISTENING_LIVE=1 adds a real provider pass on the synthetic fixture.
// CUTLINE_LISTENING_LIVE_ONLY=1 runs that provider pass without repeating mocks.
const root = process.cwd();
const parent = path.resolve(
  process.env.CUTLINE_LISTENING_RESULTS ??
    path.join(os.tmpdir(), "cutline-listening-qa"),
);
assert(
  !parent.startsWith(root + path.sep),
  "Keep QA media and profiles outside the repository",
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "profile");
const fixture = path.join(work, "Listening.cutline");
const packaged = process.env.CUTLINE_PACKAGED === "1";
const liveOnly = process.env.CUTLINE_LISTENING_LIVE_ONLY === "1";
const live = liveOnly || process.env.CUTLINE_LISTENING_LIVE === "1";
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const run = (binary, args) =>
  execFileSync(binary, args, { timeout: 120000, maxBuffer: 8 * 1024 ** 2 });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clean = (value) =>
  String(value)
    .replace(/data:[^\s"'<>]+/giu, "[inline module]")
    .replace(
      /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s"')]+/gu,
      "[local bridge]",
    )
    .slice(0, 4000);
const report = {
  work,
  packaged,
  live,
  runtime: null,
  checks: [],
  screenshots: [],
  exports: [],
  mockCounts: [],
  errors: [],
  consoleErrors: [],
  failed: null,
  cleanupFailure: null,
  cleanedUp: false,
};
const check = (message) => {
  report.checks.push(message);
  console.log(message);
};
let app, appChild, page, client, closing;
const close = () =>
  (closing ??= (async () => {
    await client?.close().catch(() => {});
    if (!app) return;
    const child = appChild;
    let timer;
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("QA close timed out")), 15000);
        }),
      ]);
    } catch {
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
    void close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
const invoke = (name, args) =>
  page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
    name,
    args,
  });
const current = async () => (await invoke("state")).snapshot.project;
const guard = (p) => ({ projectId: p.id, revision: p.revision });
const content = (p) => JSON.stringify({ ...p, revision: 0 });
const call = async (name, args = {}) => {
  const response = await client.callTool(
    { name, arguments: { sessionId: "main", ...args } },
    undefined,
    { timeout: 240000 },
  );
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert(!response.isError, `${name}: ${clean(text)}`);
  return JSON.parse(text);
};
const waitUntil = async (predicate, message, timeout = 300000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await page.waitForTimeout(250);
  }
  throw Error(message);
};
const waitJob = async (id, expected = "done") => {
  const job = await waitUntil(
    async () => {
      const jobs = (await invoke("state")).jobs;
      const value = jobs.find((item) => item.id === id);
      return value && value.state !== "running" ? value : null;
    },
    `Export ${id} timed out`,
    420000,
  );
  assert.equal(job.state, expected, job.message);
  return job;
};
const resize = async (width, height) => {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(390, 600);
      window.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await page.setViewportSize({ width, height });
};
const settingsScreenshots = async () => {
  for (const [width, height] of [
    [1440, 960],
    [390, 844],
  ]) {
    await resize(width, height);
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    assert(
      bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1,
      `Settings fit ${width}px`,
    );
    const layout = await dialog.evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
    }));
    assert(
      layout.scroll <= layout.width + 1,
      `No settings overflow at ${width}px`,
    );
    await page
      .getByRole("heading", { name: "Listening review", exact: true })
      .scrollIntoViewIfNeeded();
    const file = path.join(work, `settings-${width}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    report.screenshots.push({
      file,
      width,
      layout,
      note: "Actual viewport; the full editor retains its desktop minimum width",
    });
  }
  await resize(1440, 960);
};
const inspectExport = async (output, job) => {
  const info = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      output,
    ]).toString(),
  );
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.equal(video.r_frame_rate, "30/1");
  assert.equal(Number(video.nb_read_frames), 120);
  assert.equal(audio.codec_name, "aac");
  assert(Math.abs(Number(info.format.duration) - 4) < 0.06);
  run(ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-threads",
    "2",
    "-i",
    output,
    "-f",
    "null",
    "-",
  ]);
  const listening = job.listening
    ? JSON.parse(await readFile(job.listening.reportPath, "utf8"))
    : null;
  report.exports.push({
    file: output,
    durationSeconds: Number(info.format.duration),
    frames: 120,
    decodePassed: true,
    listening,
  });
  return listening;
};

// Only the official hosted reviewer is intercepted. Fetches to any other host
// continue through the app's original implementation. State never leaves this
// disposable Electron main process; no production hook is added to the app.
const installMock = async () =>
  app.evaluate(() => {
    const g = globalThis;
    g.__listeningQAOriginalFetch = g.fetch;
    g.__listeningQA = {
      mode: "clean",
      requests: 0,
      uploads: 0,
      submissions: 0,
      reviews: 0,
      aborted: 0,
      waiting: false,
      release: null,
    };
    g.fetch = async (input, options = {}) => {
      const url = new URL(
        typeof input === "string" ? input : (input.url ?? String(input)),
      );
      if (url.origin !== "https://qwen-qwen3-5-omni-offline-demo.hf.space")
        return g.__listeningQAOriginalFetch(input, options);
      const state = g.__listeningQA;
      state.requests++;
      const json = (value, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (state.mode === "fail")
        return json({ error: "Fixture provider unavailable" }, 503);
      if (url.pathname === "/gradio_api/upload") {
        state.uploads++;
        return json(["/tmp/gradio/listening-qa/cutline-review.wav"]);
      }
      if (url.pathname === "/gradio_api/call/chat_predict") {
        state.submissions++;
        return json({ event_id: `qa-${state.submissions}` });
      }
      if (url.pathname.startsWith("/gradio_api/call/chat_predict/")) {
        const reviewIndex = ++state.reviews;
        const response = () => {
          const issue =
            (state.mode === "masking" || state.mode === "stale") &&
            reviewIndex === 1;
          const report = {
            summary: issue
              ? "Fixture music masks the voice"
              : "Fixture audio has no remaining model findings",
            transcript: "Clear words make this short message useful.",
            issues: issue
              ? [
                  {
                    category: "music",
                    kind: "music_masking",
                    startSeconds: 0.25,
                    endSeconds: 2.75,
                    severity: "warning",
                    confidence: 0.96,
                    description:
                      "The music competes with the narration during this phrase.",
                  },
                ]
              : [],
          };
          return new Response(
            `event: complete\ndata: ${JSON.stringify([null, null, null, null, [{ role: "assistant", content: JSON.stringify(report) }]])}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        };
        if (
          state.mode === "pending" ||
          (state.mode === "stale" && reviewIndex === 1)
        ) {
          state.waiting = true;
          return new Promise((resolve, reject) => {
            const abort = () => {
              state.aborted++;
              state.waiting = false;
              state.release = null;
              reject(new DOMException("Aborted", "AbortError"));
            };
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) {
              abort();
              return;
            }
            state.release = () => {
              options.signal?.removeEventListener("abort", abort);
              state.waiting = false;
              state.release = null;
              resolve(response());
            };
          });
        }
        return response();
      }
      throw Error("Unexpected hosted review route in QA");
    };
  });
const setMock = async (mode) =>
  app.evaluate((_, mode) => {
    Object.assign(globalThis.__listeningQA, {
      mode,
      requests: 0,
      uploads: 0,
      submissions: 0,
      reviews: 0,
      aborted: 0,
      waiting: false,
      release: null,
    });
  }, mode);
const mockStats = () =>
  app.evaluate(() => {
    const { release, ...rest } = globalThis.__listeningQA;
    return rest;
  });
const snapshotStats = async (caseName) => {
  const counts = await mockStats();
  report.mockCounts.push({ case: caseName, ...counts });
  return counts;
};
const assertComplete = (review) => {
  assert(review.passes.length > 0);
  assert.equal(review.durationSeconds, 4);
  for (const pass of review.passes) {
    assert.equal(pass.complete, true);
    assert(pass.coveredSeconds >= 4);
    assert.equal(pass.evidence.mix.complete, true);
    for (const role of ["voice", "music", "sfx"])
      assert.equal(
        pass.evidence.stems[role]?.complete,
        true,
        `${role} stem measured`,
      );
    assert.equal(
      pass.evidence.alignment.status,
      "complete",
      JSON.stringify(pass.evidence.limitations),
    );
    assert(pass.evidence.alignment.words.length > 0);
  }
};

try {
  const voiceAiff = path.join(work, "synthetic-voice.aiff");
  const voice = path.join(work, "synthetic-voice.wav");
  const music = path.join(work, "synthetic-music.wav");
  const sfx = path.join(work, "synthetic-effect.wav");
  run("/usr/bin/say", [
    "-r",
    "185",
    "-o",
    voiceAiff,
    "Clear words make this short message useful.",
  ]);
  run(ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-i",
    voiceAiff,
    "-af",
    "loudnorm=I=-20:TP=-6:LRA=11,apad,atrim=duration=4",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    voice,
  ]);
  run(ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=180:duration=4:sample_rate=48000",
    "-af",
    "volume=1.5,afade=t=in:st=0:d=0.05,afade=t=out:st=3.7:d=0.3",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    music,
  ]);
  run(ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=0.2:sample_rate=48000",
    "-af",
    "volume=0.12,afade=t=out:st=0.02:d=0.18",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    sfx,
  ]);
  const originalVoiceHash = hash(await readFile(voice));
  const bundled = await build({
    stdin: {
      contents:
        'export {newProject, validateProject, makeClip, AssetSchema} from "./src/shared/model.ts";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, validateProject, makeClip, AssetSchema } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  const p = {
    ...newProject(),
    name: "Listening review QA",
    width: 640,
    height: 360,
    fps: 30,
    background: "#15191f",
    tracks: [
      {
        id: "captions",
        name: "Captions",
        kind: "text",
        muted: false,
        hidden: false,
      },
      { id: "title", name: "Title", kind: "text", muted: false, hidden: false },
      ...["voice", "music", "sfx"].map((role) => ({
        id: role,
        name: role,
        kind: "audio",
        muted: false,
        hidden: false,
      })),
    ],
  };
  p.assets = [
    ["voice", voice, 4],
    ["music", music, 4],
    ["sfx", sfx, 0.2],
  ].map(([id, file, duration]) =>
    AssetSchema.parse({
      id: `${id}-asset`,
      name: `QA ${id}`,
      kind: "audio",
      path: file,
      duration,
      hasAudio: true,
    }),
  );
  p.clips = p.assets.map((a, index) => {
    const role = ["voice", "music", "sfx"][index];
    return {
      ...makeClip(p, "audio", role, role === "sfx" ? 96 : 0, a),
      id: `${role}-clip`,
      audioRole: role,
      duration: role === "sfx" ? 6 : 120,
      volume: role === "voice" ? 0.8 : 1,
    };
  });
  p.clips.push({
    ...makeClip(p, "caption", "captions", 0),
    id: "caption-clip",
    duration: 120,
    text: "Clear words make this short message useful.",
    fontSize: 28,
    x: 30,
    y: 250,
    width: 580,
    height: 80,
  });
  p.clips.push({
    ...makeClip(p, "text", "title", 0),
    id: "title-clip",
    duration: 120,
    text: "Listening review",
    fontSize: 38,
    x: 30,
    y: 70,
    width: 580,
    height: 90,
  });
  await writeFile(
    fixture,
    JSON.stringify({
      project: validateProject(p),
      past: [],
      future: [],
      filePath: fixture,
    }),
  );
  const env = {
    ...process.env,
    CUTLINE_QA: "1",
    CUTLINE_DATA_DIR: data,
    CUTLINE_SESSION_ROOT: data,
    CUTLINE_PROJECTS_DIR: path.join(work, "projects"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CUTLINE_SESSION_ID;
  const executablePath =
    process.env.CUTLINE_APP_EXECUTABLE ??
    (packaged
      ? "/Applications/Cutline.app/Contents/MacOS/Cutline"
      : path.join(
          root,
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ));
  app = await electron.launch({
    executablePath,
    args: packaged ? [fixture] : [root, fixture],
    env,
    timeout: 120000,
  });
  appChild = app.process();
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(clean(error.message)));
  page.on("console", (message) => {
    if (message.type() === "error")
      report.consoleErrors.push(clean(message.text()));
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.waitForSelector(".titlebar", { timeout: 120000 });
  await waitUntil(
    async () => (await current()).clips.some((c) => c.id === "voice-clip"),
    "Fixture did not load",
  );
  report.runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
  }));
  assert.equal(report.runtime.packaged, packaged);
  assert.equal(
    report.runtime.version,
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  );
  const connection = JSON.parse(
    await readFile(path.join(data, "connection.json"), "utf8"),
  );
  client = new Client({ name: "cutline-listening-qa", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${connection.base}/mcp`)),
  );
  assert(
    (await client.listTools()).tools.some(
      (t) => t.name === "cutline_listening_review",
    ),
  );
  assert.deepEqual(await invoke("listening.settings"), {
    enabled: false,
    autoFix: true,
  });
  check(
    "Fresh profile leaves hosted audio review off and exposes the assistant review tool",
  );
  await page
    .getByRole("button", { name: "Settings & connections", exact: true })
    .click();
  const reviewToggle = page.getByRole("checkbox", {
    name: "Review every export",
    exact: true,
  });
  const fixToggle = page.getByRole("checkbox", {
    name: "Apply supported fixes",
    exact: true,
  });
  await expect(reviewToggle).not.toBeChecked();
  // These controlled inputs reflect persisted IPC results, not an optimistic
  // click. check()/uncheck() require an immediate state change; click then use
  // retrying assertions so this verifies the actual completed save instead.
  await reviewToggle.click();
  await expect(reviewToggle).toBeChecked();
  await waitUntil(
    async () => (await invoke("listening.settings")).enabled,
    "Automatic review did not save",
  );
  await expect(fixToggle).toBeEnabled();
  await expect(fixToggle).toBeChecked();
  await fixToggle.click();
  await expect(fixToggle).not.toBeChecked();
  await waitUntil(
    async () => !(await invoke("listening.settings")).autoFix,
    "Auto-fix off did not save",
  );
  await fixToggle.click();
  await expect(fixToggle).toBeChecked();
  await waitUntil(
    async () => (await invoke("listening.settings")).autoFix,
    "Auto-fix on did not save",
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(data, "listening-settings.json"), "utf8"),
    ),
    { enabled: true, autoFix: true },
  );
  await settingsScreenshots();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  check("Settings toggles persist and the disclosure fits 1440px and 390px");
  await page.locator('[data-clip-id="voice-clip"]').click();
  await page.getByRole("button", { name: "Properties", exact: true }).click();
  const role = page.getByRole("combobox", { name: "Audio role", exact: true });
  await expect(role).toHaveValue("voice");
  await role.selectOption("");
  await waitUntil(
    async () =>
      !(await current()).clips.find((c) => c.id === "voice-clip").audioRole,
    "Audio role did not clear",
  );
  await role.selectOption("voice");
  await waitUntil(
    async () =>
      (await current()).clips.find((c) => c.id === "voice-clip").audioRole ===
      "voice",
    "Audio role did not persist",
  );
  const inspectorShot = path.join(work, "audio-role-1440.png");
  await page.screenshot({ path: inspectorShot, animations: "disabled" });
  report.screenshots.push({ file: inspectorShot, width: 1440 });
  check(
    "Inspector role selection can be cleared and restored without changing source media",
  );

  if (!liveOnly) {
    await installMock();
    await setMock("masking");
    const before = await current();
    const output = path.join(work, "automatic-fixes.mp4");
    const job = await waitJob(
      (await invoke("test.export", { path: output })).id,
    );
    const review = await inspectExport(output, job);
    assertComplete(review);
    assert.equal(review.passes.length, 2);
    assert(review.fixes.some((f) => f.kind === "music_masking"));
    const after = await current();
    assert.equal(
      after.revision,
      before.revision + 1,
      "All accepted fixes are one undo step",
    );
    assert(
      after.clips.find((c) => c.id === "music-clip").volume <
        before.clips.find((c) => c.id === "music-clip").volume,
    );
    const counts = await snapshotStats("automatic fixes");
    assert.equal(counts.reviews, 2);
    assert.equal(hash(await readFile(voice)), originalVoiceHash);
    const modelReport = await call("cutline_listening_review", {
      action: "report",
      jobId: job.id,
    });
    assert.deepEqual(modelReport, review);
    await expect(
      page.getByRole("button", { name: "Review report", exact: true }),
    ).toBeVisible();
    const statusShot = path.join(work, "reviewed-status-1440.png");
    await page.screenshot({ path: statusShot, animations: "disabled" });
    report.screenshots.push({ file: statusShot, width: 1440 });
    const undone = await call("cutline_undo", guard(after));
    assert.equal(undone.undone, "Apply listening review fixes");
    assert.equal(
      content(await current()),
      content(before),
      "One Undo restores the entire pre-review project",
    );
    check(
      "Native export measured full mix and three stems, aligned speech locally, fixed measured masking, re-reviewed every second and committed one Undo",
    );

    await setMock("clean");
    const mcpOutput = path.join(work, "assistant-export.mp4");
    const mcpJob = await waitJob(
      (
        await call("cutline_export", {
          ...guard(await current()),
          path: mcpOutput,
        })
      ).id,
    );
    assertComplete(await inspectExport(mcpOutput, mcpJob));
    assert.equal((await snapshotStats("MCP export")).reviews, 1);
    check(
      "MCP cutline_export runs the same full listening pipeline as the UI export path",
    );

    await setMock("fail");
    const beforeFailure = await current();
    const failureOutput = path.join(work, "provider-unavailable.mp4");
    const failureJob = await waitJob(
      (await invoke("test.export", { path: failureOutput })).id,
    );
    const failed = await inspectExport(failureOutput, failureJob);
    assert.equal(failed.status, "incomplete");
    assert.equal(failed.fixes.length, 0);
    assert.equal(content(await current()), content(beforeFailure));
    assert.equal(failed.passes[0].complete, false);
    await expect(
      page.getByText("Audio review incomplete", { exact: true }),
    ).toBeVisible();
    await snapshotStats("provider failure");
    check(
      "Provider failure keeps a usable export, an incomplete report and the original timeline",
    );

    await invoke("listening.settings.set", { enabled: false });
    await setMock("fail");
    const offOutput = path.join(work, "review-disabled.mp4");
    const offJob = await waitJob(
      (await invoke("test.export", { path: offOutput })).id,
    );
    assert.equal(offJob.listening, undefined);
    await inspectExport(offOutput, offJob);
    assert.equal((await snapshotStats("disabled")).requests, 0);
    check("Disabling review exports normally with no hosted audio request");
    await invoke("listening.settings.set", { enabled: true });

    await setMock("pending");
    const beforeCancel = await current();
    const cancelledOutput = path.join(work, "cancelled.mp4");
    const pendingJob = await invoke("test.export", { path: cancelledOutput });
    await waitUntil(
      async () => (await mockStats()).waiting,
      "Review did not reach the cancellable hosted request",
    );
    await invoke("job.cancel", { id: pendingJob.id });
    await waitJob(pendingJob.id, "cancelled");
    await waitUntil(
      async () => (await mockStats()).aborted > 0,
      "Cancellation did not abort the hosted request",
      20000,
    );
    await waitUntil(
      async () =>
        !(await readdir(work)).some((f) => f.startsWith("cancelled.mp4.")),
      "Cancelled export left partial files",
      20000,
    );
    assert.equal(
      await stat(cancelledOutput).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(content(await current()), content(beforeCancel));
    await snapshotStats("cancellation");
    check(
      "Cancel aborts the hosted request, removes temporary renders and keeps the timeline unchanged",
    );

    await setMock("stale");
    const staleOutput = path.join(work, "concurrent-edit.mp4");
    const staleJob = await invoke("test.export", { path: staleOutput });
    await waitUntil(
      async () => (await mockStats()).waiting,
      "Stale-project fixture did not reach first review",
    );
    const during = await current();
    await invoke("edit", {
      ...guard(during),
      label: "Keep concurrent title edit",
      commands: [
        {
          type: "clip.update",
          id: "title-clip",
          patch: { text: "Concurrent edit kept" },
        },
      ],
    });
    const concurrent = await current();
    await app.evaluate(() => globalThis.__listeningQA.release());
    const staleDone = await waitJob(staleJob.id);
    const staleReview = await inspectExport(staleOutput, staleDone);
    assertComplete(staleReview);
    assert.equal(staleReview.passes.length, 2);
    assert.equal(staleReview.status, "needs-review");
    assert.equal(staleReview.fixes.length, 0);
    assert.equal(content(await current()), content(concurrent));
    await snapshotStats("stale project");
    check(
      "A newer live edit rejects stale automatic fixes after candidate review and preserves that edit",
    );
  }

  if (live) {
    if (!liveOnly)
      await app.evaluate(() => {
        globalThis.fetch = globalThis.__listeningQAOriginalFetch;
      });
    // The already-generated synthetic voice is the only speech sent remotely.
    await invoke("listening.settings.set", { enabled: true, autoFix: false });
    const liveOutput = path.join(work, "hosted-listening.mp4");
    const liveJob = await waitJob(
      (
        await call("cutline_export", {
          ...guard(await current()),
          path: liveOutput,
        })
      ).id,
    );
    const liveReport = await inspectExport(liveOutput, liveJob);
    assertComplete(liveReport);
    assert(liveReport.status !== "incomplete");
    check(
      "Actual hosted Qwen review received the full synthetic soundtrack and returned a valid report",
    );
  }
  assert.equal(hash(await readFile(voice)), originalVoiceHash);
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
  assert(
    !(await readdir(work)).some((f) => f.includes(".partial.mp4")),
    "All export partials are cleaned",
  );
  check(
    "Original synthetic voice bytes are unchanged and no partial renders remain",
  );
} catch (error) {
  report.failed = clean(error.stack ?? error.message ?? error);
  console.error(report.failed);
  process.exitCode = 1;
} finally {
  try {
    await close();
  } catch (error) {
    report.cleanupFailure = clean(error.stack ?? error.message ?? error);
    console.error(`QA cleanup failed: ${report.cleanupFailure}`);
    process.exitCode = 1;
  } finally {
    report.cleanedUp =
      !appChild || appChild.exitCode !== null || appChild.signalCode !== null;
    try {
      await writeFile(
        path.join(work, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
        { mode: 0o600 },
      );
    } catch (error) {
      console.error(
        `Could not save QA report: ${clean(error.message ?? error)}`,
      );
      process.exitCode = 1;
    }
    console.log(
      JSON.stringify(
        {
          work,
          checks: report.checks.length,
          exports: report.exports.length,
          screenshots: report.screenshots.length,
          cleanedUp: report.cleanedUp,
          failed: report.failed,
          cleanupFailure: report.cleanupFailure,
        },
        null,
        2,
      ),
    );
  }
}
