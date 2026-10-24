import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  process: {
    pid: 43210,
    connected: true,
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    exit: vi.fn(),
    kill: vi.fn(),
  },
  openBrowser: vi.fn(),
  selectComposition: vi.fn(),
  prepareServer: vi.fn(),
  closeServer: vi.fn(),
  renderStill: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:process", () => ({ default: mocks.process }));
vi.mock("@remotion/renderer", () => ({
  openBrowser: mocks.openBrowser,
  selectComposition: mocks.selectComposition,
  RenderInternals: {
    prepareServer: mocks.prepareServer,
    internalRenderStill: mocks.renderStill,
    findRemotionRoot: () => "/root",
    defaultOnLog: () => {},
  },
}));
vi.mock("remotion/no-react", () => ({
  NoReactInternals: {
    serializeJSONWithSpecialTypes: ({ data }: { data: unknown }) => ({
      serializedString: JSON.stringify(data),
    }),
  },
}));
const request = (id: string, frames = [0, 10, 20, 30]) => ({
  type: "render",
  id,
  serveUrl: "/composition",
  inputProps: { project: { id: "p" }, proxies: true },
  browserExecutable: "/reviewed/Chrome",
  frames,
  outputDirectory: `/tmp/preview-${id}`,
  scale: 1,
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.process.connected = true;
  for (const method of [mocks.process.on, mocks.process.once])
    method.mockImplementation((event, callback) => {
      mocks.handlers[event] = callback;
    });
  mocks.openBrowser.mockResolvedValue({ close: mocks.close });
  mocks.close.mockResolvedValue(undefined);
  mocks.selectComposition.mockResolvedValue({ durationInFrames: 60 });
  mocks.closeServer.mockResolvedValue(undefined);
  mocks.prepareServer.mockImplementation(async () => ({
    closeServer: mocks.closeServer,
  }));
  mocks.renderStill.mockResolvedValue(undefined);
  await import("../src/main/still-worker");
});
afterEach(() => {
  vi.useRealTimers();
});

it("keeps one browser across previews and gives each preview one media server", async () => {
  await mocks.handlers.message(request("1"));
  await mocks.handlers.message(request("2", [5]));
  expect(mocks.openBrowser).toHaveBeenCalledTimes(1);
  expect(mocks.openBrowser).toHaveBeenCalledWith(
    "chrome",
    expect.objectContaining({ chromeMode: "chrome-for-testing" }),
  );
  // The composition is chosen per preview, since the project changes.
  expect(mocks.selectComposition).toHaveBeenCalledTimes(2);
  expect(mocks.selectComposition).toHaveBeenCalledWith(
    expect.objectContaining({
      chromeMode: "chrome-for-testing",
      inputProps: request("1").inputProps,
    }),
  );
  // Every frame of a preview shares its server, so each source is read once.
  expect(mocks.prepareServer).toHaveBeenCalledTimes(2);
  const [first, second] = mocks.prepareServer.mock.results.map(
    (result) => result.value,
  );
  const servers = await Promise.all([first, second]);
  const calls = mocks.renderStill.mock.calls.map(([options]) => options);
  expect(calls).toHaveLength(5);
  for (const options of calls.slice(0, 4)) {
    expect(options.server).toBe(servers[0]);
    expect(options.chromeMode).toBe("chrome-for-testing");
    expect(options.serializedInputPropsWithCustomSchema).toContain(
      '"proxies":true',
    );
  }
  expect(calls[4].server).toBe(servers[1]);
  expect(mocks.closeServer).toHaveBeenCalledTimes(2);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.process.send).toHaveBeenNthCalledWith(1, {
    type: "done",
    id: "1",
    files: [0, 1, 2, 3].map((index) => `/tmp/preview-1/frame-${index}.jpg`),
  });
  expect(mocks.process.send).toHaveBeenNthCalledWith(2, {
    type: "done",
    id: "2",
    files: ["/tmp/preview-2/frame-0.jpg"],
  });
  expect(mocks.process.exit).not.toHaveBeenCalled();
});

it("answers a failed preview and starts a fresh browser for the next one", async () => {
  mocks.selectComposition.mockRejectedValueOnce(Error("Composition failed"));
  await mocks.handlers.message(request("1"));
  expect(mocks.process.send).toHaveBeenCalledWith({
    type: "error",
    id: "1",
    message: "Composition failed",
  });
  expect(mocks.close).toHaveBeenCalledTimes(1);
  await mocks.handlers.message(request("2", [5]));
  expect(mocks.openBrowser).toHaveBeenCalledTimes(2);
  expect(mocks.process.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "done", id: "2" }),
  );
});

it("closes Chrome and stops scheduling frames when the editor disconnects mid-preview", async () => {
  let finish!: () => void;
  const render = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.renderStill.mockReturnValue(render);
  const job = mocks.handlers.message(request("1"));
  await vi.waitFor(() => expect(mocks.renderStill).toHaveBeenCalledTimes(2));
  mocks.process.connected = false;
  mocks.handlers.disconnect();
  finish();
  await job;
  await vi.waitFor(() => expect(mocks.process.exit).toHaveBeenCalledWith(0));
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.renderStill).toHaveBeenCalledTimes(2);
  expect(mocks.closeServer).toHaveBeenCalledTimes(1);
  expect(mocks.process.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("also closes a browser whose startup finishes after the editor disconnected", async () => {
  let opened!: (browser: { close: typeof mocks.close }) => void;
  mocks.openBrowser.mockReturnValue(
    new Promise((resolve) => {
      opened = resolve;
    }),
  );
  const job = mocks.handlers.message(request("1"));
  await vi.waitFor(() => expect(mocks.openBrowser).toHaveBeenCalled());
  mocks.process.connected = false;
  mocks.handlers.disconnect();
  opened({ close: mocks.close });
  await job;
  await vi.waitFor(() => expect(mocks.process.exit).toHaveBeenCalledWith(0));
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.selectComposition).not.toHaveBeenCalled();
  expect(mocks.process.send).not.toHaveBeenCalled();
});

it("never starts Chrome for a preview that was still queued when the editor left", async () => {
  const job = mocks.handlers.message(request("1"));
  mocks.handlers.disconnect();
  await job;
  expect(mocks.openBrowser).not.toHaveBeenCalled();
  expect(mocks.process.exit).toHaveBeenCalledWith(0);
});

it("closes Chrome and exits when the editor stops it, even before Remotion's own handlers exist", async () => {
  await mocks.handlers.message(request("1"));
  mocks.handlers.SIGTERM();
  await vi.waitFor(() => expect(mocks.process.exit).toHaveBeenCalledWith(0));
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it("exits after 5 seconds if Chrome never starts or closes, so Remotion's exit handler stops its group", async () => {
  mocks.openBrowser.mockReturnValue(new Promise(() => {}));
  void mocks.handlers.message(request("1"));
  await vi.waitFor(() => expect(mocks.openBrowser).toHaveBeenCalled());
  mocks.handlers.disconnect();
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.process.exit).toHaveBeenCalledWith(1);
  // Chrome runs in its own process group; this worker's group never held it.
  expect(mocks.process.kill).not.toHaveBeenCalled();
  expect(mocks.process.send).not.toHaveBeenCalled();
});

it("serves each preview on a free port, never Remotion's 3000 where dev servers live", async () => {
  await mocks.handlers.message(request("1", [0]));
  const port = mocks.selectComposition.mock.calls[0][0].port;
  expect(port).toBeGreaterThan(1023);
  expect(mocks.prepareServer.mock.calls[0][0].port).toBe(port);
  expect(mocks.renderStill.mock.calls[0][0].port).toBe(port);
});
