import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

// Run from the repository root after building. Every project and app-data file
// is disposable. One Electron instance and one export run at a time. No hosted
// services, generated audio, stock assets, or user recovery files are involved.
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const outputParent = path.resolve(
  process.env.CUTLINE_PREMIUM_OUT ?? path.join(root, "../qa-premium-motion"),
);
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, "run-"));
const data = path.join(work, "user-data");
await mkdir(data, { recursive: true });
const executable =
  process.env.CUTLINE_EXECUTABLE ??
  path.join(
    process.env.CUTLINE_APP ?? root,
    packaged
      ? process.env.CUTLINE_APP
        ? "Contents/MacOS/Cutline"
        : "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline"
      : "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: data,
  CUTLINE_RENDER_CONCURRENCY: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
const results = [];
const rendererErrors = [];
const consoleErrors = [];
const sceneIds = [
  "explainer-signal",
  "explainer-count",
  "explainer-compare",
  "explainer-focus",
  "explainer-reveal",
];
const sceneSamples = [
  [15, 65, 100],
  [12, 42, 100],
  [15, 65, 100],
  [15, 50, 85],
  [15, 55, 95],
];
let app;
let page;
let windowHandle;
let client;
let transport;
let runningExport;
let failure;
const serial = (value) => JSON.parse(JSON.stringify(value));
const log = (message, detail) => {
  results.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message, detail === undefined ? "" : JSON.stringify(detail));
};
const invoke = (name, args) =>
  page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
    name,
    args,
  });
const state = async () => (await invoke("state")).snapshot.project;
const waitProject = async (predicate, message) => {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const project = await state();
    if (predicate(project)) {
      await page.waitForTimeout(100);
      return project;
    }
    await page.waitForTimeout(70);
  }
  throw Error(message);
};
const launch = async (file, id) => {
  assert(!app, "Only one disposable Electron may run at a time");
  app = await electron.launch({
    executablePath: executable,
    args: packaged
      ? ["--force-color-profile=srgb", file]
      : [root, "--force-color-profile=srgb", file],
    env,
  });
  page = await app.firstWindow();
  windowHandle = await app.browserWindow(page);
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar");
  await waitProject(
    (project) => project.id === id,
    "Expected isolated project did not open",
  );
};
const close = async () => {
  if (client) await client.close().catch(() => {});
  client = undefined;
  if (transport) await transport.close().catch(() => {});
  transport = undefined;
  if (runningExport && page && !page.isClosed())
    await invoke("job.cancel", { id: runningExport }).catch(() => {});
  runningExport = undefined;
  if (app) await app.close();
  app = undefined;
  page = undefined;
  windowHandle = undefined;
};
// Main-process capture avoids Playwright/CDP viewport resizing, which can crash
// Electron on this Mac. Native supported window sizes are tested separately
// from phone-sized artwork, which is sampled from the actual exported movie.
const capture = async (name, selector) => {
  const box = selector ? await page.locator(selector).boundingBox() : undefined;
  if (selector) assert(box, `${selector} must have visible bounds`);
  const rect = box
    ? {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
        width: Math.max(1, Math.floor(box.width)),
        height: Math.max(1, Math.floor(box.height)),
      }
    : undefined;
  const encoded = await windowHandle.evaluate(
    async (win, area) =>
      (await win.webContents.capturePage(area)).toPNG().toString("base64"),
    rect,
  );
  const file = path.join(work, name);
  await writeFile(file, Buffer.from(encoded, "base64"));
  return file;
};
const resize = async (width, height) => {
  await windowHandle.evaluate((win, bounds) => win.setBounds(bounds), {
    width,
    height,
  });
  await page.waitForTimeout(250);
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert(
    layout.scrollWidth <= layout.width + 1,
    `Horizontal overflow: ${JSON.stringify(layout)}`,
  );
  assert(
    layout.scrollHeight <= layout.height + 1,
    `Vertical overflow: ${JSON.stringify(layout)}`,
  );
  return layout;
};
const openDetails = async (label) => {
  const summary = page
    .locator("summary")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first();
  if (!(await summary.evaluate((element) => element.parentElement.open)))
    await summary.click();
};
const commit = async (operation, message) => {
  const revision = (await state()).revision;
  await operation();
  return waitProject((project) => project.revision > revision, message);
};
const number = async (label, value) => {
  const input = page.getByLabel(label, { exact: true });
  if (Number(await input.inputValue()) === value) return;
  await commit(async () => {
    await input.fill(String(value));
    await input.press("Enter");
  }, `${label} did not commit`);
};
const text = async (label, value) => {
  const input = page.getByLabel(label, { exact: true });
  await commit(async () => {
    await input.fill(value);
    await input.press("Tab");
  }, `${label} did not commit`);
};
const choose = async (label, value) => {
  const input = page.getByLabel(label, { exact: true });
  if ((await input.inputValue()) === value) return;
  await commit(() => input.selectOption(value), `${label} did not commit`);
};
const check = async (label, value) => {
  const input = page.getByLabel(label, { exact: true });
  if ((await input.isChecked()) === value) return;
  // Controlled fields wait for the revision-checked IPC edit before React
  // paints the new value. setChecked asserts too early for that round trip.
  await commit(() => input.click(), `${label} did not commit`);
  await page.waitForFunction(
    ({ label, value }) =>
      [...document.querySelectorAll("input")].find(
        (input) => input.getAttribute("aria-label") === label,
      )?.checked === value,
    { label, value },
  );
};
const clickCommit = async (label) =>
  commit(
    () => page.getByRole("button", { name: label, exact: true }).click(),
    `${label} did not commit`,
  );
