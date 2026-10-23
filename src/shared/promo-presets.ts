import {
  MotionLayerSchema,
  type Clip,
  type MotionKeyframe,
  type MotionLayer,
  type Project,
} from "./model";
import { captionTextWidth } from "./caption-layout";

export const promoSceneIds = [
  "promo-punch",
  "promo-stack",
  "promo-invert",
  "promo-zoom",
] as const;
export type PromoSceneId = (typeof promoSceneIds)[number];

export const promoScenes = [
  {
    id: "promo-punch",
    name: "Promo / Punch",
    description: "Oversized headline · sharp entrance · over footage",
    category: "Promo",
    color: "#f2f2f2",
  },
  {
    id: "promo-stack",
    name: "Promo / Stack",
    description: "Three staggered words · bold scale · over footage",
    category: "Promo",
    color: "#cbdcff",
  },
  {
    id: "promo-invert",
    name: "Promo / Invert",
    description: "Black to white · one decisive typography cut",
    category: "Promo",
    color: "#e1e1e1",
  },
  {
    id: "promo-zoom",
    name: "Promo / Zoom",
    description: "Readable headline · zoom and blur exit · over footage",
    category: "Promo",
    color: "#f3c6da",
  },
] as const;

export function isPromoScene(id: string): id is PromoSceneId {
  return promoSceneIds.includes(id as PromoSceneId);
}

type Key = Omit<MotionKeyframe, "easing"> & {
  easing?: MotionKeyframe["easing"];
};
const arrive: [number, number, number, number] = [0.16, 1, 0.3, 1];

/**
 * Four-second native compositions. The shared scene retimer preserves the
 * short entrances and exits and gives added duration to the readable hold.
 * Every visible word remains a text layer; overlays have no background plate.
 */
