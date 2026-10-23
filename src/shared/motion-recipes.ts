import {
  MotionLayerSchema,
  type Clip,
  type MotionKeyframe,
  type MotionLayer,
  type Project,
} from "./model";
import { captionTextWidth } from "./caption-layout";
import { packageMotion } from "./motion-presets";
import type { MotionBezier } from "./motion";

/**
 * One-call professional graphics. Each recipe expands into ordinary named
 * motion layers and keys, so everything stays editable afterwards. The
 * timing follows the house rules: ease-out entrances, 2 to 4 frame staggers
 * between related elements, a hold long enough to read, and a quicker
 * ease-in exit that finishes on the clip's last frame.
 */
export const motionRecipeIds = [
  "kinetic-title",
  "lower-third",
  "callout",
  "end-card",
  "logo-sting",
] as const;
export type MotionRecipeId = (typeof motionRecipeIds)[number];
export const motionRecipeStyles = ["clean", "bold", "minimal"] as const;
export type MotionRecipeStyle = (typeof motionRecipeStyles)[number];
export const motionRecipePositions = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type MotionRecipePosition = (typeof motionRecipePositions)[number];
export type MotionRecipeColors = {
  text?: string;
  accent?: string;
  panel?: string;
  background?: string;
};
export type MotionRecipeOptions = {
  recipe: MotionRecipeId;
  text: string;
  subtitle?: string;
  durationFrames?: number;
  position?: MotionRecipePosition;
  point?: { x: number; y: number };
  style?: MotionRecipeStyle;
  colors?: MotionRecipeColors;
};

export const motionRecipes: ReadonlyArray<{
  id: MotionRecipeId;
  name: string;
  seconds: number;
  position: MotionRecipePosition;
  subtitle: string;
  layers: string[];
  description: string;
}> = [
  {
    id: "kinetic-title",
    name: "Kinetic title",
    seconds: 4,
    position: "center",
    subtitle: "a quieter line under the title",
    layers: [
      "Background (only with colors.background)",
      "Title",
      "Accent line",
      "Subtitle",
    ],
    description:
      "The title rises word by word (letter by letter for short bold titles, masked lines for minimal), an accent line draws on beneath it and the subtitle follows. Sits over the footage unless colors.background is set.",
  },
  {
    id: "lower-third",
    name: "Lower third",
    seconds: 5,
    position: "bottom-left",
    subtitle: "the role or title",
    layers: ["Accent bar", "Panel", "Name", "Role"],
    description:
      "An accent bar draws, the panel slides in, then the name and the role rise 3 frames apart. It holds about 4 seconds and leaves faster than it came in.",
  },
  {
    id: "callout",
    name: "Callout",
    seconds: 3.5,
    position: "center",
    subtitle: "a detail line under the label",
    layers: ["Ring", "Dot", "Leader", "Label panel", "Label", "Detail"],
    description:
      "A ring and dot mark point {x, y} (canvas pixels; without it, the spot position names), a leader line draws out and the label panel follows on whichever side has room.",
  },
  {
    id: "end-card",
    name: "End card",
    seconds: 5,
    position: "center",
    subtitle: "the call to action, set in a button",
    layers: ["Background", "Title", "Accent line", "Button", "Call to action"],
    description:
      "A full-frame closing card: the title rises, an accent line grows beneath it and the call to action arrives in a button (plain text in minimal).",
  },
  {
    id: "logo-sting",
    name: "Logo sting",
    seconds: 3.5,
    position: "center",
    subtitle: "a tagline under the wordmark",
    layers: ["Background", "Ring", "Mark", "Monogram", "Wordmark", "Tagline"],
    description:
      "A ring draws around a mark holding the text's initial, then the wordmark and tagline reveal beside it (below it on tall canvases). For an SVG logo use cutline_vector_import and motion.logoReveal.",
  },
];

/** The recipe catalog for cutline_editing_schema section motionRecipes. */
export function motionRecipeCatalog() {
  return {
    usage:
      "motion.recipe {recipe, at, text, subtitle?, durationFrames?, position?, point?, style?, colors?, ref?} adds one editable motion clip on a free text track. text is the main line; subtitle is the secondary line each recipe describes. The result's created motion lists its layer names by index: tweak them with motion.layer.update and motion.keyframe using $ref.motion.",
    recipes: motionRecipes,
    styles: {
      clean: "Bold sans title, word rises, ease-out moves (default).",
      bold: "Heavier type, letter rises on short titles, a 2% settle overshoot and stronger accents.",
      minimal:
        "Lighter type, masked line reveals, hairline accents and a lighter panel.",
    },
    positions: [...motionRecipePositions],
    colors: {
      text: "#FFFFFF",
      accent: "#81B6FF",
      panel: "#101318",
      background:
        "transparent for kinetic-title, lower-third and callout; #0E1116 for end-card and logo-sting",
    },
    timing:
      "Entrances ease out over 10 to 18 frames at 30 fps with 2 to 4 frame staggers; text holds at least 1.5 seconds at the default length; exits ease in over 10 frames and end on the clip's last frame. Timing scales with the frame rate; durationFrames stretches the hold, and a recipe shorter than it needs is compressed with a warning.",
  };
}

const ENTER: MotionBezier = [0.22, 1, 0.36, 1];
const FADE: MotionBezier = [0.33, 1, 0.68, 1];
/** A small settle (about 2%) for bold moves; always under the 6% limit. */
const SETTLE: MotionBezier = [0.22, 1.25, 0.36, 1];
const EXIT: MotionBezier = [0.32, 0, 0.67, 0];
const FAMILY: Clip["fontFamily"] = "Helvetica";
const defaults = {
  text: "#FFFFFF",
  accent: "#81B6FF",
  panel: "#101318",
  card: "#0E1116",
};
/**
 * The length each recipe needs, in frames at 30 fps: its entrances with a
 * typical line of text, a 1.5 second hold and the 13 frame exit.
 */
