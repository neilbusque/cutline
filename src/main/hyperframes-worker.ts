import process from "node:process";
import { existsSync } from "node:fs";
import type { HyperframesRequest } from "./hyperframes";

const controller = new AbortController();
let rendering = false;
let stopping = false;
let emergency: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  if (stopping) return;
  stopping = true;
  controller.abort();
  // Producer's finally closes every capture session, file server and encoder.
  // If Chrome is unresponsive, the parent kills this worker's process group.
  emergency = setTimeout(() => {
    // Puppeteer's synchronous process-exit handler also kills Chrome's own
    // process group. SIGKILL here would skip that handler and orphan Chrome.
    process.exit(1);
  }, 8_000);
  emergency.unref();
  if (!rendering) process.exit(0);
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);

function finish(message: Record<string, unknown>, code: number) {
  clearTimeout(emergency);
  if (process.connected && process.send) {
    process.send(message, () => process.exit(code));
  } else process.exit(code);
}

process.on(
  "message",
  async (message: HyperframesRequest & { type: string }) => {
    if (message?.type === "cancel") {
      stop();
      return;
    }
    if (message?.type !== "render" || rendering) return;
    rendering = true;
    let closeBrowsers: (() => Promise<void>) | undefined;
    try {
      for (const [name, file] of [
        ["Chrome", message.browserExecutable],
        ["FFmpeg", message.ffmpeg],
        ["FFprobe", message.ffprobe],
      ]) {
        if (!existsSync(file))
          throw Error(
            `${name} is missing. Repair Cutline's local runtime, then render the scene again.`,
          );
      }
      // The producer's media helpers share these reviewed local executables.
      process.env.HYPERFRAMES_FFMPEG_PATH = message.ffmpeg;
      process.env.HYPERFRAMES_FFPROBE_PATH = message.ffprobe;
      process.env.FFMPEG_PATH = message.ffmpeg;
      process.env.FFPROBE_PATH = message.ffprobe;
      process.env.PUPPETEER_EXECUTABLE_PATH = message.browserExecutable;
      process.env.PUPPETEER_SKIP_DOWNLOAD = "true";
      // Dynamic import preserves the producer's ESM package in the CJS worker.
      const { createRenderJob, executeRenderJob, DEFAULT_CONFIG } =
        await import("@hyperframes/producer");
      closeBrowsers = (await import("@hyperframes/engine")).closeBrowserPool;
      if (controller.signal.aborted) throw Error("Cancelled");
      const job = createRenderJob({
        fps: message.fps,
        quality: "standard",
        workers: 1,
        entryFile: message.entryFile,
        format: message.transparent ? "webm" : "mp4",
        strictness: "strict",
        hdrMode: "force-sdr",
        producerConfig: {
          ...DEFAULT_CONFIG,
          chromePath: message.browserExecutable,
          concurrency: 1,
          lowMemoryMode: true,
          browserGpuMode: "hardware",
          enableBrowserPool: false,
          forceScreenshot: true,
          // Use lossless readback for authored graphics and transparent scenes.
          format: "png",
          staticFrameDedup: false,
          useDrawElement: false,
          enableDrawElementWorkerEncode: false,
          frameDataUriCacheLimit: 32,
          frameDataUriCacheBytesLimitMb: 128,
          extractCacheMaxBytes: 256 * 1024 ** 2,
        },
      });
      await executeRenderJob(
        job,
        message.directory,
        message.output,
        (current, label) => {
          if (process.connected)
            process.send?.(
              {
                type: "progress",
                progress: current.progress / 100,
                message: label,
              },
              () => {},
            );
        },
        controller.signal,
        () => {
          if (controller.signal.aborted) throw Error("Cancelled");
        },
      );
      if (controller.signal.aborted) throw Error("Cancelled");
      await closeBrowsers();
      // executeRenderJob has awaited its full cleanup before this message.
      finish({ type: "done" }, 0);
    } catch (error) {
      await closeBrowsers?.().catch(() => {});
      const message = (error as Error).message;
      finish(
        {
          type: "error",
          message: /Cannot find (?:package|module)/.test(message)
            ? "HyperFrames is missing. Reinstall Cutline's dependencies or update the app."
            : message,
        },
        1,
      );
    }
  },
);
