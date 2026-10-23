import type { MotionKeyframe, MotionLayer } from "./model";

export const motionProperties = [
  "x",
  "y",
  "opacity",
  "scale",
  "rotate",
  "blur",
  "trim",
  "strokeWidth",
  "fillOpacity",
] as const;
export type MotionProperty = (typeof motionProperties)[number];
export const motionPropertyBounds: Record<MotionProperty, [number, number]> = {
  x: [-4000, 4000],
  y: [-4000, 4000],
  opacity: [0, 1],
  scale: [0, 10],
  rotate: [-3600, 3600],
  blur: [0, 100],
  trim: [0, 1],
  strokeWidth: [0, 100],
  fillOpacity: [0, 1],
};
export const motionEasings = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "hold",
  "spring",
  "back",
  "cubic-bezier",
] as const;
export type MotionEasing = (typeof motionEasings)[number];
export type MotionBezier = [number, number, number, number];
export const defaultMotionBezier: MotionBezier = [0.16, 1, 0.3, 1];

function cubicBezier(t: number, bezier = defaultMotionBezier) {
  const controls = bezier.every(Number.isFinite) ? bezier : defaultMotionBezier;
  const x1 = Math.max(0, Math.min(1, controls[0])),
    x2 = Math.max(0, Math.min(1, controls[2]));
  const y1 = Math.max(-2, Math.min(3, controls[1])),
    y2 = Math.max(-2, Math.min(3, controls[3]));
  const coordinate = (at: number, a: number, b: number) =>
    3 * (1 - at) ** 2 * at * a + 3 * (1 - at) * at ** 2 * b + at ** 3;
  const derivative = (at: number) =>
    3 * (1 - at) ** 2 * x1 +
    6 * (1 - at) * at * (x2 - x1) +
    3 * at ** 2 * (1 - x2);
  let at = t,
    low = 0,
    high = 1;
  // Bounded Newton iteration with a bisection fallback handles flat tangents
  // and reversed control handles without losing the monotonic x solution.
  for (let i = 0; i < 40; i++) {
    const x = coordinate(at, x1, x2);
    if (Math.abs(x - t) <= 1e-12) break;
    if (x < t) low = at;
    else high = at;
    const slope = derivative(at);
    const next = slope > 1e-8 ? at - (x - t) / slope : NaN;
    at =
      Number.isFinite(next) && next > low && next < high
        ? next
        : (low + high) / 2;
  }
  return coordinate(at, y1, y2);
}

