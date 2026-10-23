import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Asset, Job } from "../shared/model";
import type { Jobs, Media } from "./media";
import { manualBeatGrid } from "../shared/music-sync";

export type MusicStyle = "clean" | "bold" | "cinematic";
type MusicOptions = {
  folder: string;
  seconds: number;
  style?: MusicStyle;
  media: Media;
  jobs: Jobs;
  job?: Job;
};
const sampleRate = 48000,
  channels = 2,
  version = "instrumental-v1";
const profiles = {
  clean: {
    bpm: 104,
    chords: [
      [48, 55, 60, 64, 71],
      [45, 52, 57, 60, 67],
      [41, 48, 53, 57, 64],
      [43, 50, 55, 59, 64],
    ],
    bars: 1,
    pad: 0.12,
    pluck: 0.12,
    kick: 0.1,
    snare: 0.025,
    hat: 0.012,
    name: "Gentle momentum",
  },
  bold: {
    bpm: 116,
    chords: [
      [45, 52, 57, 60, 64],
      [41, 48, 53, 57, 60],
      [48, 55, 60, 64, 67],
      [43, 50, 55, 59, 62],
    ],
    bars: 1,
    pad: 0.085,
    pluck: 0.15,
    kick: 0.14,
    snare: 0.045,
    hat: 0.022,
    name: "Bright momentum",
  },
  cinematic: {
    bpm: 82,
    chords: [
      [45, 52, 57, 60, 67],
      [41, 48, 53, 57, 64],
      [48, 55, 60, 64, 71],
      [43, 50, 55, 59, 66],
    ],
    bars: 2,
    pad: 0.17,
    pluck: 0.07,
    kick: 0.045,
    snare: 0,
    hat: 0.006,
    name: "Quiet horizons",
  },
} satisfies Record<
  MusicStyle,
  {
    bpm: number;
    chords: number[][];
    bars: number;
    pad: number;
    pluck: number;
    kick: number;
    snare: number;
    hat: number;
    name: string;
  }
>;
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const ease = (value: number) => {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
};

export function musicCacheName(seconds: number, style: MusicStyle) {
  const key = createHash("sha256")
    .update(`${version}:${style}:${Math.round(seconds * sampleRate)}`)
    .digest("hex")
    .slice(0, 16);
  return `cutline-original-${style}-${key}.wav`;
}

