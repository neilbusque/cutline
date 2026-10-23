import {
  makeClip,
  MotionLayerSchema,
  MotionSchema,
  uid,
  type Asset,
  type Clip,
  type MotionKeyframe,
  type MotionLayer,
  type Project,
} from "./model";
import { captionTextWidth } from "./caption-layout";
import type { ProductBrand, ProductDesign, StoryScene } from "./story-schema";

export const productBrand: ProductBrand = {
  name: "Cutline",
  accent: "#C6F16D",
  background: "#101512",
  foreground: "#F7F8F2",
};
export const productLayouts: ReadonlyArray<{
  id: ProductDesign["layout"];
  name: string;
  description: string;
  needsMedia: boolean;
}> = [
  {
    id: "title",
    name: "Big idea",
    description: "A bold opening with masked type and graphic motion",
    needsMedia: false,
  },
  {
    id: "screen",
    name: "Screen demo",
    description: "A real screenshot or recording in a browser frame",
    needsMedia: true,
  },
  {
    id: "split",
    name: "Feature spotlight",
    description: "A clear benefit beside your product in action",
    needsMedia: true,
  },
  {
    id: "features",
    name: "Three benefits",
    description: "Staggered cards that make the details easy to scan",
    needsMedia: false,
  },
  {
    id: "quote",
    name: "Statement",
    description: "A focused statement with an oversized accent mark",
    needsMedia: false,
  },
  {
    id: "cta",
    name: "Closing card",
    description: "Your brand, final thought, and a clear next step",
    needsMedia: false,
  },
];

export function sceneNeedsMedia(scene: Pick<StoryScene, "design">) {
  return (
    !scene.design ||
    scene.design.layout === "screen" ||
    scene.design.layout === "split"
  );
}

export function sceneVisualReady(
  scene: Pick<StoryScene, "design" | "assetId">,
  project: Pick<Project, "assets">,
) {
  if (!sceneNeedsMedia(scene)) return true;
  const asset = project.assets.find((item) => item.id === scene.assetId);
  return (
    !!asset &&
    (asset.kind === "image" || (asset.kind === "video" && asset.duration > 0))
  );
}

type Box = { x: number; y: number; width: number; height: number };
type ProductSceneOptions = {
  scene: StoryScene;
  brand?: ProductBrand;
  start: number;
  frames: number;
  graphicsTrackId: string;
  mediaTrackId: string;
  visual?: Asset;
};