const natural: Record<MotionRecipeId, number> = {
  "kinetic-title": 30 + 45 + 13,
  "lower-third": 30 + 45 + 13,
  callout: 40 + 45 + 13,
  "end-card": 30 + 45 + 13,
  "logo-sting": 40 + 45 + 13,
};

type Timing = {
  /** A moment in base frames, scaled to the project and the duration. */
  at: (frames: number) => number;
  /** A length in base frames, never under one frame. */
  len: (frames: number) => number;
  /** Where an element starts to leave; order 0 leaves first, 3 last. */
  leaveAt: (order: number) => number;
  exit: number;
  /** A text stagger, scaled only by the frame rate. */
  stagger: (frames: number) => number;
  reveal: number;
};
type Fitted = {
  lines: string[];
  size: number;
  width: number;
  height: number;
  weight: number;
  tracking: number;
  lineHeight: number;
};
type Context = {
  w: number;
  h: number;
  s: number;
  style: MotionRecipeStyle;
  colors: { text: string; accent: string; panel: string; background?: string };
  area: { left: number; right: number; top: number; bottom: number };
  /** Captions on screen while the recipe plays, as one vertical band. */
  captions?: { top: number; bottom: number };
  position: MotionRecipePosition;
  point?: { x: number; y: number };
  text: string;
  subtitle?: string;
  t: Timing;
  name: string;
  warnings: string[];
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));
const metricWeight = (weight: number): Clip["fontWeight"] =>
  weight >= 700 ? "800" : weight >= 600 ? "600" : "400";

function timing(
  fps: number,
  duration: number,
  recipe: MotionRecipeId,
  name: string,
  warnings: string[],
): Timing {
  const scale = fps / 30;
  const needed = natural[recipe];
  const k = Math.min(1, duration / (needed * scale));
  if (k < 1)
    warnings.push(
      `This ${name.toLowerCase()} is shorter than the ${(needed / 30).toFixed(1)} seconds it needs, so its moves are quicker and its text holds less time to read.`,
    );
  const at = (frames: number) => Math.max(0, Math.round(frames * scale * k));
  const len = (frames: number) => Math.max(1, at(frames));
  const last = duration - 1;
  const exit = len(10);
  const spread = at(3);
  return {
    at,
    len,
    exit,
    leaveAt: (order) =>
      Math.max(0, last - exit - spread + Math.min(spread, at(order))),
    stagger: (frames) => Math.max(1, Math.round(frames * scale)),
    reveal: Math.max(1, Math.round(16 * scale)),
  };
}

/**
 * The fewest balanced lines at the largest size that fits, never dropping a
 * word. Explicit line breaks in the text are kept.
 */
function fitText(
  c: Context,
  text: string,
  o: {
    size: number;
    min: number;
    maxWidth: number;
    maxLines: number;
    weight: number;
    tracking: number;
    lineHeight: number;
  },
): Fitted {
  const paragraphs = text
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim().split(/\s+/u).filter(Boolean))
    .filter((words) => words.length);
  // Width at a font size of 1: captionTextWidth scales linearly with size.
  const widths = new Map<string, number>();
  const unit = (line: string) => {
    let width = widths.get(line);
    if (width === undefined) {
      width = captionTextWidth(
        line,
        1,
        FAMILY,
        metricWeight(o.weight),
        o.tracking,
      );
      widths.set(line, width);
    }
    return width;
  };
  /** Splits words into `count` lines with the narrowest widest line. */
  const split = (words: string[], count: number) => {
    const n = words.length;
    const cost = Array.from({ length: count + 1 }, () =>
      new Array<number>(n + 1).fill(Infinity),
    );
    const from = Array.from({ length: count + 1 }, () =>
      new Array<number>(n + 1).fill(0),
    );
    cost[0][0] = 0;
    for (let k = 1; k <= count; k++)
      for (let j = k; j <= n; j++)
        for (let i = k - 1; i < j; i++) {
          const value = Math.max(
            cost[k - 1][i],
            unit(words.slice(i, j).join(" ")),
          );
          if (value < cost[k][j]) {
            cost[k][j] = value;
            from[k][j] = i;
          }
        }
    const lines: string[] = [];
    for (let k = count, j = n; k > 0; k--) {
      const i = from[k][j];
      lines.unshift(words.slice(i, j).join(" "));
      j = i;
    }
    return { lines, width: cost[count][n] };
  };
  const maxLines = Math.max(o.maxLines, paragraphs.length);
  const layout = (size: number, limit: number) => {
    const lines: string[] = [];
    let width = 0;
    for (const words of paragraphs) {
      let best = split(words, 1);
      for (
        let count = 2;
        count <= words.length && best.width * size > o.maxWidth;
        count++
      )
        best = split(words, count);
      lines.push(...best.lines);
      width = Math.max(width, best.width * size);
    }
    return { lines, width, fits: width <= o.maxWidth && lines.length <= limit };
  };
  let size = o.size;
  let result = layout(size, maxLines);
  while (!result.fits && size > o.min) {
    size = Math.max(o.min, size * 0.94);
    result = layout(size, maxLines);
  }
  if (!result.fits) {
    result = layout(size, Infinity);
    if (!result.fits || result.lines.length > maxLines)
      c.warnings.push(
        `"${text.slice(0, 60)}" is long for a ${c.name.toLowerCase()}, so it is set smaller on ${result.lines.length} lines. A shorter text reads better.`,
      );
  }
  return {
    lines: result.lines,
    size,
    width: Math.min(result.width, o.maxWidth),
    height: result.lines.length * size * o.lineHeight,
    weight: o.weight,
    tracking: o.tracking,
    lineHeight: o.lineHeight,
  };
}

