import {
  MotionSchema,
  MotionLayerSchema,
  makeClip,
  newProject,
  uid,
  validateProject,
  type Project,
  type Motion,
  type Clip,
} from "./model";
import { newTrack } from "./layers";
import { motionProperties, motionRevealStart, motionValue } from "./motion";
import { applyCommands, type Command } from "./commands";
import {
  isStudioScene,
  studioSceneIds,
  studioScenes,
  studioSceneLayers,
  studioPalette,
  type StudioSceneId,
} from "./studio-presets";
import {
  isSignatureScene,
  signatureSceneIds,
  signatureScenes,
  signatureSceneLayers,
  signaturePalette,
  type SignatureSceneId,
} from "./signature-presets";
import {
  isLogoScene,
  logoSceneIds,
  logoScenes,
  logoSceneLayers,
  logoPalette,
  type LogoSceneId,
} from "./logo-presets";
import {
  isPromoScene,
  promoSceneIds,
  promoScenes,
  promoSceneLayers,
  promoClipKeyframes,
  type PromoSceneId,
} from "./promo-presets";
import {
  isEditorialScene,
  editorialSceneIds,
  editorialScenes,
  editorialSceneLayers,
  type EditorialSceneId,
} from "./editorial-presets";
import {
  isCreatorStudioScene,
  creatorStudioSceneIds,
  creatorStudioScenes,
  creatorStudioSceneLayers,
  type CreatorStudioSceneId,
} from "./creator-studio-presets";
export {
  studioSceneIds,
  studioScenes,
  studioPalette,
  studioAccentLayers,
} from "./studio-presets";
export {
  signatureSceneIds,
  signatureScenes,
  signaturePalette,
} from "./signature-presets";
export { logoSceneIds, logoScenes, logoPalette } from "./logo-presets";
export { promoSceneIds, promoScenes } from "./promo-presets";
export { editorialSceneIds, editorialScenes } from "./editorial-presets";
export {
  creatorStudioSceneIds,
  creatorStudioScenes,
} from "./creator-studio-presets";

export const shapeTypes = [
  "rectangle",
  "ellipse",
  "triangle",
  "star",
  "line",
] as const;
export type ShapeType = (typeof shapeTypes)[number];
export const motionSceneIds = [
  ...creatorStudioSceneIds,
  ...editorialSceneIds,
  ...promoSceneIds,
  ...logoSceneIds,
  ...signatureSceneIds,
  ...studioSceneIds,
  "kinetic-title",
  "orbit-logo",
  "neon-reveal",
  "lower-third",
  "social-pop",
  "geometric-burst",
  "minimal-type",
  "title-card",
] as const;
export type MotionSceneId = (typeof motionSceneIds)[number];
export const motionScenes: ReadonlyArray<{
  id: MotionSceneId;
  name: string;
  description: string;
  category: string;
  color: string;
}> = [
  ...creatorStudioScenes,
  ...editorialScenes,
  ...promoScenes,
  ...logoScenes,
  ...signatureScenes,
  ...studioScenes,
  {
    id: "kinetic-title",
    name: "Kinetic title",
    description: "Letter rise · sliding color blocks",
    category: "Titles",
    color: "#c6f16d",
  },
  {
    id: "orbit-logo",
    name: "Orbit",
    description: "Rotating rings · a luminous center",
    category: "Loops",
    color: "#ad9bff",
  },
  {
    id: "neon-reveal",
    name: "Neon reveal",
    description: "Drawn lines · glow · text reveal",
    category: "Titles",
    color: "#8ef4ef",
  },
  {
    id: "lower-third",
    name: "Studio lower third",
    description: "Spring panels · name and role",
    category: "Overlays",
    color: "#b9ee95",
  },
  {
    id: "social-pop",
    name: "Social pop",
    description: "Spinning star · punchy word reveal",
    category: "Titles",
    color: "#ffabde",
  },
  {
    id: "geometric-burst",
    name: "Shape burst",
    description: "Choreographed shapes · elastic reveal",
    category: "Loops",
    color: "#ffb97a",
  },
  {
    id: "minimal-type",
    name: "Editorial",
    description: "Word rise · understated line animation",
    category: "Titles",
    color: "#dad4c8",
  },
  {
    id: "title-card",
    name: "Next up",
    description: "Gradient cards · staggered type",
    category: "Titles",
    color: "#a9beff",
  },
];

/** The picker and agents share the same catalog, including newly added sets. */
export const motionSceneCategories = [
  "All",
  ...new Set(motionScenes.map((scene) => scene.category)),
];

