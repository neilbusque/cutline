import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// The whole user flow: a speaker video with captions on the timeline, then
// one click on a creator-style suggestion. The signed-in Claude plans the
// beats and builds the Short with no other help. Uses Claude and the network.
//   CUTLINE_STYLE_SPEAKER=<video> CUTLINE_STYLE_SRT=<srt> node scripts/qa-style-assistant.mjs
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED !== "0";
const speaker = process.env.CUTLINE_STYLE_SPEAKER;
const srtFile = process.env.CUTLINE_STYLE_SRT;
const chip = process.env.CUTLINE_STYLE_CHIP ?? "Jack Roberts-style Short";
assert(speaker && srtFile, "Set CUTLINE_STYLE_SPEAKER and CUTLINE_STYLE_SRT.");
const out = path.resolve(
  process.env.CUTLINE_STYLE_QA_RESULTS ??
    path.join(root, "../qa-style-assistant"),
);
await mkdir(out, { recursive: true });
const data = path.join(await mkdtemp(path.join(out, "run-")), "user-data");
const env = { ...process.env, CUTLINE_QA: "1", CUTLINE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CLAUDECODE;
const executable = packaged
  ? path.join(
      process.env.CUTLINE_APP ?? "/Applications/Cutline.app",
      "Contents/MacOS/Cutline",
    )
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const app = await electron.launch({
  executablePath: executable,
  args: packaged ? ["--use-mock-keychain"] : [root, "--use-mock-keychain"],
  env,
});
let client;
const report = {};
try {
  const page = await app.firstWindow({ timeout: 90000 });
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const settings = (await invoke("state")).settings;
  client = new Client({ name: "cutline-style-assistant-qa", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: settings.mcpLauncher,
      args: [],
      env: { ...env, CUTLINE_CONNECTION: path.join(data, "connection.json") },
      stderr: "pipe",
    }),
  );
  let revision = 0,
    projectId;
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = response.content
      .filter((i) => i.type === "text")
      .map((i) => i.text)
      .join("");
    assert(!response.isError, `${name}: ${text}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
    if (typeof json.revision === "number") revision = json.revision;
    return { ...json, _content: response.content };
  };
  const first = await call("cutline_inspect");
  projectId = first.id;
  revision = first.revision;
  const guard = () => ({ projectId, revision });
  await call("cutline_edit", {
    ...guard(),
    label: "Reel canvas",
    actions: [{ type: "project.update", patch: { width: 1080, height: 1920 } }],
  });
  const imported = await call("cutline_import_media", {
    ...guard(),
    paths: [speaker],
  });
  await call("cutline_edit", {
    ...guard(),
    label: "Speaker",
    actions: [
      {
        type: "clip.add",
        kind: "video",
        assetId: imported.importedAssetIds[0],
        at: { frame: 0 },
      },
    ],
  });
  await call("cutline_caption_srt", {
    ...guard(),
    srt: await readFile(srtFile, "utf8"),
  });

  await invoke("assistant.settings.set", { provider: "claude" });
  const connected = await invoke("claude.connect");
  assert(connected.account, "Claude Code is not signed in on this Mac");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const events = [];
  await page.exposeFunction("__styleEvent", (e) => events.push(e));
  await page.evaluate(() =>
    window.cutline.on("assistant", (e) => window.__styleEvent(e)),
  );
  const started = Date.now();
  await page
    .getByRole("button", { name: new RegExp(chip) })
    .first()
    .click();
  // The chip fills the prompt; send it like a person would.
  const box = page.locator(".assistant textarea, textarea").last();
  if ((await box.inputValue().catch(() => "")).trim()) await box.press("Enter");
  while (!events.some((e) => e.type === "completed" || e.type === "error")) {
    if (Date.now() - started > 15 * 60000)
      throw Error("Claude did not finish within 15 minutes");
    await page.waitForTimeout(1000);
  }
  const done = events.find((e) => e.type === "completed" || e.type === "error");
  const tools = events.filter((e) => e.type === "tool").map((e) => e.name);
  Object.assign(report, {
    seconds: Math.round((Date.now() - started) / 1000),
    status: done.status ?? done.type,
    error: done.error ?? done.message,
    tools,
    reply: events
      .filter((e) => e.type === "delta")
      .map((e) => e.text)
      .join("")
      .slice(0, 1200),
  });
  console.log(JSON.stringify(report, null, 2));
  assert(
    tools.includes("cutline_style_reel"),
    "Claude did not use cutline_style_reel",
  );
  const current = await call("cutline_inspect");
  revision = current.revision;
  const frames = [1, 3, 5, 7, 9, 12, 16, 19, 23, 27, 33, 37].map((s) =>
    Math.round(s * 30),
  );
  const sheet = await call("cutline_preview", {
    ...guard(),
    frames,
    width: 1800,
  });
  const image = sheet._content.find((i) => i.type === "image");
  await writeFile(
    path.join(out, "assistant-built.jpg"),
    Buffer.from(image.data, "base64"),
  );
  console.log("✓ frames", path.join(out, "assistant-built.jpg"));
} finally {
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await client?.close().catch(() => {});
  await app.close().catch(() => {});
}
