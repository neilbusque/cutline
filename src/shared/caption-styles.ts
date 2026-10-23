import type { Clip, Project } from "./model";

type CaptionPreset = {
  id: Clip["captionStyle"];
  name: string;
  description: string;
  patch: Partial<Clip>;
};
const balanced: Partial<Clip> = {
  captionLayout: "balanced",
  captionCase: "original",
  captionMaxLines: 2,
  captionStrokeWidth: 2,
  captionTracking: 0,
  fontFamily: "Arial",
  fontWeight: "800",
  color: "#ffffff",
  background: "transparent",
  highlight: true,
  preset: "none",
};
export const captionStyles: CaptionPreset[] = [
  {
    id: "standard",
    name: "Clear",
    description: "Crisp type with a quiet word highlight.",
    patch: {
      ...balanced,
      captionStyle: "standard",
      fontSize: 72,
      accent: "#d9f99d",
    },
  },
  {
    id: "karaoke",
    name: "Spotlight",
    description: "A soft pill follows every spoken word.",
    patch: {
      ...balanced,
      captionStyle: "karaoke",
      fontSize: 74,
      accent: "#d9f99d",
      captionStrokeWidth: 1.5,
    },
  },
  {
    id: "pop",
    name: "Punch",
    description: "Bold capitals with a restrained word pop.",
    patch: {
      ...balanced,
      captionStyle: "pop",
      captionCase: "upper",
      fontSize: 82,
      accent: "#e5ff6f",
      captionStrokeWidth: 3,
      captionTracking: 0.25,
    },
  },
  {
    id: "box",
    name: "Editorial",
    description: "Clean, sentence-case type on a dark card.",
    patch: {
      ...balanced,
      captionStyle: "box",
      fontFamily: "Helvetica",
      fontWeight: "600",
      fontSize: 66,
      background: "#11151bea",
      accent: "#c9e4ff",
      captionStrokeWidth: 0,
      captionTracking: 0.1,
    },
  },
  {
    id: "typewriter",
    name: "Reveal",
    description: "Words arrive naturally with the voice.",
    patch: {
      ...balanced,
      captionStyle: "typewriter",
      fontSize: 72,
      accent: "#d4c4ff",
    },
  },
  {
    id: "outline",
    name: "Outline",
    description: "Strong outlined type for busy footage.",
    patch: {
      ...balanced,
      captionStyle: "outline",
      captionCase: "upper",
      fontSize: 78,
      accent: "#ffd599",
      captionStrokeWidth: 5,
      captionTracking: 0.2,
    },
  },
  {
    id: "focus",
    name: "Focus",
    description: "One strong word at a time.",
    patch: {
      ...balanced,
      captionStyle: "focus",
      captionCase: "upper",
      fontSize: 92,
      accent: "#e5ff6f",
      captionStrokeWidth: 3,
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Understated captions that let the story lead.",
    patch: {
      ...balanced,
      captionStyle: "minimal",
      fontFamily: "Helvetica",
      fontWeight: "600",
      fontSize: 62,
      accent: "#ffffff",
      highlight: false,
      captionStrokeWidth: 1,
      captionTracking: 0.35,
    },
  },
];

/** Shared presets scale to the short canvas edge without moving custom captions. */
export function captionStylePatch(
  style: Clip["captionStyle"],
  p: Pick<Project, "width" | "height">,
): Partial<Clip> {
  const preset = captionStyles.find((item) => item.id === style);
  if (!preset) throw Error("Choose a supported caption style.");
  const scale = Math.min(p.width, p.height) / 1080;
  return {
    ...preset.patch,
    fontSize: Math.max(8, Math.round(preset.patch.fontSize! * scale)),
    captionStrokeWidth: Math.min(
      12,
      Number((preset.patch.captionStrokeWidth! * scale).toFixed(2)),
    ),
    captionTracking: Number((preset.patch.captionTracking! * scale).toFixed(2)),
  };
}

/** Center the caption on the canvas with balanced side margins and room below. */
export function captionPlacement(
  p: Pick<Project, "width" | "height">,
): Pick<Clip, "x" | "y" | "width" | "height"> {
  const height = Math.round(
    Math.min(p.height * 0.24, Math.min(p.width, p.height) * 0.24),
  );
  const width = Math.round(p.width * 0.78);
  return {
    x: (p.width - width) / 2,
    y: Math.round(p.height * 0.76 - height / 2),
    width,
    height,
  };
}

export function captionWordStyle(
  c: Clip,
  index: number,
  seconds: number,
): { active: boolean; visible: boolean; scale: number; filled: boolean } {
  const word = c.words[index],
    active = Boolean(word && seconds >= word.start && seconds < word.end);
  const elapsed = word ? Math.max(0, seconds - word.start) : 0;
  return {
    active,
    visible: c.captionStyle !== "typewriter" || !word || seconds >= word.start,
    scale:
      c.captionStyle === "pop" && active
        ? 1 +
          (c.captionLayout === "balanced" ? 0.065 : 0.12) *
            Math.exp(-elapsed * 12)
        : 1,
    filled: c.captionStyle === "karaoke" && active,
  };
}