type Key = {
  frame: number;
  x?: number;
  y?: number;
  opacity?: number;
  scale?: number;
  rotate?: number;
  blur?: number;
  trim?: number;
  strokeWidth?: number;
  easing?:
    | "linear"
    | "ease-in"
    | "ease-out"
    | "ease-in-out"
    | "hold"
    | "spring"
    | "back"
    | "cubic-bezier";
  bezier?: [number, number, number, number];
};
type Layer = Motion["layers"][number];
type CreatedMotion = { clip: Clip; motion: Motion; commands: Command[] };
export type MotionSceneOptions = { durationFrames?: number };

function sceneLayers(
  p: Project,
  id: Exclude<
    MotionSceneId,
    | StudioSceneId
    | SignatureSceneId
    | LogoSceneId
    | PromoSceneId
    | EditorialSceneId
    | CreatorStudioSceneId
  >,
): Layer[] {
  const w = p.width,
    h = p.height,
    s = Math.min(w, h);
  const f = (n: number) => Math.round((n * p.fps) / 30);
  const k = (keys: Key[]) =>
    keys.map((key) => ({ ...key, frame: f(key.frame) }));
  const layer = (
    type: string,
    x: number,
    y: number,
    width: number,
    height: number,
    extra: Record<string, unknown> = {},
    keys: Key[] = [{ frame: 0 }],
  ): Layer =>
    MotionLayerSchema.parse({
      type,
      x: x * w,
      y: y * h,
      width: Math.max(1, width * w),
      height: Math.max(1, height * h),
      fontSize: Math.max(8, s * 0.09),
      keyframes: k(keys),
      ...extra,
    });
  const text = (
    value: string,
    x: number,
    y: number,
    width: number,
    height: number,
    size: number,
    color = "#ffffff",
    extra: Record<string, unknown> = {},
    keys?: Key[],
  ) =>
    layer(
      "text",
      x,
      y,
      width,
      height,
      {
        text: value,
        color,
        fontSize: Math.max(8, Math.min(500, s * size)),
        ...extra,
      },
      keys,
    );
  const bg = (a: string, b?: string) =>
    layer("rectangle", 0, 0, 1, 1, {
      background: a,
      fillStyle: b ? "gradient" : "solid",
      gradientColor: b ?? a,
      gradientAngle: 135,
    });
  const enter = (delay = 0, amount = s * 0.08): Key[] =>
    delay > 0
      ? [
          { frame: 0, opacity: 0, y: amount, easing: "hold" },
          { frame: delay, opacity: 0, y: amount, easing: "spring" },
          { frame: delay + 22, opacity: 1, y: 0 },
          { frame: 106, opacity: 1, y: 0, easing: "ease-in" },
          { frame: 119, opacity: 0, y: amount === 0 ? 0 : -amount * 0.5 },
        ]
      : [
          { frame: 0, opacity: 0, y: amount, easing: "spring" },
          { frame: 22, opacity: 1, y: 0 },
          { frame: 106, opacity: 1, y: 0, easing: "ease-in" },
          { frame: 119, opacity: 0, y: amount === 0 ? 0 : -amount * 0.5 },
        ];
  switch (id) {
    case "kinetic-title":
      return [
        bg("#161918"),
        layer(
          "rectangle",
          0.1,
          0.48,
          0.8,
          0.2,
          { background: "#c6f16d", radius: s * 0.02 },
          [
            { frame: 0, scale: 0.05, opacity: 0, rotate: -8, easing: "back" },
            { frame: 26, scale: 1, opacity: 1, rotate: 0 },
            { frame: 104, scale: 1, opacity: 1, easing: "ease-in" },
            { frame: 119, scale: 0.05, opacity: 0 },
          ],
        ),
        text(
          "MAKE IT",
          0.08,
          0.27,
          0.84,
          0.19,
          0.125,
          "#f5f7f0",
          { textAnimation: "character-rise", staggerFrames: f(2) },
          enter(4),
        ),
        text(
          "MOVE",
          0.1,
          0.49,
          0.8,
          0.17,
          0.145,
          "#151b10",
          { textAnimation: "character-rise", staggerFrames: f(3) },
          enter(15),
        ),
        text(
          "YOUR NEXT BIG IDEA",
          0.13,
          0.73,
          0.74,
          0.07,
          0.022,
          "#a4b09e",
          {},
          enter(26, s * 0.025),
        ),
        layer(
          "line",
          0.36,
          0.21,
          0.28,
          0.002,
          { stroke: "#c6f16d", strokeWidth: s * 0.004 },
          [
            { frame: 0, trim: 0, easing: "ease-out" },
            { frame: 24, trim: 1 },
          ],
        ),
      ];
    case "orbit-logo":
      return [
        bg("#151222", "#242036"),
        layer(
          "ellipse",
          0.5 - (s * 0.31) / w,
          0.5 - (s * 0.31) / h,
          (s * 0.62) / w,
          (s * 0.62) / h,
          {
            background: "transparent",
            stroke: "#66558f",
            strokeWidth: s * 0.0025,
            rotate: -25,
            opacity: 0.65,
            loop: "cycle",
            loopFrames: f(120),
          },
          [
            { frame: 0, rotate: -25, trim: 0.75, easing: "linear" },
            { frame: 120, rotate: 335, trim: 0.75 },
          ],
        ),
        layer(
          "ellipse",
          0.5 - (s * 0.24) / w,
          0.5 - (s * 0.24) / h,
          (s * 0.48) / w,
          (s * 0.48) / h,
          {
            background: "transparent",
            stroke: "#b69dfb",
            strokeWidth: s * 0.009,
            glow: s * 0.016,
            loop: "cycle",
            loopFrames: f(120),
          },
          [
            { frame: 0, rotate: 0, trim: 0.83, easing: "linear" },
            { frame: 120, rotate: -360, trim: 0.83 },
          ],
        ),
        layer(
          "ellipse",
          0.5 - (s * 0.185) / w,
          0.5 - (s * 0.185) / h,
          (s * 0.37) / w,
          (s * 0.37) / h,
          {
            background: "#a88af4",
            fillStyle: "gradient",
            gradientColor: "#5c46a4",
            glow: s * 0.026,
          },
          [
            { frame: 0, scale: 0, opacity: 0, easing: "spring" },
            { frame: 28, scale: 1, opacity: 1 },
          ],
        ),
        text("C", 0.35, 0.4, 0.3, 0.2, 0.21, "#f9f5ff", {}, enter(8)),
        text(
          "CREATE WITHOUT LIMITS",
          0.08,
          0.78,
          0.84,
          0.06,
          0.025,
          "#d0c4ef",
          { textAnimation: "character-rise", staggerFrames: f(1) },
          enter(24, s * 0.015),
        ),
      ];
    case "neon-reveal":
      return [
        bg("#071a20", "#111427"),
        layer(
          "rectangle",
          0.13,
          0.25,
          0.74,
          0.49,
          {
            background: "transparent",
            stroke: "#74e6df",
            strokeWidth: s * 0.003,
            radius: s * 0.025,
            glow: s * 0.025,
          },
          [
            { frame: 0, trim: 0, opacity: 0, easing: "ease-out" },
            { frame: 34, trim: 1, opacity: 1 },
          ],
        ),
        text(
          "AFTER",
          0.16,
          0.31,
          0.68,
          0.18,
          0.11,
          "#f4ffff",
          {
            glow: s * 0.012,
            textAnimation: "character-rise",
            staggerFrames: f(2),
          },
          enter(8),
        ),
        text(
          "HOURS",
          0.16,
          0.5,
          0.68,
          0.18,
          0.11,
          "#80f5e8",
          {
            glow: s * 0.022,
            textAnimation: "character-rise",
            staggerFrames: f(2),
          },
          enter(18),
        ),
        layer(
          "line",
          0.3,
          0.8,
          0.4,
          0.0015,
          { stroke: "#8ef4ef", strokeWidth: s * 0.003, glow: s * 0.018 },
          [
            { frame: 0, trim: 0, easing: "hold" },
            { frame: 25, trim: 0, easing: "ease-out" },
            { frame: 54, trim: 1 },
          ],
        ),
        text(
          "MAKE SOMETHING ELECTRIC",
          0.12,
          0.84,
          0.76,
          0.04,
          0.019,
          "#9abdc1",
          {},
          enter(35, s * 0.015),
        ),
      ];
    case "lower-third":
      return [
        layer(
          "rectangle",
          0.075,
          0.75,
          0.79,
          0.135,
          { background: "#202723", radius: s * 0.013 },
          [
            // A long slide settles with a 2% overshoot instead of a 13% bounce.
            {
              frame: 0,
              x: -w * 0.8,
              opacity: 0,
              easing: "cubic-bezier",
              bezier: [0.22, 1.25, 0.36, 1],
            },
            { frame: 24, x: 0, opacity: 1 },
            { frame: 104, x: 0, opacity: 1, easing: "ease-in" },
            { frame: 119, x: -w * 0.8, opacity: 0 },
          ],
        ),
        layer(
          "rectangle",
          0.075,
          0.75,
          0.012,
          0.135,
          { background: "#c6f16d" },
          enter(4, 0),
        ),
        text(
          "NEIL BUSQUE",
          0.12,
          0.767,
          0.69,
          0.059,
          0.045,
          "#f3f5ed",
          { textAnimation: "word-rise", staggerFrames: f(4) },
          enter(11, s * 0.025),
        ),
        text(
          "CREATIVE DIRECTOR",
          0.12,
          0.829,
          0.69,
          0.037,
          0.025,
          "#b9ee95",
          {},
          enter(22, s * 0.02),
        ),
        layer(
          "line",
          0.12,
          0.903,
          0.25,
          0.001,
          { stroke: "#c6f16d", strokeWidth: s * 0.002 },
          [
            { frame: 0, trim: 0, easing: "hold" },
            { frame: 20, trim: 0, easing: "ease-out" },
            { frame: 40, trim: 1 },
          ],
        ),
      ];
    case "social-pop":
      return [
        bg("#ffc2e4"),
        layer(
          "star",
          0.5 - (s * 0.37) / w,
          0.5 - (s * 0.37) / h,
          (s * 0.74) / w,
          (s * 0.74) / h,
          {
            background: "#ee5ea4",
            fillStyle: "gradient",
            gradientColor: "#f899d1",
            rotate: -18,
            loop: "cycle",
            loopFrames: f(120),
          },
          [
            { frame: 0, rotate: -18, scale: 0.4, easing: "spring" },
            { frame: 30, rotate: 0, scale: 1 },
            { frame: 120, rotate: 72, scale: 1 },
          ],
        ),
        text(
          "STOP",
          0.06,
          0.3,
          0.88,
          0.19,
          0.15,
          "#35152c",
          { textAnimation: "word-rise", staggerFrames: f(3) },
          enter(5),
        ),
        text(
          "THE SCROLL",
          0.06,
          0.5,
          0.88,
          0.13,
          0.079,
          "#35152c",
          { textAnimation: "character-rise", staggerFrames: f(2) },
          enter(15),
        ),
        layer(
          "rectangle",
          0.34,
          0.74,
          0.32,
          0.07,
          { background: "#35152c", radius: s * 0.035 },
          enter(25, s * 0.035),
        ),
        text(
          "LOOK HERE",
          0.34,
          0.74,
          0.32,
          0.07,
          0.023,
          "#ffe0f2",
          {},
          enter(29, s * 0.035),
        ),
      ];
    case "geometric-burst": {
      const accents = ["#ffb97a", "#c6f16d", "#b59afa", "#79ddd6"];
      const shapes = Array.from({ length: 8 }, (_, i) => {
        const angle = (i * Math.PI) / 4,
          size = s * (i % 2 ? 0.09 : 0.12);
        const x = w * 0.5 + Math.cos(angle) * s * 0.35 - size * 0.5;
        const y = h * 0.5 + Math.sin(angle) * s * 0.34 - size * 0.5;
        return layer(
          ["ellipse", "star", "triangle", "rectangle"][i % 4],
          x / w,
          y / h,
          size / w,
          size / h,
          {
            background: accents[i % 4],
            radius: s * 0.018,
            loop: "ping-pong",
            loopFrames: f(60),
          },
          [
            {
              frame: 0,
              x: w * 0.5 - x - size * 0.5,
              y: h * 0.5 - y - size * 0.5,
              scale: 0,
              rotate: -40,
              opacity: 0,
              easing: "spring",
            },
            {
              frame: 34 + i * 2,
              x: 0,
              y: 0,
              scale: 1,
              rotate: i * 20,
              opacity: 1,
              easing: "ease-in-out",
            },
            {
              frame: 60,
              x: Math.cos(angle) * s * 0.02,
              y: Math.sin(angle) * s * 0.02,
              scale: 0.85,
              rotate: i * 20 + 25,
              opacity: 1,
            },
          ],
        );
      });
      return [
        bg("#171b20"),
        ...shapes,
        text(
          "IDEAS",
          0.17,
          0.36,
          0.66,
          0.16,
          0.13,
          "#f5f6ef",
          { textAnimation: "character-rise", staggerFrames: f(2) },
          enter(12),
        ),
        text(
          "IN MOTION",
          0.17,
          0.55,
          0.66,
          0.09,
          0.046,
          "#ffb97a",
          { textAnimation: "word-rise", staggerFrames: f(5) },
          enter(24),
        ),
      ];
    }
    case "minimal-type":
      return [
        bg("#e9e5dc"),
        text(
          "Good design",
          0.08,
          0.3,
          0.84,
          0.15,
          0.09,
          "#302f2b",
          { textAnimation: "word-rise", staggerFrames: f(6) },
          enter(0, s * 0.045),
        ),
        text(
          "moves you.",
          0.08,
          0.47,
          0.84,
          0.15,
          0.09,
          "#302f2b",
          { textAnimation: "word-rise", staggerFrames: f(6) },
          enter(20, s * 0.045),
        ),
        layer(
          "line",
          0.28,
          0.69,
          0.44,
          0.001,
          { stroke: "#817665", strokeWidth: s * 0.002 },
          [
            { frame: 0, trim: 0, easing: "hold" },
            { frame: 26, trim: 0, easing: "ease-in-out" },
            { frame: 54, trim: 1 },
          ],
        ),
        text(
          "A LITTLE MOTION. A LOT OF FEELING.",
          0.08,
          0.75,
          0.84,
          0.05,
          0.019,
          "#70695e",
          {},
          enter(38, s * 0.02),
        ),
      ];
    case "title-card":
      return [
        bg("#111624", "#263147"),
        layer(
          "rectangle",
          0.12,
          0.24,
          0.76,
          0.53,
          {
            background: "#748ded",
            fillStyle: "gradient",
            gradientColor: "#cab7f5",
            radius: s * 0.04,
          },
          [
            { frame: 0, scale: 0.72, rotate: -7, opacity: 0, easing: "spring" },
            { frame: 30, scale: 1, rotate: 0, opacity: 1 },
            { frame: 102, scale: 1, rotate: 0, opacity: 1, easing: "ease-in" },
            { frame: 119, scale: 0.94, rotate: 3, opacity: 0 },
          ],
        ),
        text(
          "NEXT",
          0.15,
          0.3,
          0.7,
          0.18,
          0.14,
          "#172242",
          { textAnimation: "character-rise", staggerFrames: f(2) },
          enter(11),
        ),
        text(
          "UP.",
          0.15,
          0.5,
          0.7,
          0.18,
          0.16,
          "#172242",
          { textAnimation: "character-rise", staggerFrames: f(4) },
          enter(22),
        ),
        text(
          "SOMETHING WORTH WATCHING",
          0.12,
          0.83,
          0.76,
          0.055,
          0.022,
          "#c4d0ef",
          {},
          enter(35, s * 0.02),
        ),
      ];
  }
}

