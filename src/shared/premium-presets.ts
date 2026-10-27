import {
  MotionLayerSchema,
  type Clip,
  type MotionKeyframe,
  type MotionLayer,
  type Project,
} from "./model";
import { captionTextWidth } from "./caption-layout";
import { motionCounterText } from "./motion";

export const premiumSceneIds = [
  "explainer-signal",
  "explainer-count",
  "explainer-compare",
  "explainer-focus",
  "explainer-reveal",
] as const;
export type PremiumSceneId = (typeof premiumSceneIds)[number];
export const premiumScenes = [
  {
    id: "explainer-signal",
    name: "Signal route",
    description: "A request follows an editable curved route to its result",
    category: "Explainer motion",
    color: "#B8B3FF",
  },
  {
    id: "explainer-count",
    name: "Count the work",
    description: "A live number and twenty visible units build together",
    category: "Explainer motion",
    color: "#4055F5",
  },
  {
    id: "explainer-compare",
    name: "Clear comparison",
    description: "A shared wipe replaces a tangled process with a clear route",
    category: "Explainer motion",
    color: "#EAE7E0",
  },
  {
    id: "explainer-focus",
    name: "Focus the detail",
    description:
      "An editable diagram moves from context to one important detail",
    category: "Explainer motion",
    color: "#B8B3FF",
  },
  {
    id: "explainer-reveal",
    name: "Editorial reveal",
    description: "A circular reveal resolves into large composed typography",
    category: "Explainer motion",
    color: "#4055F5",
  },
] as const;

export function isPremiumScene(id: string): id is PremiumSceneId {
  return premiumSceneIds.includes(id as PremiumSceneId);
}

type Box = { x: number; y: number; width: number; height: number };
type Key = Partial<MotionKeyframe> & { frame: number };
const ink = "#141426";
const paper = "#F4F2ED";
const blue = "#4055F5";
const lavender = "#B8B3FF";
const muted = "#85849A";
const arrive: [number, number, number, number] = [0.22, 1, 0.36, 1];
const travel: [number, number, number, number] = [0.65, 0, 0.35, 1];

