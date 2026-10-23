import { it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// A fake Claude Code CLI speaking the stream-json protocol over stdin/stdout.
const control = vi.hoisted(() => ({
  children: [] as any[],
  onUser: undefined as undefined | ((c: any, m: any) => void),
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  return {
    execFile: vi.fn(),
    spawn: vi.fn((bin: string, args: string[]) => {
      const c: any = new EventEmitter();
      c.bin = bin;
      c.args = args;
      c.killed = false;
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.sent = [];
      c.emitLine = (m: any) => c.stdout.write(JSON.stringify(m) + "\n");
      c.stdin = new Writable({
        write(chunk, _encoding, done) {
          for (const line of chunk.toString().split("\n").filter(Boolean)) {
            const m = JSON.parse(line);
            c.sent.push(m);
            queueMicrotask(() => {
              if (m.type === "user") control.onUser?.(c, m);
              if (m.type === "control_request")
                c.emitLine({
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                });
            });
          }
          done();
        },
      });
      c.kill = () => {
        c.killed = true;
        queueMicrotask(() => c.emit("exit", null, "SIGTERM"));
      };
      control.children.push(c);
      return c;
    }),
  };
});
import { ClaudeAssistant } from "../src/main/claude";

const instances: ClaudeAssistant[] = [],
  dirs: string[] = [];
function make(
  options: Partial<ConstructorParameters<typeof ClaudeAssistant>[2]> = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "cutline-claude-"));
  dirs.push(dir);
  const c = new ClaudeAssistant(dir, () => "http://127.0.0.1:1234/token/mcp", {
    bin: () => "/fake/claude",
    authStatus: async () => ({ loggedIn: true, email: "me@example.com" }),
    ...options,
  });
  instances.push(c);
  return c;
}
function events(c: ClaudeAssistant) {
  const seen: any[] = [];
  c.on("event", (e) => seen.push(e));
  return seen;
}
const tick = () => new Promise((r) => setImmediate(r));
// Default reply: init, two text deltas around a tool call, then success.
function replyWithTool(c: any) {
  c.emitLine({
    type: "system",
    subtype: "init",
    session_id: "s",
    mcp_servers: [{ name: "cutline", status: "connected" }],
  });
  c.emitLine({ type: "stream_event", event: { type: "message_start" } });
  c.emitLine({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Looking." },
    },
  });
  c.emitLine({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "mcp__cutline__cutline_edit" }],
    },
  });
  c.emitLine({ type: "stream_event", event: { type: "message_start" } });
  c.emitLine({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Done." },
    },
  });
  c.emitLine({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
  });
}
afterEach(() => {
  for (const c of instances) c.dispose();
  instances.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  control.children = [];
  control.onUser = undefined;
});

it("connect reports sign-in state without starting a session", async () => {
  const c = make();
  expect(await c.connect()).toEqual({
    account: { type: "claude", email: "me@example.com" },
  });
  expect(c.status().message).toBe("Connected to Claude");
  expect(control.children).toHaveLength(0);
  const out = make({ authStatus: async () => ({ loggedIn: false }) });
  expect((await out.connect()).account).toBeNull();
  expect(out.status().message).toBe("Sign in to Claude");
});

it("runs the CLI isolated: only Cutline tools, no user settings, no built-ins", async () => {
  const c = make();
  control.onUser = replyWithTool;
  await c.send("Make a title", "p1");
  const args: string[] = control.children[0].args;
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  expect(at("--setting-sources")).toBe("");
  expect(at("--tools")).toBe("");
  expect(args).toContain("--strict-mcp-config");
  expect(at("--allowedTools")).toBe("mcp__cutline");
  expect(at("--permission-mode")).toBe("dontAsk");
  expect(at("--model")).toBe("opus");
  expect(JSON.parse(at("--mcp-config"))).toEqual({
    mcpServers: {
      cutline: { type: "http", url: "http://127.0.0.1:1234/token/mcp" },
    },
  });
  expect(args).toContain("--session-id");
  // The persona is appended; the workflow arrives as the MCP server's
  // instructions, so it must not be repeated here.
  expect(at("--append-system-prompt")).toMatch(/editor inside Cutline/);
  expect(at("--append-system-prompt")).not.toMatch(/cutline_inspect/);
});

it("streams text with step breaks, reports tools and completes", async () => {
  const c = make();
  const seen = events(c);
  control.onUser = replyWithTool;
  await c.send("Make a title", "p1");
  await tick();
  await tick();
  const text = seen
    .filter((e) => e.type === "delta")
    .map((e) => e.text)
    .join("");
  expect(text).toBe("Looking.\n\nDone.");
  expect(seen.find((e) => e.type === "tool")).toMatchObject({
    name: "cutline_edit",
  });
  expect(seen.at(-1)).toMatchObject({ type: "completed", status: "completed" });
  expect(seen.every((e) => e.provider === "claude")).toBe(true);
  expect(c.busy).toBe(false);
  const user = control.children[0].sent.find((m: any) => m.type === "user");
  expect(user.message.content[0].text).toBe("Make a title");
});

