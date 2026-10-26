import { animatedProperties, propertyBounds } from "./animation";
import { z } from "zod";
import {
  MAX_VECTOR_LAYERS,
  MAX_VECTOR_PATH_LENGTH,
  validateVectorPath,
  validateVectorViewBox,
} from "./vector-path";
import { StoryPlanSchema } from "./story-schema";
import { Model3DMetadataSchema } from "./model-3d";
export const uid = () => crypto.randomUUID();
export const fontFamilies = [
  "Arial",
  "Helvetica",
  "Georgia",
  "Courier New",
] as const;
const finite = z.number().finite();
/** The last timeline frame: 8 hours at 30 fps, 4 hours at 60. */
export const MAX_FRAME = 30 * 60 * 60 * 8;
const frame = finite.int().min(0).max(MAX_FRAME);
// Only the hex lengths CSS reads. Browsers drop other lengths, so preview and
// export would fall back to different inherited colors.
const color = z
  .string()
  .regex(
    /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent)$/,
    "Use a hex color with 3, 4, 6 or 8 digits, or transparent.",
  );
export const presets = [
  "none",
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
  "pulse",
  "glow",
  "swing",
  "custom",
] as const;
export const WordSchema = z.object({
  text: z.string().max(500),
  start: finite.min(0),
  end: finite.min(0),
});
export const RhythmSchema = z
  .object({
    version: z.literal(1),
    source: z.enum(["detected", "manual", "generated"]).optional(),
    bpm: finite.min(20).max(300).optional(),
    confidence: finite.min(0).max(1),
    duration: finite.min(0).max(1200),
    beats: z
      .array(
        z.object({
          time: finite.min(0).max(1200),
          strength: finite.min(0).max(1),
        }),
      )
      .max(10000),
    envelope: z.object({
      step: finite.min(0.001).max(1200),
      values: z.array(finite.min(0).max(1)).max(24001),
    }),
  })
  .superRefine((r, ctx) => {
    if (
      r.beats.some(
        (b, i) =>
          b.time > r.duration || (i > 0 && b.time <= r.beats[i - 1].time),
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Beat times must be increasing and within the analyzed duration",
      });
  });