/** Original explanatory compositions. All objects remain native motion layers. */
export function premiumSceneLayers(
  p: Project,
  id: PremiumSceneId,
): MotionLayer[] {
  const w = p.width,
    h = p.height,
    s = Math.min(w, h),
    portrait = h > w;
  const f = (frame: number) => Math.round((frame * p.fps) / 30);
  const canvas: Box = { x: 0, y: 0, width: w, height: h };
  const box = (x: number, y: number, width: number, height: number): Box => ({
    x: x * w,
    y: y * h,
    width: width * w,
    height: height * h,
  });
  const layer = (
    name: string,
    type: MotionLayer["type"],
    bounds: Box,
    extra: Record<string, unknown> = {},
    keys: Key[] = [{ frame: 0 }],
  ): MotionLayer =>
    MotionLayerSchema.parse({
      name,
      type,
      ...bounds,
      musicAccent: false,
      fontSize: Math.max(8, Math.min(500, s * 0.04)),
      keyframes: keys.map((key) => ({ ...key, frame: f(key.frame) })),
      ...extra,
    });
  const text = (
    name: string,
    value: string,
    bounds: Box,
    size: number,
    extra: Record<string, unknown> = {},
    keys?: Key[],
  ) => {
    const lines = value.split("\n");
    const advance = Math.max(
      1,
      ...lines.map((line) => captionTextWidth(line, 1, "Helvetica", "800", 0)),
    );
    return layer(
      name,
      "text",
      bounds,
      {
        text: value,
        color: ink,
        fontFamily: "Helvetica",
        fontWeight: 800,
        fontSize: Math.max(
          8,
          Math.min(
            500,
            size,
            (bounds.width * 0.96) / advance,
            bounds.height / (lines.length * 1.1),
          ),
        ),
        align: "left",
        lineHeight: 1.05,
        ...extra,
      },
      keys,
    );
  };
  const ground = (color: string, name = "Ground", keys?: Key[], extra = {}) =>
    layer(name, "rectangle", canvas, { background: color, ...extra }, keys);
  const path = (
    name: string,
    d: string,
    stroke: string,
    strokeWidth: number,
    keys?: Key[],
    extra: Record<string, unknown> = {},
  ) =>
    layer(
      name,
      "path",
      canvas,
      {
        vectorPath: d,
        vectorViewBox: [0, 0, w, h],
        vectorAspectRatio: "none",
        vectorLineCap: "round",
        vectorLineJoin: "round",
        background: "transparent",
        stroke,
        strokeWidth,
        ...extra,
      },
      keys,
    );
  const circle = (x: number, y: number, r: number) =>
    `M${x - r} ${y} A${r} ${r} 0 1 0 ${x + r} ${y} A${r} ${r} 0 1 0 ${x - r} ${y} Z`;

  if (id === "explainer-signal") {
    const start = { x: w * 0.22, y: h * (portrait ? 0.38 : 0.57) };
    const end = { x: w * 0.78, y: h * (portrait ? 0.72 : 0.57) };
    const c1 = { x: w * 0.18, y: h * (portrait ? 0.68 : 0.22) };
    const c2 = { x: w * 0.82, y: h * (portrait ? 0.42 : 0.92) };
    const route = `M${start.x} ${start.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`;
    const r = s * 0.065;
    const packet = s * 0.058;
    return [
      ground(ink),
      text(
        "Signal title",
        "Follow the\nsignal",
        box(0.09, 0.08, 0.82, portrait ? 0.22 : 0.27),
        s * 0.135,
        {
          color: paper,
          textAnimation: "line-reveal",
          textRevealFrames: f(16),
          staggerFrames: f(3),
        },
      ),
      path("Route outline", route, "#39384F", s * 0.012),
      path("Route drawn", route, lavender, s * 0.012, [
        { frame: 0, trim: 0 },
        { frame: 16, trim: 0, easing: "linear" },
        { frame: 82, trim: 1 },
      ]),
      path(
        "Source node",
        circle(start.x, start.y, r),
        lavender,
        s * 0.008,
        undefined,
        { background: ink },
      ),
      path(
        "Result node",
        circle(end.x, end.y, r),
        lavender,
        s * 0.008,
        undefined,
        { background: ink },
      ),
      layer(
        "Travelling request",
        "triangle",
        {
          x: start.x - packet / 2,
          y: start.y - packet / 2,
          width: packet,
          height: packet,
        },
        {
          background: paper,
          rotate: 90,
          motionPath: {
            points: [start, c1, c2, end].map((point) => ({
              x: point.x - start.x,
              y: point.y - start.y,
            })),
            autoOrient: true,
          },
        },
        [
          { frame: 0, pathProgress: 0 },
          { frame: 16, pathProgress: 0, easing: "linear" },
          { frame: 82, pathProgress: 1 },
        ],
      ),
      text(
        "Source label",
        "Request",
        {
          x: start.x - s * 0.17,
          y: start.y + r * 1.4,
          width: s * 0.34,
          height: s * 0.075,
        },
        s * 0.047,
        { color: paper, align: "center" },
      ),
      text(
        "Result label",
        "Result",
        {
          x: end.x - s * 0.17,
          y: end.y + r * 1.4,
          width: s * 0.34,
          height: s * 0.075,
        },
        s * 0.047,
        { color: paper, align: "center" },
      ),
      text(
        "Result payoff",
        "The next step\nis visible",
        box(0.12, portrait ? 0.83 : 0.8, 0.76, portrait ? 0.1 : 0.15),
        s * 0.053,
        { color: lavender, align: "center", revealMask: "wipe-up" },
        [
          { frame: 0, reveal: 0 },
          { frame: 84, reveal: 0, easing: "cubic-bezier", bezier: arrive },
          { frame: 100, reveal: 1 },
        ],
      ),
    ];
  }

  if (id === "explainer-count") {
    const columns = portrait ? 4 : 10;
    const rows = 20 / columns;
    const region = portrait
      ? box(0.12, 0.48, 0.76, 0.36)
      : box(0.09, 0.6, 0.82, 0.24);
    const gap = s * 0.018;
    const cellW = (region.width - gap * (columns - 1)) / columns;
    const cellH = (region.height - gap * (rows - 1)) / rows;
    const layers = [
      ground(paper),
      text(
        "Quantity",
        "20",
        box(0.09, 0.09, 0.82, portrait ? 0.26 : 0.35),
        s * 0.39,
        {
          color: blue,
          counter: {
            from: 0,
            to: 20,
            startFrame: f(12),
            durationFrames: f(60),
            easing: "linear",
          },
        },
      ),
      text(
        "Quantity unit",
        "tasks completed",
        box(0.1, portrait ? 0.35 : 0.43, 0.8, 0.09),
        s * 0.068,
      ),
    ];
    for (let i = 0; i < 20; i++) {
      const bounds = {
        x: region.x + (i % columns) * (cellW + gap),
        y: region.y + Math.floor(i / columns) * (cellH + gap),
        width: cellW,
        height: cellH,
      };
      layers.push(
        layer(`Task ${i + 1} slot`, "rectangle", bounds, {
          background: "#DDDBD6",
          radius: s * 0.009,
        }),
      );
      // Counter rounds to the nearest whole unit. The corresponding block arrives on that exact frame.
      const at = (Math.ceil(f(12) + ((i + 0.5) * f(60)) / 20) * 30) / p.fps;
      layers.push(
        layer(
          `Task ${i + 1} completed`,
          "rectangle",
          bounds,
          { background: blue, radius: s * 0.009 },
          [
            { frame: 0, opacity: 0, easing: "hold" },
            { frame: at, opacity: 1 },
          ],
        ),
      );
    }
    return layers;
  }

  if (id === "explainer-compare") {
    const a = { x: w * 0.2, y: h * (portrait ? 0.42 : 0.58) };
    const b = { x: w * 0.5, y: h * (portrait ? 0.58 : 0.58) };
    const c = { x: w * 0.8, y: h * (portrait ? 0.74 : 0.58) };
    const r = s * 0.057;
    const tangled = `M${a.x} ${a.y} C${w * 0.92} ${h * 0.18} ${w * 0.08} ${h * 0.95} ${c.x} ${c.y} M${a.x} ${a.y} C${w * 0.9} ${h * 0.95} ${w * 0.04} ${h * 0.32} ${c.x} ${c.y} M${a.x} ${a.y} L${c.x} ${a.y} L${b.x} ${h * 0.87} L${b.x} ${h * 0.33} L${c.x} ${c.y}`;
    const clear = `M${a.x} ${a.y} L${b.x} ${b.y} L${c.x} ${c.y}`;
    const nodes = [a, b, c]
      .map((point) => circle(point.x, point.y, r))
      .join(" ");
    const wipe: Key[] = [
      { frame: 0, reveal: 0 },
      { frame: 30, reveal: 0, easing: "cubic-bezier", bezier: travel },
      { frame: 82, reveal: 1 },
    ];
    // The background and vector diagrams share one full-canvas mask coordinate space.
    // Their leading edges therefore remain connected rather than wiping each object locally.
    return [
      ground(ink),
      path("Tangled process", tangled, muted, s * 0.01),
      path("Tangled nodes", nodes, muted, s * 0.006, undefined, {
        background: ink,
      }),
      ground(paper, "Comparison wipe", wipe, { revealMask: "wipe-right" }),
      path("Clear route", clear, blue, s * 0.013, wipe, {
        revealMask: "wipe-right",
      }),
      path("Clear nodes", nodes, blue, s * 0.008, wipe, {
        revealMask: "wipe-right",
        background: paper,
      }),
      text(
        "Before title",
        "Too many\nways through",
        box(0.09, 0.08, 0.82, 0.24),
        s * 0.13,
        { color: paper },
        [
          { frame: 0, opacity: 1, easing: "hold" },
          { frame: 30, opacity: 1, easing: "ease-out" },
          { frame: 43, opacity: 0 },
        ],
      ),
      text(
        "After title",
        "One clear\nnext step",
        box(0.09, 0.08, 0.82, 0.24),
        s * 0.13,
        { color: ink, revealMask: "wipe-right" },
        [
          { frame: 0, reveal: 0 },
          { frame: 59, reveal: 0, easing: "cubic-bezier", bezier: arrive },
          { frame: 85, reveal: 1 },
        ],
      ),
      ...[a, b, c].map((point, index) =>
        text(
          `Clear step ${index + 1}`,
          ["Start", "Decide", "Finish"][index],
          {
            x: point.x - s * 0.12,
            y: point.y + r * 1.5,
            width: s * 0.24,
            height: s * 0.065,
          },
          s * 0.038,
          { color: blue, align: "center" },
          [
            { frame: 0, opacity: 0 },
            { frame: 79, opacity: 0, easing: "ease-out" },
            { frame: 94, opacity: 1 },
          ],
        ),
      ),
    ];
  }

  if (id === "explainer-focus") {
    const dx = w * (portrait ? 0.27 : 0.25);
    const dy = h * (portrait ? 0.19 : 0.24);
    const bw = Math.min(w * 0.2, s * 0.29);
    const bh = Math.min(h * 0.13, s * 0.19);
    const layers = [ground(ink)];
    const terms = [
      "Input",
      "Context",
      "Source",
      "Cause",
      "Why",
      "Effect",
      "Test",
      "Evidence",
      "Result",
    ];
    const connectors: string[] = [];
    for (let index = 0; index < 9; index++) {
      const x = w / 2 + ((index % 3) - 1) * dx;
      const y = h / 2 + (Math.floor(index / 3) - 1) * dy;
      if (index !== 4) connectors.push(`M${x} ${y} L${w / 2} ${h / 2}`);
    }
    layers.push(
      path("Context connections", connectors.join(" "), "#4C4B65", s * 0.005),
    );
    for (let index = 0; index < 9; index++) {
      const center = index === 4;
      const bounds = {
        x: w / 2 + ((index % 3) - 1) * dx - bw / 2,
        y: h / 2 + (Math.floor(index / 3) - 1) * dy - bh / 2,
        width: bw,
        height: bh,
      };
      layers.push(
        layer(`${terms[index]} plane`, "rectangle", bounds, {
          background: center ? lavender : "#252438",
          radius: s * 0.014,
        }),
      );
      layers.push(
        text(
          `${terms[index]} label`,
          terms[index],
          bounds,
          s * (center ? 0.073 : 0.037),
          { color: center ? ink : paper, align: "center" },
        ),
      );
    }
    layers.push(
      text(
        "Context caption",
        "See the whole system",
        box(0.1, 0.08, 0.8, 0.1),
        s * 0.065,
        { color: paper, align: "center" },
        [
          { frame: 0, opacity: 1 },
          { frame: 30, opacity: 1, easing: "ease-in" },
          { frame: 45, opacity: 0 },
        ],
      ),
    );
    return layers;
  }

  const title = portrait ? "MAKE\nTHE IDEA\nVISIBLE" : "MAKE THE\nIDEA VISIBLE";
  return [
    ground(paper),
    ground(
      blue,
      "Iris field",
      [
        { frame: 0, reveal: 0 },
        { frame: 8, reveal: 0, easing: "cubic-bezier", bezier: arrive },
        { frame: 42, reveal: 1 },
      ],
      { revealMask: "iris" },
    ),
    text(
      "Opening word",
      "Idea",
      box(0.1, 0.36, 0.8, 0.28),
      s * 0.25,
      { align: "center", color: blue },
      [
        {
          frame: 0,
          opacity: 1,
          scale: 0.92,
          rotateY: -14,
          easing: "cubic-bezier",
          bezier: arrive,
        },
        { frame: 15, opacity: 1, scale: 1, rotateY: 0 },
        { frame: 24, opacity: 0 },
      ],
    ),
    text(
      "Editorial payoff",
      title,
      box(0.09, portrait ? 0.2 : 0.18, 0.82, portrait ? 0.58 : 0.64),
      s * (portrait ? 0.19 : 0.2),
      {
        color: paper,
        textAnimation: "line-reveal",
        textRevealStart: f(26),
        textRevealFrames: f(19),
        staggerFrames: f(5),
      },
    ),
  ];
}

