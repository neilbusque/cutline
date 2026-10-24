import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { assistantInstructions } from "../shared/assistant-instructions";

export type ClaudeModel = "opus" | "sonnet";
const TOOL_PREFIX = "mcp__cutline__";

/** Apps opened from Finder get a minimal PATH, so look where installers put the CLI. */
export function findClaude(env: NodeJS.ProcessEnv = process.env) {
  const home = os.homedir();
  return [
    env.CUTLINE_CLAUDE_PATH,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".local/bin/claude"),
    path.join(home, ".claude/local/claude"),
    path.join(home, ".npm-global/bin/claude"),
    path.join(home, ".bun/bin/claude"),
  ].find((file): file is string => !!file && existsSync(file));
}

function childEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A Cutline started from inside a Claude Code session must not look nested.
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[key];
  const home = os.homedir();
  env.PATH = [
    env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
  ]
    .filter(Boolean)
    .join(":");
  // Load every Cutline tool up front (built-in tool search is disabled) and
  // allow long local jobs such as transcription to finish.
  env.ENABLE_TOOL_SEARCH = "false";
  env.MCP_TOOL_TIMEOUT = "600000";
  // Claude Code's file memory would promise to remember things it can't use here.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

function friendly(message: string) {
  if (
    /log ?in|authenticat|api key|unauthori[sz]ed|\b401\b|oauth/i.test(message)
  )
    return "Claude needs you to sign in. Choose Connect in the assistant, or run `claude auth login` in Terminal.";
  if (/rate limit|usage limit|\b429\b|overloaded/i.test(message))
    return `Claude is busy or you reached a usage limit. Try again shortly. (${message})`;
  return message;
}

/**
 * Cutline's built-in Claude assistant. It runs the signed-in Claude Code CLI
 * headless with only Cutline's MCP tools: no built-in tools, no user settings,
 * hooks or plugins, and no permission prompts beyond Cutline's own tools.
 */