export type Rhythm = z.infer<typeof RhythmSchema>;
export const MusicReactiveSchema = z.object({
  musicClipId: z.string(),
  scope: z.enum(["clip", "accents"]).optional(),
  mode: z.enum(["beat", "energy"]).default("beat"),
  style: z.enum(["scale", "glow", "both"]).default("both"),
  amount: finite.min(0).max(1).default(0.35),
  releaseFrames: finite.int().min(1).max(600).default(6),
});
export const AssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["video", "audio", "image"]),
  path: z.string(),
  duration: finite.min(0),
  width: finite.optional(),
  height: finite.optional(),
  fps: finite.optional(),
  hasAudio: z.boolean().default(false),
  thumbnail: z.string().optional(),
  proxy: z.string().optional(),
  /** Editable scene source and its immutable local render. Older editors play the render. */
  composition: z
    .object({
      engine: z.literal("hyperframes"),
      entry: z.string().min(1),
      source: z.string().min(1).max(1_000_000),
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
      engineVersion: z.string().min(1).max(40),
      transparent: z.boolean(),
      model3d: Model3DMetadataSchema.optional(),
    })
    .optional(),
  /** This Mac's cached copy that plays the media backwards, for reversed clips. */
  reversed: z.string().optional(),
  /**
   * This Mac's backwards copy of only the part reversed clips use, from
   * reversedSpan.from to reversedSpan.to seconds before the media's end.
   * Versions without it ignore it and make a whole copy.
   */
  reversedPart: z.string().optional(),
  reversedSpan: z.object({ from: finite.min(0), to: finite.min(0) }).optional(),
  waveform: z.array(finite).optional(),
  words: z.array(WordSchema).optional(),
  rhythm: RhythmSchema.optional(),
  origin: z
    .object({
      provider: z.string(),
      page: z.string().url(),
      creator: z.string(),
      license: z.string(),
      licenseUrl: z.string(),
      title: z.string(),
      sourceId: z.string().optional(),
      downloadedAt: z.string().optional(),
    })
    .optional(),
});
export const KeyframeSchema = z.object({
  frame,
  x: finite.min(-4000).max(4000).optional(),
  y: finite.min(-4000).max(4000).optional(),
  opacity: finite.min(0).max(1).optional(),
  scale: finite.min(0).max(10).optional(),
  rotate: finite.min(-3600).max(3600).optional(),
  rotateX: finite.min(-85).max(85).optional(),
  rotateY: finite.min(-85).max(85).optional(),
  perspective: finite.min(200).max(8000).optional(),
  blur: finite.min(0).max(100).optional(),
  trim: finite.min(0).max(1).optional(),
  strokeWidth: finite.min(0).max(100).optional(),
  fillOpacity: finite.min(0).max(1).optional(),
  easing: z
    .enum([
      "linear",
      "ease-in",
      "ease-out",
      "ease-in-out",
      "hold",
      "spring",
      "back",
      "cubic-bezier",
    ])
    .default("linear"),
  bezier: z
    .tuple([
      finite.min(0).max(1),
      finite.min(-2).max(3),
      finite.min(0).max(1),
      finite.min(-2).max(3),
    ])
    .optional(),
});
const VectorGradientSchema = z.object({
  type: z.enum(["linear", "radial"]),
  units: z.enum(["objectBoundingBox", "userSpaceOnUse"]),
  x1: finite.optional(),
  y1: finite.optional(),
  x2: finite.optional(),
  y2: finite.optional(),
  cx: finite.optional(),
  cy: finite.optional(),
  r: finite.min(0).optional(),
  fx: finite.optional(),
  fy: finite.optional(),
  transform: z
    .tuple([finite, finite, finite, finite, finite, finite])
    .optional(),
  spread: z.enum(["pad", "reflect", "repeat"]).default("pad"),
  stops: z
    .array(
      z.object({
        offset: finite.min(0).max(1),
        color,
        opacity: finite.min(0).max(1).default(1),
      }),
    )
    .min(1)
    .max(16),
});
export const MotionLayerSchema = z
  .object({
    name: z.string().max(80).optional(),
    hidden: z.boolean().default(false),
    type: z.enum([
      "text",
      "rectangle",
      "ellipse",
      "triangle",
      "star",
      "line",
      "path",
    ]),
    vectorPath: z.string().max(MAX_VECTOR_PATH_LENGTH).optional(),
    vectorViewBox: z
      .tuple([finite, finite, finite.positive(), finite.positive()])
      .optional(),
    vectorTransform: z
      .tuple([finite, finite, finite, finite, finite, finite])
      .optional(),
    vectorFillRule: z.enum(["nonzero", "evenodd"]).default("nonzero"),
    vectorLineCap: z.enum(["butt", "round", "square"]).optional(),
    vectorLineJoin: z.enum(["miter", "round", "bevel"]).optional(),
    vectorAspectRatio: z.enum(["meet", "none"]).default("meet"),
    /** Imported SVG gradient fill; replaces background while present. */
    vectorGradient: VectorGradientSchema.optional(),
    text: z.string().max(1000).default(""),
    x: finite.min(-4000).max(4000).default(0),
    y: finite.min(-4000).max(4000).default(0),
    width: finite.min(1).max(4000).default(600),
    height: finite.min(1).max(4000).default(120),
    color: color.default("#ffffff"),
    background: color.default("transparent"),
    fontSize: finite.min(8).max(500).default(64),
    fontWeight: finite.int().min(100).max(900).optional(),
    fontFamily: z.enum(fontFamilies).optional(),
    fontStyle: z.enum(["normal", "italic"]).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    letterSpacing: finite.min(-30).max(100).default(0),
    lineHeight: finite.min(0.8).max(2.4).default(1.18),
    musicAccent: z.boolean().optional(),
    radius: finite.min(0).max(2000).default(0),
    opacity: finite.min(0).max(1).default(1),
    fillOpacity: finite.min(0).max(1).default(1),
    scale: finite.min(0).max(10).default(1),
    rotate: finite.min(-3600).max(3600).default(0),
    /** Editable 2.5D plane tilt, in degrees, around the layer anchor. */
    rotateX: finite.min(-85).max(85).default(0),
    rotateY: finite.min(-85).max(85).default(0),
    /** Perspective distance in authored canvas pixels. */
    perspective: finite.min(200).max(8000).default(1000),
    stroke: color.default("#ffffff"),
    strokeWidth: finite.min(0).max(100).default(0),
    fillStyle: z.enum(["solid", "gradient"]).default("solid"),
    gradientColor: color.default("#6c5ce7"),
    gradientAngle: finite.min(-3600).max(3600).default(135),
    glow: finite.min(0).max(100).default(0),
    blur: finite.min(0).max(100).default(0),
    trim: finite.min(0).max(1).default(1),
    anchorX: finite.min(0).max(1).default(0.5),
    anchorY: finite.min(0).max(1).default(0.5),
    textAnimation: z
      .enum([
        "none",
        "character-rise",
        "word-rise",
        "typewriter",
        "line-reveal",
      ])
      .default("none"),
    textRevealStart: frame.default(0),
    textRevealFrames: finite.int().min(1).max(1800).default(18),
    staggerFrames: finite.int().min(1).max(30).default(2),
    loop: z.enum(["none", "cycle", "ping-pong"]).default("none"),
    loopFrames: finite.int().min(1).max(1800).default(60),
    keyframes: z.array(KeyframeSchema).max(100).default([]),
  })
  .superRefine((layer, ctx) => {
    if (layer.type !== "path") return;
    try {
      if (!layer.vectorPath || !layer.vectorViewBox)
        throw Error("Path layers require vectorPath and vectorViewBox.");
      validateVectorPath(layer.vectorPath);
      validateVectorViewBox(layer.vectorViewBox);
      if (layer.vectorTransform?.some((n) => Math.abs(n) > 1e7))
        throw Error("Vector transform exceeds safe coordinate bounds.");
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  });
export const MotionSchema = z.object({
  id: z.string(),
  name: z.string().max(100),
  layers: z.array(MotionLayerSchema).min(1).max(MAX_VECTOR_LAYERS),
  source: z.string().optional(),
});
export const PropertyKeyframeSchema = z
  .object({
    property: z.enum(animatedProperties),
    frame,
    value: finite,
    easing: z
      .enum([
        "linear",
        "ease-in",
        "ease-out",
        "ease-in-out",
        "hold",
        "spring",
        "back",
        "cubic-bezier",
      ])
      .default("ease-in-out"),
    bezier: KeyframeSchema.shape.bezier,
  })
  .superRefine((k, ctx) => {
    const [min, max] = propertyBounds[k.property];
    if (k.value < min || k.value > max)
      ctx.addIssue({
        code: "custom",
        message: `${k.property} must be between ${min} and ${max}`,
      });
  });
export const ClipSchema = z.object({
  musicReactive: MusicReactiveSchema.optional(),
  keyframes: z.array(PropertyKeyframeSchema).max(2000).default([]),
  animationOffset: frame.default(0),
  scale: finite.min(0.01).max(10).default(1),
  /** Editable 2.5D plane tilt around the clip center, in degrees. */
  rotateX: finite.min(-85).max(85).default(0),
  rotateY: finite.min(-85).max(85).default(0),
  /** Perspective distance in authored canvas pixels. */
  perspective: finite.min(200).max(8000).default(1000),
  blendMode: z
    .enum(["normal", "multiply", "screen", "overlay", "lighten", "darken"])
    .default("normal"),
  mask: z.enum(["none", "ellipse", "rounded"]).default("none"),
  cornerRadius: finite.min(0).max(2000).default(32),
  shadowBlur: finite.min(0).max(200).default(0),
  shadowX: finite.min(-500).max(500).default(0),
  shadowY: finite.min(-500).max(500).default(8),
  shadowColor: color.default("#000000"),
  id: z.string(),
  trackId: z.string(),
  kind: z.enum(["video", "audio", "image", "text", "caption"]),
  assetId: z.string().optional(),
  start: frame,
  duration: frame.min(1),
  sourceIn: finite.min(0).default(0),
  speed: finite.min(0.1).max(8).default(1),
  /**
   * Plays the footage backwards from a reversed copy of the media. sourceIn
   * then counts from the end of the source, so trims and splits work as on
   * any clip; switching it on or off keeps the same footage.
   */
  reverse: z.boolean().default(false),
  /** Holds the clip's first frame for its whole duration, silently. */
  freeze: z.boolean().default(false),
  volume: finite.min(0).max(2).default(1),
  /** Explicit sound role for review; unlabelled legacy clips stay unclassified. */
  audioRole: z.enum(["voice", "music", "sfx", "mixed"]).optional(),
  transition: z
    .object({
      kind: z.enum(["crossfade", "black", "slide-left", "slide-right", "wipe"]),
      frames: frame.min(2),
      fromId: z.string(),
    })
    .optional(),
  fadeIn: frame.default(0),
  fadeOut: frame.default(0),
  x: finite.min(-8000).max(8000).default(0),
  y: finite.min(-8000).max(8000).default(0),
  width: finite.min(1).max(8000).default(1080),
  height: finite.min(1).max(8000).default(1920),
  rotation: finite.min(-3600).max(3600).default(0),
  opacity: finite.min(0).max(1).default(1),
  fit: z.enum(["cover", "contain"]).default("cover"),
  crop: z
    .object({
      top: finite.min(0).max(45),
      right: finite.min(0).max(45),
      bottom: finite.min(0).max(45),
      left: finite.min(0).max(45),
    })
    .default({ top: 0, right: 0, bottom: 0, left: 0 }),
  text: z.string().max(10000).default(""),
  fontSize: finite.min(8).max(500).default(72),
  fontFamily: z.enum(fontFamilies).default("Arial"),
  fontWeight: z.enum(["400", "600", "800"]).default("800"),
  color: color.default("#ffffff"),
  background: color.default("transparent"),
  accent: color.default("#c6f16d"),
  align: z.enum(["left", "center", "right"]).default("center"),
  preset: z.enum(presets).default("none"),
  motionId: z.string().optional(),
  words: z.array(WordSchema).default([]),
  highlight: z.boolean().default(true),
  captionStyle: z
    .enum([
      "standard",
      "karaoke",
      "pop",
      "box",
      "typewriter",
      "outline",
      "focus",
      "minimal",
      "pill",
      "clean",
      "heavy",
    ])
    .default("standard"),
  captionLayout: z.enum(["legacy", "balanced"]).default("legacy"),
  captionCase: z.enum(["original", "upper"]).default("original"),
  captionMaxLines: z.union([z.literal(1), z.literal(2)]).default(2),
  captionStrokeWidth: finite.min(0).max(12).default(2),
  captionTracking: finite.min(-5).max(20).default(0),
  captionSourceId: z.string().optional(),
  overlay: z
    .enum(["none", "film-grain", "light-leak", "vhs", "halftone"])
    .default("none"),
  overlayAmount: finite.min(0).max(1).default(0.5),
  look: z
    .enum([
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
    ])
    .default("none"),
  effectAmount: finite.min(0).max(1).default(1),
  brightness: finite.min(0.2).max(2).default(1),
  contrast: finite.min(0.2).max(2).default(1),
  saturation: finite.min(0).max(2).default(1),
  blur: finite.min(0).max(30).default(0),
  /** Horizontal red/blue channel separation in clip pixels. */
  rgbSplit: finite.min(0).max(30).default(0),
  /** 0 preserves colors; 1 fully inverts this clip. */
  invert: finite.min(0).max(1).default(0),
  vignette: finite.min(0).max(1).default(0),
  cameraMotion: z
    .enum([
      "none",
      "zoom-in",
      "zoom-out",
      "pan-left",
      "pan-right",
      "handheld",
      "slow-orbit",
      "punch-in",
      "breathe",
    ])
    .default("none"),
  animationFrames: frame.min(1).max(600).default(18),
  exitAnimation: z.enum(["none", "fade", "slide", "shrink"]).default("none"),
});
export const TrackSchema = z.object({
  id: z.string(),
  name: z.string().max(100),
  kind: z.enum(["video", "audio", "text"]),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
});
/**
 * Raise only for changes an older Cutline cannot read safely. Older builds then
 * refuse the file instead of rewriting it. New fields with neutral defaults keep
 * version 1: validateProject carries fields it does not know through edits.
 */
export const PROJECT_VERSION = 1;
export const MOTION_LIMIT = 400;
export const motionLimitMessage = `This project has reached ${MOTION_LIMIT} motion designs, the most it can hold. Delete a motion graphic you no longer use, then try again.`;
export const ProjectSchema = z.object({
  version: z.literal(PROJECT_VERSION),
  id: z.string(),
  name: z.string().min(1).max(200),
  revision: frame,
  width: finite.int().min(320).max(3840),
  height: finite.int().min(320).max(3840),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
  background: color,
  assets: z.array(AssetSchema).max(1000),
  tracks: z.array(TrackSchema).max(64),
  clips: z.array(ClipSchema).max(10000),
  motions: z.array(MotionSchema).max(MOTION_LIMIT),
  story: StoryPlanSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Motion = z.infer<typeof MotionSchema>;
export type MotionLayer = z.infer<typeof MotionLayerSchema>;
export type MotionKeyframe = z.infer<typeof KeyframeSchema>;
export type Word = z.infer<typeof WordSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Snapshot = {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
  filePath: string | null;
  missing: string[];
};
export type Job = {
  id: string;
  kind: string;
  state: "running" | "done" | "error" | "cancelled";
  progress: number;
  message: string;
  output?: string;
  listening?: {
    status: "passed" | "needs-review" | "incomplete" | "no-audio";
    fixes: number;
    reportPath: string;
    summary: string;
  };
};
export function newProject(): Project {
  return {
    version: 1,
    id: uid(),
    name: "Untitled project",
    revision: 0,
    width: 1080,
    height: 1920,
    fps: 30,
    background: "#101112",
    assets: [],
    tracks: [
      {
        id: "titles",
        name: "Titles",
        kind: "text",
        muted: false,
        hidden: false,
      },
      {
        id: "captions",
        name: "Captions",
        kind: "text",
        muted: false,
        hidden: false,
      },
      {
        id: "video",
        name: "Video",
        kind: "video",
        muted: false,
        hidden: false,
      },
      {
        id: "audio",
        name: "Music & audio",
        kind: "audio",
        muted: false,
        hidden: false,
      },
    ],
    clips: [],
    motions: [],
  };
}
export function duration(p: Project) {
  return Math.max(1, ...p.clips.map((c) => c.start + c.duration));
}
export function makeClip(
  p: Project,
  kind: Clip["kind"],
  trackId: string,
  start = 0,
  asset?: Asset,
): Clip {
  return ClipSchema.parse({
    id: uid(),
    kind,
    trackId,
    start,
    duration:
      asset && asset.kind !== "image"
        ? Math.max(1, Math.floor(asset.duration * p.fps))
        : p.fps * 4,
    assetId: asset?.id,
    width: p.width,
    height: kind === "text" || kind === "caption" ? 180 : p.height,
    y:
      kind === "text"
        ? p.height * 0.38
        : kind === "caption"
          ? p.height * 0.76
          : 0,
    text: kind === "text" ? "Your story starts here" : "",
    preset: kind === "text" ? "spring" : "none",
    // A 0.6 second entrance at any frame rate, not 18 frames.
    ...(kind === "text" || kind === "caption"
      ? { animationFrames: Math.max(1, Math.round(p.fps * 0.6)) }
      : {}),
  });
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Keys that would change an object's prototype instead of storing data.
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
function innerSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable)
      current = current.unwrap() as z.ZodType;
    else if (current instanceof z.ZodDefault)
      current = current.removeDefault() as z.ZodType;
    else if (current instanceof z.ZodPipe) current = current.out as z.ZodType;
    else return current;
  }
}
/**
 * Zod drops keys it does not know. Copy them back so a project saved by a newer
 * Cutline keeps its newer fields when this version edits and autosaves it.
 */
function keepUnknownFields(schema: z.ZodType, input: unknown, output: unknown) {
  const s = innerSchema(schema);
  if (s instanceof z.ZodArray) {
    const element = innerSchema(s.element as z.ZodType);
    if (
      !(element instanceof z.ZodObject || element instanceof z.ZodArray) ||
      !Array.isArray(input) ||
      !Array.isArray(output) ||
      input.length !== output.length
    )
      return;
    for (let i = 0; i < input.length; i++)
      keepUnknownFields(element, input[i], output[i]);
    return;
  }
  if (!(s instanceof z.ZodObject) || !isRecord(input) || !isRecord(output))
    return;
  const shape = s.shape as Record<string, z.ZodType>;
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(shape, key))
      keepUnknownFields(shape[key], input[key], output[key]);
    else if (!unsafeKeys.has(key) && !Object.hasOwn(output, key))
      output[key] = input[key];
  }
}
// Older builds accepted 5 and 7 digit hex, which CSS ignores. Repair saved
// values to the nearest readable color so such projects still open.
const legacyHex = /^#(?:[0-9a-fA-F]{5}|[0-9a-fA-F]{7})$/;
const repairHex = (value: unknown) =>
  typeof value === "string" && legacyHex.test(value)
    ? value.length === 6
      ? value + value[5]
      : value.slice(0, 7)
    : value;
