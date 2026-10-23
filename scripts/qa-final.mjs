import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
const root = process.cwd(),
  work = path.resolve("../../work"),
  appRoot = path.join(root, "release/Cutline-darwin-arm64/Cutline.app");
const data = path.join(work, "qa-final-data"),
  file = path.join(work, "final-project.cutline");
await mkdir(data, { recursive: true });
const fixture = JSON.parse(
  await readFile("sample-project/Cutline Demo.cutline", "utf8"),
);
const short = process.env.CUTLINE_QA_SHORT === "1";
if (short) {
  fixture.project.clips = fixture.project.clips
    .filter((c) => c.start < 180)
    .map((c) => ({ ...c, duration: Math.min(c.duration, 180 - c.start) }));
}
await writeFile(file, JSON.stringify(fixture));
const env = { ...process.env, CUTLINE_QA: "1", CUTLINE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: process.env.CUTLINE_SOURCE_TEST
    ? path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      )
    : path.join(appRoot, "Contents/MacOS/Cutline"),
  args: process.env.CUTLINE_SOURCE_TEST ? [root, file] : [file],
  env,
});
let client;
const results = [],
  errors = [];
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus(),
  );
  await page.waitForSelector(".titlebar");
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("RENDERER ERROR", e.stack);
  });
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const initial = (await invoke("state")).snapshot.project;
  assert(initial.clips.length > 1);
  results.push("Packaged app opens .cutline project directly");
  const title = initial.clips.find((c) => c.kind === "text");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await new Promise((r) => setTimeout(r, 2500));
  const started = Date.now();
  const t0 = await page
    .locator("video")
    .first()
    .evaluate((v) => v.currentTime);
  await new Promise((r) => setTimeout(r, short ? 2000 : 5000));
  const t1 = await page
    .locator("video")
    .first()
    .evaluate((v) => v.currentTime);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const wall = (Date.now() - started) / 1000;
  console.log("PLAYBACK", JSON.stringify({ t0, t1, wall, delta: t1 - t0 }));
  assert(Math.abs(t1 - t0 - wall) < 0.6);
  results.push(
    `Steady-state playback after 2.5s warm-up: ${Math.round((t1 - t0) * 100) / 100}s media over ${wall.toFixed(2)}s wall time`,
  );
  await page.locator(".timeline-clip.text").first().click();
  await page
    .getByRole("button", { name: "Create custom animation", exact: true })
    .click();
  await page.getByText("2. Title text", { exact: true }).click();
  await page.getByLabel("Layer text", { exact: true }).fill("A little motion");
  await page.getByLabel("Layer text", { exact: true }).press("Tab");
  await page.waitForFunction(() =>
    document
      .querySelector(".motion-inspector")
      ?.textContent?.includes("A little motion"),
  );
  const custom = (await invoke("state")).snapshot.project;
  assert.equal(custom.clips.find((c) => c.id === title.id).preset, "custom");
  assert(
    custom.motions.some((m) =>
      m.layers.some((l) => l.text === "A little motion"),
    ),
  );
  await invoke("undo");
  await invoke("undo");
  results.push(
    "Create and edit custom motion using visual controls; undo restores original",
  );
  client = new Client({ name: "cutline-final-qa", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(appRoot, "Contents/Resources/app/dist/main/mcp.cjs")],
      env: {
        ...process.env,
        CUTLINE_CONNECTION: path.join(data, "connection.json"),
      },
    }),
  );
  const inspected = JSON.parse(
    (
      await client.callTool({
        name: "cutline_inspect",
        arguments: { detail: "full" },
      })
    ).content[0].text,
  );
  assert(!inspected.assets[0].path);
  const previous = inspected.clips.find((c) => c.id === title.id);
  await client.callTool({
    name: "cutline_apply_edits",
    arguments: {
      projectId: inspected.id,
      revision: inspected.revision,
      label: "MCP text test",
      commands: [
        { type: "clip.update", id: title.id, patch: { text: "MCP verified" } },
      ],
    },
  });
  assert.deepEqual(
    (await invoke("state")).snapshot.project.clips.find(
      (c) => c.id === title.id,
    ),
    { ...previous, text: "MCP verified" },
  );
  await invoke("undo");
  results.push(
    "Packaged MCP makes an isolated property edit without resetting other fields",
  );
  const events = [];
  await page.exposeFunction("recordAssistant", (e) => {
    events.push(e);
    if (["tool", "completed", "error"].includes(e.type))
      console.log("Codex", JSON.stringify(e));
  });
  await page.evaluate(() =>
    window.cutline.on("assistant", window.recordAssistant),
  );
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  console.log("Testing Codex custom motion generation");
  await invoke("codex.send", {
    text: 'Use cutline_inspect, then a SINGLE cutline_apply_edits transaction to create a custom animation named "AI Soft Bounce" and attach it to the first text clip using preset custom and motionId. Use one text layer with empty text (inherit clip text), width 1080, height 180, fontSize 90, color #c6f16d. Keyframes: frame 0 y=30 opacity=0; frame 18 y=-5 opacity=1; frame 26 y=0 opacity=1. Do not change any other clip fields. Reply briefly.',
  });
  const aiStart = Date.now();
  while (!events.some((e) => e.type === "completed" || e.type === "error")) {
    await new Promise((r) => setTimeout(r, 1000));
    if (Date.now() - aiStart > 240000) throw Error("AI timed out");
  }
  const afterAi = (await invoke("state")).snapshot.project;
  const aiMotion = afterAi.motions.find((m) => m.name === "AI Soft Bounce");
  assert(aiMotion, "AI did not create motion");
  assert.equal(
    afterAi.clips.find((c) => c.id === title.id).motionId,
    aiMotion.id,
  );
  await page.screenshot({ path: "screenshots/04-assistant.png" });
  await invoke("undo");
  assert.equal(
    (await invoke("state")).snapshot.project.clips.find(
      (c) => c.id === title.id,
    ).preset,
    previous.preset,
  );
  results.push(
    "Codex generates and attaches custom motion in a single undoable transaction",
  );
  console.log("Rendering final 75-second acceptance export");
  const exportStart = Date.now();
  const job = await invoke("test.export", {
    path: path.join(
      root,
      short ? "acceptance-smoke.mp4" : "acceptance-demo.mp4",
    ),
  });
  const beforeConcurrent = (await invoke("state")).snapshot.project;
  await invoke("edit", {
    projectId: beforeConcurrent.id,
    revision: beforeConcurrent.revision,
    label: "Edit while rendering",
    commands: [
      {
        type: "clip.update",
        id: title.id,
        patch: { text: "This change must not reach the running export" },
      },
    ],
  });
  let last = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const j = (await invoke("state")).jobs.find((j) => j.id === job.id);
    if (Math.floor(j.progress * 10) > last) {
      last = Math.floor(j.progress * 10);
      console.log("Export", Math.round(j.progress * 100) + "%");
    }
    if (j.state === "done") {
      results.push(
        `Final ${short ? 6 : 75}-second 1080p export: ${Math.round((Date.now() - exportStart) / 1000)}s`,
      );
      break;
    }
    if (j.state !== "running") throw Error(j.message);
    if (Date.now() - exportStart > 900000) throw Error("Export timed out");
  }
  await invoke("undo");
  await page.locator(".ruler").click({ position: { x: 90 * 0.85, y: 12 } });
  await page.locator(".stage").click({ position: { x: 10, y: 10 } });
  await new Promise((r) => setTimeout(r, 500));
  await page
    .locator(".canvas")
    .screenshot({ path: "screenshots/preview-frame-90.png" });
  assert.deepEqual(errors, []);
  results.push("No uncaught renderer errors");
  await writeFile(
    short ? "qa-final-smoke-results.json" : "qa-final-results.json",
    JSON.stringify(
      { date: new Date().toISOString(), results, errors },
      null,
      2,
    ),
  );
  console.log(results);
} catch (error) {
  const page = await app.firstWindow();
  console.log(
    "ERROR STATE",
    errors,
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  await page
    .screenshot({ path: "screenshots/final-error.png" })
    .catch(() => {});
  await writeFile(
    "qa-final-failure.json",
    JSON.stringify({ results, errors, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await client?.close();
  await app.close();
}
