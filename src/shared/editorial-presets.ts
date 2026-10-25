import {
  MotionLayerSchema,
  type MotionKeyframe,
  type MotionLayer,
  type Project,
} from "./model";
import { captionTextWidth } from "./caption-layout";

export const editorialSceneIds = [
  "editorial-transfer",
  "editorial-compare",
  "editorial-focus",
] as const;
export type EditorialSceneId = (typeof editorialSceneIds)[number];

export const editorialScenes = [
  {
    id: "editorial-transfer",
    name: "Editorial / Transfer",
    description:
      "One packet travels a connected system and changes its receivers",
    category: "Editorial",
    color: "#DDE9F2",
  },
  {
    id: "editorial-compare",
    name: "Editorial / Compare",
    description:
      "A moving divider resolves a rough sketch into an aligned result",
    category: "Editorial",
    color: "#EFE9DC",
  },
  {
    id: "editorial-focus",
    name: "Editorial / Focus",
    description: "Find one passage, enlarge its detail, and hold the outcome",
    category: "Editorial",
    color: "#DDE8E0",
  },
] as const;

export function isEditorialScene(id: string): id is EditorialSceneId {
  return editorialSceneIds.includes(id as EditorialSceneId);
}

type Key = Partial<MotionKeyframe> & { frame: number };
const travel: [number, number, number, number] = [0.65, 0, 0.35, 1];
const land: [number, number, number, number] = [0.22, 1, 0.36, 1];
const palette = {
  paper: "#F5F2EA",
  ink: "#1D2B35",
  muted: "#69757B",
  edge: "#CCD4D5",
  accent: "#306A8D",
  tint: "#DDE9F2",
};

/**
 * Original, four-second, native story mechanisms, not branded creator copies.
 * All marks remain independent editable layers. The common scene packager
 * handles duration changes; the story resolves before the final reading hold.
 * These schematic examples are illustrative and make no product/metric claims.
 */
