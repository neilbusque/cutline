import {
  MotionLayerSchema,
  type MotionKeyframe,
  type MotionLayer,
  type Project,
} from "./model";

export const signatureSceneIds = [
  "signature-open",
  "signature-system",
  "signature-close",
] as const;
export type SignatureSceneId = (typeof signatureSceneIds)[number];
export const signaturePalette = {
  ivory: "#EEE9DF",
  charcoal: "#242522",
  copper: "#B36A48",
  stone: "#AAA99F",
} as const;
export const signatureScenes = [
  {
    id: "signature-open",
    name: "Signature / Pace",
    description: "Decisive type · a traveling graphic mark",
    category: "Signature",
    color: signaturePalette.ivory,
  },
  {
    id: "signature-system",
    name: "Signature / Intent",
    description: "Interlocking forms · an inverted match cut",
    category: "Signature",
    color: signaturePalette.charcoal,
  },
  {
    id: "signature-close",
    name: "Signature / Mark",
    description: "A resolved symbol · a lasting final frame",
    category: "Signature",
    color: signaturePalette.copper,
  },
] as const;

export function isSignatureScene(id: string): id is SignatureSceneId {
  return signatureSceneIds.includes(id as SignatureSceneId);
}

const arrive: [number, number, number, number] = [0.16, 1, 0.3, 1];
const travel: [number, number, number, number] = [0.65, 0, 0.35, 1];
type Key = Omit<MotionKeyframe, "easing"> & {
  easing?: MotionKeyframe["easing"];
};
type Point = { x: number; y: number };

