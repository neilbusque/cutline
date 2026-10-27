import type React from "react";
import type { Clip } from "../shared/model";
import { planeTransform } from "../shared/plane-transform";
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
    transform: [
      planeTransform(c),
      `rotate(${c.rotation}deg) scale(${c.scale * reactiveScale})`,
    ]
      .filter(Boolean)
      .join(" "),
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

const round = (n: number, digits = 4) => Number(n.toFixed(digits));
/**
 * A camera jolt: a few off-axis sine waves at different speeds read as a
 * handheld knock rather than a mechanical wobble. `amount` is 0 to 1 and the
 * offsets are shares of the frame, so the same shake fits any canvas.
 */
export function shakeTransform(frame: number, amount: number) {
  if (amount <= 0) return "";
  const x = Math.sin(frame * 12.9) * 3.2 * amount,
    y = Math.cos(frame * 9.7) * 2.1 * amount,
    tilt = Math.sin(frame * 7.3) * 0.9 * amount;
  // A little zoom keeps the frame edges covered while it moves.
  return `translate(${round(x, 3)}%, ${round(y, 3)}%) rotate(${round(tilt, 3)}deg) scale(${round(1 + 0.07 * amount)})`;
}
/** Horizontal slips for a glitch, changing every two frames. */
export function glitchSlip(frame: number, amount: number) {
  const step = Math.floor(frame / 2);
  const slip = Math.sin(step * 4.71 + 1.3) * Math.cos(step * 2.37);
  return round(slip * 2.4 * amount, 3);
}

