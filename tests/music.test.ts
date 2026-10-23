import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMusicBed, musicCacheName } from "../src/main/music";
import { Jobs } from "../src/main/media";

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "cutline-music-test-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});
const media = {
  import: vi.fn(async (file: string) => ({
    id: "music-asset",
    name: "audio",
    path: file,
    kind: "audio",
    duration: 3,
    hasAudio: true,
  })),
};

describe("original music generation", () => {
  it("writes a stereo PCM instrumental with fades, dynamics, no clipping, and source notes", async () => {
    const asset = await createMusicBed({
      folder,
      seconds: 3,
      style: "clean",
      media: media as any,
      jobs: new Jobs(() => {}),
    });
    const wav = await readFile(asset.path);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.length).toBe(44 + 3 * 48000 * 4);
    let peak = 0,
      energy = 0,
      stereoDifference = 0;
    for (let i = 44; i < wav.length; i += 4) {
      const left = wav.readInt16LE(i) / 32768,
        right = wav.readInt16LE(i + 2) / 32768;
      peak = Math.max(peak, Math.abs(left), Math.abs(right));
      energy += left * left;
      stereoDifference += Math.abs(left - right);
    }
    expect(peak).toBeGreaterThan(0.07);
    expect(peak).toBeLessThan(0.8);
    expect(Math.sqrt(energy / (3 * 48000))).toBeGreaterThan(0.02);
    expect(stereoDifference).toBeGreaterThan(50);
    expect(wav.readInt16LE(44)).toBe(0);
    expect(Math.abs(wav.readInt16LE(wav.length - 4))).toBeLessThan(5);
    expect(asset.name).toContain("Original music");
    expect(await readFile(asset.path + ".credits.txt", "utf8")).toContain(
      "No external recordings",
    );
  });

  it("reuses the stable rendered file and produces distinct arrangements by style", async () => {
    const jobs = new Jobs(() => {});
    const first = await createMusicBed({
      folder,
      seconds: 3,
      style: "clean",
      media: media as any,
      jobs,
    });
    const modified = (await stat(first.path)).mtimeMs,
      bytes = await readFile(first.path);
    const again = await createMusicBed({
      folder,
      seconds: 3,
      style: "clean",
      media: media as any,
      jobs,
    });
    expect(again.path).toBe(first.path);
    expect((await stat(again.path)).mtimeMs).toBe(modified);
    expect((await readFile(again.path)).equals(bytes)).toBe(true);
    const bold = await createMusicBed({
      folder,
      seconds: 3,
      style: "bold",
      media: media as any,
      jobs,
    });
    expect((await readFile(bold.path)).equals(bytes)).toBe(false);
    expect(musicCacheName(3, "clean")).not.toBe(musicCacheName(4, "clean"));
  });

  it("keeps exact PCM duration when ffprobe decimal rounding would shorten a frame-aligned music bed", async () => {
    const seconds = 385 / 30;
    const roundedProbe = {
      import: vi.fn(async (file: string) => ({
        id: "music-frame-test",
        name: "audio",
        path: file,
        kind: "audio",
        duration: 12.833333,
        hasAudio: true,
      })),
    };
    const asset = await createMusicBed({
      folder,
      seconds,
      style: "bold",
      media: roundedProbe as any,
      jobs: new Jobs(() => {}),
    });
    const wav = await readFile(asset.path);
    expect((wav.length - 44) / 4 / 48000).toBe(seconds);
    expect(asset.duration).toBe(seconds);
    expect(Math.floor(asset.duration * 30 + 1e-7)).toBe(385);
  }, 15000);

  it("cancels generation without committing a partial WAV and rejects unbounded durations", async () => {
    let jobs: Jobs;
    jobs = new Jobs((job) => {
      if (job.kind === "music" && job.progress > 0 && job.state === "running")
        jobs.cancel(job.id);
    });
    await expect(
      createMusicBed({ folder, seconds: 3, media: media as any, jobs }),
    ).rejects.toThrow("cancelled");
    expect(await readdir(folder)).toEqual([]);
    await expect(
      createMusicBed({ folder, seconds: Infinity, media: media as any, jobs }),
    ).rejects.toThrow("duration");
    await expect(
      createMusicBed({ folder, seconds: 10000, media: media as any, jobs }),
    ).rejects.toThrow("duration");
  });
});
