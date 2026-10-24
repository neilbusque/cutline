import type { Clip, Project } from "./model";
import type { Command } from "./commands";
import { playsForward, trimClip } from "./timeline";

/**
 * Generated captions belong to their source clip (captionSourceId). When a
 * clip is moved or trimmed by hand, its captions follow: a move shifts them by
 * the same amount, a trim cuts them to the clip's new bounds and removes the
 * ones that fall outside. The agent's clip.move and clip.trim do the same.
 */
export function linkedCaptionCommands(
  project: Project,
  before: Pick<Clip, "id" | "start" | "duration">,
  after: Pick<Clip, "start" | "duration">,
  mode: "move" | "trim",
): Command[] {
  const commands: Command[] = [];
  const captions = project.clips.filter((c) => c.captionSourceId === before.id);
  if (!captions.length) return commands;
  if (mode === "move") {
    const delta = after.start - before.start;
    if (!delta) return commands;
    for (const caption of captions)
      commands.push({
        type: "clip.update",
        id: caption.id,
        patch: { start: Math.max(0, caption.start + delta) },
      });
    return commands;
  }
  const start = after.start,
    end = after.start + after.duration;
  for (const caption of captions) {
    const left = Math.max(caption.start, start),
      right = Math.min(caption.start + caption.duration, end);
    if (left >= right) {
      commands.push({ type: "clip.delete", id: caption.id, ripple: false });
      continue;
    }
    if (left === caption.start && right === caption.start + caption.duration)
      continue;
    const { id: _id, ...patch } = trimClip(
      project,
      trimClip(project, caption, "right", right),
      "left",
      left,
    );
    // A trim that leaves none of a caption's words removes it, rather than
    // keeping a blank caption and an empty subtitle cue.
    if (caption.words.length && !patch.words.length)
      commands.push({ type: "clip.delete", id: caption.id, ripple: false });
    else commands.push({ type: "clip.update", id: caption.id, patch });
  }
  return commands;
}

/**
 * Changing a clip's speed or source in keeps its generated captions on the
 * words they show: each caption and word moves through source time to where
 * that speech now plays, then is cut to the clip's new length. A speed change
 * also stretches the clip's own keys around its animation start, so a
 * punch-in stays on its moment. Returns the clip's update, then its captions'.
 */
export function retimedClipCommands(
  project: Project,
  clip: Clip,
  patch: Partial<Omit<Clip, "id">>,
): Command[] {
  const after = { ...clip, ...patch },
    fps = project.fps;
  const plain: Command[] = [{ type: "clip.update", id: clip.id, patch }];
  if (
    (clip.kind !== "video" && clip.kind !== "audio") ||
    !playsForward(clip) ||
    !playsForward(after)
  )
    return plain;
  const ratio = clip.speed / after.speed;
  /** Timeline seconds where the speech heard at timeline second t plays now. */
  const at = (t: number) =>
    after.start / fps +
    (clip.sourceIn + (t - clip.start / fps) * clip.speed - after.sourceIn) /
      after.speed;
  // A move or a trim keeps every word where it was; other edits handle those.
  if (ratio === 1 && Math.abs(at(0) * fps) < 0.5) return plain;
  const keyframes =
    ratio === 1 || patch.keyframes || !clip.keyframes.length
      ? undefined
      : [
          ...new Map(
            clip.keyframes.map((key) => {
              const frame = Math.max(
                0,
                Math.round(
                  (key.frame - clip.animationOffset) * ratio +
                    clip.animationOffset,
                ),
              );
              // Keys that land on one frame keep the later one.
              return [`${key.property} ${frame}`, { ...key, frame }] as const;
            }),
          ).values(),
        ].sort((a, b) => a.frame - b.frame);
  const commands: Command[] = [
    {
      type: "clip.update",
      id: clip.id,
      patch: keyframes ? { ...patch, keyframes } : patch,
    },
  ];
  const end = after.start + after.duration;
  for (const caption of project.clips) {
    if (caption.captionSourceId !== clip.id) continue;
    const first = caption.start / fps;
    const from = Math.round(at(first) * fps),
      to = Math.max(
        from + 1,
        Math.round(at(first + caption.duration / fps) * fps),
      );
    const left = Math.max(from, after.start),
      right = Math.min(to, end);
    if (left >= right) {
      commands.push({ type: "clip.delete", id: caption.id, ripple: false });
      continue;
    }
    const moved: Clip = {
      ...caption,
      start: from,
      duration: to - from,
      words: caption.words.map((word) => ({
        ...word,
        start: at(first + word.start) - from / fps,
        end: at(first + word.end) - from / fps,
      })),
    };
    const { id: _id, ...fields } = trimClip(
      project,
      trimClip(project, moved, "right", right),
      "left",
      left,
    );
    if (caption.words.length && !fields.words.length)
      commands.push({ type: "clip.delete", id: caption.id, ripple: false });
    else commands.push({ type: "clip.update", id: caption.id, patch: fields });
  }
  return commands;
}
