import { createMcpServer } from "./mcp-server";
import { createLauncher, openCutlineApp } from "./mcp-launcher";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import os from "node:os";
import { sessionTools } from "./session-routing";

// The stdio server that Claude Code, Claude Desktop and Codex start. It lists
// Cutline's tools even while the app is closed, and opens Cutline when a tool
// is called (set CUTLINE_NO_AUTOSTART=1 to only explain how to open it).
const connection =
  process.env.CUTLINE_CONNECTION ??
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Cutline",
    "connection.json",
  );
const launcher = createLauncher({
  connection,
  sessionRoot: process.env.CUTLINE_SESSION_ROOT,
  currentId: process.env.CUTLINE_SESSION_ID,
  // Loaded only when Cutline is closed, so a launcher stays small while the
  // app answers (many assistant sessions each run one).
  tools: () =>
    import("./agent-tools").then((module) => sessionTools(module.cutlineTools)),
  open: process.env.CUTLINE_NO_AUTOSTART ? undefined : () => openCutlineApp(),
});
const server = createMcpServer(launcher.listTools, launcher.rpc);
server.connect(new StdioServerTransport());