export function editorialSceneLayers(
  p: Project,
  id: EditorialSceneId,
): MotionLayer[] {
  const { width: w, height: h } = p;
  const s = Math.min(w, h);
  const portrait = h > w;
  const f = (frame: number) => Math.round((frame * p.fps) / 30);
  const layer = (
    name: string,
    type: MotionLayer["type"],
    box: { x: number; y: number; width: number; height: number },
    extra: Record<string, unknown> = {},
    frames: Key[] = [{ frame: 0 }],
  ): MotionLayer =>
    MotionLayerSchema.parse({
      name,
      type,
      ...box,
      fontSize: Math.max(8, Math.min(500, s * 0.03)),
      musicAccent: false,
      keyframes: frames.map((key) => ({ ...key, frame: f(key.frame) })),
      ...extra,
    });
  const text = (
    name: string,
    value: string,
    x: number,
    y: number,
    width: number,
    preferredSize: number,
    extra: Record<string, unknown> = {},
    frames?: Key[],
  ) => {
    const advance = Math.max(
      ...value
        .split("\n")
        .map((line) => captionTextWidth(line, 1, "Helvetica", "600", 0)),
    );
    const size = Math.max(
      8,
      Math.min(500, preferredSize, (width * 0.94) / advance),
    );
    return layer(
      name,
      "text",
      { x, y, width, height: size * 1.2 * value.split("\n").length },
      {
        text: value,
        color: palette.ink,
        fontSize: size,
        fontWeight: 600,
        lineHeight: 1.2,
        align: "left",
        ...extra,
      },
      frames,
    );
  };
  const path = (
    name: string,
    box: { x: number; y: number; width: number; height: number },
    points: ReadonlyArray<readonly [number, number]>,
    stroke: string,
    frames?: Key[],
    strokeWidth = Math.max(1, s * 0.004),
  ) =>
    layer(
      name,
      "path",
      box,
      {
        // Use pixel geometry so thin horizontal/vertical routes retain the
        // same stroke width even on very tall or very wide project canvases.
        vectorPath: points
          .map(
            ([x, y], index) =>
              `${index ? "L" : "M"}${(x * box.width) / 100} ${(y * box.height) / 100}`,
          )
          .join(" "),
        vectorViewBox: [0, 0, box.width, box.height],
        vectorAspectRatio: "none",
        vectorLineCap: "round",
        vectorLineJoin: "round",
        background: "transparent",
        stroke,
        strokeWidth,
      },
      frames,
    );
  const background = layer(
    "Paper background",
    "rectangle",
    { x: 0, y: 0, width: w, height: h },
    { background: palette.paper },
  );
  const header = (value: string) =>
    text("Scene intention", value, w * 0.08, h * 0.1, w * 0.84, s * 0.07);
  const note = text(
    "Illustrative example label",
    "Illustrative example",
    w * 0.08,
    h * 0.84,
    w * 0.84,
    s * 0.025,
    { color: palette.muted, fontWeight: 400 },
  );
  const appear = (start: number, end = start + 8): Key[] => [
    { frame: 0, opacity: 0, easing: "hold" },
    { frame: start, opacity: 0, easing: "cubic-bezier", bezier: land },
    { frame: end, opacity: 1, easing: "hold" },
    { frame: 119, opacity: 1 },
  ];

  if (id === "editorial-transfer") {
    const nodeSize = s * 0.115;
    const centers = portrait
      ? [
          { x: w * 0.5, y: h * 0.31 },
          { x: w * 0.5, y: h * 0.5 },
          { x: w * 0.5, y: h * 0.69 },
        ]
      : [
          { x: w * 0.2, y: h * 0.5 },
          { x: w * 0.5, y: h * 0.5 },
          { x: w * 0.8, y: h * 0.5 },
        ];
    const first = centers[0];
    const last = centers[2];
    const wire = portrait
      ? { x: first.x - 1, y: first.y, width: 2, height: last.y - first.y }
      : { x: first.x, y: first.y - 1, width: last.x - first.x, height: 2 };
    const marks: MotionLayer[] = [
      background,
      header("Follow the handoff"),
      path(
        "Connected route",
        wire,
        portrait
          ? [
              [50, 0],
              [50, 100],
            ]
          : [
              [0, 50],
              [100, 50],
            ],
        palette.edge,
        [
          { frame: 0, trim: 0, easing: "ease-out" },
          { frame: 14, trim: 1, easing: "hold" },
          { frame: 119, trim: 1 },
        ],
      ),
    ];
    for (const [index, center] of centers.entries()) {
      const box = {
        x: center.x - nodeSize / 2,
        y: center.y - nodeSize / 2,
        width: nodeSize,
        height: nodeSize,
      };
      marks.push(
        layer(`Node ${index + 1} waiting`, "ellipse", box, {
          background: palette.paper,
          stroke: palette.edge,
          strokeWidth: Math.max(1, s * 0.003),
        }),
        layer(
          `Node ${index + 1} received`,
          "ellipse",
          box,
          {
            background: palette.tint,
            stroke: palette.accent,
            strokeWidth: Math.max(1, s * 0.004),
          },
          index === 0 ? [{ frame: 0 }] : appear(index === 1 ? 42 : 76),
        ),
        text(
          `Node ${index + 1} label`,
          ["Input", "Process", "Result"][index],
          portrait ? center.x + nodeSize * 0.85 : center.x - w * 0.1,
          portrait ? center.y - s * 0.02 : center.y + nodeSize * 0.85,
          portrait ? w * 0.32 : w * 0.2,
          s * 0.035,
          { align: portrait ? "left" : "center", fontWeight: 400 },
        ),
      );
    }
    const packet = s * 0.027;
    marks.push(
      layer(
        "Persistent packet",
        "ellipse",
        {
          x: first.x - packet / 2,
          y: first.y - packet / 2,
          width: packet,
          height: packet,
        },
        { background: palette.accent },
        [
          { frame: 0, x: 0, y: 0, easing: "hold" },
          { frame: 16, x: 0, y: 0, easing: "cubic-bezier", bezier: travel },
          {
            frame: 42,
            x: centers[1].x - first.x,
            y: centers[1].y - first.y,
            easing: "hold",
          },
          {
            frame: 50,
            x: centers[1].x - first.x,
            y: centers[1].y - first.y,
            easing: "cubic-bezier",
            bezier: travel,
          },
          {
            frame: 76,
            x: last.x - first.x,
            y: last.y - first.y,
            easing: "hold",
          },
          { frame: 119, x: last.x - first.x, y: last.y - first.y },
        ],
      ),
      note,
    );
    return marks;
  }

  if (id === "editorial-compare") {
    const stage = {
      x: w * 0.12,
      y: h * 0.32,
      width: w * 0.76,
      height: h * 0.3,
    };
    const frames: Key[] = [
      { frame: 0, trim: 0, easing: "hold" },
      { frame: 22, trim: 0, easing: "cubic-bezier", bezier: travel },
      { frame: 78, trim: 1, easing: "hold" },
      { frame: 119, trim: 1 },
    ];
    const rough: MotionLayer[] = [];
    const resolved: MotionLayer[] = [];
    for (let index = 0; index < 3; index++) {
      const box = {
        x: stage.x,
        y: stage.y + stage.height * (index / 3 + 0.07),
        width: stage.width,
        height: stage.height * 0.2,
      };
      rough.push(
        path(
          `Rough route ${index + 1}`,
          box,
          [
            [0, 50],
            [16, 25],
            [32, 68],
            [48, 36],
            [64, 65],
            [82, 30],
            [100, 50],
          ],
          palette.muted,
        ),
      );
      resolved.push(
        path(
          `Aligned route ${index + 1}`,
          box,
          [
            [0, 50],
            [100, 50],
          ],
          palette.accent,
          frames,
        ),
      );
    }
    return [
      background,
      ...rough,
      // An opaque native panel covers the rough strokes while the resolved
      // strokes draw above it. No unsupported group mask is required.
      layer(
        "Comparison reveal surface",
        "rectangle",
        stage,
        { background: palette.paper },
        [
          { frame: 0, x: -stage.width, easing: "hold" },
          {
            frame: 22,
            x: -stage.width,
            easing: "cubic-bezier",
            bezier: travel,
          },
          { frame: 78, x: 0, easing: "hold" },
          { frame: 119, x: 0 },
        ],
      ),
      ...resolved,
      path(
        "Moving comparison divider",
        {
          x: stage.x,
          y: stage.y,
          width: Math.max(1, s * 0.003),
          height: stage.height,
        },
        [
          [50, 0],
          [50, 100],
        ],
        palette.ink,
        [
          { frame: 0, x: 0, opacity: 0, easing: "hold" },
          { frame: 18, x: 0, opacity: 1, easing: "hold" },
          {
            frame: 22,
            x: 0,
            opacity: 1,
            easing: "cubic-bezier",
            bezier: travel,
          },
          { frame: 78, x: stage.width, opacity: 1, easing: "ease-out" },
          { frame: 84, x: stage.width, opacity: 0, easing: "hold" },
          { frame: 119, x: stage.width, opacity: 0 },
        ],
      ),
      header("See the difference"),
      text(
        "Before state label",
        "Rough sketch",
        stage.x,
        h * 0.72,
        stage.width,
        s * 0.04,
        {},
        [
          { frame: 0, opacity: 1, easing: "hold" },
          { frame: 22, opacity: 1, easing: "ease-in" },
          { frame: 34, opacity: 0, easing: "hold" },
          { frame: 119, opacity: 0 },
        ],
      ),
      text(
        "After state label",
        "Aligned result",
        stage.x,
        h * 0.72,
        stage.width,
        s * 0.04,
        {},
        appear(76, 84),
      ),
      note,
    ];
  }

  const document = {
    x: w * 0.22,
    y: h * 0.29,
    width: w * 0.56,
    height: h * 0.39,
  };
  const selected = {
    x: document.x + document.width * 0.1,
    y: document.y + document.height * 0.55,
    width: document.width * 0.8,
    height: document.height * 0.16,
  };
  const detail = {
    x: w * 0.12,
    y: h * 0.35,
    width: w * 0.76,
    height: h * 0.22,
  };
  const context: Key[] = [
    { frame: 0, opacity: 1, easing: "hold" },
    { frame: 32, opacity: 1, easing: "ease-in" },
    { frame: 46, opacity: 0, easing: "hold" },
    { frame: 119, opacity: 0 },
  ];
  const detailFrames: Key[] = [
    { frame: 0, opacity: 0, scale: 0.72, y: s * 0.035, easing: "hold" },
    {
      frame: 32,
      opacity: 0,
      scale: 0.72,
      y: s * 0.035,
      easing: "cubic-bezier",
      bezier: land,
    },
    { frame: 54, opacity: 1, scale: 1, y: 0, easing: "hold" },
    { frame: 119, opacity: 1, scale: 1, y: 0 },
  ];
  const marks: MotionLayer[] = [
    background,
    header("Find the useful detail"),
    layer(
      "Document context",
      "rectangle",
      document,
      {
        background: "#FFFFFF",
        stroke: palette.edge,
        strokeWidth: Math.max(1, s * 0.002),
        radius: s * 0.012,
      },
      context,
    ),
  ];
  for (let index = 0; index < 5; index++) {
    marks.push(
      path(
        `Context line ${index + 1}`,
        {
          x: document.x + document.width * 0.1,
          y: document.y + document.height * (0.14 + index * 0.14),
          width: document.width * (index === 4 ? 0.5 : 0.8),
          height: Math.max(1, s * 0.003),
        },
        [
          [0, 50],
          [100, 50],
        ],
        index === 3 ? palette.accent : palette.edge,
        context,
      ),
    );
  }
  marks.push(
    layer(
      "Selected passage focus frame",
      "rectangle",
      selected,
      {
        background: "transparent",
        stroke: palette.accent,
        strokeWidth: Math.max(1, s * 0.003),
        radius: s * 0.004,
      },
      [
        { frame: 0, opacity: 0, trim: 0, easing: "hold" },
        { frame: 10, opacity: 1, trim: 0, easing: "ease-out" },
        { frame: 26, opacity: 1, trim: 1, easing: "hold" },
        { frame: 32, opacity: 1, trim: 1, easing: "ease-in" },
        { frame: 46, opacity: 0, trim: 1, easing: "hold" },
        { frame: 119, opacity: 0, trim: 1 },
      ],
    ),
    layer(
      "Enlarged detail surface",
      "rectangle",
      detail,
      { background: "#DDE8E0", radius: s * 0.016 },
      detailFrames,
    ),
    text(
      "Enlarged editable passage",
      "Make the next\nstep clear.",
      w * 0.17,
      h * 0.385,
      w * 0.66,
      Math.min(s * 0.075, h * 0.052),
      {},
      detailFrames,
    ),
    text(
      "Settled outcome label",
      "One clear next step",
      w * 0.12,
      h * 0.72,
      w * 0.76,
      s * 0.037,
      {},
      appear(74, 84),
    ),
    note,
  );
  return marks;
}
