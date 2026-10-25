import {
  MotionLayerSchema,
  type MotionKeyframe,
  type MotionLayer,
  type Project,
} from "./model";
import { captionTextWidth } from "./caption-layout";

export const creatorStudioSceneIds = [
  "studio-depth-proof",
  "studio-path-story",
  "studio-type-handoff",
] as const;
export type CreatorStudioSceneId = (typeof creatorStudioSceneIds)[number];
export const creatorStudioScenes = [
  {
    id: "studio-depth-proof",
    name: "Creator studio / Depth",
    description:
      "Sketch, structure and a bold finished composition on layered perspective planes",
    category: "Creator studio",
    color: "#C9C5FF",
  },
  {
    id: "studio-path-story",
    name: "Creator studio / Path",
    description:
      "A persistent blue disc follows a traced full-frame process world",
    category: "Creator studio",
    color: "#4055F5",
  },
  {
    id: "studio-type-handoff",
    name: "Creator studio / Handoff",
    description:
      "The moving disc becomes the O in a dominant typographic result",
    category: "Creator studio",
    color: "#F4F4FA",
  },
] as const;

export function isCreatorStudioScene(id: string): id is CreatorStudioSceneId {
  return creatorStudioSceneIds.includes(id as CreatorStudioSceneId);
}

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Key = Partial<MotionKeyframe> & { frame: number };
const ink = "#101026";
const blue = "#4055F5";
const lavender = "#C9C5FF";
const paper = "#F4F4FA";
const arrive: [number, number, number, number] = [0.22, 1, 0.36, 1];
const move: [number, number, number, number] = [0.65, 0, 0.35, 1];

/** The first scene's disc is the next scene's opening object, at either format. */
function proofGeometry(p: Project) {
  const portrait = p.height > p.width;
  const front = portrait
    ? {
        x: p.width * 0.1,
        y: p.height * 0.24,
        width: p.width * 0.8,
        height: p.height * 0.52,
      }
    : {
        x: p.width * 0.19,
        y: p.height * 0.16,
        width: p.width * 0.62,
        height: p.height * 0.68,
      };
  const radius = Math.min(front.width, front.height) * 0.19;
  return {
    front,
    radius,
    disc: { x: front.x + front.width * 0.78, y: front.y + front.height * 0.28 },
  };
}

/**
 * Original visual studies: projected flat planes, traced paths, and a graphic
 * object/type handoff. No footage, fabricated results or third-party artwork.
 * Shared native timing keeps every subject/layer editable in the saved film.
 */