/** Easing belongs to the key at the start of a segment. */
export function motionEase(
  t: number,
  easing: MotionEasing,
  bezier?: MotionBezier,
) {
  if (Number.isNaN(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (easing) {
    case "cubic-bezier":
      return cubicBezier(t, bezier);
    case "hold":
      return 0;
    case "ease-in":
      return t * t;
    case "ease-out":
      return 1 - (1 - t) ** 2;
    case "ease-in-out":
      return t * t * (3 - 2 * t);
    case "back": {
      const overshoot = 1.70158;
      return 1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2;
    }
    case "spring":
      return (
        1 - Math.exp(-7 * t) * (Math.cos(11 * t) + (7 / 11) * Math.sin(11 * t))
      );
    default:
      return t;
  }
}

/** Named curves shared by the motion and clip keyframe editors. */
export const motionCurvePresets: ReadonlyArray<{
  id: string;
  name: string;
  bezier: MotionBezier;
}> = [
  { id: "smooth-out", name: "Smooth out", bezier: [0.16, 1, 0.3, 1] },
  { id: "smooth-in-out", name: "Smooth in & out", bezier: [0.65, 0, 0.35, 1] },
  { id: "quick-settle", name: "Quick settle", bezier: [0.22, 1, 0.36, 1] },
  { id: "overshoot", name: "Overshoot", bezier: [0.34, 1.56, 0.64, 1] },
  { id: "sharp", name: "Sharp transition", bezier: [0.76, 0, 0.24, 1] },
];

/** A fast, smooth arrival with no overshoot. */
export const settleBezier: MotionBezier = [0.16, 1, 0.3, 1];
/** Entrances: movement settles quickly and softly. */
export const entranceMoveBezier: MotionBezier = [0.22, 1, 0.36, 1];
/** Entrances: opacity rises a little more gently than movement. */
export const entranceFadeBezier: MotionBezier = [0.33, 1, 0.68, 1];

/**
 * Spring and back give movement and scale a physical settle. Amounts such as
 * opacity, reveal, blur and volume take the same timing without the bounce,
 * so they never flash past their target or stop on a clamp.
 */
export function propertyEase(
  t: number,
  easing: MotionEasing,
  bezier: MotionBezier | undefined,
  amount: boolean,
) {
  return amount && (easing === "spring" || easing === "back")
    ? motionEase(t, "cubic-bezier", settleBezier)
    : motionEase(t, easing, bezier);
}

/** Clip trim/split phase is added by the caller before loop evaluation. */
export function motionFrame(layer: MotionLayer, frame: number): number {
  const at = Number.isFinite(frame) ? Math.max(0, frame) : 0;
  if (!layer.loop || layer.loop === "none") return at;
  const length = Math.max(1, layer.loopFrames || 60);
  if (layer.loop === "cycle") return at % length;
  const phase = at % (length * 2);
  return phase <= length ? phase : length * 2 - phase;
}

type CurveKey = {
  frame: number;
  value: number;
  easing: MotionEasing;
  bezier?: MotionBezier;
};
const curveCache = new WeakMap<
  MotionKeyframe[],
  Map<MotionProperty, CurveKey[]>
>();
function curves(layer: MotionLayer) {
  let cached = curveCache.get(layer.keyframes);
  if (cached) return cached;
  cached = new Map();
  for (const property of motionProperties) {
    const byFrame = new Map<number, CurveKey>();
    for (const key of layer.keyframes ?? []) {
      const value = key[property];
      if (value !== undefined)
        // Last specified value wins per property. A sparse duplicate cannot erase another curve.
        byFrame.set(key.frame, {
          frame: key.frame,
          value,
          easing: key.easing ?? "linear",
          bezier: key.bezier,
        });
    }
    if (byFrame.size)
      cached.set(
        property,
        [...byFrame.values()].sort((a, b) => a.frame - b.frame),
      );
  }
  if (layer.keyframes) curveCache.set(layer.keyframes, cached);
  return cached;
}

/**
 * Amounts that a bounce would clamp and then dip: a spring on opacity used to
 * jump to full in four frames and sag back, and a trim or blur spring flickered.
 */
const motionAmounts = new Set<MotionProperty>([
  "opacity",
  "blur",
  "trim",
  "fillOpacity",
]);

/** x/y keys are movement offsets, preserving existing custom motion projects. */
export function motionValue(
  layer: MotionLayer,
  property: MotionProperty,
  frame: number,
): number {
  const base =
    property === "x" || property === "y"
      ? 0
      : (layer[property] ??
        (property === "opacity" ||
        property === "scale" ||
        property === "trim" ||
        property === "fillOpacity"
          ? 1
          : 0));
  const keys = curves(layer).get(property);
  if (!keys?.length) return base;
  const at = motionFrame(layer, frame);
  if (at <= keys[0].frame) return keys[0].value;
  let low = 1,
    high = keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle].frame <= at) low = middle + 1;
    else high = middle;
  }
  if (low === keys.length) return keys[keys.length - 1].value;
  const a = keys[low - 1],
    b = keys[low];
  const value =
    a.value +
    (b.value - a.value) *
      propertyEase(
        (at - a.frame) / (b.frame - a.frame),
        a.easing,
        a.bezier,
        motionAmounts.has(property),
      );
  // Natural motion may overshoot position/rotation; visual bounds must remain valid.
  if (property === "x" || property === "y" || property === "rotate")
    return value;
  const [min, max] = motionPropertyBounds[property];
  return Math.max(min, Math.min(max, value));
}

export function evaluatedMotionLayer(
  layer: MotionLayer,
  frame: number,
): MotionLayer {
  const result = { ...layer };
  for (const property of motionProperties) {
    const value = motionValue(layer, property, frame);
    result[property] =
      property === "x" || property === "y" ? layer[property] + value : value;
  }
  return result;
}

