import type { Clip, Project, Snapshot } from "../shared/model";
import type { Command } from "../shared/commands";
import { linkedCaptionCommands } from "../shared/linked-captions";
import { trimClip } from "../shared/timeline";

export type EditRequest = {
  projectId: string;
  revision: number;
  label: string;
  commands: Command[];
};
type EditResult = { project?: { id: string; revision: number } } | null | void;

/**
 * Field patches that can safely build on a newer revision: they only set the
 * fields they name. Whole-object writes (motion.put and friends) carry a full
 * copy taken from what was on screen, so replaying them on a newer revision
 * would silently undo the edit that just landed.
 */
const REBASEABLE = new Set<Command["type"]>([
  "clip.update",
  "clip.keyframe",
  "track.update",
  "project.update",
]);
export const canRebase = (commands: Command[]) =>
  commands.length > 0 &&
  commands.every(
    (c) =>
      REBASEABLE.has(c.type) &&
      // Whole-curve replacements were derived from a specific snapshot. Rebasing
      // them could erase a keyframe edit that just landed from this same window.
      !(c.type === "clip.update" && "keyframes" in c.patch),
  );

/**
 * Sends edits one at a time. Each edit carries the revision the person was
 * looking at. When that revision only differs because this window's own
 * previous edit landed and has not rendered yet, a field patch builds on it
 * instead of failing with "Project changed". Anything else, and any change
 * from elsewhere (an agent, undo), still fails the revision check, so a
 * gesture never silently overwrites work the person has not seen.
 */