/** These connected scenes retime as one choreography, preserving cause and result. */
export function retimePremiumLayers(
  layers: MotionLayer[],
  originalFrames: number,
  frames: number,
  id: PremiumSceneId,
): MotionLayer[] {
  const ratio = (frames - 1) / Math.max(1, originalFrames - 1);
  const at = (frame: number) =>
    Math.max(0, Math.min(frames - 1, Math.round(frame * ratio)));
  const retimed =
    frames === originalFrames
      ? layers
      : layers.map((layer) => {
          const keys = new Map<number, MotionKeyframe>();
          for (const key of layer.keyframes) {
            const frame = at(key.frame);
            keys.set(frame, { ...keys.get(frame), ...key, frame });
          }
          return {
            ...layer,
            keyframes: [...keys.values()].sort((a, b) => a.frame - b.frame),
            textRevealStart: at(layer.textRevealStart),
            textRevealFrames: Math.max(
              1,
              Math.min(1800, Math.round(layer.textRevealFrames * ratio)),
            ),
            staggerFrames: Math.max(
              1,
              Math.min(30, Math.round(layer.staggerFrames * ratio)),
            ),
            ...(layer.counter
              ? {
                  counter: {
                    ...layer.counter,
                    startFrame: Math.min(
                      frames - 2,
                      at(layer.counter.startFrame),
                    ),
                    durationFrames: Math.max(
                      1,
                      at(
                        layer.counter.startFrame + layer.counter.durationFrames,
                      ) - Math.min(frames - 2, at(layer.counter.startFrame)),
                    ),
                  },
                }
              : {}),
          };
        });
  if (id !== "explainer-count") return retimed;
  const quantity = retimed.find((layer) => layer.name === "Quantity")!;
  const counter = quantity.counter!;
  return retimed.map((layer) => {
    const completion = /^Task (\d+) completed$/.exec(layer.name ?? "");
    if (!completion) return layer;
    const count = Number(completion[1]);
    let frame =
      counter.startFrame +
      Math.max(0, Math.ceil(((count - 0.5) * counter.durationFrames) / 20));
    // Use the same deterministic rounding as preview/export at the boundary.
    while (
      frame < frames - 1 &&
      Number(motionCounterText(quantity, frame)) < count
    )
      frame++;
    while (frame > 0 && Number(motionCounterText(quantity, frame - 1)) >= count)
      frame--;
    return {
      ...layer,
      keyframes:
        frame === 0
          ? [{ frame: 0, opacity: 1, easing: "linear" as const }]
          : [
              { frame: 0, opacity: 0, easing: "hold" as const },
              { frame, opacity: 1, easing: "linear" as const },
            ],
    };
  });
}

/** Transform the full editable scene, keeping the zoom's diagram objects together. */
export function premiumClipKeyframes(
  p: Project,
  id: PremiumSceneId,
  frames: number,
): Clip["keyframes"] {
  if (id !== "explainer-focus") return [];
  const at = (frame: number) => Math.round((frame / 119) * (frames - 1));
  const byFrame = new Map<number, Clip["keyframes"][number]>();
  for (const [frame, value, easing] of [
    [0, 1, "hold"],
    [29, 1, "cubic-bezier"],
    [77, p.height > p.width ? 3.1 : 3.3, "hold"],
    [119, p.height > p.width ? 3.1 : 3.3, "linear"],
  ] as const)
    byFrame.set(at(frame), {
      property: "scale",
      frame: at(frame),
      value,
      easing,
      ...(easing === "cubic-bezier" ? { bezier: travel } : {}),
    });
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}
