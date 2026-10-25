import { spawn } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FRAME_BREAK,
  FRAME_CHECK_SIZE,
  IsolatedFrameFinder,
  meanDifference,
} from "../shared/frame-check";

// RGB thumbnails: FFmpeg converts video by its own range and matrix tags and a
// PNG stays as drawn, so a fresh still and a video frame compare like for like.
const thumbnailArgs = [
  "-vf",
  `scale=${FRAME_CHECK_SIZE}:${FRAME_CHECK_SIZE},format=rgb24`,
  "-f",
  "rawvideo",
  "-",
];
const THUMBNAIL_BYTES = FRAME_CHECK_SIZE * FRAME_CHECK_SIZE * 3;
/** More one-frame breaks than this is not a capture fault worth patching. */
export const MAX_REPAIRED_FRAMES = 24;

/** Runs FFmpeg, handing its stdout over in chunks. */
function runFfmpeg(
  ffmpeg: string,
  args: string[],
  onData?: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", ...args], {
      stdio: ["ignore", onData ? "pipe" : "ignore", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => onData?.(chunk));
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(stderr || `FFmpeg exited ${code}`)),
    );
  });
}

/** Calls back with every frame's thumbnail, in order. */
async function eachThumbnail(
  ffmpeg: string,
  file: string,
  onFrame: (thumbnail: Uint8Array) => void,
) {
  let pending = Buffer.alloc(0);
  await runFfmpeg(ffmpeg, ["-i", file, ...thumbnailArgs], (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= THUMBNAIL_BYTES) {
      onFrame(new Uint8Array(pending.subarray(0, THUMBNAIL_BYTES)));
      pending = pending.subarray(THUMBNAIL_BYTES);
    }
  });
}

/** Frames of a video that break from both neighbours, with their thumbnails. */
export async function findIsolatedFrames(ffmpeg: string, video: string) {
  const finder = new IsolatedFrameFinder();
  await eachThumbnail(ffmpeg, video, (t) => finder.push(t));
  return finder.found;
}

async function thumbnailOf(ffmpeg: string, image: string) {
  let thumbnail: Uint8Array = new Uint8Array();
  await eachThumbnail(ffmpeg, image, (t) => (thumbnail = t));
  return thumbnail;
}

export type VideoColor = {
  pixelFormat: string;
  range: "pc" | "tv";
  matrix: "bt601" | "bt709";
  /** The colorspace tag to write back, when the source had one. */
  tag?: string;
};

/**
 * Reads pixel format, range and matrix from FFmpeg's stream line, such as
 * "yuvj420p(pc, bt470bg/unknown/unknown)" for Remotion's H.264.
 */
export function parseVideoColor(info: string): VideoColor {
  const match = /Video: [^\n]*?, (\w+)(?:\(([^)]*)\))?/.exec(info);
  const pixelFormat = match?.[1] ?? "yuv420p";
  const details = (match?.[2] ?? "").split(/[,\s/]+/);
  const range = details.includes("pc")
    ? "pc"
    : details.includes("tv")
      ? "tv"
      : pixelFormat.startsWith("yuvj")
        ? "pc"
        : "tv";
  const tag = details.find((d) =>
    ["bt709", "bt470bg", "smpte170m"].includes(d),
  );
  return {
    pixelFormat,
    range,
    matrix: tag === "bt709" ? "bt709" : "bt601",
    ...(tag ? { tag } : {}),
  };
}

function probeColor(ffmpeg: string, video: string): Promise<VideoColor> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", video], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let info = "";
    child.stderr?.on("data", (d) => (info += d));
    child.on("error", () => resolve(parseVideoColor("")));
    // FFmpeg exits with an error when given no output; the stream line is enough.
    child.on("exit", () => resolve(parseVideoColor(info)));
  });
}

/**
 * The patch filter: fresh frames are laid over their own frame numbers in RGB,
 * then converted back to the source's pixel format, range and matrix, so a
 * repaired frame keeps the video's colors.
 */
