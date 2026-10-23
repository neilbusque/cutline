import type { Clip, Motion, MotionLayer, Project } from "./model";
import { applyCommands, type Command } from "./commands";
import { propertyBounds } from "./animation";

const bounded = (
  value: number,
  factor: number,
  minimum: number,
  maximum: number,
) => Math.min(maximum, Math.max(minimum, value * factor));

function clipKeys(clip: Clip, sx: number, sy: number) {
  let changed = false;
  const keys = clip.keyframes.map((key) => {
    if (key.property !== "x" && key.property !== "y") return key;
    const [minimum, maximum] = propertyBounds[key.property];
    const value = bounded(
      key.value,
      key.property === "x" ? sx : sy,
      minimum,
      maximum,
    );
    if (value === key.value) return key;
    changed = true;
    return { ...key, value };
  });
  return changed ? keys : clip.keyframes;
}

function motionLayer(
  layer: MotionLayer,
  sx: number,
  sy: number,
  styleScale: number,
): MotionLayer {
  let changedKeys = false;
  const scaledKeys = layer.keyframes.map((key) => {
    const patch: Partial<typeof key> = {};
    if (key.x !== undefined) patch.x = bounded(key.x, sx, -4000, 4000);
    if (key.y !== undefined) patch.y = bounded(key.y, sy, -4000, 4000);
    if (key.blur !== undefined)
      patch.blur = bounded(key.blur, styleScale, 0, 100);
    if (key.strokeWidth !== undefined)
      patch.strokeWidth = bounded(key.strokeWidth, styleScale, 0, 100);
    if (
      !Object.entries(patch).some(
        ([name, value]) => value !== key[name as keyof typeof key],
      )
    )
      return key;
    changedKeys = true;
    return { ...key, ...patch };
  });
  const patch = {
    x: bounded(layer.x, sx, -4000, 4000),
    y: bounded(layer.y, sy, -4000, 4000),
    width: bounded(layer.width, sx, 1, 4000),
    height: bounded(layer.height, sy, 1, 4000),
    fontSize: bounded(layer.fontSize, styleScale, 8, 500),
    letterSpacing: bounded(layer.letterSpacing, styleScale, -30, 100),
    radius: bounded(layer.radius, styleScale, 0, 2000),
    glow: bounded(layer.glow, styleScale, 0, 100),
    blur: bounded(layer.blur, styleScale, 0, 100),
    strokeWidth: bounded(layer.strokeWidth, styleScale, 0, 100),
    keyframes: changedKeys ? scaledKeys : layer.keyframes,
  };
  return Object.entries(patch).some(
    ([name, value]) => value !== layer[name as keyof MotionLayer],
  )
    ? { ...layer, ...patch }
    : layer;
}

function resizedMotion(
  motion: Motion,
  sx: number,
  sy: number,
  styleScale: number,
): Motion {
  const layers = motion.layers.map((layer) =>
    motionLayer(layer, sx, sy, styleScale),
  );
  return layers.some((layer, index) => layer !== motion.layers[index])
    ? { ...motion, layers }
    : motion;
}

/** Plans one validated canvas edit. Timing, source media, curves and audio keep their phase. */
export function resizeCanvas(
  p: Project,
  width: number,
  height: number,
): Command[] {
  if (
    ![width, height].every(
      (value) => Number.isInteger(value) && value >= 320 && value <= 3840,
    )
  )
    throw Error(
      "Canvas width and height must be whole pixels between 320 and 3,840.",
    );
  if (width === p.width && height === p.height) return [];
  const sx = width / p.width,
    sy = height / p.height,
    styleScale = Math.min(sx, sy);
  const commands: Command[] = [
    { type: "project.update", patch: { width, height } },
  ];
  for (const clip of p.clips) {
    if (clip.kind === "audio") continue;
    const patch: Partial<Omit<Clip, "id">> = {
      x: bounded(clip.x, sx, -8000, 8000),
      y: bounded(clip.y, sy, -8000, 8000),
      width: bounded(clip.width, sx, 1, 8000),
      height: bounded(clip.height, sy, 1, 8000),
      fontSize: bounded(clip.fontSize, styleScale, 8, 500),
    };
    const keyframes = clipKeys(clip, sx, sy);
    if (keyframes !== clip.keyframes) patch.keyframes = keyframes;
    if (
      Object.entries(patch).some(
        ([name, value]) => value !== clip[name as keyof Clip],
      )
    )
      commands.push({ type: "clip.update", id: clip.id, patch });
  }
  // A definition can be referenced by several clips; scaling definitions once prevents compounded changes.
  for (const motion of p.motions) {
    const next = resizedMotion(motion, sx, sy, styleScale);
    if (next !== motion) commands.push({ type: "motion.put", motion: next });
  }
  if (commands.length > 2000)
    throw Error(
      "Canvas resize exceeds this project's 2,000-command edit limit.",
    );
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Change canvas",
    commands,
  });
  return commands;
}
