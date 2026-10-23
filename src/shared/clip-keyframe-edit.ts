import type { Clip } from "./model";
import type { AnimatedProperty } from "./animation";

type Keys = Clip["keyframes"];
export type ClipKeyEdit =
  { keyframes: Keys; error?: never } | { error: string; keyframes?: never };
const maxFrame = 864000;

/** The editor uses clip-relative time; saved curves retain their original phase. */
export function visibleClipKeys(clip: Clip, property: AnimatedProperty): Keys {
  return clip.keyframes
    .filter(
      (key) =>
        key.property === property &&
        key.frame >= clip.animationOffset &&
        key.frame < clip.animationOffset + clip.duration,
    )
    .sort((a, b) => a.frame - b.frame);
}

function validLocalFrame(clip: Clip, frame: number) {
  return (
    Number.isInteger(frame) &&
    frame >= 0 &&
    frame < clip.duration &&
    frame + clip.animationOffset <= maxFrame
  );
}

/** Move or copy a selected saved key without replacing any destination key. */
export function relocateClipKey(
  clip: Clip,
  property: AnimatedProperty,
  sourceFrame: number,
  destinationLocalFrame: number,
  copy = false,
): ClipKeyEdit {
  const source = visibleClipKeys(clip, property).find(
    (key) => key.frame === sourceFrame,
  );
  if (!source) return { error: "Select a key inside this clip first." };
  if (!validLocalFrame(clip, destinationLocalFrame))
    return { error: "Choose a whole frame inside this clip." };
  const destination = destinationLocalFrame + clip.animationOffset;
  if (destination === sourceFrame && !copy)
    return { keyframes: clip.keyframes };
  if (
    clip.keyframes.some(
      (key) => key.property === property && key.frame === destination,
    )
  )
    return {
      error:
        "This property already has a key at that frame. Choose an empty frame.",
    };
  if (copy && clip.keyframes.length >= 2000)
    return { error: "This clip has reached its 2,000-key limit." };
  const keyframes = structuredClone(
    clip.keyframes.filter(
      (key) => copy || key.property !== property || key.frame !== sourceFrame,
    ),
  );
  keyframes.push({ ...structuredClone(source), frame: destination });
  keyframes.sort((a, b) => a.frame - b.frame);
  return { keyframes };
}

/** Retime only visible keys. Offscreen handles from trimming stay untouched. */
export function retimeClipKeys(
  clip: Clip,
  property: AnimatedProperty,
  start: number,
  end: number,
): ClipKeyEdit {
  const keys = visibleClipKeys(clip, property);
  if (keys.length < 2)
    return { error: "Add at least two visible keys to retime this property." };
  if (
    !validLocalFrame(clip, start) ||
    !validLocalFrame(clip, end) ||
    end <= start
  )
    return { error: "Choose a start and a later end frame inside this clip." };
  const first = keys[0].frame;
  const last = keys[keys.length - 1].frame;
  const moved = keys.map((key) => ({
    ...structuredClone(key),
    frame:
      clip.animationOffset +
      Math.round(
        start + ((key.frame - first) * (end - start)) / (last - first),
      ),
  }));
  if (new Set(moved.map((key) => key.frame)).size !== moved.length)
    return { error: "That range would overlap keys. Use a longer range." };
  const visibleFrames = new Set(keys.map((key) => key.frame));
  const keyframes = structuredClone(
    clip.keyframes.filter(
      (key) => key.property !== property || !visibleFrames.has(key.frame),
    ),
  );
  keyframes.push(...moved);
  keyframes.sort((a, b) => a.frame - b.frame);
  return { keyframes };
}