type Values = Partial<Record<"x" | "y" | "opacity" | "scale" | "trim", number>>;
type Enter = {
  at: number;
  frames: number;
  from: Values;
  move?: MotionBezier;
  /** Opacity switches on at `at`; letters and words then rise on their own. */
  pop?: boolean;
};
type Leave = { at: number; frames: number; to: Values };
const neutral: Required<Values> = { x: 0, y: 0, opacity: 1, scale: 1, trim: 1 };

/**
 * Keys for one layer: hold the starting values, ease out to the resting
 * values, hold, then ease in to the leaving values. Opacity fades on its own
 * gentler curve; properties sharing a frame and curve share a key.
 */
function keys(rest: Values, enter?: Enter, leave?: Leave): MotionKeyframe[] {
  const records: {
    frame: number;
    easing: MotionKeyframe["easing"];
    bezier?: MotionBezier;
    values: Values;
  }[] = [];
  const add = (
    frame: number,
    property: keyof Values,
    value: number,
    easing: MotionKeyframe["easing"],
    bezier?: MotionBezier,
  ) => {
    const same = records.find(
      (record) =>
        record.frame === frame &&
        record.easing === easing &&
        record.bezier === bezier,
    );
    if (same) same.values[property] = value;
    else records.push({ frame, easing, bezier, values: { [property]: value } });
  };
  const properties = new Set([
    ...Object.keys(enter?.from ?? {}),
    ...Object.keys(leave?.to ?? {}),
  ]) as Set<keyof Values>;
  for (const property of properties) {
    const resting = rest[property] ?? neutral[property];
    const from = enter?.from[property];
    if (enter && from !== undefined) {
      // Never let a squeezed entrance run into the exit.
      const until = leave ? Math.max(enter.at + 1, leave.at) : Infinity;
      const at = Math.min(enter.at, until - 1);
      const end = Math.min(at + enter.frames, until);
      if (at > 0) add(0, property, from, "hold");
      if (enter.pop) add(at, property, resting, "linear");
      else {
        add(
          at,
          property,
          from,
          "cubic-bezier",
          property === "opacity" ? FADE : (enter.move ?? ENTER),
        );
        add(end, property, resting, "linear");
      }
    }
    const to = leave?.to[property];
    if (leave && to !== undefined) {
      add(leave.at, property, resting, "cubic-bezier", EXIT);
      add(leave.at + leave.frames, property, to, "linear");
    }
  }
  return records
    .sort((a, b) => a.frame - b.frame)
    .map((record) => ({
      frame: record.frame,
      ...record.values,
      easing: record.easing,
      ...(record.bezier ? { bezier: [...record.bezier] as MotionBezier } : {}),
    }));
}

const layer = (definition: Record<string, unknown>): MotionLayer =>
  MotionLayerSchema.parse(definition);

/** Where a block of the given size sits for a position, inside the safe area. */
function placeBlock(c: Context, width: number, height: number) {
  const column = c.position.endsWith("left")
    ? ("left" as const)
    : c.position.endsWith("right")
      ? ("right" as const)
      : ("center" as const);
  const row = c.position.startsWith("top")
    ? "top"
    : c.position.startsWith("bottom")
      ? "bottom"
      : "middle";
  const x =
    column === "left"
      ? c.area.left
      : column === "right"
        ? c.area.right - width
        : (c.w - width) / 2;
  let y =
    row === "top"
      ? c.area.top
      : row === "bottom"
        ? c.area.bottom - height
        : (c.h - height) / 2;
  // Step around captions on screen at the same time: above them when there
  // is room, otherwise below.
  const band = c.captions;
  if (band && height > 0 && y < band.bottom && y + height > band.top) {
    const gap = c.s * 0.025;
    const above = band.top - gap - height,
      below = band.bottom + gap;
    if (above >= c.area.top * 0.5) y = above;
    else if (below + height <= c.h - c.area.top * 0.5) y = below;
    else
      c.warnings.push(
        `This ${c.name.toLowerCase()} overlaps the captions on screen; choose another position or shorten the text.`,
      );
  }
  return {
    x: clamp(x, 0, c.w - width),
    y: clamp(y, 0, c.h - height),
    column,
  };
}
/** The left edge of a line of `width` inside a block, for its alignment. */
const alignedLeft = (
  x: number,
  blockWidth: number,
  width: number,
  align: "left" | "center" | "right",
) =>
  align === "left"
    ? x
    : align === "right"
      ? x + blockWidth - width
      : x + (blockWidth - width) / 2;

/** How text arrives: masked lines for minimal, letters for short bold titles, words otherwise. */
function textMotion(c: Context, text: string, title: boolean) {
  if (c.style === "minimal")
    return { animation: "line-reveal" as const, stagger: 4 };
  if (c.style === "bold" && title && Array.from(text).length <= 14)
    return { animation: "character-rise" as const, stagger: 2 };
  const words = text.split(/\s+/u).filter(Boolean).length;
  return { animation: "word-rise" as const, stagger: words > 6 ? 2 : 3 };
}

