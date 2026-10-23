import type React from "react";
import type { Clip } from "../shared/model";
import { cameraTransform, filterFor } from "../shared/effects";
import { transitionProgress, smoothProgress } from "../shared/transitions";
import type { AnimationSpan } from "../shared/text-presets";

export type TransitionKind = NonNullable<Clip["transition"]>["kind"];
/**
 * The incoming side of an active transition, in the incoming clip's frames.
 * `isolated` means the pair renders in its own group (see transitionGroups).
 */
export type IncomingTransition = {
  kind: TransitionKind;
  frames: number;
  isolated?: boolean;
};
/** The outgoing side: the overlap starts `start` frames into the outgoing clip. */
export type OutgoingTransition = {
  kind: TransitionKind;
  start: number;
  frames: number;
  isolated?: boolean;
};

const isMedia = (c: Pick<Clip, "kind">) =>
  c.kind === "video" || c.kind === "image";

/**
 * One clip-path for crop and mask together. Nothing is clipped when neither is
 * set, so callout rings, rise offsets and text glows are not cut at the box
 * edge. A rounded or oval mask follows the cropped area, not the full box.
 */
export function clipShape(
  c: Pick<Clip, "crop" | "mask" | "cornerRadius">,
): string | undefined {
  const { top, right, bottom, left } = c.crop;
  if (c.mask === "ellipse") {
    const rx = (100 - left - right) / 2,
      ry = (100 - top - bottom) / 2;
    return `ellipse(${rx}% ${ry}% at ${left + rx}% ${top + ry}%)`;
  }
  if (c.mask === "rounded")
    return `inset(${top}% ${right}% ${bottom}% ${left}% round ${c.cornerRadius}px)`;
  return top > 0 || right > 0 || bottom > 0 || left > 0
    ? `inset(${top}% ${right}% ${bottom}% ${left}%)`
    : undefined;
}

/**
 * A CSS blur pulls in transparency from beyond the frame edge. Filling footage
 * is scaled just enough that the soft, see-through rim falls outside the clip.
 */
export function blurCoverScale(
  c: Pick<Clip, "kind" | "fit" | "blur" | "width" | "height"> & {
    keyframes?: Clip["keyframes"];
  },
) {
  if (!isMedia(c) || c.fit !== "cover") return 1;
  // Sized for the clip's strongest blur, so animating blur never turns into
  // a zoom: the framing stays put and only the blur amount changes.
  const blur = Math.max(
    c.blur ?? 0,
    ...(c.keyframes ?? [])
      .filter((k) => k.property === "blur")
      .map((k) => k.value),
  );
  if (!(blur > 0)) return 1;
  // Three blur radii past each edge keeps the rim fully opaque.
  const reach = Math.min(
    0.45,
    (6 * blur) / Math.max(1, Math.min(c.width, c.height)),
  );
  return 1 / (1 - reach);
}

/**
 * Footage styles inside the clip box: the look, the blur and the camera move.
 * The blur radius is divided by the cover scale so it looks the same on screen.
 */
export function mediaStyle(
  c: Clip,
  frame: number,
  fps: number,
  span?: AnimationSpan,
): React.CSSProperties {
  if (!isMedia(c)) return { filter: filterFor(c) };
  const cover = blurCoverScale(c);
  const camera = cameraTransform(c, frame, { fps, span });
  const transforms = [
    cover !== 1 ? `scale(${cover})` : "",
    camera !== "none" ? camera : "",
  ].filter(Boolean);
  return {
    filter: filterFor(cover !== 1 ? { ...c, blur: (c.blur ?? 0) / cover } : c),
    transform: transforms.length ? transforms.join(" ") : "none",
  };
}

/** The clip's own box. Anything drawn past it stays visible unless cropped or masked. */
export function clipBoxStyle(
  c: Clip,
  opacity: number,
  reactiveScale = 1,
): React.CSSProperties {
  return {
    position: "absolute",
    left: c.x,
    top: c.y,
    width: c.width,
    height: c.height,
    opacity,
    transform: `rotate(${c.rotation}deg) scale(${c.scale * reactiveScale})`,
    clipPath: clipShape(c),
  };
}

/**
 * Fade through black: the screen is fully black on the middle frame, or on
 * both middle frames of an even-length transition, and the shots swap there.
 */
export function blackDip(frame: number, frames: number) {
  const last = Math.max(1, frames - 1);
  if (frame < 0 || frame > last)
    return { black: 0, incomingVisible: frame > last };
  const toBlack = Math.floor(last / 2),
    fromBlack = Math.ceil(last / 2);
  const black =
    frame <= toBlack
      ? toBlack > 0
        ? smoothProgress(frame / toBlack)
        : 1
      : frame >= fromBlack
        ? last - fromBlack > 0
          ? smoothProgress((last - frame) / (last - fromBlack))
          : 1
        : 1;
  return { black, incomingVisible: frame >= fromBlack };
}

/** Equal-power gains keep the loudness steady through an audio crossfade. */
export function crossfadeGains(progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  return { in: Math.sin((p * Math.PI) / 2), out: Math.cos((p * Math.PI) / 2) };
}