export function creatorStudioSceneLayers(
  p: Project,
  id: CreatorStudioSceneId,
): MotionLayer[] {
  const w = p.width,
    h = p.height,
    s = Math.min(w, h);
  const portrait = h > w;
  const f = (frame: number) => Math.round((frame * p.fps) / 30);
  const perspective = Math.max(600, Math.min(8000, s * 1.8));
  const { front, disc, radius } = proofGeometry(p);
  const layer = (
    name: string,
    type: MotionLayer["type"],
    box: Box,
    extra: Record<string, unknown> = {},
    frames: Key[] = [{ frame: 0 }],
  ): MotionLayer =>
    MotionLayerSchema.parse({
      name,
      type,
      ...box,
      musicAccent: false,
      fontSize: Math.max(8, Math.min(500, s * 0.03)),
      keyframes: frames.map((key) => ({ ...key, frame: f(key.frame) })),
      ...extra,
    });
  const text = (
    name: string,
    value: string,
    box: Box,
    preferred: number,
    extra: Record<string, unknown> = {},
    frames?: Key[],
  ) => {
    const family = extra.fontFamily === "Georgia" ? "Georgia" : "Helvetica";
    const weight = extra.fontWeight === 400 ? "400" : "800";
    const advance = Math.max(
      ...value
        .split("\n")
        .map((line) => captionTextWidth(line, 1, family, weight, 0)),
    );
    const size = Math.max(
      8,
      Math.min(
        500,
        preferred,
        (box.width * 0.96) / advance,
        box.height / (value.split("\n").length * 1.08),
      ),
    );
    return layer(
      name,
      "text",
      box,
      {
        text: value,
        fontFamily: family,
        fontWeight: 800,
        fontSize: size,
        lineHeight: 1.05,
        align: "left",
        color: ink,
        ...extra,
      },
      frames,
    );
  };
  const canvas = { x: 0, y: 0, width: w, height: h };
  const ground = (color: string, name = "Studio ground", frames?: Key[]) =>
    layer(name, "rectangle", canvas, { background: color }, frames);
  const path = (
    name: string,
    box: Box,
    points: Point[],
    stroke: string,
    strokeWidth: number,
    frames?: Key[],
    extra: Record<string, unknown> = {},
  ) =>
    layer(
      name,
      "path",
      box,
      {
        vectorPath: points
          .map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`)
          .join(" "),
        vectorViewBox: [0, 0, box.width, box.height],
        vectorAspectRatio: "none",
        vectorLineCap: "round",
        vectorLineJoin: "round",
        background: "transparent",
        stroke,
        strokeWidth,
        ...extra,
      },
      frames,
    );
  const circlePath = (cx: number, cy: number, r: number) =>
    `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
  const discLayer = (
    name: string,
    box: Box,
    frames: Key[],
    extra: Record<string, unknown> = {},
  ) => layer(name, "ellipse", box, { background: blue, ...extra }, frames);
  // Preserve the poster sphere's object-relative light/material across cuts.
  // Vector gradients render on native path layers rather than ellipse layers.
  const sphereDisc = (name: string, box: Box, frames: Key[]) => {
    const materialScale = box.width / (radius * 2);
    return layer(
      name,
      "path",
      box,
      {
        vectorPath: circlePath(box.width / 2, box.height / 2, box.width / 2),
        vectorViewBox: [0, 0, box.width, box.height],
        vectorAspectRatio: "none",
        background: blue,
        strokeWidth: 0,
        vectorGradient: {
          type: "radial",
          units: "userSpaceOnUse",
          cx: (radius - front.width * 0.05) * materialScale,
          cy: (radius - front.height * 0.05) * materialScale,
          r: radius * 1.3 * materialScale,
          stops: [
            { offset: 0, color: "#6D91FF", opacity: 1 },
            { offset: 0.54, color: blue, opacity: 1 },
            { offset: 1, color: "#2530AA", opacity: 1 },
          ],
        },
      },
      frames,
    );
  };

  if (id === "studio-depth-proof") {
    const rearLeft = portrait
      ? { x: w * 0.04, y: h * 0.15, width: w * 0.62, height: h * 0.62 }
      : { x: w * 0.09, y: h * 0.1, width: w * 0.62, height: h * 0.68 };
    const rearRight = portrait
      ? { x: w * 0.34, y: h * 0.18, width: w * 0.62, height: h * 0.62 }
      : { x: w * 0.29, y: h * 0.22, width: w * 0.62, height: h * 0.68 };
    const planeKeys = (side: number): Key[] => [
      {
        frame: 0,
        opacity: 1,
        x: side * s * 0.08,
        y: s * 0.09,
        scale: 0.88,
        rotate: side * 9,
        rotateX: 12,
        rotateY: side * 22,
        perspective,
        easing: "cubic-bezier",
        bezier: arrive,
      },
      {
        frame: 26,
        opacity: 1,
        x: 0,
        y: 0,
        scale: 1,
        rotate: side * 5,
        rotateX: 4,
        rotateY: side * 13,
        perspective,
        easing: "hold",
      },
      {
        frame: 119,
        opacity: 1,
        x: 0,
        y: 0,
        scale: 1,
        rotate: side * 5,
        rotateX: 4,
        rotateY: side * 13,
        perspective,
      },
    ];
    const frontKeys: Key[] = [
      {
        frame: 0,
        opacity: 0,
        y: s * 0.18,
        scale: 0.82,
        rotateX: 20,
        rotateY: -18,
        perspective,
        easing: "hold",
      },
      {
        frame: 8,
        opacity: 0,
        y: s * 0.18,
        scale: 0.82,
        rotateX: 20,
        rotateY: -18,
        perspective,
        easing: "cubic-bezier",
        bezier: arrive,
      },
      {
        frame: 38,
        opacity: 1,
        y: 0,
        scale: 1,
        rotateX: 0,
        rotateY: 0,
        perspective,
        easing: "hold",
      },
      {
        frame: 119,
        opacity: 1,
        y: 0,
        scale: 1,
        rotateX: 0,
        rotateY: 0,
        perspective,
      },
    ];
    const leftKeys = planeKeys(-1),
      rightKeys = planeKeys(1);
    const marks: MotionLayer[] = [ground(ink)];
    marks.push(
      layer(
        "Sketch plane",
        "rectangle",
        rearLeft,
        { background: paper, radius: s * 0.025 },
        leftKeys,
      ),
      path(
        "Sketch construction",
        rearLeft,
        [
          { x: rearLeft.width * 0.12, y: rearLeft.height * 0.26 },
          { x: rearLeft.width * 0.72, y: rearLeft.height * 0.26 },
          { x: rearLeft.width * 0.72, y: rearLeft.height * 0.72 },
          { x: rearLeft.width * 0.28, y: rearLeft.height * 0.72 },
        ],
        "#A2A0C1",
        Math.max(1, s * 0.003),
        leftKeys,
      ),
      layer(
        "Structure plane",
        "rectangle",
        rearRight,
        { background: blue, radius: s * 0.025 },
        rightKeys,
      ),
      path(
        "Structure route",
        rearRight,
        [
          { x: rearRight.width * 0.12, y: rearRight.height * 0.82 },
          { x: rearRight.width * 0.5, y: rearRight.height * 0.82 },
          { x: rearRight.width * 0.5, y: rearRight.height * 0.36 },
          { x: rearRight.width * 0.84, y: rearRight.height * 0.36 },
        ],
        lavender,
        Math.max(2, s * 0.006),
        rightKeys,
      ),
      layer(
        "Finished poster plane",
        "rectangle",
        front,
        { background: lavender, radius: s * 0.025 },
        frontKeys,
      ),
      layer(
        "Poster disc artwork",
        "path",
        front,
        {
          vectorPath: circlePath(
            front.width * 0.78,
            front.height * 0.28,
            radius,
          ),
          vectorViewBox: [0, 0, front.width, front.height],
          vectorAspectRatio: "none",
          background: blue,
          strokeWidth: 0,
          vectorGradient: {
            type: "radial",
            units: "userSpaceOnUse",
            cx: front.width * 0.73,
            cy: front.height * 0.23,
            r: radius * 1.3,
            stops: [
              { offset: 0, color: "#6D91FF", opacity: 1 },
              { offset: 0.54, color: blue, opacity: 1 },
              { offset: 1, color: "#2530AA", opacity: 1 },
            ],
          },
        },
        frontKeys,
      ),
      text(
        "Poster hero type",
        "One\nidea.",
        {
          x: front.x + front.width * 0.065,
          y: front.y + front.height * 0.22,
          width: front.width * 0.57,
          height: front.height * 0.56,
        },
        s * 0.19,
        { color: ink },
        [
          { frame: 0, opacity: 0, y: s * 0.035, easing: "hold" },
          {
            frame: 38,
            opacity: 0,
            y: s * 0.035,
            easing: "cubic-bezier",
            bezier: arrive,
          },
          { frame: 54, opacity: 1, y: 0, easing: "hold" },
          { frame: 119, opacity: 1, y: 0 },
        ],
      ),
    );
    return marks;
  }

  const end = { x: w * 0.82, y: h * 0.72 };
  if (id === "studio-path-story") {
    const points = [
      disc,
      { x: w * 0.2, y: disc.y },
      { x: w * 0.2, y: end.y },
      end,
    ];
    const lengths = points
      .slice(1)
      .map((point, index) =>
        Math.hypot(point.x - points[index].x, point.y - points[index].y),
      );
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let covered = 0;
    const travelKeys: Key[] = [
      {
        frame: 0,
        x: 0,
        y: 0,
        scale: 1,
        easing: "cubic-bezier",
        bezier: arrive,
      },
      { frame: 18, x: 0, y: 0, scale: 0.22, easing: "hold" },
      { frame: 22, x: 0, y: 0, scale: 0.22, easing: "linear" },
    ];
    for (const [index, point] of points.slice(1).entries()) {
      covered += lengths[index];
      travelKeys.push({
        frame: 22 + Math.round((56 * covered) / total),
        x: point.x - disc.x,
        y: point.y - disc.y,
        scale: 0.22,
        easing: "linear",
      });
    }
    travelKeys.push({
      frame: 119,
      x: end.x - disc.x,
      y: end.y - disc.y,
      scale: 0.22,
    });
    const marks = [
      ground(ink),
      path(
        "Process route bed",
        canvas,
        points,
        "#333657",
        Math.max(2, s * 0.006),
      ),
      path(
        "Process route trace",
        canvas,
        points,
        lavender,
        Math.max(2, s * 0.006),
        [
          { frame: 0, trim: 0, easing: "hold" },
          { frame: 22, trim: 0, easing: "linear" },
          { frame: 78, trim: 1, easing: "hold" },
          { frame: 119, trim: 1 },
        ],
      ),
      sphereDisc(
        "Traveling studio disc",
        {
          x: disc.x - radius,
          y: disc.y - radius,
          width: radius * 2,
          height: radius * 2,
        },
        travelKeys,
      ),
      text(
        "Motion instruction",
        portrait ? "Make it\nmove." : "Make it move.",
        {
          x: w * 0.07,
          y: h * 0.07,
          width: w * 0.86,
          height: h * (portrait ? 0.24 : 0.21),
        },
        s * (portrait ? 0.22 : 0.17),
        { color: paper },
        [
          {
            frame: 0,
            opacity: 0,
            y: s * 0.025,
            easing: "cubic-bezier",
            bezier: arrive,
          },
          { frame: 16, opacity: 1, y: 0, easing: "hold" },
          { frame: 119, opacity: 1, y: 0 },
        ],
      ),
      text(
        "Process accent",
        "a connected thought",
        { x: w * 0.32, y: h * 0.54, width: w * 0.58, height: s * 0.075 },
        s * 0.055,
        {
          color: lavender,
          fontFamily: "Georgia",
          fontStyle: "italic",
          fontWeight: 400,
        },
        [
          { frame: 0, opacity: 0, easing: "hold" },
          { frame: 58, opacity: 0, easing: "ease-out" },
          { frame: 74, opacity: 1, easing: "hold" },
          { frame: 119, opacity: 1 },
        ],
      ),
    ];
    return marks;
  }

  const font = Math.max(
    8,
    Math.min(
      500,
      s * (portrait ? 0.34 : 0.46),
      (w * 0.88) / captionTextWidth("SHOW", 1, "Helvetica", "800", 0),
    ),
  );
  const sh = captionTextWidth("SH", font, "Helvetica", "800", 0);
  const o = captionTextWidth("O", font, "Helvetica", "800", 0);
  const whole = captionTextWidth("SHOW", font, "Helvetica", "800", 0);
  const wordX = (w - whole) / 2,
    wordY = h * (portrait ? 0.34 : 0.23);
  const diameter = font * 0.76;
  const target = { x: wordX + sh + o / 2, y: wordY + font * 0.56 };
  const handoffKeys: Key[] = [
    {
      frame: 0,
      x: end.x - target.x,
      y: end.y - target.y,
      scale: (radius * 2 * 0.22) / diameter,
      easing: "hold",
    },
    {
      frame: 10,
      x: end.x - target.x,
      y: end.y - target.y,
      scale: (radius * 2 * 0.22) / diameter,
      easing: "cubic-bezier",
      bezier: move,
    },
    { frame: 54, x: 0, y: 0, scale: 1, easing: "hold" },
    { frame: 119, x: 0, y: 0, scale: 1 },
  ];
  const typeKeys: Key[] = [
    { frame: 0, opacity: 0, y: s * 0.035, easing: "hold" },
    {
      frame: 30,
      opacity: 0,
      y: s * 0.035,
      easing: "cubic-bezier",
      bezier: arrive,
    },
    { frame: 54, opacity: 1, y: 0, easing: "hold" },
    { frame: 119, opacity: 1, y: 0 },
  ];
  const discBox = {
    x: target.x - diameter / 2,
    y: target.y - diameter / 2,
    width: diameter,
    height: diameter,
  };
  return [
    ground(ink),
    ground(paper, "Paper palette handoff", [
      { frame: 0, opacity: 0, easing: "hold" },
      { frame: 8, opacity: 1, easing: "hold" },
      { frame: 119, opacity: 1 },
    ]),
    sphereDisc(
      "Handoff solid disc",
      discBox,
      handoffKeys.map((key) => ({ ...key, opacity: key.frame >= 54 ? 0 : 1 })),
    ),
    discLayer(
      "Handoff letter O",
      discBox,
      handoffKeys.map((key) => ({ ...key, opacity: key.frame >= 54 ? 1 : 0 })),
      { background: "transparent", stroke: blue, strokeWidth: font * 0.115 },
    ),
    text(
      "Show letters SH",
      "SH",
      { x: wordX, y: wordY, width: sh, height: font * 1.12 },
      font,
      { color: ink, fontSize: font },
      typeKeys,
    ),
    text(
      "Show letter W",
      "W",
      {
        x: wordX + sh + o,
        y: wordY,
        width: whole - sh - o,
        height: font * 1.12,
      },
      font,
      { color: ink, fontSize: font },
      typeKeys,
    ),
    text(
      "Result editorial accent",
      "the result.",
      {
        x: w * 0.08,
        y: wordY + font * 1.28,
        width: w * 0.84,
        height: s * 0.14,
      },
      s * 0.105,
      {
        align: "center",
        color: ink,
        fontFamily: "Georgia",
        fontStyle: "italic",
        fontWeight: 400,
      },
      [
        { frame: 0, opacity: 0, y: s * 0.025, easing: "hold" },
        {
          frame: 58,
          opacity: 0,
          y: s * 0.025,
          easing: "cubic-bezier",
          bezier: arrive,
        },
        { frame: 78, opacity: 1, y: 0, easing: "hold" },
        { frame: 119, opacity: 1, y: 0 },
      ],
    ),
  ];
}
