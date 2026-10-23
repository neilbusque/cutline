import { animatedValue } from "./animation";
import { clipFadeEnvelope } from "./transitions";
import type { Clip, Project, Rhythm } from "./model";
import { playsForward } from "./timeline";

export type MusicBinding = {
  clip: Clip;
  rhythm: Rhythm;
  muted: boolean;
  fps: number;
  /** Every piece of the same music on the same track, the bound clip included. */
  pieces?: Clip[];
};
export function musicBindings(p: Project): Map<string, MusicBinding> {
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  const tracks = new Map(p.tracks.map((t) => [t.id, t]));
  const bindings = new Map<string, MusicBinding>();
  // A split or a pause cut leaves one song in several clips; a pulse bound to
  // any of them follows the song across all of them.
  const pieces = new Map<string, Clip[]>();
  for (const clip of p.clips) {
    const rhythm = clip.assetId && assets.get(clip.assetId)?.rhythm;
    if (clip.kind !== "audio" || !rhythm) continue;
    const key = `${clip.trackId}\n${clip.assetId}`;
    const group = pieces.get(key) ?? [];
    group.push(clip);
    pieces.set(key, group);
    bindings.set(clip.id, {
      clip,
      rhythm,
      muted: !!tracks.get(clip.trackId)?.muted,
      fps: p.fps,
      pieces: group,
    });
  }
  return bindings;
}
const covers = (clip: Clip, frame: number) =>
  frame >= clip.start && frame < clip.start + clip.duration;
/** Uses project time so trimming, seeking, and exporting keep the same musical phase. */
export function musicResponse(
  target: Clip,
  timelineFrame: number,
  binding?: MusicBinding,
) {
  const reactive = target.musicReactive;
  if (!reactive || !binding || binding.muted || reactive.amount === 0) return 0;
  const { rhythm, fps } = binding;
  const clip = covers(binding.clip, timelineFrame)
    ? binding.clip
    : binding.pieces?.find((piece) => covers(piece, timelineFrame));
  // Beats and energy are measured on the music played forward.
  if (!clip || !playsForward(clip)) return 0;
  const local = timelineFrame - clip.start;
  const time = clip.sourceIn + (local / fps) * clip.speed;
  if (time > rhythm.duration) return 0;
  let signal = 0;
  if (reactive.mode === "energy") {
    const index = time / rhythm.envelope.step;
    if (
      !Number.isFinite(index) ||
      index < 0 ||
      index >= rhythm.envelope.values.length
    )
      return 0;
    const i = Math.floor(index),
      fraction = index - i;
    const a = rhythm.envelope.values[i] ?? 0;
    signal = a + ((rhythm.envelope.values[i + 1] ?? a) - a) * fraction;
  } else {
    // First beat whose time is greater than the current source sample.
    let low = 0,
      high = rhythm.beats.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rhythm.beats[mid].time <= time + (clip.speed / fps) * 0.51)
        low = mid + 1;
      else high = mid;
    }
    const beat = rhythm.beats[low - 1];
    if (beat) {
      const elapsed = Math.max(0, ((time - beat.time) / clip.speed) * fps);
      if (elapsed < reactive.releaseFrames)
        signal =
          beat.strength * Math.pow(1 - elapsed / reactive.releaseFrames, 2);
    }
  }
  // The pulse amount is independent of mix level, so quiet music under dialogue
  // can still drive the artwork. Muting and zero volume stop it completely.
  const audible =
    (animatedValue(clip, "volume", local) > 0 ? 1 : 0) *
    clipFadeEnvelope(clip, local);
  if (reactive.mode === "beat" && rhythm.envelope.values.length) {
    const energy =
      rhythm.envelope.values[Math.floor(time / rhythm.envelope.step)] ?? 0;
    signal *= Math.min(1, energy * 4);
  }
  return Math.max(0, Math.min(1, signal * audible));
}
export function reactiveVisual(
  target: Clip,
  timelineFrame: number,
  binding?: MusicBinding,
) {
  const response = musicResponse(target, timelineFrame, binding);
  const r = target.musicReactive;
  return {
    scale: r && r.style !== "glow" ? 1 + response * r.amount * 0.22 : 1,
    glow: r && r.style !== "scale" ? response * r.amount * 48 : 0,
  };
}

/** Accent-only response leaves the composition's canvas and reading position steady. */
export function reactiveClipVisual(
  target: Clip,
  timelineFrame: number,
  binding?: MusicBinding,
) {
  return target.musicReactive?.scope === "accents"
    ? { scale: 1, glow: 0 }
    : reactiveVisual(target, timelineFrame, binding);
}
