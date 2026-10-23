import { mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Jobs } from "../src/main/media";
import { analyzeMusicFile } from "../src/main/music-analysis";
import {
  analyzePcm,
  MUSIC_ANALYSIS_MAX_SECONDS,
} from "../src/shared/music-analysis";

const SAMPLE_RATE = 11025;
function pulses(times: number[], duration = 12, amplitude = 0.8) {
  const samples = new Float32Array(Math.round(duration * SAMPLE_RATE));
  for (const time of times) {
    const start = Math.round(time * SAMPLE_RATE);
    for (let n = 0; n < SAMPLE_RATE * 0.065 && start + n < samples.length; n++)
      samples[start + n] +=
        amplitude *
        Math.sin((n / SAMPLE_RATE) * 2 * Math.PI * 110) *
        Math.exp((-n / SAMPLE_RATE) * 65);
  }
  return samples;
}
const grid = (bpm: number, offset = 0.37, duration = 12) =>
  Array.from(
    { length: Math.floor(((duration - offset) * bpm) / 60) },
    (_, i) => offset + (i * 60) / bpm,
  );

describe("local PCM rhythm analysis", () => {
  it.each([72, 90, 120, 150, 180, 220])(
    "detects a steady %i BPM pulse train and its source offset",
    (bpm) => {
      const times = grid(bpm);
      const analysis = analyzePcm(pulses(times), SAMPLE_RATE);
      expect(analysis.bpm).toBeCloseTo(bpm, 0);
      expect(analysis.confidence).toBeGreaterThan(0.85);
      expect(analysis.beats.length).toBe(times.length);
      analysis.beats.forEach((beat, i) =>
        expect(Math.abs(beat.time - times[i])).toBeLessThan(0.021),
      );
      expect(analysis.duration).toBe(12);
    },
  );

  it("detects quiet pulses relative to their own energy", () => {
    const analysis = analyzePcm(pulses(grid(120), 12, 0.0002), SAMPLE_RATE);
    expect(analysis.bpm).toBeCloseTo(120, 0);
    expect(analysis.envelope.values.some((value) => value === 1)).toBe(true);
  });

  it("keeps compact, bounded normalized RMS bins and does not mutate PCM", () => {
    const samples = pulses([0.15, 0.65], 1);
    const original = samples.slice();
    const analysis = analyzePcm(samples, SAMPLE_RATE);
    expect(analysis.envelope.step).toBe(0.05);
    expect(analysis.envelope.values).toHaveLength(20);
    expect(
      analysis.envelope.values.every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      ),
    ).toBe(true);
    expect(samples).toEqual(original);
    expect(analysis.envelope.values[0]).toBe(0);
    expect(analysis.envelope.values[3]).toBeGreaterThan(0.9);
  });

  it("reports silence and invalid PCM safely without a guessed BPM", () => {
    for (const samples of [
      new Float32Array(),
      new Float32Array(SAMPLE_RATE * 3),
      new Float32Array([NaN, Infinity, -Infinity]),
    ]) {
      const analysis = analyzePcm(samples, SAMPLE_RATE);
      expect(analysis.bpm).toBeUndefined();
      expect(analysis.confidence).toBe(0);
      expect(analysis.beats).toEqual([]);
      expect(analysis.envelope.values.every((value) => value === 0)).toBe(true);
    }
    for (const rate of [0, NaN, Infinity, -1])
      expect(() => analyzePcm(new Float32Array(10), rate)).toThrow();
  });

  it("returns isolated and irregular onsets without calling them a stable tempo", () => {
    for (const times of [
      [0.7, 2.4, 7.2],
      [0.3, 0.9, 1.65, 2.05, 3.1, 3.42, 4.4, 5.2, 6.33, 7.0, 8.23, 9.63, 10.1],
    ]) {
      const analysis = analyzePcm(pulses(times), SAMPLE_RATE);
      expect(analysis.beats.length).toBe(times.length);
      expect(analysis.bpm).toBeUndefined();
      expect(analysis.confidence).toBeLessThan(0.8);
    }
  });

  it("does not claim one BPM for a passage that changes tempo", () => {
    const times = [...grid(120, 0.2, 6), ...grid(150, 6.2, 12)];
    const analysis = analyzePcm(pulses(times), SAMPLE_RATE);
    expect(analysis.beats.length).toBe(times.length);
    expect(analysis.bpm).toBeUndefined();
  });

  it("does not infer repeated beats from a continuous tone", () => {
    const samples = Float32Array.from(
      { length: SAMPLE_RATE * 8 },
      (_, i) => Math.sin((i / SAMPLE_RATE) * Math.PI * 2 * 110) * 0.5,
    );
    const analysis = analyzePcm(samples, SAMPLE_RATE);
    expect(analysis.bpm).toBeUndefined();
    expect(analysis.beats.length).toBeLessThan(4);
  });

  it("sanitizes invalid samples while preserving the remaining rhythm", () => {
    const samples = pulses(grid(120));
    samples[0] = NaN;
    samples[3] = Infinity;
    samples[7] = -Infinity;
    const analysis = analyzePcm(samples, SAMPLE_RATE);
    expect(analysis.bpm).toBeCloseTo(120, 0);
    expect(
      analysis.beats.every(
        (beat) => Number.isFinite(beat.time) && Number.isFinite(beat.strength),
      ),
    ).toBe(true);
  });

  it("keeps the observed onsets and tempo when occasional beats are absent", () => {
    const times = grid(120).filter((_, i) => i !== 7 && i !== 17);
    const analysis = analyzePcm(pulses(times), SAMPLE_RATE);
    expect(analysis.bpm).toBeCloseTo(120, 0);
    expect(analysis.beats.length).toBe(times.length);
  });

  it("does not invent a rhythm for stationary noise", () => {
    let seed = 19;
    const samples = Float32Array.from({ length: SAMPLE_RATE * 12 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.15;
    });
    expect(analyzePcm(samples, SAMPLE_RATE).bpm).toBeUndefined();
  });

  it("caps analyzed duration and envelope storage at twenty minutes", () => {
    const analysis = analyzePcm(
      new Float32Array((MUSIC_ANALYSIS_MAX_SECONDS + 2) * 1000),
      1000,
    );
    expect(analysis.duration).toBe(MUSIC_ANALYSIS_MAX_SECONDS);
    expect(analysis.envelope.values).toHaveLength(
      MUSIC_ANALYSIS_MAX_SECONDS * 20,
    );
  });

  it.each([120, 180, 220])(
    "fits a %i BPM grid across twenty minutes without accumulating hop drift",
    (bpm) => {
      const times = grid(bpm, 0.37, MUSIC_ANALYSIS_MAX_SECONDS);
      const analysis = analyzePcm(
        pulses(times, MUSIC_ANALYSIS_MAX_SECONDS),
        SAMPLE_RATE,
      );
      expect(analysis.bpm).toBeCloseTo(bpm, 1);
      expect(analysis.confidence).toBeGreaterThan(0.95);
      expect(analysis.beats.length).toBe(times.length);
      for (const i of [0, Math.floor(times.length / 2), times.length - 1])
        expect(Math.abs(analysis.beats[i].time - times[i])).toBeLessThan(0.021);
      expect(analysis.envelope.values).toHaveLength(24000);
    },
  );

  it("rejects an averaged BPM when long steady sections use different tempos", () => {
    const times = [...grid(120, 0.2, 60), ...grid(150, 60.2, 120)];
    const analysis = analyzePcm(pulses(times, 120), SAMPLE_RATE);
    expect(analysis.beats.length).toBe(times.length);
    expect(analysis.bpm).toBeUndefined();
  });
});