export function promoSceneLayers(p: Project, id: PromoSceneId): MotionLayer[] {
  const { width: w, height: h } = p;
  const s = Math.min(w, h);
  const f = (frame: number) => Math.round((frame * p.fps) / 30);
  const keys = (frames: Key[]) =>
    frames.map((key) => ({ ...key, frame: f(key.frame) }));
  const layer = (
    name: string,
    type: MotionLayer["type"],
    extra: Record<string, unknown>,
    frames: Key[],
  ): MotionLayer =>
    MotionLayerSchema.parse({
      name,
      type,
      musicAccent: false,
      keyframes: keys(frames),
      ...extra,
    });

  // Use the renderer's Helvetica metrics, including tracking, before choosing
  // sizes. The same safe width works on landscape, square and portrait canvases.
  const tracking = -0.035;
  const textWidth = w * 0.88;
  const fitSize = (value: string, preferred: number) => {
    const unitWidth = Math.max(
      ...value
        .split("\n")
        .map((line) => captionTextWidth(line, 1, "Helvetica", "800", tracking)),
    );
    return Math.max(
      8,
      Math.min(500, preferred, (textWidth * 0.94) / unitWidth),
    );
  };
  const rows = (values: string[], sizes: number[]) => {
    const fitted = values.map((value, i) => fitSize(value, s * sizes[i]));
    const naturalHeight = fitted.reduce((sum, size) => sum + size * 1.12, 0);
    const shrink = Math.min(1, (h * 0.68) / naturalHeight);
    let top = (h - naturalHeight * shrink) / 2;
    return values.map((value, i) => {
      const size = fitted[i] * shrink;
      const height = size * 1.12;
      const row = {
        text: value,
        x: w * 0.06,
        y: top,
        width: textWidth,
        height,
        fontSize: size,
        letterSpacing: size * tracking,
        lineHeight: 0.96,
        fontWeight: 800,
        align: "center",
        color: "#ffffff",
        background: "transparent",
        textAnimation: "none",
      };
      top += height;
      return row;
    });
  };
  const entrance = (delay: number, zoom: boolean): Key[] => [
    ...(delay > 0
      ? [
          {
            frame: 0,
            opacity: 0,
            scale: 1.16,
            y: s * 0.025,
            blur: 5,
            easing: "hold" as const,
          },
        ]
      : []),
    {
      frame: delay,
      opacity: 0,
      scale: 1.16,
      y: s * 0.025,
      blur: 5,
      easing: "cubic-bezier",
      bezier: arrive,
    },
    { frame: delay + 9, opacity: 1, scale: 1, y: 0, blur: 0 },
    {
      frame: 110,
      opacity: 1,
      scale: 1,
      y: 0,
      blur: 0,
      easing: "ease-in",
    },
    {
      frame: 119,
      opacity: 0,
      scale: zoom ? 2.15 : 1.08,
      y: zoom ? 0 : -s * 0.035,
      blur: zoom ? Math.min(65, s * 0.035) : Math.min(18, s * 0.012),
    },
  ];

  if (id === "promo-invert") {
    const size = Math.min(
      fitSize("MAKE\nYOUR MOVE", s * 0.32),
      (h * 0.64) / 2.12,
    );
    const text = {
      text: "MAKE\nYOUR MOVE",
      x: w * 0.06,
      y: (h - size * 2.12) / 2,
      width: textWidth,
      height: size * 2.12,
      fontSize: size,
      letterSpacing: size * tracking,
      lineHeight: 0.96,
      fontWeight: 800,
      align: "center",
      textAnimation: "none",
    };
    // The shared 30 -> 110 hold makes both phases retime together. All color
    // switches use hold interpolation: a single hard cut, never a gray fade.
    const switchOn: Key[] = [
      { frame: 0, opacity: 0, easing: "hold" },
      { frame: 30, opacity: 1, easing: "hold" },
      { frame: 110, opacity: 1, easing: "hold" },
      { frame: 119, opacity: 1 },
    ];
    return [
      layer(
        "Black card · before cut",
        "rectangle",
        { x: 0, y: 0, width: w, height: h, background: "#000000" },
        [{ frame: 0 }],
      ),
      layer(
        "White headline · before cut",
        "text",
        { ...text, color: "#ffffff" },
        [
          {
            frame: 0,
            opacity: 0,
            scale: 1.12,
            blur: 5,
            easing: "cubic-bezier",
            bezier: arrive,
          },
          { frame: 9, opacity: 1, scale: 1, blur: 0, easing: "hold" },
          { frame: 30, opacity: 0, scale: 1, blur: 0, easing: "hold" },
          { frame: 110, opacity: 0, easing: "hold" },
          { frame: 119, opacity: 0 },
        ],
      ),
      layer(
        "White card · after cut",
        "rectangle",
        { x: 0, y: 0, width: w, height: h, background: "#ffffff" },
        switchOn,
      ),
      layer(
        "Black headline · after cut",
        "text",
        { ...text, color: "#000000" },
        [
          { frame: 0, opacity: 0, scale: 1, blur: 0, easing: "hold" },
          { frame: 30, opacity: 1, scale: 1, blur: 0, easing: "hold" },
          { frame: 110, opacity: 1, scale: 1, blur: 0, easing: "ease-in" },
          { frame: 119, opacity: 0, scale: 1.08, blur: 7 },
        ],
      ),
    ];
  }

  const zoom = id === "promo-zoom";
  const values =
    id === "promo-stack"
      ? ["FEEL", "THE", "MOMENT"]
      : zoom
        ? ["NEXT", "LEVEL"]
        : ["MAKE", "IT COUNT"];
  const sizes =
    id === "promo-stack"
      ? [0.28, 0.22, 0.3]
      : zoom
        ? [0.39, 0.35]
        : [0.39, 0.29];
  return rows(values, sizes).map((row, index) =>
    layer(
      `Headline ${index + 1} · ${row.text}`,
      "text",
      row,
      entrance(id === "promo-stack" ? index * 3 : 0, zoom),
    ),
  );
}

/** Short, editable RGB accents live only at a cut; the reading hold is clean. */
export function promoClipKeyframes(
  p: Project,
  id: PromoSceneId,
  duration: number,
): Clip["keyframes"] {
  if (id === "promo-invert" || id === "promo-stack") return [];
  const last = duration - 1;
  const settle = Math.min(Math.round((6 * p.fps) / 30), Math.floor(last * 0.2));
  const exit = Math.max(settle + 1, last - Math.round((8 * p.fps) / 30));
  const peak = Math.max(exit, last - Math.max(1, Math.round((2 * p.fps) / 30)));
  const strength = Math.min(20, Math.min(p.width, p.height) * 0.012);
  const byFrame = new Map<number, Clip["keyframes"][number]>();
  for (const [frame, value, easing] of [
    [0, strength, "ease-out"],
    [settle, 0, "hold"],
    [Math.min(last, exit), 0, "ease-in"],
    [
      Math.min(last, peak),
      strength * (id === "promo-zoom" ? 1.4 : 1),
      "ease-out",
    ],
    [last, 0, "linear"],
  ] as const)
    byFrame.set(frame, { property: "rgbSplit", frame, value, easing });
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}
