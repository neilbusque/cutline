import { it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const control = vi.hoisted(() => ({
  children: [] as any[],
  hook: undefined as undefined | ((c: any, m: any) => boolean),
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  return {
    spawn: vi.fn(() => {
      const c: any = new EventEmitter();
      c.killed = false;
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.sent = [];
      c.notify = (m: any) => c.stdout.write(JSON.stringify(m) + "\n");
      c.stdin = new Writable({
        write(chunk, _encoding, done) {
          const m = JSON.parse(chunk.toString());
          c.sent.push(m);
          queueMicrotask(() => {
            if (control.hook?.(c, m)) return;
            if (m.id === undefined) return;
            const result =
              m.method === "account/read"
                ? { account: { type: "chatgpt" } }
                : m.method === "thread/start"
                  ? { thread: { id: "thread-" + c.sent.length } }
                  : m.method === "turn/start"
                    ? { turn: { id: "turn-" + m.id } }
                    : {};
            c.notify({ id: m.id, result });
          });
          done();
        },
      });
      c.kill = () => {
        c.killed = true;
        queueMicrotask(() => c.emit("exit", 0));
      };
      control.children.push(c);
      return c;
    }),
  };
});
import { Codex } from "../src/main/codex";
const instances: Codex[] = [],
  dirs: string[] = [];
function make(call = vi.fn(async () => ({ ok: true }))) {
  const dir = mkdtempSync(path.join(tmpdir(), "cutline-codex-"));
  dirs.push(dir);
  const c = new Codex(dir, [{ name: "edit" }], call);
  instances.push(c);
  return c;
}
const tick = () => new Promise((r) => setImmediate(r));
afterEach(() => {
  for (const c of instances) c.dispose();
  instances.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  control.hook = undefined;
  control.children = [];
  vi.useRealTimers();
});
it("shares startup and initializes once per connection", async () => {
  const c = make();
  await Promise.all([c.connect(), c.connect()]);
  expect(control.children).toHaveLength(1);
  expect(
    control.children[0].sent.filter((m: any) => m.method === "initialize"),
  ).toHaveLength(1);
});
it("failed handshake kills its process and reconnect creates a clean session", async () => {
  control.hook = (c, m) => {
    if (m.method === "initialize") {
      c.notify({ id: m.id, error: { message: "bad handshake" } });
      return true;
    }
    return false;
  };
  const c = make();
  await expect(c.connect()).rejects.toThrow("bad handshake");
  expect(control.children[0].killed).toBe(true);
  control.hook = undefined;
  await c.reconnect();
  expect(c.status().status).toBe("connected");
  expect(control.children).toHaveLength(2);
});
it("late exit from old process cannot disconnect replacement", async () => {
  const c = make();
  await c.connect();
  const old = control.children[0];
  await c.reconnect();
  old.emit("exit", 1);
  expect(c.status().status).toBe("connected");
});
it("stop during startup prevents turn creation", async () => {
  let held: any;
  control.hook = (c, m) => {
    if (m.method === "account/read") {
      held = { c, m };
      return true;
    }
    return false;
  };
  const c = make();
  const sending = c.send("edit").catch((e) => e);
  await tick();
  await c.stop();
  held.c.notify({ id: held.m.id, result: { account: { type: "chatgpt" } } });
  expect((await sending).message).toContain("stopped");
  expect(held.c.sent.some((m: any) => m.method === "turn/start")).toBe(false);
  expect(c.busy).toBe(false);
});
it("duplicate dynamic tool request runs the edit exactly once", async () => {
  const call = vi.fn(async () => ({ ok: true })),
    c = make(call);
  await c.send("edit");
  const child = control.children[0];
  const m = {
    id: 90,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  };
  child.notify(m);
  child.notify(m);
  await tick();
  expect(call).toHaveBeenCalledTimes(1);
});
it("transient error keeps turn busy until terminal completion", async () => {
  const c = make();
  await c.send("edit");
  const child = control.children[0];
  child.notify({ method: "error", params: { error: { message: "retrying" } } });
  await tick();
  expect(c.busy).toBe(true);
  child.notify({
    method: "turn/completed",
    params: { turn: { id: (c as any).turn, status: "failed" } },
  });
  await tick();
  expect(c.busy).toBe(false);
});
it("request timeout rejects outstanding requests and kills broken connection", async () => {
  vi.useFakeTimers();
  control.hook = () => true;
  const c = make();
  const pending = c.connect().catch((e) => e);
  await vi.advanceTimersByTimeAsync(60001);
  expect((await pending).message).toContain("timed out");
  expect(control.children[0].killed).toBe(true);
  expect(c.busy).toBe(false);
});
it("keeps one conversation across projects and rejects tools after stop", async () => {
  const call = vi.fn(async () => ({ ok: true })),
    c = make(call);
  await c.send("first");
  const child = control.children[0];
  child.notify({
    method: "turn/completed",
    params: { turn: { id: (c as any).turn, status: "completed" } },
  });
  await tick();
  await c.send("now the same for this one");
  const starts = child.sent.filter((m: any) => m.method === "thread/start");
  expect(starts).toHaveLength(1);
  // Saved, so a reconnect can pick it up.
  expect(starts[0].params.ephemeral).toBe(false);
  const turns = child.sent.filter((m: any) => m.method === "turn/start");
  expect(turns[1].params.threadId).toBe(turns[0].params.threadId);
  await c.stop();
  child.notify({
    id: 99,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await tick();
  expect(call).not.toHaveBeenCalled();
});
it("resumes the conversation after a reconnect instead of starting over", async () => {
  const c = make();
  await c.send("Add a title");
  const first = control.children[0];
  const thread = first.sent.find((m: any) => m.method === "turn/start").params
    .threadId;
  first.notify({
    method: "turn/completed",
    params: { turn: { id: (c as any).turn, status: "completed" } },
  });
  await tick();
  await c.reconnect();
  await c.send("Make it bigger");
  const second = control.children[1];
  const resume = second.sent.find((m: any) => m.method === "thread/resume");
  expect(resume.params.threadId).toBe(thread);
  expect(second.sent.some((m: any) => m.method === "thread/start")).toBe(false);
  const turn = second.sent.find((m: any) => m.method === "turn/start");
  expect(turn.params.threadId).toBe(thread);
});
it("says so in the chat when the earlier conversation can't be resumed", async () => {
  const c = make();
  const seen: any[] = [];
  c.on("event", (e) => seen.push(e));
  await c.send("Add a title");
  control.children[0].notify({
    method: "turn/completed",
    params: { turn: { id: (c as any).turn, status: "completed" } },
  });
  await tick();
  await c.reconnect();
  control.hook = (child, m) => {
    if (m.method !== "thread/resume") return false;
    child.notify({ id: m.id, error: { message: "no rollout found" } });
    return true;
  };
  await c.send("Make it bigger");
  const second = control.children[1];
  expect(second.sent.some((m: any) => m.method === "thread/start")).toBe(true);
  expect(seen.some((e) => e.type === "notice")).toBe(true);
});
it("shows commentary as progress and only the final answer as the reply", async () => {
  const c = make();
  const seen: any[] = [];
  c.on("event", (e) => seen.push(e));
  await c.send("Center the title");
  const child = control.children[0];
  const turn = (c as any).turn;
  child.notify({
    method: "item/agentMessage/delta",
    params: { itemId: "m1", delta: "Checking the " },
  });
  child.notify({
    method: "item/completed",
    params: {
      item: { type: "agentMessage", id: "m1", text: "Checking the title", phase: "commentary" },
    },
  });
  // Unmarked text before a tool call is progress too.
  child.notify({
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "m2", text: "Moving it", phase: null } },
  });
  child.notify({
    id: 80,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await tick();
  child.notify({
    method: "item/completed",
    params: {
      item: { type: "agentMessage", id: "m3", text: "The title is centered.", phase: "final_answer" },
    },
  });
  child.notify({
    method: "turn/completed",
    params: { turn: { id: turn, status: "completed" } },
  });
  await tick();
  const notes = seen.filter((e) => e.type === "note").map((e) => e.text);
  expect(notes).toEqual(["Checking the title", "Moving it"]);
  const reply = seen
    .filter((e) => e.type === "delta")
    .map((e) => e.text)
    .join("");
  expect(reply).toBe("The title is centered.");
});
it("names the tool while it runs, not after it finishes", async () => {
  const call = vi.fn(() => new Promise(() => {})) as any;
  const c = make(call);
  const seen: any[] = [];
  c.on("event", (e) => seen.push(e));
  await c.send("Transcribe the interview");
  control.children[0].notify({
    id: 82,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await tick();
  expect(call).toHaveBeenCalledTimes(1);
  expect(seen).toContainEqual({ type: "tool", name: "edit" });
});
it("ends an unmarked message as the reply when no tool follows", async () => {
  const c = make();
  const seen: any[] = [];
  c.on("event", (e) => seen.push(e));
  await c.send("What is on the timeline?");
  const child = control.children[0];
  child.notify({
    method: "item/agentMessage/delta",
    params: { itemId: "m1", delta: "Two clips " },
  });
  child.notify({
    method: "item/agentMessage/delta",
    params: { itemId: "m1", delta: "and a title." },
  });
  child.notify({
    method: "turn/completed",
    params: { turn: { id: (c as any).turn, status: "completed" } },
  });
  await tick();
  expect(
    seen
      .filter((e) => e.type === "delta")
      .map((e) => e.text)
      .join(""),
  ).toBe("Two clips and a title.");
  expect(seen.at(-1)).toMatchObject({ type: "completed" });
});
it("guards oversized tool results the way the MCP server does", async () => {
  const call = vi.fn(async () => ({ huge: "x".repeat(200_000) }));
  const c = make(call as any);
  await c.send("Inspect everything");
  const child = control.children[0];
  child.notify({
    id: 81,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await tick();
  await tick();
  const response = child.sent.find((m: any) => m.id === 81);
  const text = response.result.contentItems[0].text;
  expect(text.length).toBeLessThan(1000);
  expect(text).toContain("too large");
});
it("delivers requested preview images as image content to the assistant", async () => {
  const call = vi.fn(async () => ({
    content: [
      { type: "text", text: '{"frame":12}' },
      { type: "image", data: "jpeg-data", mimeType: "image/jpeg" },
    ],
    structuredContent: { frame: 12 },
  }));
  const c = make(call as any);
  await c.send("Review preview");
  const child = control.children[0];
  child.notify({
    id: 91,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await tick();
  const response = child.sent.find((message: any) => message.id === 91);
  expect(response.result).toEqual({
    success: true,
    contentItems: [
      { type: "inputText", text: '{"frame":12}' },
      { type: "inputImage", imageUrl: "data:image/jpeg;base64,jpeg-data" },
    ],
  });
});
it("keeps waiting while a long Cutline tool runs, then times out only on Codex itself", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const call = vi.fn(() => new Promise((resolve) => (finish = resolve))) as any;
  const c = make(call);
  await c.send("Import my 30 minute 4K interview");
  const child = control.children[0];
  child.notify({
    id: 70,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(call).toHaveBeenCalledTimes(1);
  // An import with a proxy, or a long transcription, can take minutes.
  await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
  expect(child.killed).toBe(false);
  expect(c.status().status).toBe("connected");
  finish({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  const response = child.sent.find((m: any) => m.id === 70);
  expect(response.result.success).toBe(true);
  // Once the tool has answered, silence from Codex is a real stall again.
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
  expect(child.killed).toBe(true);
  expect(c.status().message).toContain("stopped responding");
});
it("stop also stops the Cutline work the turn started", async () => {
  let signal: AbortSignal | undefined;
  const call = vi.fn((_name: string, _args: unknown, stop?: AbortSignal) => {
    signal = stop;
    return new Promise(() => {});
  }) as any;
  const c = make(call);
  await c.send("Remove the long pauses");
  const child = control.children[0];
  child.notify({
    id: 72,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await tick();
  expect(call).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  await c.stop();
  expect(signal?.aborted).toBe(true);
  // The next turn's work gets a fresh signal.
  child.notify({
    method: "turn/completed",
    params: { turn: { id: (c as any).turn, status: "interrupted" } },
  });
  await tick();
  await c.send("Try again");
  child.notify({
    id: 73,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await tick();
  expect(signal?.aborted).toBe(false);
});
