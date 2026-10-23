import type { Clip } from "./model";

type Box = Pick<Clip, "x" | "y" | "width" | "height" | "rotation" | "scale">;
export type Alignment =
  "left" | "center" | "right" | "top" | "middle" | "bottom";
const bounded = (n: number) => Math.max(-8000, Math.min(8000, n));

/** Axis-aligned bounds of the same center-origin transform used by Film. */
export function stageBounds(box: Box) {
  const angle = (box.rotation * Math.PI) / 180;
  const width =
    (Math.abs(Math.cos(angle)) * box.width +
      Math.abs(Math.sin(angle)) * box.height) *
    box.scale;
  const height =
    (Math.abs(Math.sin(angle)) * box.width +
      Math.abs(Math.cos(angle)) * box.height) *
    box.scale;
  const center = box.x + box.width / 2,
    middle = box.y + box.height / 2;
  return {
    left: center - width / 2,
    right: center + width / 2,
    top: middle - height / 2,
    bottom: middle + height / 2,
    center,
    middle,
  };
}

export function alignOnStage(
  box: Box,
  canvas: { width: number; height: number },
  alignment: Alignment,
) {
  const bounds = stageBounds(box);
  switch (alignment) {
    case "left":
      return { x: bounded(box.x - bounds.left) };
    case "center":
      return { x: bounded(box.x + canvas.width / 2 - bounds.center) };
    case "right":
      return { x: bounded(box.x + canvas.width - bounds.right) };
    case "top":
      return { y: bounded(box.y - bounds.top) };
    case "middle":
      return { y: bounded(box.y + canvas.height / 2 - bounds.middle) };
    case "bottom":
      return { y: bounded(box.y + canvas.height - bounds.bottom) };
  }
}

/** Snap in canvas pixels; callers convert a constant screen tolerance to canvas units. */
export function snapOnStage(
  box: Box,
  canvas: { width: number; height: number },
  others: Box[],
  tolerance: number,
  axis?: "x" | "y",
) {
  const bounds = stageBounds(box);
  const all = others.map(stageBounds);
  const closest = (from: number[], to: number[]) => {
    let best: { delta: number; guide: number } | undefined;
    for (const source of from)
      for (const target of to) {
        const delta = target - source;
        if (
          Math.abs(delta) <= tolerance &&
          (!best || Math.abs(delta) < Math.abs(best.delta))
        )
          best = { delta, guide: target };
      }
    return best;
  };
  const x =
    axis === "y"
      ? undefined
      : closest(
          [bounds.left, bounds.center, bounds.right],
          [
            0,
            canvas.width / 2,
            canvas.width,
            ...all.flatMap((b) => [b.left, b.center, b.right]),
          ],
        );
  const y =
    axis === "x"
      ? undefined
      : closest(
          [bounds.top, bounds.middle, bounds.bottom],
          [
            0,
            canvas.height / 2,
            canvas.height,
            ...all.flatMap((b) => [b.top, b.middle, b.bottom]),
          ],
        );
  const next = {
    x: bounded(box.x + (x?.delta ?? 0)),
    y: bounded(box.y + (y?.delta ?? 0)),
  };
  return {
    ...next,
    guideX: next.x === box.x + (x?.delta ?? 0) ? x?.guide : undefined,
    guideY: next.y === box.y + (y?.delta ?? 0) ? y?.guide : undefined,
  };
}

/** Resize from the lower-right handle while keeping the opposite transformed corner fixed. */
export function resizeOnStage(
  box: Box,
  dx: number,
  dy: number,
  keepRatio: boolean,
) {
  const angle = (box.rotation * Math.PI) / 180,
    cosine = Math.cos(angle),
    sine = Math.sin(angle);
  const scale = Math.max(0.01, box.scale);
  const localX = (dx * cosine + dy * sine) / scale;
  const localY = (-dx * sine + dy * cosine) / scale;
  let width = Math.max(1, Math.min(8000, box.width + localX));
  let height = Math.max(1, Math.min(8000, box.height + localY));
  if (keepRatio) {
    const factor =
      Math.abs(localX / box.width) >= Math.abs(localY / box.height)
        ? width / box.width
        : height / box.height;
    const safe = Math.max(
      1 / Math.min(box.width, box.height),
      Math.min(8000 / Math.max(box.width, box.height), factor),
    );
    width = box.width * safe;
    height = box.height * safe;
  }
  const dw = width - box.width,
    dh = height - box.height;
  return {
    width,
    height,
    x: bounded(box.x + (scale * (dw * cosine - dh * sine) - dw) / 2),
    y: bounded(box.y + (scale * (dw * sine + dh * cosine) - dh) / 2),
  };
}