/** A text layer whose box fits its measured lines, with room so they never rewrap. */
function typeLayer(
  c: Context,
  f: Fitted,
  o: {
    name: string;
    left: number;
    top: number;
    align: "left" | "center" | "right";
    color: string;
    opacity?: number;
    title: boolean;
    start: number;
    leave: number;
  },
): MotionLayer {
  const text = f.lines.join("\n");
  const motion = textMotion(c, text, o.title);
  const slack = f.width * 0.06 + 4;
  const width = Math.min(c.w, f.width + slack);
  const x = clamp(
    o.align === "left"
      ? o.left
      : o.align === "right"
        ? o.left + f.width - width
        : o.left + (f.width - width) / 2,
    0,
    c.w - width,
  );
  const height = Math.min(c.h, f.height + f.size * 0.25);
  const y = clamp(o.top - f.size * 0.125, 0, c.h - height);
  const rest = o.opacity ?? 1;
  const leave: Leave = {
    at: o.leave,
    frames: c.t.exit,
    to: { opacity: 0, y: -c.s * 0.012 },
  };
  return layer({
    type: "text",
    name: o.name,
    text,
    x,
    y,
    width,
    height,
    color: o.color,
    fontSize: clamp(f.size, 8, 500),
    fontWeight: f.weight,
    align: o.align,
    letterSpacing: clamp(f.tracking * f.size, -30, 100),
    lineHeight: f.lineHeight,
    opacity: rest,
    musicAccent: false,
    textAnimation: motion.animation,
    staggerFrames: c.t.stagger(motion.stagger),
    textRevealStart: motion.animation === "line-reveal" ? o.start : 0,
    textRevealFrames: c.t.reveal,
    keyframes:
      motion.animation === "line-reveal"
        ? keys({ opacity: rest }, undefined, leave)
        : keys(
            { opacity: rest },
            { at: o.start, frames: 1, from: { opacity: 0 }, pop: true },
            leave,
          ),
  });
}

function background(c: Context, color: string, fade: boolean): MotionLayer {
  return layer({
    type: "rectangle",
    name: "Background",
    x: 0,
    y: 0,
    width: c.w,
    height: c.h,
    background: color,
    musicAccent: false,
    keyframes: fade
      ? keys({}, { at: 0, frames: c.t.len(8), from: { opacity: 0 } })
      : [],
  });
}

/**
 * A horizontal accent line that grows from its center when centered and
 * draws from its outer edge otherwise.
 */
function accentLine(
  c: Context,
  o: {
    left: number;
    top: number;
    width: number;
    stroke: number;
    align: "left" | "center" | "right";
    start: number;
    leave: number;
  },
): MotionLayer {
  const centered = o.align === "center";
  return layer({
    type: "line",
    name: "Accent line",
    x: o.left,
    y: o.top,
    width: o.width,
    height: o.stroke,
    background: "transparent",
    stroke: c.colors.accent,
    strokeWidth: o.stroke,
    // A line draws from its start: turned around, it draws from the right.
    rotate: o.align === "right" ? 180 : 0,
    keyframes: keys(
      {},
      {
        at: o.start,
        frames: c.t.len(14),
        from: centered ? { scale: 0 } : { trim: 0 },
        move: c.style === "bold" && centered ? SETTLE : ENTER,
      },
      { at: o.leave, frames: c.t.exit, to: { opacity: 0 } },
    ),
  });
}

function kineticTitle(c: Context): MotionLayer[] {
  const { s, t, style } = c;
  const bold = style === "bold",
    minimal = style === "minimal";
  const safe = c.area.right - c.area.left;
  const title = fitText(c, c.text, {
    size: s * (bold ? 0.12 : minimal ? 0.085 : 0.1),
    min: s * 0.05,
    maxWidth: safe * 0.92,
    maxLines: c.h > c.w ? 3 : 2,
    weight: bold ? 800 : minimal ? 500 : 700,
    tracking: bold ? -0.03 : minimal ? -0.01 : -0.02,
    lineHeight: 1.05,
  });
  const sub = c.subtitle
    ? fitText(c, c.subtitle, {
        // About a third of the title: inside the 2 to 3 times hierarchy.
        size: Math.max(s * 0.03, title.size * 0.38),
        min: s * 0.02,
        maxWidth: safe * 0.8,
        maxLines: 2,
        weight: bold ? 600 : 400,
        tracking: minimal ? 0.04 : bold ? 0.01 : 0,
        lineHeight: 1.25,
      })
    : undefined;
  const stroke = Math.max(2, s * (bold ? 0.01 : minimal ? 0.0025 : 0.005));
  const lineWidth = clamp(title.width * 0.22, s * 0.08, s * 0.2);
  const above = title.size * 0.32,
    below = sub ? sub.size * 0.9 : 0;
  const blockWidth = Math.max(title.width, lineWidth, sub?.width ?? 0);
  const blockHeight =
    title.height + above + stroke + (sub ? below + sub.height : 0);
  const at = placeBlock(c, blockWidth, blockHeight);
  const align = at.column;
  const layers: MotionLayer[] = [];
  const card =
    c.colors.background && c.colors.background !== "transparent"
      ? c.colors.background
      : undefined;
  if (card) layers.push(background(c, card, true));
  const begin = card ? t.at(4) : 0;
  layers.push(
    typeLayer(c, title, {
      name: "Title",
      left: alignedLeft(at.x, blockWidth, title.width, align),
      top: at.y,
      align,
      color: c.colors.text,
      title: true,
      start: begin,
      leave: t.leaveAt(2),
    }),
  );
  const lineTop = at.y + title.height + above;
  layers.push(
    accentLine(c, {
      left: alignedLeft(at.x, blockWidth, lineWidth, align),
      top: lineTop,
      width: lineWidth,
      stroke,
      align,
      start: begin + t.at(2),
      leave: t.leaveAt(1),
    }),
  );
  if (sub)
    layers.push(
      typeLayer(c, sub, {
        name: "Subtitle",
        left: alignedLeft(at.x, blockWidth, sub.width, align),
        top: lineTop + stroke + below,
        align,
        color: c.colors.text,
        opacity: 0.78,
        title: false,
        start: begin + t.at(4),
        leave: t.leaveAt(0),
      }),
    );
  return layers;
}

