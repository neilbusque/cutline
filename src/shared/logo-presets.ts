import {
  MotionLayerSchema,
  MotionSchema,
  uid,
  type Motion,
  type MotionKeyframe,
  type MotionLayer,
  type Project,
} from "./model";
import { applyCommands, type Command } from "./commands";

export const logoRevealStyles = ["draw", "orbit", "signal"] as const;
export type LogoRevealStyle = (typeof logoRevealStyles)[number];
export const logoSceneIds = ["logo-draw", "logo-orbit", "logo-signal"] as const;
export type LogoSceneId = (typeof logoSceneIds)[number];
export const logoPalette = {
  paper: "#F4F1E9",
  ink: "#1E2827",
  ochre: "#C49957",
  mist: "#D0D4CB",
} as const;
export const logoScenes = [
  {
    id: "logo-draw",
    name: "Logo / Draw",
    description: "A custom contour draws, then fills",
    category: "Logos",
    color: logoPalette.paper,
  },
  {
    id: "logo-orbit",
    name: "Logo / Orbit",
    description: "An orbital entrance with a measured settle",
    category: "Logos",
    color: logoPalette.ink,
  },
  {
    id: "logo-signal",
    name: "Logo / Signal",
    description: "A precise reveal with expanding echoes",
    category: "Logos",
    color: logoPalette.ochre,
  },
] as const;

/** Original angular C/L construction, authored for these editable compositions. */
export const originalLogoPaths = [
  {
    name: "Monogram · C contour",
    path: "M200 40L156 8H80L16 72V184L80 248H156L200 216L176 176L144 208H100L60 168V88L100 48H144L176 80Z",
  },
  { name: "Monogram · L ribbon", path: "M174 101H214V168H246V208H174Z" },
] as const;
export const originalLogoViewBox: [number, number, number, number] = [
  0, 0, 256, 256,
];
export function isLogoScene(id: string): id is LogoSceneId {
  return logoSceneIds.includes(id as LogoSceneId);
}

const arrive: [number, number, number, number] = [0.16, 1, 0.3, 1];
const flow: [number, number, number, number] = [0.65, 0, 0.35, 1];
type Key = Omit<MotionKeyframe, "easing"> & {
  easing?: MotionKeyframe["easing"];
};
export type LogoRevealOptions = {
  style: LogoRevealStyle;
  durationFrames?: number;
  animationOffset?: number;
};

function revealKeys(
  layer: MotionLayer,
  style: LogoRevealStyle,
  frames: number,
  phase: number,
  index: number,
  count: number,
): MotionKeyframe[] {
  const at = (fraction: number) =>
    phase +
    Math.min(frames - 1, Math.max(0, Math.round(fraction * (frames - 1))));
  const delay = count > 1 ? Math.min(0.06, 0.12 / (count - 1)) * index : 0;
  const start = at(delay);
  const endDraw = at(
    delay + (style === "draw" ? 0.37 : style === "orbit" ? 0.31 : 0.2),
  );
  const endFill = Math.min(
    phase + frames - 1,
    Math.max(
      start + 1,
      at(delay + (style === "draw" ? 0.56 : style === "orbit" ? 0.53 : 0.36)),
    ),
  );
  const fill = layer.background === "transparent" ? 0 : layer.fillOpacity;
  const outline =
    layer.strokeWidth > 0
      ? layer.strokeWidth
      : Math.max(1, Math.min(4, Math.min(layer.width, layer.height) * 0.008));
  const initial: Key = {
    frame: start,
    trim: 0,
    fillOpacity: 0,
    ...(layer.strokeWidth === 0 ? { strokeWidth: outline } : {}),
    easing: "cubic-bezier",
    bezier: arrive,
  };
  const drawn: Key = {
    frame: endDraw,
    trim: 1,
    fillOpacity: 0,
    ...(layer.strokeWidth === 0 ? { strokeWidth: outline } : {}),
    easing: "cubic-bezier",
    bezier: arrive,
  };
  const filled: Key = {
    frame: endFill,
    trim: 1,
    fillOpacity: fill,
    ...(layer.strokeWidth === 0 ? { strokeWidth: 0 } : {}),
    easing: "hold",
  };
  if (style === "orbit") {
    Object.assign(initial, {
      scale: layer.scale * 0.84,
      rotate: Math.max(-3600, layer.rotate - 28),
    });
    Object.assign(drawn, {
      scale: Math.min(10, layer.scale * 1.018),
      rotate: Math.min(3600, layer.rotate + 4),
    });
    Object.assign(filled, { scale: layer.scale, rotate: layer.rotate });
  }
  if (style === "signal") {
    Object.assign(initial, {
      scale: layer.scale * 0.94,
      opacity: layer.opacity * 0.2,
    });
    Object.assign(drawn, {
      scale: Math.min(10, layer.scale * 1.025),
      opacity: layer.opacity,
    });
    Object.assign(filled, { scale: layer.scale, opacity: layer.opacity });
  }
  // Coalescing very short reveals keeps all phases legal without duplicate values.
  const compact = new Map<number, Key>();
  if (start > phase)
    compact.set(phase, { ...initial, frame: phase, easing: "hold" });
  for (const key of [initial, drawn, filled])
    compact.set(key.frame, { ...compact.get(key.frame), ...key });
  return [...compact.values()].map((key) => ({
    ...key,
    easing: key.easing ?? "linear",
  }));
}

