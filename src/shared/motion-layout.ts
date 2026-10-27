import type { MotionLayer } from "./model";
import {
  evaluatedMotionLayer,
  motionProperties,
  motionRevealStart,
} from "./motion";

export type MotionLayerEditResult =
  { layers: MotionLayer[]; error?: never } | { error: string; layers?: never };
export type LayerAlignment =
  "left" | "center-x" | "right" | "top" | "center-y" | "bottom";
export type LayerBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
const lastFrame = 30 * 60 * 60 * 8;

/** Bounds of the transformed layer box, without glow, blur or music pulses. */
export function motionLayerBounds(
  layer: MotionLayer,
  frame: number,
): LayerBounds {
  const pose = evaluatedMotionLayer(layer, frame);
  const ax = pose.width * pose.anchorX;
  const ay = pose.height * pose.anchorY;
  const angle = (pose.rotate * Math.PI) / 180;
  const c = Math.cos(angle) * pose.scale;
  const s = Math.sin(angle) * pose.scale;
  const corners = [
    [0, 0],
    [pose.width, 0],
    [pose.width, pose.height],
    [0, pose.height],
  ].map(([x, y]) => ({
    x: pose.x + ax + (x - ax) * c - (y - ay) * s,
    y: pose.y + ay + (x - ax) * s + (y - ay) * c,
  }));
  return {
    left: Math.min(...corners.map((p) => p.x)),
    top: Math.min(...corners.map((p) => p.y)),
    right: Math.max(...corners.map((p) => p.x)),
    bottom: Math.max(...corners.map((p) => p.y)),
  };
}

function selection(layers: MotionLayer[], indices: number[]) {
  const unique = [...new Set(indices)];
  return unique.length &&
    unique.every((i) => Number.isInteger(i) && i >= 0 && i < layers.length)
    ? unique
    : null;
}
function moveLayers(
  layers: MotionLayer[],
  moves: Map<number, { x?: number; y?: number }>,
): MotionLayerEditResult {
  for (const [i, delta] of moves) {
    for (const axis of ["x", "y"] as const) {
      const next = layers[i][axis] + (delta[axis] ?? 0);
      if (!Number.isFinite(next) || next < -4000 || next > 4000)
        return {
          error:
            "This layout would move a layer beyond its position limits. Move the group closer to the canvas first.",
        };
    }
  }
  return {
    layers: layers.map((layer, i) => {
      const delta = moves.get(i);
      return delta
        ? { ...layer, x: layer.x + (delta.x ?? 0), y: layer.y + (delta.y ?? 0) }
        : layer;
    }),
  };
}

/** Move static origins so animated paths retain their shape and outgoing easing. */
export function alignMotionLayers(
  layers: MotionLayer[],
  indices: number[],
  canvas: { width: number; height: number },
  alignment: LayerAlignment,
  target: "canvas" | "selection",
  frame = 0,
): MotionLayerEditResult {
  const selected = selection(layers, indices);
  if (!selected) return { error: "Select at least one layer." };
  if (target === "selection" && selected.length < 2)
    return {
      error: "Select two or more layers to align within the selection.",
    };
  if (
    !Number.isFinite(frame) ||
    !Number.isFinite(canvas.width) ||
    !Number.isFinite(canvas.height) ||
    canvas.width <= 0 ||
    canvas.height <= 0
  )
    return { error: "The canvas dimensions and playhead must be valid." };
  const boxes = selected.map((i) => ({
    i,
    box: motionLayerBounds(layers[i], frame),
  }));
  const reference =
    target === "canvas"
      ? { left: 0, top: 0, right: canvas.width, bottom: canvas.height }
      : {
          left: Math.min(...boxes.map(({ box }) => box.left)),
          top: Math.min(...boxes.map(({ box }) => box.top)),
          right: Math.max(...boxes.map(({ box }) => box.right)),
          bottom: Math.max(...boxes.map(({ box }) => box.bottom)),
        };
  const coordinate = (box: LayerBounds) => {
    switch (alignment) {
      case "left":
        return box.left;
      case "center-x":
        return (box.left + box.right) / 2;
      case "right":
        return box.right;
      case "top":
        return box.top;
      case "center-y":
        return (box.top + box.bottom) / 2;
      case "bottom":
        return box.bottom;
    }
  };
  const axis = ["left", "center-x", "right"].includes(alignment) ? "x" : "y";
  return moveLayers(
    layers,
    new Map(
      boxes.map(({ i, box }) => [
        i,
        { [axis]: coordinate(reference) - coordinate(box) },
      ]),
    ),
  );
}