/** A shared mark moves through three compositions; its cut poses are identical. */
export function signatureSceneLayers(
  p: Project,
  id: SignatureSceneId,
): MotionLayer[] {
  const w = p.width,
    h = p.height,
    s = Math.min(w, h),
    portrait = h >= w;
  const f = (frame: number) => Math.round((frame * p.fps) / 30);
  const { ivory, charcoal, copper, stone } = signaturePalette;
  const inverted = id === "signature-system";
  const paper = inverted ? charcoal : ivory;
  const ink = inverted ? ivory : charcoal;
  const point = (x: number, y: number): Point => ({ x: x * w, y: y * h });
  const openHold = point(portrait ? 0.62 : 0.76, portrait ? 0.645 : 0.49);
  const firstCut = point(portrait ? 0.48 : 0.53, portrait ? 0.66 : 0.5);
  const systemHold = point(portrait ? 0.65 : 0.77, portrait ? 0.675 : 0.51);
  const secondCut = point(portrait ? 0.59 : 0.72, portrait ? 0.64 : 0.67);
  const closeHold = point(portrait ? 0.65 : 0.8, portrait ? 0.665 : 0.64);
  const start =
    id === "signature-open"
      ? { x: openHold.x - s * 0.1, y: openHold.y + s * 0.055 }
      : id === "signature-system"
        ? firstCut
        : secondCut;
  const hold =
    id === "signature-open" ? openHold : inverted ? systemHold : closeHold;
  const end =
    id === "signature-open" ? firstCut : inverted ? secondCut : closeHold;
  const chapter = signatureSceneIds.indexOf(id) + 1;
  const keys = (input: Key[]) =>
    input.map((key) => ({ ...key, frame: f(key.frame) }));
  const layer = (
    name: string,
    type: MotionLayer["type"],
    x: number,
    y: number,
    width: number,
    height: number,
    extra: Record<string, unknown> = {},
    frames: Key[] = [{ frame: 0 }],
  ): MotionLayer =>
    MotionLayerSchema.parse({
      name,
      type,
      x,
      y,
      width: Math.max(1, width),
      height: Math.max(1, height),
      fontSize: Math.max(8, Math.min(500, s * 0.02)),
      musicAccent: false,
      keyframes: keys(frames),
      ...extra,
    });
  const motifKeys = (
    extra: (frame: number) => Partial<Key> = () => ({}),
  ): Key[] => [
    {
      frame: 0,
      x: start.x - w * 0.5,
      y: start.y - h * 0.5,
      easing: "cubic-bezier",
      bezier: arrive,
      ...extra(0),
    },
    {
      frame: 22,
      x: hold.x - w * 0.5 + s * 0.007,
      y: hold.y - h * 0.5 - s * 0.004,
      easing: "cubic-bezier",
      bezier: travel,
      ...extra(22),
    },
    {
      frame: 58,
      x: hold.x - w * 0.5 - s * 0.016,
      y: hold.y - h * 0.5 + s * 0.011,
      easing: "cubic-bezier",
      bezier: travel,
      ...extra(58),
    },
    {
      frame: 86,
      x: hold.x - w * 0.5,
      y: hold.y - h * 0.5,
      easing: "cubic-bezier",
      bezier: travel,
      ...extra(86),
    },
    { frame: 119, x: end.x - w * 0.5, y: end.y - h * 0.5, ...extra(119) },
  ];
  const textKeys = (final = false): Key[] =>
    final
      ? [{ frame: 0, x: 0, opacity: 1 }]
      : [
          { frame: 0, x: 0, y: 0, opacity: 1, easing: "hold" },
          {
            frame: 95,
            x: 0,
            y: 0,
            opacity: 1,
            easing: "cubic-bezier",
            bezier: travel,
          },
          { frame: 119, x: -s * 0.035, y: -s * 0.008, opacity: 0 },
        ];
  const text = (
    name: string,
    value: string,
    x: number,
    y: number,
    width: number,
    size: number,
    revealStart: number,
    extra: Record<string, unknown> = {},
    persistent = false,
  ) => {
    const lines = value.split("\n");
    const longest = Math.max(...lines.map((line) => line.length));
    const tracking =
      typeof extra.letterSpacing === "number" ? extra.letterSpacing : 0;
    const fontSize = Math.max(
      8,
      Math.min(
        500,
        s * size,
        (width * w - Math.max(0, longest - 1) * Math.max(0, tracking)) /
          Math.max(1, longest * 0.66),
      ),
    );
    const lineHeight =
      typeof extra.lineHeight === "number" ? extra.lineHeight : 1.04;
    return layer(
      name,
      "text",
      x * w,
      y * h,
      width * w,
      fontSize * lineHeight * lines.length * 1.18,
      {
        text: value,
        color: ink,
        align: "left",
        fontSize,
        fontWeight: 700,
        lineHeight,
        letterSpacing: -fontSize * 0.032,
        textAnimation: "line-reveal",
        textRevealStart: f(revealStart),
        textRevealFrames: Math.max(1, f(13)),
        staggerFrames: Math.max(1, f(5)),
        ...extra,
      },
      textKeys(persistent),
    );
  };
  const label = (
    name: string,
    value: string,
    x: number,
    y: number,
    width: number,
    startAt = 6,
    extra: Record<string, unknown> = {},
    persistent = false,
  ) =>
    text(
      name,
      value,
      x,
      y,
      width,
      0.018,
      startAt,
      {
        fontWeight: 500,
        letterSpacing: s * 0.0011,
        lineHeight: 1.2,
        textRevealFrames: Math.max(1, f(10)),
        ...extra,
      },
      persistent,
    );
  const ellipse = (
    name: string,
    cx: number,
    cy: number,
    diameter: number,
    extra: Record<string, unknown>,
    frames: Key[],
  ) =>
    layer(
      name,
      "ellipse",
      cx - diameter / 2,
      cy - diameter / 2,
      diameter,
      diameter,
      extra,
      frames,
    );

  const base: MotionLayer[] = [
    layer("Paper · background", "rectangle", 0, 0, w, h, { background: paper }),
    layer(
      "Frame · top rule",
      "line",
      w * 0.068,
      h * 0.127,
      w * 0.864,
      Math.max(1, s * 0.0014),
      {
        stroke: inverted ? stone : charcoal,
        strokeWidth: Math.max(1, s * 0.0014),
        opacity: 0.45,
        anchorX: 0,
      },
      [
        { frame: 0, trim: 0.6, easing: "cubic-bezier", bezier: arrive },
        { frame: 18, trim: 1 },
      ],
    ),
  ];
  if (inverted) {
    for (const [index, offset] of [-0.19, 0, 0.19].entries()) {
      const delay = 5 + index * 7;
      base.push(
        layer(
          `Structure · slat ${index + 1}`,
          "rectangle",
          hold.x - s * 0.29,
          hold.y + offset * s - s * 0.02,
          s * 0.58,
          s * 0.038,
          {
            background: stone,
            radius: s * 0.009,
            opacity: 0.55,
          },
          [
            {
              frame: 0,
              x: -s * 0.16,
              scale: 0.7,
              rotate: -18,
              opacity: 0,
              easing: "hold",
            },
            {
              frame: delay,
              x: -s * 0.16,
              scale: 0.7,
              rotate: -18,
              opacity: 0,
              easing: "cubic-bezier",
              bezier: arrive,
            },
            {
              frame: delay + 18,
              x: s * 0.01,
              scale: 1.025,
              rotate: 2,
              opacity: 0.55,
              easing: "cubic-bezier",
              bezier: travel,
            },
            {
              frame: 58 + index * 4,
              x: 0,
              scale: 1,
              rotate: index === 1 ? -9 : 8,
              opacity: 0.55,
              easing: "cubic-bezier",
              bezier: travel,
            },
            {
              frame: 92,
              x: 0,
              scale: 1,
              rotate: 0,
              opacity: 0.55,
              easing: "cubic-bezier",
              bezier: travel,
            },
            { frame: 119, x: s * 0.12, scale: 0.7, rotate: 12, opacity: 0 },
          ],
        ),
      );
    }
  }
  base.push(
    ellipse(
      "Orbit · drawn contour",
      w * 0.5,
      h * 0.5,
      s * 0.51,
      {
        background: "transparent",
        stroke: copper,
        strokeWidth: Math.max(1, s * 0.0018),
        opacity: 0.75,
      },
      motifKeys((frame) => ({
        trim:
          id === "signature-open" && frame === 0
            ? 0.36
            : frame === 58
              ? 0.8
              : 1,
      })),
    ),
    ellipse(
      "Orbit · shell",
      w * 0.5,
      h * 0.5,
      s * 0.42,
      { background: ink },
      motifKeys(),
    ),
    ellipse(
      "Orbit · counterform",
      w * 0.5 + s * 0.095,
      h * 0.5 - s * 0.035,
      s * 0.29,
      { background: paper },
      motifKeys(),
    ),
  );
  const startAngle = id === "signature-open" ? -22 : inverted ? 0 : -22;
  const endAngle = id === "signature-open" ? 0 : inverted ? -22 : -10;
  const angles: Record<number, number> = {
    0: startAngle,
    22: -13,
    58: 9,
    86: -8,
    119: endAngle,
  };
  base.push(
    layer(
      "Orbit · copper baton",
      "rectangle",
      w * 0.5 - s * 0.255,
      h * 0.5 + s * 0.028,
      s * 0.51,
      s * 0.071,
      {
        background: copper,
        radius: s * 0.018,
        musicAccent: true,
      },
      motifKeys((frame) => ({ rotate: angles[frame] })),
    ),
  );

  // Secondary motion continues through the read; endpoints join the next shot.
  const angleStart =
    id === "signature-open"
      ? -Math.PI * 0.25
      : inverted
        ? Math.PI * 0.5
        : -Math.PI * 0.5;
  const angleEnd =
    id === "signature-open"
      ? Math.PI * 0.5
      : inverted
        ? Math.PI * 1.5
        : Math.PI * 1.75;
  const orbit: Key[] = Array.from({ length: 13 }, (_, index) => {
    const t = index / 12,
      frame = Math.round(t * 119);
    const angle = angleStart + (angleEnd - angleStart) * t;
    const center =
      t <= 0.18
        ? {
            x: start.x + ((hold.x - start.x) * t) / 0.18,
            y: start.y + ((hold.y - start.y) * t) / 0.18,
          }
        : t >= 0.72
          ? {
              x: hold.x + ((end.x - hold.x) * (t - 0.72)) / 0.28,
              y: hold.y + ((end.y - hold.y) * (t - 0.72)) / 0.28,
            }
          : hold;
    return {
      frame,
      x: center.x - w * 0.5 + Math.cos(angle) * s * 0.255,
      y: center.y - h * 0.5 + Math.sin(angle) * s * 0.255,
      easing: "linear",
    };
  });
  base.push(
    ellipse(
      "Orbit · traveling point",
      w * 0.5,
      h * 0.5,
      s * 0.025,
      { background: copper, musicAccent: true },
      orbit,
    ),
  );

  base.push(
    label(
      "Brand · signature",
      "CUTLINE / SIGNATURE",
      0.068,
      0.079,
      portrait ? 0.58 : 0.44,
      0,
      {},
      true,
    ),
    label(
      "Chapter · index",
      `0${chapter} / ${chapter === 1 ? "DIRECTION" : chapter === 2 ? "INTENTION" : "RESOLUTION"}`,
      portrait ? 0.59 : 0.66,
      0.079,
      portrait ? 0.342 : 0.272,
      1,
      { align: "right" },
      true,
    ),
  );
  const titleY = portrait ? 0.175 : 0.23;
  const titleWidth = portrait ? 0.864 : id === "signature-close" ? 0.65 : 0.55;
  const bodyY = portrait ? 0.405 : 0.652;
  const final = id === "signature-close";
  base.push(
    text(
      "Headline · masked reveal",
      id === "signature-open"
        ? "SET THE\nPACE."
        : inverted
          ? "BUILT\nWITH INTENT."
          : "MAKE\nYOUR MARK.",
      0.068,
      titleY,
      titleWidth,
      portrait ? 0.137 : 0.135,
      0,
      {},
      final,
    ),
  );
  base.push(
    text(
      "Support · statement",
      id === "signature-open"
        ? "Motion with a clear direction."
        : inverted
          ? "Every element has a role."
          : "Create something worth watching.",
      0.07,
      bodyY,
      portrait ? 0.82 : 0.5,
      0.025,
      22,
      {
        fontWeight: 400,
        letterSpacing: 0,
        lineHeight: 1.2,
        textRevealFrames: Math.max(1, f(14)),
      },
      final,
    ),
  );
  base.push(
    layer(
      "Accent · underline",
      "line",
      w * 0.07,
      h * (bodyY + (portrait ? 0.046 : 0.071)),
      w * (portrait ? 0.23 : 0.13),
      Math.max(1, s * 0.0025),
      {
        stroke: copper,
        strokeWidth: Math.max(1, s * 0.0025),
        anchorX: 0,
        musicAccent: true,
      },
      [
        { frame: 0, trim: 0, easing: "hold" },
        { frame: 28, trim: 0, easing: "cubic-bezier", bezier: arrive },
        { frame: 48, trim: 1, easing: "cubic-bezier", bezier: travel },
        { frame: 80, trim: 0.7, easing: "cubic-bezier", bezier: travel },
        { frame: 102, trim: 1, easing: "hold" },
        { frame: 119, trim: 1 },
      ],
    ),
  );
  base.push(
    label(
      "Footer · editorial note",
      inverted
        ? "FORM / RHYTHM / RESOLVE"
        : final
          ? "LOCAL TOOLS. LIMITLESS IDEAS."
          : "A STUDY IN INTENTIONAL MOVEMENT",
      0.068,
      0.89,
      portrait ? 0.79 : 0.6,
      27,
      { color: inverted ? stone : charcoal },
      final,
    ),
    label(
      "Footer · progress",
      `0${chapter} / 03`,
      0.82,
      0.89,
      0.112,
      27,
      { align: "right", color: inverted ? stone : charcoal },
      final,
    ),
  );
  return base;
}
