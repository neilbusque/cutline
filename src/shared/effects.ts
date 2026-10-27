import type { Clip } from "./model";
import { motionEase, settleBezier } from "./motion";
export const videoLooks = [
  "none",
  "cinematic",
  "warm",
  "cool",
  "mono",
  "vintage",
  "vivid",
  "dreamy",
  "moody",
  "sunset",
  "teal-orange",
  "bleach",
  "studio",
  "soft-film",
  "crisp-mono",
] as const;
/** Starting strengths, not an automatic exposure or skin-tone match. */
export const lookStrength = (look: (typeof videoLooks)[number]) =>
  look === "studio"
    ? 0.7
    : look === "soft-film"
      ? 0.6
      : look === "crisp-mono"
        ? 0.85
        : 1;
export const cameraMoves = [
  "none",
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
  "handheld",
  "slow-orbit",
  "punch-in",
  "punch-out",
  "pop-in",
  "shake",
  "breathe",
] as const;
/** Finishing overlays: what each adds, for the Effects panel and the assistant guide. */
export const overlayNames = {
  none: "None",
  "film-grain": "Film grain",
  "light-leak": "Light leak",
  vhs: "VHS scan",
  halftone: "Halftone",
  letterbox: "Letterbox",
  "flash-in": "Flash cut",
  glitch: "Glitch",
  halation: "Halation",
} as const;
export const overlayDescriptions: Record<keyof typeof overlayNames, string> = {
  none: "The picture as shot.",
  "film-grain": "Fine moving grain, like film stock.",
  "light-leak": "A warm drifting glow from one edge.",
  vhs: "Scan lines and a rolling band, like a worn tape.",
  halftone: "A print-like dot pattern.",
  letterbox: "Black bars top and bottom for a cinematic frame.",
  "flash-in": "A white pop on the clip's first frames: hides a hard cut without a transition.",
  glitch: "Short bursts of digital tearing and color separation.",
  halation: "A soft warm glow bleeding from the highlights.",
};
export const cameraMoveDescriptions: Record<(typeof cameraMoves)[number], string> = {
  none: "Holds still.",
  "zoom-in": "A slow push in over the shot.",
  "zoom-out": "A slow pull back over the shot.",
  "pan-left": "Drifts left while slightly zoomed.",
  "pan-right": "Drifts right while slightly zoomed.",
  handheld: "A gentle continuous handheld sway.",
  "slow-orbit": "A slow tilt and drift, like orbiting the subject.",
  "punch-in": "Snaps 18% tighter in a fifth of a second: the jump-cut punch.",
  "punch-out": "Starts tight and snaps back to full frame.",
  "pop-in": "Springs up from 82% to full size, for screenshots and inserts.",
  shake: "A camera knock on the first frames that settles within half a second.",
  breathe: "A slow in-and-out breath of scale.",
};
export const textAnimations = [
  { preset: "spring", label: "Make it pop", group: "Essential" },
  { preset: "slide", label: "Slide in", group: "Essential" },
  { preset: "fade", label: "Quietly bold", group: "Essential" },
  { preset: "typewriter", label: "One word.", group: "Essential" },
  { preset: "word-reveal", label: "Tell your story", group: "Essential" },
  { preset: "lower-third", label: "Your name", group: "Essential" },
  { preset: "callout", label: "Look here", group: "Essential" },
  { preset: "blur-in", label: "Into focus", group: "Expressive" },
  { preset: "wipe", label: "A fresh reveal", group: "Expressive" },
  { preset: "flip", label: "New perspective", group: "Expressive" },
  { preset: "stagger", label: "Every letter", group: "Expressive" },
  { preset: "rise", label: "On the rise", group: "Expressive" },
  { preset: "pulse", label: "Feel the beat", group: "Expressive" },
  { preset: "glow", label: "After hours", group: "Expressive" },
  { preset: "swing", label: "A little attitude", group: "Expressive" },
] as const;
export function filterFor(
  c: Pick<
    Clip,
    "look" | "effectAmount" | "brightness" | "contrast" | "saturation" | "blur"
  > &
    Partial<Pick<Clip, "invert">>,
) {
  const a = c.effectAmount ?? 1;
  if (
    (!c.look || c.look === "none" || a === 0) &&
    (c.brightness ?? 1) === 1 &&
    (c.contrast ?? 1) === 1 &&
    (c.saturation ?? 1) === 1 &&
    !(c.blur ?? 0) &&
    !(c.invert ?? 0)
  )
    return "none";
  const looks: Record<string, [number, number, number, number, number]> = {
    none: [1, 1, 1, 0, 0],
    cinematic: [0.96, 1.22, 0.82, 0, 0],
    warm: [1.04, 1.06, 1.15, 0.25, 0],
    cool: [1, 1.08, 0.9, 0, 16],
    mono: [1, 1.12, 0, 0, 0],
    vintage: [1.08, 0.88, 0.65, 0.5, 0],
    vivid: [1.02, 1.15, 1.5, 0, 0],
    dreamy: [1.12, 0.88, 0.86, 0.12, 0],
    moody: [0.82, 1.3, 0.7, 0.08, -8],
    sunset: [1.08, 1.1, 1.25, 0.38, -12],
    "teal-orange": [1.02, 1.22, 1.3, 0.15, -18],
    bleach: [1.06, 1.48, 0.35, 0.05, 0],
    studio: [1.02, 1.055, 1.035, 0, 0],
    "soft-film": [1.035, 0.95, 0.9, 0.045, 0],
    "crisp-mono": [1.015, 1.18, 0, 0, 0],
  };
  const [b, k, s, sepia, hue] = looks[c.look ?? "none"];
  return `brightness(${(c.brightness ?? 1) * (1 + (b - 1) * a)}) contrast(${(c.contrast ?? 1) * (1 + (k - 1) * a)}) saturate(${(c.saturation ?? 1) * (1 + (s - 1) * a)}) sepia(${sepia * a}) hue-rotate(${hue * a}deg) blur(${c.blur ?? 0}px)${c.invert ? ` invert(${c.invert})` : ""}`;
}
/** Shots this long or longer get the full camera move; shorter shots move less. */
export const fullCameraMoveSeconds = 6;
/**
 * Camera moves cover the whole shot, or the whole of a shot that was split, so
 * a cut never restarts the move. A drift's size follows the shot length, at
 * most 3% zoom per second up to the full 18%, so short inserts drift gently
 * instead of lunging. Drifts start and finish at half speed, and a punch-in
 * snaps in over a fifth of a second.
 */
