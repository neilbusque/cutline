import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  process: { on: vi.fn(), send: vi.fn(), exit: vi.fn() },
  selectComposition: vi.fn(),
  renderMedia: vi.fn(),
  renderStill: vi.fn(),
  repairDamagedFrames: vi.fn(),
  openBrowser: vi.fn(),
  browser: { close: vi.fn() },
  spawn: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:process", () => ({ default: mocks.process }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ rmSync: mocks.rm }));
vi.mock("../src/main/frame-repair", () => ({
  repairDamagedFrames: mocks.repairDamagedFrames,
}));
vi.mock("@remotion/renderer", () => ({
  selectComposition: mocks.selectComposition,
  renderMedia: mocks.renderMedia,
  renderStill: mocks.renderStill,
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
  mocks.repairDamagedFrames.mockResolvedValue([]);
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
    repairedFrames: [],
    completedStems: [],
    stemFailures: [],
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
  // Its own free port, never Remotion's default 3000 where dev servers live.
  const port = mocks.renderMedia.mock.calls[0][0].port;
  expect(port).toBeGreaterThan(1023);
  expect(mocks.selectComposition.mock.calls[0][0].port).toBe(port);
  const cache =
    mocks.renderMedia.mock.calls[0][0].offthreadVideoCacheSizeInBytes;
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

it("stops cleanly on the editor's SIGTERM, even while Chrome is still starting", async () => {
  let opened!: (browser: typeof mocks.browser) => void;
  mocks.openBrowser.mockReturnValue(
    new Promise((resolve) => {
      opened = resolve;
    }),
  );
  const exporting = mocks.handlers.message({
    type: "render",
    serveUrl: "/composition",
    inputProps: {},
    browserExecutable: "/reviewed/Chrome",
    outputLocation: "/output.mp4",
    ffmpeg: "/ffmpeg",
  });
  // Remotion's own handlers are added only once Chrome is up.
  mocks.handlers.SIGTERM();
  expect(mocks.process.exit).not.toHaveBeenCalled();
  opened(mocks.browser);
  await exporting;
  expect(mocks.selectComposition).not.toHaveBeenCalled();
  expect(mocks.browser.close).toHaveBeenCalledWith({ silent: true });
  expect(mocks.process.exit).toHaveBeenCalledWith(0);
});

it("exits right away on SIGTERM when no export has started", () => {
  mocks.handlers.SIGTERM();
  expect(mocks.process.exit).toHaveBeenCalledWith(0);
});

it("re-renders damaged frames with the export's own browser and composition before muxing", async () => {
  mocks.repairDamagedFrames.mockImplementation(async ({ renderFrame }) => {
    await renderFrame(131, "/tmp/frame-131.png");
    return [131];
  });
  await mocks.handlers.message({
    type: "render",
    serveUrl: "/composition",
    inputProps: { project: "p" },
    browserExecutable: "/reviewed/Chrome",
    outputLocation: "/output.mp4",
    ffmpeg: "/ffmpeg",
  });
  expect(mocks.repairDamagedFrames).toHaveBeenCalledWith(
    expect.objectContaining({
      ffmpeg: "/ffmpeg",
      video: "/output.mp4.video.mp4",
      fps: 30,
    }),
  );
  expect(mocks.renderStill).toHaveBeenCalledWith(
    expect.objectContaining({
      serveUrl: "/composition",
      inputProps: { project: "p" },
      frame: 131,
      output: "/tmp/frame-131.png",
      imageFormat: "png",
      puppeteerInstance: mocks.browser,
      chromeMode: "chrome-for-testing",
    }),
  );
  // The repair runs on the silent video, before the audio mux reads it.
  expect(mocks.repairDamagedFrames.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.spawn.mock.invocationCallOrder[0],
  );
  expect(mocks.process.send).toHaveBeenCalledWith({
    type: "done",
    output: "/output.mp4",
    repairedFrames: [131],
    completedStems: [],
    stemFailures: [],
  });
});

it("isolates requested roles without removing clips or losing the selected role's gain automation", async () => {
  const project = {
    tracks: [
      { id: "speech", kind: "audio", muted: false, hidden: false },
      { id: "bed", kind: "audio", muted: true, hidden: false },
      { id: "picture", kind: "video", muted: false, hidden: false },
    ],
    clips: [
      {
        id: "voice",
        trackId: "speech",
        kind: "audio",
        audioRole: "voice",
        start: 5,
        duration: 45,
        sourceIn: 2,
        speed: 1.25,
        volume: 0.8,
        fadeIn: 3,
        fadeOut: 5,
        keyframes: [
          { property: "volume", frame: 0, value: 0.8 },
          { property: "volume", frame: 30, value: 0.3 },
          { property: "opacity", frame: 10, value: 0.5 },
        ],
      },
      {
        id: "music",
        trackId: "bed",
        kind: "audio",
        audioRole: "music",
        start: 0,
        duration: 60,
        sourceIn: 8,
        speed: 1,
        // Native volume keys can make a zero-base clip audible. Muting only
        // the base gain would leak this clip into the isolated voice mix.
        volume: 0,
        keyframes: [
          { property: "volume", frame: 10, value: 0.9 },
          { property: "scale", frame: 20, value: 1.1 },
        ],
      },
      {
        id: "mixed-camera",
        trackId: "picture",
        kind: "video",
        audioRole: "mixed",
        start: 0,
        duration: 60,
        volume: 1,
        keyframes: [{ property: "volume", frame: 1, value: 1 }],
      },
      {
        id: "unclassified",
        trackId: "picture",
        kind: "video",
        start: 0,
        duration: 60,
        volume: 1,
        keyframes: [],
      },
    ],
  };
  const original = structuredClone(project);
  await mocks.handlers.message({
    type: "render",
    serveUrl: "/composition",
    inputProps: { project, mediaBase: "/media", preview: false },
    browserExecutable: "/reviewed/Chrome",
    outputLocation: "/output.mp4",
    ffmpeg: "/ffmpeg",
    audioStems: { voice: "/voice.wav", music: "/music.wav" },
  });

  expect(mocks.renderMedia).toHaveBeenCalledTimes(3);
  expect(project).toEqual(original);
  const [main, voice, music] = mocks.renderMedia.mock.calls.map(
    ([args]) => args,
  );
  expect(main.inputProps.project).toEqual(original);
  for (const stem of [voice, music]) {
    expect(stem.codec).toBe("wav");
    expect(stem.enforceAudioTrack).toBe(true);
    expect(stem.composition).toEqual(main.composition);
    expect(stem.inputProps.project.tracks).toEqual(original.tracks);
    expect(stem.inputProps.project.clips.map((clip: any) => clip.id)).toEqual(
      original.clips.map((clip) => clip.id),
    );
    expect(stem.puppeteerInstance).toBe(mocks.browser);
  }
  expect(voice.outputLocation).toBe("/voice.wav");
  expect(voice.inputProps.project.clips[0]).toEqual(original.clips[0]);
  expect(voice.inputProps.project.clips[1]).toEqual({
    ...original.clips[1],
    volume: 0,
    keyframes: [
      { property: "volume", frame: 10, value: 0 },
      { property: "scale", frame: 20, value: 1.1 },
    ],
  });
  expect(voice.inputProps.project.clips[2].volume).toBe(0);
  expect(voice.inputProps.project.clips[2].keyframes[0].value).toBe(0);
  expect(voice.inputProps.project.clips[3].volume).toBe(0);
  expect(music.outputLocation).toBe("/music.wav");
  expect(music.inputProps.project.clips[1]).toEqual(original.clips[1]);
  expect(music.inputProps.project.clips[0].volume).toBe(0);
  expect(music.inputProps.project.clips[0].keyframes).toEqual([
    { property: "volume", frame: 0, value: 0 },
    { property: "volume", frame: 30, value: 0 },
    { property: "opacity", frame: 10, value: 0.5 },
  ]);
  expect(mocks.process.send).toHaveBeenCalledWith({
    type: "done",
    output: "/output.mp4",
    repairedFrames: [],
    completedStems: ["voice", "music"],
    stemFailures: [],
  });
  expect(mocks.openBrowser).toHaveBeenCalledTimes(1);
  expect(mocks.browser.close).toHaveBeenCalledTimes(1);
});

it("keeps the completed MP4 and other stems when an optional stem render fails", async () => {
  mocks.renderMedia.mockImplementation(async (args) => {
    if (args.outputLocation === "/voice.wav")
      throw Error("Fixture isolated voice rendering failed");
  });
  await mocks.handlers.message({
    type: "render",
    serveUrl: "/composition",
    inputProps: {
      project: {
        clips: [
          { id: "voice", audioRole: "voice", volume: 1, keyframes: [] },
          { id: "music", audioRole: "music", volume: 0.2, keyframes: [] },
        ],
      },
    },
    browserExecutable: "/reviewed/Chrome",
    outputLocation: "/output.mp4",
    ffmpeg: "/ffmpeg",
    audioStems: { voice: "/voice.wav", music: "/music.wav" },
  });

  expect(mocks.renderMedia).toHaveBeenCalledTimes(3);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.spawn.mock.calls[0][1].at(-1)).toBe("/output.mp4");
  expect(mocks.spawn.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.renderMedia.mock.invocationCallOrder[1],
  );
  expect(mocks.rm).toHaveBeenCalledWith("/voice.wav", { force: true });
  expect(mocks.rm).not.toHaveBeenCalledWith("/music.wav", { force: true });
  expect(mocks.rm).not.toHaveBeenCalledWith("/output.mp4", { force: true });
  expect(mocks.process.send).toHaveBeenCalledWith({
    type: "done",
    output: "/output.mp4",
    repairedFrames: [],
    completedStems: ["music"],
    stemFailures: [
      "The isolated voice mix could not be rendered. Automatic corrections requiring it were withheld.",
    ],
  });
  expect(
    mocks.process.send.mock.calls.some(([message]) => message.type === "error"),
  ).toBe(false);
  expect(mocks.browser.close).toHaveBeenCalledWith({ silent: true });
  expect(mocks.process.exit).toHaveBeenCalledWith(0);
});