export function patchFilter(frames: number[], color: VideoColor, fps: number) {
  // Timestamps are renumbered from the decoded frame index first, so frame N
  // is exactly the N the scan reported. (Overlay's own `n` can follow the
  // other input's frame rate.)
  const toRgb = `setpts=N/(${fps}*TB),scale=in_range=${color.range}:in_color_matrix=${color.matrix},format=gbrp`;
  const parts = [`[0:v]${toRgb}[b0]`];
  frames.forEach((frame, i) => {
    const from = ((frame - 0.5) / fps).toFixed(6),
      to = ((frame + 0.5) / fps).toFixed(6);
    parts.push(`[${i + 1}:v]format=gbrp[s${i}]`);
    parts.push(
      `[b${i}][s${i}]overlay=enable='between(t\\,${from}\\,${to})':format=gbrp[b${i + 1}]`,
    );
  });
  parts.push(
    `[b${frames.length}]scale=out_range=${color.range}:out_color_matrix=${color.matrix},format=${color.pixelFormat}[out]`,
  );
  return parts.join(";");
}

/**
 * Checks a finished render for frames the browser captured wrong and puts a
 * fresh render of each one in its place. A one-frame shot the edit really
 * has renders the same again and is left alone. Returns the repaired frames.
 */
export async function repairDamagedFrames({
  ffmpeg,
  video,
  fps,
  renderFrame,
}: {
  ffmpeg: string;
  video: string;
  fps: number;
  renderFrame: (frame: number, output: string) => Promise<unknown>;
}): Promise<number[]> {
  const candidates = await findIsolatedFrames(ffmpeg, video);
  if (!candidates.length) return [];
  if (candidates.length > MAX_REPAIRED_FRAMES)
    throw Error(
      `The export has ${candidates.length} frames that break from the frames around them. Export again.`,
    );
  const folder = mkdtempSync(path.join(os.tmpdir(), "cutline-frames-"));
  const patched = video.replace(/(\.\w+)?$/, ".repaired$1");
  try {
    const damaged: { frame: number; image: string; fresh: Uint8Array }[] = [];
    for (const candidate of candidates) {
      const image = path.join(folder, `frame-${candidate.frame}.png`);
      await renderFrame(candidate.frame, image);
      const fresh = await thumbnailOf(ffmpeg, image);
      if (meanDifference(fresh, candidate.thumbnail) > FRAME_BREAK)
        damaged.push({ frame: candidate.frame, image, fresh });
    }
    if (!damaged.length) return [];
    const color = await probeColor(ffmpeg, video);
    await runFfmpeg(ffmpeg, [
      "-y",
      "-i",
      video,
      ...damaged.flatMap(({ image }) => ["-i", image]),
      "-filter_complex",
      patchFilter(
        damaged.map((d) => d.frame),
        color,
        fps,
      ),
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-crf",
      "19",
      "-pix_fmt",
      color.pixelFormat,
      "-color_range",
      color.range,
      ...(color.tag ? ["-colorspace", color.tag] : []),
      "-r",
      String(fps),
      "-video_track_timescale",
      "90000",
      patched,
    ]);
    // Every repaired frame must now match its fresh render.
    const wanted = new Map(damaged.map((d) => [d.frame, d.fresh]));
    const mismatched: number[] = [];
    let index = 0;
    await eachThumbnail(ffmpeg, patched, (t) => {
      const fresh = wanted.get(index);
      if (fresh && meanDifference(t, fresh) > FRAME_BREAK / 2)
        mismatched.push(index);
      index++;
    });
    if (mismatched.length)
      throw Error(
        `Frames ${mismatched.join(", ")} stayed damaged after a re-render. Export again.`,
      );
    renameSync(patched, video);
    return damaged.map((d) => d.frame);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(patched, { force: true });
  }
}