function lowerThird(c: Context): MotionLayer[] {
  const { s, t, style } = c;
  const bold = style === "bold",
    minimal = style === "minimal";
  const safe = c.area.right - c.area.left;
  const maxText = Math.min(safe, s * 1.1) * 0.86;
  const name = fitText(c, c.text, {
    size: s * (bold ? 0.048 : minimal ? 0.042 : 0.044),
    min: s * 0.028,
    maxWidth: maxText,
    maxLines: 2,
    weight: bold ? 800 : minimal ? 500 : 700,
    tracking: bold ? -0.015 : -0.01,
    lineHeight: 1.1,
  });
  const role = c.subtitle
    ? fitText(c, c.subtitle, {
        size: Math.max(s * 0.024, name.size * 0.66),
        min: s * 0.018,
        maxWidth: maxText,
        maxLines: 2,
        weight: bold ? 600 : 400,
        tracking: minimal ? 0.04 : 0.01,
        lineHeight: 1.25,
      })
    : undefined;
  const padX = name.size * 0.62,
    padY = name.size * 0.46,
    gap = role ? name.size * 0.16 : 0;
  const textWidth = Math.max(name.width, role?.width ?? 0);
  const panelWidth = textWidth + padX * 2;
  const panelHeight = name.height + gap + (role?.height ?? 0) + padY * 2;
  const bar = Math.max(3, s * (bold ? 0.009 : minimal ? 0.003 : 0.006));
  const barGap = Math.max(bar * 1.6, s * 0.006);
  const at = placeBlock(c, bar + barGap + panelWidth, panelHeight);
  const right = at.column === "right";
  const align = at.column;
  const panelX = right ? at.x : at.x + bar + barGap;
  const barX = right ? at.x + panelWidth + barGap : at.x;
  // Slide in from the outer edge, or up from below when centered.
  const slide = s * 0.035;
  const from: Values =
    align === "center" ? { y: slide } : { x: right ? slide : -slide };
  const away: Values =
    align === "center"
      ? { y: slide * 0.6 }
      : { x: right ? slide * 0.6 : -slide * 0.6 };
  const textLeft = (f: Fitted) =>
    alignedLeft(panelX + padX, textWidth, f.width, align);
  const layers: MotionLayer[] = [
    layer({
      type: "path",
      name: "Accent bar",
      x: barX,
      y: at.y,
      width: bar,
      height: panelHeight,
      vectorPath: `M${(bar / 2).toFixed(2)} ${panelHeight.toFixed(2)}L${(bar / 2).toFixed(2)} 0`,
      vectorViewBox: [0, 0, bar, panelHeight],
      vectorAspectRatio: "none",
      vectorLineCap: "butt",
      background: "transparent",
      stroke: c.colors.accent,
      strokeWidth: bar,
      keyframes: keys(
        {},
        { at: 0, frames: t.len(12), from: { trim: 0 } },
        { at: t.leaveAt(3), frames: t.exit, to: { opacity: 0 } },
      ),
    }),
    layer({
      type: "rectangle",
      name: "Panel",
      x: panelX,
      y: at.y,
      width: panelWidth,
      height: panelHeight,
      background: c.colors.panel,
      fillOpacity: bold ? 0.94 : minimal ? 0.6 : 0.86,
      radius: minimal ? 0 : s * (bold ? 0.004 : 0.008),
      musicAccent: false,
      keyframes: keys(
        {},
        {
          at: t.at(2),
          frames: t.len(14),
          from: { opacity: 0, ...from },
          move: bold ? SETTLE : ENTER,
        },
        { at: t.leaveAt(2), frames: t.exit, to: { opacity: 0, ...away } },
      ),
    }),
    typeLayer(c, name, {
      name: "Name",
      left: textLeft(name),
      top: at.y + padY,
      align,
      color: c.colors.text,
      title: true,
      start: t.at(5),
      leave: t.leaveAt(1),
    }),
  ];
  if (role)
    layers.push(
      typeLayer(c, role, {
        name: "Role",
        left: textLeft(role),
        top: at.y + padY + name.height + gap,
        align,
        color: c.colors.text,
        opacity: 0.78,
        title: false,
        start: t.at(8),
        leave: t.leaveAt(0),
      }),
    );
  return layers;
}

