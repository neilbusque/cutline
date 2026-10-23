import type { Clip, MotionLayer } from "./model";
import {
  motionProperties,
  type MotionProperty,
  type MotionEasing,
  type MotionBezier,
} from "./motion";
type Key = MotionLayer["keyframes"][number];
/** Preserve every other curve, including its easing and custom handles, when editing a sparse key. */
export function upsertMotionKey(
  layer: MotionLayer,
  property: MotionProperty,
  frame: number,
  value: number,
  easing: MotionEasing,
  bezier?: MotionBezier,
): Key[] | null {
  const effective = new Map<
    string,
    {
      frame: number;
      property: MotionProperty;
      value: number;
      easing: MotionEasing;
      bezier?: MotionBezier;
    }
  >();
  for (const key of layer.keyframes)
    for (const p of motionProperties) {
      if (key[p] !== undefined)
        effective.set(`${key.frame}:${p}`, {
          frame: key.frame,
          property: p,
          value: key[p]!,
          easing: key.easing,
          bezier: key.bezier,
        });
    }
  effective.set(`${frame}:${property}`, {
    frame,
    property,
    value,
    easing,
    bezier,
  });
  // Group only curves with identical outgoing easing and handles; never silently retime a sibling.
  const grouped = new Map<string, Key>();
  for (const item of effective.values()) {
    const id = `${item.frame}:${item.easing}:${item.bezier?.join(",") ?? "default"}`;
    const key = grouped.get(id) ?? {
      frame: item.frame,
      easing: item.easing,
      ...(item.bezier ? { bezier: [...item.bezier] as MotionBezier } : {}),
    };
    key[item.property] = item.value;
    grouped.set(id, key);
  }
  const keys = [...grouped.values()].sort((a, b) => a.frame - b.frame);
  return keys.length <= 100 ? keys : null;
}

/** Move one effective property key, retaining all sibling curves. null leaves the layer unchanged. */
export function moveMotionKey(
  layer: MotionLayer,
  property: MotionProperty,
  fromFrame: number,
  toFrame: number,
): Key[] | null {
  const validFrame = (frame: number) =>
    Number.isInteger(frame) && frame >= 0 && frame <= 30 * 60 * 60 * 8;
  if (!validFrame(fromFrame) || !validFrame(toFrame)) return null;
  const source = [...layer.keyframes]
    .reverse()
    .find((key) => key.frame === fromFrame && key[property] !== undefined);
  if (!source) return null;
  if (fromFrame === toFrame) return layer.keyframes;
  if (
    layer.keyframes.some(
      (key) => key.frame === toFrame && key[property] !== undefined,
    )
  )
    return null;
  // Remove every sparse duplicate so an earlier value cannot reappear at the source time.
  const remaining = layer.keyframes
    .map((key) => {
      if (key.frame !== fromFrame || key[property] === undefined) return key;
      const sibling = { ...key };
      delete sibling[property];
      return sibling;
    })
    .filter((key) => motionProperties.some((p) => key[p] !== undefined));
  return upsertMotionKey(
    { ...layer, keyframes: remaining },
    property,
    toFrame,
    source[property]!,
    source.easing,
    source.bezier,
  );
}
/** Seek a visible occurrence of a loop key, including after trim/split. End keys remain explicit edit targets. */
export function motionKeySeekFrame(
  layer: MotionLayer,
  clip: Clip,
  keyFrame: number,
  timelineFrame: number,
): number {
  const start = clip.animationOffset,
    end = start + clip.duration - 1;
  const preferred = Math.max(
    start,
    Math.min(end, timelineFrame - clip.start + start),
  );
  if (layer.loop === "none")
    return clip.start + Math.max(start, Math.min(end, keyFrame)) - start;
  const length = layer.loopFrames;
  const period = layer.loop === "cycle" ? length : length * 2;
  const phase =
    layer.loop === "cycle" ? keyFrame % length : Math.min(length, keyFrame);
  const phases = layer.loop === "cycle" ? [phase] : [phase, period - phase];
  const candidates = phases.flatMap((phase) => {
    const first = Math.ceil((start - phase) / period);
    const nearest = Math.round((preferred - phase) / period);
    return [first, nearest - 1, nearest, nearest + 1]
      .map((n) => n * period + phase)
      .filter((at) => at >= start && at <= end);
  });
  const raw =
    candidates.sort(
      (a, b) => Math.abs(a - preferred) - Math.abs(b - preferred),
    )[0] ?? preferred;
  return clip.start + raw - start;
}
