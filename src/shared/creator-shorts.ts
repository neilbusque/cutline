import { creatorCaptionClips } from "./creator-education";
import { captionStylePatch } from "./caption-styles";
import { MotionLayerSchema, type Clip, type Project, type Word } from "./model";
import type { ReelFormat, ReelProofBeat } from "./reel-formats";

export const creatorShortColors = {
  canvas: "#101114",
  ink: "#ffffff",
  accent: "#c6f16d",
} as const;

export function isCreatorShortFormat(format: ReelFormat | undefined) {
  return format === "creator-punch" || format === "screen-demo";
}

/** Keep real word/phrase alignment, with a separate full-frame visual treatment. */
export function creatorShortCaptionClips(
  p: Project,
  words: Word[],
  footage: Clip,
  trackId: string,
  style: Clip["captionStyle"] = "outline",
): Clip[] {
  return creatorCaptionClips(p, words, footage, trackId, style).map(
    (caption) => ({
      ...caption,
      ...captionStylePatch(style, p),
      x: Math.round(p.width * 0.1),
      y: Math.round(p.height * 0.65),
      width: Math.round(p.width * 0.8),
      height: Math.round(
        Math.min(p.height * 0.13, Math.min(p.width, p.height) * 0.24),
      ),
      ...(style === "outline"
        ? {
            fontSize: Math.max(
              8,
              Math.round(Math.min(p.width, p.height) * 0.076),
            ),
            fontFamily: "Arial" as const,
            fontWeight: "800" as const,
            background: "transparent",
            color: creatorShortColors.ink,
            accent: creatorShortColors.accent,
            captionStrokeWidth: Math.min(
              12,
              Math.min(p.width, p.height) * 0.0046,
            ),
            captionCase: "upper" as const,
            captionMaxLines: 2 as const,
            highlight: true,
            preset: "none" as const,
          }
        : {}),
    }),
  );
}

/** Fast sentence-boundary reframes, not a continuous camera push or face tracking. */
export function creatorShortPunchIns(
  clip: Clip,
  starts: { frame: number }[],
  fps: number,
) {
  if (clip.kind !== "video") return;
  const keys: Clip["keyframes"] = [
    { property: "scale", frame: 0, value: 1, easing: "hold" },
  ];
  let previousEnd = -fps;
  let count = 0;
  for (const { frame: at } of starts) {
    const enter = Math.max(1, Math.round(fps * 0.1));
    const holdEnd = at + Math.round(fps * 1.25);
    const end = holdEnd + enter;
    if (at < fps * 1.8 || at < previousEnd + fps * 1.8 || end >= clip.duration)
      continue;
    const scale = count++ % 2 ? 1.12 : 1.1;
    keys.push(
      { property: "scale", frame: at - 1, value: 1, easing: "ease-out" },
      { property: "scale", frame: at + enter, value: scale, easing: "hold" },
      { property: "scale", frame: holdEnd, value: scale, easing: "ease-out" },
      { property: "scale", frame: end, value: 1, easing: "hold" },
    );
    previousEnd = end;
  }
  if (keys.length > 1) clip.keyframes = keys;
}

/** Pause-cut sentences may have no internal boundary. Reframe only at real cuts. */
export function creatorShortCutReframes(clips: Clip[], fps: number) {
  if (
    clips.length < 2 ||
    clips.some((clip) => clip.keyframes.some((key) => key.property === "scale"))
  )
    return;
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const end = ordered.at(-1)!.start + ordered.at(-1)!.duration;
  let lastChange = ordered[0].start;
  let scale = 1;
  let punch = 0;
  for (const clip of ordered.slice(1)) {
    if (clip.start - lastChange >= fps * 3 && end - clip.start >= fps) {
      scale = scale === 1 ? (punch++ % 2 ? 1.12 : 1.1) : 1;
      lastChange = clip.start;
    }
    if (scale !== 1)
      clip.keyframes.push({
        property: "scale",
        frame: 0,
        value: scale,
        easing: "hold",
      });
  }
}

