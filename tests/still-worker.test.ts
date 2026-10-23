import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  process: {
    pid: 43210,
    connected: true,
    once: vi.fn(),
    send: vi.fn(),
    exit: vi.fn(),
    kill: vi.fn(),
  },
  openBrowser: vi.fn(),
  selectComposition: vi.fn(),
  renderStill: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:process", () => ({ default: mocks.process }));
vi.mock("@remotion/renderer", () => ({
  openBrowser: mocks.openBrowser,
  selectComposition: mocks.selectComposition,
  renderStill: mocks.renderStill,
}));
const input = {
  frames: [0, 10, 20, 30],
  outputDirectory: "/tmp/preview",
  scale: 1,
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.process.connected = true;
  mocks.process.once.mockImplementation((event, callback) => {
    mocks.handlers[event] = callback;
  });
  mocks.process.send.mockImplementation((_message, callback) => callback());
  mocks.openBrowser.mockResolvedValue({ close: mocks.close });
  mocks.close.mockResolvedValue(undefined);
  mocks.selectComposition.mockResolvedValue({ durationInFrames: 60 });
  mocks.renderStill.mockResolvedValue(undefined);
  await import("../src/main/still-worker");
});
afterEach(() => {
  vi.useRealTimers();
});

it("closes Chrome and stops scheduling frames when the editor disconnects mid-preview", async () => {
  let finish!: () => void;
  const render = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.renderStill.mockReturnValue(render);
  const job = mocks.handlers.message(input);
  await vi.waitFor(() => expect(mocks.renderStill).toHaveBeenCalledTimes(2));
  mocks.process.connected = false;
  mocks.handlers.disconnect();
  finish();
  await job;
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.renderStill).toHaveBeenCalledTimes(2);
  expect(mocks.process.send).not.toHaveBeenCalled();
  expect(mocks.process.exit).toHaveBeenCalledWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("also closes a browser whose startup finishes after the editor disconnected", async () => {
  let opened!: (browser: { close: typeof mocks.close }) => void;
  mocks.openBrowser.mockReturnValue(
    new Promise((resolve) => {
      opened = resolve;
    }),
  );
  const job = mocks.handlers.message(input);
  mocks.process.connected = false;
  mocks.handlers.disconnect();
  opened({ close: mocks.close });
  await job;
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.selectComposition).not.toHaveBeenCalled();
  expect(mocks.process.send).not.toHaveBeenCalled();
  expect(mocks.process.exit).toHaveBeenCalledWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("kills the detached worker group if browser startup or close never returns", async () => {
  mocks.openBrowser.mockReturnValue(new Promise(() => {}));
  void mocks.handlers.message(input);
  mocks.handlers.disconnect();
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.process.kill).toHaveBeenCalledWith(-43210, "SIGKILL");
  expect(mocks.process.send).not.toHaveBeenCalled();
});

it("returns completed frames and closes the browser on the normal path", async () => {
  await mocks.handlers.message(input);
  expect(mocks.openBrowser).toHaveBeenCalledWith(
    "chrome",
    expect.objectContaining({ chromeMode: "chrome-for-testing" }),
  );
  expect(mocks.selectComposition).toHaveBeenCalledWith(
    expect.objectContaining({ chromeMode: "chrome-for-testing" }),
  );
  for (const [options] of mocks.renderStill.mock.calls)
    expect(options.chromeMode).toBe("chrome-for-testing");
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.process.send).toHaveBeenCalledWith(
    {
      type: "done",
      files: [
        "/tmp/preview/frame-0.jpg",
        "/tmp/preview/frame-1.jpg",
        "/tmp/preview/frame-2.jpg",
        "/tmp/preview/frame-3.jpg",
      ],
    },
    expect.any(Function),
  );
  expect(mocks.process.exit).toHaveBeenCalledWith(0);
  expect(mocks.process.kill).not.toHaveBeenCalled();
});