function callout(c: Context): MotionLayer[] {
  const { s, t, style, w, h } = c;
  const bold = style === "bold",
    minimal = style === "minimal";
  const radius = s * 0.032,
    ring = Math.max(2, s * (bold ? 0.006 : minimal ? 0.0025 : 0.004)),
    dot = s * (bold ? 0.011 : 0.0085);
  const edge = radius + ring;
  const anchor = () => {
    const at = placeBlock(c, 0, 0);
    const column = at.column;
    const row = c.position.startsWith("top")
      ? 0.32
      : c.position.startsWith("bottom")
        ? 0.68
        : 0.5;
    return {
      x: w * (column === "left" ? 0.3 : column === "right" ? 0.7 : 0.5),
      y: h * row,
    };
  };
  const target = c.point ?? anchor();
  const point = {
    x: clamp(target.x, edge, w - edge),
    y: clamp(target.y, edge, h - edge),
  };
  const label = fitText(c, c.text, {
    size: s * (bold ? 0.04 : 0.036),
    min: s * 0.024,
    maxWidth: s * 0.55,
    maxLines: 2,
    weight: bold ? 800 : minimal ? 500 : 700,
    tracking: -0.01,
    lineHeight: 1.1,
  });
  const detail = c.subtitle
    ? fitText(c, c.subtitle, {
        size: label.size * 0.78,
        min: s * 0.018,
        maxWidth: s * 0.55,
        maxLines: 2,
        weight: 400,
        tracking: minimal ? 0.03 : 0,
        lineHeight: 1.25,
      })
    : undefined;
  const padX = label.size * 0.6,
    padY = label.size * 0.42,
    gap = detail ? label.size * 0.18 : 0;
  const textWidth = Math.max(label.width, detail?.width ?? 0);
  const panelWidth = textWidth + padX * 2;
  const panelHeight = label.height + gap + (detail?.height ?? 0) + padY * 2;
  const diagonal = s * 0.07,
    run = s * 0.04,
    space = s * 0.01;
  // The label goes toward the open side of the frame, and flips when it would leave it.
  const reach = radius * 0.7071 + diagonal + run + space + panelWidth;
  let side = point.x <= w / 2 ? 1 : -1;
  if (side > 0 && point.x + reach > c.area.right && point.x - reach >= 0)
    side = -1;
  else if (side < 0 && point.x - reach < c.area.left && point.x + reach <= w)
    side = 1;
  let rise = point.y >= h / 2 ? -1 : 1;
  const climb = radius * 0.7071 + diagonal + panelHeight / 2;
  if (rise < 0 && point.y - climb < 0) rise = 1;
  else if (rise > 0 && point.y + climb > h) rise = -1;
  const start = {
    x: point.x + side * radius * 0.7071,
    y: point.y + rise * radius * 0.7071,
  };
  const elbow = { x: start.x + side * diagonal, y: start.y + rise * diagonal };
  const end = { x: elbow.x + side * run, y: elbow.y };
  const panelX = clamp(
    side > 0 ? end.x + space : end.x - space - panelWidth,
    0,
    w - panelWidth,
  );
  const panelY = clamp(end.y - panelHeight / 2, 0, h - panelHeight);
  const align = side > 0 ? ("left" as const) : ("right" as const);
  const text = (f: Fitted) =>
    alignedLeft(panelX + padX, textWidth, f.width, align);
  const fixed = (n: number) => n.toFixed(1);
  const layers: MotionLayer[] = [
    layer({
      type: "ellipse",
      name: "Ring",
      x: point.x - radius,
      y: point.y - radius,
      width: radius * 2,
      height: radius * 2,
      background: "transparent",
      stroke: c.colors.accent,
      strokeWidth: ring,
      keyframes: keys(
        {},
        { at: 0, frames: t.len(14), from: { trim: 0, scale: 0.6 } },
        { at: t.leaveAt(3), frames: t.exit, to: { opacity: 0, scale: 0.6 } },
      ),
    }),
    layer({
      type: "ellipse",
      name: "Dot",
      x: point.x - dot,
      y: point.y - dot,
      width: dot * 2,
      height: dot * 2,
      background: c.colors.accent,
      keyframes: keys(
        {},
        {
          at: t.at(2),
          frames: t.len(10),
          from: { scale: 0 },
          move: bold ? SETTLE : ENTER,
        },
        { at: t.leaveAt(3), frames: t.exit, to: { opacity: 0, scale: 0.4 } },
      ),
    }),
    layer({
      type: "path",
      name: "Leader",
      x: 0,
      y: 0,
      width: w,
      height: h,
      vectorPath: `M${fixed(start.x)} ${fixed(start.y)}L${fixed(elbow.x)} ${fixed(elbow.y)}L${fixed(end.x)} ${fixed(end.y)}`,
      vectorViewBox: [0, 0, w, h],
      vectorAspectRatio: "none",
      vectorLineCap: "round",
      vectorLineJoin: "round",
      background: "transparent",
      stroke: c.colors.accent,
      strokeWidth: ring,
      keyframes: keys(
        {},
        { at: t.at(5), frames: t.len(10), from: { trim: 0 } },
        { at: t.leaveAt(2), frames: t.exit, to: { trim: 0, opacity: 0 } },
      ),
    }),
    layer({
      type: "rectangle",
      name: "Label panel",
      x: panelX,
      y: panelY,
      width: panelWidth,
      height: panelHeight,
      background: c.colors.panel,
      fillOpacity: bold ? 0.94 : minimal ? 0.6 : 0.86,
      radius: minimal ? 0 : s * 0.008,
      musicAccent: false,
      keyframes: keys(
        {},
        {
          at: t.at(13),
          frames: t.len(12),
          from: { opacity: 0, x: -side * s * 0.015 },
        },
        {
          at: t.leaveAt(1),
          frames: t.exit,
          to: { opacity: 0, x: -side * s * 0.01 },
        },
      ),
    }),
    typeLayer(c, label, {
      name: "Label",
      left: text(label),
      top: panelY + padY,
      align,
      color: c.colors.text,
      title: true,
      start: t.at(15),
      leave: t.leaveAt(1),
    }),
  ];
  if (detail)
    layers.push(
      typeLayer(c, detail, {
        name: "Detail",
        left: text(detail),
        top: panelY + padY + label.height + gap,
        align,
        color: c.colors.text,
        opacity: 0.78,
        title: false,
        start: t.at(18),
        leave: t.leaveAt(0),
      }),
    );
  return layers;
}

