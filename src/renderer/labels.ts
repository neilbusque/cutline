import { animatedProperties, type AnimatedProperty } from "../shared/animation";
import type { Clip } from "../shared/model";

/** Option ids read as sentence case: "ease-in-out" becomes "Ease in out". */
export const optionLabel = (id: string) =>
  id ? id[0].toUpperCase() + id.slice(1).replaceAll("-", " ") : id;

const propertyNames: Record<AnimatedProperty, string> = {
  x: "Position X",
  y: "Position Y",
  scale: "Scale",
  rotation: "Rotation",
  rotateX: "Tilt X",
  rotateY: "Tilt Y",
  perspective: "Perspective",
  opacity: "Opacity",
  brightness: "Brightness",
  contrast: "Contrast",
  saturation: "Saturation",
  blur: "Blur",
  rgbSplit: "RGB split",
  invert: "Invert colors",
  volume: "Volume",
};
export const propertyLabel = (property: string) =>
  propertyNames[property as AnimatedProperty] ?? optionLabel(property);

const easingNames: Record<string, string> = {
  linear: "Linear",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "Ease in and out",
  hold: "Hold",
  spring: "Spring",
  back: "Back",
  "cubic-bezier": "Bezier curve",
};
/** Easing ids added later still read as words. */
export const easingLabel = (easing: string) =>
  easingNames[easing] ?? optionLabel(easing);

const kindNames: Record<string, string> = {
  video: "Video",
  image: "Photo",
  audio: "Audio",
  text: "Text",
  caption: "Caption",
};
export const kindLabel = (kind: string) => kindNames[kind] ?? optionLabel(kind);

/** "1 clip", "3 clips". */
export const countLabel = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Properties that change something you can see or hear on this clip. Audio
 * clips only have volume; picture clips have everything else, plus volume
 * when they carry sound. A property that already has keys always stays
 * listed, so older projects keep every curve reachable.
 */
export function keyframeProperties(
  clip: Pick<Clip, "kind" | "keyframes">,
  audible: boolean,
): AnimatedProperty[] {
  const keyed = new Set(clip.keyframes.map((k) => k.property));
  return animatedProperties.filter(
    (property) =>
      keyed.has(property) ||
      (property === "volume" ? audible : clip.kind !== "audio"),
  );
}

/** Opens on a property that is already animated, otherwise opacity or volume. */
export function defaultKeyframeProperty(
  clip: Pick<Clip, "kind" | "keyframes">,
  audible: boolean,
): AnimatedProperty {
  const list = keyframeProperties(clip, audible);
  return (
    list.find((property) =>
      clip.keyframes.some((k) => k.property === property),
    ) ?? (list.includes("opacity") ? "opacity" : list[0])
  );
}

/** Keyframe values in the units people think in. */
export function formatKeyValue(property: string, value: number) {
  switch (property) {
    case "opacity":
    case "volume":
    case "brightness":
    case "contrast":
    case "saturation":
    case "invert":
      return `${Math.round(value * 100)}%`;
    case "scale":
      return `${Math.round(value * 100) / 100}×`;
    case "rotation":
    case "rotateX":
    case "rotateY":
      return `${Math.round(value * 10) / 10}°`;
    case "perspective":
    case "x":
    case "y":
      return `${Math.round(value)} px`;
    case "blur":
    case "rgbSplit":
      return `${Math.round(value * 10) / 10} px`;
    default:
      return String(Math.round(value * 1000) / 1000);
  }
}

/** How a clip plays, when not plainly forward: shown after its name on the timeline. */
export function clipNote(c: Pick<Clip, "reverse" | "freeze">) {
  return [c.reverse && "Reversed", c.freeze && "Freeze frame"]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What a timeline clip is called: for a custom motion graphic, the text it
 * shows (a text layer with no text of its own shows the clip's text) or the
 * motion's name; otherwise the clip's text or media name.
 */
export function clipLabel(
  c: Pick<Clip, "kind" | "text"> & Partial<Pick<Clip, "preset" | "motionId">>,
  motions: {
    id: string;
    name: string;
    layers: { type: string; name?: string; text?: string }[];
  }[],
  assetName?: string,
) {
  if (c.preset === "custom" && c.motionId) {
    const motion = motions.find((m) => m.id === c.motionId);
    const textLayers =
      motion?.layers.filter((layer) => layer.type === "text") ?? [];
    const textOf = (layer: (typeof textLayers)[number]) =>
      layer.text?.trim() || c.text?.trim();
    // Product scenes lead with a repeated brand label. Identify the scene by
    // its message while retaining the first visible text for older designs.
    const headline = textLayers
      .filter((layer) =>
        /^(headline|statement)$/iu.test(layer.name?.trim() ?? ""),
      )
      .map(textOf)
      .find(Boolean);
    const shown = headline || textLayers.map(textOf).find(Boolean);
    const named = shown || motion?.name?.trim();
    if (named) return named;
  }
  return c.text || assetName || kindLabel(c.kind);
}
