import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

// Run AFTER the source build, through one-at-a-time. No dev server is started.
//   one-at-a-time node scripts/qa-motion-direction.mjs
// Optional live, key-free Openverse retrieval/import:
//   CUTLINE_QA_OPENVERSE=1 one-at-a-time node scripts/qa-motion-direction.mjs
// Optional packaged runtime: CUTLINE_INSTALLED=1 or CUTLINE_APP=/path/Cutline.app.
// One isolated Electron, low-resolution technical fixtures, always closed.
// The source is synthetic color blocks + a tone, not presenter footage or VO.
const root = process.cwd();
const creatorStudio = process.env.CUTLINE_CREATOR_STUDIO === "1";
const installed =
  process.env.CUTLINE_INSTALLED === "1" || Boolean(process.env.CUTLINE_APP);
const appFolder = path.resolve(
  process.env.CUTLINE_APP ?? "/Applications/Cutline.app",
);
const outputRoot = path.resolve(
  process.env.CUTLINE_MOTION_QA_RESULTS ??
    path.join(root, "../../qa-motion-direction"),
);
await mkdir(outputRoot, { recursive: true });
const work = await mkdtemp(path.join(outputRoot, "run-"));
const data = path.join(work, "data");
const fixture = path.join(work, "Motion-direction.cutline");
const source = path.join(work, "Synthetic source.mp4");
const proof = path.join(work, "Moving proof.mp4");
const still = path.join(work, "Proof still.png");
const output = path.join(work, "Motion-direction-technical-fixture.mp4");
const scenesOutput = path.join(
  work,
  creatorStudio
    ? "Creator-studio-style-study.mp4"
    : "Editorial-scenes-technical-fixture.mp4",
);
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
const results = [],
  errors = [],
  consoleErrors = [];
