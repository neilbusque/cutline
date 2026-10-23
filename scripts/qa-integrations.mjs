import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const root = process.cwd(),
  work = path.resolve("../../work");
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "qa-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.join(
    root,
    "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  ),
  args: [root],
  env,
});
let client;
const results = [];
try {
  const page = await app.firstWindow();
  await page.waitForSelector(".titlebar");
  const events = [];
  await page.exposeFunction("recordAssistant", (e) => {
    events.push(e);
    console.log("AI", JSON.stringify(e).slice(0, 300));
  });
  await page.evaluate(() =>
    window.cutline.on("assistant", window.recordAssistant),
  );
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const before = (await invoke("state")).snapshot.project;
  console.log("Project", before.name, before.clips.length, "clips");
  client = new Client({ name: "cutline-qa", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/main/mcp.cjs")],
      env: {
        ...process.env,
        CUTLINE_CONNECTION: path.join(work, "qa-data/connection.json"),
      },
    }),
  );
  const list = await client.listTools();
  assert(list.tools.length >= 8);
  const inspected = await client.callTool({
    name: "cutline_inspect",
    arguments: {},
  });
  const current = JSON.parse(inspected.content[0].text);
  assert(!current.assets[0].path);
  const text = current.clips.find((c) => c.kind === "text");
  await client.callTool({
    name: "cutline_apply_edits",
    arguments: {
      projectId: current.id,
      revision: current.revision,
      label: "MCP title edit",
      commands: [
        {
          type: "clip.update",
          id: text.id,
          patch: { text: "Edited through MCP" },
        },
      ],
    },
  });
  assert.equal(
    (await invoke("state")).snapshot.project.clips.find((c) => c.id === text.id)
      .text,
    "Edited through MCP",
  );
  await invoke("undo");
  results.push("External MCP transport: list, inspect, apply edit, undo");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await invoke("codex.send", {
    text: 'Use cutline_inspect and then cutline_apply_edits to change the first text clip to exactly "Made with Cutline". Make no other changes. Keep your reply short.',
  });
  const start = Date.now();
  while (!events.some((e) => e.type === "completed" || e.type === "error")) {
    await new Promise((r) => setTimeout(r, 1000));
    if (Date.now() - start > 180000) throw Error("Codex timed out");
  }
  assert.equal(
    (await invoke("state")).snapshot.project.clips.find(
      (c) => c.kind === "text",
    ).text,
    "Made with Cutline",
  );
  results.push("Embedded Codex: real tool-driven edit verified");
  await invoke("undo");
  results.push("AI edit undone successfully");
  await page.screenshot({
    path: path.join(root, "screenshots/04-assistant.png"),
  });
  if (process.env.CUTLINE_SKIP_EXPORT !== "1") {
    console.log("Starting export");
    const started = Date.now();
    const job = await invoke("test.export", {
      path: path.join(root, "acceptance-demo.mp4"),
    });
    let last = -1;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const state = (await invoke("state")).jobs.find((j) => j.id === job.id);
      if (Math.floor(state.progress * 10) > last) {
        last = Math.floor(state.progress * 10);
        console.log("Export", Math.round(state.progress * 100) + "%");
      }
      if (state.state === "done") {
        results.push(
          `Exported 75-second 1080p MP4 in ${Math.round((Date.now() - started) / 1000)}s`,
        );
        break;
      }
      if (state.state !== "running") throw Error(state.message);
      if (Date.now() - started > 900000) throw Error("Export timed out");
    }
  }
  await writeFile(
    "qa-integration-results.json",
    JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
  );
  console.log(results);
} finally {
  await client?.close();
  await app.close();
}
