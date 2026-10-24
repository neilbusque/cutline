/**
 * The moments to look at after a builder lays out a sequence: its first
 * frame, each visual beat once its entrance has settled, and its last frame.
 * At most 12, the most one cutline_preview contact sheet shows, so an
 * assistant checks the right frames in one call instead of guessing.
 */
export function checkFrames(
  fps: number,
  start: number,
  end: number,
  beats: { start: number; duration: number }[],
  settleSeconds = 0.6,
): number[] {
  const last = Math.max(start, end - 1);
  const settle = Math.round(fps * settleSeconds);
  const settled = [
    ...new Set(
      beats.map(
        (beat) => beat.start + Math.max(0, Math.min(beat.duration - 1, settle)),
      ),
    ),
  ]
    .filter((frame) => frame > start && frame < last)
    .sort((a, b) => a - b);
  // More beats than fit: an even sample that still spans the whole edit.
  const room = 10;
  const picked =
    settled.length <= room
      ? settled
      : Array.from(
          { length: room },
          (_, i) =>
            settled[Math.round((i * (settled.length - 1)) / (room - 1))],
        );
  return [...new Set([start, ...picked, last])];
}
