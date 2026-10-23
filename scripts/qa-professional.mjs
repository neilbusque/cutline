import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

// Exercise the packaged editor and its real MCP endpoint with disposable app
// data. The source project, locally generated music and renders stay in work/.
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED !== "0";
const appRoot =
  process.env.CUTLINE_APP ??
  path.join(root, "release/Cutline-darwin-arm64/Cutline.app");
const outputParent =
  process.env.CUTLINE_PROFESSIONAL_QA_RESULTS ??
  path.resolve(root, "../qa-professional");
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, "run-"));
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
const media = (binary, args) => {
  const result = spawnSync(binary, args, { maxBuffer: 32 * 1024 * 1024 });
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
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const waitProject = async (predicate, message) => {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const p = await state();
    if (predicate(p)) {
      await page.waitForTimeout(100);
      return p;
    }
    await page.waitForTimeout(80);
  }
  throw Error(message);
};
const call = async (name, args = {}, expectError = false) => {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (expectError) {
    assert(response.isError, `${name} should reject`);
    return text;
  }
  assert(!response.isError, `${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const edit = async (label, actions) =>
  call("cutline_edit", { ...guard(await state()), label, actions });
const number = async (label, value) => {
  const input = page.getByLabel(label, { exact: true });
  if (Number(await input.inputValue()) === value) return;
  const revision = (await state()).revision;
  await input.fill(String(value));
  await input.press("Enter");
  await waitProject((p) => p.revision > revision, `${label} did not commit`);
};
const choose = async (label, value, committed = true) => {
  const input = page.getByLabel(label, { exact: true });
  if ((await input.inputValue()) === value) return;
  const revision = (await state()).revision;
  await input.selectOption(value);
  if (committed)
    await waitProject((p) => p.revision > revision, `${label} did not commit`);
  else await page.waitForTimeout(100);
};
const details = async (label) => {
  const summary = page
    .locator(".motion-inspector summary")
    .filter({ hasText: label })
    .first();
  if (!(await summary.evaluate((el) => el.parentElement.open)))
    await summary.click();
};
const seek = async (frame, clipId) => {
  await call("cutline_preview", {
    ...guard(await state()),
    frame,
    ...(clipId ? { clipId } : {}),
    playing: false,
  });
  await page.waitForTimeout(180);
};
const pixels = (file, frame = 0) =>
  media(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `select=eq(n\\,${frame}),scale=160:90`,
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
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
};
const exportVideo = async (file) => {
  const started = Date.now();
  const job = await call("cutline_export", {
    ...guard(await state()),
    path: file,
  });
  while (Date.now() - started < 240000) {
    const current = (await call("cutline_jobs")).find(
      (item) => item.id === job.id,
    );
    if (current?.state === "done") return (Date.now() - started) / 1000;
    if (current?.state === "error") throw Error(current.message);
    await page.waitForTimeout(500);
  }
  throw Error("Signature export exceeded four minutes");
};
const assertTypographyFits = (layers) => {
  assert(
    layers.length > 0,
    "Held Signature scene must render real text layers",
  );
  const issues = layers.flatMap((layer) => [
    ...(layer.scrollWidth > layer.width + 1
      ? [`Text overflows horizontally: ${layer.text}`]
      : []),
    ...(layer.scrollHeight > layer.height + 1
      ? [`Text overflows vertically: ${layer.text}`]
      : []),
    ...layer.lines
      .filter((line) => line.fragments > 1)
      .map(
        (line) => `Explicit Signature line wraps unexpectedly: ${line.text}`,
      ),
  ]);
  assert.equal(issues.length, 0, issues.join("\n"));
};
const inspectTypography = async (strict = true) => {
  const layers = await page
    .locator('.canvas [data-motion-type="text"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const lines = [...node.querySelectorAll("[data-motion-line] span")].map(
          (line) => {
            const range = document.createRange();
            range.selectNodeContents(line);
            return {
              text: line.textContent,
              fragments: range.getClientRects().length,
            };
          },
        );
        return {
          layer: node.getAttribute("data-motion-layer"),
          text: node.textContent,
          width: node.clientWidth,
          scrollWidth: node.scrollWidth,
          height: node.clientHeight,
          scrollHeight: node.scrollHeight,
          lines,
        };
      }),
    );
  await writeFile(
    path.join(work, "signature-typography-current.json"),
    JSON.stringify(layers, null, 2),
  );
  if (strict) assertTypographyFits(layers);
  return layers;
};

try {
  const bundle = await build({
    stdin: {
      contents:
        'export {newProject,makeClip,MotionSchema,validateProject} from "./src/shared/model.ts";export {motionValue} from "./src/shared/motion.ts";export {createSignatureDemoProject} from "./src/shared/motion-presets.ts";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const {
    newProject,
    makeClip,
    MotionSchema,
    validateProject,
    motionValue,
    createSignatureDemoProject,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const fixture = newProject();
  Object.assign(fixture, {
    name: "Signature curve and type QA",
    width: 1280,
    height: 720,
    fps: 30,
    background: "#10120f",
  });
  const motion = MotionSchema.parse({
    id: "qa-signature-motion",
    name: "Curve and typography fixture",
    layers: [
      {
        type: "rectangle",
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        background: "#10120f",
      },
      {
        type: "text",
        text: "MAKE IT\nMOVE",
        x: 100,
        y: 130,
        width: 1080,
        height: 350,
        fontSize: 96,
        keyframes: [
          {
            frame: 0,
            y: 80,
            opacity: 0,
            easing: "cubic-bezier",
            bezier: [0.65, 0, 0.35, 1],
          },
          { frame: 24, y: 0, opacity: 1, easing: "linear" },
          {
            frame: 90,
            y: -24,
            easing: "cubic-bezier",
            bezier: [0.16, 1, 0.3, 1],
          },
          { frame: 119, y: 0, easing: "linear" },
        ],
      },
      {
        type: "line",
        x: 100,
        y: 535,
        width: 1080,
        height: 8,
        stroke: "#c6f16d",
        strokeWidth: 4,
        keyframes: [
          {
            frame: 0,
            trim: 0,
            easing: "cubic-bezier",
            bezier: [0.16, 1, 0.3, 1],
          },
          { frame: 36, trim: 1 },
        ],
      },
    ],
  });
  fixture.motions.push(motion);
  const clip = {
    ...makeClip(fixture, "text", "titles", 0),
    id: "qa-signature-clip",
    duration: 120,
    width: 1280,
    height: 720,
    x: 0,
    y: 0,
    motionId: motion.id,
    preset: "custom",
    text: "MAKE IT MOVE",
    fontWeight: "800",
    align: "center",
  };
  fixture.clips.push(clip);
  validateProject(fixture);
  const fixtureFile = path.join(work, "Signature curve QA.cutline");
  await writeFile(
    fixtureFile,
    JSON.stringify({ project: fixture, past: [], future: [] }),
  );
  app = await electron.launch({
    executablePath: executable,
    args: packaged
      ? ["--force-color-profile=srgb", fixtureFile]
      : [root, "--force-color-profile=srgb", fixtureFile],
    env,
  });
  page = await app.firstWindow({ timeout: 90000 });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar");
  await waitProject(
    (p) => p.id === fixture.id,
    "Signature fixture did not load",
  );
  const settings = (await invoke("state")).settings;
  client = new Client({ name: "cutline-signature-qa", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: settings.mcpLauncher,
      args: [],
      env: { ...env, CUTLINE_CONNECTION: path.join(data, "connection.json") },
      stderr: "pipe",
    }),
  );
  await seek(0, clip.id);
  await page
    .getByRole("button", { name: "Select motion layer 2", exact: true })
    .click();
  let p = await state();
  const nameInput = page.getByLabel("Layer name", { exact: true });
  await nameInput.fill("Hero title");
  await nameInput.press("Enter");
  p = await waitProject(
    (p) => p.motions[0].layers[1].name === "Hero title",
    "Layer name did not commit",
  );
  const heroRow = page.getByRole("button", {
    name: "Select motion layer 2",
    exact: true,
  });
  assert((await heroRow.textContent()).includes("Hero title"));
  assert.equal(await heroRow.getAttribute("title"), "Hero title");
  assert(
    (await heroRow.getAttribute("aria-description")).includes("Hero title"),
  );
  await edit("Set a spaced layer name", [
    {
      type: "motion.layer.update",
      motionId: motion.id,
      layer: 1,
      patch: { name: "  Guide  " },
    },
  ]);
  p = await waitProject(
    (p) => p.motions[0].layers[1].name === "  Guide  ",
    "MCP layer name did not commit",
  );
  const beforeNameCancel = snapshot(p);
  await nameInput.fill("Discard this rename");
  await nameInput.press("Escape");
  assert.deepEqual(snapshot(await state()), beforeNameCancel);
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => p.motions[0].layers[1].name === "Hero title",
    "Layer name undo failed",
  );
  await seek(60, clip.id);
  await page
    .getByRole("button", { name: "Hide motion layer 2", exact: true })
    .click();
  p = await waitProject(
    (p) => p.motions[0].layers[1].hidden,
    "Layer visibility did not commit",
  );
  assert.equal(
    await page.locator('.canvas [data-motion-layer="1"]').count(),
    0,
  );
  assert.equal(
    await page.locator('.canvas [data-motion-layer="2"]').count(),
    1,
    "Visible siblings must retain original indices",
  );
  assert(
    Number(await heroRow.evaluate((node) => getComputedStyle(node).opacity)) <
      1,
  );
  await page.screenshot({
    path: path.join(work, "professional-layer-names-visibility.png"),
  });
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => !p.motions[0].layers[1].hidden,
    "Visibility undo failed",
  );
  assert.equal(
    await page.locator('.canvas [data-motion-layer="1"]').count(),
    1,
  );
  await call("cutline_redo", guard(p));
  p = await waitProject(
    (p) => p.motions[0].layers[1].hidden,
    "Visibility redo failed",
  );
  await page
    .getByRole("button", { name: "Show motion layer 2", exact: true })
    .click();
  p = await waitProject(
    (p) => !p.motions[0].layers[1].hidden,
    "Show layer did not commit",
  );
  log(
    "Named layers expose full names, Escape cancels renaming, and hidden layers preserve sibling indices with undo/redo",
  );
  let layer = p.motions[0].layers[1];

  await choose("Layer animated property", "y", false);
  await seek(0, clip.id);
  await page
    .locator(".motion-inspector .keyframe-list button")
    .filter({ hasText: "◆ 0 · 80" })
    .click();
  await choose("Layer easing", "cubic-bezier");
  await choose("Curve preset", "overshoot");
  await number("Bezier X1", 0.2);
  await number("Bezier Y1", 1.3);
  await number("Bezier X2", 0.8);
  await number("Bezier Y2", 1);
  p = await state();
  layer = p.motions[0].layers[1];
  const yKey = layer.keyframes.find(
    (key) => key.frame === 0 && key.y !== undefined,
  );
  const opacityKey = layer.keyframes.find(
    (key) => key.frame === 0 && key.opacity !== undefined,
  );
  assert.deepEqual(yKey.bezier, [0.2, 1.3, 0.8, 1]);
  assert.deepEqual(opacityKey.bezier, [0.65, 0, 0.35, 1]);
  assert.equal(opacityKey.easing, "cubic-bezier");
  assert(
    await page
      .getByRole("img", { name: "Cubic Bezier easing curve", exact: true })
      .isVisible(),
  );
  const curveBeforeGestures = snapshot(p.motions);
  const keyTuple = (project) =>
    project.motions[0].layers[1].keyframes.find(
      (key) => key.frame === 0 && key.y !== undefined,
    ).bezier;
  const firstHandle = page.getByRole("button", {
    name: "Bezier handle 1",
    exact: true,
  });
  await firstHandle.scrollIntoViewIfNeeded();
  const graphBox = await page.locator(".motion-bezier-graph").boundingBox();
  let handleBox = await firstHandle.boundingBox();
  assert(graphBox && handleBox);
  const dragStart = {
    x: handleBox.x + handleBox.width / 2,
    y: handleBox.y + handleBox.height / 2,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(
    dragStart.x + graphBox.width * 0.1,
    dragStart.y - graphBox.height * 0.04,
    { steps: 4 },
  );
  assert.deepEqual(
    snapshot((await state()).motions),
    curveBeforeGestures,
    "A drag previews without changing project history",
  );
  assert(
    Number(await page.getByLabel("Bezier X1", { exact: true }).inputValue()) >
      0.2,
  );
  const revisionBeforeDrag = p.revision;
  await page.mouse.up();
  p = await waitProject(
    (p) => p.revision > revisionBeforeDrag,
    "Bezier handle drag did not commit",
  );
  assert(keyTuple(p)[0] > 0.2 && keyTuple(p)[1] > 1.3);
  assert.deepEqual(
    p.motions[0].layers[1].keyframes.find(
      (key) => key.frame === 0 && key.opacity !== undefined,
    ).bezier,
    [0.65, 0, 0.35, 1],
  );
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => JSON.stringify(p.motions) === JSON.stringify(curveBeforeGestures),
    "One undo must restore the entire curve drag",
  );
  await firstHandle.focus();
  const frameBeforeKeyboard = await page
    .getByLabel("Motion playhead", { exact: true })
    .inputValue();
  const revisionBeforeKeyboard = p.revision;
  await firstHandle.press("ArrowRight");
  p = await waitProject(
    (p) => p.revision > revisionBeforeKeyboard,
    "Bezier keyboard adjustment did not commit",
  );
  assert.equal(keyTuple(p)[0], 0.21);
  assert.equal(
    await page.getByLabel("Motion playhead", { exact: true }).inputValue(),
    frameBeforeKeyboard,
    "Handle arrows must not seek the global playhead",
  );
  assert(
    (await firstHandle.getAttribute("aria-description")).includes("X 0.21"),
  );
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => JSON.stringify(p.motions) === JSON.stringify(curveBeforeGestures),
    "Handle keyboard undo failed",
  );
  await firstHandle.focus();
  await firstHandle.press("Shift+ArrowUp");
  p = await waitProject(
    (p) => keyTuple(p)[1] === 1.4,
    "Shift handle keyboard adjustment did not commit",
  );
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => JSON.stringify(p.motions) === JSON.stringify(curveBeforeGestures),
    "Shift handle keyboard undo failed",
  );
  await firstHandle.scrollIntoViewIfNeeded();
  handleBox = await firstHandle.boundingBox();
  const beforeDragCancel = snapshot(p);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2 + graphBox.width * 0.05,
    handleBox.y + handleBox.height / 2 + graphBox.height * 0.03,
    { steps: 3 },
  );
  await firstHandle.press("Escape");
  await page.mouse.up();
  assert.deepEqual(
    snapshot(await state()),
    beforeDragCancel,
    "Escape must cancel curve dragging without an undo entry",
  );
  assert.equal(
    Number(await page.getByLabel("Bezier X1", { exact: true }).inputValue()),
    0.2,
  );
  log(
    "Curve handles drag with one-step undo, support precise and Shift arrow adjustments without seeking, and cancel without mutation",
  );

  const beforeTiming = snapshot(p.motions);
  await page.getByLabel("Keyframe frame", { exact: true }).fill("24");
  await page
    .getByRole("button", { name: "Move keyframe", exact: true })
    .click();
  assert.deepEqual(snapshot((await state()).motions), beforeTiming);
  assert(
    await page
      .getByRole("status")
      .filter({ hasText: "already exists" })
      .isVisible(),
  );
  await page.getByLabel("Keyframe frame", { exact: true }).fill("10");
  await page
    .getByRole("button", { name: "Move keyframe", exact: true })
    .click();
  p = await waitProject(
    (p) =>
      p.motions[0].layers[1].keyframes.some(
        (key) => key.frame === 10 && key.y === 80,
      ),
    "Keyframe timing did not move",
  );
  assert(
    !p.motions[0].layers[1].keyframes.some(
      (key) => key.frame === 0 && key.y !== undefined,
    ),
  );
  assert(
    p.motions[0].layers[1].keyframes.some(
      (key) => key.frame === 0 && key.opacity === 0,
    ),
  );
  assert.deepEqual(
    p.motions[0].layers[1].keyframes.find(
      (key) => key.frame === 10 && key.y !== undefined,
    ).bezier,
    [0.2, 1.3, 0.8, 1],
  );
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => JSON.stringify(p.motions) === JSON.stringify(beforeTiming),
    "Keyframe timing undo failed",
  );
  await page
    .locator(".motion-inspector .keyframe-list button")
    .filter({ hasText: "◆ 0 · 80" })
    .click();
  log(
    "Keyframe frame rejects occupied destinations atomically and moves only the chosen property with easing/handles intact",
  );

  await seek(12, clip.id);
  const evaluated = Number(
    await page
      .getByLabel("Layer evaluated value", { exact: true })
      .getAttribute("data-value"),
  );
  assert(Math.abs(evaluated - motionValue(layer, "y", 12)) < 1e-7);
  await page.locator(".motion-bezier").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(work, "signature-cubic-bezier-controls.png"),
  });
  const beforeTrimImage = path.join(work, "curve-before-trim.png");
  await page.locator(".canvas").screenshot({ path: beforeTrimImage });
  const beforeTrimPixels = pixels(beforeTrimImage);
  log(
    "Curve presets and four numeric Bezier controls update the actual curve while preserving a sibling property's easing",
  );

  const beforeInvalid = snapshot(p);
  await call(
    "cutline_edit",
    {
      ...guard(p),
      label: "Invalid Bezier validation",
      actions: [
        {
          type: "motion.keyframe",
          motionId: motion.id,
          layer: 1,
          property: "y",
          frame: 0,
          value: 80,
          easing: "cubic-bezier",
          bezier: [-0.1, 0, 0.8, 1],
        },
      ],
    },
    true,
  );
  assert.deepEqual(snapshot(await state()), beforeInvalid);
  await call(
    "cutline_edit",
    {
      ...guard(p),
      label: "Atomic keyframe move rejection",
      actions: [
        {
          type: "motion.layer.update",
          motionId: motion.id,
          layer: 1,
          patch: { name: "Should roll back" },
        },
        {
          type: "motion.keyframe.move",
          motionId: motion.id,
          layer: 1,
          property: "y",
          fromFrame: 0,
          toFrame: 24,
        },
      ],
    },
    true,
  );
  assert.deepEqual(snapshot(await state()), beforeInvalid);
  await edit("Agent layer and timing edit", [
    {
      type: "motion.layer.update",
      motionId: motion.id,
      layer: 1,
      patch: {
        name: "Agent title",
        hidden: true,
      },
    },
    {
      type: "motion.keyframe.move",
      motionId: motion.id,
      layer: 1,
      property: "y",
      fromFrame: 0,
      toFrame: 5,
    },
  ]);
  p = await state();
  assert.equal(p.motions[0].layers[1].name, "Agent title");
  assert(p.motions[0].layers[1].hidden);
  assert(
    p.motions[0].layers[1].keyframes.some(
      (key) => key.frame === 5 && key.y === 80,
    ),
  );
  assert.equal(
    await page.locator('.canvas [data-motion-layer="1"]').count(),
    0,
  );
  await call("cutline_undo", guard(p));
  p = await state();
  assert.deepEqual(snapshot(p.motions), beforeInvalid.motions);
  await edit("Trim while preserving curve phase", [
    { type: "clip.trim", clipId: clip.id, start: { frame: 12 } },
  ]);
  p = await state();
  assert.equal(p.clips[0].animationOffset, 12);
  assert.equal(p.clips[0].start, 12);
  await seek(12, clip.id);
  const afterTrimImage = path.join(work, "curve-after-trim.png");
  await page.locator(".canvas").screenshot({ path: afterTrimImage });
  assert(
    difference(beforeTrimPixels, pixels(afterTrimImage)) < 0.6,
    "Trimming must preserve the visible curve/reveal phase",
  );
  const trimmedBeforeTiming = snapshot(p.motions);
  await page
    .locator(".motion-inspector .keyframe-list button")
    .filter({ hasText: "◆ 24 · 0" })
    .click();
  assert.equal(
    await page.getByLabel("Keyframe frame", { exact: true }).inputValue(),
    "12",
  );
  await page.getByLabel("Keyframe frame", { exact: true }).fill("18");
  await page
    .getByRole("button", { name: "Move keyframe", exact: true })
    .click();
  p = await waitProject(
    (p) =>
      p.motions[0].layers[1].keyframes.some(
        (key) => key.frame === 30 && key.y === 0,
      ),
    "Trimmed keyframe timing did not include animation offset",
  );
  assert(
    p.motions[0].layers[1].keyframes.some(
      (key) => key.frame === 24 && key.opacity === 1,
    ),
  );
  assert.equal(p.clips[0].animationOffset, 12);
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => JSON.stringify(p.motions) === JSON.stringify(trimmedBeforeTiming),
    "Trimmed key timing undo failed",
  );
  await edit("Enable loop for timing QA", [
    {
      type: "motion.layer.update",
      motionId: motion.id,
      layer: 1,
      patch: { loop: "cycle", loopFrames: 120 },
    },
  ]);
  p = await state();
  await page
    .locator(".motion-inspector .keyframe-list button")
    .filter({ hasText: "◆ 119 · 0" })
    .click();
  assert.equal(
    await page
      .getByLabel("Keyframe frame", { exact: true })
      .getAttribute("max"),
    "120",
  );
  await page.getByLabel("Keyframe frame", { exact: true }).fill("120");
  await page
    .getByRole("button", { name: "Move keyframe", exact: true })
    .click();
  p = await waitProject(
    (p) =>
      p.motions[0].layers[1].keyframes.some(
        (key) => key.frame === 120 && key.y === 0,
      ),
    "Loop endpoint must use raw curve frame120",
  );
  await call("cutline_undo", guard(p));
  p = await state();
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => JSON.stringify(p.motions) === JSON.stringify(trimmedBeforeTiming),
    "Loop timing QA undo failed",
  );
  await page
    .locator(".motion-inspector .keyframe-list button")
    .filter({ hasText: "◆ 0 · 80" })
    .click();
  log(
    "Real MCP names/visibility/key timing commit atomically; scene-relative trimmed timing and explicit loop endpoints preserve sibling curves",
  );
  await seek(75, clip.id);
  const beforeSplitImage = path.join(work, "curve-before-split.png");
  await page.locator(".canvas").screenshot({ path: beforeSplitImage });
  await edit("Split motion without restarting reveal", [
    {
      type: "clip.split",
      clipId: clip.id,
      at: { frame: 60 },
      rightRef: "right",
    },
  ]);
  p = await state();
  const right = p.clips.find((item) => item.id !== clip.id);
  assert.equal(right.animationOffset, 60);
  assert.equal(right.motionId, motion.id);
  await seek(75, right.id);
  await page
    .getByRole("button", { name: "Select motion layer 2", exact: true })
    .click();
  await choose("Layer animated property", "y", false);
  assert(
    Math.abs(
      Number(
        await page
          .getByLabel("Layer evaluated value", { exact: true })
          .getAttribute("data-value"),
      ) - motionValue(p.motions[0].layers[1], "y", 75),
    ) < 1e-7,
  );
  const afterSplitImage = path.join(work, "curve-after-split.png");
  await page.locator(".canvas").screenshot({ path: afterSplitImage });
  assert(
    difference(pixels(beforeSplitImage), pixels(afterSplitImage)) < 0.6,
    "Splitting must retain the visible motion and completed multiline reveal phase",
  );
  log(
    "Real MCP validates typography/Bezier edits atomically; trim and split retain curve and line-reveal phase",
  );

  const saved = path.join(work, "Signature edited motion.cutline");
  const beforeSave = snapshot(await state());
  await call("cutline_save_project", { ...guard(beforeSave), path: saved });
  await call("cutline_new_project", {
    ...guard(beforeSave),
    name: "Disposable persistence check",
  });
  p = await state();
  await call("cutline_open_project", { ...guard(p), path: saved });
  p = await waitProject(
    (p) => p.id === beforeSave.id,
    "Saved Signature project did not reopen",
  );
  assert.deepEqual(snapshot(p.motions), beforeSave.motions);
  assert.deepEqual(snapshot(p.clips), beforeSave.clips);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }),
  );
  await seek(75, right.id);
  await page
    .getByRole("button", { name: "Select motion layer 2", exact: true })
    .click();
  await choose("Layer animated property", "y", false);
  await page
    .locator(".motion-inspector .keyframe-list button")
    .filter({ hasText: "◆ 0 · 80" })
    .click();
  const geometry = await page.evaluate(() => ({
    w: innerWidth,
    h: innerHeight,
    sw: document.documentElement.scrollWidth,
    sh: document.documentElement.scrollHeight,
  }));
  assert(geometry.sw <= geometry.w + 1 && geometry.sh <= geometry.h + 1);
  await page.getByLabel("Bezier X1", { exact: true }).focus();
  assert.notEqual(
    await page
      .getByLabel("Bezier X1", { exact: true })
      .evaluate((el) => getComputedStyle(el).outlineStyle),
    "none",
  );
  await page.screenshot({
    path: path.join(work, "signature-minimum-window.png"),
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }),
  );
  log(
    "Edited typography and curves survive save/reopen; minimum-size controls remain keyboard accessible",
  );

  const beforeLibrary = snapshot(await state());
  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Motion", exact: true })
    .click();
  await page.getByRole("tab", { name: "Scenes", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Signature", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  const sceneSearch = page.getByLabel("Search motion library", { exact: true });
  await sceneSearch.fill("Kinetic");
  assert(
    await page
      .getByRole("button", { name: "Add Kinetic title scene", exact: true })
      .isVisible(),
    "Scene search must include presets beyond the active Signature category",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Signature", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await sceneSearch.fill("");
  for (const name of [
    "Signature / Pace",
    "Signature / Intent",
    "Signature / Mark",
  ])
    assert(
      await page
        .getByRole("button", { name: `Add ${name} scene`, exact: true })
        .isVisible(),
    );
  await page.screenshot({
    path: path.join(work, "signature-scene-library.png"),
  });
  await page
    .getByRole("button", { name: "Add Signature / Pace scene", exact: true })
    .click();
  p = await waitProject(
    (p) => p.motions.length === beforeLibrary.motions.length + 1,
    "Signature library card did not add an editable scene",
  );
  await call("cutline_undo", guard(p));
  p = await state();
  assert.deepEqual(snapshot(p.clips), beforeLibrary.clips);
  assert.deepEqual(snapshot(p.motions), beforeLibrary.motions);
  log(
    "Signature is the default scene category, and a real library card adds editable motion with one-step undo",
  );

  const portrait = createSignatureDemoProject({
    width: 1080,
    height: 1920,
    fps: 30,
    bpm: 104,
    beatsPerScene: 8,
  });
  const portraitFile = path.join(work, "Signature portrait layout.cutline");
  validateProject(portrait);
  await writeFile(
    portraitFile,
    JSON.stringify({ project: portrait, past: [], future: [] }),
  );
  await invoke("test.load", { path: portraitFile });
  await waitProject(
    (p) => p.id === portrait.id,
    "Portrait Signature layout fixture did not load",
  );
  const portraitLayout = [];
  for (const clip of portrait.clips) {
    const frame = clip.start + Math.min(60, clip.duration - 1);
    await seek(frame);
    portraitLayout.push({ frame, layers: await inspectTypography(false) });
    await page
      .locator(".canvas")
      .screenshot({ path: path.join(work, `signature-portrait-${frame}.png`) });
  }
  await writeFile(
    path.join(work, "signature-portrait-typography-layout.json"),
    JSON.stringify(portraitLayout, null, 2),
  );
  assertTypographyFits(portraitLayout.flatMap((layout) => layout.layers));
  log(
    "Actual-font Signature typography fits portrait 1080×1920 without horizontal/vertical overflow or unintended line wraps",
  );

  const demo = createSignatureDemoProject({
    width: 1280,
    height: 720,
    fps: 30,
    bpm: 104,
    beatsPerScene: 8,
  });
  demo.name = "Cutline Signature — Motion Showcase";
  const visualEnd = Math.max(
    ...demo.clips.map((clip) => clip.start + clip.duration),
  );
  const demoFixture = path.join(work, "Signature showcase source.cutline");
  validateProject(demo);
  await writeFile(
    demoFixture,
    JSON.stringify({ project: demo, past: [], future: [] }),
  );
  await invoke("test.load", { path: demoFixture });
  await waitProject(
    (p) => p.id === demo.id,
    "Signature showcase fixture did not load",
  );
  await call("cutline_music_create", {
    ...guard(await state()),
    style: "clean",
    seconds: 20,
    startFrame: 0,
  });
  p = await state();
  const music = p.clips.find((clip) => clip.kind === "audio");
  assert(music, "The showcase must include locally composed music");
  await edit("Finish showcase music", [
    { type: "clip.trim", clipId: music.id, end: { frame: visualEnd } },
    {
      type: "clip.update",
      clipId: music.id,
      patch: { volume: 0.5, fadeIn: 3, fadeOut: 24 },
    },
  ]);
  p = await state();
  const signatureClip = p.clips.find((clip) => clip.kind === "text");
  await seek(signatureClip.start + 30, signatureClip.id);
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  await page.getByRole("button", { name: "Music sync", exact: true }).click();
  const pulseSummary = page
    .locator(".music-sync summary")
    .filter({ hasText: "Pulse motion" });
  if (!(await pulseSummary.evaluate((el) => el.parentElement.open)))
    await pulseSummary.click();
  assert.equal(
    await page.getByLabel("Pulse target", { exact: true }).inputValue(),
    "accents",
    "New Signature motion must default to graphical accents",
  );
  await call("cutline_music_reactive", {
    ...guard(p),
    musicClipId: music.id,
    clipIds: [signatureClip.id],
    mode: "beat",
    style: "scale",
    amount: 0.16,
    releaseFrames: 10,
  });
  p = await waitProject(
    (p) => !!p.clips.find((clip) => clip.id === signatureClip.id).musicReactive,
    "Legacy Signature pulse did not commit",
  );
  assert.equal(
    p.clips.find((clip) => clip.id === signatureClip.id).musicReactive.scope,
    undefined,
    "Omitted scope preserves the legacy whole-clip binding",
  );
  await seek(signatureClip.start + 30, signatureClip.id);
  assert.equal(
    await page.getByLabel("Pulse target", { exact: true }).inputValue(),
    "clip",
    "An existing legacy Signature binding must display Entire clip",
  );
  await choose("Pulse target", "accents", false);
  await choose("Pulse style", "scale", false);
  await page.getByLabel("Pulse decay frames", { exact: true }).fill("13");
  const pulseRevision = p.revision;
  await page.getByRole("button", { name: "Apply pulse", exact: true }).click();
  p = await waitProject(
    (p) => p.revision > pulseRevision,
    "UI Signature music pulse did not commit",
  );
  assert.equal(
    p.clips.find((clip) => clip.id === signatureClip.id).musicReactive.scope,
    "accents",
  );
  assert.equal(
    p.clips.find((clip) => clip.id === signatureClip.id).musicReactive
      .releaseFrames,
    13,
  );
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) =>
      p.clips.find((clip) => clip.id === signatureClip.id).musicReactive
        ?.releaseFrames === 10,
    "UI pulse undo did not restore the legacy binding",
  );
  assert.equal(
    p.clips.find((clip) => clip.id === signatureClip.id).musicReactive.scope,
    undefined,
  );
  await call("cutline_undo", guard(p));
  p = await waitProject(
    (p) => !p.clips.find((clip) => clip.id === signatureClip.id).musicReactive,
    "UI pulse undo failed",
  );
  log(
    "Music sync defaults new Signature scenes to accents, displays legacy bindings as Entire clip, and commits explicit scope/decay with independent undo",
  );
  await call("cutline_music_reactive", {
    ...guard(p),
    musicClipId: music.id,
    clipIds: p.clips
      .filter((clip) => clip.kind === "text")
      .map((clip) => clip.id),
    mode: "beat",
    style: "scale",
    scope: "accents",
    amount: 0.16,
    releaseFrames: 10,
  });
  p = await state();
  assert(
    p.clips
      .filter((clip) => clip.kind === "text")
      .every((clip) => clip.musicReactive?.scope === "accents"),
  );
  const soundtrack = p.assets.find((asset) => asset.id === music.assetId);
  assert.equal(soundtrack.rhythm.bpm, 104);
  assert.equal(
    p.clips.find((clip) => clip.id === music.id).duration,
    visualEnd,
  );
  await writeFile(
    path.join(work, "signature-project-snapshot.json"),
    JSON.stringify(p, null, 2),
  );
  const demoSaved = path.join(work, "Cutline Signature Showcase.cutline");
  await call("cutline_save_project", { ...guard(p), path: demoSaved });
  await writeFile(
    path.join(work, "signature-assets.json"),
    JSON.stringify(p.assets, null, 2),
  );
  await page.locator(".stage").click({ position: { x: 4, y: 4 } });
  const frames = p.clips
    .filter((clip) => clip.kind === "text")
    .map((clip) =>
      Math.min(
        clip.start + clip.duration - 1,
        clip.start + Math.round(clip.duration * 0.6),
      ),
    );
  const previews = new Map();
  const landscapeLayout = [];
  for (const frame of frames) {
    await seek(frame);
    landscapeLayout.push({ frame, layers: await inspectTypography() });
    const png = path.join(work, `signature-preview-${frame}.png`);
    await page.locator(".canvas").screenshot({ path: png });
    previews.set(frame, pixels(png));
  }
  await writeFile(
    path.join(work, "signature-typography-layout.json"),
    JSON.stringify(
      { portrait: portraitLayout, landscape: landscapeLayout },
      null,
      2,
    ),
  );
  const demoVideo = path.join(work, "Cutline Signature Showcase.mp4");
  const seconds = await exportVideo(demoVideo);
  const metadata = JSON.parse(
    media(ffprobe, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      demoVideo,
    ]).toString(),
  );
  const video = metadata.streams.find((item) => item.codec_type === "video");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assertCfrExport(ffprobe, demoVideo, { fps: 30, frames: visualEnd });
  assert(metadata.streams.some((item) => item.codec_type === "audio"));
  assert(Math.abs(Number(metadata.format.duration) - visualEnd / 30) < 0.1);
  const parity = frames.map((frame) => ({
    frame,
    meanPixelDifference: difference(
      previews.get(frame),
      pixels(demoVideo, frame),
    ),
  }));
  assert(
    parity.every((item) => item.meanPixelDifference < 4),
    `Signature preview/export mismatch: ${JSON.stringify(parity)}`,
  );
  for (const frame of frames)
    media(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-i",
      demoVideo,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      path.join(work, `signature-export-${frame}.png`),
    ]);
  const contact = path.join(work, "signature-contact-sheet.png");
  media(ffmpeg, [
    "-v",
    "error",
    "-y",
    ...frames.flatMap((frame) => [
      "-i",
      path.join(work, `signature-export-${frame}.png`),
    ]),
    "-filter_complex",
    "[0:v]scale=640:360[a];[1:v]scale=640:360[b];[2:v]scale=640:360[c];[a][b][c]xstack=inputs=3:layout=0_0|640_0|1280_0[v]",
    "-map",
    "[v]",
    "-frames:v",
    "1",
    contact,
  ]);
  await writeFile(
    path.join(work, "signature-export-metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  log(
    "Three editable Signature scenes render with original 104 BPM music and subtle beat accents, matching held preview frames",
    {
      seconds,
      duration: Number(metadata.format.duration),
      frames: visualEnd,
      parity,
      project: demoSaved,
      video: demoVideo,
      assetPaths: p.assets.map((asset) => asset.path),
      contactSheet: contact,
    },
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  log("Signature packaged editor completes without renderer or console errors");
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
        releaseBuildSha256: process.env.CUTLINE_QA_PACKAGE_SHA ?? null,
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
  if (app) {
    const closed = await Promise.race([
      app
        .close()
        .then(() => true)
        .catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!closed) app.process().kill("SIGKILL");
  }
  console.log(`Signature QA artifacts: ${work}`);
}
if (failure) throw Error(failure);
