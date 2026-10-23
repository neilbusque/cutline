import {
  MotionLayerSchema,
  type MotionLayer,
  type MotionKeyframe,
  type Project,
} from "./model";

export const studioSceneIds = [
  "studio-title",
  "studio-grid",
  "studio-identity",
  "studio-outro",
] as const;
export type StudioSceneId = (typeof studioSceneIds)[number];
export const studioPalette = {
  ivory: "#F1EDE4",
  ink: "#252B25",
  sage: "#A8B79B",
  paper: "#D7D5CA",
} as const;
export const studioScenes = [
  {
    id: "studio-title",
    name: "Studio / Title",
    description: "Masked type · a drawn circle · a considered hold",
    category: "Studio",
    color: studioPalette.ivory,
  },
  {
    id: "studio-grid",
    name: "Studio / System",
    description: "A staggered grid · geometric follow-through",
    category: "Studio",
    color: studioPalette.ink,
  },
  {
    id: "studio-identity",
    name: "Studio / Identity",
    description: "A graphic mark · deliberate typographic rhythm",
    category: "Studio",
    color: studioPalette.sage,
  },
  {
    id: "studio-outro",
    name: "Studio / Outro",
    description: "A quiet closing card · a purposeful exit",
    category: "Studio",
    color: studioPalette.ivory,
  },
] as const;
/** Small decorative marks, rather than the background, layout panels or typography. */
export const studioAccentLayers: Record<StudioSceneId, readonly number[]> = {
  "studio-title": [1, 7],
  "studio-grid": [5, 6, 7, 8],
  "studio-identity": [2, 3],
  "studio-outro": [2, 7],
};
export function isStudioScene(id: string): id is StudioSceneId {
  return studioSceneIds.includes(id as StudioSceneId);
}

const reveal: [number, number, number, number] = [0.16, 1, 0.3, 1];
const wipe: [number, number, number, number] = [0.76, 0, 0.24, 1];
type Key = Omit<MotionKeyframe, "easing"> & {
  easing?: MotionKeyframe["easing"];
};