/**
 * Styles for the full-frame wrapper of a clip taking part in a transition.
 * Slides and pushes move the outgoing shot out as the new one comes in; whips
 * add motion blur (see transitionEffect). Flash, shake and glitch are a hard
 * cut in the middle of the overlap, dressed on both sides. Zooms and spins
 * put the outgoing shot on top (zIndex, inside the pair's own group) so it
 * can grow, shrink or turn away over the next shot settling behind it.
 * When the pair is isolated (rendered together in its own group), a
 * crossfade, blur or wipe also fades the outgoing shot and adds the two with
 * plus-lighter, so areas the incoming shot does not cover (letterboxing,
 * picture in picture, masks) dissolve too instead of cutting at the end.
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
  const filters: string[] = [];
  const blur = (px: number) => {
    if (px > 0.05) filters.push(`blur(${round(px, 2)}px)`);
  };
  if (incoming && frame < incoming.frames) {
    const n = incoming.frames;
    const p = transitionProgress(frame, n);
    const dip = blackDip(frame, n);
    switch (incoming.kind) {
      case "crossfade":
        opacity *= p;
        if (incoming.isolated) style.mixBlendMode = "plus-lighter";
        break;
      case "black":
      case "flash":
        if (!dip.incomingVisible) opacity = 0;
        break;
      case "blur":
        opacity *= p;
        blur((1 - p) * 22);
        transforms.push(`scale(${round(1 + 0.06 * (1 - p))})`);
        if (incoming.isolated) style.mixBlendMode = "plus-lighter";
        break;
      case "zoom-in":
      case "zoom-out":
        // Settles from larger than the frame, behind the outgoing shot.
        transforms.push(`scale(${round(1 + 0.3 * (1 - p))})`);
        blur((1 - p) * 8);
        if (!incoming.isolated) opacity *= p;
        break;
      case "spin":
        transforms.push(
          `rotate(${round(-(1 - p) * 90, 2)}deg) scale(${round(1 + 0.7 * (1 - p))})`,
        );
        blur((1 - p) * 6);
        if (!incoming.isolated) opacity *= p;
        break;
      case "whip-left":
        transforms.push(
          `translateX(${round((1 - p) * 100, 3)}%) scale(${round(1 + 0.12 * Math.sin(Math.PI * p))})`,
        );
        break;
      case "whip-right":
        transforms.push(
          `translateX(${round(-(1 - p) * 100, 3)}%) scale(${round(1 + 0.12 * Math.sin(Math.PI * p))})`,
        );
        break;
      case "slide-left":
        transforms.push(`translateX(${(1 - p) * 100}%)`);
        break;
      case "slide-right":
        transforms.push(`translateX(${-(1 - p) * 100}%)`);
        break;
      case "push-up":
        transforms.push(`translateY(${(1 - p) * 100}%)`);
        break;
      case "push-down":
        transforms.push(`translateY(${-(1 - p) * 100}%)`);
        break;
      case "wipe":
        Object.assign(style, wipeMask(p, false));
        if (incoming.isolated) style.mixBlendMode = "plus-lighter";
        break;
      case "shake":
        if (!dip.incomingVisible) opacity = 0;
        else if (dip.black > 0) transforms.push(shakeTransform(frame, dip.black));
        break;
      case "glitch":
        if (!dip.incomingVisible) opacity = 0;
        else if (dip.black > 0)
          transforms.push(
            `translateX(${glitchSlip(frame, dip.black)}%) scale(${round(1 + 0.04 * dip.black)})`,
          );
        break;
    }
  }
  if (outgoing && frame >= outgoing.start) {
    const local = frame - outgoing.start;
    const n = outgoing.frames;
    const p = transitionProgress(local, n);
    const dip = blackDip(local, n);
    switch (outgoing.kind) {
      case "crossfade":
        if (outgoing.isolated) opacity *= 1 - p;
        break;
      case "black":
      case "flash":
        if (dip.incomingVisible) opacity = 0;
        break;
      case "blur":
        if (outgoing.isolated) opacity *= 1 - p;
        blur(p * 22);
        transforms.push(`scale(${round(1 + 0.06 * p)})`);
        break;
      case "zoom-in":
        if (outgoing.isolated) {
          style.zIndex = 1;
          opacity *= 1 - p;
        }
        transforms.push(`scale(${round(1 + 0.9 * p)})`);
        blur(p * 14);
        break;
      case "zoom-out":
        if (outgoing.isolated) {
          style.zIndex = 1;
          opacity *= 1 - p;
        }
        transforms.push(`scale(${round(1 - 0.45 * p)})`);
        blur(p * 10);
        break;
      case "spin":
        if (outgoing.isolated) {
          style.zIndex = 1;
          opacity *= 1 - p;
        }
        transforms.push(
          `rotate(${round(p * 90, 2)}deg) scale(${round(1 + 0.7 * p)})`,
        );
        blur(p * 6);
        break;
      case "whip-left":
        transforms.push(
          `translateX(${round(-p * 100, 3)}%) scale(${round(1 + 0.12 * Math.sin(Math.PI * p))})`,
        );
        break;
      case "whip-right":
        transforms.push(
          `translateX(${round(p * 100, 3)}%) scale(${round(1 + 0.12 * Math.sin(Math.PI * p))})`,
        );
        break;
      case "slide-left":
        transforms.push(`translateX(${-p * 100}%)`);
        break;
      case "slide-right":
        transforms.push(`translateX(${p * 100}%)`);
        break;
      case "push-up":
        transforms.push(`translateY(${-p * 100}%)`);
        break;
      case "push-down":
        transforms.push(`translateY(${p * 100}%)`);
        break;
      case "wipe":
        if (outgoing.isolated) Object.assign(style, wipeMask(p, true));
        break;
      case "shake":
        if (dip.incomingVisible) opacity = 0;
        else if (dip.black > 0) transforms.push(shakeTransform(local, dip.black));
        break;
      case "glitch":
        if (dip.incomingVisible) opacity = 0;
        else if (dip.black > 0)
          transforms.push(
            `translateX(${glitchSlip(local, dip.black)}%) scale(${round(1 + 0.04 * dip.black)})`,
          );
        break;
    }
  }
  if (opacity !== 1) style.opacity = opacity;
  if (transforms.length) style.transform = transforms.join(" ");
  if (filters.length) style.filter = filters.join(" ");
  return style;
}

/**
 * The parts of a transition CSS cannot draw: directional motion blur for
 * whips and the tearing and color separation of a glitch. Rendered as one
 * SVG filter on the clip's full-frame wrapper (see TransitionFilter).
 * Amounts are in frame pixels, scaled from `size`, the canvas's short edge.
 */
export type SvgEffect = {
  blurX: number;
  blurY: number;
  displace: number;
  rgb: number;
  seed: number;
  /** Halation strength (0 to 1) and blur radius in pixels. */
  bloom: number;
  bloomRadius: number;
};
const noEffect = (): SvgEffect => ({
  blurX: 0,
  blurY: 0,
  displace: 0,
  rgb: 0,
  seed: 0,
  bloom: 0,
  bloomRadius: 0,
});
const someEffect = (effect: SvgEffect) =>
  effect.blurX || effect.blurY || effect.displace || effect.rgb || effect.bloom
    ? effect
    : undefined;