/** Equal edge-to-edge gaps; the two outside boxes stay in place. */
export function distributeMotionLayers(
  layers: MotionLayer[],
  indices: number[],
  axis: "x" | "y",
  frame = 0,
): MotionLayerEditResult {
  const selected = selection(layers, indices);
  if (!selected || selected.length < 3)
    return { error: "Select three or more layers to distribute." };
  if (!Number.isFinite(frame))
    return { error: "Choose a valid playhead frame." };
  const start = axis === "x" ? "left" : "top";
  const end = axis === "x" ? "right" : "bottom";
  const boxes = selected
    .map((i) => ({ i, box: motionLayerBounds(layers[i], frame) }))
    .sort((a, b) => a.box[start] - b.box[start] || a.i - b.i);
  const total = boxes.reduce((sum, { box }) => sum + box[end] - box[start], 0);
  const gap =
    (boxes.at(-1)!.box[end] - boxes[0].box[start] - total) / (boxes.length - 1);
  let at = boxes[0].box[start];
  const moves = new Map<number, { x?: number; y?: number }>();
  for (const { i, box } of boxes) {
    moves.set(i, { [axis]: at - box[start] });
    at += box[end] - box[start] + gap;
  }
  return moveLayers(layers, moves);
}

/** Ordered selection makes top-first, bottom-first and spatial stagger explicit. */
export function orderedMotionLayers(
  layers: MotionLayer[],
  indices: number[],
  order: "top-first" | "bottom-first" | "left-first",
  frame = 0,
): number[] {
  return [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < layers.length)
    .sort((a, b) =>
      order === "top-first"
        ? b - a
        : order === "bottom-first"
          ? a - b
          : motionLayerBounds(layers[a], frame).left -
              motionLayerBounds(layers[b], frame).left || a - b,
    );
}

function isTimed(layer: MotionLayer) {
  return (
    layer.keyframes.length > 0 ||
    (layer.type === "text" &&
      (layer.textAnimation === "line-reveal" || Boolean(layer.counter)))
  );
}

/** Offset whole sparse key sets; reject the complete operation if any layer cannot fit. */
export function shiftMotionLayerTiming(
  layers: MotionLayer[],
  indices: number[],
  offset: number,
  stagger = 0,
): MotionLayerEditResult {
  const selected = selection(layers, indices);
  if (!selected) return { error: "Select at least one layer." };
  if (![offset, stagger].every(Number.isInteger) || stagger < 0)
    return { error: "Use whole frames and a positive stagger." };
  const timed = selected.filter((i) => isTimed(layers[i]));
  if (!timed.length)
    return {
      error:
        "Add keyframes or a masked text reveal to the selected layers first.",
    };
  const changes = new Map<number, MotionLayer>();
  for (const [rank, index] of timed.entries()) {
    const layer = layers[index];
    const delta = offset + rank * stagger;
    if (!delta) continue;
    if (layer.loop !== "none")
      return {
        error:
          "Switch selected looping layers to Play once before shifting their timing.",
      };
    if (
      layer.type === "text" &&
      ["word-rise", "character-rise", "typewriter"].includes(
        layer.textAnimation,
      )
    ) {
      // Those reveal clocks derive from the opacity entrance, not a separate start field.
      const begin = motionRevealStart(layer);
      const hasEntrance =
        layer.keyframes.some(
          (key) => key.opacity === 0 && key.frame <= begin,
        ) &&
        layer.keyframes.some(
          (key) =>
            key.opacity !== undefined && key.opacity > 0 && key.frame >= begin,
        );
      if (!hasEntrance)
        return {
          error:
            "Give staggered text an opacity entrance first so its words and layer move together.",
        };
    }
    const keys = layer.keyframes.map((key) => ({
      ...key,
      frame: key.frame + delta,
    }));
    const reveal =
      layer.type === "text" && layer.textAnimation === "line-reveal";
    const start = layer.textRevealStart + delta;
    const counterStart = layer.counter ? layer.counter.startFrame + delta : 0;
    if (
      keys.some((key) => key.frame < 0 || key.frame > lastFrame) ||
      (reveal && (start < 0 || start > lastFrame)) ||
      (layer.counter && (counterStart < 0 || counterStart > lastFrame))
    )
      return {
        error:
          "This shift would place animation before frame 0 or beyond the timeline limit. No layers were changed.",
      };
    changes.set(index, {
      ...layer,
      keyframes: keys,
      ...(reveal ? { textRevealStart: start } : {}),
      ...(layer.counter
        ? { counter: { ...layer.counter, startFrame: counterStart } }
        : {}),
    });
  }
  return { layers: layers.map((layer, i) => changes.get(i) ?? layer) };
}

