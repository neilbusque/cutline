import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { assistantInstructions } from "../shared/assistant-instructions";
export class Codex extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<
    number,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private thread?: string;
  private projectId?: string;
  private turn?: string;
  private connecting?: Promise<any>;
  private stopping = false;
  private watchdog?: NodeJS.Timeout;
  private toolResults = new Map<string, Promise<any>>();
  /** Cutline tools still working for Codex; Codex is waiting on us, not stalled. */
  private toolsRunning = new Set<string>();
  private state = {
    status: "disconnected",
    busy: false,
    message: "Not connected",
  };
  busy = false;
  status() {
    return { ...this.state, busy: this.busy };
  }
  async reconnect() {
    if (this.busy) throw Error("Stop the current edit before reconnecting");
    this.dispose();
    await this.connecting?.catch(() => {});
    return this.connect();
  }
  private touch() {
    clearTimeout(this.watchdog);
    // Imports, transcription and exports can take minutes; only silence
    // from Codex itself means it stopped responding.
    if (this.busy && !this.toolsRunning.size)
      this.watchdog = setTimeout(
        () =>
          this.fail(
            Error(
              "Codex stopped responding. Reconnect and inspect your project before retrying; completed edits are preserved.",
            ),
          ),
        300000,
      );
  }
  constructor(
    readonly cwd: string,
    readonly tools: any[],
    readonly call: (name: string, args: any) => Promise<unknown>,
  ) {
    super();
    mkdirSync(cwd, { recursive: true });
  }
  private emitState(value: any) {
    if (value.type === "connected")
      this.state = {
        status: "connected",
        busy: this.busy,
        message:
          value.account === "signed-out"
            ? "Sign in to Codex"
            : "Connected to Codex",
      };
    if (value.type === "connecting")
      this.state = {
        status: "connecting",
        busy: this.busy,
        message: "Connecting to Codex…",
      };
    if (value.type === "error")
      this.state = { status: "error", busy: this.busy, message: value.message };
    this.emit("event", value);
  }
  private request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || child.killed || !child.stdin.writable) {
        reject(Error("Codex is disconnected. Reconnect to continue."));
        return;
      }
      const id = this.next++;
      const timer = setTimeout(() => {
        this.fail(
          Error(
            `Codex timed out: ${method}. Reconnect before retrying; completed edits are preserved.`,
          ),
        );
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (error) => {
          if (error && this.child === child) this.fail(error);
        },
      );
    });
  }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.child) return this.request("account/read", {});
    this.emitState({ type: "connecting" });
    this.connecting = this.start().catch((error) => {
      if (this.child) this.fail(error);
      throw error;
    });
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private async start() {
    const bin =
      process.env.CUTLINE_CODEX_PATH ||
      [
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
      ].find(existsSync) ||
      "codex";
    this.child = spawn(
      bin,
      [
        "app-server",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        "mcp_servers={}",
        "-c",
        'web_search="disabled"',
      ],
      { cwd: this.cwd, stdio: "pipe" },
    );
    const child = this.child;
    const failed = (e: Error) => {
      if (this.child === child) this.fail(e);
    };
    child.stdin.on("error", failed);
    child.on("error", failed);
    this.child.on("exit", () =>
      failed(
        Error(
          "Codex disconnected. Reconnect to continue; completed edits are preserved.",
        ),
      ),
    );
    this.child.stderr.on("data", () => {});
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        if (this.child === child)
          void this.message(JSON.parse(line), child).catch(failed);
      } catch {}
    });
    await this.request("initialize", {
      clientInfo: { name: "cutline", title: "Cutline", version: "0.3.1" },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
    const account = await this.request("account/read", {});
    this.emitState({
      type: "connected",
      account: account.account?.type ?? "signed-out",
    });
    return account;
  }
  private fail(error: Error, notify = true) {
    const child = this.child;
    this.child = undefined;
    clearTimeout(this.watchdog);
    child?.kill();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.child = undefined;
    this.thread = undefined;
    this.turn = undefined;
    this.busy = false;
    this.toolResults.clear();
    this.toolsRunning.clear();
    if (notify) this.emitState({ type: "error", message: error.message });
  }
  private async message(m: any, child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.touch();
    if (m.params?.threadId && this.thread && m.params.threadId !== this.thread)
      return;
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
      }
      return;
    }
    if (m.id !== undefined && m.method === "item/tool/call") {
      try {
        if (!this.busy || this.stopping)
          throw Error("This edit was stopped; no further tools may run.");
        if (!this.tools.some((t) => t.name === m.params.tool))
          throw Error("Unknown Cutline tool");
        const key = String(m.id);
        let work = this.toolResults.get(key);
        if (!work) {
          if (this.toolResults.size >= 2000)
            throw Error(
              "Too many tool calls in one edit. Start a new request.",
            );
          work = Promise.resolve().then(() =>
            this.call(m.params.tool, m.params.arguments),
          );
          this.toolResults.set(key, work);
        }
        this.toolsRunning.add(key);
        clearTimeout(this.watchdog);
        let result: any;
        try {
          result = await work;
        } finally {
          if (this.child === child) {
            this.toolsRunning.delete(key);
            this.touch();
          }
        }
        if (this.child !== child) return;
        this.child?.stdin.write(
          JSON.stringify({
            id: m.id,
            result: {
              contentItems:
                result?.content && result?.structuredContent
                  ? result.content.map((item: any) =>
                      item.type === "image"
                        ? {
                            type: "inputImage",
                            imageUrl: `data:${item.mimeType};base64,${item.data}`,
                          }
                        : { type: "inputText", text: item.text ?? "" },
                    )
                  : [{ type: "inputText", text: JSON.stringify(result) }],
              success: true,
            },
          }) + "\n",
        );
        this.emitState({ type: "tool", name: m.params.tool });
      } catch (e) {
        if (this.child !== child) return;
        this.child?.stdin.write(
          JSON.stringify({
            id: m.id,
            result: {
              contentItems: [{ type: "inputText", text: (e as Error).message }],
              success: false,
            },
          }) + "\n",
        );
      }
      return;
    }
    if (m.id !== undefined) {
      this.child?.stdin.write(
        JSON.stringify({
          id: m.id,
          error: {
            code: -32601,
            message: "Only Cutline editing tools are supported",
          },
        }) + "\n",
      );
      return;
    }
    if (m.method === "item/agentMessage/delta")
      this.emitState({ type: "delta", text: m.params.delta });
    if (m.method === "turn/started") this.turn = m.params.turn.id;
    if (m.method === "turn/completed") {
      if (this.turn && m.params.turn.id !== this.turn) return;
      clearTimeout(this.watchdog);
      this.busy = false;
      this.turn = undefined;
      this.emitState({
        type: "completed",
        status: m.params.turn.status,
        error: m.params.turn.error?.message,
      });
    }
    if (m.method === "account/login/completed")
      this.emitState({
        type: "login",
        success: m.params.success,
        message: m.params.error,
      });
    if (m.method === "error")
      this.emitState({
        type: "warning",
        message: m.params.error?.message ?? "Codex request failed",
      });
  }
  async login() {
    await this.connect();
    return this.request("account/login/start", { type: "chatgpt" });
  }
  /** Forget the conversation; the next message starts a new thread. */
  newChat() {
    if (this.busy) throw Error("Stop the current edit before starting a new chat");
    this.thread = undefined;
  }

  async send(text: string, projectId?: string) {
    if (this.busy) throw Error("Wait for the current edit or stop it first");
    if (projectId !== this.projectId) {
      this.thread = undefined;
      this.projectId = projectId;
    }
    this.busy = true;
    this.emitState({ type: "started" });
    this.stopping = false;
    this.toolResults.clear();
    try {
      const account = await this.connect();
      if (!account.account)
        throw Error("Sign in to Codex before sending an edit.");
      if (this.stopping) throw Error("Edit stopped before it started.");
      this.touch();
      if (!this.thread) {
        const result = await this.request("thread/start", {
          cwd: this.cwd,
          sandbox: "read-only",
          environments: [],
          selectedCapabilityRoots: [],
          approvalPolicy: "never",
          ephemeral: true,
          baseInstructions: assistantInstructions,
          dynamicTools: this.tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        this.thread = result.thread.id;
      }
      if (this.stopping) throw Error("Edit stopped before it started.");
      const result = await this.request("turn/start", {
        threadId: this.thread,
        input: [{ type: "text", text, text_elements: [] }],
      });
      if (this.busy) this.turn = result.turn.id;
      if (this.stopping && this.busy) await this.stop();
      return { threadId: this.thread };
    } catch (e) {
      clearTimeout(this.watchdog);
      this.busy = false;
      throw e;
    }
  }
  async stop() {
    this.stopping = true;
    if (this.thread && this.turn)
      await this.request("turn/interrupt", {
        threadId: this.thread,
        turnId: this.turn,
      });
  }
  dispose() {
    this.fail(Error("Codex disconnected"), false);
    this.state = {
      status: "disconnected",
      busy: false,
      message: "Not connected",
    };
  }
}