export function transitionEffect({
  frame,
  incoming,
  outgoing,
  size,
}: {
  frame: number;
  incoming?: IncomingTransition;
  outgoing?: OutgoingTransition;
  size: number;
}): SvgEffect | undefined {
  const effect = noEffect();
  const side = (
    kind: TransitionKind,
    local: number,
    frames: number,
    salt: number,
  ) => {
    const p = transitionProgress(local, frames);
    if (kind === "whip-left" || kind === "whip-right")
      effect.blurX = Math.max(
        effect.blurX,
        size * 0.03 * Math.sin(Math.PI * p),
      );
    else if (kind === "push-up" || kind === "push-down")
      effect.blurY = Math.max(
        effect.blurY,
        size * 0.012 * Math.sin(Math.PI * p),
      );
    else if (kind === "glitch") {
      const amount = blackDip(local, frames).black;
      effect.displace = Math.max(effect.displace, size * 0.05 * amount);
      effect.rgb = Math.max(effect.rgb, size * 0.012 * amount);
      effect.seed = Math.floor(local / 2) + salt;
    }
  };
  if (incoming && frame < incoming.frames)
    side(incoming.kind, frame, incoming.frames, 100);
  if (outgoing && frame >= outgoing.start)
    side(outgoing.kind, frame - outgoing.start, outgoing.frames, 0);
  for (const key of ["blurX", "blurY", "displace", "rgb"] as const)
    effect[key] = round(effect[key], 2);
  return someEffect(effect);
}

/**
 * Finishing overlays that work on the picture itself rather than over it: a
 * glitch tears the footage in short bursts (about a quarter of the time, in
 * three-frame blocks, never two bursts alike), and halation makes the
 * highlights glow. Sized from the clip's short edge so it reads the same at
 * any canvas size.
 */
export function finishingEffect(
  c: Pick<Clip, "overlay" | "overlayAmount" | "width" | "height">,
  frame: number,
): SvgEffect | undefined {
  const amount = c.overlayAmount,
    size = Math.max(1, Math.min(c.width, c.height));
  if (amount <= 0) return undefined;
  if (c.overlay === "glitch") {
    const block = Math.floor(frame / 3);
    // A fixed scramble of the block number decides which blocks burst.
    const burst = (block * 7919 + 13) % 11 < 3;
    if (!burst) return undefined;
    const effect = noEffect();
    effect.displace = round(size * 0.06 * amount, 2);
    effect.rgb = round(size * 0.012 * amount, 2);
    effect.seed = block % 1000;
    return effect;
  }
  if (c.overlay === "halation") {
    const effect = noEffect();
    effect.bloom = round(0.35 + 0.65 * amount, 3);
    effect.bloomRadius = round(size * (0.012 + 0.03 * amount), 2);
    return effect;
  }
  return undefined;
}

/** The color a mid-cut transition dips through, and how deep, at a frame of the incoming clip. */
export function transitionDip(
  frame: number,
  incoming?: IncomingTransition,
): { color: string; amount: number } | undefined {
  if (!incoming || frame >= incoming.frames) return undefined;
  if (incoming.kind === "black")
    return { color: "black", amount: blackDip(frame, incoming.frames).black };
  if (incoming.kind === "flash")
    return { color: "white", amount: blackDip(frame, incoming.frames).black };
  return undefined;
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
  filterUrl,
}: {
  c: Clip;
  frame: number;
  glow?: number;
  incoming?: IncomingTransition;
  outgoing?: OutgoingTransition;
  /** An SVG filter reference (`url(#id)`) for the transition's motion blur or glitch. */
  filterUrl?: string;
}): React.CSSProperties {
  const transition = transitionStyle({ frame, incoming, outgoing });
  const filters = [
    filterUrl ?? "",
    transition.filter ?? "",
    c.shadowBlur
      ? `drop-shadow(${c.shadowX}px ${c.shadowY}px ${c.shadowBlur}px ${c.shadowColor})`
      : "",
    glow > 0 ? `drop-shadow(0 0 ${glow}px ${c.accent})` : "",
  ].filter(Boolean);
  return {
    position: "absolute",
    inset: 0,
    mixBlendMode: c.blendMode,
    ...transition,
    filter: filters.length ? filters.join(" ") : undefined,
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
