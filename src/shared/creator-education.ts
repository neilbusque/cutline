import { buildCaptionClips } from "./caption-grouping";
import { captionTextWidth } from "./caption-layout";
import { reelSafeArea } from "./safe-area";
import {
  MotionLayerSchema,
  type Clip,
  type MotionLayer,
  type Project,
  type Word,
} from "./model";

export const creatorEducationColors = {
  canvas: "#ece9e0",
  cream: "#f7f3e8",
  caption: "#faf7ef",
  ink: "#26352f",
  teal: "#3d746a",
} as const;

/** A deliberate lower-frame crop, not face detection or tracking. */
export function creatorSpeakerPlacement(
  p: Pick<Project, "width" | "height">,
): Partial<Clip> {
  return {
    x: 0,
    y: Math.round(p.height * 0.3),
    width: p.width,
    height: Math.round(p.height * 0.7),
    fit: "cover",
  };
}

/** Fit the actual small title band, including the text renderer's padding. */
export function creatorTitlePlacement(
  p: Pick<Project, "width" | "height">,
  text: string,
): Partial<Clip> {
  const width = Math.round(p.width * 0.78),
    height = Math.round(p.height * 0.07);
  const availableWidth = Math.max(1, width - 24),
    availableHeight = Math.max(1, height - 24);
  let fontSize = Math.max(8, Math.floor(Math.min(p.width, p.height) * 0.035));
  const linesAt = (size: number) => {
    let lines = 1,
      line = "";
    for (const word of text.split(/\s+/u)) {
      if (
        line &&
        captionTextWidth(`${line} ${word}`, size, "Helvetica", "600", 0) >
          availableWidth
      ) {
        lines++;
        line = "";
      }
      const tokenWidth = captionTextWidth(word, size, "Helvetica", "600", 0);
      if (tokenWidth > availableWidth) {
        lines += Math.ceil(tokenWidth / availableWidth) - 1;
        line = "";
      } else line += `${line ? " " : ""}${word}`;
    }
    return lines;
  };
  while (fontSize > 8 && linesAt(fontSize) * fontSize * 1.2 > availableHeight)
    fontSize--;
  return {
    x: Math.round(p.width * 0.11),
    y: Math.round(p.height * 0.02),
    width,
    height,
    fontSize,
    fontFamily: "Helvetica",
    fontWeight: "600",
    background: "transparent",
    color: creatorEducationColors.ink,
    accent: creatorEducationColors.teal,
    preset: "fade",
  };
}

/** Supporting media stays above the speaker, below the optional title line. */
export function creatorBrollPlacement(
  p: Pick<Project, "width" | "height">,
): Partial<Clip> {
  return {
    x: Math.round(p.width * 0.11),
    y: Math.round(p.height * 0.11),
    width: Math.round(p.width * 0.78),
    height: Math.round(p.height * 0.15),
    fit: "contain",
    mask: "rounded",
    cornerRadius: Math.round(Math.min(p.width, p.height) * 0.018),
    cameraMotion: "none",
    keyframes: [],
  };
}

/** Keep a cutaway within its spoken beat and out of the teaching card's time. */
export function creatorBrollWindow(
  start: number,
  frames: number,
  cards: Pick<Clip, "start" | "duration">[],
) {
  let from = start,
    end = start + frames;
  for (const card of [...cards].sort((a, b) => a.start - b.start)) {
    if (card.start >= end || card.start + card.duration <= from) continue;
    if (card.start <= from) from = Math.min(end, card.start + card.duration);
    else end = card.start;
  }
  return { start: from, frames: Math.max(0, end - from) };
}