export function wavHeader(frames: number) {
  const header = Buffer.alloc(44),
    bytes = frames * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

/** Render an original arrangement: evolving chords, plucked arpeggios, bass and restrained percussion. */
async function synthesize(
  file: string,
  seconds: number,
  style: MusicStyle,
  jobs: Jobs,
  job: Job,
) {
  const frames = Math.round(seconds * sampleRate),
    profile = profiles[style],
    beatLength = 60 / profile.bpm,
    chordLength = beatLength * 4 * profile.bars;
  const chords = profile.chords.map((chord) => chord.map(hz));
  const handle = await open(file, "wx");
  let random = 0x1256abcd,
    previousNoise = 0;
  const noise = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return (random >>> 0) / 2147483648 - 1;
  };
  const padAt = (frequencies: number[], t: number) => {
    let left = 0,
      right = 0;
    for (let i = 1; i < frequencies.length; i++) {
      const frequency = frequencies[i],
        voice =
          (Math.sin(2 * Math.PI * frequency * t) +
            0.18 * Math.sin(4 * Math.PI * frequency * t)) /
          1.18;
      const drift = 0.9 + 0.1 * Math.sin(t * (0.35 + i * 0.09) + i);
      const pan = i % 2 ? 0.72 : 0.28;
      left += voice * drift * (1 - pan);
      right += voice * drift * pan;
    }
    return [left / 2, right / 2];
  };
  try {
    await handle.writeFile(wavHeader(frames));
    const blockSize = 12000;
    for (let first = 0; first < frames; first += blockSize) {
      if (job.state === "cancelled") throw Error("Music generation cancelled");
      const count = Math.min(blockSize, frames - first),
        buffer = Buffer.allocUnsafe(count * 4);
      for (let offset = 0; offset < count; offset++) {
        const t = (first + offset) / sampleRate;
        const chordIndex = Math.floor(t / chordLength) % chords.length,
          current = chords[chordIndex],
          previous = chords[(chordIndex + chords.length - 1) % chords.length];
        const chordTime = t % chordLength,
          blend = first + offset === 0 ? 1 : ease(chordTime / 0.35);
        const currentPad = padAt(current, t),
          previousPad = blend < 1 && t > 0.01 ? padAt(previous, t) : currentPad;
        let left =
          (currentPad[0] * blend + previousPad[0] * (1 - blend)) * profile.pad;
        let right =
          (currentPad[1] * blend + previousPad[1] * (1 - blend)) * profile.pad;
        const eighth = beatLength / 2,
          step = Math.floor(t / eighth),
          noteTime = t % eighth;
        const pattern = [1, 2, 3, 4, 2, 3, 1, 4],
          note = current[pattern[step % 8]] * 2;
        const pluckEnvelope =
          (1 - Math.exp(-noteTime * 150)) *
          Math.exp(-noteTime * (style === "cinematic" ? 5 : 9));
        const pluck =
          (Math.sin(2 * Math.PI * note * t) +
            0.22 * Math.sin(4 * Math.PI * note * t) +
            0.06 * Math.sin(6 * Math.PI * note * t)) *
          pluckEnvelope *
          profile.pluck;
        const pan = step % 2 ? 0.7 : 0.3;
        left += pluck * (1 - pan);
        right += pluck * pan;
        const beat = Math.floor(t / beatLength),
          beatTime = t % beatLength;
        const bassEnvelope =
          (1 - Math.exp(-beatTime * 100)) * Math.exp(-beatTime * 2.5);
        const bass =
          Math.sin(2 * Math.PI * current[0] * t) * bassEnvelope * 0.075;
        left += bass * 0.7;
        right += bass * 0.7;
        const kickActive = style === "bold" || beat % 2 === 0;
        const kick = kickActive
          ? Math.sin(
              2 *
                Math.PI *
                (45 * beatTime +
                  55 * 0.025 * (1 - Math.exp(-beatTime / 0.025))),
            ) *
            Math.exp(-beatTime * 20) *
            profile.kick
          : 0;
        const white = noise(),
          high = white - previousNoise;
        previousNoise = white;
        const snare =
          beat % 4 === 1 || beat % 4 === 3
            ? white * Math.exp(-beatTime * 32) * profile.snare
            : 0;
        const hat = high * Math.exp(-noteTime * 85) * profile.hat;
        left += kick + snare + hat * 0.65;
        right += kick + snare + hat * 0.35;
        const fade =
          ease(t / Math.min(1.2, seconds * 0.2)) *
          ease((seconds - t) / Math.min(2.2, seconds * 0.25));
        // Soft limiting leaves headroom for narration even before the timeline music-volume control.
        buffer.writeInt16LE(
          Math.round(Math.tanh(left * 1.35) * 0.8 * fade * 32767),
          offset * 4,
        );
        buffer.writeInt16LE(
          Math.round(Math.tanh(right * 1.35) * 0.8 * fade * 32767),
          offset * 4 + 2,
        );
      }
      await handle.writeFile(buffer);
      jobs.update(job, {
        progress: Math.min(0.85, ((first + count) / frames) * 0.85),
        message: `Composing ${profile.name.toLowerCase()}…`,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    await handle.close();
  }
}

async function isCached(file: string, frames: number) {
  try {
    const details = await stat(file);
    if (details.size !== 44 + frames * 4) return false;
    const handle = await open(file, "r");
    try {
      const bytes = Buffer.alloc(44);
      await handle.read(bytes, 0, 44, 0);
      return bytes.equals(wavHeader(frames));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** Uses only local synthesis. An optional supplied job is updated but never completed/cancelled by this helper. */
export async function createMusicBed(options: MusicOptions): Promise<Asset> {
  const { folder, media, jobs } = options,
    style = options.style ?? "clean",
    seconds = options.seconds;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 180)
    throw Error("Choose a music duration between 1 and 180 seconds.");
  if (!Object.hasOwn(profiles, style))
    throw Error("Choose a supported music style.");
  const render = async (job: Job) => {
    const check = () => {
      if (job.state === "cancelled") throw Error("Music generation cancelled");
    };
    check();
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, musicCacheName(seconds, style)),
      temporary = file + "." + randomUUID() + ".part";
    try {
      if (!(await isCached(file, Math.round(seconds * sampleRate)))) {
        await synthesize(temporary, seconds, style, jobs, job);
        check();
        await rename(temporary, file);
      }
      check();
      jobs.update(job, {
        progress: 0.9,
        message: "Preparing your original music bed…",
      });
      const asset = await media.import(file);
      check();
      if (asset.kind !== "audio")
        throw Error("Generated music could not be imported as audio.");
      // ffprobe reports six decimal places. Preserve the known PCM sample count
      // so a frame-aligned bed is not rounded down by one timeline frame.
      asset.duration = Math.round(seconds * sampleRate) / sampleRate;
      asset.name = `Original music · ${profiles[style].name}`;
      const pcm = await readFile(file);
      check();
      const step = 0.05,
        bins = Math.ceil(asset.duration / step),
        values: number[] = [];
      for (let bin = 0; bin < bins; bin++) {
        const first = Math.floor(bin * step * sampleRate),
          last = Math.min(
            Math.floor((bin + 1) * step * sampleRate),
            (pcm.length - 44) / 4,
          );
        let energy = 0;
        for (let i = first; i < last; i++) {
          const left = pcm.readInt16LE(44 + i * 4) / 32768,
            right = pcm.readInt16LE(46 + i * 4) / 32768;
          energy += (left * left + right * right) / 2;
        }
        values.push(last > first ? Math.sqrt(energy / (last - first)) : 0);
      }
      const peak = Math.max(0.00001, ...values);
      asset.rhythm = {
        ...manualBeatGrid({
          bpm: profiles[style].bpm,
          duration: asset.duration,
        }),
        source: "generated",
        envelope: { step, values: values.map((v) => Math.min(1, v / peak)) },
      };
      await writeFile(
        file + ".credits.txt",
        `${asset.name}\nCreated locally by Cutline using original procedural synthesis.\nArrangement: evolving chords, plucked arpeggios, bass, and light percussion.\nNo external recordings, samples, or stock-music service were used.\nDuration: ${seconds} seconds. Style: ${style}.\n`,
      );
      return asset;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };
  return options.job
    ? render(options.job)
    : jobs.run("music", "Composing original music…", render);
}