/** Brief text emphasis has no card or permanent reserved upper panel. */
export function creatorShortEmphasisLayers(
  p: Pick<Project, "width" | "height">,
  text: string,
  duration: number,
  fps: number,
) {
  const width = Math.round(p.width * 0.8),
    height = Math.round(p.height * 0.15);
  const longest = Math.max(1, ...text.split(/\s+/u).map((word) => word.length));
  const fontSize = Math.max(
    8,
    Math.floor(
      Math.min(
        Math.min(p.width, p.height) * 0.085,
        width / longest / 0.7,
        Math.sqrt((width * height) / Math.max(1, text.length) / 1.45),
      ),
    ),
  );
  const enter = Math.max(1, Math.round(fps * 0.12));
  const exit = Math.max(1, Math.round(fps * 0.12));
  return [
    MotionLayerSchema.parse({
      name: "Spoken emphasis",
      type: "text",
      text,
      x: Math.round(p.width * 0.1),
      y: Math.round(p.height * 0.18),
      width,
      height,
      color: creatorShortColors.ink,
      stroke: creatorShortColors.canvas,
      strokeWidth: Math.max(1, Math.min(p.width, p.height) * 0.004),
      fontSize,
      fontWeight: 800,
      align: "center",
      keyframes: [
        { frame: 0, opacity: 0, scale: 0.94, easing: "ease-out" },
        { frame: enter, opacity: 1, scale: 1, easing: "hold" },
        { frame: duration - exit - 1, opacity: 1, scale: 1, easing: "ease-in" },
        { frame: duration - 1, opacity: 0, scale: 1, easing: "linear" },
      ],
    }),
  ];
}

/** Use the actual imported screen at readable size; contain never crops its UI. */
export function creatorProofPlacement(
  p: Pick<Project, "width" | "height">,
  layout: ReelProofBeat["layout"],
): Partial<Clip> {
  return {
    x: 0,
    y: 0,
    width: p.width,
    height:
      layout === "split"
        ? Math.round(p.height * 0.48)
        : Math.round(p.height * 0.76),
    fit: "contain",
    cameraMotion: "none",
    keyframes: [],
    look: "none",
    effectAmount: 0,
    overlay: "none",
    fadeIn: 0,
    fadeOut: 0,
    volume: 0,
  };
}

export function creatorProofSpeakerPlacement(
  p: Pick<Project, "width" | "height">,
): Partial<Clip> {
  const top = Math.round(p.height * 0.6);
  return { x: 0, y: top, width: p.width, height: p.height - top, fit: "cover" };
}

export type CreatorProofWindow = Pick<Clip, "start" | "duration"> & {
  layout: ReelProofBeat["layout"];
};

/** Move at exact proof boundaries without splitting a real aligned word cue. */
export function creatorProofCaptionPlacement(
  p: Pick<Project, "width" | "height">,
  caption: Clip,
  proofs: CreatorProofWindow[],
): Partial<Clip> {
  const height = Math.min(
    caption.height,
    Math.round(p.height * 0.6) - Math.round(p.height * 0.48),
  );
  const boundaries = new Set([0]);
  for (const proof of proofs)
    for (const absolute of [proof.start, proof.start + proof.duration]) {
      const frame = absolute - caption.start;
      if (frame > 0 && frame < caption.duration) boundaries.add(frame);
    }
  const keys: Clip["keyframes"] = [];
  for (const frame of [...boundaries].sort((a, b) => a - b)) {
    const absolute = caption.start + frame;
    const active = proofs.find(
      (proof) =>
        absolute >= proof.start && absolute < proof.start + proof.duration,
    );
    const value = active
      ? Math.round(p.height * (active.layout === "split" ? 0.48 : 0.77))
      : caption.y;
    if (!keys.length || keys.at(-1)!.value !== value)
      keys.push({ property: "y", frame, value, easing: "hold" });
  }
  return {
    y: keys[0].value,
    height,
    keyframes: [
      ...caption.keyframes.filter((key) => key.property !== "y"),
      ...keys,
    ].sort((a, b) => a.frame - b.frame),
  };
}
