import type { Clip, Project } from "./model";
import { trimClip } from "./timeline";
export const transitionNames = {
  crossfade: "Crossfade",
  black: "Fade through black",
  "slide-left": "Slide left",
  "slide-right": "Slide right",
  wipe: "Wipe",
} as const;
export type TransitionKind = keyof typeof transitionNames;
const visual = (c: Clip) => c.kind === "video" || c.kind === "image";
export function previousClip(p: Project, c: Clip) {
  let previous: Clip | undefined;
  for (const x of p.clips)
    if (
      x.trackId === c.trackId &&
      x.start < c.start &&
      visual(x) &&
      (!previous || x.start > previous.start)
    )
      previous = x;
  return previous;
}
export function activeTransition(p: Project, c: Clip) {
  const t = c.transition;
  if (!t || !visual(c)) return undefined;
  const previous = previousClip(p, c);
  if (!previous || previous.id !== t.fromId) return undefined;
  const overlap = previous.start + previous.duration - c.start;
  if (overlap <= 1 || overlap >= c.duration || overlap >= previous.duration)
    return undefined;
  return { ...t, frames: Math.min(t.frames, overlap), previous };
}
/** Moves this clip and everything after it on its track, with their generated captions. */
function rippleTrack(p: Project, c: Clip, shift: number) {
  const start = c.start,
    moved = new Set<string>();
  for (const x of p.clips)
    if (x.trackId === c.trackId && x.start >= start) {
      x.start += shift;
      moved.add(x.id);
    }
  for (const x of p.clips)
    if (x.captionSourceId && moved.has(x.captionSourceId) && !moved.has(x.id))
      x.start = Math.max(0, x.start + shift);
}
// Timeline overlap uses existing source frames; no frozen frames or hidden source handles.
export function setTransition(
  p: Project,
  c: Clip,
  kind: TransitionKind | "none",
  frames: number,
) {
  const active = activeTransition(p, c);
  if (kind === "none") {
    if (active)
      rippleTrack(
        p,
        c,
        active.previous.start + active.previous.duration - c.start,
      );
    delete c.transition;
    return;
  }
  const previous = previousClip(p, c);
  if (
    !visual(c) ||
    !previous ||
    (!active && previous.start + previous.duration !== c.start)
  )
    throw Error(
      "Place this clip directly after another video or image on the same track.",
    );
  const limit = Math.floor(Math.min(c.duration, previous.duration) / 2);
  if (limit < 2) throw Error("These clips are too short for a transition.");
  const length = Math.max(2, Math.min(frames, limit));
  rippleTrack(p, c, previous.start + previous.duration - length - c.start);
  c.transition = { kind, frames: length, fromId: previous.id };
  endOutgoingCaptions(p, previous, c);
}

/**
 * Over a crossfade the outgoing clip's captions end where the incoming
 * clip's first caption starts, so two phrases never show at once.
 */
function endOutgoingCaptions(p: Project, previous: Clip, c: Clip) {
  const next = Math.min(
    ...p.clips.filter((x) => x.captionSourceId === c.id).map((x) => x.start),
  );
  if (!Number.isFinite(next)) return;
  p.clips = p.clips.flatMap((caption) => {
    if (
      caption.captionSourceId !== previous.id ||
      caption.start + caption.duration <= next
    )
      return [caption];
    if (caption.start >= next) return [];
    const cut = { ...caption, ...trimClip(p, caption, "right", next) };
    // A cut that leaves none of its words would be a blank caption.
    return caption.words.length && !cut.words.length ? [] : [cut];
  });
}
// Zero velocity at either end makes the first and last visible steps gentle.
// The same curve is shared by preview, export and complementary audio ramps.
export function smoothProgress(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
export function transitionProgress(frame: number, frames: number) {
  return smoothProgress(frame / Math.max(1, frames - 1));
}

/** Fade lengths are intervals between source frames, not extra timeline handles. */
export function boundedClipFades(
  c: Pick<Clip, "duration" | "fadeIn" | "fadeOut">,
) {
  const available = Math.max(0, c.duration - 1);
  // There is no room for a visible middle frame in a two-frame in/out fade.
  if (available < 2 && c.fadeIn && c.fadeOut) return { fadeIn: 0, fadeOut: 0 };
  let fadeIn = Math.min(available, Math.max(0, c.fadeIn));
  let fadeOut = Math.min(available, Math.max(0, c.fadeOut));
  if (fadeIn + fadeOut > available) {
    // Preserve the requested balance while guaranteeing an actual fully visible
    // source frame. Oversized fades must never make short cutaways translucent.
    fadeIn = Math.max(
      1,
      Math.min(
        available - 1,
        Math.round((available * fadeIn) / (fadeIn + fadeOut)),
      ),
    );
    fadeOut = available - fadeIn;
  }
  return { fadeIn, fadeOut };
}

export function clipFadeEnvelope(
  c: Pick<Clip, "duration" | "fadeIn" | "fadeOut">,
  frame: number,
) {
  if (frame < 0 || frame >= c.duration) return 0;
  const { fadeIn, fadeOut } = boundedClipFades(c);
  return Math.min(
    fadeIn ? smoothProgress(frame / fadeIn) : 1,
    fadeOut ? smoothProgress((c.duration - 1 - frame) / fadeOut) : 1,
  );
}

/** A short dissolve with most of the shot held clear, at any project frame rate. */
export function overlayFadeFrames(duration: number, fps: number) {
  return Math.max(
    0,
    Math.min(Math.round(fps * 0.27), Math.floor((duration - 1) * 0.2)),
  );
}