it("keeps one process per conversation and starts fresh for another project", async () => {
  const c = make();
  control.onUser = replyWithTool;
  await c.send("one", "p1");
  await tick();
  await c.send("two", "p1");
  await tick();
  expect(control.children).toHaveLength(1);
  await c.send("three", "p2");
  await tick();
  expect(control.children).toHaveLength(2);
  expect(control.children[0].killed).toBe(true);
  const first = control.children[0].args;
  const second = control.children[1].args;
  expect(second[second.indexOf("--session-id") + 1]).not.toBe(
    first[first.indexOf("--session-id") + 1],
  );
});

it("stop interrupts the turn and reports it as interrupted", async () => {
  const c = make();
  const seen = events(c);
  control.onUser = () => {}; // never answers on its own
  await c.send("long job", "p1");
  expect(c.busy).toBe(true);
  await c.stop();
  await tick();
  await tick();
  expect(
    control.children[0].sent.some((m: any) => m.type === "control_request"),
  ).toBe(true);
  expect(seen.at(-1)).toMatchObject({
    type: "completed",
    status: "interrupted",
  });
  expect(c.busy).toBe(false);
});

it("stop falls back to ending the process and resumes the chat next time", async () => {
  vi.useFakeTimers();
  try {
    const c = make({ interruptMs: 50 });
    const seen = events(c);
    control.onUser = (child) =>
      child.emitLine({ type: "system", subtype: "init", mcp_servers: [] });
    await c.send("long job", "p1");
    await vi.advanceTimersByTimeAsync(1);
    // Ignore the interrupt: swallow the control request.
    control.children[0].stdin.write = () => true;
    await c.stop();
    await vi.advanceTimersByTimeAsync(60);
    expect(seen.at(-1)).toMatchObject({
      type: "completed",
      status: "interrupted",
    });
    expect(control.children[0].killed).toBe(true);
    control.onUser = replyWithTool;
    await c.send("again", "p1");
    const args = control.children[1].args;
    expect(args).toContain("--resume");
  } finally {
    vi.useRealTimers();
  }
});

it("a crash mid-turn ends the turn with a readable error", async () => {
  const c = make();
  const seen = events(c);
  control.onUser = (child) => {
    child.stderr.write("Error: something broke\n");
    setImmediate(() => child.emit("exit", 1, null));
  };
  await c.send("go", "p1");
  await tick();
  await tick();
  await tick();
  expect(seen.at(-1)).toMatchObject({ type: "error" });
  expect(seen.at(-1).message).toMatch(/something broke/);
  expect(c.busy).toBe(false);
});

it("auth failures in a result ask the user to sign in", async () => {
  const c = make();
  const seen = events(c);
  control.onUser = (child) =>
    child.emitLine({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Invalid API key · Please run /login",
    });
  await c.send("go", "p1");
  await tick();
  await tick();
  expect(c.status().message).toBe("Sign in to Claude");
  expect(seen.at(-1)).toMatchObject({ type: "completed", status: "failed" });
  expect(seen.at(-1).error).toMatch(/sign in/i);
});

it("missing CLI explains how to install Claude Code", async () => {
  const c = make({ bin: () => undefined });
  await expect(c.connect()).rejects.toThrow(/Claude Code isn't installed/);
  await expect(c.send("go", "p1")).rejects.toThrow(/isn't installed/);
  expect(c.busy).toBe(false);
});

it("switching model restarts on the new model and resumes the chat", async () => {
  const c = make();
  control.onUser = replyWithTool;
  await c.send("one", "p1");
  await tick();
  c.setModel("sonnet");
  await c.send("two", "p1");
  await tick();
  const args = control.children[1].args;
  expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  expect(args).toContain("--resume");
  expect(() => c.setModel("gpt" as any)).toThrow(/Unknown model/);
});

it("refuses a second message while busy and warns when Cutline tools fail to load", async () => {
  const c = make();
  const seen = events(c);
  control.onUser = (child) =>
    child.emitLine({
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "cutline", status: "failed" }],
    });
  await c.send("go", "p1");
  await expect(c.send("again", "p1")).rejects.toThrow(
    /Wait for the current edit/,
  );
  await tick();
  expect(seen.find((e) => e.type === "warning")?.message).toMatch(
    /didn't load/,
  );
});
