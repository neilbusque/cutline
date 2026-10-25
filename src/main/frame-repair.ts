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

const thumbnailArgs = [
  "-vf",
  `scale=${FRAME_CHECK_SIZE}:${FRAME_CHECK_SIZE},format=gray`,
  "-f",
  "rawvideo",
  "-",
];
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

/** Frames of a video that break from both neighbours, with their thumbnails. */
export async function findIsolatedFrames(ffmpeg: string, video: string) {
  const size = FRAME_CHECK_SIZE * FRAME_CHECK_SIZE;
  const finder = new IsolatedFrameFinder();
  let pending = Buffer.alloc(0);
  await runFfmpeg(ffmpeg, ["-i", video, ...thumbnailArgs], (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= size) {
      finder.push(new Uint8Array(pending.subarray(0, size)));
      pending = pending.subarray(size);
    }
  });
  return finder.found;
}

async function thumbnailOf(ffmpeg: string, image: string) {
  const chunks: Buffer[] = [];
  await runFfmpeg(ffmpeg, ["-i", image, ...thumbnailArgs], (c) =>
    chunks.push(c),
  );
  return new Uint8Array(Buffer.concat(chunks));
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
    // Each fresh frame is laid over its own frame number only.
    const filters = damaged.map(
      ({ frame }, i) =>
        `[${i ? `v${i}` : "0:v"}][${i + 1}:v]overlay=enable='eq(n\\,${frame})'[v${i + 1}]`,
    );
    await runFfmpeg(ffmpeg, [
      "-y",
      "-i",
      video,
      ...damaged.flatMap(({ image }) => ["-i", image]),
      "-filter_complex",
      filters.join(";"),
      "-map",
      `[v${damaged.length}]`,
      "-c:v",
      "libx264",
      "-crf",
      "19",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-video_track_timescale",
      "90000",
      patched,
    ]);
    const still = await findIsolatedFrames(ffmpeg, patched);
    const unrepaired = damaged.filter(({ frame, fresh }) =>
      still.some(
        (s) =>
          s.frame === frame && meanDifference(s.thumbnail, fresh) > FRAME_BREAK,
      ),
    );
    if (unrepaired.length)
      throw Error(
        `Frames ${unrepaired.map((d) => d.frame).join(", ")} stayed damaged after a re-render. Export again.`,
      );
    renameSync(patched, video);
    return damaged.map((d) => d.frame);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(patched, { force: true });
  }
}
