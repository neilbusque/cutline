import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createAgentConfigurations,
  quoteShellArgument,
} from "../src/shared/agent-connections";

const settings = {
  mcpLauncher: "/Applications/Cutline.app/Contents/Resources/cutline-mcp",
  connection:
    "/Users/Editor/Library/Application Support/Cutline/connection.json",
};

describe("external assistant connection recipes", () => {
  it("launches the bundled runtime in Claude Desktop without relying on node on PATH", () => {
    const config = JSON.parse(
      createAgentConfigurations(settings).claudeDesktop,
    );
    expect(config.mcpServers.cutline).toEqual({
      command: settings.mcpLauncher,
      args: [],
      env: { CUTLINE_CONNECTION: settings.connection },
    });
    expect(config.mcpServers.cutline.command).not.toBe("node");
  });

  it("round-trips escaped file paths in JSON and TOML string fields", () => {
    const paths = {
      mcpLauncher:
        '/Applications/Cutline "Studio".app/Contents/Resources/cutline-mcp',
      connection: '/Users/Editor/Library/Connection \\ "test"/connection.json',
    };
    const configs = createAgentConfigurations(paths);
    expect(JSON.parse(configs.claudeDesktop).mcpServers.cutline.command).toBe(
      paths.mcpLauncher,
    );
    expect(
      JSON.parse(
        configs.codex
          .split("\n")
          .find((line) => line.startsWith("command = "))!
          .slice("command = ".length),
      ),
    ).toBe(paths.mcpLauncher);
    expect(
      JSON.parse(
        configs.codex
          .split("\n")
          .find((line) => line.startsWith("CUTLINE_CONNECTION = "))!
          .slice("CUTLINE_CONNECTION = ".length),
      ),
    ).toBe(paths.connection);
  });

  it("allows long local jobs in Codex without placing timeout settings in the environment table", () => {
    const config = createAgentConfigurations(settings).codex;
    const [server, environment] = config.split("[mcp_servers.cutline.env]");
    expect(server).toContain("tool_timeout_sec = 600");
    expect(server).toContain('default_tools_approval_mode = "auto"');
    expect(environment).not.toContain("tool_timeout_sec");
    expect(config).not.toContain("sandbox_mode");
    expect(config).not.toContain("approval_policy");
  });

  it("preserves literal paths with apostrophes, shell expansions and backticks", () => {
    const value =
      "/Users/O'Neil/$HOME/$(printf WRONG)/`printf WRONG`/connection.json";
    const actual = execFileSync(
      "/bin/sh",
      ["-c", `printf '%s' ${quoteShellArgument(value)}`],
      { encoding: "utf8" },
    );
    expect(actual).toBe(value);
  });

  it("passes the exact command and environment assignment to each CLI without treating the server name as an env value", () => {
    const paths = {
      mcpLauncher:
        "/Applications/Cutline's Test $(printf WRONG).app/cutline-mcp",
      connection: "/Users/Editor's Test/Library/connection.json",
    };
    const configs = createAgentConfigurations(paths);
    const capture = (client: string, command: string) =>
      execFileSync(
        "/bin/sh",
        ["-c", `${client}() { printf '%s\\n' "$@"; }\n${command}`],
        { encoding: "utf8" },
      )
        .trimEnd()
        .split("\n");
    expect(capture("claude", configs.claudeCode)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--env",
      `CUTLINE_CONNECTION=${paths.connection}`,
      "--transport",
      "stdio",
      "cutline",
      "--",
      paths.mcpLauncher,
    ]);
    expect(capture("codex", configs.codexCommand)).toEqual([
      "mcp",
      "add",
      "cutline",
      "--env",
      `CUTLINE_CONNECTION=${paths.connection}`,
      "--",
      paths.mcpLauncher,
    ]);
  });

  it("refuses incomplete or relative paths instead of copying an unusable configuration", () => {
    for (const incomplete of [
      {},
      { ...settings, mcpLauncher: undefined },
      { ...settings, connection: undefined },
      { ...settings, mcpLauncher: "cutline-mcp" },
      { ...settings, connection: "~/connection.json" },
      { ...settings, connection: "/tmp/connection\n.json" },
    ])
      expect(() => createAgentConfigurations(incomplete)).toThrow(/not ready/);
  });
});