const seek = async (frame) => {
  await page.getByRole("button", { name: "Go to start", exact: true }).click();
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < Math.floor(frame / 10); i++)
    await page.keyboard.press("Shift+ArrowRight");
  for (let i = 0; i < frame % 10; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(180);
};
const media = (command, args, timeout = 120000) => {
  const result = spawnSync(command, args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message ?? result.stderr?.toString(),
  );
  return result.stdout;
};
const rawFrame = (file, frame) =>
  media(ffmpeg, [
    "-v",
    "error",
    "-threads",
    "1",
    "-i",
    file,
    "-vf",
    `select=eq(n\\,${frame}),scale=96:96`,
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
  assert(a.length > 0, "Decoded frame must contain pixels");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};
const mcp = async (name, args = {}, expectError = false) => {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (expectError) {
    assert(response.isError, `${name} should reject invalid fields`);
    return;
  }
  assert(!response.isError, `${name}: ${content}`);
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
};
const connectMcp = async () => {
  const connection = path.join(data, "connection.json");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await stat(connection).then(
        () => true,
        () => false,
      )
    )
      break;
    await page.waitForTimeout(50);
  }
  const launcher = (await invoke("state")).settings.mcpLauncher;
  assert.equal(
    typeof launcher,
    "string",
    "Isolated app must provide its MCP launcher",
  );
  client = new Client({ name: "cutline-premium-motion-qa", version: "1.0" });
  transport = new StdioClientTransport({
    command: launcher,
    args: [],
    env: { ...env, CUTLINE_CONNECTION: connection },
  });
  await client.connect(transport);
};
const exportVideo = async (file) => {
  assert(!runningExport, "Exports must run sequentially");
  const job = await invoke("test.export", { path: file });
  runningExport = job.id;
  const start = Date.now();
  let lastStatus = "";
  while (Date.now() - start < 600000) {
    const current = (await invoke("state")).jobs.find(
      (item) => item.id === job.id,
    );
    if (current?.state === "done") {
      runningExport = undefined;
      return (Date.now() - start) / 1000;
    }
    if (current?.state === "error" || current?.state === "cancelled")
      throw Error(current.message);
    if (current?.message && current.message !== lastStatus) {
      lastStatus = current.message;
      console.log(`Export ${path.basename(file)}: ${lastStatus}`);
    }
    await page.waitForTimeout(750);
  }
  throw Error("Native premium showcase export exceeded ten minutes");
};