export function packageMotion(
  p: Project,
  start: number,
  name: string,
  layers: Layer[],
  frames = p.fps * 4,
  source?: string,
): CreatedMotion {
  const track = p.tracks.find(
    (t) =>
      t.kind === "text" &&
      t.id !== "captions" &&
      !t.hidden &&
      !t.muted &&
      !p.clips.some(
        (c) =>
          c.trackId === t.id &&
          c.start < start + frames &&
          c.start + c.duration > start,
      ),
  );
  const destination = track ?? {
    ...newTrack(p, "text"),
    name: `${name} · motion`,
  };
  const motion = MotionSchema.parse({
    id: uid(),
    name,
    layers,
    ...(source ? { source } : {}),
  });
  const clip = {
    ...makeClip(p, "text", destination.id, start),
    preset: "custom" as const,
    motionId: motion.id,
    text: name,
    x: 0,
    y: 0,
    width: p.width,
    height: p.height,
    duration: frames,
    align: "center" as const,
    ...(source &&
    (isStudioScene(source) ||
      isSignatureScene(source) ||
      isLogoScene(source) ||
      isPromoScene(source) ||
      isEditorialScene(source) ||
      isCreatorStudioScene(source))
      ? { fontFamily: "Helvetica" as const }
      : {}),
  };
  return {
    clip,
    motion,
    commands: [
      { type: "motion.put", motion },
      ...(!track ? [{ type: "track.add" as const, track: destination }] : []),
      { type: "clip.add", clip },
    ],
  };
}

