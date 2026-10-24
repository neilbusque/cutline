import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const electron = vi.hoisted(() => {
  const windows: any[] = [];
  /** What the next window's page does; each test sets it. */
  const page = {
    load: () => Promise.resolve() as Promise<void>,
    script: (_code: string) => Promise.resolve(null as unknown),
  };
  class BrowserWindow {
    destroyed = false;
    events: Record<string, () => void> = {};
    webContents = {
      setWindowOpenHandler: () => {},
      setAudioMuted: () => {},
      setUserAgent: () => {},
      once: (event: string, listener: () => void) => {
        this.events[event] = listener;
      },
      stop: vi.fn(),
      executeJavaScript: vi.fn((code: string) => page.script(code)),
      capturePage: vi.fn(async () => ({
        toPNG: () => Buffer.alloc(4000, 1),
        isEmpty: () => false,
        getSize: () => ({ width: 2880, height: 1800 }),
      })),
    };
    constructor() {
      windows.push(this);
    }
    loadURL = vi.fn(() => page.load());
    destroy() {
      this.destroyed = true;
    }
  }
  const session = {
    fromPartition: () => ({
      setPermissionRequestHandler: () => {},
      on: () => {},
      clearStorageData: async () => {},
    }),
  };
  return { windows, page, BrowserWindow, session };
});
vi.mock("electron", () => ({
  BrowserWindow: electron.BrowserWindow,
  session: electron.session,
}));

import { captureLimits, capturePage } from "../src/main/page-capture";

let directory = "";
beforeEach(() => {
  vi.useFakeTimers();
  electron.windows.length = 0;
  electron.page.load = () => Promise.resolve();
  electron.page.script = async (code) =>
    code === "document.title" ? "Example" : null;
  directory = mkdtempSync(path.join(os.tmpdir(), "cutline-capture-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
const never = () => new Promise<never>(() => {});

it("captures a page and closes its window", async () => {
  const file = path.join(directory, "page.png");
  const shot = capturePage("https://example.com", file, { device: "desktop" });
  await vi.advanceTimersByTimeAsync(3000);
  await expect(shot).resolves.toMatchObject({ title: "Example", width: 2880 });
  expect(existsSync(file)).toBe(true);
  expect(electron.windows[0].destroyed).toBe(true);
});

it("gives up on a page that never finishes rendering, closing its window", async () => {
  // The page blocks its main thread, so no script ever answers.
  electron.page.script = never;
  const shot = capturePage(
    "https://example.com",
    path.join(directory, "a.png"),
    {
      device: "desktop",
    },
  );
  const failed = expect(shot).rejects.toThrow(
    "example.com didn't finish rendering",
  );
  await vi.advanceTimersByTimeAsync(captureLimits.totalMs);
  await failed;
  expect(electron.windows[0].destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("captures a page that never finishes loading once its content is there", async () => {
  electron.page.load = never;
  const shot = capturePage(
    "https://example.com",
    path.join(directory, "b.png"),
    {
      device: "phone",
    },
  );
  electron.windows[0].events["dom-ready"]();
  await vi.advanceTimersByTimeAsync(captureLimits.loadMs + 3000);
  await expect(shot).resolves.toMatchObject({ title: "Example" });
  expect(electron.windows[0].webContents.stop).toHaveBeenCalled();
});

it("fails a page that shows nothing before the load timeout", async () => {
  electron.page.load = never;
  const shot = capturePage(
    "https://example.com",
    path.join(directory, "c.png"),
    {
      device: "desktop",
    },
  );
  const failed = expect(shot).rejects.toThrow("took too long to load");
  await vi.advanceTimersByTimeAsync(captureLimits.loadMs);
  await failed;
  expect(electron.windows[0].destroyed).toBe(true);
});

it("stops when cancelled, closing the window", async () => {
  electron.page.script = never;
  const stop = new AbortController();
  const shot = capturePage(
    "https://example.com",
    path.join(directory, "d.png"),
    {
      device: "desktop",
      signal: stop.signal,
    },
  );
  const failed = expect(shot).rejects.toThrow("Cancelled");
  await vi.advanceTimersByTimeAsync(2000);
  stop.abort();
  await failed;
  expect(electron.windows[0].destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
