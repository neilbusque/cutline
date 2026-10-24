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
  process.env.CUTLINE_VECTOR_QA_RESULTS ?? path.resolve(root, "../qa-vector");
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
  throw Error("Logo export exceeded four minutes");
};

const draftNumber = async (label, value) => {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(String(value));
  await input.press("Enter");
  await page.waitForTimeout(80);
};
const vectorDetails = async (name) => {
  const summary = page
    .locator(".vector-editor summary")
    .filter({ hasText: name })
    .first();
  if (!(await summary.evaluate((el) => el.parentElement.open)))
    await summary.click();
};
const sourceClick = async (x, y) => {
  const at = await page.locator(".vector-drawing").evaluate(
    (el, p) => {
      const pt = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM());
      return { x: pt.x, y: pt.y };
    },
    { x, y },
  );
  await page.mouse.click(at.x, at.y);
};
const dragControl = async (label, dx, dy, cancel = false) => {
  const handle = page.getByRole("button", { name: label, exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  assert(box);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  if (cancel) await handle.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(80);
};
const fits = async () => {
  const values = await page
    .locator('.canvas [data-motion-type="text"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent,
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
        height: node.clientHeight,
        scrollHeight: node.scrollHeight,
        lines: [...node.querySelectorAll("[data-motion-line] span")].map(
          (line) => {
            const r = document.createRange();
            r.selectNodeContents(line);
            return {
              text: line.textContent,
              fragments: r.getClientRects().length,
            };
          },
        ),
      })),
    );
  assert(values.length > 0, "Logo scene must include real typography");
  for (const value of values) {
    assert(
      value.scrollWidth <= value.width + 1,
      `Horizontal overflow: ${value.text}`,
    );
    assert(
      value.scrollHeight <= value.height + 1,
      `Vertical overflow: ${value.text}`,
    );
    for (const line of value.lines)
      assert(line.fragments <= 1, `Unexpected line wrap: ${line.text}`);
  }
  return values;
};

