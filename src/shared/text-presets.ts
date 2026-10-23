import type { Clip, Project } from "./model";
import {
  entranceFadeBezier,
  entranceMoveBezier,
  motionEase,
  type MotionBezier,
} from "./motion";

/**
 * Frames of one continuous animation that come before this clip, and the
 * animation's whole length. A clip that was split keeps playing the same
 * entrance, exit and camera move across the cut.
 */
export type AnimationSpan = { phase: number; length: number };

export const presetCurves = {
  /** Movement and scale settle quickly and softly. */
  move: entranceMoveBezier,
  /** Opacity rises a little more gently than movement. */
  fade: entranceFadeBezier,
  /** Exits hold, then accelerate away. */
  exit: [0.32, 0, 0.67, 0] as MotionBezier,
} as const;

const entrancePresets = new Set<Clip["preset"]>([
  "fade",
  "slide",
  "spring",
  "typewriter",
  "word-reveal",
  "lower-third",
  "callout",
  "blur-in",
  "wipe",
  "flip",
  "stagger",
  "rise",
  "swing",
]);

const clamp01 = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
export const easeCurve = (t: number, bezier: MotionBezier) =>
  motionEase(clamp01(t), "cubic-bezier", bezier);

export type PresetTiming = {
  /** Frame within the continuous animation. */
  at: number;
  length: number;
  /** Entrance and exit length in frames. */
  window: number;
  /** Linear entrance progress, for steady cadences such as typing. */
  progress: number;
  /** Eased entrance for movement, rotation and reveals. */
  move: number;
  /** Eased entrance opacity. */
  fade: number;
  /** Short opacity ramp for presets that mainly move or scale. */
  appear: number;
  /** A settling spring that overshoots about 13% before resting at 1. */
  pop: number;
  /** Linear exit progress. */
  exit: number;
  /** Exit progress that holds, then accelerates away. */
  exitEased: number;
};

/**
 * Entrance and exit share the clip. When a clip has both, each gets at most
 * half of it, so every clip reaches full strength for at least one frame.
 */
export function presetTiming(
  c: Pick<Clip, "preset" | "exitAnimation" | "animationFrames" | "duration">,
  frame: number,
  span?: AnimationSpan,
): PresetTiming {
  const length = Math.max(1, span?.length ?? c.duration);
  const at = frame + (span?.phase ?? 0);
  const entrance = entrancePresets.has(c.preset);
  const exits = !!c.exitAnimation && c.exitAnimation !== "none";
  const room = length - 1;
  if (room < 1 || (entrance && exits && room < 2))
    // No room for an entrance and an exit: show the text plainly.
    return {
      at,
      length,
      window: 1,
      progress: 1,
      move: 1,
      fade: 1,
      appear: 1,
      pop: 1,
      exit: 0,
      exitEased: 0,
    };
  const requested = Math.max(1, c.animationFrames ?? 18);
  const window = Math.max(
    1,
    Math.min(requested, entrance && exits ? Math.floor(room / 2) : room),
  );
  const progress = clamp01(at / window);
  const exit = exits ? clamp01((at - (room - window)) / window) : 0;
  return {
    at,
    length,
    window,
    progress,
    move: easeCurve(progress, presetCurves.move),
    fade: easeCurve(progress, presetCurves.fade),
    appear: easeCurve(progress / 0.45, presetCurves.fade),
    pop: motionEase(progress, "spring"),
    exit,
    exitEased: easeCurve(exit, presetCurves.exit),
  };
}

/** Opacity of an entrance preset; the exit is applied separately. */
export function presetEntranceOpacity(
  preset: Clip["preset"],
  timing: PresetTiming,
) {
  switch (preset) {
    case "fade":
    case "blur-in":
    case "rise":
    case "flip":
      return timing.fade;
    case "spring":
    case "callout":
    case "swing":
    case "slide":
    case "lower-third":
      return timing.appear;
    default:
      return 1;
  }
}

/** Short eased fades per word; the last word settles as the entrance ends. */
export function wordRevealOpacity(
  index: number,
  count: number,
  timing: Pick<PresetTiming, "at" | "window">,
) {
  const fade = Math.max(1, Math.round(timing.window * 0.4));
  const step = count > 1 ? Math.max(0, timing.window - fade) / (count - 1) : 0;
  return easeCurve((timing.at - index * step) / fade, presetCurves.fade);
}

/** Each letter fades and rises on its own short eased curve. */
export function staggerLetter(
  index: number,
  count: number,
  timing: Pick<PresetTiming, "at" | "window">,
) {
  const a = timing.window;
  const local = clamp01(
    (timing.at - (index * a * 0.6) / Math.max(1, count)) /
      Math.max(1, a * 0.4),
  );
  return {
    opacity: easeCurve(local, presetCurves.fade),
    rise: 1 - easeCurve(local, presetCurves.move),
  };
}

/** Typed characters stay in place; the rest keeps its room in the layout. */
export function typewriterSplit(text: string, progress: number) {
  const characters = Array.from(text);
  const typed = Math.ceil(characters.length * clamp01(progress));
  return {
    typed: characters.slice(0, typed).join(""),
    hidden: characters.slice(typed).join(""),
  };
}

/** Runs of letters and runs of spaces, so words wrap only at spaces. */
export function wordRuns(text: string) {
  const runs: { text: string; space: boolean; start: number }[] = [];
  let index = 0;
  for (const part of text.split(/(\s+)/u)) {
    const length = Array.from(part).length;
    if (length)
      runs.push({ text: part, space: /^\s+$/u.test(part), start: index });
    index += length;
  }
  return runs;
}

function continues(a: Clip, b: Clip) {
  return (
    a.kind === b.kind &&
    a.assetId === b.assetId &&
    a.preset === b.preset &&
    a.motionId === b.motionId &&
    a.cameraMotion === b.cameraMotion &&
    (a.kind !== "text" || a.text === b.text) &&
    !b.transition
  );
}

/**
 * A split leaves two pieces end to end whose animation offsets continue.
 * Those pieces play one entrance, one exit and one camera move. Moving,
 * trimming or editing either piece breaks the chain, and each piece then
 * animates on its own again.
 */
export function animationSpans(
  p: Pick<Project, "clips">,
): Map<string, AnimationSpan> {
  const key = (trackId: string, start: number, offset: number) =>
    `${trackId}\u0000${start}\u0000${offset}`;
  const at = new Map<string, Clip>();
  for (const c of p.clips)
    at.set(key(c.trackId, c.start, c.animationOffset ?? 0), c);
  const next = new Map<string, Clip>(),
    linked = new Set<string>();
  for (const c of p.clips) {
    const candidate = at.get(
      key(
        c.trackId,
        c.start + c.duration,
        (c.animationOffset ?? 0) + c.duration,
      ),
    );
    if (
      candidate &&
      candidate !== c &&
      !linked.has(candidate.id) &&
      continues(c, candidate)
    ) {
      next.set(c.id, candidate);
      linked.add(candidate.id);
    }
  }
  const spans = new Map<string, AnimationSpan>();
  for (const head of p.clips) {
    if (linked.has(head.id) || !next.has(head.id)) continue;
    const chain = [head];
    for (
      let link = next.get(head.id);
      link && chain.length <= p.clips.length;
      link = next.get(link.id)
    )
      chain.push(link);
    const length = chain.reduce((sum, c) => sum + c.duration, 0);
    let phase = 0;
    for (const c of chain) {
      spans.set(c.id, { phase, length });
      phase += c.duration;
    }
  }
  return spans;
}
