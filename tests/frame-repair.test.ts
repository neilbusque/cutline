import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findIsolatedFrames,
  parseVideoColor,
  patchFilter,
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
/**
 * A 12-frame dark clip with frame 5 replaced by a white one, encoded the way
 * Remotion encodes: full-range yuvj420p tagged bt470bg.
 */
function damagedVideo(folder: string) {
  const video = path.join(folder, "render.mp4");
  run([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x202838:s=64x112:r=30:d=0.4",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=64x112:r=30:d=0.4",
    "-filter_complex",
    "[0:v][1:v]overlay=enable='eq(n\\,5)',format=yuvj420p",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuvj420p",
    "-color_range",
    "pc",
    "-colorspace",
    "bt470bg",
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
/** Mean RGB of one frame. */
const rgbAt = (video: string, frame: number) => {
  const raw = execFileSync(ffmpeg, [
    "-v",
    "error",
    "-i",
    video,
    "-vf",
    `select=eq(n\\,${frame}),scale=1:1,format=rgb24`,
    "-vsync",
    "0",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
  return [...raw];
};

describe("video color for repairs", () => {
  it("reads Remotion's full-range bt601 stream and a tagged bt709 one", () => {
    expect(
      parseVideoColor(
        "Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuvj420p(pc, bt470bg/unknown/unknown), 1080x1920",
      ),
    ).toEqual({
      pixelFormat: "yuvj420p",
      range: "pc",
      matrix: "bt601",
      tag: "bt470bg",
    });
    expect(
      parseVideoColor(
        "Video: h264 (High), yuv420p(tv, bt709, progressive), 1920x1080",
      ),
    ).toEqual({
      pixelFormat: "yuv420p",
      range: "tv",
      matrix: "bt709",
      tag: "bt709",
    });
    expect(parseVideoColor("Video: h264, yuvj420p, 64x64")).toMatchObject({
      range: "pc",
      matrix: "bt601",
    });
  });

  it("places each fresh frame by decoded frame number, in RGB, then converts back", () => {
    const filter = patchFilter(
      [5, 40],
      { pixelFormat: "yuvj420p", range: "pc", matrix: "bt601" },
      30,
    );
    expect(filter).toContain(
      "[0:v]setpts=N/(30*TB),scale=in_range=pc:in_color_matrix=bt601,format=gbrp[b0]",
    );
    expect(filter).toContain("between(t\\,0.150000\\,0.183333)");
    expect(filter).toContain("between(t\\,1.316667\\,1.350000)");
    expect(filter).toMatch(
      /scale=out_range=pc:out_color_matrix=bt601,format=yuvj420p\[out\]$/,
    );
  });
});

describe.skipIf(!hasFfmpeg)("damaged frame repair", () => {
  it("replaces a frame the browser captured wrong and keeps the video's colors", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "frame-repair-"));
    try {
      const video = damagedVideo(folder);
      const before = rgbAt(video, 3);
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
          await still("0x202838")(frame, output);
        },
      });
      expect(rendered).toEqual([5]);
      expect(repaired).toEqual([5]);
      expect(await findIsolatedFrames(ffmpeg, video)).toEqual([]);
      // The repaired frame has the scene's real color, not a washed-out one,
      // and the untouched frames keep theirs.
      for (const [got, want] of [
        [rgbAt(video, 5), [0x20, 0x28, 0x38]],
        [rgbAt(video, 3), before],
      ])
        got.forEach((v, i) =>
          expect(Math.abs(v - want[i])).toBeLessThanOrEqual(3),
        );
      const info = execFileSync(
        ffmpeg
          .replace("ffmpeg-installer", "ffprobe-installer")
          .replace(/ffmpeg$/, "ffprobe"),
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=pix_fmt,color_range,nb_frames",
          "-of",
          "compact",
          video,
        ],
      ).toString();
      expect(info).toContain("pix_fmt=yuvj420p");
      expect(info).toContain("color_range=pc");
      expect(info).toContain("nb_frames=12");
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
