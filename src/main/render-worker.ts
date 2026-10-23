import process from "node:process";
import { browserOptions } from "../../scripts/browser-config.mjs";
import {
  renderMedia,
  selectComposition,
  makeCancelSignal,
} from "@remotion/renderer";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
let cancel: (() => void) | undefined;
let mux: ChildProcess | undefined;
let cancelled = false;
// A crashed/closed editor must not leave an orphan render occupying the Mac.
process.on("disconnect", () => {
  cancelled = true;
  cancel?.();
  mux?.kill("SIGTERM");
  setTimeout(() => process.exit(1), 5000).unref();
});
process.on("message", async (message: any) => {
  if (message.type === "cancel") {
    cancelled = true;
    cancel?.();
    mux?.kill("SIGTERM");
    return;
  }
  const audio = message.outputLocation + ".audio.wav",
    video = message.outputLocation + ".video.mp4";
  try {
    const { serveUrl, inputProps, outputLocation, browserExecutable, ffmpeg } =
      message;
    const signal = makeCancelSignal();
    cancel = signal.cancel;
    const composition = await selectComposition({
      serveUrl,
      id: "Cutline",
      inputProps,
      browserExecutable,
      ...browserOptions,
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
      onProgress: (p) =>
        process.send?.({ type: "progress", progress: p.progress * 0.97 }),
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
    process.send?.({ type: "done", output: outputLocation });
  } catch (e) {
    process.send?.({ type: "error", message: (e as Error).message });
  } finally {
    rmSync(audio, { force: true });
    rmSync(video, { force: true });
    process.exit(0);
  }
});