/** Width of the soft wipe edge, as a share of the frame. */
export const wipeSoftness = 6;
function wipeMask(progress: number, outgoing: boolean) {
  const center = -wipeSoftness / 2 + progress * (100 + wipeSoftness);
  const from = center - wipeSoftness / 2,
    to = center + wipeSoftness / 2;
  const image = outgoing
    ? `linear-gradient(to right, transparent ${from}%, #000 ${to}%)`
    : `linear-gradient(to right, #000 ${from}%, transparent ${to}%)`;
  return { maskImage: image, WebkitMaskImage: image };
}

/**
 * Styles for the full-frame wrapper of a clip taking part in a transition.
 * Slides push the outgoing shot out as the new one comes in. When the pair is
 * isolated (rendered together in its own group), a crossfade or wipe also
 * fades the outgoing shot and adds the two with plus-lighter, so areas the
 * incoming shot does not cover (letterboxing, picture in picture, masks)
 * dissolve too instead of cutting at the end.
 */
export function transitionStyle({
  frame,
  incoming,
  outgoing,
}: {
  frame: number;
  incoming?: IncomingTransition;
  outgoing?: OutgoingTransition;
}): React.CSSProperties {
  const style: React.CSSProperties = {};
  let opacity = 1;
  const transforms: string[] = [];
  if (incoming && frame < incoming.frames) {
    const p = transitionProgress(frame, incoming.frames);
    switch (incoming.kind) {
      case "crossfade":
        opacity *= p;
        if (incoming.isolated) style.mixBlendMode = "plus-lighter";
        break;
      case "black":
        if (!blackDip(frame, incoming.frames).incomingVisible) opacity = 0;
        break;
      case "slide-left":
        transforms.push(`translateX(${(1 - p) * 100}%)`);
        break;
      case "slide-right":
        transforms.push(`translateX(${-(1 - p) * 100}%)`);
        break;
      case "wipe":
        Object.assign(style, wipeMask(p, false));
        if (incoming.isolated) style.mixBlendMode = "plus-lighter";
        break;
    }
  }
  if (outgoing && frame >= outgoing.start) {
    const local = frame - outgoing.start;
    const p = transitionProgress(local, outgoing.frames);
    switch (outgoing.kind) {
      case "crossfade":
        if (outgoing.isolated) opacity *= 1 - p;
        break;
      case "black":
        if (blackDip(local, outgoing.frames).incomingVisible) opacity = 0;
        break;
      case "slide-left":
        transforms.push(`translateX(${-p * 100}%)`);
        break;
      case "slide-right":
        transforms.push(`translateX(${p * 100}%)`);
        break;
      case "wipe":
        if (outgoing.isolated) Object.assign(style, wipeMask(p, true));
        break;
    }
  }
  if (opacity !== 1) style.opacity = opacity;
  if (transforms.length) style.transform = transforms.join(" ");
  return style;
}

/**
 * The full-frame wrapper carries what must reach past the clip box: the drop
 * shadow, the music glow, the blend mode and the transition. A glow on the
 * clipped box itself would be cut off at the box edge.
 */
export function clipWrapperStyle({
  c,
  frame,
  glow = 0,
  incoming,
  outgoing,
}: {
  c: Clip;
  frame: number;
  glow?: number;
  incoming?: IncomingTransition;
  outgoing?: OutgoingTransition;
}): React.CSSProperties {
  const filters = [
    c.shadowBlur
      ? `drop-shadow(${c.shadowX}px ${c.shadowY}px ${c.shadowBlur}px ${c.shadowColor})`
      : "",
    glow > 0 ? `drop-shadow(0 0 ${glow}px ${c.accent})` : "",
  ].filter(Boolean);
  return {
    position: "absolute",
    inset: 0,
    mixBlendMode: c.blendMode,
    filter: filters.length ? filters.join(" ") : undefined,
    ...transitionStyle({ frame, incoming, outgoing }),
  };
}

/** Audio gain from the transitions a clip takes part in, at a frame of that clip. */
export function transitionGain(
  frame: number,
  incoming?: Pick<IncomingTransition, "frames">,
  outgoing?: Pick<OutgoingTransition, "start" | "frames">,
) {
  return (
    (incoming
      ? crossfadeGains(transitionProgress(frame, incoming.frames)).in
      : 1) *
    (outgoing
      ? crossfadeGains(
          transitionProgress(frame - outgoing.start, outgoing.frames),
        ).out
      : 1)
  );
}

/**
 * Clips on one track that are joined by transitions render as one isolated
 * group, so a dissolve only mixes the two shots and never the tracks below.
 * Every clip after the first in a group joined it through its transition.
 */
export function transitionGroups<
  T extends {
    c: Pick<Clip, "id" | "blendMode">;
    incoming?: { previous: Pick<Clip, "id" | "blendMode"> };
  },
>(entries: T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] | undefined;
  for (const entry of entries) {
    const t = entry.incoming;
    const joins =
      !!t &&
      !!current &&
      current.some((item) => item.c.id === t.previous.id) &&
      // Isolating a pair would change how a blend mode reaches lower tracks.
      entry.c.blendMode === "normal" &&
      t.previous.blendMode === "normal";
    if (joins && current) current.push(entry);
    else {
      current = [entry];
      groups.push(current);
    }
  }
  return groups;
}
