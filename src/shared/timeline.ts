import {
  ClipSchema,
  type Asset,
  type Clip,
  type Project,
  type Track,
} from "./model";

const clipFields = new Set(Object.keys(ClipSchema.shape));

export function compatibleTrack(clip: Pick<Clip, "kind">, track: Track) {
  return (
    track.kind ===
    (clip.kind === "audio"
      ? "audio"
      : clip.kind === "text" || clip.kind === "caption"
        ? "text"
        : "video")
  );
}

/**
 * A clip plays its source forward unless it is reversed or holds a frame.
 * Transcripts, beats and silences are measured on the forward source, so they
 * line up with a clip only when this is true.
 */
export function playsForward(clip: Pick<Clip, "reverse" | "freeze">) {
  return !clip.reverse && !clip.freeze;
}

/**
 * The forward source position, in seconds, at a clip-relative frame. A
 * reversed clip's sourceIn counts from the end of the source, so its position
 * moves from the end of its footage back to the start.
 */
export function sourceSecondsAt(p: Project, clip: Clip, frame: number) {
  const along = clip.freeze
    ? clip.sourceIn
    : clip.sourceIn + (frame / p.fps) * clip.speed;
  if (!clip.reverse) return along;
  const asset = p.assets.find((a) => a.id === clip.assetId);
  return asset ? Math.max(0, asset.duration - along) : along;
}

/**
 * The stretch of a reversed copy a reversed clip plays, in seconds counted
 * from the end of the media, as its sourceIn is.
 */
export function reversedRange(
  clip: Pick<Clip, "sourceIn" | "duration" | "speed" | "freeze">,
  fps: number,
) {
  const length = clip.freeze ? 0 : (clip.duration / fps) * clip.speed;
  return { from: clip.sourceIn, to: clip.sourceIn + length };
}

/**
 * Whether an asset's partial reversed copy holds a stretch, with a frame to
 * spare at each edge so rounding never reads past it. A part that reaches the
 * end or the start of the media holds everything beyond that edge.
 */
export function reversedPartCovers(
  asset: Pick<Asset, "reversedPart" | "reversedSpan" | "duration">,
  range: { from: number; to: number },
  fps: number,
) {
  const span = asset.reversedPart ? asset.reversedSpan : undefined;
  if (!span) return false;
  const spare = 1 / fps;
  return (
    (span.from <= 0 || range.from >= span.from + spare) &&
    (span.to >= asset.duration || range.to + spare <= span.to)
  );
}

/**
 * The part of an asset's backwards copy its reversed clips play, with two
 * seconds of room on each side and rounded out to whole seconds, so trims
 * and small moves reuse the same copy. Undefined when no clip is reversed.
 */
export function reversedRequest(
  project: Pick<Project, "clips" | "fps">,
  asset: Pick<Asset, "id" | "duration">,
) {
  const ranges = project.clips
    .filter((clip) => clip.reverse && clip.assetId === asset.id)
    .map((clip) => reversedRange(clip, project.fps));
  if (!ranges.length) return undefined;
  const from = Math.max(
    0,
    Math.floor(Math.min(...ranges.map((range) => range.from)) - 2),
  );
  const to = Math.min(
    Math.ceil(asset.duration),
    Math.ceil(Math.max(...ranges.map((range) => range.to)) + 2),
  );
  return { from, to: Math.max(from, to) };
}

/** Whether an asset's partial backwards copy holds every reversed clip of it. */
export function reversedPartHolds(
  project: Pick<Project, "clips" | "fps">,
  asset: Pick<Asset, "id" | "reversedPart" | "reversedSpan" | "duration">,
) {
  return project.clips
    .filter((clip) => clip.reverse && clip.assetId === asset.id)
    .every((clip) =>
      reversedPartCovers(asset, reversedRange(clip, project.fps), project.fps),
    );
}

/** The sourceIn that shows the same footage played the other way. */
export function flippedSourceIn(
  clip: Clip,
  sourceDuration: number,
  fps: number,
) {
  const length = clip.freeze ? 0 : (clip.duration / fps) * clip.speed;
  return Math.max(0, sourceDuration - clip.sourceIn - length);
}

/**
 * Resolve a trim to valid source frames, preserving each caption word's visible
 * interval and keeping keyframes on the same footage frames. The result holds
 * only fields this version knows, so it can be sent whole as an update.
 */
export function trimClip(
  p: Project,
  clip: Clip,
  edge: "left" | "right",
  target: number,
): Clip {
  const asset = p.assets.find((a) => a.id === clip.assetId);
  // A held frame keeps showing the same frame however far it is trimmed.
  const bounded = asset && asset.kind !== "image" && !clip.freeze;
  const end = clip.start + clip.duration;
  let start = clip.start,
    length = clip.duration,
    sourceIn = clip.sourceIn;
  if (edge === "left") {
    const earliest = bounded
      ? clip.start - Math.floor((clip.sourceIn * p.fps) / clip.speed + 1e-7)
      : 0;
    start = Math.max(0, earliest, Math.min(end - 1, Math.round(target)));
    length = end - start;
    if (bounded)
      sourceIn = Math.max(
        0,
        clip.sourceIn + ((start - clip.start) * clip.speed) / p.fps,
      );
  } else {
    const available = bounded
      ? Math.max(
          1,
          Math.floor(((asset.duration - sourceIn) * p.fps) / clip.speed + 1e-7),
        )
      : Infinity;
    length = Math.min(available, Math.max(1, Math.round(target) - start));
  }
  const offset = (start - clip.start) / p.fps;
  const words = clip.words
    .map((w) => ({
      ...w,
      start: Math.max(0, w.start - offset),
      end: Math.min(length / p.fps, w.end - offset),
    }))
    .filter((w) => w.end > w.start);
  // Extending the head past the clip's first animated frame: the offset cannot
  // go below zero, so the keys move later instead and stay on their footage.
  // A custom motion's phase lives in its shared design, so such a clip keeps
  // replaying its animation from the new start.
  const phase = clip.animationOffset + start - clip.start;
  const lead =
    phase < 0 && !(clip.preset === "custom" && clip.motionId) ? -phase : 0;
  const trimmed: Clip = {
    ...clip,
    animationOffset: Math.max(0, phase),
    keyframes: lead
      ? clip.keyframes.map((k) => ({ ...k, frame: k.frame + lead }))
      : clip.keyframes,
    start,
    duration: length,
    sourceIn,
    words,
    ...(clip.kind === "caption" && clip.words.length
      ? { text: words.map((w) => w.text).join(" ") }
      : {}),
  };
  for (const key of Object.keys(trimmed))
    if (!clipFields.has(key)) delete (trimmed as Record<string, unknown>)[key];
  return trimmed;
}

/** One SVG path for only the source interval audible in this clip. */
export function audioWaveformPath(
  asset: import("./model").Asset,
  clip: Clip,
  fps: number,
) {
  const wave = asset.waveform;
  // A held frame is silent.
  if (!wave?.length || !asset.duration || clip.freeze) return "";
  const points = 160;
  return Array.from({ length: points }, (_, i) => {
    const along =
      clip.sourceIn + (((i / (points - 1)) * clip.duration) / fps) * clip.speed;
    const source = clip.reverse ? asset.duration - along : along;
    const index = Math.min(
      wave.length - 1,
      Math.max(0, Math.floor((source / asset.duration) * (wave.length - 1))),
    );
    const amplitude = Math.min(1, Math.max(0, wave[index]));
    return `M${i},${(20 - amplitude * 18).toFixed(2)}V${(20 + amplitude * 18).toFixed(2)}`;
  }).join("");
}
