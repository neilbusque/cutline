import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

// Run after the source build, serially through one-at-a-time. This launches
// one disposable Electron app and closes it in finally. CUTLINE_INSTALLED=1
// tests /Applications/Cutline.app with the same isolated data and fixture.
// The rectangles and macOS speech below are a technical test fixture, not a
// real presenter showcase or a recreation of a creator's video.
const root = process.cwd();
const parent = path.resolve(root, "../creator-shorts-qa");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "data");
const installed = process.env.CUTLINE_INSTALLED === "1";
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
    maxBuffer: 32 * 1024 * 1024,
  });
const voice = path.join(work, "fixture-voice.aiff");
const source = path.join(work, "Creator speech fixture.mp4");
const screenPath = path.join(work, "Screen proof fixture.png");
const fixture = path.join(work, "Creator-shorts-fixture.cutline");
const output = path.join(work, "Creator-shorts-technical-fixture.mp4");
const results = [],
  errors = [],
  consoleErrors = [];
const report = {
  installed,
  work,
  output,
  fixture,
  fixtureDescription:
    "Synthetic colored blocks with macOS speech; technical QA, not a real creator showcase.",
  results,
  errors,
  consoleErrors,
  reviewBoundary:
    "Automated geometry, decoded video, audio correlation and saved preview images. Human visual and listening review remain separate.",
};
const log = (message) => {
  results.push(message);
  console.log(message);
};
let app, client, page, invoke;