/** Four-second master compositions. Packaging controls output duration without changing their choreography. */
function studioSceneLayersCore(p: Project, id: StudioSceneId): MotionLayer[] {
  const w = p.width,
    h = p.height,
    s = Math.min(w, h);
  const f = (frame: number) => Math.round((frame * p.fps) / 30);
  const keyframes = (keys: Key[]) =>
    keys.map((key) => ({ ...key, frame: f(key.frame) }));
  const layer = (
    type: MotionLayer["type"],
    x: number,
    y: number,
    width: number,
    height: number,
    extra: Record<string, unknown> = {},
    keys: Key[] = [{ frame: 0 }],
  ): MotionLayer =>
    MotionLayerSchema.parse({
      type,
      x: x * w,
      y: y * h,
      width: Math.max(1, width * w),
      height: Math.max(1, height * h),
      fontSize: Math.max(8, Math.min(500, s * 0.03)),
      keyframes: keyframes(keys),
      ...extra,
    });
  const holdExit = (end = 101): Key[] => [
    { frame: 0, opacity: 1, y: 0, easing: "hold" },
    { frame: end, opacity: 1, y: 0, easing: "cubic-bezier", bezier: wipe },
    { frame: 119, opacity: 0, y: -s * 0.018 },
  ];
  const settle = (delay: number, distance = s * 0.027): Key[] => [
    {
      frame: 0,
      opacity: 0,
      y: distance,
      scale: 0.965,
      easing: delay ? "hold" : "cubic-bezier",
      ...(delay ? {} : { bezier: reveal }),
    },
    ...(delay
      ? [
          {
            frame: delay,
            opacity: 0,
            y: distance,
            scale: 0.965,
            easing: "cubic-bezier" as const,
            bezier: reveal,
          },
        ]
      : []),
    {
      frame: delay + 17,
      opacity: 1,
      y: -distance * 0.1,
      scale: 1.012,
      easing: "cubic-bezier",
      bezier: reveal,
    },
    { frame: delay + 30, opacity: 1, y: 0, scale: 1, easing: "hold" },
    {
      frame: 102,
      opacity: 1,
      y: 0,
      scale: 1,
      easing: "cubic-bezier",
      bezier: wipe,
    },
    { frame: 119, opacity: 0, y: -distance * 0.55, scale: 0.985 },
  ];
  const drawn = (delay: number): Key[] => [
    { frame: 0, trim: 0, opacity: 1, easing: "hold" },
    {
      frame: delay,
      trim: 0,
      opacity: 1,
      easing: "cubic-bezier",
      bezier: reveal,
    },
    { frame: delay + 28, trim: 1, opacity: 1, easing: "hold" },
    { frame: 99, trim: 1, opacity: 1, easing: "cubic-bezier", bezier: wipe },
    { frame: 119, trim: 0, opacity: 0 },
  ];
  const text = (
    value: string,
    x: number,
    y: number,
    width: number,
    height: number,
    size: number,
    color: string,
    start: number,
    extra: Record<string, unknown> = {},
  ) => {
    const longest = Math.max(...value.split("\n").map((line) => line.length));
    const fontSize = Math.max(
      8,
      Math.min(500, s * size, (width * w) / Math.max(1, longest * 0.63)),
    );
    return layer(
      "text",
      x,
      y,
      width,
      height,
      {
        text: value,
        color,
        align: "left",
        fontWeight: 600,
        fontSize,
        lineHeight: 1.05,
        letterSpacing: -fontSize * 0.028,
        textAnimation: "line-reveal",
        textRevealStart: f(start),
        textRevealFrames: f(23),
        staggerFrames: Math.max(1, f(8)),
        ...extra,
      },
      holdExit(),
    );
  };
  const label = (
    value: string,
    x: number,
    y: number,
    width: number,
    color: string,
    start: number,
    extra: Record<string, unknown> = {},
  ) => {
    const tracking =
      typeof extra.letterSpacing === "number" ? extra.letterSpacing : s * 0.002;
    const longest = Math.max(...value.split("\n").map((line) => line.length));
    // Tracked labels need room for spacing as well as their glyph advances.
    const fontSize = Math.max(
      8,
      Math.min(
        500,
        s * 0.019,
        (width * w - Math.max(0, longest - 1) * Math.max(0, tracking)) /
          Math.max(1, longest * 0.63),
      ),
    );
    return text(value, x, y, width, 0.045, 0.019, color, start, {
      fontWeight: 500,
      letterSpacing: tracking,
      textRevealFrames: Math.max(1, f(15)),
      staggerFrames: Math.max(1, f(3)),
      lineHeight: 1.18,
      ...extra,
      fontSize,
    });
  };
  const circle = (
    cx: number,
    cy: number,
    diameter: number,
    extra: Record<string, unknown>,
    keys: Key[],
  ) =>
    layer(
      "ellipse",
      (cx * w - diameter / 2) / w,
      (cy * h - diameter / 2) / h,
      diameter / w,
      diameter / h,
      extra,
      keys,
    );
  const background = (color: string) =>
    layer("rectangle", 0, 0, 1, 1, { background: color });
  const { ivory, ink, sage, paper } = studioPalette;

  switch (id) {
    case "studio-title":
      return [
        background(ivory),
        circle(
          0.815,
          0.385,
          s * 0.24,
          {
            background: "transparent",
            stroke: ink,
            strokeWidth: Math.max(1, s * 0.003),
          },
          drawn(16),
        ),
        layer(
          "rectangle",
          0.695,
          0.185,
          Math.max(1, s * 0.0015) / w,
          0.525,
          { background: paper, anchorY: 0 },
          settle(0, s * 0.018).map((key, index) =>
            index === 0
              ? { ...key, easing: "cubic-bezier", bezier: reveal }
              : key,
          ),
        ),
        label("CUTLINE / STUDIO NOTES", 0.082, 0.115, 0.52, ink, 4),
        text("MADE\nTO MOVE.", 0.075, 0.28, 0.59, 0.38, 0.148, ink, 10),
        text(
          "Purposeful motion. Space to breathe.",
          0.083,
          0.755,
          0.56,
          0.07,
          0.026,
          ink,
          32,
          {
            fontWeight: 400,
            letterSpacing: 0,
            textRevealFrames: Math.max(1, f(18)),
          },
        ),
        label("01 / 04", 0.083, 0.916, 0.18, ink, 36),
        layer(
          "line",
          0.73,
          0.808,
          0.18,
          Math.max(1, s * 0.002) / h,
          { stroke: ink, strokeWidth: Math.max(1, s * 0.002), anchorX: 0 },
          drawn(30),
        ),
        label("FORM FOLLOWS FEELING", 0.64, 0.916, 0.29, ink, 40, {
          align: "right",
          letterSpacing: s * 0.0008,
        }),
      ];
    case "studio-grid":
      return [
        background(ink),
        layer(
          "rectangle",
          0.54,
          0.205,
          0.175,
          0.235,
          { background: sage, radius: s * 0.006 },
          settle(4),
        ),
        layer(
          "rectangle",
          0.735,
          0.205,
          0.175,
          0.235,
          { background: paper, radius: s * 0.006 },
          settle(10),
        ),
        layer(
          "rectangle",
          0.54,
          0.465,
          0.175,
          0.235,
          { background: ivory, radius: s * 0.006 },
          settle(16),
        ),
        layer(
          "rectangle",
          0.735,
          0.465,
          0.175,
          0.235,
          { background: sage, radius: s * 0.006 },
          settle(22),
        ),
        circle(
          0.6275,
          0.3225,
          s * 0.095,
          { background: ivory },
          settle(16, s * 0.012),
        ),
        layer(
          "rectangle",
          0.763,
          0.317,
          0.119,
          Math.max(1, s * 0.023) / h,
          { background: ink, radius: s * 0.001 },
          settle(22, s * 0.012),
        ),
        circle(
          0.6275,
          0.5825,
          s * 0.095,
          {
            background: "transparent",
            stroke: ink,
            strokeWidth: Math.max(1, s * 0.003),
          },
          drawn(28),
        ),
        layer(
          "triangle",
          (0.8225 * w - s * 0.0525) / w,
          (0.5825 * h - s * 0.0525) / h,
          (s * 0.105) / w,
          (s * 0.105) / h,
          { background: ink },
          settle(34, s * 0.012),
        ),
        label("02 / A CONSIDERED SYSTEM", 0.083, 0.115, 0.43, ivory, 4),
        text(
          "A SYSTEM\nIN MOTION.",
          0.075,
          0.265,
          0.415,
          0.305,
          0.087,
          ivory,
          12,
        ),
        text(
          "Shape, space, and a\nconsidered sense of timing.",
          0.083,
          0.655,
          0.39,
          0.115,
          0.026,
          paper,
          32,
          {
            fontWeight: 400,
            letterSpacing: 0,
            lineHeight: 1.3,
            staggerFrames: Math.max(1, f(4)),
            textRevealFrames: Math.max(1, f(18)),
          },
        ),
        label("02 / 04", 0.083, 0.916, 0.18, paper, 42),
        label("SHAPE / SPACE / RHYTHM", 0.6, 0.916, 0.31, paper, 42, {
          align: "right",
          letterSpacing: s * 0.0008,
        }),
      ];
    case "studio-identity":
      return [
        background(sage),
        circle(
          0.27,
          0.465,
          s * 0.425,
          { background: ink },
          settle(2, s * 0.027),
        ),
        circle(
          0.27 + (s * 0.07) / w,
          0.465,
          s * 0.245,
          { background: sage },
          settle(15, s * 0.012),
        ),
        layer(
          "line",
          0.56,
          0.754,
          0.31,
          Math.max(1, s * 0.002) / h,
          { stroke: ink, strokeWidth: Math.max(1, s * 0.002), anchorX: 0 },
          drawn(30),
        ),
        label("03 / A CLEAR POINT OF VIEW", 0.083, 0.115, 0.7, ink, 4),
        text("MOVE WITH\nPURPOSE.", 0.545, 0.285, 0.385, 0.3, 0.1, ink, 14),
        text(
          "A considered identity.\nA clear point of view.",
          0.553,
          0.626,
          0.37,
          0.1,
          0.026,
          ink,
          35,
          {
            fontWeight: 400,
            letterSpacing: 0,
            lineHeight: 1.3,
            staggerFrames: Math.max(1, f(4)),
            textRevealFrames: Math.max(1, f(18)),
          },
        ),
        label("03 / 04", 0.083, 0.916, 0.18, ink, 40),
        label("CUTLINE / STUDIO", 0.67, 0.916, 0.25, ink, 40, {
          align: "right",
          letterSpacing: s * 0.0008,
        }),
      ];
    case "studio-outro":
      return [
        background(ivory),
        layer(
          "rectangle",
          0.083,
          0.795,
          0.2,
          0.065,
          { background: sage, radius: s * 0.004 },
          settle(34, s * 0.012),
        ),
        circle(
          0.845,
          0.194,
          s * 0.092,
          { background: ink },
          settle(18, s * 0.012),
        ),
        label("CUTLINE / STUDIO", 0.083, 0.115, 0.52, ink, 4),
        text("MAKE IT\nMATTER.", 0.075, 0.28, 0.75, 0.36, 0.145, ink, 8),
        text(
          "A little restraint. A lasting impression.",
          0.083,
          0.67,
          0.7,
          0.075,
          0.026,
          ink,
          31,
          {
            fontWeight: 400,
            letterSpacing: 0,
            textRevealFrames: Math.max(1, f(18)),
          },
        ),
        label("MADE IN CUTLINE", 0.095, 0.805, 0.175, ink, 42, {
          fontWeight: 600,
          letterSpacing: s * 0.0012,
          textRevealFrames: Math.max(1, f(14)),
        }),
        layer(
          "line",
          0.55,
          0.825,
          0.36,
          Math.max(1, s * 0.002) / h,
          { stroke: ink, strokeWidth: Math.max(1, s * 0.002), anchorX: 0 },
          drawn(35),
        ),
        label("END / A NEW BEGINNING", 0.62, 0.916, 0.29, ink, 44, {
          align: "right",
          letterSpacing: s * 0.0008,
        }),
        label("04 / 04", 0.083, 0.916, 0.18, ink, 40),
      ];
  }
}

export function studioSceneLayers(
  p: Project,
  id: StudioSceneId,
): MotionLayer[] {
  return studioSceneLayersCore(p, id).map((layer, index) =>
    MotionLayerSchema.parse({
      ...layer,
      musicAccent: studioAccentLayers[id].includes(index),
    }),
  );
}