/** A loop whose last key matches its first plays seamlessly at any length. */
function seamlessLoop(layer: Layer) {
  if (layer.loop === "ping-pong") return true;
  if (layer.loop !== "cycle") return false;
  const curve = { ...layer, loop: "none" as const };
  return motionProperties.every((property) => {
    const difference =
      motionValue(curve, property, layer.loopFrames) -
      motionValue(curve, property, 0);
    if (property !== "rotate") return Math.abs(difference) < 1e-6;
    const turn = ((difference % 360) + 360) % 360;
    return Math.min(turn, 360 - turn) < 1e-6;
  });
}

/** True when nothing about the layer changes between two frames. */
function stillBetween(layer: Layer, from: number, to: number) {
  const curve = { ...layer, loop: "none" as const };
  const span = to - from;
  const probes = [0.25, 0.5, 0.75, 1].map((share) =>
    Math.max(from, Math.min(to - 1, from + span * share)),
  );
  return motionProperties.every((property) => {
    const first = motionValue(curve, property, from);
    return probes.every(
      (frame) => Math.abs(motionValue(curve, property, frame) - first) < 1e-6,
    );
  });
}

/**
 * Where a layer's timing gives when its scene changes length. Titles and
 * panels pause between their entrance and exit, so that pause stretches and
 * the exit stays anchored to the end. A pause that only delays an entrance
 * never stretches, or the entrance would drift late. When a layer ends with
 * one long move, such as a slow spin, that move stretches instead. A layer in
 * constant motion across the scene scales evenly ("even").
 */