try {
  const bundle = await build({
    stdin: {
      contents:
        'export {newProject} from "./src/shared/model.ts"; export {createMotionScene} from "./src/shared/motion-presets.ts"; export {applyCommands} from "./src/shared/commands.ts";',
      resolveDir: root,
      sourcefile: "qa-premium-fixtures.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { newProject, createMotionScene, applyCommands } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const initial = newProject();
  Object.assign(initial, {
    name: "Premium motion controls QA",
    width: 1080,
    height: 1920,
    fps: 30,
  });
  const editFile = path.join(work, "Premium motion controls QA.cutline");
  await writeFile(
    editFile,
    JSON.stringify({ project: initial, past: [], future: [] }),
  );
  await launch(editFile, initial.id);
  await resize(1440, 960);
  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Motion", exact: true })
    .click();
  await page.getByRole("tab", { name: "Shapes", exact: true }).click();
  await page
    .getByRole("button", { name: "Add Rectangle shape", exact: true })
    .click();
  let project = await waitProject(
    (p) => p.clips.length === 1 && p.motions.length === 1,
    "Motion library did not add a native shape",
  );
  const motionId = project.motions[0].id;
  const layer = (p) =>
    p.motions.find((motion) => motion.id === motionId).layers[0];
  await page.getByLabel("Select motion layer 1", { exact: true }).click();
  const initialKeys = serial(layer(project).keyframes);
  await openDetails("Motion path");
  await check("Follow a curved path", true);
  await number("First handle Y", -210);
  await number("End X", 320);
  await check("Rotate along path", true);
  await clickCommit("Animate path");
  project = await state();
  assert.equal(layer(project).motionPath.points.length, 4);
  assert.equal(layer(project).motionPath.points[1].y, -210);
  assert.equal(layer(project).motionPath.points[3].x, 320);
  assert.equal(layer(project).motionPath.autoOrient, true);
  assert(
    layer(project).keyframes.some(
      (key) => key.frame === 0 && key.pathProgress === 0,
    ),
  );
  assert(
    layer(project).keyframes.some(
      (key) => key.frame === 90 && key.pathProgress === 1,
    ),
  );
  for (const key of initialKeys)
    assert(
      layer(project).keyframes.some((item) =>
        Object.entries(key).every(([name, value]) => item[name] === value),
      ),
      "Path action must preserve existing entrance keys",
    );
  assert(
    await page
      .getByRole("img", { name: "Motion path shape", exact: true })
      .isVisible(),
  );
  await capture("controls-path-1440.png");
  log(
    "Curved-path controls commit editable points, auto-orientation and progress keys while preserving the entrance",
  );

  await openDetails("Reveal mask");
  await choose("Mask shape", "wipe-right");
  await clickCommit("Animate reveal");
  await choose("Mask shape", "iris");
  project = await state();
  assert.equal(layer(project).revealMask, "iris");
  assert(
    layer(project).keyframes.some((key) => key.frame === 0 && key.reveal === 0),
  );
  assert(
    layer(project).keyframes.some(
      (key) => key.frame === 90 && key.reveal === 1,
    ),
  );
  assert(layer(project).keyframes.some((key) => key.pathProgress === 1));
  await invoke("undo");
  await waitProject(
    (p) => layer(p).revealMask === "wipe-right",
    "Undo did not restore wipe mask",
  );
  await invoke("redo");
  await waitProject(
    (p) => layer(p).revealMask === "iris",
    "Redo did not restore iris mask",
  );
  await capture("controls-reveal-1440.png");
  log(
    "Wipe and iris masks animate natively, preserve path motion, and undo/redo exactly",
  );

  await choose("Layer type", "text");
  await openDetails("Number counter");
  await check("Animate a number", true);
  await number("Count from", 12.5);
  await number("Count to", 87.25);
  await number("Counter start (frames)", 8);
  await number("Counter duration (frames)", 52);
  await number("Decimal places", 2);
  await text("Before number", "+");
  await text("After number", " pts");
  await choose("Counter easing", "linear");
  assert.deepEqual(layer(await state()).counter, {
    from: 12.5,
    to: 87.25,
    startFrame: 8,
    durationFrames: 52,
    decimals: 2,
    prefix: "+",
    suffix: " pts",
    easing: "linear",
  });
  await capture("controls-counter-1440.png");
  log("Counter UI commits endpoints, timing, precision, affixes and easing");
  const desktop = await resize(1100, 760);
  await capture("controls-counter-1100.png");
  log("Controls fit the supported 1100px desktop window", desktop);
  await resize(1440, 960);

  await connectMcp();
  const inspected = await mcp("cutline_inspect", { detail: "full" });
  assert.equal(
    inspected.id,
    initial.id,
    "MCP must target the disposable project",
  );
  const schema = await mcp("cutline_editing_schema", {
    section: "motionLayer",
  });
  for (const field of [
    "motionPath",
    "pathProgress",
    "revealMask",
    "reveal",
    "counter",
  ])
    assert(JSON.stringify(schema).includes(field), `MCP schema omits ${field}`);
  const beforeOffsetMotion = serial(
    (await state()).motions.find((motion) => motion.id === motionId),
  );
  const setViaMcp = async (label, actions) => {
    const p = await state();
    await mcp("cutline_edit", {
      projectId: p.id,
      revision: p.revision,
      label,
      actions,
    });
    await waitProject(
      (next) => next.revision > p.revision,
      `${label} did not commit`,
    );
  };
  await seek(0);
  await setViaMcp("Set trimmed animation phase", [
    {
      type: "clip.update",
      clipId: (await state()).clips[0].id,
      patch: { animationOffset: 120 },
    },
  ]);
  await openDetails("Motion path");
  await clickCommit("Animate path");
  await openDetails("Reveal mask");
  await clickCommit("Animate reveal");
  project = await state();
  for (const property of ["pathProgress", "reveal"]) {
    assert(
      layer(project).keyframes.some(
        (key) => key.frame === 120 && key[property] === 0,
      ),
      `${property} must start at the trimmed phase`,
    );
    assert(
      layer(project).keyframes.some(
        (key) => key.frame === 210 && key[property] === 1,
      ),
      `${property} must end relative to the trimmed phase`,
    );
    assert(
      !layer(project).keyframes.some(
        (key) => key.frame === 0 && key[property] !== undefined,
      ),
      `${property} must not restart at curve frame zero`,
    );
  }
  const customAmountCurves = {
    pathProgress: [0.22, 0.8, 0.38, 1],
    reveal: [0.12, 0.4, 0.75, 1],
  };
  await setViaMcp("Author custom curves before live numeric edits", [
    ...Object.entries(customAmountCurves).map(([property, bezier]) => ({
      type: "motion.keyframe",
      motionId,
      layer: 0,
      property,
      frame: 135,
      value: 0.2,
      easing: "cubic-bezier",
      bezier,
    })),
    {
      type: "motion.keyframe",
      motionId,
      layer: 0,
      property: "opacity",
      frame: 135,
      value: 0.92,
      easing: "hold",
    },
  ]);
  await seek(15);
  await number("Path progress", 0.35);
  await number("Mask reveal", 0.6);
  project = await state();
  assert(
    layer(project).keyframes.some(
      (key) => key.frame === 135 && key.pathProgress === 0.35,
    ),
    "Live path amount must edit the current phase-aware key",
  );
  assert(
    layer(project).keyframes.some(
      (key) => key.frame === 135 && key.reveal === 0.6,
    ),
    "Live mask amount must edit the current phase-aware key",
  );
  for (const [property, bezier] of Object.entries(customAmountCurves)) {
    const key = layer(project).keyframes.find(
      (key) => key.frame === 135 && key[property] !== undefined,
    );
    assert.equal(
      key.easing,
      "cubic-bezier",
      `${property} must keep its custom easing`,
    );
    assert.deepEqual(
      key.bezier,
      bezier,
      `${property} must keep its Bezier handles`,
    );
  }
  assert(
    layer(project).keyframes.some(
      (key) =>
        key.frame === 135 && key.opacity === 0.92 && key.easing === "hold",
    ),
    "Live numeric edits must preserve sibling curves at the same frame",
  );
  await openDetails("Number counter");
  await check("Animate a number", false);
  await check("Animate a number", true);
  assert.equal(
    layer(await state()).counter.startFrame,
    120,
    "Counter must start at the trimmed animation phase",
  );
  await choose("Layer type", "rectangle");
  assert.equal(
    layer(await state()).counter,
    undefined,
    "Converting text to shape must clear its counter",
  );
  await choose("Layer type", "text");
  assert.equal(
    layer(await state()).counter,
    undefined,
    "Converting back to text must not revive the removed counter",
  );
  await setViaMcp("Restore control fixture after trimmed-phase check", [
    {
      type: "clip.update",
      clipId: (await state()).clips[0].id,
      patch: { animationOffset: 0 },
    },
    { type: "motion.put", motion: beforeOffsetMotion },
  ]);
  await seek(0);
  assert.deepEqual(serial(layer(await state())), beforeOffsetMotion.layers[0]);
  log(
    "Trimmed clips author phase-correct timing; live amounts preserve custom easing, Bezier handles and sibling curves; shape conversion clears the counter",
  );
  const currentGuard = await state();
  const beforeMcp = serial(layer(await state()));
  const actions = [
    {
      type: "motion.layer.update",
      motionId,
      layer: 0,
      patch: {
        revealMask: "wipe-up",
        motionPath: { ...beforeMcp.motionPath, autoOrient: false },
        counter: { ...beforeMcp.counter, to: 99.5 },
      },
    },
    {
      type: "motion.keyframe",
      motionId,
      layer: 0,
      property: "pathProgress",
      frame: 45,
      value: 0.5,
      easing: "linear",
    },
    {
      type: "motion.keyframe",
      motionId,
      layer: 0,
      property: "reveal",
      frame: 45,
      value: 0.75,
      easing: "linear",
    },
  ];
  await mcp("cutline_edit", {
    projectId: currentGuard.id,
    revision: currentGuard.revision,
    label: "Preview premium fields",
    actions,
    dryRun: true,
  });
  assert.deepEqual(
    serial(layer(await state())),
    beforeMcp,
    "MCP dry run must not mutate layers",
  );
  await mcp("cutline_edit", {
    projectId: currentGuard.id,
    revision: currentGuard.revision,
    label: "Edit premium fields",
    actions,
  });
  project = await waitProject(
    (p) => layer(p).counter.to === 99.5,
    "MCP fields did not commit",
  );
  assert.equal(layer(project).motionPath.autoOrient, false);
  assert.equal(layer(project).revealMask, "wipe-up");
  assert(
    layer(project).keyframes.some(
      (key) => key.frame === 45 && key.pathProgress === 0.5,
    ),
  );
  assert(
    layer(project).keyframes.some(
      (key) => key.frame === 45 && key.reveal === 0.75,
    ),
  );
  const afterMcp = serial(layer(project));
  await invoke("undo");
  await waitProject(
    (p) => JSON.stringify(layer(p)) === JSON.stringify(beforeMcp),
    "Atomic MCP edit did not undo in one step",
  );
  await invoke("redo");
  await waitProject(
    (p) => JSON.stringify(layer(p)) === JSON.stringify(afterMcp),
    "MCP redo failed",
  );
  project = await state();
  await mcp(
    "cutline_edit",
    {
      projectId: project.id,
      revision: project.revision,
      label: "Reject incomplete path",
      actions: [
        {
          type: "motion.layer.update",
          motionId,
          layer: 0,
          patch: { motionPath: { points: [{ x: 0, y: 0 }], autoOrient: true } },
        },
      ],
    },
    true,
  );
  assert.equal(
    (await state()).revision,
    project.revision,
    "Invalid MCP fields must not mutate revision",
  );
  log(
    "Real local MCP exposes, dry-runs and commits premium fields atomically and rejects an incomplete path",
  );

  await invoke("save");
  const saved = JSON.parse(await readFile(editFile, "utf8")).project;
  assert.deepEqual(saved.motions, serial((await state()).motions));
  await close();
  await launch(editFile, initial.id);
  assert.deepEqual(serial((await state()).motions), saved.motions);
  assert.deepEqual(serial((await state()).clips), saved.clips);
  log("Native premium edits survive saving and a full disposable app relaunch");

  for (const [format, width, height] of [
    ["portrait", 1080, 1920],
    ["landscape", 960, 540],
  ]) {
    let showcase = {
      ...newProject(),
      name: `Silent native motion showcase ${format}`,
      width,
      height,
      fps: 30,
    };
    for (const [index, id] of sceneIds.entries()) {
      const created = createMotionScene(showcase, index * 120, id, {
        durationFrames: 120,
      });
      showcase = applyCommands(showcase, {
        projectId: showcase.id,
        revision: showcase.revision,
        label: `Native showcase ${id}`,
        commands: created.commands,
      });
    }
    assert.equal(showcase.clips.length, 5);
    assert.equal(
      showcase.assets.length,
      0,
      "Showcase must not require remote or source media",
    );
    assert(
      showcase.clips.every((clip) => clip.kind === "text" && clip.motionId),
      "Showcase must remain native editable motion",
    );
    const projectFile = path.join(
      work,
      `Premium motion ${format} silent.cutline`,
    );
    await writeFile(
      projectFile,
      JSON.stringify({ project: showcase, past: [], future: [] }),
    );
    await invoke("test.load", { path: projectFile });
    await waitProject(
      (p) => p.id === showcase.id,
      `${format} showcase did not open`,
    );
    await resize(1440, 960);
    for (const [index, samples] of sceneSamples.entries()) {
      for (const localFrame of [samples[0], samples[2]]) {
        const frame = index * 120 + localFrame;
        await seek(frame);
        await capture(
          `${format}-preview-${sceneIds[index]}-${localFrame}.png`,
          ".canvas",
        );
      }
    }
    await capture(`${format}-editor-1440.png`);
    const output = path.join(work, `Premium motion ${format} silent.mp4`);
    const exportSeconds = await exportVideo(output);
    const metadata = JSON.parse(
      media(ffprobe, [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        output,
      ]).toString(),
    );
    const stream = metadata.streams.find((item) => item.codec_type === "video");
    assert.equal(stream?.codec_name, "h264");
    assert.equal(stream.width, width);
    assert.equal(stream.height, height);
    const timing = assertCfrExport(ffprobe, output, { fps: 30, frames: 600 });
    media(
      ffmpeg,
      [
        "-v",
        "error",
        "-xerror",
        "-threads",
        "1",
        "-i",
        output,
        "-f",
        "null",
        "-",
      ],
      180000,
    );
    const changes = [];
    for (const [index, samples] of sceneSamples.entries()) {
      const pixels = [];
      for (const localFrame of samples) {
        const frame = index * 120 + localFrame;
        pixels.push(rawFrame(output, frame));
        media(ffmpeg, [
          "-v",
          "error",
          "-y",
          "-threads",
          "1",
          "-i",
          output,
          "-vf",
          `select=eq(n\\,${frame})${format === "portrait" ? ",scale=390:-1" : ""}`,
          "-frames:v",
          "1",
          path.join(
            work,
            `${format}-export-${sceneIds[index]}-${localFrame}${format === "portrait" ? "-390w" : ""}.png`,
          ),
        ]);
      }
      const change = difference(pixels[0], pixels[2]);
      assert(
        change > 0.15,
        `${sceneIds[index]} must develop visually in ${format}: ${change}`,
      );
      changes.push({ scene: sceneIds[index], meanPixelDifference: change });
    }
    await writeFile(
      path.join(work, `${format}-metadata.json`),
      JSON.stringify({ metadata, timing, changes, silent: true }, null, 2),
    );
    log(`Native ${format} showcase exported sequentially and fully decoded`, {
      output,
      projectFile,
      width,
      height,
      fps: 30,
      frames: 600,
      exportSeconds,
      changes,
    });
  }
  assert.deepEqual(
    rendererErrors,
    [],
    "No uncaught renderer errors are expected",
  );
  assert.deepEqual(
    consoleErrors,
    [],
    "No renderer console errors are expected",
  );
  await writeFile(
    path.join(work, "README.md"),
    "# Premium motion QA\n\nThe two movies are silent native animation demonstrations, not finished narrated reels. Their five scenes and all text, paths, masks and counters remain editable in the accompanying Cutline projects. Portrait frames at 390px show artwork legibility. Desktop screenshots test native 1440px and 1100px windows; this Mac editor does not claim a 390px mobile UI. Frame samples and full decoding are not a substitute for real-time visual review. No audio, footage, hosted generation or paid service was used.\n",
  );
  log(
    "No renderer exceptions or console errors; all showcase layers remain editable",
  );
} catch (error) {
  failure = error.stack ?? String(error);
  if (page && !page.isClosed()) await capture("failure.png").catch(() => {});
} finally {
  await close().catch((error) => {
    failure ??= `Cleanup failed: ${error.stack ?? error}`;
  });
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(
      {
        passed: !failure,
        work,
        executable,
        packaged,
        results,
        rendererErrors,
        consoleErrors,
        ...(failure ? { failure } : {}),
      },
      null,
      2,
    ),
  );
  console.log(`Premium motion QA artifacts: ${work}`);
}
if (failure) throw Error(failure);
