import { _electron as electron } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// Live check of the external path Neil uses from any Claude Code session:
// the signed-in `claude` CLI connects to this disposable Cutline through the
// bundled stdio MCP launcher, builds an animation, reviews it with a contact
// sheet and reports. One short request on your Claude account.
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
  process.env.CUTLINE_CLAUDE_QA_RESULTS ?? path.join(root, "../qa-claude-code"),
);
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, "run-"));
const data = path.join(work, "user-data");
const env = { ...process.env, CUTLINE_QA: "1", CUTLINE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CLAUDECODE;
const claudeBin = process.env.CUTLINE_CLAUDE_PATH ?? "/opt/homebrew/bin/claude";
const model = process.env.CUTLINE_CLAUDE_MODEL ?? "sonnet";
const app = await electron.launch({
  executablePath: executable,
  args: [...(packaged ? [] : [root]), "--force-color-profile=srgb"],
  env,
});
try {
  const page = await app.firstWindow({ timeout: 90000 });
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const { settings, snapshot } = await invoke("state");
  const before = snapshot.project;
  const config = path.join(work, "mcp.json");
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        cutline: {
          type: "stdio",
          command: settings.mcpLauncher,
          args: [],
          env: {
            CUTLINE_CONNECTION: path.join(data, "connection.json"),
            CUTLINE_NO_AUTOSTART: "1",
          },
        },
      },
    }),
  );
  const prompt =
    'In Cutline, make a 4 second kinetic title that says "Cutline 0.14" with a line accent that draws on under it. ' +
    "Use one cutline_edit transaction, then check it with one cutline_preview contact sheet of 3 frames (start, middle, settled), and reply in two sentences.";
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      claudeBin,
      [
        "-p",
        "--output-format",
        "json",
        "--setting-sources",
        "",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        config,
        "--allowedTools",
        "mcp__cutline",
        "--permission-mode",
        "dontAsk",
        "--model",
        model,
        "--no-session-persistence",
        prompt,
      ],
      { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 300000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(
          Error(`claude exited ${code}: ${err.slice(-500) || out.slice(-500)}`),
        );
      }
    });
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    "Claude Code finished",
    JSON.stringify({
      seconds,
      turns: result.num_turns,
      error: result.is_error,
      reply: String(result.result).slice(0, 400),
    }),
  );
  assert(!result.is_error, String(result.result));
  const after = (await invoke("state")).snapshot.project;
  const added = after.clips.filter(
    (c) => !before.clips.some((b) => b.id === c.id),
  );
  assert(added.length > 0, "Claude Code did not add anything");
  assert(
    JSON.stringify(after).toLowerCase().includes("cutline 0.14"),
    "The title text is missing",
  );
  console.log(
    "Edit landed",
    JSON.stringify(
      added.map((c) => ({
        kind: c.kind,
        start: c.start,
        duration: c.duration,
      })),
    ),
  );
  await page.screenshot({ path: path.join(work, "claude-code-edit.png") });
  await writeFile(
    path.join(work, "result.json"),
    JSON.stringify({ seconds, result, added }, null, 2),
  );
  console.log("QA Claude Code passed", work);
} finally {
  await app.close();
}
