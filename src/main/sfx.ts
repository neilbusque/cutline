import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Asset } from "../shared/model";
import {
  soundAccentKinds,
  soundAccentNames,
  soundAccentSeconds,
  type SoundAccentKind,
} from "../shared/sound-accents";
import { wavHeader } from "./music";

const sampleRate = 48000,
  version = "accent-v1";

/** A fixed-seed noise source, so every Mac renders the same file. */
function noiseSource(seed: number) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2147483648 - 1;
  };
}
/** A resonant two-pole low-pass whose cutoff can move every sample. */
function resonantLowPass(q: number) {
  let low = 0,
    band = 0;
  return (input: number, cutoff: number) => {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, sampleRate / 6)) / sampleRate);
    low += f * band;
    const high = input - low - band / q;
    band += f * high;
    return { low, band };
  };
}
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * Renders one accent as stereo float samples. Each is a few simple parts:
 * filtered noise with a moving cutoff for air, decaying sines for pitched
 * hits, and envelopes shaped so the attack lands on the first frame.
 */
export function renderSoundAccent(kind: SoundAccentKind): Float32Array[] {
  const seconds = soundAccentSeconds[kind];
  const count = Math.round(seconds * sampleRate);
  const left = new Float32Array(count),
    right = new Float32Array(count);
  const noise = noiseSource(0x5eed0 + soundAccentKinds.indexOf(kind));
  const filter = resonantLowPass(kind === "riser" ? 3 : 2.2);
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate,
      u = t / seconds;
    let a = 0,
      b = 0;
    switch (kind) {
      case "whoosh": {
        // Air: noise through a low-pass that opens as it passes, loudest
        // just before the middle, sweeping from left to right.
        const cutoff = 350 + 4200 * u * u;
        const env = Math.sin(Math.PI * Math.min(1, u / 0.9)) ** 1.6;
        const air = filter(noise(), cutoff).low * env * 1.6;
        a = air * (1 - 0.6 * u);
        b = air * (0.4 + 0.6 * u);
        break;
      }
      case "impact": {
        // A low thump that drops in pitch, a sub under it, and a short
        // click so it still reads on a phone speaker.
        const pitch = 46 + 90 * Math.exp(-t * 14);
        const thump = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 9);
        const sub = Math.sin(2 * Math.PI * 38 * t) * Math.exp(-t * 6) * 0.5;
        const click = filter(noise(), 2600).band * Math.exp(-t * 180) * 0.9;
        const tail = Math.min(1, (seconds - t) / 0.05);
        a = b = (thump * 0.85 + sub + click) * tail;
        break;
      }
      case "pop": {
        // A quick downward chirp with a tiny tick on its first millisecond.
        const pitch = 320 + 700 * Math.exp(-t * 60);
        const chirp = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 32);
        const tick = noise() * Math.exp(-t * 900) * 0.35;
        a = b = (chirp + tick) * Math.min(1, (seconds - t) / 0.02);
        break;
      }
      case "click": {
        // A 3 ms burst of bright noise and a damped 2.2 kHz ring.
        const burst = filter(noise(), 5200).band * Math.exp(-t * 700) * 1.4;
        const ring = Math.sin(2 * Math.PI * 2200 * t) * Math.exp(-t * 160) * 0.4;
        a = b = (burst + ring) * Math.min(1, (seconds - t) / 0.01);
        break;
      }
      case "riser": {
        // Noise and a low tone that both climb, louder every moment, cut
        // off cleanly at the end so the reveal lands on silence.
        const cutoff = 200 + 6000 * u * u;
        const air = filter(noise(), cutoff).low * (0.15 + 0.85 * u * u) * 1.5;
        const tone =
          Math.sin(2 * Math.PI * (160 + 520 * u * u) * t) * 0.25 * u;
        const end = Math.min(1, (seconds - t) / 0.03);
        a = (air * 0.9 + tone) * end;
        b = (air * 1.0 + tone) * end;
        break;
      }
      case "ding": {
        // A small bell: a fundamental and a bright inharmonic partial.
        const attack = Math.min(1, t / 0.003);
        const bell =
          Math.sin(2 * Math.PI * 1760 * t) * Math.exp(-t * 5) * 0.7 +
          Math.sin(2 * Math.PI * 1760 * 2.76 * t) * Math.exp(-t * 11) * 0.3;
        a = b = bell * attack * Math.min(1, (seconds - t) / 0.04);
        break;
      }
    }
    left[i] = a;
    right[i] = b;
  }
  // Peak at -3 dBFS, so a 50% clip volume sits well under speech.
  let peak = 0.0001;
  for (let i = 0; i < count; i++)
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const gain = 0.708 / peak;
  for (let i = 0; i < count; i++) {
    left[i] = clamp(left[i] * gain);
    right[i] = clamp(right[i] * gain);
  }
  return [left, right];
}

export function soundAccentFileName(kind: SoundAccentKind) {
  return `cutline-${kind}-${version}.wav`;
}

/** The file's PCM as a 16-bit stereo WAV buffer. */
export function soundAccentWav(kind: SoundAccentKind) {
  const [left, right] = renderSoundAccent(kind);
  const frames = left.length;
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(Math.round(left[i] * 32767), i * 4);
    pcm.writeInt16LE(Math.round(right[i] * 32767), i * 4 + 2);
  }
  return Buffer.concat([wavHeader(frames), pcm]);
}

/**
 * Makes (once) and imports an accent. The file is deterministic, so the
 * same kind always has the same name and length, and a project reopened on
 * another Mac can be rebuilt from scratch.
 */
export async function createSoundAccent(options: {
  kind: SoundAccentKind;
  folder: string;
  media: { import: (file: string) => Promise<Asset> };
}): Promise<Asset> {
  const { kind, folder, media } = options;
  if (!soundAccentKinds.includes(kind))
    throw Error("Choose a supported sound accent.");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, soundAccentFileName(kind));
  const wav = soundAccentWav(kind);
  const cached = await stat(file)
    .then((info) => info.size === wav.length)
    .catch(() => false);
  if (!cached) {
    const temporary = file + "." + randomUUID() + ".part";
    try {
      await writeFile(temporary, wav);
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    await writeFile(
      file + ".credits.txt",
      `${soundAccentNames[kind]} accent\nMade locally by Cutline from scratch (procedural synthesis). No recordings or samples were used.\n`,
    );
  }
  const asset = await media.import(file);
  if (asset.kind !== "audio")
    throw Error("The sound accent could not be imported as audio.");
  asset.name = `${soundAccentNames[kind]} accent`;
  asset.duration = soundAccentSeconds[kind];
  return asset;
}