/** Scale native key times, loop length and masked reveal timing without merging distinct key times. */
export function scaleMotionLayerTiming(
  layers: MotionLayer[],
  indices: number[],
  percent: number,
): MotionLayerEditResult {
  const selected = selection(layers, indices);
  if (!selected) return { error: "Select at least one layer." };
  if (!Number.isFinite(percent) || percent < 10 || percent > 1000)
    return { error: "Choose a timing scale from 10% to 1000%." };
  const factor = percent / 100;
  const timed = selected.filter((i) => isTimed(layers[i]));
  if (!timed.length)
    return {
      error:
        "Add keyframes or a masked text reveal to the selected layers first.",
    };
  const changes = new Map<number, MotionLayer>();
  for (const index of timed) {
    const layer = layers[index];
    const keys = layer.keyframes.map((key) => ({
      ...key,
      frame: Math.round(key.frame * factor),
    }));
    // Two sparse siblings at the same source frame stay independent. Distinct effective
    // times of the same property may never collapse and silently overwrite a pose.
    for (const property of motionProperties) {
      const seen = new Map<number, number>();
      for (let i = 0; i < keys.length; i++) {
        if (keys[i][property] === undefined) continue;
        const prior = seen.get(keys[i].frame);
        if (prior !== undefined && prior !== layer.keyframes[i].frame)
          return {
            error:
              "This scale would merge keyframes. Choose a longer timing scale to keep every pose.",
          };
        seen.set(keys[i].frame, layer.keyframes[i].frame);
      }
    }
    const loopFrames = Math.round(layer.loopFrames * factor);
    const reveal =
      layer.type === "text" && layer.textAnimation === "line-reveal";
    const textRevealStart = Math.round(layer.textRevealStart * factor);
    const textRevealFrames = Math.round(layer.textRevealFrames * factor);
    const staggerFrames = Math.round(layer.staggerFrames * factor);
    const counter = layer.counter
      ? {
          ...layer.counter,
          startFrame: Math.round(layer.counter.startFrame * factor),
          durationFrames: Math.round(layer.counter.durationFrames * factor),
        }
      : undefined;
    if (
      keys.some((key) => key.frame < 0 || key.frame > lastFrame) ||
      (layer.loop !== "none" && (loopFrames < 1 || loopFrames > 1800)) ||
      (counter &&
        (counter.startFrame > lastFrame ||
          counter.durationFrames < 1 ||
          counter.durationFrames > lastFrame)) ||
      (reveal &&
        (textRevealStart > lastFrame ||
          textRevealFrames < 1 ||
          textRevealFrames > 1800 ||
          staggerFrames < 1 ||
          staggerFrames > 30))
    )
      return {
        error:
          "This scale exceeds native keyframe, loop or text-reveal limits. No layers were changed.",
      };
    changes.set(index, {
      ...layer,
      keyframes: keys,
      ...(layer.loop !== "none" ? { loopFrames } : {}),
      ...(reveal ? { textRevealStart, textRevealFrames, staggerFrames } : {}),
      ...(counter ? { counter } : {}),
    });
  }
  return { layers: layers.map((layer, i) => changes.get(i) ?? layer) };
}