function stretchPoint(
  layer: Layer,
  originalFrames: number,
): { room: number; split: number } | "even" {
  const frames = [...new Set(layer.keyframes.map((key) => key.frame))].sort(
    (a, b) => a - b,
  );
  const segments = [
    ...frames
      .slice(1)
      .map((to, index) => ({ from: frames[index], to, tail: false })),
    {
      from: frames.at(-1) ?? 0,
      to: Math.max(originalFrames, frames.at(-1) ?? 0),
      tail: true,
    },
  ].filter((segment) => segment.tail || segment.to > originalFrames / 2);
  const longest = (list: typeof segments) =>
    list.reduce<(typeof segments)[number] | undefined>(
      (best, segment) =>
        !best || segment.to - segment.from >= best.to - best.from
          ? segment
          : best,
      undefined,
    );
  const pause = longest(
    segments.filter(
      (segment) =>
        segment.tail || stillBetween(layer, segment.from, segment.to),
    ),
  );
  const move = longest(segments);
  const pick =
    pause && pause.to - pause.from >= originalFrames * 0.25
      ? pause
      : move && move.to - move.from >= originalFrames * 0.5
        ? move
        : undefined;
  if (!pick) return "even";
  return {
    room: pick.to - pick.from,
    split: pick.tail ? Infinity : pick.to,
  };
}

