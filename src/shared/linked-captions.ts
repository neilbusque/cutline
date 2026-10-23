import type { Clip, Project } from "./model";
import type { Command } from "./commands";
import { trimClip } from "./timeline";

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
    commands.push({ type: "clip.update", id: caption.id, patch });
  }
  return commands;
}