function endCard(c: Context): MotionLayer[] {
  const { s, t, style } = c;
  const bold = style === "bold",
    minimal = style === "minimal";
  const safe = c.area.right - c.area.left;
  const title = fitText(c, c.text, {
    size: s * (bold ? 0.1 : minimal ? 0.075 : 0.085),
    min: s * 0.045,
    maxWidth: safe * 0.86,
    maxLines: 2,
    weight: bold ? 800 : minimal ? 500 : 700,
    tracking: bold ? -0.03 : minimal ? -0.01 : -0.02,
    lineHeight: 1.05,
  });
  const cta = c.subtitle
    ? fitText(c, c.subtitle, {
        size: s * 0.036,
        min: s * 0.024,
        maxWidth: safe * 0.7,
        maxLines: 2,
        weight: bold ? 700 : 500,
        tracking: minimal ? 0.06 : 0.01,
        lineHeight: 1.2,
      })
    : undefined;
  const stroke = Math.max(2, s * (bold ? 0.008 : minimal ? 0.0025 : 0.0045));
  const lineWidth = clamp(title.width * 0.24, s * 0.06, s * 0.16);
  const above = title.size * 0.34,
    below = title.size * 0.5;
  const button =
    cta && !minimal
      ? (() => {
          const height = cta.height + cta.size * 1.1;
          return {
            width: Math.max(cta.width + cta.size * 2.4, height * 2.6),
            height,
          };
        })()
      : undefined;
  const ctaWidth = button?.width ?? cta?.width ?? 0,
    ctaHeight = button?.height ?? cta?.height ?? 0;
  const blockWidth = Math.max(title.width, lineWidth, ctaWidth);
  const blockHeight =
    title.height + above + stroke + (cta ? below + ctaHeight : 0);
  const at = placeBlock(c, blockWidth, blockHeight);
  const align = at.column;
  const card =
    c.colors.background && c.colors.background !== "transparent"
      ? c.colors.background
      : c.colors.background === "transparent"
        ? undefined
        : defaults.card;
  const layers: MotionLayer[] = [];
  if (card) layers.push(background(c, card, true));
  layers.push(
    typeLayer(c, title, {
      name: "Title",
      left: alignedLeft(at.x, blockWidth, title.width, align),
      top: at.y,
      align,
      color: c.colors.text,
      title: true,
      start: t.at(4),
      leave: t.leaveAt(3),
    }),
  );
  const lineTop = at.y + title.height + above;
  layers.push(
    accentLine(c, {
      left: alignedLeft(at.x, blockWidth, lineWidth, align),
      top: lineTop,
      width: lineWidth,
      stroke,
      align,
      start: t.at(6),
      leave: t.leaveAt(2),
    }),
  );
  if (cta) {
    const top = lineTop + stroke + below;
    const left = alignedLeft(at.x, blockWidth, ctaWidth, align);
    if (button)
      layers.push(
        layer({
          type: "rectangle",
          name: "Button",
          x: left,
          y: top,
          width: button.width,
          height: button.height,
          radius: button.height / 2,
          background: bold ? c.colors.accent : "transparent",
          stroke: c.colors.accent,
          strokeWidth: bold ? 0 : Math.max(2, s * 0.003),
          keyframes: bold
            ? keys(
                {},
                {
                  at: t.at(8),
                  frames: t.len(12),
                  from: { opacity: 0, scale: 0.92 },
                  move: SETTLE,
                },
                { at: t.leaveAt(1), frames: t.exit, to: { opacity: 0 } },
              )
            : keys(
                {},
                { at: t.at(8), frames: t.len(16), from: { trim: 0 } },
                { at: t.leaveAt(1), frames: t.exit, to: { opacity: 0 } },
              ),
        }),
      );
    layers.push(
      typeLayer(c, cta, {
        name: "Call to action",
        left: button ? left + (button.width - cta.width) / 2 : left,
        top: button ? top + (button.height - cta.height) / 2 : top,
        align: button ? "center" : align,
        // Dark type on a filled button.
        color: bold ? (card ?? defaults.card) : c.colors.text,
        title: false,
        // Without a button it follows the accent line directly.
        start: t.at(button ? 10 : 8),
        leave: t.leaveAt(0),
      }),
    );
  }
  return layers;
}

function logoSting(c: Context): MotionLayer[] {
  const { s, t, style } = c;
  const bold = style === "bold",
    minimal = style === "minimal";
  const safe = c.area.right - c.area.left;
  const mark = s * (bold ? 0.17 : minimal ? 0.13 : 0.15);
  const ringSize = mark * 1.3;
  const ringStroke = Math.max(2, s * (minimal ? 0.0025 : 0.0045));
  const wide = c.w >= c.h;
  const gap = mark * 0.32;
  const room = (wide ? safe - ringSize - gap : safe) * 0.95;
  const word = fitText(c, c.text, {
    size: s * (bold ? 0.085 : minimal ? 0.065 : 0.075),
    min: s * 0.04,
    maxWidth: room,
    maxLines: 2,
    weight: bold ? 800 : minimal ? 500 : 700,
    tracking: minimal ? 0.06 : bold ? -0.02 : -0.01,
    lineHeight: 1.05,
  });
  const tag = c.subtitle
    ? fitText(c, c.subtitle, {
        size: s * 0.03,
        min: s * 0.02,
        maxWidth: room,
        maxLines: 2,
        weight: 400,
        tracking: minimal ? 0.08 : 0.02,
        lineHeight: 1.25,
      })
    : undefined;
  const tagGap = word.size * 0.3;
  const textWidth = Math.max(word.width, tag?.width ?? 0);
  const textHeight = word.height + (tag ? tagGap + tag.height : 0);
  const blockWidth = wide
    ? ringSize + gap + textWidth
    : Math.max(ringSize, textWidth);
  const blockHeight = wide
    ? Math.max(ringSize, textHeight)
    : ringSize + gap + textHeight;
  const at = placeBlock(c, blockWidth, blockHeight);
  const align = wide ? "left" : at.column;
  const center = wide
    ? { x: at.x + ringSize / 2, y: at.y + blockHeight / 2 }
    : {
        x: alignedLeft(at.x, blockWidth, ringSize, align) + ringSize / 2,
        y: at.y + ringSize / 2,
      };
  const textX = wide ? at.x + ringSize + gap : at.x;
  const textY = wide
    ? at.y + (blockHeight - textHeight) / 2
    : at.y + ringSize + gap;
  const columnWidth = wide ? textWidth : blockWidth;
  const card =
    c.colors.background === "transparent"
      ? undefined
      : (c.colors.background ?? defaults.card);
  const initial =
    Array.from(c.text.trim()).find((character) =>
      /[\p{L}\p{N}]/u.test(character),
    ) ?? Array.from(c.text.trim())[0];
  const monogram = fitText(c, initial.toUpperCase(), {
    size: mark * 0.5,
    min: 8,
    maxWidth: mark * 0.8,
    maxLines: 1,
    weight: 800,
    tracking: 0,
    lineHeight: 1,
  });
  const layers: MotionLayer[] = [];
  if (card) layers.push(background(c, card, false));
  layers.push(
    layer({
      type: "ellipse",
      name: "Ring",
      x: center.x - ringSize / 2,
      y: center.y - ringSize / 2,
      width: ringSize,
      height: ringSize,
      background: "transparent",
      stroke: c.colors.accent,
      strokeWidth: ringStroke,
      keyframes: keys(
        {},
        { at: 0, frames: t.len(18), from: { trim: 0 } },
        { at: t.leaveAt(3), frames: t.exit, to: { opacity: 0 } },
      ),
    }),
    layer({
      type: "ellipse",
      name: "Mark",
      x: center.x - mark / 2,
      y: center.y - mark / 2,
      width: mark,
      height: mark,
      background: c.colors.accent,
      keyframes: keys(
        {},
        {
          at: t.at(4),
          frames: t.len(16),
          from: { scale: 0 },
          move: bold ? SETTLE : ENTER,
        },
        { at: t.leaveAt(2), frames: t.exit, to: { opacity: 0, scale: 0.9 } },
      ),
    }),
    typeLayer(c, monogram, {
      name: "Monogram",
      left: center.x - monogram.width / 2,
      top: center.y - monogram.height / 2,
      align: "center",
      color: card ?? defaults.card,
      title: true,
      start: t.at(8),
      leave: t.leaveAt(2),
    }),
    typeLayer(c, word, {
      name: "Wordmark",
      left: alignedLeft(textX, columnWidth, word.width, align),
      top: textY,
      align,
      color: c.colors.text,
      title: true,
      start: t.at(12),
      leave: t.leaveAt(1),
    }),
  );
  if (tag)
    layers.push(
      typeLayer(c, tag, {
        name: "Tagline",
        left: alignedLeft(textX, columnWidth, tag.width, align),
        top: textY + word.height + tagGap,
        align,
        color: c.colors.text,
        opacity: 0.72,
        title: false,
        start: t.at(15),
        leave: t.leaveAt(0),
      }),
    );
  return layers;
}

