/** Connection recipes use Cutline's bundled launcher; external clients need no system Node. */
export type AgentConnectionSettings = {
  mcpLauncher?: string;
  connection?: string;
  mcpUrl?: string;
};
export type AgentBridgeStatus = {
  ready: boolean;
  launcherReady: boolean;
  message: string;
  tools?: number;
  projectName?: string;
  protocols?: string[];
  lastCall?: { tool: string; at: string | number };
};
export const connectionVerificationPrompt =
  "Use cutline_inspect to inspect the open Cutline project. Report its canvas size, timeline tracks, clips and editable motion layers. Do not change the project.";

export const agentCapabilities = [
  {
    name: "Projects & media",
    detail:
      "Create, open and save projects; import local video, audio and images by absolute path.",
  },
  {
    name: "Timeline & layers",
    detail:
      "Add, trim, split, delete and arrange clips; change timing, speed, volume and track visibility.",
  },
  {
    name: "Motion graphics",
    detail:
      "Create editable text and shape compositions with keyframes, easing, loops, gradients, strokes, glow and animated text.",
  },
  {
    name: "Effects & transitions",
    detail:
      "Adjust color looks, blur, camera motion, masks, blend modes and crossfades, slides or wipes.",
  },
  {
    name: "Captions & speech",
    detail:
      "Generate local word-timed captions, import or export SRT text, edit styling, find phrases in transcripts and remove long pauses.",
  },
  {
    name: "Complete reels",
    detail:
      "Build an editable reel from imported assets with cuts, B-roll, titles, captions and music.",
  },
  {
    name: "Stock discovery",
    detail:
      "Search supported stock providers for photos and footage with licensing and creator details.",
  },
  {
    name: "Visual review",
    detail:
      "Look at rendered frames, one at a time or as a contact sheet, exactly as the export will look; seek, play, pause and select clips.",
  },
  {
    name: "Export & recovery",
    detail:
      "Export MP4 locally, wait for, check or cancel processing jobs, and undo or redo edits.",
  },
] as const;

function absoluteFile(value: string | undefined, label: string): string {
  if (!value || !value.startsWith("/") || /[\u0000-\u001f\u007f]/.test(value))
    throw Error(`${label} is not ready. Reopen Cutline and try again.`);
  return value;
}

/** POSIX quoting protects paths containing spaces, apostrophes, dollars and command substitutions. */
export function quoteShellArgument(value: string): string {
  if (/[\u0000]/.test(value))
    throw Error("Shell arguments cannot contain a null byte.");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createAgentConfigurations(settings: AgentConnectionSettings) {
  const launcher = absoluteFile(settings.mcpLauncher, "The local MCP launcher");
  const connection = absoluteFile(
    settings.connection,
    "The project connection file",
  );
  const server = {
    command: launcher,
    args: [] as string[],
    env: { CUTLINE_CONNECTION: connection },
  };
  const envArgument = quoteShellArgument(`CUTLINE_CONNECTION=${connection}`);
  const launcherArgument = quoteShellArgument(launcher);
  return {
    claudeDesktop: JSON.stringify({ mcpServers: { cutline: server } }, null, 2),
    // --env is variadic in Claude Code; --transport terminates its value list before the server name.
    claudeCode: `claude mcp add --scope user --env ${envArgument} --transport stdio cutline -- ${launcherArgument}`,
    codex: `[mcp_servers.cutline]\ncommand = ${JSON.stringify(launcher)}\nargs = []\ntool_timeout_sec = 600\ndefault_tools_approval_mode = "auto"\n\n[mcp_servers.cutline.env]\nCUTLINE_CONNECTION = ${JSON.stringify(connection)}`,
    codexCommand: `codex mcp add cutline --env ${envArgument} -- ${launcherArgument}`,
    localLaunchCommand: `env ${envArgument} ${launcherArgument}`,
  };
}
