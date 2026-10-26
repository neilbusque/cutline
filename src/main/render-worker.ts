import os from "node:os";
import process from "node:process";
import { browserOptions } from "../../scripts/browser-config.mjs";
import {
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
  makeCancelSignal,
} from "@remotion/renderer";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { freePort } from "./free-port";
import { repairDamagedFrames } from "./frame-repair";
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
let sentPercent = -1;
let cancel: (() => void) | undefined;
let mux: ChildProcess | undefined;
let cancelled = false;
let rendering = false;
/** Stops the render and exits within 5 seconds, closing Chrome first. */
const stop = () => {
  cancelled = true;
  cancel?.();
  mux?.kill("SIGTERM");
  void browser?.close({ silent: true }).catch(() => {});
  setTimeout(() => process.exit(1), 5000).unref();
};
// A crashed/closed editor must not leave an orphan render occupying the Mac.
process.on("disconnect", stop);
// The editor's SIGTERM can arrive before Remotion adds its own handlers, and
// by default it would end this worker and leave Chrome running in its own
// process group.
process.on("SIGTERM", () => {
  stop();
  if (!rendering) process.exit(0);
});
process.on("message", async (message: any) => {
  if (message.type === "cancel") {
    cancelled = true;
    cancel?.();
    mux?.kill("SIGTERM");
    return;
  }
  rendering = true;
  const audio = message.outputLocation + ".audio.wav",
    video = message.outputLocation + ".video.mp4";
  try {
    const { serveUrl, inputProps, outputLocation, browserExecutable, ffmpeg } =
      message;
    const signal = makeCancelSignal();
    cancel = signal.cancel;
    // Remotion's video frame cache defaults to half of free memory. This Mac
    // runs other work beside exports, so a quarter of free memory, 256 MB to
    // 1 GB, is the budget.
    const frameCache = Math.max(
      256 * 1024 ** 2,
      Math.min(1024 ** 3, Math.floor(os.freemem() / 4)),
    );
    const port = await freePort().catch(() => null);
    // One Chrome for the whole export instead of one per step.
    browser = await openBrowser("chrome", {
      browserExecutable,
      ...browserOptions,
    });
    if (cancelled) throw Error("Cancelled");
    const composition = await selectComposition({
      serveUrl,
      id: "Cutline",
      inputProps,
      browserExecutable,
      ...browserOptions,
      puppeteerInstance: browser,
      offthreadVideoCacheSizeInBytes: frameCache,
      port,
      timeoutInMilliseconds: 30000,
    });
    // Keep the intermediate mix lossless. Mux AAC directly into MP4 so its
    // encoder-delay metadata is retained, avoiding a ~43 ms ADTS timing shift.
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: "h264",
      audioCodec: "pcm-16",
      separateAudioTo: audio,
      enforceAudioTrack: true,
      outputLocation: video,
      browserExecutable,
      ...browserOptions,
      puppeteerInstance: browser,
      offthreadVideoCacheSizeInBytes: frameCache,
      offthreadVideoThreads: 2,
      port,
      concurrency: 2,
      crf: 19,
      pixelFormat: "yuv420p",
      timeoutInMilliseconds: 30000,
      cancelSignal: signal.cancelSignal,
      // The H.264/PCM pre-encode uses Matroska's millisecond timestamps.
      // Keep subsequent MP4 remuxes at 90 kHz to avoid further quantization;
      // remuxing cannot restore precision already lost in the intermediate.
      ffmpegOverride: ({ type, args }) =>
        type === "pre-stitcher"
          ? args
          : [
              ...args.slice(0, -1),
              "-r",
              String(composition.fps),
              "-video_track_timescale",
              "90000",
              args[args.length - 1],
            ],
      // Whole percents only: the editor redraws on every progress message.
      onProgress: (p) => {
        const percent = Math.floor(p.progress * 97);
        if (percent === sentPercent) return;
        sentPercent = percent;
        process.send?.({ type: "progress", progress: percent / 100 });
      },
    });
    if (cancelled) throw Error("Cancelled");
    // Chrome now and then captures a frame wrong (once: the top of the canvas
    // tiled five times). Re-render any frame that breaks from both
    // neighbours and keep the fresh one where it differs.
    const repairedFrames = await repairDamagedFrames({
      ffmpeg,
      video,
      fps: composition.fps,
      renderFrame: (frame, output) =>
        renderStill({
          serveUrl,
          composition,
          inputProps,
          frame,
          output,
          imageFormat: "png",
          overwrite: true,
          browserExecutable,
          ...browserOptions,
          puppeteerInstance: browser,
          offthreadVideoCacheSizeInBytes: frameCache,
          port,
          timeoutInMilliseconds: 30000,
          cancelSignal: signal.cancelSignal,
        }),
    });
    if (cancelled) throw Error("Cancelled");
    await new Promise<void>((resolve, reject) => {
      mux = spawn(
        ffmpeg,
        [
          "-y",
          "-v",
          "error",
          "-i",
          video,
          "-i",
          audio,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          // Preserve Remotion's exact frame rate and MP4 time base through the
          // final AAC mux instead of letting FFmpeg infer rounded timestamps.
          "-r",
          String(composition.fps),
          "-video_track_timescale",
          "90000",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-t",
          String(composition.durationInFrames / composition.fps),
          "-movflags",
          "+faststart",
          outputLocation,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      mux.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      mux.on("error", reject);
      mux.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              Error(cancelled ? "Cancelled" : stderr || "Audio mux failed"),
            ),
      );
    });
    // Exact isolated native mixes: use the same source timing, envelopes,
    // transitions and track mutes as the delivered movie. No role guessing.
    const stemFailures: string[] = [];
    const completedStems: string[] = [];
    for (const role of ["voice", "music", "sfx"] as const) {
      const stemPath = message.audioStems?.[role];
      if (!stemPath) continue;
      if (cancelled) throw Error("Cancelled");
      process.send?.({
        type: "status",
        message: `Preparing ${role === "sfx" ? "sound effects" : role} for listening`,
      });
      const stemProject = {
        ...inputProps.project,
        clips: inputProps.project.clips.map((clip: any) =>
          clip.audioRole === role
            ? clip
            : {
                ...clip,
                volume: 0,
                keyframes: clip.keyframes?.map((key: any) =>
                  key.property === "volume" ? { ...key, value: 0 } : key,
                ),
              },
        ),
      };
      try {
        await renderMedia({
          serveUrl,
          composition,
          inputProps: { ...inputProps, project: stemProject },
          codec: "wav",
          outputLocation: stemPath,
          enforceAudioTrack: true,
          browserExecutable,
          ...browserOptions,
          puppeteerInstance: browser,
          offthreadVideoCacheSizeInBytes: frameCache,
          offthreadVideoThreads: 2,
          port,
          concurrency: 1,
          timeoutInMilliseconds: 30000,
          cancelSignal: signal.cancelSignal,
        });
        completedStems.push(role);
      } catch (error) {
        if (cancelled) throw Error("Cancelled");
        rmSync(stemPath, { force: true });
        stemFailures.push(
          `The isolated ${role} mix could not be rendered. Automatic corrections requiring it were withheld.`,
        );
      }
    }
    if (cancelled) throw Error("Cancelled");
    process.send?.({
      type: "done",
      output: outputLocation,
      repairedFrames,
      completedStems,
      stemFailures,
    });
  } catch (e) {
    process.send?.({ type: "error", message: (e as Error).message });
  } finally {
    await browser?.close({ silent: true }).catch(() => {});
    rmSync(audio, { force: true });
    rmSync(video, { force: true });
    process.exit(0);
  }
});