const clipColorFields = ["color", "background", "accent", "shadowColor"];
const layerColorFields = ["color", "background", "stroke", "gradientColor"];
function repairLegacyColors(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const records = (list: unknown) =>
    Array.isArray(list) ? list.filter(isRecord) : [];
  const layers = (motions: unknown) =>
    records(motions).flatMap((m) => records(m.layers));
  const stale = (item: Record<string, unknown>, fields: string[]) =>
    fields.some((field) => repairHex(item[field]) !== item[field]);
  if (
    !stale(input, ["background"]) &&
    !records(input.clips).some((c) => stale(c, clipColorFields)) &&
    !layers(input.motions).some((l) => stale(l, layerColorFields))
  )
    return input;
  const copy = structuredClone(input);
  const fix = (item: Record<string, unknown>, fields: string[]) => {
    for (const field of fields)
      if (repairHex(item[field]) !== item[field])
        item[field] = repairHex(item[field]);
  };
  fix(copy, ["background"]);
  for (const c of records(copy.clips)) fix(c, clipColorFields);
  for (const l of layers(copy.motions)) fix(l, layerColorFields);
  return copy;
}
export function validateProject(input: unknown): Project {
  if (isRecord(input)) {
    if (Array.isArray(input.assets)) {
      let sourceSize = 0;
      for (const asset of input.assets) {
        if (
          isRecord(asset) &&
          isRecord(asset.composition) &&
          typeof asset.composition.source === "string"
        )
          sourceSize += asset.composition.source.length;
        if (sourceSize > 16_000_000)
          throw Error(
            "This project contains too much scene source. Split the scenes into separate projects.",
          );
      }
    }
    if (typeof input.version === "number" && input.version > PROJECT_VERSION)
      throw Error(
        "This project was saved by a newer version of Cutline. Update Cutline to open it.",
      );
    if (Array.isArray(input.motions) && input.motions.length > MOTION_LIMIT)
      throw Error(motionLimitMessage);
  }
  const source = repairLegacyColors(input);
  const p = ProjectSchema.parse(source);
  keepUnknownFields(ProjectSchema, source, p);
  const ids = new Set<string>();
  for (const item of [...p.assets, ...p.tracks, ...p.clips, ...p.motions]) {
    if (ids.has(item.id)) throw Error("Duplicate object ID");
    ids.add(item.id);
  }
  for (const asset of p.assets)
    if (asset.composition && asset.kind !== "video")
      throw Error("An HTML scene must reference a rendered video asset.");
  for (const c of p.clips) {
    const last = new Map<string, number>();
    for (const k of c.keyframes) {
      if (k.frame <= (last.get(k.property) ?? -1))
        throw Error(
          "Property keyframes must be unique and increasing per property",
        );
      last.set(k.property, k.frame);
    }
    if (!p.tracks.some((t) => t.id === c.trackId))
      throw Error("Clip track is missing");
    if (c.assetId && !p.assets.some((a) => a.id === c.assetId))
      throw Error("Clip media is missing");
    if (["audio", "video", "image"].includes(c.kind) && !c.assetId)
      throw Error("Media clip requires an asset");
    if (c.preset === "custom" && !p.motions.some((m) => m.id === c.motionId))
      throw Error("Animation is missing");
    const a = p.assets.find((a) => a.id === c.assetId);
    if (a?.composition?.transparent && c.reverse)
      throw Error(
        "Reverse is unavailable for transparent scenes. Reverse the animation in its HTML source instead.",
      );
    // A held frame can run longer than its source; it only needs that frame.
    if (
      a &&
      a.kind !== "image" &&
      (c.freeze ? c.sourceIn : c.sourceIn + (c.duration / p.fps) * c.speed) >
        a.duration + 1 / p.fps
    )
      throw Error("Trim exceeds source media");
    for (const w of c.words)
      if (w.end < w.start) throw Error("Invalid word timing");
  }
  return p;
}
export function publicProject(p: Project) {
  return {
    ...p,
    assets: p.assets.map(
      ({
        path,
        thumbnail,
        proxy,
        reversed,
        reversedPart,
        reversedSpan,
        rhythm,
        composition,
        ...a
      }) => ({
        ...a,
        ...(composition
          ? {
              composition: {
                engine: composition.engine,
                sourceHash: composition.sourceHash,
                engineVersion: composition.engineVersion,
                transparent: composition.transparent,
                ...(composition.model3d
                  ? { model3d: composition.model3d }
                  : {}),
              },
            }
          : {}),
        ...(rhythm ? { rhythm: publicRhythm(rhythm) } : {}),
      }),
    ),
  };
}
/** Agents request beat pages through music.inspect instead of receiving thousands of RMS samples on every read. */
export function publicRhythm(r: Rhythm) {
  return {
    version: r.version,
    source: r.source,
    bpm: r.bpm,
    confidence: r.confidence,
    duration: r.duration,
    beatCount: r.beats.length,
    energyMeasured: !!r.envelope.values.length,
    envelopeStep: r.envelope.step,
  };
}
