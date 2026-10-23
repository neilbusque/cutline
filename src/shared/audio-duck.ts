import type { Clip, Project } from "./model";
import { playsForward } from "./timeline";

/** Speech that music ducks under, in frames of the ducked clip. */
export type DuckRange = { start: number; end: number };
export type DuckingOptions = {
  /** Volume outside speech. */
  level: number;
  /** Volume under speech. */
  ducked: number;
  /** Frames the volume takes to go down, ending where speech starts. */
  attack: number;
  /** Frames the volume takes to come back up after speech. */
  release: number;
  /**
   * Extra frames of silence that still stay ducked. Ranges closer than
   * attack + release + bridge merge, so the music never pumps between phrases.
   */
  bridge?: number;
  /**
   * When speech ends too close to the clip's end for a full release, stay
   * ducked to the end instead of swelling back up in a frame or two.
   */
  holdToEnd?: boolean;
};

/** Ranges sorted and merged wherever their keys would run into each other. */
function mergeRanges(ranges: DuckRange[], gap: number) {
  const merged: DuckRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const current = merged.at(-1);
    if (current && range.start - current.end < gap)
      current.end = Math.max(current.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Volume keys for a clip of `duration` frames that hold `level` and dip to
 * `ducked` under each range: down over `attack` frames before the speech,
 * held through it, and back up over `release` frames after it. Frames are
 * clip-relative (the caller adds the clip's animationOffset). Auto Reel's
 * music bed and the audio.duck edit action share this curve.
 */
export function duckingKeys(
  duration: number,
  ranges: DuckRange[],
  options: DuckingOptions,
): Clip["keyframes"] {
  const { level, ducked, attack, release } = options;
  const last = duration - 1;
  const keys = new Map<number, number>([
    [0, level],
    [last, level],
  ]);
  for (const range of mergeRanges(
    ranges,
    attack + release + (options.bridge ?? 0),
  )) {
    const start = Math.max(0, range.start),
      end = Math.min(last, range.end);
    if (start > last || end < 0) continue;
    keys.set(Math.max(0, start - attack), level);
    keys.set(start, ducked);
    keys.set(end, ducked);
    if (end + release <= last) keys.set(end + release, level);
    else if (options.holdToEnd) keys.set(last, ducked);
  }
  return [...keys]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, value]) => ({
      property: "volume" as const,
      frame,
      value,
      easing: "ease-in-out" as const,
    }));
}

export type DuckRequest = {
  musicClipId: string;
  speechClipIds: string[];
  /** Duck under each spoken phrase (default) or under each clip's whole span. */
  by?: "words" | "clips";
  /** How far the music goes down under speech, in decibels. */
  depthDb?: number;
  attackFrames?: number;
  releaseFrames?: number;
  /** Volume outside speech; defaults to the clip's current level. */
  level?: number;
};

const MAX_CLIP_KEYS = 2000;
/** Bracketed tags such as [music] are not speech. */
const spoken = (word: { text: string; start: number; end: number }) =>
  Number.isFinite(word.start) &&
  Number.isFinite(word.end) &&
  word.end > word.start &&
  !!word.text.trim() &&
  !/^\s*\[[^\]]*\]\s*$/.test(word.text);
const round = (value: number) => Math.round(value * 10000) / 10000;

/**
 * The music clip's keyframes with a ducking curve under the chosen speech
 * clips: under each spoken phrase from the transcript, or under each clip's
 * whole span. Earlier volume keys are replaced so ducking again with a new
 * depth starts from the same level; other keys are kept.
 */
