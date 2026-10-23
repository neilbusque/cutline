import type { Clip } from "./model";
import {
  motionEase,
  propertyEase,
  type MotionBezier,
  type MotionEasing,
} from "./motion";
export const animatedProperties = [
  "x",
  "y",
  "scale",
  "rotation",
  "opacity",
  "brightness",
  "contrast",
  "saturation",
  "blur",
  "rgbSplit",
  "invert",
  "volume",
] as const;
export type AnimatedProperty = (typeof animatedProperties)[number];
export const propertyBounds: Record<AnimatedProperty, [number, number]> = {
  x: [-8000, 8000],
  y: [-8000, 8000],
  scale: [0.01, 10],
  rotation: [-3600, 3600],
  opacity: [0, 1],
  brightness: [0.2, 2],
  contrast: [0.2, 2],
  saturation: [0, 2],
  blur: [0, 30],
  rgbSplit: [0, 30],
  invert: [0, 1],
  volume: [0, 2],
};
/** Amounts settle without a bounce; movement, scale and rotation may overshoot. */
const amountProperties = new Set<AnimatedProperty>([
  "opacity",
  "volume",
  "blur",
  "rgbSplit",
  "invert",
]);
export function eased(t: number, easing: string, bezier?: MotionBezier) {
  switch (easing) {
    case "hold":
      return 0;
    case "ease-in":
      return t * t;
    case "ease-out":
      return 1 - (1 - t) ** 2;
    case "ease-in-out":
      return t * t * (3 - 2 * t);
    case "spring":
    case "back":
    case "cubic-bezier":
      return motionEase(t, easing, bezier);
    default:
      return t;
  }
}
const curveCache = new WeakMap<
  Clip["keyframes"],
  Map<AnimatedProperty, Clip["keyframes"]>
>();
function curves(c: Clip) {
  let cached = curveCache.get(c.keyframes);
  if (!cached) {
    cached = new Map();
    for (const k of c.keyframes ?? []) {
      const list = cached.get(k.property) ?? [];
      list.push(k);
      cached.set(k.property, list);
    }
    if (c.keyframes) curveCache.set(c.keyframes, cached);
  }
  return cached;
}
export function animatedValue(
  c: Clip,
  property: AnimatedProperty,
  frame: number,
): number {
  const keys = curves(c).get(property) ?? [];
  const base = c[property] ?? 1;
  if (!keys.length) return base;
  const at = frame + (c.animationOffset ?? 0);
  if (at <= keys[0].frame) return keys[0].value;
  let low = 1,
    high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (keys[mid].frame <= at) low = mid + 1;
    else high = mid;
  }
  if (low === keys.length) return keys[keys.length - 1].value;
  const a = keys[low - 1],
    b = keys[low];
  const t = (at - a.frame) / (b.frame - a.frame);
  const shaped =
    a.easing === "spring" || a.easing === "back"
      ? propertyEase(
          t,
          a.easing as MotionEasing,
          a.bezier,
          amountProperties.has(property),
        )
      : eased(t, a.easing, a.bezier);
  // Overshooting curves stay inside the property's valid range.
  const [min, max] = propertyBounds[property];
  return Math.max(min, Math.min(max, a.value + (b.value - a.value) * shaped));
}
export function evaluatedClip(c: Clip, frame: number): Clip {
  if (!c.keyframes?.length) return c;
  const result = { ...c };
  for (const property of curves(c).keys())
    result[property] = animatedValue(c, property, frame);
  return result;
}
/** Text for cutline_effects_guide; agent-guide.ts adds value lists generated from the validators. */
export const effectsGuide = {
  workflow:
    "Inspect first. Make each requested change one cutline_edit transaction with the current projectId and revision; everything stays editable and undoable. Then check it: cutline_preview with image true returns rendered frames from the same renderer as the MP4 export, and frames [..] returns several moments as one contact sheet. Look at the images before saying how something looks, and never say an export finished without checking cutline_jobs.",
  keyframes:
    "clip.keyframe {clipId, property, frame, value, easing?, bezier?, remove?}: frame is clip-relative (0 is the clip's first frame) and values are absolute, not deltas. Clip easings: linear, ease-in, ease-out, ease-in-out, hold, spring, back, cubic-bezier (with bezier [x1,y1,x2,y2], x in 0..1, y in -2..3); easing belongs to the outgoing segment. Spring and back overshoot position, scale and rotation; opacity, volume and blur take the same timing without the bounce. A curve overrides the static property; remove its keys to return to the static value. Split and trim keep the animation phase through animationOffset, so leave animationOffset alone unless you mean to retime.",
  properties: propertyBounds,
  compositing:
    "clip.update {clipId, patch}: scale, blendMode (normal, multiply, screen, overlay, lighten, darken), mask (none, ellipse, rounded), cornerRadius, shadowBlur, shadowColor, shadowX, shadowY, crop, look, effectAmount, overlay, rgbSplit (0..30 clip pixels), invert (0..1). rgbSplit and invert work on footage, text and native motion, default to 0, and accept clip.keyframe curves. Track index 0 is the top layer and blend modes composite over the tracks below. Masks also apply to text.",
  motionLayers:
    "Build graphics with motion.scene {scene, at} or motion.shape {shape, at}, then edit their layers: motion.layer.update {motionId, layer, patch}, motion.layer.add {motionId, definition}, motion.keyframe {motionId, layer, property, frame, value, easing?, bezier?}. In the same edit, $ref.motion names the motion of a scene or shape created with ref. Layer x/y keys are offsets from the layer's static position; other keys override static values. The last layer draws on top. loop is none, cycle or ping-pong with loopFrames. Text layers animate with textAnimation and staggerFrames. motion.put {motion, clipId?} writes a whole definition; prefer scenes plus layer edits.",
  recipes: {
    promoAccent:
      "For a short RGB accent at 30 fps: clip.keyframe rgbSplit 10 at frame 0 with hold easing, then 0 at frame 4. Scale timing to fps, settle to 0 for readable holds. For a deliberate color cut, key invert 0 with hold easing then 1 at the cut; avoid repeated flashing. These effects never create 3D objects or replace source footage.",
    gentlePush:
      "clip.keyframe scale 1 at frame 0 and 1.12 at the last frame, ease-in-out.",
    titleReveal:
      "opacity 0 to 1 and y from 60 px below its resting position over 12 to 20 frames, ease-out (or motion easing cubic-bezier with bezier [0.22, 1, 0.36, 1]). Optionally blur 12 to 0. Use one entrance, not several presets at once.",
    pictureInPicture:
      "Put the video on a track above the base footage and below the titles; clip.update x, y, width, height, mask rounded, cornerRadius 32, shadowBlur 24; animate scale 0.85 to 1 and opacity 0 to 1.",
    audioDuck:
      "cutline_edit action audio.duck {musicClipId, speechClipIds}: the music dips 14 dB (depthDb) under each spoken phrase, with short attack and release ramps, as one undoable step.",
    motionRecipe:
      "cutline_edit action motion.recipe {recipe, at, text, subtitle?}: a finished kinetic title, lower third, callout, end card or logo sting as named, editable layers.",
  },
  limitations:
    "No arbitrary code, third-party plugins, 3D, tracking or rotoscoping. You see the footage only through the preview images you request. Source media stays on this Mac. Transitions ripple their own track only, so separately placed captions or music may need retiming.",
};