/** The frame a layer's text reveal finishes, so a shorter scene never cuts it off. */
function revealEnd(layer: Layer, fps: number) {
  if (layer.type !== "text" || layer.textAnimation === "none") return 0;
  if (layer.textAnimation === "line-reveal")
    return (
      layer.textRevealStart +
      layer.textRevealFrames +
      layer.staggerFrames * (layer.text.split(/\r\n|\r|\n/u).length - 1)
    );
  const tokens =
    layer.textAnimation === "word-rise"
      ? layer.text.split(/\s+/u).filter(Boolean).length
      : Array.from(layer.text).length;
  return (
    motionRevealStart(layer) +
    layer.staggerFrames * Math.max(0, tokens - 1) +
    (layer.textAnimation === "typewriter"
      ? 1
      : Math.max(1, Math.round((12 * fps) / 30)))
  );
}

/**
 * A scene made longer or shorter keeps its entrances at their own pace and
 * its exits anchored to the end; only the hold between them changes. Loops
 * keep their speed, and a scene-long one-shot loop stretches with the scene
 * so it never restarts. Only a scene too short to fit its entrances and exits
 * is compressed evenly.
 */
function retimeSceneLayers(
  layers: Layer[],
  originalFrames: number,
  durationFrames: number,
  fps: number,
): Layer[] {
  if (durationFrames === originalFrames) return layers;
  const extra = durationFrames - originalFrames;
  const ratio = durationFrames / originalFrames;
  const rekey = (layer: Layer, frameOf: (frame: number) => number) => {
    const keys = new Map<number, Layer["keyframes"][number]>();
    for (const key of layer.keyframes) {
      const frame = frameOf(key.frame);
      keys.set(frame, { ...keys.get(frame), ...key, frame });
    }
    return [...keys.values()].sort((a, b) => a.frame - b.frame);
  };
  const even = (layer: Layer): Layer => {
    const at = (frame: number) =>
      Math.min(durationFrames - 1, Math.max(0, Math.round(frame * ratio)));
    const boundedTiming = (frame: number, maximum: number) =>
      Math.min(maximum, Math.max(1, Math.round(frame * ratio)));
    return {
      ...layer,
      keyframes: rekey(layer, at),
      textRevealStart: at(layer.textRevealStart),
      textRevealFrames: boundedTiming(layer.textRevealFrames, 1800),
      staggerFrames: boundedTiming(layer.staggerFrames, 30),
      loopFrames: boundedTiming(layer.loopFrames, 1800),
    };
  };
  const plans = layers.map((layer) =>
    layer.loop === "none" ||
    (!seamlessLoop(layer) && layer.loopFrames >= originalFrames - 1)
      ? stretchPoint(layer, originalFrames)
      : undefined,
  );
  const fits = layers.every((layer, index) => {
    const plan = plans[index];
    if (!plan || plan === "even") return true;
    const exitStart =
      plan.split === Infinity ? durationFrames : plan.split + extra;
    return plan.room + extra >= 1 && revealEnd(layer, fps) <= exitStart;
  });
  if (!fits) return layers.map(even);
  return layers.map((layer, index) => {
    const plan = plans[index];
    // Seamless loops, and loops that repeat inside the scene, keep their speed.
    if (!plan) return layer;
    if (plan === "even") return even(layer);
    return {
      ...layer,
      keyframes: rekey(layer, (frame) =>
        frame >= plan.split
          ? Math.min(durationFrames - 1, frame + extra)
          : frame,
      ),
      // A scene-long one-shot loop spans the new length, so it never restarts.
      ...(layer.loop === "cycle"
        ? {
            loopFrames: Math.max(1, Math.min(1800, layer.loopFrames + extra)),
          }
        : {}),
    };
  });
}

