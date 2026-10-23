import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  installClaudeConnection,
  installCodexConnection,
  writeAgentLauncher,
} from "../src/main/agent-connection";

it("bundled launcher handles quoted paths and defaults its connection without shell expansion", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cutline-agent-"));
  try {
    const script = path.join(dir, "script '$()` with spaces.cjs");
    const connection = path.join(dir, "connection '$(false).json");
    writeFileSync(
      script,
      "console.log(JSON.stringify({connection:process.env.CUTLINE_CONNECTION, runtime:process.env.ELECTRON_RUN_AS_NODE,args:process.argv.slice(2)}))",
    );
    const launcher = writeAgentLauncher(
      dir,
      process.execPath,
      script,
      connection,
    );
    const env = { ...process.env };
    delete env.CUTLINE_CONNECTION;
    const result = spawnSync(launcher, ["literal '$()`"], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      connection,
      runtime: "1",
      args: ["literal '$()`"],
    });
    expect(statSync(launcher).mode & 0o777).toBe(0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("updates only Cutline's Codex tables and backs up unrelated configuration", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cutline-codex-config-"));
  try {
    const file = path.join(dir, "config.toml");
    const launcher = writeAgentLauncher(
      dir,
      process.execPath,
      "app.cjs",
      "connection.json",
    );
    const original =
      'model = "example"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.cutline]\ncommand = "old"\nargs = ["old-script"]\n\n[mcp_servers.cutline.env]\nCUTLINE_CONNECTION = "old"\n\n[memories]\nuse_memories = true\n';
    writeFileSync(file, original);
    const result = installCodexConnection(
      file,
      launcher,
      path.join(dir, "connection.json"),
    );
    const current = readFileSync(file, "utf8");
    expect(current).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(current).toContain("[memories]\nuse_memories = true");
    expect(current).toContain('model = "example"');
    expect(current).not.toContain('command = "old"');
    expect(current.match(/\[mcp_servers.cutline\]/g)).toHaveLength(1);
    expect(current).toContain('default_tools_approval_mode = "auto"');
    expect(readFileSync(result.backup!, "utf8")).toBe(original);
    const second = installCodexConnection(
      file,
      launcher,
      path.join(dir, "connection.json"),
    );
    expect(readFileSync(file, "utf8")).toBe(current);
    expect(second.installed).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("install merges Claude configuration and keeps a recoverable original", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cutline-config-"));
  try {
    const file = path.join(dir, "claude-config.json");
    const launcher = writeAgentLauncher(
      dir,
      process.execPath,
      "app.cjs",
      "connection.json",
    );
    const original = {
      preferences: { theme: "dark" },
      mcpServers: { other: { command: "other-app" } },
    };
    writeFileSync(file, JSON.stringify(original));
    const result = installClaudeConnection(file, launcher, "connection.json");
    const merged = JSON.parse(readFileSync(file, "utf8"));
    expect(merged.preferences).toEqual(original.preferences);
    expect(merged.mcpServers.other).toEqual(original.mcpServers.other);
    expect(merged.mcpServers.cutline.command).toBe(launcher);
    expect(JSON.parse(readFileSync(result.backup!, "utf8"))).toEqual(original);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "malformed");
    expect(() =>
      installClaudeConnection(file, launcher, "connection.json"),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe("malformed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
