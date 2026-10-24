import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { keepEditorAlive } from "../src/main/editor-window";

function editor() {
  const webContents = Object.assign(new EventEmitter(), {
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
  });
  const win = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents,
  });
  return win;
}
function watched(askReload = vi.fn(async () => true)) {
  const win = editor();
  const pending = new Map<string, { reject: (error: Error) => void }>();
  const timers: Array<() => void> = [];
  let clock = 0;
  const editorWindow = keepEditorAlive(win, {
    pending,
    askReload,
    later: (run) => timers.push(run),
    now: () => clock,
  });
  return {
    win,
    pending,
    timers,
    askReload,
    editorWindow,
    tick: (ms: number) => (clock += ms),
  };
}

it("reloads a crashed editor and answers the preview requests waiting on it", () => {
  const { win, pending, timers } = watched();
  const reject = vi.fn();
  pending.set("preview-1", { reject });
  win.webContents.emit("render-process-gone", {}, { reason: "oom" });
  expect(reject).toHaveBeenCalledWith(Error("The editor restarted. Retry."));
  expect(pending.size).toBe(0);
  expect(timers).toHaveLength(1);
  timers[0]();
  expect(win.webContents.reload).toHaveBeenCalledTimes(1);
});

it("leaves a page that closed normally alone, and stops reloading one that keeps crashing", () => {
  const { win, timers, tick } = watched();
  win.webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
  expect(timers).toHaveLength(0);
  for (let crash = 0; crash < 5; crash++) {
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    tick(1000);
  }
  expect(timers).toHaveLength(3);
  // Much later, a new crash reloads again.
  tick(5 * 60_000);
  win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  expect(timers).toHaveLength(4);
});

it("asks once about a hung editor and restarts it on Reload, never after it recovered", async () => {
  let answer!: (reload: boolean) => void;
  const askReload = vi.fn(
    () => new Promise<boolean>((resolve) => (answer = resolve)),
  );
  const { win } = watched(askReload);
  win.emit("unresponsive");
  win.emit("unresponsive");
  expect(askReload).toHaveBeenCalledTimes(1);
  answer(true);
  await new Promise((resolve) => setImmediate(resolve));
  expect(win.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  // It catches up while the question is open: nothing is restarted.
  win.emit("unresponsive");
  win.emit("responsive");
  answer(true);
  await new Promise((resolve) => setImmediate(resolve));
  expect(win.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
});

it("View > Reload editor answers waiting previews first", () => {
  const { win, pending, editorWindow } = watched();
  const reject = vi.fn();
  pending.set("preview-2", { reject });
  editorWindow.reload();
  expect(reject).toHaveBeenCalled();
  expect(win.webContents.reload).toHaveBeenCalledTimes(1);
});