try {
  const bundle = await build({
    stdin: {
      contents:
        'export {newProject,makeClip,MotionSchema,validateProject} from "./src/shared/model.ts";export {motionValue} from "./src/shared/motion.ts";export {createLogoDemoProject} from "./src/shared/motion-presets.ts";export {vectorPathToPoints,parseEditableSvg} from "./src/shared/vector-path.ts";',
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
    createLogoDemoProject,
    vectorPathToPoints,
    parseEditableSvg,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const fixture = newProject();
  Object.assign(fixture, {
    name: "Vector path editing QA",
    width: 1280,
    height: 720,
    fps: 30,
    background: "#10120f",
  });
  const motion = MotionSchema.parse({
    id: "qa-vector-motion",
    name: "Editable vector fixture",
    layers: [
      {
        type: "rectangle",
        name: "Background",
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        background: "#10120f",
      },
      {
        type: "path",
        name: "Original mark",
        vectorPath: "M20 80 L50 20 L80 80 Z",
        vectorViewBox: [0, 0, 100, 100],
        background: "#d38a5f",
        stroke: "#f5f0e7",
        strokeWidth: 4,
        x: 490,
        y: 210,
        width: 300,
        height: 300,
        keyframes: [
          { frame: 0, x: 0 },
          { frame: 90, x: 35 },
        ],
      },
    ],
  });
  fixture.motions.push(motion);
  const clip = {
    ...makeClip(fixture, "text", "titles", 0),
    id: "qa-vector-clip",
    text: "Custom mark",
    fontWeight: "800",
    preset: "custom",
    motionId: motion.id,
    duration: 120,
    width: 1280,
    height: 720,
    x: 0,
    y: 0,
  };
  fixture.clips.push(clip, { ...clip, id: "qa-vector-shared", start: 150 });
  validateProject(fixture);
  const fixtureFile = path.join(work, "Vector editing QA.cutline");
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
  await waitProject((p) => p.id === fixture.id, "Vector fixture did not load");
  const settings = (await invoke("state")).settings;
  client = new Client({ name: "cutline-vector-qa", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: settings.mcpLauncher,
      args: [],
      env: { ...env, CUTLINE_CONNECTION: path.join(data, "connection.json") },
      stderr: "pipe",
    }),
  );
  await seek(30, clip.id);
  await page
    .getByRole("button", { name: "Select motion layer 2", exact: true })
    .click();
  await vectorDetails("SVG path data");
  const dataInput = page.getByLabel("SVG path data", { exact: true });
  const original = snapshot(await state());
  await page.getByRole("button", { name: "New path", exact: true }).click();
  await sourceClick(20, 75);
  assert.equal(
    await page
      .getByRole("button", { name: "Path node 1", exact: true })
      .count(),
    1,
    "First pen point must remain editable",
  );
  assert(
    await page
      .getByRole("button", { name: "Apply path", exact: true })
      .isDisabled(),
  );
  await sourceClick(50, 20);
  await sourceClick(80, 75);
  assert.equal(
    await page.locator(".vector-node-hit[data-vector-node]").count(),
    3,
  );
  await page.getByLabel("Close path", { exact: true }).check();
  await page.getByRole("button", { name: "Path node 2", exact: true }).click();
  await choose("Point style", "bezier", false);
  await draftNumber("Node X", 52);
  await vectorDetails("Handle coordinates");
  await draftNumber("Incoming Y", 18);
  const beforeArrow = await dataInput.inputValue();
  await page.getByRole("button", { name: "Path node 2", exact: true }).focus();
  await page
    .getByRole("button", { name: "Path node 2", exact: true })
    .press("ArrowRight");
  assert.notEqual(await dataInput.inputValue(), beforeArrow);
  assert.equal(
    Number(
      await page.getByLabel("Motion playhead", { exact: true }).inputValue(),
    ),
    30,
    "Node arrow must not trigger timeline seeking",
  );
  await dragControl("Outgoing path handle", 8, 7);
  const beforeCancelDrag = await dataInput.inputValue();
  await dragControl("Path node 2", -15, 15, true);
  assert.equal(
    await dataInput.inputValue(),
    beforeCancelDrag,
    "Escape must discard an active drag",
  );
  assert.deepEqual(
    snapshot(await state()),
    original,
    "Draft gestures and numeric fields must not commit",
  );
  await page.screenshot({ path: path.join(work, "vector-draft-controls.png") });
  await page
    .getByRole("button", { name: "Cancel changes", exact: true })
    .click();
  assert.equal(await dataInput.inputValue(), motion.layers[1].vectorPath);
  assert.deepEqual(snapshot(await state()), original);
  log(
    "Pen clicks, node/Bezier drag, numeric fields and keyboard arrows edit a draft; Escape and Cancel preserve the project exactly",
  );

  await page.getByRole("button", { name: "Path node 2", exact: true }).click();
  await draftNumber("Node X", 58);
  await choose("Point style", "bezier", false);
  const editedPath = await dataInput.inputValue();
  await page.getByRole("button", { name: "Apply path", exact: true }).click();
  let p = await waitProject(
    (p) => p.motions[0].layers[1].vectorPath === editedPath,
    "Path Apply did not commit",
  );
  assert.equal(p.revision, original.revision + 1);
  await call("cutline_undo", guard(p));
  p = await state();
  assert.deepEqual(snapshot(p.motions), original.motions);
  await call("cutline_redo", guard(p));
  p = await waitProject(
    (p) => p.motions[0].layers[1].vectorPath === editedPath,
    "Path redo failed",
  );
  const applied = snapshot(p);
  await dataInput.fill("M 0 0 L");
  assert(
    await page
      .getByRole("button", { name: "Apply path", exact: true })
      .isDisabled(),
  );
  assert(await page.locator(".vector-error").isVisible());
  await dataInput.fill("M20 80 L55 20 L80 80 Z");
  assert(
    await dataInput.isVisible(),
    "Valid recovery must keep advanced editing open",
  );
  assert(await page.locator(".vector-data").evaluate((el) => el.open));
  await page
    .getByRole("button", { name: "Cancel changes", exact: true })
    .click();
  await vectorDetails("SVG path data");
  await page.getByLabel("Path viewBox width", { exact: true }).fill("0");
  assert(
    await page
      .getByRole("button", { name: "Apply path", exact: true })
      .isDisabled(),
  );
  await page
    .getByRole("button", { name: "Cancel changes", exact: true })
    .click();
  assert.deepEqual(snapshot(await state()), applied);
  await page
    .getByRole("button", { name: "Select motion layer 1", exact: true })
    .click();
  await choose("Layer type", "path");
  p = await state();
  assert(p.motions[0].layers[0].vectorPath);
  assert.deepEqual(p.motions[0].layers[0].vectorViewBox, [0, 0, 100, 100]);
  await call("cutline_undo", guard(p));
  await page
    .getByRole("button", { name: "Select motion layer 2", exact: true })
    .click();
  log(
    "Apply is one undoable edit; invalid path/viewBox drafts reject, and shape-to-path conversion supplies a valid definition",
  );

  const safeSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><g transform="translate(10 10) scale(1.2)" fill="#d38a5f" stroke="#f5f0e7" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel"><path id="Imported curve" d="M10 60 C20 0 60 0 70 60 L40 80 Z" fill-rule="evenodd"/></g><circle cx="95" cy="20" r="8" fill="#c6f16d"/></svg>';
  const safeFile = path.join(work, "Editable logo.svg");
  await writeFile(safeFile, safeSvg);
  const parsed = parseEditableSvg(safeSvg);
  const beforeImport = snapshot(await state());
  const imported = await call("cutline_vector_import", {
    ...guard(beforeImport),
    path: safeFile,
    startFrame: 300,
    name: "Imported custom logo",
  });
  p = await state();
  assert.equal(p.revision, beforeImport.revision + 1);
  assert.equal(imported.vectorLayers, 2);
  assert.equal(p.assets.length, beforeImport.assets.length);
  const importedMotion = p.motions.find((m) => m.id === imported.motionId);
  assert.deepEqual(
    importedMotion.layers[0].vectorTransform,
    parsed.layers[0].vectorTransform,
  );
  assert.equal(importedMotion.layers[0].vectorFillRule, "evenodd");
  assert.equal(importedMotion.layers[0].vectorLineCap, "round");
  assert.equal(importedMotion.layers[0].vectorLineJoin, "bevel");
  await seek(330, imported.clipId);
  await page
    .getByRole("button", { name: "Select motion layer 1", exact: true })
    .click();
  await page.getByRole("button", { name: "Path node 1", exact: true }).focus();
  await page
    .getByRole("button", { name: "Path node 1", exact: true })
    .press("ArrowRight");
  await vectorDetails("SVG path data");
  const transformedDraft = vectorPathToPoints(await dataInput.inputValue());
  assert.equal(
    transformedDraft.points[0].x,
    11.2,
    "Imported matrix editing must remain in source-space coordinates",
  );
  await page
    .getByRole("button", { name: "Cancel changes", exact: true })
    .click();
  const beforeBadImport = snapshot(await state());
  for (const [name, svg] of [
    ["script", '<svg viewBox="0 0 100 100"><script>alert(1)</script></svg>'],
    [
      "reference",
      '<svg viewBox="0 0 100 100"><image href="https://example.com/logo.png" width="100" height="100"/></svg>',
    ],
    [
      "html",
      '<svg viewBox="0 0 100 100"><foreignObject width="100" height="100"><div>x</div></foreignObject></svg>',
    ],
  ]) {
    const file = path.join(work, `${name}.svg`);
    await writeFile(file, svg);
    await call(
      "cutline_vector_import",
      { ...guard(await state()), path: file },
      true,
    );
    assert.deepEqual(snapshot(await state()), beforeBadImport);
  }
  await call(
    "cutline_vector_import",
    { ...guard(beforeImport), path: safeFile, startFrame: 500 },
    true,
  );
  assert.deepEqual(
    snapshot(await state()),
    beforeBadImport,
    "Stale import must reject atomically",
  );
  const badEdit = await call(
    "cutline_edit",
    {
      ...guard(await state()),
      label: "Reject malformed vector",
      actions: [
        {
          type: "motion.layer.update",
          motionId: imported.motionId,
          layer: 0,
          patch: { vectorPath: "M0 0 Q" },
        },
      ],
    },
    true,
  );
  assert(badEdit);
  assert.deepEqual(snapshot(await state()), beforeBadImport);
  // Since 0.30 scripts and event handlers are stripped and the shapes import;
  // none of that markup may reach the project.
  const beforeStripped = snapshot(await state());
  const strippedFile = path.join(work, "stripped.svg");
  await writeFile(
    strippedFile,
    '<svg viewBox="0 0 100 100"><script>alert(1)</script><path d="M0 0 L10 10 L0 10Z" onclick="alert(1)"/></svg>',
  );
  const stripped = await call("cutline_vector_import", {
    ...guard(await state()),
    path: strippedFile,
    startFrame: 900,
  });
  assert.equal(stripped.vectorLayers, 1);
  assert(!/alert|onclick|script/u.test(JSON.stringify(await state())));
  await call("cutline_undo", guard(await state()));
  assert.deepEqual(snapshot(await state()).clips, beforeStripped.clips);
  assert(
    !JSON.stringify(await call("cutline_inspect")).includes(safeFile),
    "Imported source path is not exposed or required",
  );
  const native = await invoke("vector.import", {
    ...guard(await state()),
    path: safeFile,
    startFrame: 450,
    name: "Native vector IPC",
  });
  assert(native.clipId);
  await call("cutline_undo", guard(await state()));
  log(
    "Real MCP and native SVG import retain editable paint/transform details without an asset dependency; unsafe, malformed and stale imports reject atomically",
  );

  const beforeAgentVector = snapshot(await state());
  const agentVector = await edit("Create and reveal an agent vector", [
    {
      type: "motion.vector",
      points: [
        { x: 10, y: 80 },
        { x: 50, y: 10, out: { x: 65, y: 10 } },
        { x: 90, y: 80, in: { x: 90, y: 55 } },
      ],
      closed: true,
      viewBox: [0, 0, 100, 100],
      at: { frame: 600 },
      fill: "#d38a5f",
      stroke: "#ffffff",
      strokeWidth: 2,
      ref: "pen",
    },
    { type: "motion.logoReveal", clipId: "$pen", style: "signal" },
    { type: "motion.svg", svg: safeSvg, at: { frame: 750 }, ref: "svg" },
  ]);
  p = await state();
  assert.equal(p.revision, beforeAgentVector.revision + 1);
  assert(p.clips.some((c) => c.id === agentVector.references.pen));
  assert(p.clips.some((c) => c.id === agentVector.references.svg));
  await call("cutline_undo", guard(p));
  p = await state();
  assert.deepEqual(snapshot(p.motions), beforeAgentVector.motions);
  assert.deepEqual(snapshot(p.clips), beforeAgentVector.clips);
  log(
    "Structured MCP pen points, embedded SVG and logo reveal work together as one atomic edit with creation references",
  );

  const arc = "M20 50 A30 30 0 1 1 80 50 A30 30 0 1 1 20 50 Z";
  await edit("Keep advanced arc path", [
    {
      type: "motion.layer.update",
      motionId: imported.motionId,
      layer: 0,
      patch: { vectorPath: arc, fillOpacity: 0.6 },
    },
  ]);
  await seek(330, imported.clipId);
  await page
    .getByRole("button", { name: "Select motion layer 1", exact: true })
    .click();
  assert.equal(await page.locator(".vector-node-hit").count(), 0);
  assert(
    await page
      .getByText("Edit this complex path using its SVG data below.", {
        exact: true,
      })
      .isVisible(),
  );
  assert.equal(await dataInput.inputValue(), arc);
  await dataInput.fill(
    "M20 50 A30 30 0 1 1 80 50 A30 30 0 1 1 20 50 Z M40 50 L60 50",
  );
  await page.getByRole("button", { name: "Apply path", exact: true }).click();
  p = await state();
  assert(
    p.motions
      .find((m) => m.id === imported.motionId)
      .layers[0].vectorPath.includes("M40"),
  );
  await call("cutline_undo", guard(p));
  await edit("Animate vector fill", [
    {
      type: "motion.keyframe",
      motionId: imported.motionId,
      layer: 0,
      property: "fillOpacity",
      frame: 0,
      value: 0,
      easing: "linear",
    },
    {
      type: "motion.keyframe",
      motionId: imported.motionId,
      layer: 0,
      property: "fillOpacity",
      frame: 60,
      value: 0.6,
    },
  ]);
  await seek(330, imported.clipId);
  p = await state();
  const rendered = page.locator('.canvas [data-motion-layer="0"] path');
  assert(
    Math.abs(Number(await rendered.getAttribute("fill-opacity")) - 0.3) < 1e-7,
  );
  log(
    "Advanced arcs/compound paths stay editable as validated SVG data; real MCP fill-opacity keys evaluate in the preview",
  );

  await edit("Trim reveal target", [
    { type: "clip.trim", clipId: clip.id, start: { frame: 24 } },
  ]);
  await seek(35, clip.id);
  await page
    .getByRole("button", { name: "Select motion layer 2", exact: true })
    .click();
  await details("Logo reveal");
  const beforeReveal = snapshot(await state());
  for (const style of ["draw", "orbit", "signal"]) {
    await page
      .getByRole("button", { name: "Select motion layer 2", exact: true })
      .click();
    await details("Logo reveal");
    await choose("Logo reveal style", style, false);
    await page
      .getByRole("button", { name: "Apply logo reveal", exact: true })
      .click();
    p = await waitProject(
      (p) => p.clips.find((c) => c.id === clip.id).motionId !== motion.id,
      `${style} reveal did not create a private definition`,
    );
    const target = p.clips.find((c) => c.id === clip.id),
      revealed = p.motions.find((m) => m.id === target.motionId);
    assert.deepEqual(
      snapshot(p.motions.find((m) => m.id === motion.id)),
      beforeReveal.motions.find((m) => m.id === motion.id),
    );
    assert.equal(
      p.clips.find((c) => c.id === "qa-vector-shared").motionId,
      motion.id,
    );
    assert.equal(target.animationOffset, 24);
    assert.equal(
      revealed.layers[1].vectorPath,
      beforeReveal.motions[0].layers[1].vectorPath,
    );
    assert(
      revealed.layers[1].keyframes.some((k) => k.frame === 24 && k.trim === 0),
    );
    assert(
      revealed.layers[1].keyframes.some((k) => k.frame === 90 && k.x === 35),
      "Existing X animation must remain",
    );
    await call("cutline_undo", guard(p));
    p = await state();
    assert.deepEqual(snapshot(p.motions), beforeReveal.motions);
    assert.deepEqual(snapshot(p.clips), beforeReveal.clips);
  }
  await page
    .getByRole("button", { name: "Select motion layer 2", exact: true })
    .click();
  await details("Logo reveal");
  await vectorDetails("SVG path data");
  await page.getByRole("button", { name: "Path node 2", exact: true }).click();
  await draftNumber("Node X", 61);
  assert(
    await page
      .getByRole("button", { name: "Apply logo reveal", exact: true })
      .isDisabled(),
  );
  await page
    .getByRole("button", { name: "Cancel changes", exact: true })
    .click();
  log(
    "Draw, Orbit and Signal reveal the trimmed clip in one undo, clone shared definitions, retain existing motion, and protect unfinished path drafts",
  );

  const saved = path.join(work, "Edited custom vectors.cutline"),
    beforeSave = snapshot(await state());
  await call("cutline_save_project", { ...guard(beforeSave), path: saved });
  await call("cutline_new_project", {
    ...guard(beforeSave),
    name: "Disposable vector reopen",
  });
  await call("cutline_open_project", { ...guard(await state()), path: saved });
  p = await waitProject(
    (p) => p.id === beforeSave.id,
    "Vector save did not reopen",
  );
  assert.deepEqual(snapshot(p.motions), beforeSave.motions);
  assert.deepEqual(snapshot(p.clips), beforeSave.clips);
  await seek(35, clip.id);
  await page
    .getByRole("button", { name: "Select motion layer 2", exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }),
  );
  await page.getByRole("button", { name: "Path node 2", exact: true }).focus();
  const geometry = await page.evaluate(() => ({
    w: innerWidth,
    h: innerHeight,
    sw: document.documentElement.scrollWidth,
    sh: document.documentElement.scrollHeight,
  }));
  assert(geometry.sw <= geometry.w + 1 && geometry.sh <= geometry.h + 1);
  await page.screenshot({ path: path.join(work, "vector-minimum-window.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }),
  );
  log(
    "Path definitions, transforms and curves survive save/reopen; designer remains usable at the minimum window size",
  );

  const beforeLibrary = snapshot(await state());
  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Motion", exact: true })
    .click();
  await page.getByRole("tab", { name: "Vectors", exact: true }).click();
  assert(
    await page
      .getByRole("button", { name: "Import SVG", exact: true })
      .isVisible(),
  );
  await page.getByRole("button", { name: "Draw vector", exact: true }).click();
  p = await waitProject(
    (p) => p.clips.length === beforeLibrary.clips.length + 1,
    "Custom vector library action failed",
  );
  assert(p.motions.at(-1).layers.every((layer) => layer.type === "path"));
  await call("cutline_undo", guard(p));
  for (const label of ["Logo / Draw", "Logo / Orbit", "Logo / Signal"])
    assert(
      await page
        .getByRole("button", { name: `Add ${label} scene`, exact: true })
        .isVisible(),
    );
  await page.screenshot({ path: path.join(work, "vector-library.png") });
  log(
    "Vectors library creates editable custom paths and exposes native SVG import and three original logo treatments",
  );

  const layouts = [];
  for (const [width, height, label] of [
    [1080, 1920, "portrait"],
    [1280, 720, "landscape"],
  ]) {
    const demo = createLogoDemoProject({
      width,
      height,
      fps: 30,
      bpm: 104,
      beatsPerScene: 8,
    });
    validateProject(demo);
    const file = path.join(work, `Logo ${label} source.cutline`);
    await writeFile(
      file,
      JSON.stringify({ project: demo, past: [], future: [] }),
    );
    await invoke("test.load", { path: file });
    await waitProject((p) => p.id === demo.id, "Logo layout fixture failed");
    for (const c of demo.clips) {
      const frame = c.start + Math.round(c.duration * 0.6);
      await seek(frame);
      layouts.push({ label, frame, layers: await fits() });
      await page
        .locator(".canvas")
        .screenshot({ path: path.join(work, `logo-${label}-${frame}.png`) });
    }
  }
  await writeFile(
    path.join(work, "logo-typography.json"),
    JSON.stringify(layouts, null, 2),
  );
  log(
    "Actual-font logo compositions fit landscape and portrait canvases without overflow or unintended label wraps",
  );

  p = await state();
  const visualEnd = Math.max(...p.clips.map((c) => c.start + c.duration));
  await call("cutline_music_create", {
    ...guard(p),
    style: "clean",
    seconds: 20,
    startFrame: 0,
  });
  p = await state();
  const music = p.clips.find((c) => c.kind === "audio");
  assert(music);
  await edit("Finish logo soundtrack", [
    { type: "clip.trim", clipId: music.id, end: { frame: visualEnd } },
    {
      type: "clip.update",
      clipId: music.id,
      patch: { volume: 0.5, fadeIn: 3, fadeOut: 24 },
    },
    {
      type: "project.update",
      patch: { name: "Cutline / Custom Vector Logo Showcase" },
    },
  ]);
  p = await state();
  await call("cutline_music_reactive", {
    ...guard(p),
    musicClipId: music.id,
    clipIds: p.clips.filter((c) => c.kind === "text").map((c) => c.id),
    mode: "beat",
    style: "scale",
    scope: "accents",
    amount: 0.16,
    releaseFrames: 10,
  });
  p = await state();
  assert(
    p.clips
      .filter((c) => c.kind === "text")
      .every((c) => c.musicReactive?.scope === "accents"),
  );
  assert.equal(p.assets.find((a) => a.id === music.assetId).rhythm.bpm, 104);
  const projectFile = path.join(work, "Cutline Vector Logo Showcase.cutline");
  await call("cutline_save_project", { ...guard(p), path: projectFile });
  await writeFile(
    path.join(work, "logo-assets.json"),
    JSON.stringify(p.assets, null, 2),
  );
  await writeFile(
    path.join(work, "logo-project-snapshot.json"),
    JSON.stringify(p, null, 2),
  );
  await page.locator(".stage").click({ position: { x: 4, y: 4 } });
  const logoClips = p.clips.filter((c) => c.kind === "text");
  const heldFrames = logoClips.map(
    (c) => c.start + Math.round(c.duration * 0.6),
  );
  const frames = logoClips.flatMap((c, index) => [
    c.start + 22,
    heldFrames[index],
  ]);
  const previews = new Map();
  for (const frame of frames) {
    await seek(frame);
    const png = path.join(work, `logo-preview-${frame}.png`);
    await page.locator(".canvas").screenshot({ path: png });
    previews.set(frame, pixels(png));
  }
  logoClips.forEach((c, index) =>
    assert(
      difference(previews.get(c.start + 22), previews.get(heldFrames[index])) >
        0.8,
      "A logo reveal must visibly progress from its early drawing to the held design",
    ),
  );
  const videoFile = path.join(work, "Cutline Vector Logo Showcase.mp4");
  const seconds = await exportVideo(videoFile);
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
    ),
    video = metadata.streams.find((s) => s.codec_type === "video");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assertCfrExport(ffprobe, videoFile, { fps: 30, frames: visualEnd });
  assert(metadata.streams.some((s) => s.codec_type === "audio"));
  assert(Math.abs(Number(metadata.format.duration) - visualEnd / 30) < 0.1);
  const parity = frames.map((frame) => ({
    frame,
    meanPixelDifference: difference(
      previews.get(frame),
      pixels(videoFile, frame),
    ),
  }));
  assert(
    parity.every((item) => item.meanPixelDifference < 4),
    JSON.stringify(parity),
  );
  for (const frame of frames)
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
      path.join(work, `logo-export-${frame}.png`),
    ]);
  const contact = path.join(work, "logo-contact-sheet.png");
  media(ffmpeg, [
    "-v",
    "error",
    "-y",
    ...heldFrames.flatMap((frame) => [
      "-i",
      path.join(work, `logo-export-${frame}.png`),
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
    path.join(work, "logo-export-metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  log(
    "Three original editable vector logo reveals export with a local 104 BPM soundtrack and match held preview frames",
    {
      seconds,
      duration: Number(metadata.format.duration),
      frames: visualEnd,
      parity,
      project: projectFile,
      video: videoFile,
      assetPaths: p.assets.map((a) => a.path),
      contactSheet: contact,
    },
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  log("Vector editor completes without renderer or console errors");
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
  console.log(`Vector QA artifacts: ${work}`);
}
if (failure) throw Error(failure);