/** Vector geometry remains shared between preview and the exported composition. */
export function motionShapePath(layer: MotionLayer): string {
  const width = Math.max(1, layer.width),
    height = Math.max(1, layer.height);
  const inset = Math.min(layer.strokeWidth / 2, width / 2, height / 2);
  const left = inset,
    right = width - inset,
    top = inset,
    bottom = height - inset;
  const cx = width / 2,
    cy = height / 2,
    rx = (right - left) / 2,
    ry = (bottom - top) / 2;
  switch (layer.type) {
    case "path":
      return layer.vectorPath ?? "";
    case "line":
      return `M${left},${cy}L${right},${cy}`;
    case "ellipse":
      return `M${cx},${top}A${rx},${ry} 0 1 1 ${cx},${bottom}A${rx},${ry} 0 1 1 ${cx},${top}Z`;
    case "triangle":
      return `M${cx},${top}L${right},${bottom}L${left},${bottom}Z`;
    case "star":
      return (
        Array.from({ length: 10 }, (_, i) => {
          const angle = -Math.PI / 2 + (i * Math.PI) / 5;
          const size = i % 2 ? 0.43 : 1;
          return `${i ? "L" : "M"}${cx + Math.cos(angle) * rx * size},${cy + Math.sin(angle) * ry * size}`;
        }).join("") + "Z"
      );
    default: {
      const radius = Math.min(layer.radius, rx, ry);
      return `M${left + radius},${top}H${right - radius}Q${right},${top} ${right},${top + radius}V${bottom - radius}Q${right},${bottom} ${right - radius},${bottom}H${left + radius}Q${left},${bottom} ${left},${bottom - radius}V${top + radius}Q${left},${top} ${left + radius},${top}Z`;
    }
  }
}

/**
 * The frame a layer starts to show, from its opacity keys. Letter and word
 * reveals start there, so a stagger is never spent while the layer is still
 * invisible.
 */
export function motionRevealStart(layer: MotionLayer): number {
  const keys = curves(layer).get("opacity");
  if (!keys?.length || keys[0].value > 0) return 0;
  for (let i = 1; i < keys.length; i++)
    if (keys[i].value > 0)
      return keys[i - 1].easing === "hold" ? keys[i].frame : keys[i - 1].frame;
  return 0;
}

/**
 * Letters and words rise one after another over 0.4 seconds each, at any
 * frame rate, fading and settling on ease-out curves.
 */
export function motionTextTokens(
  layer: MotionLayer,
  text: string,
  frame: number,
  fps = 30,
) {
  const tokens =
    layer.textAnimation === "word-rise"
      ? text.split(/(\s+)/u)
      : Array.from(text);
  const at = motionFrame(layer, frame);
  const begin = layer.textAnimation === "none" ? 0 : motionRevealStart(layer);
  const rise = Math.max(1, Math.round((12 * fps) / 30));
  const rises = layer.textAnimation.endsWith("rise");
  let order = 0;
  return tokens.map((text) => {
    const whitespace = /^\s+$/u.test(text);
    const start = begin + order * layer.staggerFrames;
    if (!(layer.textAnimation === "word-rise" && whitespace)) order++;
    const progress =
      layer.textAnimation === "none"
        ? 1
        : layer.textAnimation === "typewriter"
          ? at >= start
            ? 1
            : 0
          : Math.max(0, Math.min(1, (at - start) / rise));
    const move = motionEase(progress, "cubic-bezier", entranceMoveBezier);
    return {
      text,
      opacity: rises
        ? motionEase(progress, "cubic-bezier", entranceFadeBezier)
        : progress,
      y: rises ? (1 - move) * Math.min(60, layer.fontSize * 0.55) : 0,
      blur: rises ? (1 - move) * 8 : 0,
    };
  });
}

/** Explicit text lines reveal through individual masks. y is a percentage of each line's rendered height. */
export function motionTextLines(
  layer: MotionLayer,
  text: string,
  frame: number,
) {
  const at = motionFrame(layer, frame);
  const duration = Math.max(1, layer.textRevealFrames ?? 18);
  return text.split(/\r\n|\r|\n/u).map((text, index) => {
    const start = (layer.textRevealStart ?? 0) + index * layer.staggerFrames;
    const progress = Math.max(0, Math.min(1, (at - start) / duration));
    const eased = motionEase(progress, "cubic-bezier");
    return { text, progress, y: (1 - eased) * 105 };
  });
}

/** Accent eligibility is stable over animation time and independent of React/rendering. */
export function isMotionAccentLayer(
  layer: Pick<MotionLayer, "type" | "width" | "height" | "musicAccent"> &
    Partial<Pick<MotionLayer, "hidden">>,
  canvas: { width: number; height: number },
) {
  return (
    layer.type !== "text" &&
    !layer.hidden &&
    layer.musicAccent !== false &&
    layer.width * layer.height <
      Math.max(1, canvas.width * canvas.height) * 0.65
  );
}
