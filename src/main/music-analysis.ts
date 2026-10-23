import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Jobs } from "./media";
import {
  analyzePcm,
  MUSIC_ANALYSIS_MAX_SECONDS,
  MUSIC_ANALYSIS_SAMPLE_RATE,
  type MusicAnalysis,
} from "../shared/music-analysis";

export type AnalyzeMusicFileOptions = {
  path: string;
  bin: { ffmpeg: string };
  jobs: Jobs;
  duration?: number;
  cacheDirectory?: string;
};

/** Bounded local decode. The temporary PCM is removed on success, error, or cancellation. */
export async function analyzeMusicFile(
  options: AnalyzeMusicFileOptions,
): Promise<MusicAnalysis> {
  const { jobs } = options;
  const seconds =
    options.duration === undefined
      ? MUSIC_ANALYSIS_MAX_SECONDS
      : Math.min(MUSIC_ANALYSIS_MAX_SECONDS, options.duration);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw Error("Audio analysis requires a positive media duration");
  return jobs.run(
    "music-analysis",
    `Analyzing ${path.basename(options.path)}`,
    async (job) => {
      const checkCancelled = () => {
        if (job.state === "cancelled") throw Error("Cancelled");
      };
      const base = options.cacheDirectory ?? os.tmpdir();
      await mkdir(base, { recursive: true });
      checkCancelled();
      const directory = await mkdtemp(path.join(base, "cutline-rhythm-"));
      try {
        checkCancelled();
        const pcm = path.join(directory, "audio.f32");
        await jobs.exec(
          options.bin.ffmpeg,
          [
            "-y",
            "-nostdin",
            "-v",
            "error",
            "-i",
            options.path,
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            String(MUSIC_ANALYSIS_SAMPLE_RATE),
            "-t",
            String(seconds),
            "-f",
            "f32le",
            pcm,
          ],
          job,
        );
        checkCancelled();
        const info = await stat(pcm);
        const maxBytes =
          (Math.ceil(seconds * MUSIC_ANALYSIS_SAMPLE_RATE) +
            MUSIC_ANALYSIS_SAMPLE_RATE) *
          4;
        if (!info.size || info.size % 4 || info.size > maxBytes)
          throw Error(
            "Decoded audio exceeded the analysis limit or contains no audio samples",
          );
        checkCancelled();
        jobs.update(job, {
          progress: 0.7,
          message: "Finding the rhythm and audio envelope",
        });
        const buffer = await readFile(pcm);
        checkCancelled();
        // Copy explicitly so float decoding is independent of host byte order or Buffer alignment.
        const count = Math.min(
          buffer.length / 4,
          Math.floor(seconds * MUSIC_ANALYSIS_SAMPLE_RATE),
        );
        const samples = new Float32Array(count);
        for (let i = 0; i < count; i++) samples[i] = buffer.readFloatLE(i * 4);
        const analysis = analyzePcm(samples, MUSIC_ANALYSIS_SAMPLE_RATE);
        checkCancelled();
        return analysis;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