/** Every scene is an editable composition; no footage or remote resources are required. */
export function createMotionScene(
  p: Project,
  start: number,
  id: MotionSceneId,
  options: MotionSceneOptions = {},
): CreatedMotion {
  const info = motionScenes.find((scene) => scene.id === id);
  if (!info) throw Error("Choose a supported motion scene.");
  const frames = options.durationFrames ?? p.fps * 4;
  if (!Number.isInteger(frames) || frames < 2 || frames > 18000)
    throw Error("Choose a scene duration from 2 to 18,000 whole frames.");
  const layers = isCreatorStudioScene(id)
    ? creatorStudioSceneLayers(p, id)
    : isEditorialScene(id)
      ? editorialSceneLayers(p, id)
      : isPromoScene(id)
        ? promoSceneLayers(p, id)
        : isLogoScene(id)
          ? logoSceneLayers(p, id)
          : isSignatureScene(id)
            ? signatureSceneLayers(p, id)
            : isStudioScene(id)
              ? studioSceneLayers(p, id)
              : sceneLayers(p, id);
  const created = packageMotion(
    p,
    start,
    info.name,
    retimeSceneLayers(layers, p.fps * 4, frames, p.fps),
    frames,
    id,
  );
  if (isPromoScene(id))
    created.clip.keyframes = promoClipKeyframes(p, id, frames);
  return created;
}

/** Shape layers use their own available text track, so adding at the playhead never overlaps a clip. */
export function createShapeLayer(
  p: Project,
  start: number,
  type: ShapeType,
): CreatedMotion {
  if (!shapeTypes.includes(type)) throw Error("Choose a supported shape.");
  const s = Math.min(p.width, p.height),
    isLine = type === "line";
  const width = s * (isLine ? 0.54 : 0.32),
    height = isLine ? Math.max(1, s * 0.006) : s * 0.32;
  const motionLayer = MotionLayerSchema.parse({
    type,
    x: (p.width - width) / 2,
    y: (p.height - height) / 2,
    width,
    height,
    background: isLine ? "transparent" : "#c6f16d",
    color: "#c6f16d",
    stroke: "#c6f16d",
    strokeWidth: isLine ? s * 0.008 : 0,
    radius: type === "rectangle" ? s * 0.025 : 0,
    keyframes: isLine
      ? [
          { frame: 0, trim: 0, easing: "ease-out" },
          { frame: Math.round(p.fps * 0.8), trim: 1 },
        ]
      : [
          { frame: 0, scale: 0.1, rotate: -15, opacity: 0, easing: "spring" },
          { frame: Math.round(p.fps * 0.8), scale: 1, rotate: 0, opacity: 1 },
        ],
  });
  return packageMotion(
    p,
    start,
    type === "ellipse" ? "Circle" : type[0].toUpperCase() + type.slice(1),
    [motionLayer],
  );
}

