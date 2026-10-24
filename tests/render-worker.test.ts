import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  process: { on: vi.fn(), send: vi.fn(), exit: vi.fn() },
  selectComposition: vi.fn(),
  renderMedia: vi.fn(),
  openBrowser: vi.fn(),
  browser: { close: vi.fn() },
  spawn: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:process", () => ({ default: mocks.process }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ rmSync: mocks.rm }));
vi.mock("@remotion/renderer", () => ({
  selectComposition: mocks.selectComposition,
  renderMedia: mocks.renderMedia,
  openBrowser: mocks.openBrowser,
  makeCancelSignal: () => ({ cancel: vi.fn(), cancelSignal: vi.fn() }),
}));
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.process.on.mockImplementation((name, handler) => {
    mocks.handlers[name] = handler;
  });
  mocks.selectComposition.mockResolvedValue({ durationInFrames: 60, fps: 30 });
  mocks.renderMedia.mockResolvedValue(undefined);
  mocks.browser.close.mockResolvedValue(undefined);
  mocks.openBrowser.mockResolvedValue(mocks.browser);
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  await import("../src/main/render-worker");
});
it("uses the reviewed full browser for both composition loading and video rendering while retaining original audio muxing", async () => {
  await mocks.handlers.message({
    type: "render",
    serveUrl: "/composition",
    inputProps: {},
    browserExecutable: "/reviewed/Chrome",
    outputLocation: "/output.mp4",
    ffmpeg: "/ffmpeg",
  });
  expect(mocks.selectComposition).toHaveBeenCalledWith(
    expect.objectContaining({
      browserExecutable: "/reviewed/Chrome",
      chromeMode: "chrome-for-testing",
    }),
  );
  expect(mocks.renderMedia).toHaveBeenCalledWith(
    expect.objectContaining({
      browserExecutable: "/reviewed/Chrome",
      chromeMode: "chrome-for-testing",
      audioCodec: "pcm-16",
      separateAudioTo: "/output.mp4.audio.wav",
      enforceAudioTrack: true,
    }),
  );
  expect(mocks.process.send).toHaveBeenCalledWith({
    type: "done",
    output: "/output.mp4",
  });
  // One Chrome serves composition loading and rendering, with a bounded
  // frame cache, and is closed when the export ends.
  expect(mocks.openBrowser).toHaveBeenCalledTimes(1);
  for (const step of [mocks.selectComposition, mocks.renderMedia])
    expect(step).toHaveBeenCalledWith(
      expect.objectContaining({
        puppeteerInstance: mocks.browser,
        offthreadVideoCacheSizeInBytes: expect.any(Number),
      }),
    );
  const cache = mocks.renderMedia.mock.calls[0][0].offthreadVideoCacheSizeInBytes;
  expect(cache).toBeGreaterThanOrEqual(256 * 1024 ** 2);
  expect(cache).toBeLessThanOrEqual(1024 ** 3);
  expect(mocks.browser.close).toHaveBeenCalledWith({ silent: true });
  expect(mocks.rm).toHaveBeenCalledWith("/output.mp4.audio.wav", {
    force: true,
  });
  expect(mocks.rm).toHaveBeenCalledWith("/output.mp4.video.mp4", {
    force: true,
  });
});

it.each([24, 25, 30, 60])(
  "preserves the composition's %sfps timing when copying video into the AAC container",
  async (fps) => {
    mocks.selectComposition.mockResolvedValue({ durationInFrames: 240, fps });
    await mocks.handlers.message({
      type: "render",
      serveUrl: "/composition",
      inputProps: {},
      browserExecutable: "/reviewed/Chrome",
      outputLocation: "/output.mp4",
      ffmpeg: "/ffmpeg",
    });
    const [binary, args] = mocks.spawn.mock.calls[0];
    expect(binary).toBe("/ffmpeg");
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("-r")).toBe(String(fps));
    expect(value("-video_track_timescale")).toBe("90000");
    // Output options must follow both inputs. An input -r would change timestamps.
    expect(args.indexOf("-r")).toBeGreaterThan(args.lastIndexOf("-i"));
    expect(args.filter((arg: string) => arg === "-r")).toHaveLength(1);
    expect(value("-c:v")).toBe("copy");
    expect(value("-c:a")).toBe("aac");
    expect(value("-t")).toBe(String(240 / fps));
    expect(
      args.filter((_: string, index: number) => args[index - 1] === "-i"),
    ).toEqual(["/output.mp4.video.mp4", "/output.mp4.audio.wav"]);
    expect(args.at(-1)).toBe("/output.mp4");
    const override = mocks.renderMedia.mock.calls[0][0].ffmpegOverride;
    const encoderArgs = ["-r", String(fps), "-i", "-", "/preencoded.mp4"];
    expect(override({ type: "pre-stitcher", args: encoderArgs })).toBe(
      encoderArgs,
    );
    const stitchArgs = [
      "-i",
      "/preencoded.mp4",
      "-an",
      "-c:v",
      "copy",
      "/intermediate.mp4",
    ];
    const preserved = override({ type: "stitcher", args: stitchArgs });
    expect(preserved).toEqual([
      "-i",
      "/preencoded.mp4",
      "-an",
      "-c:v",
      "copy",
      "-r",
      String(fps),
      "-video_track_timescale",
      "90000",
      "/intermediate.mp4",
    ]);
    expect(stitchArgs).toHaveLength(6);
  },
);