try {
  run("/usr/bin/say", [
    "-r",
    "165",
    "-o",
    voice,
    "Start with one clear idea. Show the screen that proves your point. Keep your original voice. Make each important detail easy to see. Return to the speaker when the demonstration is finished.",
  ]);
  run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x233944:s=360x640:r=30:d=16",
    "-i",
    voice,
    "-vf",
    "drawbox=x=125:y=170:w=110:h=120:color=0xe5b793:t=fill,drawbox=x=65:y=310:w=230:h=265:color=0x648a98:t=fill",
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
    "color=c=0xf3ede3:s=960x540",
    "-vf",
    "drawbox=x=20:y=20:w=170:h=500:color=0x28313f:t=fill,drawbox=x=215:y=30:w=720:h=65:color=0x337ab7:t=fill,drawbox=x=215:y=125:w=340:h=365:color=0x8bc1bb:t=fill,drawbox=x=580:y=125:w=350:h=170:color=0xe4bd6d:t=fill,drawbox=x=580:y=320:w=350:h=170:color=0x7e91ba:t=fill",
    "-frames:v",
    "1",
    screenPath,
  ]);
  const bundled = await build({
    stdin: {
      contents:
        'export {newProject, makeClip} from "./src/shared/model.ts"; export {captionLayout} from "./src/shared/caption-layout.ts"; export {evaluatedClip} from "./src/shared/animation.ts";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, makeClip, captionLayout, evaluatedClip } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  const initial = newProject();
  initial.name = "Creator shorts technical QA";
  await writeFile(
    fixture,
    JSON.stringify({
      project: initial,
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
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CUTLINE_SESSION_ID;
  app = await electron.launch({
    executablePath: installed
      ? "/Applications/Cutline.app/Contents/MacOS/Cutline"
      : path.join(
          root,
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
    args: installed ? [fixture] : [root, fixture],
    env,
    timeout: 120000,
  });
  report.runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
  }));
  assert.equal(
    report.runtime.version,
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  );
  assert.equal(report.runtime.packaged, installed);
  if (installed)
    assert.equal(
      report.runtime.appPath,
      "/Applications/Cutline.app/Contents/Resources/app",
    );
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar", { timeout: 120000 });
  // The workflow is completely local. Fail closed if a main-process fetch
  // accidentally attempts a stock/provider request during these test actions.
  await app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.__creatorQaExternalRequests = [];
    globalThis.fetch = async (...args) => {
      const input = args[0];
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(address);
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
        globalThis.__creatorQaExternalRequests.push(
          `${url.protocol}//${url.host}${url.pathname}`,
        );
        throw Error("Creator QA blocks external network requests");
      }
      return original(...args);
    };
  });
  invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = () => invoke("state");
  const project = async () => (await state()).snapshot.project;
  const waitJob = async (result, timeout = 240000) => {
    if (!result?.pending && !result?.jobId) return result;
    const id = result.jobId ?? result.id;
    assert(id, "Pending MCP result did not provide a job ID");
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      // AgentTasks are exposed by cutline_jobs, not the renderer's processing
      // job list. Read the returned task result rather than launching again.
      const job = (await call("cutline_jobs", { id, waitSeconds: 10 })).find(
        (item) => item.id === id,
      );
      if (job?.state === "done") {
        assert(job.result, "Completed MCP task did not preserve its result");
        return job.result;
      }
      if (["error", "cancelled"].includes(job?.state)) throw Error(job.message);
    }
    throw Error(`MCP job ${id} timed out`);
  };
  const speaker = await invoke("test.import", { path: source });
  const screen = await invoke("test.import", { path: screenPath });
  let p = await project();
  p.clips = [
    {
      ...makeClip(
        p,
        "video",
        p.tracks.find((track) => track.kind === "video").id,
        0,
        speaker,
      ),
      duration: p.fps,
    },
  ];
  const before = structuredClone(p);
  await writeFile(
    fixture,
    JSON.stringify({ project: p, past: [], future: [], filePath: fixture }),
  );
  await invoke("test.load", { path: fixture });
  const connection = JSON.parse(
    await readFile(path.join(data, "connection.json"), "utf8"),
  );
  client = new Client({ name: "creator-shorts-qa", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${connection.base}/mcp/local`)),
  );
  const call = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 240000 },
    );
    const body = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert(!response.isError, `${name}: ${body}`);
    return JSON.parse(body);
  };
  const savePreview = async (name, frames) => {
    assert(frames.length <= 12);
    const response = await client.callTool(
      {
        name: "cutline_preview",
        arguments: { frames, image: true, width: 360 },
      },
      undefined,
      { timeout: 240000 },
    );
    assert(
      !response.isError,
      JSON.stringify(response.content.filter((item) => item.type === "text")),
    );
    const pictures = response.content.filter((item) => item.type === "image");
    assert(pictures.length, "Preview returned no rendered images");
    for (const [index, picture] of pictures.entries()) {
      const extension = picture.mimeType === "image/png" ? "png" : "jpg";
      await writeFile(
        path.join(work, `${name}${index ? `-${index + 1}` : ""}.${extension}`),
        Buffer.from(picture.data, "base64"),
      );
    }
    await writeFile(
      path.join(work, `${name}.json`),
      JSON.stringify(
        {
          frames,
          notes: response.content.filter((item) => item.type === "text"),
        },
        null,
        2,
      ),
    );
  };
  const resize = async (width, height) =>
    app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setMinimumSize(390, 600);
        window.setSize(size.width, size.height);
        if (size.width >= 1100) window.setMinimumSize(1100, 760);
      },
      { width, height },
    );
  const capturePanel = async (selector, name, anchor) => {
    const panel = page.locator(selector);
    await resize(1440, 960);
    if (anchor)
      await panel
        .locator(anchor)
        .evaluate((element) => element.scrollIntoView({ block: "start" }));
    else
      await panel.evaluate((element) => {
        element.scrollTop = 0;
      });
    await page.screenshot({
      animations: "disabled",
      path: path.join(work, `${name}-1440.png`),
    });
    await resize(390, 844);
    const style = await page.addStyleTag({
      content: `body{min-width:0!important}body *{visibility:hidden}${selector},${selector} *{visibility:visible}${selector}{position:fixed!important;inset:0!important;width:390px!important;height:844px!important;box-sizing:border-box!important;z-index:99999;background:#141417}`,
    });
    try {
      if (anchor)
        await panel
          .locator(anchor)
          .evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.screenshot({
        animations: "disabled",
        path: path.join(work, `${name}-390.png`),
      });
      const dimensions = await panel.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
      assert(
        dimensions.scrollWidth <= dimensions.clientWidth + 1,
        `${name} has horizontal overflow: ${JSON.stringify(dimensions)}`,
      );
      if (anchor) {
        await panel
          .getByRole("group", { name: "Proof shot 2", exact: true })
          .evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.screenshot({
          animations: "disabled",
          path: path.join(work, `${name}-390-second-shot.png`),
        });
      }
      report[`${name}Panel`] = {
        ...dimensions,
        note: "Actual panel isolated at 390px; full desktop editor retains its 1100px minimum.",
      };
    } finally {
      await style.evaluate((element) => element.remove());
      await resize(1440, 960);
    }
  };
  const assertCaptions = (current, label) => {
    const captions = current.clips.filter((clip) => clip.kind === "caption");
    assert(captions.length > 3, `${label}: generated captions missing`);
    for (const caption of captions) {
      const sourceClip = current.clips.find(
        (clip) => clip.id === caption.captionSourceId,
      );
      assert(sourceClip, `${label}: caption source linkage missing`);
      assert(
        caption.start >= sourceClip.start &&
          caption.start + caption.duration <=
            sourceClip.start + sourceClip.duration,
        `${label}: caption is outside source timing`,
      );
      assert(
        caption.x >= 0 &&
          caption.y >= 0 &&
          caption.x + caption.width <= current.width + 1 &&
          caption.y + caption.height <= current.height + 1,
        `${label}: caption box is outside canvas`,
      );
      const layout = captionLayout(caption);
      assert(
        layout.contentWidth <= caption.width - 2 * layout.paddingX + 1,
        `${label}: caption text exceeds its width`,
      );
      assert(
        layout.contentHeight <= caption.height - 2 * layout.paddingY + 1,
        `${label}: caption text exceeds its height`,
      );
      for (const word of caption.words) {
        assert(
          word.end > word.start &&
            word.start >= 0 &&
            word.end <= caption.duration / current.fps + 1 / current.fps,
          `${label}: word timing exceeds the caption`,
        );
      }
    }
    return captions.length;
  };
  const assertProof = (current, label) => {
    const proofs = current.clips.filter((clip) => clip.assetId === screen.id);
    assert.equal(
      proofs.length,
      2,
      `${label}: expected exactly two explicit proof shots`,
    );
    const split = proofs.find((clip) => clip.start === 2 * current.fps);
    const cutaway = proofs.find((clip) => clip.start === 8 * current.fps);
    assert(split && cutaway, `${label}: proof timing changed`);
    const proofTrack = current.tracks.find(
      (track) => track.name === "Reel · proof screens",
    );
    const speakerTrack = current.tracks.find(
      (track) => track.name === "Reel · proof speaker",
    );
    assert(
      proofTrack?.muted && speakerTrack?.muted,
      `${label}: proof layers are not independently muted`,
    );
    const speakerCopies = current.clips.filter(
      (clip) => clip.trackId === speakerTrack.id,
    );
    assert.equal(
      speakerCopies.length,
      1,
      `${label}: split view needs one muted speaker copy; cutaway needs none`,
    );
    assert.equal(speakerCopies[0].start, split.start);
    assert.equal(speakerCopies[0].duration, split.duration);
    assert.equal(speakerCopies[0].volume, 0);
    assert.equal(speakerCopies[0].sourceIn, 2);
    assert.equal(speakerCopies[0].y, Math.round(current.height * 0.6));
    assert.equal(split.height, Math.round(current.height * 0.48));
    assert(
      speakerCopies[0].y > split.height,
      `${label}: split view must leave an actual divider for captions`,
    );
    assert.equal(speakerCopies[0].y + speakerCopies[0].height, current.height);
    const canvasMotion = current.motions.find(
      (motion) =>
        motion.source === "reel:proof-backdrop" &&
        current.clips.some((clip) => clip.motionId === motion.id),
    );
    assert(
      canvasMotion?.layers.some(
        (layer) => layer.name === "Opaque proof canvas" && layer.opacity === 1,
      ),
      `${label}: proof needs an opaque editable canvas`,
    );
    assert.equal(
      current.clips.filter((clip) => clip.motionId === canvasMotion.id).length,
      2,
    );
    for (const proof of proofs) {
      assert.equal(
        proof.duration,
        3 * current.fps,
        `${label}: proof duration changed`,
      );
      assert.equal(proof.volume, 0, `${label}: proof footage must stay muted`);
      assert.equal(
        proof.fit,
        "contain",
        `${label}: screen evidence must not crop controls`,
      );
      assert.equal(proof.trackId, proofTrack.id);
      for (const caption of current.clips.filter(
        (clip) =>
          clip.kind === "caption" &&
          clip.start < proof.start + proof.duration &&
          clip.start + clip.duration > proof.start,
      )) {
        const first = Math.max(caption.start, proof.start);
        const last = Math.min(
          caption.start + caption.duration,
          proof.start + proof.duration,
        );
        for (let frame = first; frame < last; frame++) {
          // evaluatedClip consumes clip-relative frames and accounts for an
          // existing animationOffset, exactly as the renderer does.
          const effective = evaluatedClip(caption, frame - caption.start);
          if (proof.id === split.id) {
            assert(
              effective.y >= split.y + split.height - 1 &&
                effective.y + effective.height <= speakerCopies[0].y + 1,
              `${label}: split caption enters screen or speaker at frame ${frame}`,
            );
          } else {
            assert(
              effective.y >= cutaway.y + cutaway.height &&
                effective.y + effective.height <= current.height * 0.91,
              `${label}: cutaway caption enters screen or bottom interface region at frame ${frame}`,
            );
          }
        }
      }
    }
    assert(
      split.height < current.height * 0.8,
      `${label}: split proof did not leave speaker space`,
    );
    assert(
      cutaway.height > split.height,
      `${label}: cutaway proof did not grow beyond split layout`,
    );
    for (const caption of current.clips.filter(
      (clip) => clip.kind === "caption",
    )) {
      for (
        let frame = caption.start;
        frame < caption.start + caption.duration;
        frame++
      ) {
        if (
          proofs.some(
            (proof) =>
              proof.start <= frame && frame < proof.start + proof.duration,
          )
        )
          continue;
        assert.equal(
          evaluatedClip(caption, frame - caption.start).y,
          Math.round(current.height * 0.65),
          `${label}: caption did not return to its speaker position at frame ${frame}`,
        );
      }
    }
    // Every output frame must have exactly one audible original source. A
    // muted speaker copy for split composition must not double the narration.
    const audible = current.clips.filter(
      (clip) =>
        clip.assetId === speaker.id &&
        clip.volume > 0 &&
        !current.tracks.find((track) => track.id === clip.trackId)?.muted,
    );
    for (let frame = 0; frame < 15 * current.fps; frame++) {
      const active = audible.filter(
        (clip) => clip.start <= frame && clip.start + clip.duration > frame,
      );
      assert.equal(
        active.length,
        1,
        `${label}: missing or duplicated original voice at frame ${frame}`,
      );
      const clip = active[0];
      assert(
        Math.abs(
          clip.sourceIn +
            ((frame - clip.start) / current.fps) * clip.speed -
            frame / current.fps,
        ) <
          1 / current.fps,
        `${label}: source continuity changed at frame ${frame}`,
      );
    }
    return proofs.map(({ id, start, duration, x, y, width, height, fit }) => ({
      id,
      start,
      duration,
      x,
      y,
      width,
      height,
      fit,
    }));
  };

  const tools = await client.listTools();
  const reel = tools.tools.find((tool) => tool.name === "cutline_create_reel");
  const reelOptions = reel.inputSchema.properties.options.properties;
  for (const format of ["creator-punch", "screen-demo"])
    assert(
      reelOptions.format.enum.includes(format),
      `${format} missing from MCP schema`,
    );
  assert.equal(reelOptions.proofBeats.maxItems, 24);
  const proofSchema = reelOptions.proofBeats.items.properties;
  assert(
    proofSchema.sourceIndex &&
      proofSchema.sourceSeconds &&
      proofSchema.assetId &&
      proofSchema.sourceIn &&
      proofSchema.durationSeconds,
  );
  assert.deepEqual(proofSchema.layout.enum, ["split", "cutaway"]);
  const autoOptions = tools.tools.find(
    (tool) => tool.name === "cutline_auto_edit",
  ).inputSchema.properties.options.properties;
  for (const format of ["creator-punch", "screen-demo"])
    assert(autoOptions.format.enum.includes(format));
  report.schema = {
    formats: reelOptions.format.enum,
    proofBeats: reelOptions.proofBeats,
  };
  log(
    "MCP exposes both creator formats and complete source-timed split/cutaway proof options.",
  );

  await resize(1440, 960);
  await page.getByRole("button", { name: "Reel", exact: true }).click();
  await page
    .getByRole("button", { name: "Build manually", exact: true })
    .click();
  const wizard = page.locator(".reel-builder");
  await wizard
    .locator(".reel-source")
    .filter({ hasText: path.basename(source) })
    .getByRole("checkbox")
    .check();
  await wizard
    .getByRole("button", { name: "Continue to style", exact: false })
    .click();
  await wizard
    .getByLabel("Reel format", { exact: false })
    .selectOption("screen-demo");
  await wizard.getByLabel("Target length").selectOption("15");
  for (const [index, proof] of [
    { time: "2", layout: "split" },
    { time: "8", layout: "cutaway" },
  ].entries()) {
    await wizard
      .getByRole("button", { name: "Add proof shot", exact: true })
      .click();
    const row = wizard.getByRole("group", {
      name: `Proof shot ${index + 1}`,
      exact: true,
    });
    await row
      .getByLabel("Source clip", { exact: false })
      .selectOption(speaker.id);
    await row
      .getByLabel("Proof image or video", { exact: false })
      .selectOption(screen.id);
    await row.getByLabel("Show at (seconds)", { exact: true }).fill(proof.time);
    await row.getByLabel("Duration (seconds)", { exact: true }).fill("3");
    await row.getByLabel("Layout", { exact: false }).selectOption(proof.layout);
  }
  // A bad source time must stop the actual UI submission, then editing the
  // same row must recover without throwing away the rest of the draft.
  const secondProof = wizard.getByRole("group", {
    name: "Proof shot 2",
    exact: true,
  });
  await secondProof.getByLabel("Show at (seconds)", { exact: true }).fill("99");
  await wizard
    .getByRole("button", { name: "Continue to finishing", exact: false })
    .click();
  assert(
    await wizard
      .getByRole("button", { name: "Build Reel", exact: true })
      .isDisabled(),
    "Out-of-range proof time did not block Build Reel",
  );
  await wizard
    .getByRole("button", { name: "Edit proof shots", exact: true })
    .click();
  await secondProof.getByLabel("Show at (seconds)", { exact: true }).fill("8");
  await capturePanel(".reel-builder", "proof-shots", ".reel-proofs h4");
  await wizard
    .getByRole("button", { name: "Continue to finishing", exact: false })
    .click();
  await wizard
    .getByLabel("Background music", { exact: false })
    .selectOption("");
  assert.equal(
    await wizard.getByLabel("Timeline", { exact: false }).inputValue(),
    "append",
  );
  await wizard.getByLabel("Timeline", { exact: false }).selectOption("replace");
  await wizard.getByRole("button", { name: "Build Reel", exact: true }).click();
  await wizard
    .getByText("Your screen demo edit is ready", { exact: true })
    .waitFor({ timeout: 240000 });
  assert.match(
    await wizard.locator(".reel-result").textContent(),
    /2 proof shots/,
  );
  p = await project();
  assert(
    p.assets.find((asset) => asset.id === speaker.id).words.length > 15,
    "Real local transcription did not generate aligned speech",
  );
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert.equal(
    Math.max(...p.clips.map((clip) => clip.start + clip.duration)),
    15 * p.fps,
  );
  report.manualProof = assertProof(p, "UI screen demo");
  report.manualCaptionCount = assertCaptions(p, "UI screen demo");
  report.captionPositionKeys = p.clips
    .filter(
      (clip) =>
        clip.kind === "caption" &&
        clip.keyframes.some((key) => key.property === "y"),
    )
    .map(({ text, start, duration, keyframes }) => ({
      text,
      start,
      duration,
      keyframes,
    }));
  report.manualQuality = await call("cutline_quality_check");
  assert.equal(
    report.manualQuality.summary.errorCount,
    0,
    JSON.stringify(report.manualQuality.issues),
  );
  const created = structuredClone(p);
  await writeFile(
    path.join(work, "Manual-screen-demo.cutline"),
    JSON.stringify({ project: created, past: [], future: [] }),
  );
  log(
    "UI rejects invalid proof timing, recovers the draft, and builds two editable proof layouts with real local captions and one uninterrupted voice.",
  );

  await invoke("undo");
  const undone = await project();
  assert.deepEqual(
    undone.clips,
    before.clips,
    "Undo did not restore the original timeline",
  );
  assert.deepEqual(
    undone.tracks,
    before.tracks,
    "Undo did not restore the original track layout",
  );
  await invoke("redo");
  const redone = await project();
  assert.deepEqual(redone.clips, created.clips);
  assert.deepEqual(redone.motions, created.motions);
  log(
    "One Undo restores the previous edit; one Redo restores all proof, caption and native animation clips.",
  );

  const proofFrames = [15, 54, 60, 90, 147, 150, 237, 240, 270, 327, 330, 435];
  await savePreview("screen-demo-preview-contact", proofFrames);
  const longestCaption = [
    ...created.clips.filter((clip) => clip.kind === "caption"),
  ].sort((a, b) => b.text.length - a.text.length)[0];
  await savePreview("longest-caption-preview", [
    longestCaption.start,
    longestCaption.start + Math.floor(longestCaption.duration / 2),
  ]);
  report.previewFrames = proofFrames;
  report.longestCaption = {
    text: longestCaption.text,
    start: longestCaption.start,
    duration: longestCaption.duration,
  };

  const current = await project();
  const creatorResult = await call("cutline_create_reel", {
    projectId: current.id,
    revision: current.revision,
    options: {
      sources: [{ assetId: speaker.id }],
      targetSeconds: 15,
      mode: "replace",
      format: "creator-punch",
      captions: true,
      proofBeats: [
        {
          sourceIndex: 0,
          sourceSeconds: 2,
          assetId: screen.id,
          durationSeconds: 3,
          layout: "split",
        },
        {
          sourceIndex: 0,
          sourceSeconds: 8,
          assetId: screen.id,
          durationSeconds: 3,
          layout: "cutaway",
        },
      ],
    },
  });
  const creatorSummary = await waitJob(creatorResult);
  assert.equal(
    creatorSummary.proofCount,
    2,
    "MCP result omitted the explicit proof count",
  );
  const punch = await project();
  report.creatorPunchProof = assertProof(punch, "MCP creator punch");
  report.creatorPunchCaptionCount = assertCaptions(punch, "MCP creator punch");
  assert(
    punch.clips.some(
      (clip) =>
        clip.assetId === speaker.id &&
        clip.keyframes.some((key) => key.property === "scale" && key.value > 1),
    ),
    "Creator punch-in animation missing",
  );
  await savePreview(
    "creator-punch-preview-contact",
    [15, 59, 69, 138, 150, 239, 249, 318, 330, 435],
  );
  await writeFile(
    path.join(work, "MCP-creator-punch.cutline"),
    JSON.stringify({ project: punch, past: [], future: [] }),
  );
  log(
    "MCP builds Creator punch with editable emphasis, linked captions and the same two explicit proof shots.",
  );

  await page.getByRole("button", { name: "Auto edit", exact: true }).click();
  const auto = page.locator(".auto-reel");
  await auto.getByLabel("Automatic Reel format").selectOption("creator-punch");
  await auto
    .getByRole("checkbox", { name: "Relevant B-roll", exact: false })
    .uncheck();
  await auto
    .getByRole("checkbox", { name: "Original music", exact: false })
    .uncheck();
  await auto
    .getByRole("checkbox", { name: "Opening title", exact: false })
    .uncheck();
  await auto.getByLabel("Length", { exact: false }).selectOption("15");
  await capturePanel(".auto-reel", "auto-creator-punch");
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
  report.autoCaptionCount = assertCaptions(automatic, "Auto creator punch");
  assert(
    automatic.assets.some(
      (asset) => asset.kind === "video" && asset.words?.length > 15,
    ),
    "Auto edit did not retain real speech alignment",
  );
  assert(
    automatic.clips.some(
      (clip) =>
        clip.kind === "video" &&
        clip.keyframes.some((key) => key.property === "scale" && key.value > 1),
    ),
    "Auto edit dropped creator punch-ins",
  );
  assert(
    !automatic.clips.some((clip) => clip.kind === "audio"),
    "Auto edit added an unrequested music/voice track",
  );
  await writeFile(
    path.join(work, "Automatic-creator-punch.cutline"),
    JSON.stringify({ project: automatic, past: [], future: [] }),
  );
  log(
    "Auto edit runs the new creator format through local transcription and pause cutting with stock and music switched off.",
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
  const exportJob = await invoke("test.export", { path: output });
  const until = Date.now() + 600000;
  let exported;
  while (Date.now() < until) {
    exported = (await state()).jobs.find((job) => job.id === exportJob.id);
    if (exported?.state === "done") break;
    if (["error", "cancelled"].includes(exported?.state))
      throw Error(exported.message);
    await page.waitForTimeout(500);
  }
  assert.equal(exported?.state, "done", "Full 15-second export timed out");
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
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(video.codec_name, "h264");
  assert(
    probe.streams.some(
      (stream) => stream.codec_type === "audio" && stream.codec_name === "aac",
    ),
  );
  assert(Math.abs(Number(probe.format.duration) - 15) < 0.1);
  run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
  report.export = {
    width: video.width,
    height: video.height,
    codec: video.codec_name,
    duration: Number(probe.format.duration),
    fullDecode: true,
  };
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
      (_, index) => bytes.readInt16LE(index * 2) / 32768,
    );
  };
  const original = samples(source),
    rendered = samples(output);
  let correlation = -1,
    lagAtBest = 0;
  for (let lag = -40; lag <= 40; lag++) {
    let cross = 0,
      a2 = 0,
      b2 = 0;
    for (
      let index = 80;
      index < Math.min(original.length, rendered.length) - 80;
      index += 4
    ) {
      const a = original[index],
        b = rendered[index + lag];
      cross += a * b;
      a2 += a * a;
      b2 += b * b;
    }
    const value = cross / Math.sqrt(a2 * b2);
    if (value > correlation) {
      correlation = value;
      lagAtBest = lag;
    }
  }
  assert(correlation > 0.9, `Original voice correlation is ${correlation}`);
  report.audio = {
    correlation,
    lagSamplesAt8000Hz: lagAtBest,
    note: "Waveform correspondence validates source voice continuity, not a human listening review.",
  };
  for (const [index, frame] of proofFrames.entries()) {
    run(ffmpeg, [
      "-y",
      "-v",
      "error",
      "-ss",
      String(frame / created.fps),
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "scale=360:640",
      path.join(work, `export-frame-${String(index).padStart(2, "0")}.png`),
    ]);
  }
  run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-framerate",
    "1",
    "-i",
    path.join(work, "export-frame-%02d.png"),
    "-vf",
    "tile=4x3:nb_frames=12:padding=8:margin=8:color=0x17191c",
    "-frames:v",
    "1",
    path.join(work, "screen-demo-export-contact.png"),
  ]);
  report.externalRequests = await app.evaluate(
    () => globalThis.__creatorQaExternalRequests,
  );
  assert.deepEqual(
    report.externalRequests,
    [],
    "A local-only QA workflow tried an external request",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  log(
    `Full export decodes at 1080x1920 H.264/AAC for 15 seconds; original voice correlation ${correlation.toFixed(4)}. Before/during/after proof frames are saved.`,
  );
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(report, null, 2),
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
        ...report,
        message: error.message,
        stack: error.stack,
        windowUrls: app?.windows().map((window) => window.url()) ?? [],
      },
      null,
      2,
    ),
  );
  console.error("Creator shorts QA artifacts:", work);
  throw error;
} finally {
  // These jobs and this process belong only to the disposable test instance.
  if (invoke) {
    const pending = await invoke("state").catch(() => undefined);
    for (const job of pending?.jobs ?? []) {
      if (["queued", "running"].includes(job.state))
        await invoke("job.cancel", { id: job.id }).catch(() => {});
    }
  }
  await client?.close().catch(() => {});
  if (app) {
    const appProcess = app.process();
    const stop = setTimeout(() => appProcess?.kill("SIGTERM"), 10000);
    stop.unref();
    await app
      .close()
      .catch(() => {
        appProcess?.kill("SIGTERM");
      })
      .finally(() => clearTimeout(stop));
  }
}