/** Eight seconds of actual editable scenes for preview and export QA. */
export function createMotionDemoProject(width = 1280, height = 720): Project {
  let p = {
    ...newProject(),
    width,
    height,
    name: "Cutline · motion graphics showcase",
    background: "#101415",
  };
  for (const [index, scene] of (
    ["kinetic-title", "orbit-logo", "neon-reveal", "geometric-burst"] as const
  ).entries()) {
    const created = createMotionScene(p, index * p.fps * 2, scene);
    created.clip.duration = p.fps * 2;
    created.motion.layers = created.motion.layers.map((layer) => ({
      ...layer,
      loopFrames: Math.max(1, Math.round(layer.loopFrames / 2)),
      staggerFrames: Math.max(1, Math.round(layer.staggerFrames / 2)),
      keyframes: layer.keyframes.map((key) => ({
        ...key,
        frame: Math.round(key.frame / 2),
      })),
    }));
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: `Showcase · ${scene}`,
      commands: created.commands,
    });
  }
  return validateProject(p);
}

/** Four editorial scenes aligned to cumulative music beats, ready for a local music bed. */
export function createStudioDemoProject({
  width = 1280,
  height = 720,
  fps = 30,
  bpm = 104,
  beatsPerScene = 8,
}: {
  width?: number;
  height?: number;
  fps?: Project["fps"];
  bpm?: number;
  beatsPerScene?: number;
} = {}): Project {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)
    throw Error("Choose a tempo from 20 to 300 BPM.");
  if (
    !Number.isInteger(beatsPerScene) ||
    beatsPerScene < 1 ||
    beatsPerScene > 64
  )
    throw Error("Choose between one and 64 beats per Studio scene.");
  let p = validateProject({
    ...newProject(),
    width,
    height,
    fps,
    name: "Cutline / Studio motion study",
    background: studioPalette.ivory,
  });
  for (const [index, id] of studioSceneIds.entries()) {
    const start = Math.round(((index * beatsPerScene * 60) / bpm) * fps);
    const end = Math.round((((index + 1) * beatsPerScene * 60) / bpm) * fps);
    const created = createMotionScene(p, start, id, {
      durationFrames: end - start,
    });
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: `Studio / ${created.motion.name}`,
      commands: created.commands,
    });
  }
  return p;
}

/** Three connected graphic acts on the same eight-beat grid as the original music bed. */
export function createSignatureDemoProject({
  width = 1280,
  height = 720,
  fps = 30,
  bpm = 104,
  beatsPerScene = 8,
}: {
  width?: number;
  height?: number;
  fps?: Project["fps"];
  bpm?: number;
  beatsPerScene?: number;
} = {}): Project {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)
    throw Error("Choose a tempo from 20 to 300 BPM.");
  if (
    !Number.isInteger(beatsPerScene) ||
    beatsPerScene < 1 ||
    beatsPerScene > 64
  )
    throw Error("Choose between one and 64 beats per Signature scene.");
  let p = validateProject({
    ...newProject(),
    width,
    height,
    fps,
    name: "Cutline / Signature motion sequence",
    background: signaturePalette.ivory,
  });
  for (const [index, id] of signatureSceneIds.entries()) {
    const start = Math.round(((index * beatsPerScene * 60) / bpm) * fps);
    const end = Math.round((((index + 1) * beatsPerScene * 60) / bpm) * fps);
    const created = createMotionScene(p, start, id, {
      durationFrames: end - start,
    });
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: created.motion.name,
      commands: created.commands,
    });
  }
  return p;
}

/** Three original vector logo treatments on cumulative eight-beat boundaries. */
export function createLogoDemoProject({
  width = 1280,
  height = 720,
  fps = 30,
  bpm = 104,
  beatsPerScene = 8,
}: {
  width?: number;
  height?: number;
  fps?: Project["fps"];
  bpm?: number;
  beatsPerScene?: number;
} = {}): Project {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)
    throw Error("Choose a tempo from 20 to 300 BPM.");
  if (
    !Number.isInteger(beatsPerScene) ||
    beatsPerScene < 1 ||
    beatsPerScene > 64
  )
    throw Error("Choose between one and 64 beats per logo scene.");
  let p = validateProject({
    ...newProject(),
    width,
    height,
    fps,
    name: "Cutline / Original logo reveals",
    background: logoPalette.paper,
  });
  for (const [index, id] of logoSceneIds.entries()) {
    const start = Math.round(((index * beatsPerScene * 60) / bpm) * fps);
    const end = Math.round((((index + 1) * beatsPerScene * 60) / bpm) * fps);
    const created = createMotionScene(p, start, id, {
      durationFrames: end - start,
    });
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: created.motion.name,
      commands: created.commands,
    });
  }
  return p;
}
