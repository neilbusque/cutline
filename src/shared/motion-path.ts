import type { MotionLayer } from "./model";

type MotionPath = NonNullable<MotionLayer["motionPath"]>;
type Point = { x: number; y: number };
const samples = 128;
const lengths = new WeakMap<MotionPath, number[]>();

function pointAt(path: MotionPath, t: number): Point {
  const [a, b, c, d] = path.points;
  const u = 1 - t;
  return {
    x:
      u ** 3 * a.x + 3 * u ** 2 * t * b.x + 3 * u * t ** 2 * c.x + t ** 3 * d.x,
    y:
      u ** 3 * a.y + 3 * u ** 2 * t * b.y + 3 * u * t ** 2 * c.y + t ** 3 * d.y,
  };
}

/** Distance mapping avoids a speed surge when Bezier handles have unequal lengths. */
function distanceParameter(path: MotionPath, progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  let table = lengths.get(path);
  if (!table) {
    table = [0];
    let previous = pointAt(path, 0);
    for (let i = 1; i <= samples; i++) {
      const point = pointAt(path, i / samples);
      table.push(
        table[i - 1] + Math.hypot(point.x - previous.x, point.y - previous.y),
      );
      previous = point;
    }
    lengths.set(path, table);
  }
  const total = table[samples];
  if (total <= 1e-9) return 0;
  const distance = progress * total;
  let low = 1;
  let high = samples;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (table[middle] < distance) low = middle + 1;
    else high = middle;
  }
  const segment = table[low] - table[low - 1];
  return (
    (low - 1 + (segment > 0 ? (distance - table[low - 1]) / segment : 0)) /
    samples
  );
}

/** Pure frame sampling shared by preview and export, including degenerate curves. */
export function sampleMotionPath(path: MotionPath, progress: number) {
  const bounded = Number.isFinite(progress)
    ? Math.max(0, Math.min(1, progress))
    : 0;
  const t = distanceParameter(path, bounded);
  const point = pointAt(path, t);
  const [a, b, c, d] = path.points;
  const u = 1 - t;
  let dx =
    3 * u ** 2 * (b.x - a.x) +
    6 * u * t * (c.x - b.x) +
    3 * t ** 2 * (d.x - c.x);
  let dy =
    3 * u ** 2 * (b.y - a.y) +
    6 * u * t * (c.y - b.y) +
    3 * t ** 2 * (d.y - c.y);
  if (Math.hypot(dx, dy) < 1e-8) {
    // A one-sided tangent handles coincident controls and interior cusps. A
    // centered difference cancels at a U-turn and would flash an unrelated 0°.
    const before = pointAt(path, Math.max(0, t - 1e-4));
    const after = pointAt(path, Math.min(1, t + 1e-4));
    dx = after.x - point.x;
    dy = after.y - point.y;
    if (Math.hypot(dx, dy) < 1e-12) {
      dx = point.x - before.x;
      dy = point.y - before.y;
    }
  }
  return {
    ...point,
    angle:
      Math.hypot(dx, dy) < 1e-12 ? 0 : (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}
