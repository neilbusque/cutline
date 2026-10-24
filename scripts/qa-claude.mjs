import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// Live check of the built-in Claude assistant: it runs the signed-in Claude
// Code CLI against this disposable app instance, asks for a real edit, and
// verifies the edit landed as one undoable transaction. Uses your Claude
// account (one short request). CUTLINE_PACKAGED=1 uses the staged app.
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const appRoot =
  process.env.CUTLINE_APP ??
  path.join(root, "release/Cutline-darwin-arm64/Cutline.app");
const executable = packaged
  ? path.join(appRoot, "Contents/MacOS/Cutline")
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const outputParent = path.resolve(
  process.env.CUTLINE_CLAUDE_QA_RESULTS ?? path.join(root, "../qa-claude"),
);
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, "run-"));
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "user-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CLAUDECODE;
const model = process.env.CUTLINE_CLAUDE_MODEL ?? "sonnet";
const app = await electron.launch({
  executablePath: executable,
  args: [...(packaged ? [] : [root]), "--force-color-profile=srgb"],
  env,
});
const results = [];
const log = (m, d) => {
  results.push({ m, d });
  console.log(m, d === undefined ? "" : JSON.stringify(d));
};
try {
  const page = await app.firstWindow({ timeout: 90000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const project = async () => (await invoke("state")).snapshot.project;
  const before = await project();
  await invoke("assistant.settings.set", {
    provider: "claude",
    claudeModel: model,
  });
  const connected = await invoke("claude.connect");
  assert(connected.account, "Claude Code is not signed in on this Mac");
  log("Claude connected", { model });
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const events = [];
  await page.exposeFunction("__claudeEvent", (e) => events.push(e));
  await page.evaluate(() =>
    window.cutline.on("assistant", (e) => window.__claudeEvent(e)),
  );
  const started = Date.now();
  await invoke("claude.send", {
    text:
      'Add a centered title that says "Hello Cutline" from 0s to 3s with a soft fade and rise in. ' +
      "Make it one transaction. Then request one preview image at frame 45 to check it, and reply in one short sentence.",
  });
  while (!events.some((e) => e.type === "completed" || e.type === "error")) {
    if (Date.now() - started > 240000)
      throw Error("Claude did not finish within 4 minutes");
    await page.waitForTimeout(500);
  }
  const done = events.find((e) => e.type === "completed" || e.type === "error");
  const tools = events.filter((e) => e.type === "tool").map((e) => e.name);
  const text = events
    .filter((e) => e.type === "delta")
    .map((e) => e.text)
    .join("");
  log("Claude finished", {
    seconds: Math.round((Date.now() - started) / 1000),
    notes: events.filter((e) => e.type === "note").map((e) => e.text),
    status: done.status ?? done.type,
    error: done.error ?? done.message,
    tools,
    reply: text.slice(0, 300),
  });
  assert.equal(done.type, "completed", done.message);
  assert.equal(done.status, "completed", done.error);
  const after = await project();
  const added = after.clips.filter(
    (c) => !before.clips.some((b) => b.id === c.id),
  );
  const titled = added.find(
    (c) => /hello cutline/i.test(JSON.stringify(c)) || c.motionId,
  );
  assert(titled, "No new title clip was added");
  assert(
    tools.includes("cutline_edit") || tools.includes("cutline_apply_edits"),
  );
  assert(
    tools.includes("cutline_preview"),
    "Claude did not review a preview frame",
  );
  log("Edit landed", {
    added: added.map((c) => ({
      kind: c.kind,
      start: c.start,
      duration: c.duration,
    })),
  });
  // Every edit is undoable: Claude may draft, preview and then fix, so undo
  // once per cutline_edit it made and the title is gone.
  const edits = tools.filter(
    (tool) => tool === "cutline_edit" || tool === "cutline_apply_edits",
  ).length;
  for (let i = 0; i < edits; i++) await invoke("undo");
  const undone = await project();
  assert(
    !undone.clips.some((c) => c.id === titled.id),
    "Undo did not remove Claude's edit",
  );
  log("Undo removes Claude's edits", { edits });
  // Stop works on a running turn and keeps the session usable.
  events.length = 0;
  await invoke("claude.send", {
    text: "Inspect the project and describe every track in detail, slowly.",
  });
  await page.waitForTimeout(1500);
  await invoke("claude.stop");
  const stopWait = Date.now();
  while (!events.some((e) => e.type === "completed" || e.type === "error")) {
    if (Date.now() - stopWait > 30000) throw Error("Stop did not end the turn");
    await page.waitForTimeout(250);
  }
  const stopped = events.find(
    (e) => e.type === "completed" || e.type === "error",
  );
  log("Stop", { status: stopped.status ?? stopped.type });
  assert.equal(stopped.status, "interrupted");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(work, "assistant-claude.png") });
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log("QA Claude passed", work);
} finally {
  await app.close();
}
