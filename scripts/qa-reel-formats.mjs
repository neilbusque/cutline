import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const parent = path.resolve(root, "../reel-format-qa");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "data");
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
    stdio: "pipe",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
const voice = path.join(work, "voice.aiff");
const source = path.join(work, "Speaker test.mp4");
const cutaway = path.join(work, "Screen test.png");
const speech =
  "Start with one clear idea. Keep your story easy to follow. Show the important detail. Give each point time to breathe. Add captions that follow your voice. Make your next reel in Cutline.";
run("/usr/bin/say", ["-r", "155", "-o", voice, speech]);
run(ffmpeg, [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=0x28343a:s=360x640:r=30:d=16",
  "-i",
  voice,
  "-vf",
  "drawbox=x=125:y=190:w=110:h=120:color=0xb6c4c8:t=fill,drawbox=x=65:y=325:w=230:h=235:color=0x6b8188:t=fill",
  "-af",
  "apad",
  "-t",
  "16",
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
run(ffmpeg, [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=0xe4e7e9:s=640x360",
  "-vf",
  "drawbox=x=20:y=20:w=100:h=320:color=0x26363e:t=fill,drawbox=x=145:y=25:w=470:h=50:color=0x8fadb0:t=fill,drawbox=x=145:y=100:w=220:h=225:color=0xb8c9ce:t=fill",
  "-frames:v",
  "1",
  cutaway,
]);
const bundled = await build({
  entryPoints: [path.join(root, "src/shared/model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { newProject, makeClip } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const fixture = path.join(work, "formats.cutline");
const initial = newProject();
initial.name = "Cutline Reel Formats QA";
await writeFile(
  fixture,
  JSON.stringify({ project: initial, past: [], future: [], filePath: fixture }),
);
const installed = process.env.CUTLINE_INSTALLED === "1";
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: data,
  CUTLINE_SESSION_ROOT: data,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CUTLINE_SESSION_ID;
const app = await electron.launch({
  executablePath: installed
    ? "/Applications/Cutline.app/Contents/MacOS/Cutline"
    : path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
  args: installed ? [fixture] : [root, fixture],
  env,
});
let client, page;
const results = [],
  errors = [];
const log = (message) => {
  results.push(message);
  console.log(message);
};
try {
  const appVersion = await app.evaluate(({ app }) => app.getVersion());
  assert.equal(
    appVersion,
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  );
  console.log(
    `Checking ${installed ? "installed" : "source"} Cutline ${appVersion}`,
  );
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  console.log(`First window: ${page.url()}`);
  await page.waitForSelector(".titlebar", { timeout: 120000 });
  console.log(`Editor ready: ${page.url()}`);
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = () => invoke("state");
  const project = async () => (await state()).snapshot.project;
  const speaker = await invoke("test.import", { path: source });
  const screen = await invoke("test.import", { path: cutaway });
  let p = await project();
  p.clips = [
    {
      ...makeClip(
        p,
        "video",
        p.tracks.find((t) => t.kind === "video").id,
        0,
        speaker,
      ),
      duration: 30,
    },
  ];
  await writeFile(
    fixture,
    JSON.stringify({ project: p, past: [], future: [], filePath: fixture }),
  );
  await invoke("test.load", { path: fixture });
  const connection = JSON.parse(
    await readFile(path.join(data, "connection.json"), "utf8"),
  );
  client = new Client({ name: "reel-format-qa", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${connection.base}/mcp/local`)),
  );
  const call = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 180000 },
    );
    const text = response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    assert(!response.isError, `${name}: ${text}`);
    return JSON.parse(text);
  };
  const tools = await client.listTools();
  const reelTool = tools.tools.find((t) => t.name === "cutline_create_reel");
  assert.deepEqual(
    reelTool.inputSchema.properties.options.properties.format.enum,
    [
      "montage",
      "talking-head",
      "explainer",
      "listicle",
      "product-demo",
      "creator-education",
      "creator-punch",
      "screen-demo",
    ],
  );
  const guide = await call("cutline_effects_guide");
  assert.equal(guide.reel.formats.length, 8);
  const autoTool = tools.tools.find((t) => t.name === "cutline_auto_edit");
  assert(
    autoTool.inputSchema.properties.options.properties.format.enum.includes(
      "creator-education",
    ),
  );
  log(
    "Real MCP connection exposes all eight formats, captions and animation timing.",
  );
  await page.getByRole("button", { name: "Reel", exact: true }).click();
  await page
    .getByRole("button", { name: "Build manually", exact: true })
    .click();
  const wizard = page.locator(".reel-builder");
  await wizard
    .locator(".reel-source")
    .filter({ hasText: "Speaker test.mp4" })
    .getByRole("checkbox")
    .check();
  await wizard
    .getByRole("button", { name: "Continue to style", exact: false })
    .click();
  await wizard
    .getByLabel("Reel format", { exact: false })
    .selectOption("creator-education");
  await wizard.getByLabel("Target length").selectOption("15");
  assert.equal(
    await wizard
      .getByRole("button", { name: "Aa Clean Quiet + clear" })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.screenshot({
    animations: "disabled",
    path: path.join(work, "reel-formats-1440.png"),
  });
  // The Mac editor requires 1100px. Isolate the actual new panel at 390px to
  // test its controls without claiming that the entire desktop shell is mobile.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setMinimumSize(390, 600);
    w.setSize(390, 844);
  });
  const narrow = await page.addStyleTag({
    content:
      "body{min-width:0!important} body *{visibility:hidden} .reel-builder,.reel-builder *{visibility:visible} .reel-builder{position:fixed!important;inset:0!important;width:390px!important;height:844px!important;box-sizing:border-box!important;z-index:99999;background:#141417}",
  });
  await page.screenshot({ path: path.join(work, "reel-panel-390.png") });
  const overflow = await wizard.evaluate((el) => ({
    scroll: el.scrollWidth,
    width: el.clientWidth,
  }));
  assert(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
  await narrow.evaluate((el) => el.remove());
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1440, 960);
    w.setMinimumSize(1100, 760);
  });
  await wizard
    .getByRole("button", { name: "Continue to finishing", exact: false })
    .click();
  assert.equal(
    await wizard.getByLabel("Caption style", { exact: false }).inputValue(),
    "box",
  );
  await wizard.getByText("B-roll overlays", { exact: false }).click();
  await wizard
    .getByRole("checkbox", { name: "Screen test.png", exact: false })
    .check();
  assert.equal(
    await wizard.getByLabel("Timeline", { exact: false }).inputValue(),
    "append",
  );
  await wizard.getByLabel("Timeline", { exact: false }).selectOption("replace");
  await wizard.getByRole("button", { name: "Build Reel", exact: true }).click();
  await wizard
    .getByText("Your Ali Abdaal-inspired edit is ready", { exact: true })
    .waitFor({ timeout: 180000 });
  p = await project();
  assert(
    p.assets.find((a) => a.id === speaker.id).words.length > 15,
    "Real local speech alignment was not generated",
  );
  assert(p.clips.some((c) => c.kind === "caption" && c.captionStyle === "box"));
  assert(
    p.motions.some((m) => m.source === "reel:creator-education"),
    "Automatic educational animations missing",
  );
  assert(
    p.clips.find((c) => c.assetId === speaker.id).keyframes.length > 1,
    "Creator punch-ins missing",
  );
  log(
    "Wizard completes with real local transcription, Ali-inspired captions, editable educational cards and punch-ins.",
  );
  const creatorCardIds = new Set(
    p.motions
      .filter((m) => m.source === "reel:creator-education")
      .map((m) => m.id),
  );
  const creatorCards = p.clips.filter((c) => creatorCardIds.has(c.motionId));
  const creatorBroll = p.clips.filter((c) => c.assetId === screen.id);
  assert(creatorBroll.length > 0, "Selected supporting B-roll was dropped");
  for (const clip of creatorBroll) {
    assert.equal(clip.volume, 0);
    assert(
      clip.y + clip.height < p.height * 0.3,
      "Supporting media covers the speaker",
    );
    assert(
      !creatorCards.some(
        (card) =>
          clip.start < card.start + card.duration &&
          clip.start + clip.duration > card.start,
      ),
      "Supporting B-roll overlaps a teaching card",
    );
  }
  log(
    "Muted supporting B-roll stays above the speaker and outside teaching-card times.",
  );
  const created = structuredClone(p);
  await invoke("undo");
  assert.equal((await project()).clips.length, 1);
  await invoke("redo");
  assert.deepEqual((await project()).clips, created.clips);
  log(
    "One Undo and Redo restore the complete animated edit and its prior timeline.",
  );
  // Exercise every format through the actual MCP endpoint, then restore the UI reel.
  for (const format of [
    "montage",
    "talking-head",
    "explainer",
    "listicle",
    "product-demo",
  ]) {
    const current = await project();
    const options = {
      sources: [
        { assetId: format === "product-demo" ? screen.id : speaker.id },
      ],
      targetSeconds: 15,
      mode: "replace",
      format,
      captionStyle: "typewriter",
    };
    if (format === "product-demo")
      options.beats = [
        {
          sourceIndex: 0,
          sourceSeconds: 0,
          text: "Show the important detail",
          kind: "callout",
        },
      ];
    const result = await call("cutline_create_reel", {
      projectId: current.id,
      revision: current.revision,
      options,
    });
    if (result.pending || result.jobId) {
      const id = result.jobId ?? result.id;
      for (let i = 0; i < 360; i++) {
        const jobs = (await state()).jobs;
        const job = jobs.find((j) => j.id === id);
        if (job?.state === "done") break;
        if (job?.state === "error") throw Error(job.message);
        await page.waitForTimeout(500);
      }
    }
    const next = await project();
    assert.equal(next.width, 1080);
    assert.equal(next.height, 1920);
    assert.equal(Math.max(...next.clips.map((c) => c.start + c.duration)), 450);
    if (format !== "montage") assert(next.clips.some((c) => c.motionId));
    if (format === "product-demo")
      assert.equal(
        next.clips.find((c) => c.assetId === screen.id).fit,
        "contain",
      );
    if (format === "listicle")
      assert(
        next.motions.some((m) =>
          m.layers.some((l) => l.name === "Step number"),
        ),
      );
    const preview = await client.callTool(
      {
        name: "cutline_preview",
        arguments: { frames: [15, 45, 240], image: true, width: 360 },
      },
      undefined,
      { timeout: 180000 },
    );
    assert(
      !preview.isError,
      JSON.stringify(preview.content.filter((item) => item.type === "text")),
    );
    const previewImage = preview.content.find((item) => item.type === "image");
    assert(previewImage, "Rendered format preview missing");
    await writeFile(
      path.join(work, `preview-${format}.jpg`),
      Buffer.from(previewImage.data, "base64"),
    );
    log(`MCP builds ${format} with native editable timeline layers.`);
  }
  // The Auto edit UI must route the same format through the full local pipeline.
  await page.getByRole("button", { name: "Auto edit", exact: true }).click();
  const auto = page.locator(".auto-reel");
  await auto
    .getByLabel("Automatic Reel format")
    .selectOption("creator-education");
  assert.equal(
    await auto.getByLabel("Automatic caption style").inputValue(),
    "box",
  );
  assert.equal(
    await auto.getByLabel("Automatic edit pacing").inputValue(),
    "natural",
  );
  await auto.getByRole("checkbox", { name: "Relevant B-roll" }).uncheck();
  await auto.getByRole("checkbox", { name: "Original music" }).uncheck();
  await auto.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    animations: "disabled",
    path: path.join(work, "auto-creator-1440.png"),
  });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setMinimumSize(390, 600);
    w.setSize(390, 844);
  });
  const autoNarrow = await page.addStyleTag({
    content:
      "body{min-width:0!important} body *{visibility:hidden} .auto-reel,.auto-reel *{visibility:visible} .auto-reel{position:fixed!important;inset:0!important;width:390px!important;height:844px!important;box-sizing:border-box!important;z-index:99999;background:#141417}",
  });
  await page.screenshot({ path: path.join(work, "auto-creator-390.png") });
  assert(
    await auto.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    "Auto format overflows at 390px",
  );
  await autoNarrow.evaluate((el) => el.remove());
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1440, 960);
    w.setMinimumSize(1100, 760);
  });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, source);
  await auto
    .getByRole("button", { name: "Upload & auto edit", exact: false })
    .click();
  await auto
    .getByText("Your Reel is ready", { exact: true })
    .waitFor({ timeout: 240000 });
  const automatic = await project();
  assert(
    automatic.motions.some((m) => m.source === "reel:creator-education"),
    "Auto edit dropped educational motion cards",
  );
  assert(
    automatic.clips
      .filter((c) => c.kind === "caption")
      .every((c) => c.captionStyle === "box"),
    "Auto edit dropped creator captions",
  );
  assert(
    automatic.clips
      .filter(
        (c) =>
          c.kind === "video" &&
          !automatic.tracks.find((t) => t.id === c.trackId)?.muted,
      )
      .some((c) =>
        c.keyframes.some((k) => k.property === "scale" && k.value >= 1.05),
      ),
    "Auto edit replaced emphasis punch-ins with the generic drift",
  );
  assert(
    automatic.clips
      .filter((c) => c.kind === "caption")
      .every((c) => c.captionSourceId),
    "Auto captions lost source alignment",
  );
  await writeFile(
    path.join(work, "auto-creator.cutline"),
    JSON.stringify({ project: automatic, past: [], future: [] }),
  );
  log(
    "Auto edit UI completes local transcription and cuts with the same editable educational format.",
  );
  await writeFile(
    fixture,
    JSON.stringify({
      project: created,
      past: [],
      future: [],
      filePath: fixture,
    }),
  );
  await invoke("test.load", { path: fixture });
  const output = path.join(work, "Cutline-educational-reel-demo.mp4");
  const job = await invoke("test.export", { path: output });
  let done;
  for (let i = 0; i < 720; i++) {
    done = (await state()).jobs.find((j) => j.id === job.id);
    if (done?.state === "done") break;
    if (["error", "cancelled"].includes(done?.state)) throw Error(done.message);
    await page.waitForTimeout(500);
  }
  assert.equal(done?.state, "done", "Export timed out");
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
  const video = probe.streams.find((s) => s.codec_type === "video");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(video.codec_name, "h264");
  assert(
    probe.streams.some(
      (s) => s.codec_type === "audio" && s.codec_name === "aac",
    ),
  );
  assert(Math.abs(Number(probe.format.duration) - 15) < 0.1);
  run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
  const samples = (file) => {
    const b = run(ffmpeg, [
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
      { length: Math.floor(b.length / 2) },
      (_, i) => b.readInt16LE(i * 2) / 32768,
    );
  };
  const original = samples(source),
    rendered = samples(output);
  let correlation = 0;
  for (let lag = -40; lag <= 40; lag++) {
    let cross = 0,
      a2 = 0,
      b2 = 0;
    for (
      let i = 80;
      i < Math.min(original.length, rendered.length) - 80;
      i += 4
    ) {
      const a = original[i],
        b = rendered[i + lag];
      cross += a * b;
      a2 += a * a;
      b2 += b * b;
    }
    correlation = Math.max(correlation, cross / Math.sqrt(a2 * b2));
  }
  assert(correlation > 0.9, `Source audio correlation ${correlation}`);
  const firstMotion = created.clips.find((c) => creatorCardIds.has(c.motionId));
  const frameTimes = [
    0.6,
    (firstMotion.start + 15) / 30,
    (firstMotion.start + 45) / 30,
    7.5,
    12.5,
  ];
  for (let i = 0; i < frameTimes.length; i++)
    run(ffmpeg, [
      "-y",
      "-v",
      "error",
      "-ss",
      String(frameTimes[i]),
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "scale=432:768",
      path.join(work, `frame-${i}.png`),
    ]);
  log(
    `Export verified: 1080x1920 H.264/AAC, 15 seconds, narration correlation ${correlation.toFixed(4)}.`,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(
      { installed, output, fixture, results, errors, correlation },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ work, output, fixture }));
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(work, "failure.png") })
      .catch(() => {});
  await writeFile(
    path.join(work, "failure.json"),
    JSON.stringify(
      {
        message: error.message,
        windowUrls: app.windows().map((window) => window.url()),
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.error("QA artifacts:", work);
  throw error;
} finally {
  await client?.close();
  await app.close();
}