/** Replace reveal properties only; sparse same-frame keys keep unrelated curves' easing intact. */
export function applyLogoReveal(
  motion: Motion,
  { style, durationFrames = 120, animationOffset = 0 }: LogoRevealOptions,
): Motion {
  if (!logoRevealStyles.includes(style))
    throw Error("Choose Draw, Orbit or Signal for the logo reveal.");
  if (
    !Number.isInteger(durationFrames) ||
    durationFrames < 2 ||
    durationFrames > 18000
  )
    throw Error("Choose a logo reveal duration from 2 to 18,000 whole frames.");
  if (!Number.isInteger(animationOffset) || animationOffset < 0)
    throw Error(
      "The logo reveal animation phase must be a nonnegative whole frame.",
    );
  const targets = motion.layers.filter(
    (layer) => layer.type === "path" && !layer.hidden,
  );
  if (!targets.length)
    throw Error("Choose a motion clip with a visible custom vector path.");
  if (targets.some((layer) => layer.loop !== "none"))
    throw Error("Turn off vector looping before applying a logo reveal.");
  const replaced = new Set<string>([
    "trim",
    "fillOpacity",
    ...(style === "orbit"
      ? ["scale", "rotate"]
      : style === "signal"
        ? ["scale", "opacity"]
        : []),
  ]);
  let index = 0;
  const layers = motion.layers.map((layer) => {
    if (layer.type !== "path" || layer.hidden) return structuredClone(layer);
    const existing = layer.keyframes.flatMap((key) => {
      const retained = Object.fromEntries(
        Object.entries(key).filter(
          ([property]) =>
            !replaced.has(property) &&
            !(property === "strokeWidth" && layer.strokeWidth === 0),
        ),
      );
      return Object.keys(retained).some(
        (property) => !["frame", "easing", "bezier"].includes(property),
      )
        ? [retained as MotionKeyframe]
        : [];
    });
    const additions = revealKeys(
      layer,
      style,
      durationFrames,
      animationOffset,
      index++,
      targets.length,
    );
    const keyframes = [...existing, ...additions].sort(
      (a, b) => a.frame - b.frame,
    );
    if (keyframes.length > 100)
      throw Error(
        "This vector uses too many animation keys for a reveal. Remove a few keys first.",
      );
    return MotionLayerSchema.parse({
      ...layer,
      ...(layer.strokeWidth === 0 && layer.background !== "transparent"
        ? { stroke: layer.background }
        : {}),
      keyframes,
    });
  });
  return MotionSchema.parse({ ...motion, layers });
}

/** Isolate a trimmed or split clip's motion before applying one atomic, undoable edit. */
export function createLogoRevealCommands(
  p: Project,
  clipId: string,
  style: LogoRevealStyle,
  options: { durationFrames?: number } = {},
): Command[] {
  const clip = p.clips.find((item) => item.id === clipId);
  if (
    !clip ||
    clip.kind !== "text" ||
    clip.preset !== "custom" ||
    !clip.motionId
  )
    throw Error("Select a custom motion clip containing a vector logo.");
  const motion = p.motions.find((item) => item.id === clip.motionId);
  if (!motion)
    throw Error("The selected clip's vector composition is missing.");
  const frames = options.durationFrames ?? Math.min(clip.duration, 18000);
  if (frames > clip.duration)
    throw Error("The logo reveal duration must fit inside the selected clip.");
  const replacement = applyLogoReveal(motion, {
    style,
    durationFrames: frames,
    animationOffset: clip.animationOffset,
  });
  const cloned = MotionSchema.parse({
    ...replacement,
    id: uid(),
    name: `${motion.name.slice(0, 78)} · ${style[0].toUpperCase()}${style.slice(1)} reveal`,
  });
  const commands: Command[] = [
    { type: "motion.put", motion: cloned },
    { type: "clip.update", id: clip.id, patch: { motionId: cloned.id } },
  ];
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: `${style} logo reveal`,
    commands,
  });
  return commands;
}

