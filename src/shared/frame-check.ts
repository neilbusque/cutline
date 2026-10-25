/**
 * Finds single frames that break from both neighbours while the neighbours
 * agree with each other: the signature of a frame the renderer captured wrong
 * (seen 2026-10-24 as the top of the canvas tiled five times, speaker gone).
 * Frames are small thumbnails of equal size.
 */
export const FRAME_CHECK_SIZE = 96;
/** Mean 0-255 difference above which a frame breaks from a neighbour. */
export const FRAME_BREAK = 4;

export function meanDifference(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/** True when `current` differs from both neighbours more than they differ. */
export function isIsolatedFrame(
  previous: Uint8Array,
  current: Uint8Array,
  next: Uint8Array,
): boolean {
  const before = meanDifference(current, previous),
    after = meanDifference(current, next);
  return (
    before > FRAME_BREAK &&
    after > FRAME_BREAK &&
    meanDifference(previous, next) < 0.5 * Math.min(before, after)
  );
}

/**
 * Streams thumbnails through a three-frame window. A one-frame shot between
 * two matching ones is reported too; the caller re-renders each candidate to
 * tell a real one-frame edit from a damaged capture.
 */
export class IsolatedFrameFinder {
  private window: Uint8Array[] = [];
  private index = -1;
  readonly found: { frame: number; thumbnail: Uint8Array }[] = [];

  push(thumbnail: Uint8Array): void {
    this.index++;
    this.window.push(thumbnail);
    if (this.window.length > 3) this.window.shift();
    if (this.window.length < 3) return;
    const [previous, current, next] = this.window;
    if (isIsolatedFrame(previous, current, next))
      this.found.push({ frame: this.index - 1, thumbnail: current });
  }
}
