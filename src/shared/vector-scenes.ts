import { MotionSchema, makeClip, uid, type Project } from "./model";
import type { Command } from "./commands";
import { newTrack } from "./layers";
import { validateVectorViewBox, type ParsedEditableSvg } from "./vector-path";

/** One atomic creation plan shared by native SVG import and structured agent editing. */
export function createVectorScene(
  p: Project,
  start: number,
  source: ParsedEditableSvg,
  options: { name?: string; width?: number; height?: number } = {},
) {
  if (!Number.isInteger(start) || start < 0 || start > 864000)
    throw Error("Choose a whole start frame within project bounds.");
  validateVectorViewBox(source.viewBox);
  if (![source.width, source.height].every((n) => Number.isFinite(n) && n > 0))
    throw Error("Vector source dimensions must be positive.");
  const name = options.name ?? "Editable vector";
  const fit = Math.min(
    (p.width * 0.65) / source.width,
    (p.height * 0.65) / source.height,
    4000 / source.width,
    4000 / source.height,
  );
  const width =
    options.width ??
    (options.height
      ? (options.height * source.width) / source.height
      : source.width * fit);
  const height =
    options.height ??
    (options.width
      ? (options.width * source.height) / source.width
      : source.height * fit);
  if (![width, height].every((n) => Number.isFinite(n) && n >= 1 && n <= 4000))
    throw Error(
      "Vector placement width/height must be between 1 and 4,000 pixels.",
    );
  const frames = p.fps * 4;
  const track = p.tracks.find(
    (t) =>
      t.kind === "text" &&
      t.id !== "captions" &&
      !t.hidden &&
      !t.muted &&
      !p.clips.some(
        (c) =>
          c.trackId === t.id &&
          c.start < start + frames &&
          c.start + c.duration > start,
      ),
  );
  const destination = track ?? {
    ...newTrack(p, "text"),
    name: `${name} · vector`.slice(0, 100),
  };
  const motion = MotionSchema.parse({
    id: uid(),
    name,
    source: "vector",
    layers: source.layers.map((layer) => {
      const matrix = layer.vectorTransform ?? [1, 0, 0, 1, 0, 0];
      const sx = Math.hypot(matrix[0], matrix[1]),
        sy = Math.hypot(matrix[2], matrix[3]);
      const dot = matrix[0] * matrix[2] + matrix[1] * matrix[3];
      const vx = width / layer.vectorViewBox[2],
        vy = height / layer.vectorViewBox[3];
      // A stretched outline can only keep one width here; the average of its two
      // scales looks closest. Uniform transforms are exact.
      const uniform =
        Math.abs(sx - sy) <= Math.max(1, sx, sy) * 1e-7 &&
        Math.abs(dot) <= Math.max(1, sx * sy) * 1e-7;
      const strokeWidth = Math.min(
        100,
        layer.strokeWidth *
          (uniform ? sx : Math.sqrt(sx * sy)) *
          (layer.vectorAspectRatio === "none"
            ? Math.sqrt(vx * vy)
            : Math.min(vx, vy)),
      );
      return {
        ...layer,
        strokeWidth,
        x: (p.width - width) / 2,
        y: (p.height - height) / 2,
        width,
        height,
      };
    }),
  });
  const clip = {
    ...makeClip(p, "text", destination.id, start),
    text: name,
    preset: "custom" as const,
    motionId: motion.id,
    x: 0,
    y: 0,
    width: p.width,
    height: p.height,
    duration: frames,
  };
  const commands: Command[] = [
    { type: "motion.put", motion },
    ...(!track ? [{ type: "track.add" as const, track: destination }] : []),
    { type: "clip.add", clip },
  ];
  return { motion, clip, commands };
}