export function logoSceneLayers(p: Project, id: LogoSceneId): MotionLayer[] {
  const w = p.width,
    h = p.height,
    s = Math.min(w, h),
    portrait = h > w;
  const f = (frame: number) => Math.round((frame * p.fps) / 30);
  const { paper, ink, ochre, mist } = logoPalette;
  const dark = id === "logo-orbit",
    background = dark ? ink : paper,
    foreground = dark ? paper : ink;
  const centerY = portrait ? 0.4 : 0.43;
  const diameter = s * (portrait ? 0.4 : 0.34);
  const center = { x: w * 0.5, y: h * centerY };
  const layer = (
    name: string,
    type: MotionLayer["type"],
    x: number,
    y: number,
    width: number,
    height: number,
    extra: Record<string, unknown> = {},
    keys: Key[] = [{ frame: 0 }],
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
      keyframes: keys.map((key) => ({ ...key, frame: f(key.frame) })),
      ...extra,
    });
  const text = (
    name: string,
    value: string,
    y: number,
    width: number,
    size: number,
    start: number,
    extra: Record<string, unknown> = {},
  ) => {
    const tracking =
      typeof extra.letterSpacing === "number" ? extra.letterSpacing : 0;
    const fontSize = Math.max(
      8,
      Math.min(
        500,
        s * size,
        (w * width - Math.max(0, value.length - 1) * Math.max(0, tracking)) /
          Math.max(1, value.length * 0.65),
      ),
    );
    return layer(
      name,
      "text",
      ((1 - width) * w) / 2,
      y * h,
      width * w,
      fontSize * 1.5,
      {
        text: value,
        color: foreground,
        align: "center",
        fontWeight: 600,
        fontSize,
        lineHeight: 1.2,
        letterSpacing: -fontSize * 0.025,
        textAnimation: "line-reveal",
        textRevealStart: f(start),
        textRevealFrames: Math.max(1, f(13)),
        staggerFrames: Math.max(1, f(4)),
        ...extra,
      },
    );
  };
  const ellipse = (
    name: string,
    width: number,
    height: number,
    extra: Record<string, unknown>,
    keys: Key[],
  ) =>
    layer(
      name,
      "ellipse",
      center.x - width / 2,
      center.y - height / 2,
      width,
      height,
      extra,
      keys,
    );
  const layers: MotionLayer[] = [
    layer("Paper · background", "rectangle", 0, 0, w, h, { background }),
    layer(
      "Frame · top rule",
      "line",
      w * 0.075,
      h * 0.14,
      w * 0.85,
      Math.max(1, s * 0.0013),
      {
        stroke: dark ? mist : ink,
        strokeWidth: Math.max(1, s * 0.0013),
        opacity: 0.35,
        anchorX: 0,
      },
      [
        { frame: 0, trim: 0.5, easing: "cubic-bezier", bezier: arrive },
        { frame: 20, trim: 1 },
      ],
    ),
  ];
  if (id === "logo-draw") {
    for (const [index, side] of [-1, 1].entries()) {
      layers.push(
        layer(
          `Construction · bracket ${index + 1}`,
          "line",
          center.x + side * s * 0.265 - s * 0.215,
          center.y,
          s * 0.43,
          Math.max(1, s * 0.0016),
          {
            stroke: ochre,
            strokeWidth: Math.max(1, s * 0.0016),
            rotate: 90,
            opacity: 0.65,
            musicAccent: true,
          },
          [
            { frame: 0, trim: 0.4, easing: "cubic-bezier", bezier: arrive },
            { frame: 28, trim: 1 },
          ],
        ),
      );
    }
  } else if (dark) {
    layers.push(
      ellipse(
        "Orbit · back trajectory",
        s * 0.65,
        s * 0.38,
        {
          background: "transparent",
          stroke: ochre,
          strokeWidth: Math.max(1, s * 0.0018),
          opacity: 0.7,
        },
        [
          {
            frame: 0,
            trim: 0.3,
            rotate: -28,
            easing: "cubic-bezier",
            bezier: arrive,
          },
          {
            frame: 30,
            trim: 1,
            rotate: 16,
            easing: "cubic-bezier",
            bezier: flow,
          },
          {
            frame: 78,
            trim: 0.8,
            rotate: 34,
            easing: "cubic-bezier",
            bezier: flow,
          },
          { frame: 119, trim: 1, rotate: 10 },
        ],
      ),
    );
  } else {
    for (let index = 0; index < 2; index++) {
      const delay = index * 9;
      layers.push(
        ellipse(
          `Signal · echo ${index + 1}`,
          s * 0.49,
          s * 0.49,
          {
            background: "transparent",
            stroke: ochre,
            strokeWidth: Math.max(1, s * 0.002),
            musicAccent: true,
          },
          [
            { frame: 0, scale: 0.85, opacity: 0, easing: "hold" },
            {
              frame: 8 + delay,
              scale: 0.85,
              opacity: 0.6,
              easing: "cubic-bezier",
              bezier: flow,
            },
            { frame: 45 + delay, scale: 1.25, opacity: 0, easing: "hold" },
            {
              frame: 67 + delay,
              scale: 0.9,
              opacity: 0.4,
              easing: "cubic-bezier",
              bezier: flow,
            },
            { frame: 110 + delay, scale: 1.25, opacity: 0 },
          ],
        ),
      );
    }
  }
  const marks = originalLogoPaths.map((mark, index) =>
    layer(
      mark.name,
      "path",
      center.x - diameter / 2,
      center.y - diameter / 2,
      diameter,
      diameter,
      {
        vectorPath: mark.path,
        vectorViewBox: originalLogoViewBox,
        vectorFillRule: "nonzero",
        background: index === 0 ? foreground : ochre,
        stroke: index === 0 ? foreground : ochre,
        strokeWidth: 0,
      },
    ),
  );
  const revealed = applyLogoReveal(
    MotionSchema.parse({
      id: "logo-master",
      name: "Original monogram",
      layers: marks,
    }),
    {
      style: id === "logo-draw" ? "draw" : dark ? "orbit" : "signal",
      durationFrames: p.fps * 4,
    },
  );
  layers.push(...revealed.layers);
  if (dark) {
    layers.push(
      ellipse(
        "Orbit · foreground arc",
        s * 0.65,
        s * 0.38,
        {
          background: "transparent",
          stroke: ochre,
          strokeWidth: Math.max(1, s * 0.0018),
          musicAccent: true,
        },
        [
          {
            frame: 0,
            trim: 0.12,
            rotate: 152,
            opacity: 0.2,
            easing: "cubic-bezier",
            bezier: arrive,
          },
          {
            frame: 30,
            trim: 0.24,
            rotate: 196,
            opacity: 0.7,
            easing: "cubic-bezier",
            bezier: flow,
          },
          {
            frame: 78,
            trim: 0.17,
            rotate: 214,
            opacity: 0.7,
            easing: "cubic-bezier",
            bezier: flow,
          },
          { frame: 119, trim: 0.24, rotate: 190, opacity: 0.7 },
        ],
      ),
    );
  }
  const titleY = portrait ? 0.61 : 0.675;
  const supportY = portrait ? 0.705 : 0.807;
  const chapter = logoSceneIds.indexOf(id) + 1;
  layers.push(
    text(
      "Heading · study",
      `0${chapter} / ${id === "logo-draw" ? "DRAWN WITH INTENT" : dark ? "CONTROLLED MOMENTUM" : "A CLEAR SIGNAL"}`,
      0.085,
      0.8,
      0.018,
      0,
      { fontWeight: 500, letterSpacing: s * 0.0013 },
    ),
    text("Wordmark · Cutline", "CUTLINE", titleY, 0.78, 0.079, dark ? 28 : 34, {
      letterSpacing: s * 0.002,
    }),
    text(
      "Support · statement",
      id === "logo-draw"
        ? "Create. Shape. Move."
        : dark
          ? "A mark with momentum."
          : "Ideas with a clear signal.",
      supportY,
      0.79,
      0.022,
      42,
      { fontWeight: 400, letterSpacing: 0 },
    ),
    text(
      "Footer · editable note",
      "ORIGINAL VECTOR / EDITABLE PATHS",
      0.915,
      0.85,
      0.016,
      50,
      { fontWeight: 500, letterSpacing: s * 0.001 },
    ),
  );
  return layers;
}