const report = {
  installed,
  work,
  fixture,
  output,
  scenesOutput,
  results,
  errors,
  consoleErrors,
  fixtureDescription:
    "12 seconds, 360x640, synthetic source blocks with a test tone; moving color-pattern proof. Technical fixture only.",
  reviewBoundary:
    "Real MCP schema, native timeline, source-audio continuity, rendered preview images, real Effects controls, isolated 390px panels, exported MP4 probe and full decode. No subjective audio or creative quality claim.",
};
const log = (message) => {
  results.push(message);
  console.log(message);
};
let app, client, page, invoke;
try {
  run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x233944:s=360x640:r=30:d=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=12",
    "-vf",
    "drawbox=x=125:y=170:w=110:h=120:color=0xe5b793:t=fill,drawbox=x=65:y=310:w=230:h=265:color=0x648a98:t=fill",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-t",
    "12",
    source,
  ]);
  run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    proof,
  ]);
  run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-ss",
    "3",
    "-i",
    proof,
    "-frames:v",
    "1",
    still,
  ]);
  const bundled = await build({
    stdin: {
      contents:
        'export {newProject,makeClip} from "./src/shared/model.ts"; export {createMotionScene} from "./src/shared/motion-presets.ts"; export {applyCommands} from "./src/shared/commands.ts";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, makeClip, createMotionScene, applyCommands } =
    await import(
      `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
    );
  const initial = {
    ...newProject(),
    name: "Motion direction technical QA",
    width: 360,
    height: 640,
  };
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
      ? path.join(appFolder, "Contents/MacOS/Cutline")
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
  assert.equal(report.runtime.packaged, installed);
  assert.equal(
    report.runtime.appPath,
    installed ? path.join(appFolder, "Contents/Resources/app") : root,
  );
  assert.equal(
    report.runtime.version,
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  );
  assert.equal(path.resolve(report.runtime.userData), path.resolve(data));
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar", { timeout: 120000 });
  invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const project = async () => (await invoke("state")).snapshot.project;
  const speakerAsset = await invoke("test.import", { path: source });
  const proofAsset = await invoke("test.import", { path: proof });
  const stillAsset = await invoke("test.import", { path: still });
  let p = await project();
  p.clips = [
    {
      ...makeClip(
        p,
        "video",
        p.tracks.find((track) => track.kind === "video").id,
        0,
        speakerAsset,
      ),
      duration: 360,
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
  client = new Client({ name: "motion-direction-qa", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${connection.base}/mcp/local`)),
  );
  const inventory = (await client.listTools()).tools;
  const schemas = new Map(
    inventory.map((tool) => [tool.name, tool.inputSchema]),
  );
  const argsFor = (name, args) =>
    schemas.get(name)?.properties?.sessionId
      ? { sessionId: "main", ...args }
      : args;
  const call = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: argsFor(name, args) },
      undefined,
      { timeout: 240000 },
    );
    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert(!response.isError, `${name}: ${text}`);
    return JSON.parse(text);
  };
  const guard = async () => {
    const current = await project();
    return { projectId: current.id, revision: current.revision };
  };
  const waitResult = async (started) => {
    if (!started.pending && !started.jobId && started.state !== "running")
      return started;
    const id = started.jobId ?? started.id;
    assert(id, "Pending job has no ID");
    const until = Date.now() + 240000;
    while (Date.now() < until) {
      const value = await call("cutline_jobs", { id, waitSeconds: 10 });
      const job =
        (Array.isArray(value) ? value : (value.jobs ?? [value])).find(
          (item) => item.id === id,
        ) ?? value;
      if (job.state === "done") return job.result ?? job;
      assert(!["error", "cancelled"].includes(job.state), JSON.stringify(job));
    }
    throw Error(`Job ${id} timed out`);
  };
  const saveProject = async (name) =>
    writeFile(
      path.join(work, `${name}.cutline`),
      JSON.stringify({ project: await project(), past: [], future: [] }),
    );
  const preview = async (name, frames) => {
    const response = await client.callTool(
      {
        name: "cutline_preview",
        arguments: argsFor("cutline_preview", {
          ...(await guard()),
          frames,
          image: true,
          width: 216,
        }),
      },
      undefined,
      { timeout: 240000 },
    );
    assert(
      !response.isError,
      JSON.stringify(response.content.filter((item) => item.type === "text")),
    );
    const images = response.content.filter((item) => item.type === "image");
    assert(images.length > 0, "No preview image returned");
    for (const [index, image] of images.entries())
      await writeFile(
        path.join(
          work,
          `${name}${index ? `-${index}` : ""}.${image.mimeType === "image/png" ? "png" : "jpg"}`,
        ),
        Buffer.from(image.data, "base64"),
      );
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
  const resize = (width, height) =>
    app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setMinimumSize(390, 600);
        window.setSize(size.width, size.height);
      },
      { width, height },
    );
  const capturePanel = async (selector, name) => {
    await resize(1440, 960);
    const panel = page.locator(selector);
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
      await page.screenshot({
        animations: "disabled",
        path: path.join(work, `${name}-390.png`),
      });
      const size = await panel.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
      report[`${name}Panel`] = {
        ...size,
        note: "Actual panel isolated at 390px; full desktop editor retains its minimum size.",
      };
      assert(
        size.scrollWidth <= size.clientWidth + 1,
        `${name}: horizontal overflow ${JSON.stringify(size)}`,
      );
    } finally {
      await style.evaluate((element) => element.remove());
      await resize(1440, 960);
    }
  };
  if (process.env.CUTLINE_STYLE_ONLY !== "1") {
    const beatSchema =
      schemas.get("cutline_style_reel").properties.beats.items.properties;
    for (const field of [
      "entrance",
      "backdrop",
      "background",
      "emphasis",
      "framing",
      "sourceIn",
    ])
      assert(beatSchema[field], `${field} missing from real MCP schema`);
    assert.deepEqual(beatSchema.entrance.enum, [
      "cut",
      "fade",
      "rise",
      "slide-left",
      "pop",
    ]);
    report.schema = beatSchema;
    log(
      "Real MCP schema exposes authored entrance, backdrop, framing, source timing and emphasis.",
    );

    const legacyBeats = Array.from({ length: 4 }, (_, index) => ({
      from: index * 3,
      to: (index + 1) * 3,
      kind: "asset",
      show: stillAsset.id,
    }));
    report.legacy = await waitResult(
      await call("cutline_style_reel", {
        ...(await guard()),
        style: "split",
        beats: legacyBeats,
      }),
    );
    const legacy = await project();
    assert(legacy.motions.some((motion) => motion.name === "Ring ripple"));
    await saveProject("Legacy-before");
    await preview(
      "legacy-before-contact",
      [0, 3, 8, 45, 90, 93, 98, 135, 180, 225, 270, 315],
    );
    const authoredBeats = [
      {
        from: 0,
        to: 2.4,
        layout: "full",
        kind: "text",
        show: "One clear idea",
        entrance: "cut",
        backdrop: "plain",
        background: "#101820",
        emphasis: "none",
      },
      {
        from: 2.4,
        to: 5,
        layout: "full",
        kind: "asset",
        show: proofAsset.id,
        sourceIn: 2,
        framing: "contain",
        entrance: "fade",
        backdrop: "plain",
        background: "#F3EEE4",
        emphasis: "none",
      },
      { from: 5, to: 6, layout: "face", entrance: "cut", emphasis: "none" },
      {
        from: 6,
        to: 9,
        layout: "split",
        kind: "asset",
        show: proofAsset.id,
        sourceIn: 7,
        framing: "fill",
        entrance: "slide-left",
        backdrop: "grid",
        background: "#E7EDF1",
        emphasis: "none",
      },
      {
        from: 9,
        to: 12,
        layout: "full",
        kind: "text",
        show: "Show the result",
        entrance: "rise",
        backdrop: "plain",
        background: "#F3EEE4",
        emphasis: "none",
      },
    ];
    report.authored = await waitResult(
      await call("cutline_style_reel", {
        ...(await guard()),
        style: "split",
        beats: authoredBeats,
      }),
    );
    p = await project();
    assert(
      !p.motions.some((motion) => motion.name === "Ring ripple"),
      "Explicit direction leaked legacy ripple",
    );
    const proofs = p.clips.filter((clip) => clip.assetId === proofAsset.id);
    assert.deepEqual(
      proofs.map((clip) => clip.sourceIn).sort((a, b) => a - b),
      [2, 7],
    );
    assert(proofs.every((clip) => clip.volume === 0));
    for (let frame = 0; frame < 360; frame++) {
      const audible = p.clips.filter(
        (clip) =>
          clip.assetId === speakerAsset.id &&
          clip.volume > 0 &&
          !p.tracks.find((track) => track.id === clip.trackId)?.muted &&
          clip.start <= frame &&
          clip.start + clip.duration > frame,
      );
      assert.equal(
        audible.length,
        1,
        `Missing/duplicated original source audio at frame ${frame}`,
      );
      const clip = audible[0];
      assert(
        Math.abs(
          clip.sourceIn +
            ((frame - clip.start) / p.fps) * clip.speed -
            frame / p.fps,
        ) <
          1 / p.fps,
        `Source discontinuity at frame ${frame}`,
      );
    }
    await saveProject("Authored-after");
    await preview(
      "authored-after-contact",
      [0, 3, 8, 45, 72, 76, 89, 120, 157, 183, 220, 305],
    );
    log(
      "Same project now has five authored composition beats, native motion, two continuing proof passages, and uninterrupted original source audio.",
    );

    await resize(1440, 960);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.locator(".timeline-clip.video").first().click();
    await page.getByRole("button", { name: "Effects", exact: true }).click();
    for (const look of ["studio", "soft-film", "crisp-mono", "studio"]) {
      await page
        .getByRole("button", { name: `Apply ${look} look`, exact: true })
        .click();
      await page
        .getByRole("button", { name: `Apply ${look} look`, exact: true })
        .evaluate((button) => {
          if (button.getAttribute("aria-pressed") !== "true")
            throw Error("Look did not select");
        });
      assert(
        (await project()).clips.some((clip) => clip.look === look),
        `${look} not persisted`,
      );
    }
    await capturePanel(".effects-library", "effects");
    await page.getByRole("button", { name: "Stock", exact: true }).click();
    await page
      .locator(".stock-library")
      .getByRole("button", { name: "Audio", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Stock provider", { exact: true }).inputValue(),
      "openverse",
    );
    assert(
      await page.getByLabel("Stock orientation", { exact: true }).isDisabled(),
    );
    await capturePanel(".stock-library", "stock-openverse-audio");
    log(
      "All three new native grades persist through real Effects controls; Effects and Openverse audio panels captured at 1440px and isolated 390px.",
    );

    if (process.env.CUTLINE_QA_OPENVERSE === "1") {
      report.openverse = {};
      try {
        const found = await call("cutline_stock_search", {
          query: "click",
          provider: "openverse",
          kind: "audio",
        });
        const items = found.items ?? found.videos ?? [];
        assert(items.length > 0, "No live Openverse audio results");
        const candidate =
          items.find((item) => item.duration >= 0.5 && item.duration <= 3) ??
          items[0];
        const imported = await waitResult(
          await call("cutline_stock_import", {
            ...(await guard()),
            id: candidate.id,
            provider: "openverse",
            kind: "audio",
            at: { seconds: 0.5 },
            duration: {
              seconds: Math.max(0.2, Math.min(1, candidate.duration || 1)),
            },
          }),
        );
        const current = await project();
        const asset = current.assets.find(
          (item) => item.id === imported.asset?.id,
        );
        assert(
          asset && asset.kind === "audio",
          "Openverse import did not land in the media library",
        );
        const placed = current.clips.find((clip) => clip.assetId === asset.id);
        assert(
          placed && placed.kind === "audio",
          "Openverse sound did not land on the timeline",
        );
        const track = current.tracks.find((item) => item.id === placed.trackId);
        assert(
          track && track.kind === "audio" && !track.muted && !track.hidden,
          "Openverse sound track is not audible",
        );
        assert(
          placed.volume > 0 && placed.volume <= 0.5,
          "Sound needs a conservative audible starting level",
        );
        assert.equal(placed.start, 15);
        assert.equal(
          placed.fadeIn,
          Math.min(2, Math.floor(placed.duration / 4)),
        );
        assert.equal(
          placed.fadeOut,
          Math.min(3, Math.floor(placed.duration / 4)),
        );
        assert.equal(asset.origin?.provider, "Openverse");
        assert(
          asset.origin?.page &&
            asset.origin?.license &&
            asset.origin?.licenseUrl &&
            asset.origin?.creator,
          "Openverse provenance is incomplete",
        );
        report.openverse.audio = {
          status: "passed",
          resultId: candidate.id,
          imported,
          asset: {
            id: asset.id,
            name: asset.name,
            duration: asset.duration,
            origin: asset.origin,
          },
          placed: {
            id: placed.id,
            start: placed.start,
            duration: placed.duration,
            volume: placed.volume,
            fadeIn: placed.fadeIn,
            fadeOut: placed.fadeOut,
          },
          track: { id: track.id, kind: track.kind, muted: track.muted },
        };
        log(
          "Live Openverse audio search/import places an audible, faded sound on an audio track and preserves source/license metadata.",
        );
      } catch (error) {
        report.openverse.audio = {
          status: "unavailable",
          error: error.message,
        };
        console.error(
          `Openverse LIVE AUDIO CHECK UNAVAILABLE: ${error.message}`,
        );
      }
      try {
        const found = await call("cutline_stock_search", {
          query: "ocean",
          provider: "openverse",
          kind: "image",
        });
        const items = found.items ?? found.videos ?? [];
        assert(items.length > 0, "No live Openverse image results");
        const candidate =
          items.find((item) => /\.(png|jpe?g|webp)(?:\?|$)/i.test(item.url)) ??
          items[0];
        const imported = await waitResult(
          await call("cutline_stock_import", {
            ...(await guard()),
            id: candidate.id,
            provider: "openverse",
            kind: "image",
          }),
        );
        const current = await project();
        const asset =
          current.assets.find((item) => item.id === imported.assetId) ??
          current.assets.find(
            (item) =>
              item.origin?.provider === "Openverse" && item.kind === "image",
          );
        assert(
          asset?.kind === "image" && asset.origin?.licenseUrl,
          "Openverse photo or its license did not land",
        );
        report.openverse.image = {
          status: "passed",
          resultCount: items.length,
          firstResult: {
            id: candidate.id,
            title: candidate.title,
            license: candidate.license,
            page: candidate.page,
          },
          imported: {
            id: asset.id,
            origin: asset.origin,
            width: asset.width,
            height: asset.height,
          },
        };
        log(
          "Live Openverse photo search/import succeeds with retained source and license metadata.",
        );
      } catch (error) {
        report.openverse.image = {
          status: "unavailable",
          error: error.message,
        };
        console.error(
          `Openverse LIVE IMAGE CHECK UNAVAILABLE: ${error.message}`,
        );
      }
    } else
      report.openverse = {
        status: "skipped",
        enable: "CUTLINE_QA_OPENVERSE=1",
      };
    await saveProject("Authored-graded");
    await preview("graded-after-contact", [0, 45, 89, 120, 157, 220, 305, 350]);
    const started = await call("cutline_export", {
      ...(await guard()),
      path: output,
    });
    await waitResult(started);
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
    assert.equal(video.width, 360);
    assert.equal(video.height, 640);
    assert.equal(video.codec_name, "h264");
    assert(
      probe.streams.some(
        (stream) =>
          stream.codec_type === "audio" && stream.codec_name === "aac",
      ),
    );
    assert(Math.abs(Number(probe.format.duration) - 12) < 0.1);
    run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
    run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-i",
      output,
      "-vf",
      "fps=1,scale=180:-1,tile=4x3",
      "-frames:v",
      "1",
      path.join(work, "export-contact.jpg"),
    ]);
    report.export = {
      width: video.width,
      height: video.height,
      codec: video.codec_name,
      duration: Number(probe.format.duration),
      fullDecode: true,
    };
    log(
      "12-second native Reel MP4 exports at 360x640 with AAC, correct duration and full decode.",
    );
  }

  // These native schematic scenes exercise three different visual mechanisms.
  // They are not a recreation of any creator or evidence of a real product.
  let scenes = {
    ...newProject(),
    name: creatorStudio
      ? "Creator studio motion style study"
      : "Editorial mechanisms technical QA",
    width: creatorStudio ? 540 : 360,
    height: creatorStudio ? 960 : 640,
  };
  const sceneIds = creatorStudio
    ? ["studio-depth-proof", "studio-path-story", "studio-type-handoff"]
    : ["editorial-transfer", "editorial-compare", "editorial-focus"];
  for (const [index, id] of sceneIds.entries()) {
    const created = createMotionScene(scenes, index * 120, id, {
      durationFrames: 120,
    });
    scenes = applyCommands(scenes, {
      projectId: scenes.id,
      revision: scenes.revision,
      label: `Add ${id}`,
      commands: created.commands,
    });
  }
  assert.equal(scenes.motions.length, 3);
  assert.deepEqual(
    scenes.clips.map((clip) => [clip.start, clip.duration]),
    [
      [0, 120],
      [120, 120],
      [240, 120],
    ],
  );
  assert(scenes.motions.every((motion) => sceneIds.includes(motion.source)));
  const scenesFile = path.join(
    work,
    creatorStudio
      ? "Creator-studio-style-study.cutline"
      : "Editorial-scenes.cutline",
  );
  await writeFile(
    scenesFile,
    JSON.stringify({
      project: scenes,
      past: [],
      future: [],
      filePath: scenesFile,
    }),
  );
  await invoke("test.load", { path: scenesFile });
  const loadedScenes = await project();
  assert.equal(loadedScenes.id, scenes.id);
  assert.deepEqual(loadedScenes.motions, scenes.motions);
  if (creatorStudio) {
    await page.getByRole("button", { name: "Motion", exact: true }).click();
    await page.getByRole("tab", { name: "Scenes", exact: true }).click();
    await page
      .getByRole("button", { name: "Creator studio", exact: true })
      .click();
    report.creatorStudioLibrary = await page
      .locator(".motion-library")
      .evaluate((element) => ({
        category: [...element.querySelectorAll(".mg-filters button")]
          .filter((button) => button.getAttribute("aria-pressed") === "true")
          .map((button) => button.textContent),
        labels: [...element.querySelectorAll(".mg-tile")].map((button) =>
          button.getAttribute("aria-label"),
        ),
      }));
    assert.equal(
      await page
        .getByRole("button", { name: /^Add Creator studio \/.+ scene$/ })
        .count(),
      3,
      JSON.stringify(report.creatorStudioLibrary),
    );
    await capturePanel(".motion-library", "creator-studio-library");
  }
  await preview(
    "editorial-scenes-contact",
    [0, 20, 76, 119, 120, 150, 210, 239, 240, 266, 294, 359],
  );
  await waitResult(
    await call("cutline_export", { ...(await guard()), path: scenesOutput }),
  );
  const scenesProbe = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      scenesOutput,
    ]).toString(),
  );
  const scenesVideo = scenesProbe.streams.find(
    (stream) => stream.codec_type === "video",
  );
  assert.equal(scenesVideo.width, scenes.width);
  assert.equal(scenesVideo.height, scenes.height);
  assert.equal(scenesVideo.codec_name, "h264");
  assert(Math.abs(Number(scenesProbe.format.duration) - 12) < 0.1);
  run(ffmpeg, ["-v", "error", "-i", scenesOutput, "-f", "null", "-"]);
  run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-i",
    scenesOutput,
    "-vf",
    "fps=1,scale=180:-1,tile=4x3",
    "-frames:v",
    "1",
    path.join(work, "editorial-scenes-export-contact.jpg"),
  ]);
  report.editorialScenes = {
    sceneIds,
    project: scenesFile,
    output: scenesOutput,
    nativeMotionCount: loadedScenes.motions.length,
    nativeLayerCount: loadedScenes.motions.reduce(
      (sum, motion) => sum + motion.layers.length,
      0,
    ),
    width: scenesVideo.width,
    height: scenesVideo.height,
    duration: Number(scenesProbe.format.duration),
    fullDecode: true,
    previewFrames: [0, 20, 76, 119, 120, 150, 210, 239, 240, 266, 294, 359],
  };
  log(
    `${creatorStudio ? "Creator studio scenes" : "Editorial mechanisms"} round-trip editable layers, render entrances/holds/cuts, export a separate 12-second MP4 and fully decode.`,
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(consoleErrors.length, 0, JSON.stringify(consoleErrors));
  log(
    `${process.env.CUTLINE_STYLE_ONLY === "1" ? "Style export" : "Both exports"} complete with zero renderer page/console errors. Subjective listening remains unreviewed.`,
  );
} catch (error) {
  report.failure = error.stack ?? error.message;
  process.exitCode = 1;
  console.error(report.failure);
  await page
    ?.screenshot({ path: path.join(work, "failure.png") })
    .catch(() => {});
} finally {
  await writeFile(
    path.join(work, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await client?.close().catch(() => {});
  await app?.close().catch(() => {});
  console.log(`QA artifacts: ${work}`);
}