/** The vertical band of visible captions overlapping [start, start + duration). */
function captionBand(p: Project, start: number, duration: number) {
  const hidden = new Set(
    p.tracks.filter((track) => track.hidden).map((track) => track.id),
  );
  const boxes = p.clips.filter(
    (clip) =>
      clip.kind === "caption" &&
      !hidden.has(clip.trackId) &&
      clip.start < start + duration &&
      clip.start + clip.duration > start,
  );
  if (!boxes.length) return undefined;
  return {
    top: Math.min(...boxes.map((clip) => clip.y)),
    bottom: Math.max(...boxes.map((clip) => clip.y + clip.height)),
  };
}

const builders: Record<MotionRecipeId, (c: Context) => MotionLayer[]> = {
  "kinetic-title": kineticTitle,
  "lower-third": lowerThird,
  callout,
  "end-card": endCard,
  "logo-sting": logoSting,
};

/**
 * One editable motion clip for a recipe at `start`, on a free text track.
 * Returns the creation commands, the layer names by index and warnings.
 */
export function createMotionRecipe(
  p: Project,
  start: number,
  options: MotionRecipeOptions,
) {
  const info = motionRecipes.find((recipe) => recipe.id === options.recipe);
  if (!info) throw Error("Choose a supported motion recipe.");
  if (options.point && options.recipe !== "callout")
    throw Error(
      "point applies only to the callout recipe; place other recipes with position.",
    );
  const text = options.text.trim();
  if (!text) throw Error("A motion recipe needs text.");
  const duration = options.durationFrames ?? Math.round(info.seconds * p.fps);
  if (!Number.isInteger(duration) || duration < 12 || duration > 18000)
    throw Error("Choose a recipe duration from 12 to 18,000 whole frames.");
  const warnings: string[] = [];
  const portrait = p.height > p.width;
  const context: Context = {
    w: p.width,
    h: p.height,
    // Phones show a vertical video's full width across the screen, so type
    // and spacing run a quarter larger there to stay readable.
    s: Math.min(p.width, p.height) * (portrait ? 1.25 : 1),
    style: options.style ?? "clean",
    colors: {
      text: options.colors?.text ?? defaults.text,
      accent: options.colors?.accent ?? defaults.accent,
      panel: options.colors?.panel ?? defaults.panel,
      background: options.colors?.background,
    },
    // Clear of the frame edge, and of captions and app buttons at the bottom
    // of tall videos.
    area: {
      left: Math.round(p.width * 0.06),
      right: Math.round(p.width * 0.94),
      top: Math.round(p.height * (portrait ? 0.1 : 0.08)),
      bottom: Math.round(p.height * (portrait ? 0.76 : 0.85)),
    },
    captions: captionBand(p, start, duration),
    position: options.position ?? info.position,
    point: options.point,
    text,
    subtitle: options.subtitle?.trim() || undefined,
    t: timing(p.fps, duration, info.id, info.name, warnings),
    name: info.name,
    warnings,
  };
  const layers = builders[info.id](context);
  const created = packageMotion(
    p,
    start,
    // A new track is named after the motion plus " · motion"; both stay
    // inside the 100 character limit.
    `${info.name} · ${text.replace(/\s+/gu, " ")}`.slice(0, 80).trim(),
    layers,
    duration,
    `recipe:${info.id}`,
  );
  created.clip.fontFamily = FAMILY;
  return {
    ...created,
    layers: layers.map((item) => item.name ?? item.type),
    warnings: [...new Set(warnings)],
  };
}
