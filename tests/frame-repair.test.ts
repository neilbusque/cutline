import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findIsolatedFrames,
  repairDamagedFrames,
} from "../src/main/frame-repair";

const ffmpeg = path.resolve(
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const hasFfmpeg =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  existsSync(ffmpeg);
const run = (args: string[]) =>
  execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
/** A 12-frame grey clip with frame 5 replaced by a white one. */
function damagedVideo(folder: string) {
  const video = path.join(folder, "render.mp4");
  run([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x606060:s=64x112:r=30:d=0.4",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=64x112:r=30:d=0.4",
    "-filter_complex",
    "[0:v][1:v]overlay=enable='eq(n\\,5)'",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  return video;
}
const still = (color: string) => async (_frame: number, output: string) =>
  run([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x112`,
    "-frames:v",
    "1",
    output,
  ]);

describe.skipIf(!hasFfmpeg)("damaged frame repair", () => {
  it("replaces a frame the browser captured wrong with a fresh render", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "frame-repair-"));
    try {
      const video = damagedVideo(folder);
      expect(
        (await findIsolatedFrames(ffmpeg, video)).map((f) => f.frame),
      ).toEqual([5]);
      const rendered: number[] = [];
      const repaired = await repairDamagedFrames({
        ffmpeg,
        video,
        fps: 30,
        renderFrame: async (frame, output) => {
          rendered.push(frame);
          await still("0x606060")(frame, output);
        },
      });
      expect(rendered).toEqual([5]);
      expect(repaired).toEqual([5]);
      expect(await findIsolatedFrames(ffmpeg, video)).toEqual([]);
      expect(existsSync(video.replace(".mp4", ".repaired.mp4"))).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("keeps a one-frame shot that renders the same again", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "frame-repair-"));
    try {
      const video = damagedVideo(folder);
      const before = statSync(video).mtimeMs;
      const repaired = await repairDamagedFrames({
        ffmpeg,
        video,
        fps: 30,
        renderFrame: still("white"),
      });
      expect(repaired).toEqual([]);
      expect(statSync(video).mtimeMs).toBe(before);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