export class ClaudeAssistant extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private session?: string;
  private resumable = false;
  private projectId?: string;
  private stopping = false;
  private watchdog?: NodeJS.Timeout;
  private interruptTimer?: NodeJS.Timeout;
  private textInTurn = false;
  private pendingBreak = false;
  private stderr = "";
  private state = {
    status: "disconnected",
    message: "Not connected",
  };
  busy = false;
  model: ClaudeModel = "opus";

  constructor(
    readonly cwd: string,
    readonly mcpUrl: () => string,
    readonly options: {
      bin?: () => string | undefined;
      authStatus?: (
        bin: string,
      ) => Promise<{ loggedIn: boolean; email?: string }>;
      watchdogMs?: number;
      interruptMs?: number;
    } = {},
  ) {
    super();
    mkdirSync(cwd, { recursive: true });
  }

  status() {
    return {
      ...this.state,
      busy: this.busy,
      provider: "claude" as const,
      model: this.model,
    };
  }

  private emitState(value: any) {
    if (value.type === "connected")
      this.state = {
        status: value.account === "signed-out" ? "signed-out" : "connected",
        message:
          value.account === "signed-out"
            ? "Sign in to Claude"
            : "Connected to Claude",
      };
    if (value.type === "connecting")
      this.state = { status: "connecting", message: "Connecting to Claude…" };
    if (value.type === "error")
      this.state = { status: "error", message: value.message };
    this.emit("event", { ...value, provider: "claude" });
  }

  private bin() {
    const bin = (this.options.bin ?? findClaude)();
    if (!bin)
      throw Error(
        "Claude Code isn't installed on this Mac. Install it from claude.com/code, sign in once, then connect again.",
      );
    return bin;
  }

  private authStatus(bin: string) {
    if (this.options.authStatus) return this.options.authStatus(bin);
    return new Promise<{ loggedIn: boolean; email?: string }>(
      (resolve, reject) =>
        execFile(
          bin,
          ["auth", "status"],
          { env: childEnv(), timeout: 15000, cwd: this.cwd },
          (error, stdout) => {
            try {
              const parsed = JSON.parse(String(stdout));
              resolve({ loggedIn: !!parsed.loggedIn, email: parsed.email });
            } catch {
              if (error) reject(Error(friendly(error.message)));
              else resolve({ loggedIn: false });
            }
          },
        ),
    );
  }

  async connect() {
    this.emitState({ type: "connecting" });
    try {
      const bin = this.bin();
      const auth = await this.authStatus(bin);
      this.emitState({
        type: "connected",
        account: auth.loggedIn ? "claude" : "signed-out",
      });
      return {
        account: auth.loggedIn ? { type: "claude", email: auth.email } : null,
      };
    } catch (error) {
      this.emitState({ type: "error", message: (error as Error).message });
      throw error;
    }
  }

  async login() {
    const bin = this.bin();
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        bin,
        ["auth", "login"],
        { env: childEnv(), timeout: 300000, cwd: this.cwd },
        (error) =>
          error
            ? reject(
                Error(
                  "Claude sign-in didn't finish. Run `claude auth login` in Terminal, then connect again.",
                ),
              )
            : resolve(),
      );
      child.stdin?.end();
    });
    return this.connect();
  }

  async reconnect() {
    if (this.busy) throw Error("Stop the current edit before reconnecting");
    this.close();
    return this.connect();
  }

  setModel(model: ClaudeModel) {
    if (model !== "opus" && model !== "sonnet") throw Error("Unknown model");
    if (this.busy) throw Error("Wait for the current edit before switching");
    if (model === this.model) return this.status();
    this.model = model;
    // The next message starts a process on the new model and resumes the chat.
    this.close();
    return this.status();
  }

  private touch() {
    clearTimeout(this.watchdog);
    if (this.busy)
      this.watchdog = setTimeout(
        () =>
          this.fail(
            Error(
              "Claude stopped responding. Inspect your project before retrying; completed edits are kept.",
            ),
          ),
        this.options.watchdogMs ?? 300000,
      );
  }

  private spawnSession() {
    const bin = this.bin();
    const sessionArgs = this.session
      ? this.resumable
        ? ["--resume", this.session]
        : ["--session-id", this.session]
      : [];
    if (!this.session) {
      this.session = randomUUID();
      sessionArgs.push("--session-id", this.session);
    }
    const child = spawn(
      bin,
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--setting-sources",
        "",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({
          mcpServers: { cutline: { type: "http", url: this.mcpUrl() } },
        }),
        "--allowedTools",
        "mcp__cutline",
        "--permission-mode",
        "dontAsk",
        "--model",
        this.model,
        // The whole editing workflow as the system prompt, in place of
        // Claude Code's coding prompt. Delivered as MCP server instructions
        // it was cut to its first 2,048 characters.
        "--system-prompt",
        assistantInstructions,
        ...sessionArgs,
      ],
      { cwd: this.cwd, env: childEnv(), stdio: "pipe" },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.stderr = "";
    // Only the current process can fail the session; a replaced or closed
    // process exiting later is ignored.
    const failed = (error: Error) => {
      if (this.child === child) this.fail(error);
    };
    child.on("error", (error: NodeJS.ErrnoException) =>
      failed(
        error.code === "ENOENT"
          ? Error(
              "Claude Code couldn't be started. Reinstall it, then connect again.",
            )
          : error,
      ),
    );
    child.stdin.on("error", failed);
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    child.on("exit", () =>
      failed(
        Error(
          friendly(
            this.stderr.trim().split("\n").pop() ||
              "Claude disconnected. Send your request again; completed edits are kept.",
          ),
        ),
      ),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child !== child) return;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.message(message);
    });
    return child;
  }

  private message(m: any) {
    this.touch();
    if (m.type === "system" && m.subtype === "init") {
      this.resumable = true;
      const cutline = (m.mcp_servers ?? []).find(
        (s: any) => s.name === "cutline",
      );
      if (cutline && cutline.status !== "connected")
        this.emitState({
          type: "warning",
          message: `Cutline's tools didn't load in Claude (${cutline.status}).`,
        });
      return;
    }
    if (m.type === "stream_event") {
      const event = m.event;
      if (m.parent_tool_use_id) return;
      if (event?.type === "message_start") this.pendingBreak = this.textInTurn;
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        event.delta.text
      ) {
        if (this.pendingBreak) {
          this.emitState({ type: "delta", text: "\n\n" });
          this.pendingBreak = false;
        }
        this.textInTurn = true;
        this.emitState({ type: "delta", text: event.delta.text });
      }
      return;
    }
    if (m.type === "assistant") {
      for (const block of m.message?.content ?? [])
        if (
          block.type === "tool_use" &&
          String(block.name).startsWith(TOOL_PREFIX)
        )
          this.emitState({
            type: "tool",
            name: String(block.name).slice(TOOL_PREFIX.length),
          });
      return;
    }
    if (m.type === "result") {
      clearTimeout(this.watchdog);
      clearTimeout(this.interruptTimer);
      const interrupted = this.stopping;
      const ok = m.subtype === "success" && !m.is_error;
      const detail = String(
        m.result ||
          (Array.isArray(m.errors) ? m.errors.join("; ") : "") ||
          m.subtype ||
          "",
      );
      this.busy = false;
      this.stopping = false;
      if (
        !ok &&
        !interrupted &&
        /log ?in|authenticat|api key|unauthori/i.test(detail)
      )
        this.emitState({ type: "connected", account: "signed-out" });
      this.emitState({
        type: "completed",
        status: interrupted ? "interrupted" : ok ? "completed" : "failed",
        error: interrupted || ok ? undefined : friendly(detail),
      });
    }
  }

  async send(text: string, projectId?: string) {
    if (this.busy) throw Error("Wait for the current edit or stop it first");
    if (projectId !== this.projectId) {
      // A different project gets a fresh conversation.
      this.close();
      this.session = undefined;
      this.resumable = false;
      this.projectId = projectId;
    }
    this.busy = true;
    this.stopping = false;
    this.textInTurn = false;
    this.pendingBreak = false;
    this.emitState({ type: "started" });
    try {
      const child =
        this.child && !this.child.killed ? this.child : this.spawnSession();
      if (!child.stdin.writable)
        throw Error("Claude is disconnected. Send again to reconnect.");
      child.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
          parent_tool_use_id: null,
        }) + "\n",
      );
      this.touch();
      return { sessionId: this.session };
    } catch (error) {
      clearTimeout(this.watchdog);
      this.busy = false;
      throw error;
    }
  }

  async stop() {
    if (!this.busy || !this.child) return;
    this.stopping = true;
    this.child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: `stop-${randomUUID()}`,
        request: { subtype: "interrupt" },
      }) + "\n",
    );
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      if (!this.busy) return;
      // The CLI did not wind down in time: end the process; the chat resumes next time.
      this.close();
      this.busy = false;
      this.stopping = false;
      this.emitState({ type: "completed", status: "interrupted" });
    }, this.options.interruptMs ?? 8000);
  }

  private close() {
    const child = this.child;
    this.child = undefined;
    clearTimeout(this.watchdog);
    clearTimeout(this.interruptTimer);
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }

  private fail(error: Error) {
    this.close();
    this.busy = false;
    this.stopping = false;
    this.emitState({ type: "error", message: error.message });
  }

  dispose() {
    this.close();
    this.busy = false;
    this.state = { status: "disconnected", message: "Not connected" };
  }
}