/** Wrap without truncation, using the same font advances as the composition. */
function fittedText(
  text: string,
  box: Box,
  preferred: number,
  weight: "400" | "600" | "800",
) {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  const wrap = (size: number) => {
    const width = (value: string) =>
      captionTextWidth(value, size, "Helvetica", weight, 0) * 1.04;
    const lines: string[] = [];
    for (const paragraph of normalized.split("\n")) {
      if (!paragraph.trim()) {
        lines.push("");
        continue;
      }
      let line = "";
      for (const word of paragraph.trim().split(/\s+/u)) {
        if (line && width(`${line} ${word}`) <= box.width) {
          line += ` ${word}`;
          continue;
        }
        if (line) {
          lines.push(line);
          line = "";
        }
        for (const character of Array.from(word)) {
          if (line && width(line + character) > box.width) {
            lines.push(line);
            line = "";
          }
          line += character;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  };
  let size = Math.max(8, Math.min(500, preferred));
  let lines = wrap(size);
  while (size > 8 && lines.length * size * 1.13 > box.height) {
    size = Math.max(8, size - 1);
    lines = wrap(size);
  }
  return { text: lines.join("\n"), size, lines: lines.length };
}

const mix = (first: string, second: string, amount: number) => {
  const a = first
    .slice(1)
    .match(/../gu)!
    .map((channel) => parseInt(channel, 16));
  const b = second
    .slice(1)
    .match(/../gu)!
    .map((channel) => parseInt(channel, 16));
  return `#${a
    .map((channel, i) =>
      Math.round(channel + (b[i] - channel) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

/** One native, editable motion design plus a native screenshot/video. No rasterized typography. */
export function createProductScene(
  project: Project,
  options: ProductSceneOptions,
) {
  const { scene, start, frames, graphicsTrackId, mediaTrackId, visual } =
    options;
  const design = scene.design;
  if (!design) throw Error("Choose a product layout for this scene.");
  if (sceneNeedsMedia(scene) && !sceneVisualReady(scene, project))
    throw Error("Choose a screenshot or recording for this product scene.");
  const brand = options.brand ?? productBrand;
  const w = project.width,
    h = project.height,
    s = Math.min(w, h);
  const tall = h > w * 1.1;
  const square = !tall && h > w * 0.8;
  const minimal = design.motion === "minimal";
  const snappy = design.motion === "snappy";
  const last = frames - 1;
  const frame = (seconds: number) =>
    Math.min(last, Math.max(0, Math.round(seconds * project.fps)));
  const arrive = frame(minimal ? 0.22 : snappy ? 0.3 : 0.48);
  const exit = Math.max(1, frame(minimal ? 0.16 : 0.23));
  const leave = Math.max(arrive, last - exit);
  const curve: [number, number, number, number] = snappy
    ? [0.22, 1, 0.36, 1]
    : [0.16, 1, 0.3, 1];
  const box = (x: number, y: number, width: number, height: number): Box => ({
    x: x * w,
    y: y * h,
    width: width * w,
    height: height * h,
  });
  const accentCard = design.layout === "cta";
  const bg = accentCard ? brand.accent : brand.background;
  const ink = accentCard ? brand.background : brand.foreground;
  const accent = accentCard ? brand.background : brand.accent;
  const panel = mix(bg, ink, accentCard ? 0.08 : 0.075);
  const muted = mix(bg, ink, 0.7);
  const layers: MotionLayer[] = [];
  const warnings: string[] = [];
  const keys = (
    delay = 0,
    distance = s * 0.035,
    fade = true,
  ): MotionKeyframe[] => {
    const begin = Math.min(frame(delay), Math.max(0, leave - arrive));
    const end = Math.min(leave, begin + arrive);
    const records: MotionKeyframe[] = [
      {
        frame: 0,
        opacity: fade ? 0 : 1,
        y: minimal ? 0 : distance,
        easing: begin ? "hold" : "cubic-bezier",
        bezier: curve,
      },
      ...(begin
        ? [
            {
              frame: begin,
              opacity: fade ? 0 : 1,
              y: minimal ? 0 : distance,
              easing: "cubic-bezier" as const,
              bezier: curve,
            },
          ]
        : []),
      { frame: end, opacity: 1, y: 0, easing: "hold" },
      { frame: leave, opacity: 1, y: 0, easing: "ease-in" },
      {
        frame: last,
        opacity: fade ? 0 : 1,
        y: minimal ? 0 : -distance * 0.35,
        easing: "linear",
      },
    ];
    return [...new Map(records.map((key) => [key.frame, key])).values()].sort(
      (a, b) => a.frame - b.frame,
    );
  };
  const shape = (
    name: string,
    area: Box,
    fill: string,
    extra: Partial<MotionLayer> = {},
  ) => {
    layers.push(
      MotionLayerSchema.parse({
        type: "rectangle",
        name,
        ...area,
        background: fill,
        ...extra,
      }),
    );
  };
  const type = (
    name: string,
    text: string,
    area: Box,
    size: number,
    extra: Partial<MotionLayer> = {},
  ) => {
    if (!text.trim()) return;
    const fitted = fittedText(
      text,
      area,
      size,
      extra.fontWeight === 400
        ? "400"
        : extra.fontWeight === 600
          ? "600"
          : "800",
    );
    if (fitted.lines * fitted.size * 1.13 > area.height + 0.01)
      throw Error(
        `${scene.title}: shorten ${name.toLowerCase()} or remove extra line breaks so it fits the layout.`,
      );
    if (
      fitted.size < s * 0.019 &&
      /Headline|Statement|Supporting copy|^Benefit \d+$/u.test(name)
    )
      warnings.push(
        `${scene.title}: shorten ${name.toLowerCase()} for easier reading.`,
      );
    const revealStart = Math.min(
      extra.textRevealStart ?? frame(0.08),
      Math.floor(leave * 0.25),
    );
    const revealBudget = Math.max(1, leave - revealStart);
    const stagger = Math.max(
      1,
      Math.min(
        6,
        Math.floor(project.fps * 0.06),
        Math.floor(
          (revealBudget - Math.min(arrive, revealBudget)) /
            Math.max(1, fitted.lines - 1),
        ),
      ),
    );
    // A very short scene must never end before the last line appears. Fall
    // back to a shared fade when there are more lines than reveal frames.
    const textAnimation =
      extra.textAnimation ??
      (minimal || fitted.lines > revealBudget ? "none" : "line-reveal");
    layers.push(
      MotionLayerSchema.parse({
        type: "text",
        name,
        ...area,
        text: fitted.text,
        color: ink,
        fontSize: fitted.size,
        fontWeight: 800,
        align: "left",
        lineHeight: 1.13,
        keyframes: keys(0, 0),
        ...extra,
        textAnimation,
        textRevealStart: revealStart,
        textRevealFrames: Math.max(
          1,
          Math.min(arrive, revealBudget - (fitted.lines - 1) * stagger),
        ),
        staggerFrames: stagger,
      }),
    );
  };
  shape("Background", box(0, 0, 1, 1), bg, {
    musicAccent: false,
    ...(design.layout === "title"
      ? {
          fillStyle: "gradient",
          gradientColor: mix(bg, accent, 0.065),
          gradientAngle: 120,
        }
      : {}),
  });
  // Consistent typography and spacing carry the brand without decorative rules.
  type("Brand", brand.name, box(0.07, 0.043, 0.54, 0.039), s * 0.025, {
    fontWeight: 600,
    color: ink,
    textAnimation: "none",
    keyframes: [],
  });
  shape(
    "Brand accent",
    box(0.905, 0.051, (0.022 * s) / w, (0.022 * s) / h),
    accent,
    { radius: s * 0.011, keyframes: keys(0.04, 0) },
  );
  const headline = design.headline.trim() || scene.title;
  const eyebrow = design.eyebrow.trim();
  const body = design.body.trim();
  let mediaBox: Box | undefined;
  let chromeHeight = 0;
  const browserKeys = keys(0.15, s * (snappy ? 0.045 : 0.026));

  if (design.layout === "title" || design.layout === "cta") {
    type("Eyebrow", eyebrow, box(0.075, 0.17, 0.78, 0.045), s * 0.022, {
      color: muted,
      fontWeight: 600,
    });
    type(
      "Headline",
      headline,
      box(0.07, 0.235, 0.84, 0.29),
      s * (tall ? 0.105 : 0.112),
      design.layout === "title"
        ? {
            fillStyle: "gradient",
            gradientColor: brand.accent,
            gradientAngle: 105,
          }
        : {},
    );
    type("Supporting copy", body, box(0.075, 0.595, 0.76, 0.13), s * 0.03, {
      fontWeight: 400,
      color: muted,
      textRevealStart: frame(0.2),
    });
    if (!minimal && design.layout === "title") {
      shape(
        "Orbit",
        box(0.77, 0.14, (0.12 * s) / w, (0.12 * s) / h),
        "transparent",
        {
          type: "ellipse",
          stroke: accent,
          strokeWidth: s * 0.003,
          keyframes: keys(0.1, 0),
        },
      );
    }
  } else if (design.layout === "quote") {
    type("Eyebrow", eyebrow, box(0.075, 0.145, 0.83, 0.04), s * 0.022, {
      color: muted,
      fontWeight: 600,
    });
    shape("Statement rule", box(0.075, 0.225, 0.009, 0.3), accent, {
      keyframes: keys(0.12, 0),
    });
    type("Statement", headline, box(0.115, 0.205, 0.78, 0.34), s * 0.079);
    type("Supporting copy", body, box(0.115, 0.58, 0.73, 0.14), s * 0.029, {
      color: muted,
      fontWeight: 400,
      textRevealStart: frame(0.22),
    });
  } else if (design.layout === "features") {
    type("Eyebrow", eyebrow, box(0.075, 0.145, 0.84, 0.04), s * 0.022, {
      color: muted,
      fontWeight: 600,
    });
    type("Headline", headline, box(0.07, 0.2, 0.86, 0.17), s * 0.076);
    const points = design.points.filter((point) => point.trim());
    if (points.length) {
      const vertical = tall || square;
      const gap = vertical ? 0.014 : 0.023;
      const count = points.length;
      points.forEach((point, index) => {
        const area = vertical
          ? box(0.075, 0.4 + index * (0.072 + gap), 0.85, 0.072)
          : box(
              0.075 + index * ((0.85 - gap * (count - 1)) / count + gap),
              0.405,
              (0.85 - gap * (count - 1)) / count,
              0.21,
            );
        shape(`Benefit ${index + 1} card`, area, panel, {
          radius: s * 0.018,
          keyframes: keys(index * 0.09 + 0.08, s * 0.025),
          musicAccent: false,
        });
        type(
          `Benefit ${index + 1} number`,
          `${index + 1}`.padStart(2, "0"),
          {
            x: area.x + s * 0.02,
            y: area.y + area.height * (vertical ? 0.15 : 0.1),
            width: s * 0.05,
            height: vertical ? area.height * 0.7 : area.height * 0.25,
          },
          s * 0.022,
          {
            color: accent,
            fontWeight: 600,
            textAnimation: "none",
            keyframes: keys(index * 0.09 + 0.12, 0),
          },
        );
        type(
          `Benefit ${index + 1}`,
          point,
          {
            x: area.x + (vertical ? s * 0.083 : s * 0.02),
            y: area.y + area.height * (vertical ? 0.1 : 0.36),
            width: area.width - (vertical ? s * 0.105 : s * 0.04),
            height: area.height * (vertical ? 0.8 : 0.52),
          },
          s * 0.034,
          { fontWeight: 600, textRevealStart: frame(index * 0.09 + 0.16) },
        );
      });
    }
    type(
      "Supporting copy",
      body,
      box(
        0.075,
        points.length ? 0.665 : 0.42,
        0.83,
        points.length ? 0.075 : 0.26,
      ),
      s * 0.02,
      { color: muted, fontWeight: 400, textAnimation: "none" },
    );
  } else {
    const split = design.layout === "split" && !tall && !square;
    const heroScreen = design.layout === "screen" && !tall && !square;
    type(
      "Eyebrow",
      eyebrow,
      heroScreen
        ? box(0.62, 0.043, 0.25, 0.039)
        : box(0.075, 0.145, split ? 0.36 : 0.83, 0.04),
      s * 0.022,
      { color: muted, fontWeight: 600 },
    );
    type(
      "Headline",
      headline,
      heroScreen
        ? box(0.075, 0.123, body ? 0.45 : 0.85, 0.071)
        : box(
            0.07,
            0.2,
            split ? 0.38 : 0.86,
            split ? 0.255 : tall ? 0.17 : 0.115,
          ),
      s * (heroScreen ? 0.046 : split ? 0.072 : 0.065),
    );
    type(
      "Supporting copy",
      body,
      heroScreen
        ? box(0.57, 0.123, 0.355, 0.071)
        : box(
            0.075,
            split ? 0.48 : tall ? 0.375 : 0.32,
            split ? 0.35 : 0.83,
            split ? 0.17 : tall ? 0.065 : 0.055,
          ),
      s * (heroScreen ? 0.024 : 0.026),
      { fontWeight: 400, color: muted, textRevealStart: frame(0.2) },
    );
    const available = split
      ? box(0.5, 0.215, 0.43, 0.455)
      : heroScreen
        ? box(0.075, 0.205, 0.85, 0.54)
        : box(0.075, tall ? 0.47 : 0.405, 0.85, tall ? 0.245 : 0.305);
    const border = Math.max(2, s * 0.005);
    chromeHeight = Math.min(
      s * (heroScreen ? 0.034 : 0.045),
      available.height * 0.14,
    );
    const sourceRatio =
      visual?.width && visual?.height && visual.width > 0 && visual.height > 0
        ? visual.width / visual.height
        : 16 / 9;
    // Screen demos get a frame shaped for their source, not a panorama with
    // a small screenshot floating in the middle. Extreme source ratios stay
    // contained inside a usable frame; the actual media is never stretched.
    const ratio = Math.max(0.4, Math.min(3.6, sourceRatio));
    const contentWidth = Math.min(
      available.width - border * 2,
      (available.height - chromeHeight - border) * ratio,
    );
    const contentHeight = contentWidth / ratio;
    const outer =
      design.layout === "screen"
        ? {
            x: available.x + (available.width - contentWidth - border * 2) / 2,
            y:
              available.y +
              (available.height - contentHeight - chromeHeight - border) / 2,
            width: contentWidth + border * 2,
            height: contentHeight + chromeHeight + border,
          }
        : available;
    shape("Browser frame", outer, panel, {
      radius: s * 0.018,
      stroke: mix(bg, ink, 0.19),
      strokeWidth: Math.max(1, s * 0.001),
      musicAccent: false,
      keyframes: browserKeys,
    });
    for (let dot = 0; dot < 3; dot++)
      shape(
        `Browser control ${dot + 1}`,
        {
          x: outer.x + s * (0.018 + dot * 0.016),
          y: outer.y + chromeHeight * 0.38,
          width: s * 0.007,
          height: s * 0.007,
        },
        dot === 0 ? accent : mix(bg, ink, 0.3),
        { type: "ellipse", keyframes: browserKeys },
      );
    type(
      "Browser label",
      brand.name.length > 24 ? `${brand.name.slice(0, 23)}…` : brand.name,
      {
        x: outer.x + s * 0.09,
        y: outer.y + chromeHeight * 0.14,
        width: outer.width - s * 0.12,
        height: chromeHeight * 0.72,
      },
      s * 0.016,
      {
        color: muted,
        fontWeight: 400,
        textAnimation: "none",
        keyframes: browserKeys,
      },
    );
    mediaBox = {
      x: outer.x + border,
      y: outer.y + chromeHeight,
      width: outer.width - border * 2,
      height: outer.height - chromeHeight - border,
    };
  }

  const motion = MotionSchema.parse({
    id: uid(),
    name: `${scene.title || "Product"} · ${design.layout}`.slice(0, 100),
    layers,
    source: `product:${design.layout}`,
  });
  const graphic = {
    ...makeClip(project, "text", graphicsTrackId, start),
    preset: "custom" as const,
    motionId: motion.id,
    text: scene.title,
    fontFamily: "Helvetica" as const,
    x: 0,
    y: 0,
    width: w,
    height: h,
    duration: frames,
  };
  const clips: Clip[] = [graphic];
  if (mediaBox && visual) {
    const length =
      visual.kind === "image"
        ? frames
        : Math.max(1, Math.floor(visual.duration * project.fps));
    if (Math.ceil(frames / length) > 10000)
      throw Error(
        "This product scene would exceed 10,000 clips. Choose a longer recording.",
      );
    for (let offset = 0; offset < frames; offset += length) {
      clips.push({
        ...makeClip(project, visual.kind, mediaTrackId, start + offset, visual),
        ...mediaBox,
        duration: Math.min(length, frames - offset),
        volume: 0,
        fit: "contain",
        mask: "rounded",
        cornerRadius: s * 0.007,
        // The native media and its chrome share an entrance and exit. A loop
        // keeps the animation's phase instead of restarting the whole frame.
        animationOffset: offset,
        keyframes: browserKeys.flatMap((key) => [
          {
            property: "y" as const,
            frame: key.frame,
            value: mediaBox!.y + (key.y ?? 0),
            easing: key.easing,
            bezier: key.bezier,
          },
          {
            property: "opacity" as const,
            frame: key.frame,
            value: key.opacity ?? 1,
            easing: key.easing,
            bezier: key.bezier,
          },
        ]),
      });
    }
    if (frames > length)
      warnings.push(
        `${scene.title}: the shorter recording loops to fill the scene.`,
      );
  }
  return { motion, clips, warnings };
}
