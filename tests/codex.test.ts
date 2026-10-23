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
it("project switches start a new conversation and reject tools after stop", async () => {
  const call = vi.fn(async () => ({ ok: true })),
    c = make(call);
  await c.send("first", "p1");
  const child = control.children[0];
  child.notify({
    method: "turn/completed",
    params: { turn: { id: (c as any).turn, status: "completed" } },
  });
  await tick();
  await c.send("second", "p2");
  expect(
    child.sent.filter((m: any) => m.method === "thread/start"),
  ).toHaveLength(2);
  await c.stop();
  child.notify({
    id: 99,
    method: "item/tool/call",
    params: { tool: "edit", arguments: {} },
  });
  await tick();
  expect(call).not.toHaveBeenCalled();
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
  await c.send("Review preview", "p1");
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
  await c.send("Import my 30 minute 4K interview", "p1");
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
