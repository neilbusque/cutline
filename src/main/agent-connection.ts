import { CUTLINE_VERSION } from "../shared/version";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgentConfigurations } from "../shared/agent-connections";

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export function writeAgentLauncher(
  directory: string,
  executable: string,
  script: string,
  connection: string,
) {
  const file = path.join(directory, "cutline-mcp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    file,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nif [ -z "$CUTLINE_CONNECTION" ]; then\n  export CUTLINE_CONNECTION=${quote(connection)}\nfi\nexec ${quote(executable)} ${quote(script)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(file, 0o700);
  return file;
}

export async function testAgentConnection(
  launcher: string,
  connection: string,
  sessionId?: string,
) {
  const transport = new StdioClientTransport({
    command: launcher,
    args: [],
    env: {
      ...(process.env as Record<string, string>),
      CUTLINE_CONNECTION: connection,
      // A connection check must never start a second Cutline.
      CUTLINE_NO_AUTOSTART: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "cutline-connection-check",
    version: CUTLINE_VERSION,
  });
  try {
    await client.connect(transport, { timeout: 15000 });
    const result = await client.listTools({}, { timeout: 15000 });
    // The launcher lists tools even while Cutline is closed, so also make one
    // call that has to reach the running app.
    const status = await client.callTool(
      {
        name: "cutline_connection_status",
        arguments: sessionId ? { sessionId } : {},
      },
      undefined,
      { timeout: 15000 },
    );
    if (status.isError)
      throw Error(
        (status.content as { text?: string }[])[0]?.text ??
          "Cutline's bridge did not answer.",
      );
    return result.tools.length;
  } finally {
    await client.close();
  }
}

export function installClaudeConnection(
  file: string,
  launcher: string,
  connection: string,
) {
  if (!existsSync(launcher))
    throw Error("Cutline's MCP launcher is missing. Reopen the app.");
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw Error("Claude's configuration is not a JSON object.");
  if (
    data.mcpServers &&
    (typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers))
  )
    throw Error("Claude's mcpServers configuration is invalid.");
  const backup = existsSync(file)
    ? file + `.cutline-backup-${Date.now()}`
    : null;
  if (backup) copyFileSync(file, backup);
  data.mcpServers = {
    ...data.mcpServers,
    cutline: { command: launcher, env: { CUTLINE_CONNECTION: connection } },
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".cutline-tmp";
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, file);
  return {
    installed: true,
    message:
      "Cutline connection installed. Restart Claude Desktop to load its tools.",
    backup,
  };
}

export function installCodexConnection(
  file: string,
  launcher: string,
  connection: string,
) {
  if (!existsSync(launcher))
    throw Error("Cutline's MCP launcher is missing. Reopen the app.");
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = original.split("\n");
  const headers = lines.filter((line) =>
    /^\s*\[mcp_servers\.cutline(?:\.env)?\]\s*(?:#.*)?$/.test(line),
  );
  if (
    headers.filter((line) => /cutline\]/.test(line)).length > 1 ||
    headers.filter((line) => /cutline\.env\]/.test(line)).length > 1
  )
    throw Error(
      "Duplicate Cutline configuration tables found. Update the configuration manually.",
    );
  let skipping = false;
  const kept = lines
    .filter((line) => {
      if (/^\s*\[/.test(line))
        skipping = /^\s*\[mcp_servers\.cutline(?:\.env)?\]\s*(?:#.*)?$/.test(
          line,
        );
      return !skipping;
    })
    .join("\n");
  const config = createAgentConfigurations({
    mcpLauncher: launcher,
    connection,
  }).codex;
  mkdirSync(path.dirname(file), { recursive: true });
  const backup = existsSync(file)
    ? file + `.cutline-backup-${Date.now()}`
    : null;
  if (backup) copyFileSync(file, backup);
  const temporary = file + ".cutline-tmp";
  writeFileSync(temporary, kept.trimEnd() + "\n\n" + config + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, file);
  return {
    installed: true,
    message:
      "Cutline connection installed. Start a new Codex chat or reconnect MCP to load its tools.",
    backup,
  };
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; output: string }>((resolve) =>
    execFile(bin, args, { env, timeout: 30000 }, (error, stdout, stderr) =>
      resolve({
        code: error ? ((error as any).code ?? 1) : 0,
        output: `${stdout}${stderr}`.trim(),
      }),
    ),
  );
}

/** Adds (or refreshes) Cutline in Claude Code for every project of this user. */
export async function installClaudeCodeConnection(
  bin: string | undefined,
  launcher: string,
  connection: string,
  env: NodeJS.ProcessEnv,
) {
  if (!bin)
    throw Error(
      "Claude Code isn't installed on this Mac. Install it, then add Cutline again.",
    );
  if (!existsSync(launcher))
    throw Error("Cutline's MCP launcher is missing. Reopen the app.");
  // Replace an older entry so the launcher path stays current.
  await run(bin, ["mcp", "remove", "--scope", "user", "cutline"], env);
  const added = await run(
    bin,
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "--env",
      `CUTLINE_CONNECTION=${connection}`,
      "--transport",
      "stdio",
      "cutline",
      "--",
      launcher,
    ],
    env,
  );
  if (added.code !== 0)
    throw Error(
      `Claude Code didn't accept the connection: ${added.output || "unknown error"}`,
    );
  return {
    installed: true,
    message:
      "Cutline added to Claude Code for all your projects. Start a new Claude Code session and run /mcp to see it.",
  };
}