export function duckClipVolume(project: Project, request: DuckRequest) {
  const fps = project.fps;
  const music = project.clips.find((clip) => clip.id === request.musicClipId);
  if (!music) throw Error(`Clip ${request.musicClipId} is missing.`);
  if ((music.kind !== "audio" && music.kind !== "video") || !music.assetId)
    throw Error(
      "Duck an audio or video clip: musicClipId must be a placed audio or video clip.",
    );
  const warnings: string[] = [];
  const earlier = music.keyframes.filter((key) => key.property === "volume");
  const level =
    request.level ??
    (earlier.length
      ? Math.max(...earlier.map((key) => key.value))
      : music.volume);
  const ducked = round(level * 10 ** ((request.depthDb ?? -14) / 20));
  const attack = request.attackFrames ?? Math.max(1, Math.round(fps * 0.2));
  const release = request.releaseFrames ?? Math.max(1, Math.round(fps * 0.3));
  const by = request.by ?? "words";
  const ranges: DuckRange[] = [];
  for (const id of new Set(request.speechClipIds)) {
    const speech = project.clips.find((clip) => clip.id === id);
    if (!speech) throw Error(`Clip ${id} is missing.`);
    if (speech.id === music.id)
      throw Error("A clip cannot duck under itself; name the voice clips.");
    if ((speech.kind !== "audio" && speech.kind !== "video") || !speech.assetId)
      throw Error(
        `Clip ${speech.id} is not an audio or video clip; speechClipIds must name the voice clips.`,
      );
    const end = speech.start + speech.duration;
    // Reversed or held speech doesn't follow its transcript.
    const forward = playsForward(speech);
    const words =
      by === "words" && forward
        ? (project.assets
            .find((asset) => asset.id === speech.assetId)
            ?.words?.filter(spoken) ?? [])
        : [];
    if (by === "words" && !forward)
      warnings.push(
        `Clip ${speech.id} plays backwards or holds a frame, so the music ducks under the whole clip.`,
      );
    else if (by === "words" && !words.length)
      warnings.push(
        `Clip ${speech.id} has no transcript, so the music ducks under the whole clip. Transcribe it to duck only under speech.`,
      );
    if (!words.length) {
      ranges.push({ start: speech.start, end });
      continue;
    }
    // Source seconds to timeline frames, inside the part of the source the clip plays.
    const frameAt = (seconds: number) =>
      speech.start + ((seconds - speech.sourceIn) / speech.speed) * fps;
    for (const word of words) {
      const start = Math.max(speech.start, Math.floor(frameAt(word.start)));
      const stop = Math.min(end, Math.ceil(frameAt(word.end)));
      if (stop > start) ranges.push({ start, end: stop });
    }
  }
  const local = ranges
    .map((range) => ({
      start: range.start - music.start,
      end: range.end - music.start,
    }))
    .filter((range) => range.end > 0 && range.start < music.duration);
  if (!local.length)
    throw Error(
      `None of the speech plays while clip ${music.id} does. Check the clip IDs and their timing.`,
    );
  const others = music.keyframes.filter((key) => key.property !== "volume");
  let bridge = Math.max(0, Math.round(fps * 0.25));
  let keys = duckingKeys(music.duration, local, {
    level,
    ducked,
    attack,
    release,
    bridge,
    holdToEnd: true,
  });
  // A long interview has more phrases than a clip has keys: hold the duck
  // through longer pauses until the curve fits.
  while (keys.length + others.length > MAX_CLIP_KEYS) {
    // Once every pause is bridged, nothing more can merge.
    if (bridge >= music.duration)
      throw Error(
        `Clip ${music.id} has too many other keyframes for a ducking curve. Remove some of its keys, then duck again.`,
      );
    bridge = Math.max(fps, bridge * 2);
    keys = duckingKeys(music.duration, local, {
      level,
      ducked,
      attack,
      release,
      bridge,
      holdToEnd: true,
    });
  }
  if (bridge > Math.round(fps * 0.25))
    warnings.push(
      `Pauses shorter than ${((attack + release + bridge) / fps).toFixed(1)} seconds stay ducked, so the curve fits the clip's key limit.`,
    );
  if (earlier.length)
    warnings.push(
      `Replaced ${earlier.length} earlier volume keys on clip ${music.id}.`,
    );
  if (level === 0)
    warnings.push(
      `Clip ${music.id} is silent (volume 0); set level to hear the music.`,
    );
  const offset = music.animationOffset;
  const keyframes = [
    ...others,
    ...keys.map((key) => ({ ...key, frame: key.frame + offset })),
  ].sort((a, b) => a.frame - b.frame);
  return { keyframes, warnings, level, ducked };
}