export function cameraTransform(
  c: Pick<Clip, "cameraMotion" | "duration">,
  frame: number,
  {
    fps = 30,
    span,
  }: { fps?: number; span?: { phase: number; length: number } } = {},
) {
  const length = Math.max(1, span?.length ?? c.duration);
  const at = frame + (span?.phase ?? 0);
  const t = Math.min(1, Math.max(0, at / Math.max(1, length - 1)));
  const reach = Math.min(1, length / fps / fullCameraMoveSeconds);
  // Half linear, half sine: no dead stop at a cut, no mechanical constant speed.
  const glide = 0.5 * t + 0.25 * (1 - Math.cos(Math.PI * t));
  switch (c.cameraMotion) {
    case "zoom-in":
      return `scale(${1 + 0.18 * reach * glide})`;
    case "zoom-out":
      return `scale(${1 + 0.18 * reach * (1 - glide)})`;
    case "pan-left":
      return `scale(${1 + 0.16 * reach}) translateX(${(5 - 10 * glide) * reach}%)`;
    case "pan-right":
      return `scale(${1 + 0.16 * reach}) translateX(${(-5 + 10 * glide) * reach}%)`;
    case "slow-orbit":
      return `scale(${1 + 0.12 * reach}) rotate(${(-2 + 4 * glide) * reach}deg) translateX(${(2 - 4 * glide) * reach}%)`;
    case "punch-in": {
      const snap = Math.max(1, Math.round(fps * 0.2));
      return `scale(${1 + 0.18 * motionEase(at / snap, "cubic-bezier", settleBezier)})`;
    }
    case "punch-out": {
      const snap = Math.max(1, Math.round(fps * 0.2));
      return `scale(${1.18 - 0.18 * motionEase(at / snap, "cubic-bezier", settleBezier)})`;
    }
    case "pop-in": {
      const frames = Math.max(1, Math.round(fps * 0.4));
      return `scale(${0.82 + 0.18 * motionEase(Math.min(1, at / frames), "spring")})`;
    }
    case "shake": {
      // A knock at the cut: about 10 Hz (a 15 Hz shake would alias to a
      // left-right flicker at 30 fps), gone within half a second, the same
      // at any frame rate. A little zoom keeps the edges covered.
      const seconds = at / fps;
      const amount = Math.exp(-seconds * 7);
      if (amount < 0.01) return "scale(1.05)";
      const s = seconds * 30;
      return `scale(1.05) translate(${(Math.sin(s * 2.1 + 0.9) * 14 * amount).toFixed(2)}px,${(Math.cos(s * 2.7) * 9 * amount).toFixed(2)}px) rotate(${(Math.sin(s * 1.7 + 0.4) * 0.7 * amount).toFixed(3)}deg)`;
    }
    case "breathe":
      return `scale(${1.06 + 0.04 * Math.sin(t * Math.PI * 2)})`;
    case "handheld": {
      // The same shake speed at any frame rate.
      const s = (at / fps) * 30;
      return `scale(1.04) translate(${Math.sin(s * 0.13) * 3}px,${Math.cos(s * 0.17) * 2}px) rotate(${Math.sin(s * 0.09) * 0.25}deg)`;
    }
    default:
      return "none";
  }
}