export function createEditQueue<R extends EditResult>(
  send: (request: EditRequest) => Promise<R>,
) {
  let tail: Promise<unknown> = Promise.resolve();
  const own = new Map<string, number>();
  const key = (projectId: string, revision: number) =>
    `${projectId}:${revision}`;
  return (request: EditRequest): Promise<R> => {
    const run = async () => {
      let revision = request.revision;
      for (let hop = 0; hop < 64 && canRebase(request.commands); hop++) {
        const next = own.get(key(request.projectId, revision));
        if (next === undefined) break;
        revision = next;
      }
      const result = await send({ ...request, revision });
      const landed = result?.project;
      if (landed?.id === request.projectId) {
        own.set(key(request.projectId, revision), landed.revision);
        if (own.size > 64) own.delete(own.keys().next().value!);
      }
      return result;
    };
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
}

/**
 * Holds a value that changes many times a second (a color being dragged in
 * the color panel) and commits it once: after a short pause, on blur, or when
 * the picker closes. Values that are already stored are never re-committed.
 */
export function createDraftCommit<T>(commit: (value: T) => void, delay = 250) {
  let stored: T | undefined;
  let pending: { value: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    stop();
    const next = pending;
    pending = undefined;
    if (next && !Object.is(next.value, stored)) {
      stored = next.value;
      commit(next.value);
    }
  };
  return {
    /** The project now holds this value (first render, undo, another edit). */
    sync(value: T) {
      stored = value;
    },
    change(value: T) {
      pending = { value };
      stop();
      timer = setTimeout(flush, delay);
    },
    flush,
    /** True while a change is waiting for its commit. */
    pending: () => pending !== undefined,
  };
}

/**
 * Arrow-key nudges add up while the key repeats and commit once on release,
 * so holding an arrow is one undo step instead of one per repeat.
 */
export function createNudge(commit: (id: string, start: number) => void) {
  let current: { id: string; from: number; delta: number } | undefined;
  const release = () => {
    const done = current;
    current = undefined;
    if (!done) return;
    const start = Math.max(0, done.from + done.delta);
    if (start !== done.from) commit(done.id, start);
  };
  return {
    /** Adds one step and returns where the clip shows now. */
    press(id: string, from: number, step: number) {
      if (current && current.id !== id) release();
      current ??= { id, from, delta: 0 };
      current.delta += step;
      return Math.max(0, current.from + current.delta);
    },
    release,
    active: () => current?.id,
  };
}

type Transform = Partial<Pick<Clip, "x" | "y" | "width" | "height">>;

/**
 * Moving or resizing a layer in the preview. X and Y that are animated get a
 * key at the playhead (keeping that key's easing); everything else is a plain
 * property change.
 */
export function transformCommands(
  c: Pick<Clip, "id" | "keyframes" | "animationOffset">,
  change: Transform,
  local: number,
): Command[] {
  const commands: Command[] = [];
  const rest: Transform = { ...change };
  for (const property of ["x", "y"] as const) {
    if (
      rest[property] === undefined ||
      !c.keyframes.some((k) => k.property === property)
    )
      continue;
    const at = local + (c.animationOffset ?? 0);
    const existing = c.keyframes.find(
      (k) => k.property === property && k.frame === at,
    );
    commands.push({
      type: "clip.keyframe",
      id: c.id,
      property,
      frame: local,
      value: rest[property]!,
      easing: existing?.easing ?? "ease-in-out",
      ...(existing?.easing === "cubic-bezier" && existing.bezier
        ? { bezier: existing.bezier }
        : {}),
      remove: false,
    });
    delete rest[property];
  }
  if (Object.keys(rest).length)
    commands.push({ type: "clip.update", id: c.id, patch: rest });
  return commands;
}

/** The clip as it will look once transformCommands land, for a live drag. */
export function previewTransform(c: Clip, change: Transform, local: number) {
  const next: Clip = { ...c };
  for (const command of transformCommands(c, change, local)) {
    if (command.type === "clip.update") Object.assign(next, command.patch);
    if (command.type !== "clip.keyframe") continue;
    const frame = command.frame + (c.animationOffset ?? 0);
    next.keyframes = [
      ...next.keyframes.filter(
        (k) => k.property !== command.property || k.frame !== frame,
      ),
      {
        property: command.property,
        frame,
        value: command.value,
        easing: command.easing,
        ...(command.bezier ? { bezier: command.bezier } : {}),
      },
    ].sort((a, b) => a.frame - b.frame);
  }
  return next;
}

/**
 * Trim Start or Trim End to a frame. Like a dragged edge, the clip's
 * generated captions are cut to its new bounds.
 */
export function trimCommands(
  project: Project,
  clip: Clip,
  edge: "left" | "right",
  frame: number,
): Command[] {
  const trimmed = trimClip(project, clip, edge, frame);
  const { id, ...patch } = trimmed;
  return [
    { type: "clip.update", id, patch },
    ...linkedCaptionCommands(project, clip, trimmed, "trim"),
  ];
}

/**
 * Start or Duration typed in Properties. A new start moves the clip's
 * generated captions with it; a new duration trims them, as dragging does.
 */
export function timingCommands(
  project: Project,
  clip: Clip,
  change: { start: number } | { duration: number },
): Command[] {
  const after = { start: clip.start, duration: clip.duration, ...change };
  return [
    { type: "clip.update", id: clip.id, patch: change },
    ...linkedCaptionCommands(
      project,
      clip,
      after,
      "start" in change ? "move" : "trim",
    ),
  ];
}

/** The project with a layer that is being dragged in the preview. */
export function withDraft(project: Project, draft?: Clip): Project {
  if (!draft || !project.clips.some((c) => c.id === draft.id)) return project;
  return {
    ...project,
    clips: project.clips.map((c) => (c.id === draft.id ? draft : c)),
  };
}

/**
 * A project that was never saved to a file lives only in the recovery copy,
 * which a new or opened project replaces. Saved projects autosave to their
 * file, so leaving them loses nothing.
 */
export const hasUnsavedWork = (
  snapshot: Pick<Snapshot, "filePath" | "canUndo"> & {
    project: Pick<Project, "clips" | "story">;
  },
) =>
  !snapshot.filePath &&
  (snapshot.canUndo ||
    snapshot.project.clips.length > 0 ||
    !!snapshot.project.story);
