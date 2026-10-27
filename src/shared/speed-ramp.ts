/**
 * A speed ramp plays one clip at several speeds in a row: the "velocity
 * edit" of TikTok and Reels. The clip is cut into pieces that stay
 * contiguous in the source, each with its own speed, so nothing repeats and
 * nothing is skipped. Segments are measured in source seconds, the same
 * seconds a transcript or a music analysis gives, and the last segment may
 * be left out to keep the rest of the clip at its current speed.
 */
export type SpeedRampSegment = { seconds: number; speed: number };

export const speedRampPresets = [
  {
    id: "slow-fast-slow",
    name: "Slow, fast, slow",
    description:
      "Half speed in, a 2.5x rush through the middle, half speed out: the classic velocity edit.",
    shares: [
      { share: 0.25, speed: 0.5 },
      { share: 0.5, speed: 2.5 },
      { share: 0.25, speed: 0.5 },
    ],
  },
  {
    id: "fast-slow",
    name: "Fast, then slow",
    description: "Rush through the first part at 3x, then land at half speed.",
    shares: [
      { share: 0.6, speed: 3 },
      { share: 0.4, speed: 0.5 },
    ],
  },
  {
    id: "slow-fast",
    name: "Slow, then fast",
    description: "Half speed to begin, then a 3x rush to the end.",
    shares: [
      { share: 0.4, speed: 0.5 },
      { share: 0.6, speed: 3 },
    ],
  },
  {
    id: "hold-rush",
    name: "Hold, then rush",
    description:
      "Normal speed for the first moment, then 4x through the rest: a quick way to show a long process.",
    shares: [
      { share: 0.15, speed: 1 },
      { share: 0.85, speed: 4 },
    ],
  },
] as const;
export type SpeedRampPresetId = (typeof speedRampPresets)[number]["id"];

/** A preset's segments for a clip that plays `sourceSeconds` of its source. */
export function speedRampPresetSegments(
  id: SpeedRampPresetId,
  sourceSeconds: number,
): SpeedRampSegment[] {
  const preset = speedRampPresets.find((item) => item.id === id);
  if (!preset) throw Error("Choose a supported speed ramp.");
  return preset.shares.map(({ share, speed }) => ({
    seconds: Number((sourceSeconds * share).toFixed(4)),
    speed,
  }));
}

/**
 * The pieces a ramp cuts a clip into: timeline start and length in frames,
 * where each begins in the source, and its speed. Returns an explanation
 * instead when the segments do not fit the clip.
 */
export function speedRampPlan(
  clip: { duration: number; speed: number; sourceIn: number },
  segments: SpeedRampSegment[],
  fps: number,
) {
  const sourceSeconds = (clip.duration * clip.speed) / fps;
  const total = segments.reduce((sum, s) => sum + s.seconds, 0);
  if (!segments.length) throw Error("A speed ramp needs at least one segment.");
  for (const s of segments) {
    if (!(s.seconds > 0)) throw Error("Each ramp segment needs a positive length in source seconds.");
    if (!(s.speed >= 0.1 && s.speed <= 8))
      throw Error("Ramp speeds run from 0.1x to 8x.");
  }
  if (total > sourceSeconds + 1e-6)
    throw Error(
      `The ramp covers ${total.toFixed(2)} s of source but this clip plays only ${sourceSeconds.toFixed(2)} s. Shorten the segments or leave the last one out.`,
    );
  const list = [...segments];
  const rest = sourceSeconds - total;
  if (rest > 0.5 / fps) list.push({ seconds: rest, speed: clip.speed });
  const pieces: {
    start: number;
    duration: number;
    sourceIn: number;
    sourceSeconds: number;
    speed: number;
  }[] = [];
  let start = 0,
    at = clip.sourceIn;
  for (const s of list) {
    const duration = Math.max(1, Math.round((s.seconds / s.speed) * fps));
    pieces.push({
      start,
      duration,
      sourceIn: Number(at.toFixed(6)),
      sourceSeconds: s.seconds,
      speed: s.speed,
    });
    start += duration;
    at += s.seconds;
  }
  return { pieces, frames: start, shift: start - clip.duration };
}