/** Three or four aligned words per cue; imported phrase cues remain indivisible. */
export function creatorCaptionClips(
  p: Project,
  words: Word[],
  footage: Clip,
  trackId: string,
  style: Clip["captionStyle"] = "box",
): Clip[] {
  const groups: Word[][] = [];
  for (let index = 0; index < words.length;) {
    const remaining = words.length - index;
    const count =
      remaining > 4 && remaining % 4 === 1 ? 3 : Math.min(4, remaining);
    let length = count;
    for (let at = 0; at < count; at++) {
      // A timed imported phrase is never split into invented word timings.
      if (/\s/u.test(words[index + at].text)) {
        length = at || 1;
        break;
      }
      if (/[.!?。！？]["'”’)]?$/u.test(words[index + at].text)) {
        length = at + 1;
        break;
      }
    }
    groups.push(words.slice(index, index + length));
    index += length;
  }
  // A boundary must leave every aligned word a positive visible interval.
  // Overlapping or sub-frame cues stay together instead of losing speech.
  for (let index = 1; index < groups.length;) {
    const previous = groups[index - 1],
      current = groups[index];
    const boundary = Math.floor(current[0].start * p.fps) / p.fps;
    if (
      previous.some(
        (word) => word.start >= boundary || word.end > current[0].start + 1e-9,
      )
    ) {
      previous.push(...current);
      groups.splice(index, 1);
    } else index++;
  }
  return groups.flatMap((group, index) => {
    const end =
      index + 1 < groups.length
        ? Math.floor(groups[index + 1][0].start * p.fps)
        : footage.duration;
    return buildCaptionClips(p, group, {
      trackId,
      sourceId: footage.id,
      startFrame: footage.start,
      maxDurationFrames: Math.min(footage.duration, end),
      style,
    }).map((caption) => {
      if (style !== "box") return caption;
      const fontSize = Math.max(
        8,
        Math.round(Math.min(p.width, p.height) * 0.048),
      );
      const measured = captionTextWidth(
        caption.text,
        fontSize,
        "Helvetica",
        "600",
        0,
      );
      const width = Math.round(
        Math.min(
          p.width * 0.78,
          Math.max(p.width * 0.27, measured + fontSize * 0.95),
        ),
      );
      // Imported subtitle phrases have one real timing atom. Keep that atom
      // intact and give long cues a second line instead of inventing alignment.
      const maxLines = measured + fontSize * 0.95 > p.width * 0.78 ? 2 : 1;
      const height = Math.round(fontSize * (maxLines === 2 ? 2.72 : 1.62));
      return {
        ...caption,
        x: (p.width - width) / 2,
        // Just above the Reel safe area's bottom, clear of the description.
        y: Math.round(p.height * (reelSafeArea.bottom - 0.02) - height),
        width,
        height,
        fontSize,
        fontFamily: "Helvetica" as const,
        fontWeight: "600" as const,
        background: creatorEducationColors.caption,
        color: creatorEducationColors.ink,
        accent: creatorEducationColors.teal,
        highlight: true,
        captionStrokeWidth: 0,
        captionCase: "original" as const,
        captionMaxLines: maxLines as 1 | 2,
        captionTracking: 0,
        preset: "none" as const,
      };
    });
  });
}

/** Native named layers form an editable idea card or a numbered step diagram. */
export function creatorTeachingLayers(
  p: Pick<Project, "width" | "height">,
  text: string,
  kind: "callout" | "step" | "takeaway",
  step: number,
  hasTitle: boolean,
  keyframes: MotionLayer["keyframes"],
  revealFrames: number,
): MotionLayer[] {
  const { width: w, height: h } = p;
  const x = Math.round(w * 0.11),
    y = Math.round(h * (hasTitle ? 0.11 : 0.075));
  const width = Math.round(w * 0.78),
    height = Math.round(h * (hasTitle ? 0.15 : 0.18));
  const inset = Math.round(Math.min(w, h) * 0.03);
  const circle = Math.round(Math.min(w, h) * 0.084),
    numberWidth = kind === "step" ? circle + inset : 0;
  const textWidth = width - inset * 2 - numberWidth;
  const longest = Math.max(1, ...text.split(/\s+/u).map((word) => word.length));
  const fontSize = Math.max(
    8,
    Math.floor(
      Math.min(
        Math.min(w, h) * 0.058,
        textWidth / longest / 0.66,
        Math.sqrt(
          (textWidth * (height - inset * 2)) / Math.max(1, text.length) / 1.4,
        ),
      ),
    ),
  );
  const diagramKeys = keyframes.map((key, index) => ({
    ...key,
    trim: index === 0 ? 0 : 1,
  }));
  const layers = [
    {
      name: "Card",
      type: "rectangle",
      x,
      y,
      width,
      height,
      background: creatorEducationColors.cream,
      radius: Math.round(inset * 0.65),
      keyframes,
    },
    ...(kind === "step"
      ? [
          {
            name: "Step node",
            type: "ellipse",
            x: x + inset,
            y: y + (height - circle) / 2,
            width: circle,
            height: circle,
            background: creatorEducationColors.teal,
            keyframes,
          },
          {
            name: "Step connector",
            type: "line",
            x: x + inset + circle,
            y: y + height / 2,
            width: inset,
            height: 1,
            stroke: creatorEducationColors.teal,
            strokeWidth: Math.max(1, w / 540),
            keyframes: diagramKeys,
          },
          {
            name: "Step number",
            type: "text",
            text: String(step).padStart(2, "0"),
            x: x + inset,
            y: y + (height - circle) / 2,
            width: circle,
            height: circle,
            color: creatorEducationColors.cream,
            fontSize: Math.round(circle * 0.42),
            fontWeight: 600,
            align: "center",
            keyframes,
          },
        ]
      : []),
    {
      name:
        kind === "step"
          ? "Step title"
          : kind === "takeaway"
            ? "Takeaway"
            : "Callout",
      type: "text",
      text,
      x: x + inset + numberWidth,
      y: y + inset,
      width: textWidth,
      height: height - inset * 2,
      color:
        kind === "takeaway"
          ? creatorEducationColors.teal
          : creatorEducationColors.ink,
      fontSize,
      fontWeight: 600,
      align: kind === "takeaway" ? "center" : "left",
      textAnimation: kind === "takeaway" ? "word-rise" : "line-reveal",
      textRevealFrames: revealFrames,
      staggerFrames: 2,
      keyframes,
    },
  ];
  return layers.map((layer) => MotionLayerSchema.parse(layer));
}