describe("bounded FFmpeg analysis jobs", () => {
  const ffmpeg = path.resolve(
    "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
  );
  it.runIf(
    process.platform === "darwin" &&
      process.arch === "arm64" &&
      existsSync(ffmpeg),
  )("analyzes a real stereo WAV through the bundled decoder", async () => {
    const cache = await mkdtemp(
      path.join(os.tmpdir(), "cutline-analysis-test-"),
    );
    const rate = 48000;
    const duration = 10;
    const times = grid(150, 0.63, duration);
    const wav = Buffer.alloc(44 + rate * duration * 4);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 4, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    for (const time of times) {
      const start = Math.round(time * rate);
      for (let n = 0; n < rate * 0.065 && start + n < rate * duration; n++) {
        const sample = Math.round(
          20000 *
            Math.sin((n / rate) * 2 * Math.PI * 110) *
            Math.exp((-n / rate) * 65),
        );
        wav.writeInt16LE(sample, 44 + (start + n) * 4);
        wav.writeInt16LE(sample, 46 + (start + n) * 4);
      }
    }
    const file = path.join(cache, "stereo.wav");
    await writeFile(file, wav);
    try {
      const analysis = await analyzeMusicFile({
        path: file,
        bin: { ffmpeg },
        jobs: new Jobs(() => {}),
        duration,
        cacheDirectory: cache,
      });
      expect(analysis.bpm).toBeCloseTo(150, 0);
      expect(analysis.duration).toBe(10);
      expect(analysis.beats.length).toBe(times.length);
      expect(Math.abs(analysis.beats[0].time - 0.63)).toBeLessThan(0.025);
      expect(await readdir(cache)).toEqual(["stereo.wav"]);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("decodes the audio stream with explicit bounds and removes temporary PCM", async () => {
    const cache = await mkdtemp(
      path.join(os.tmpdir(), "cutline-analysis-test-"),
    );
    const jobs = new Jobs(() => {});
    const samples = pulses(grid(120), 12);
    const buffer = Buffer.alloc(samples.length * 4);
    samples.forEach((sample, i) => buffer.writeFloatLE(sample, i * 4));
    const exec = vi
      .spyOn(jobs, "exec")
      .mockImplementation(async (_bin, args) => {
        expect(args).toEqual(
          expect.arrayContaining([
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "11025",
            "-t",
            "12",
            "-f",
            "f32le",
          ]),
        );
        await writeFile(args.at(-1)!, buffer);
        return { stdout: "", stderr: "" };
      });
    try {
      const analysis = await analyzeMusicFile({
        path: "/audio/music.wav",
        bin: { ffmpeg: "ffmpeg" },
        jobs,
        duration: 12,
        cacheDirectory: cache,
      });
      expect(analysis.bpm).toBeCloseTo(120, 0);
      expect(exec).toHaveBeenCalledOnce();
      expect(Array.from(jobs.jobs.values())[0]).toMatchObject({
        kind: "music-analysis",
        state: "done",
        progress: 1,
      });
      expect(await readdir(cache)).toEqual([]);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("cleans temporary PCM and rejects a cancelled decode", async () => {
    const cache = await mkdtemp(
      path.join(os.tmpdir(), "cutline-analysis-test-"),
    );
    const jobs = new Jobs(() => {});
    vi.spyOn(jobs, "exec").mockImplementation(async (_bin, args, job) => {
      await writeFile(args.at(-1)!, Buffer.alloc(4));
      jobs.cancel(job!.id);
      return { stdout: "", stderr: "" };
    });
    try {
      await expect(
        analyzeMusicFile({
          path: "/audio/music.wav",
          bin: { ffmpeg: "ffmpeg" },
          jobs,
          cacheDirectory: cache,
        }),
      ).rejects.toThrow("Cancelled");
      expect(Array.from(jobs.jobs.values())[0].state).toBe("cancelled");
      expect(await readdir(cache)).toEqual([]);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("rejects oversized output before reading PCM and cleans failed jobs", async () => {
    const cache = await mkdtemp(
      path.join(os.tmpdir(), "cutline-analysis-test-"),
    );
    const jobs = new Jobs(() => {});
    vi.spyOn(jobs, "exec").mockImplementation(async (_bin, args) => {
      await writeFile(args.at(-1)!, "");
      await truncate(args.at(-1)!, SAMPLE_RATE * 4 * 3);
      return { stdout: "", stderr: "" };
    });
    try {
      await expect(
        analyzeMusicFile({
          path: "/audio/music.wav",
          bin: { ffmpeg: "ffmpeg" },
          jobs,
          duration: 1,
          cacheDirectory: cache,
        }),
      ).rejects.toThrow("analysis limit");
      expect(Array.from(jobs.jobs.values())[0].state).toBe("error");
      expect(await readdir(cache)).toEqual([]);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("never asks FFmpeg to decode more than twenty minutes", async () => {
    const cache = await mkdtemp(
      path.join(os.tmpdir(), "cutline-analysis-test-"),
    );
    const jobs = new Jobs(() => {});
    vi.spyOn(jobs, "exec").mockImplementation(async (_bin, args) => {
      expect(args[args.indexOf("-t") + 1]).toBe("1200");
      await writeFile(args.at(-1)!, Buffer.alloc(SAMPLE_RATE * 4));
      return { stdout: "", stderr: "" };
    });
    try {
      const analysis = await analyzeMusicFile({
        path: "/audio/music.wav",
        bin: { ffmpeg: "ffmpeg" },
        jobs,
        duration: 3600,
        cacheDirectory: cache,
      });
      expect(analysis.duration).toBe(1);
      await expect(
        analyzeMusicFile({
          path: "/audio/music.wav",
          bin: { ffmpeg: "ffmpeg" },
          jobs,
          duration: NaN,
        }),
      ).rejects.toThrow("positive media duration");
      expect(await readdir(cache)).toEqual([]);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
