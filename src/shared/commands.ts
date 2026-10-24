import { activeTransition, setTransition } from "./transitions";
import {
  compatibleTrack,
  flippedSourceIn,
  playsForward,
  trimClip,
} from "./timeline";
import { z } from "zod";
import {
  ClipSchema,
  MOTION_LIMIT,
  PropertyKeyframeSchema,
  MotionSchema,
  ProjectSchema,
  TrackSchema,
  motionLimitMessage,
  validateProject,
  uid,
  type Project,
  type Clip,
  type Track,
} from "./model";
// Defaults belong to creation, never to a partial update. Zod 4 otherwise
// inserts default geometry/timing into a patch that only changes text.
function patchShape(shape: Record<string, z.ZodType>) {
  return z
    .object(
      Object.fromEntries(
        Object.entries(shape)
          .filter(([key]) => key !== "id")
          .map(([key, schema]) => [
            key,
            (schema instanceof z.ZodDefault
              ? (schema.removeDefault() as z.ZodType)
              : schema
            ).optional(),
          ]),
      ),
    )
    .strict();
}
const patch = patchShape(ClipSchema.shape) as z.ZodType<
  Partial<Omit<Clip, "id">>
>;
const trackPatch = patchShape(TrackSchema.shape) as z.ZodType<
  Partial<Omit<Track, "id">>
>;
export const CommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("clip.keyframe"),
    id: z.string(),
    ...PropertyKeyframeSchema.shape,
    remove: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("clip.transition"),
    id: z.string(),
    kind: z.enum([
      "none",
      "crossfade",
      "black",
      "slide-left",
      "slide-right",
      "wipe",
    ]),
    frames: z.number().int().min(2).max(600).default(15),
  }),
  z.object({ type: z.literal("clip.add"), clip: ClipSchema }),
  z.object({ type: z.literal("clip.update"), id: z.string(), patch }),
  z.object({
    type: z.literal("clip.split"),
    id: z.string(),
    frame: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("clip.delete"),
    id: z.string(),
    ripple: z.boolean().default(false),
    deleteCaptions: z
      .boolean()
      .optional()
      .describe(
        "Also delete the captions generated from this clip. Defaults to true.",
      ),
  }),
  z.object({ type: z.literal("track.add"), track: TrackSchema }),
  z.object({
    type: z.literal("track.move"),
    id: z.string(),
    direction: z.enum(["up", "down"]),
  }),
  z.object({
    type: z.literal("track.update"),
    id: z.string(),
    patch: trackPatch,
  }),
  z.object({ type: z.literal("motion.put"), motion: MotionSchema }),
  z.object({
    type: z.literal("project.update"),
    patch: z.object({
      name: z.string().min(1).max(200).optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      background: ProjectSchema.shape.background.optional(),
      fps: ProjectSchema.shape.fps.optional(),
    }),
  }),
]);
export const TransactionSchema = z.object({
  projectId: z.string(),
  revision: z.number().int(),
  label: z.string().min(1).max(200),
  commands: z.array(CommandSchema).min(1).max(2000),
});
export type Command = z.infer<typeof CommandSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
function target(p: Project, id: string): Clip {
  const c = p.clips.find((c) => c.id === id);
  if (!c) throw Error("Clip no longer exists");
  return c;
}

/** Generated captions follow their media's split; independent captions stay untouched. */
function splitCaptionOwnership(
  p: Project,
  sourceId: string,
  rightId: string,
  frame: number,
) {
  p.clips = p.clips.flatMap((caption) => {
    if (
      caption.kind !== "caption" ||
      caption.captionSourceId !== sourceId ||
      caption.start + caption.duration <= frame
    )
      return [caption];
    if (caption.start >= frame)
      return [{ ...caption, captionSourceId: rightId }];
    const left = {
      ...caption,
      ...trimClip(p, caption, "right", frame),
      fadeOut: 0,
    };
    const right = {
      ...caption,
      ...trimClip(p, caption, "left", frame),
      id: uid(),
      captionSourceId: rightId,
      fadeIn: 0,
      transition: undefined,
    };
    // A cut in a caption's silent handle must not leave a blank timed cue.
    // Corrected captions with cleared alignment keep their text on each side;
    // splitting them must not invent replacement word timestamps.
    return [left, right].filter(
      (part) =>
        part.text.trim() && (!caption.words.length || part.words.length),
    );
  });
}

/** The clip that crossfades in from this one, if that transition is playing. */
function outgoingTransition(p: Project, c: Clip) {
  return p.clips.find(
    (x) => x.transition?.fromId === c.id && activeTransition(p, x),
  );
}

/** Frames of a clip's head and tail that overlap its crossfaded neighbours. */
function transitionOverlaps(p: Project, c: Clip) {
  const incoming = activeTransition(p, c);
  const outgoing = outgoingTransition(p, c);
  return {
    head: incoming
      ? incoming.previous.start + incoming.previous.duration - c.start
      : 0,
    tail: outgoing ? c.start + c.duration - outgoing.start : 0,
  };
}

/** A split inside a crossfade would leave one half drawn over the other. */
function assertOutsideTransitions(p: Project, c: Clip, frame: number) {
  const { head, tail } = transitionOverlaps(p, c);
  if (
    (head && frame <= c.start + head) ||
    (tail && frame >= c.start + c.duration - tail)
  )
    throw Error(
      "This frame is inside a transition. Split outside it, or remove the transition first.",
    );
}

/**
 * Removes a clip with the captions generated from it. A ripple closes the gap
 * on every track without stacking the clips that crossfaded with it.
 */
function deleteClip(
  p: Project,
  c: Clip,
  ripple: boolean,
  captions: boolean,
  cascaded: Set<string>,
) {
  const { head, tail } = ripple
    ? transitionOverlaps(p, c)
    : { head: 0, tail: 0 };
  const removed = new Set([c.id]);
  if (captions)
    for (const x of p.clips)
      if (x.captionSourceId === c.id) {
        removed.add(x.id);
        cascaded.add(x.id);
      }
  p.clips = p.clips.filter((x) => !removed.has(x.id));
  // A transition from a deleted clip has nothing left to blend from.
  for (const x of p.clips)
    if (x.transition?.fromId === c.id) delete x.transition;
  if (!ripple) return;
  const from = c.start + c.duration - tail,
    shift = Math.max(0, c.duration - head - tail);
  for (const x of p.clips) if (x.start >= from) x.start -= shift;
}

/** Raw edits must keep every clip it touches on a track of its kind. */
/** Where every clip sat before an edit, kept apart from the project the edit changes. */
type TrackPlaces = {
  clips: Map<string, Pick<Clip, "trackId" | "kind">>;
  tracks: Map<string, Track["kind"]>;
};
const trackPlaces = (p: Project): TrackPlaces => ({
  clips: new Map(p.clips.map((c) => [c.id, { trackId: c.trackId, kind: c.kind }])),
  tracks: new Map(p.tracks.map((t) => [t.id, t.kind])),
});

function checkTrackKinds(before: TrackPlaces, p: Project) {
  const tracks = new Map(p.tracks.map((t) => [t.id, t]));
  for (const c of p.clips) {
    const t = tracks.get(c.trackId);
    if (!t || compatibleTrack(c, t)) continue;
    const old = before.clips.get(c.id);
    // A mismatch saved by an older build stays editable until it is moved.
    if (
      old &&
      old.trackId === c.trackId &&
      old.kind === c.kind &&
      before.tracks.get(t.id) === t.kind
    )
      continue;
    throw Error(
      `Track "${t.name}" holds ${t.kind} clips, so ${c.kind} clip ${c.id} cannot go there.`,
    );
  }
}

/**
 * Motion designs are kept until the project would pass its limit. Then the
 * oldest ones no clip uses are dropped, never one added in this edit.
 */
function collectMotions(p: Project, added: Set<string>) {
  let excess = p.motions.length - MOTION_LIMIT;
  if (excess <= 0) return;
  const used = new Set(p.clips.map((c) => c.motionId));
  const drop = new Set<string>();
  for (const m of p.motions) {
    if (!excess) break;
    if (used.has(m.id) || added.has(m.id)) continue;
    drop.add(m.id);
    excess--;
  }
  if (excess) throw Error(motionLimitMessage);
  p.motions = p.motions.filter((m) => !drop.has(m.id));
}

/**
 * Applies one transaction. By default the project passed in is left untouched
 * and the result is validated. A caller already holding a private copy (an
 * agent edit applying many actions) can skip the copy and the validation and
 * validate once at the end: each costs tens of milliseconds on a real project.
 */
export function applyCommands(
  project: Project,
  raw: unknown,
  options: { clone?: boolean; validate?: boolean } = {},
): Project {
  const tx = TransactionSchema.parse(raw);
  if (tx.projectId !== project.id || tx.revision !== project.revision)
    throw Error("Project changed. Refresh the project and retry this edit.");
  const before = trackPlaces(project);
  const p = options.clone === false ? project : structuredClone(project);
  // Captions already removed with their source clip earlier in this edit.
  const cascaded = new Set<string>();
  const putMotions = new Set<string>();
  for (const op of tx.commands) {
    switch (op.type) {
      case "clip.keyframe": {
        const c = target(p, op.id);
        if (op.frame >= c.duration)
          throw Error("Place keyframes inside the clip");
        const frame = op.frame + c.animationOffset;
        c.keyframes = c.keyframes.filter(
          (k) => k.property !== op.property || k.frame !== frame,
        );
        if (!op.remove)
          c.keyframes.push(
            PropertyKeyframeSchema.parse({
              property: op.property,
              frame,
              value: op.value,
              easing: op.easing,
              ...(op.easing === "cubic-bezier" && op.bezier
                ? { bezier: op.bezier }
                : {}),
            }),
          );
        c.keyframes.sort((a, b) => a.frame - b.frame);
        break;
      }
      case "clip.transition":
        setTransition(p, target(p, op.id), op.kind, op.frames);
        break;
      case "clip.add":
        p.clips.push(op.clip);
        cascaded.delete(op.clip.id);
        break;
      case "clip.update": {
        const c = target(p, op.id);
        Object.assign(c, withDirection(p, c, op.patch));
        break;
      }
      case "clip.split": {
        const c = target(p, op.id);
        const offset = op.frame - c.start;
        if (offset <= 0 || offset >= c.duration)
          throw Error("Place the playhead inside the clip to split");
        assertOutsideTransitions(p, c, op.frame);
        const right = {
          ...structuredClone(c),
          id: uid(),
          start: op.frame,
          duration: c.duration - offset,
          // Both halves of a held frame hold the same frame.
          sourceIn: c.freeze
            ? c.sourceIn
            : c.sourceIn + (offset / p.fps) * c.speed,
          fadeIn: 0,
          transition: undefined,
          animationOffset: c.animationOffset + offset,
          words: c.words
            .filter((w) => w.end > offset / p.fps)
            .map((w) => ({
              ...w,
              start: Math.max(0, w.start - offset / p.fps),
              end: w.end - offset / p.fps,
            })),
        };
        c.duration = offset;
        c.fadeOut = 0;
        c.words = c.words
          .filter((w) => w.start < offset / p.fps)
          .map((w) => ({ ...w, end: Math.min(w.end, offset / p.fps) }));
        if (c.kind === "caption" && (c.words.length || right.words.length)) {
          c.text = c.words.map((w) => w.text).join(" ");
          right.text = right.words.map((w) => w.text).join(" ");
        }
        if (c.kind === "video" || c.kind === "audio")
          splitCaptionOwnership(p, c.id, right.id, op.frame);
        for (const next of p.clips)
          if (next.transition?.fromId === c.id)
            next.transition.fromId = right.id;
        p.clips.push(right);
        break;
      }
      case "clip.delete":
        // Deleting every clip, as a full replace does, may name a caption
        // that already went with its source clip.
        if (!cascaded.has(op.id))
          deleteClip(
            p,
            target(p, op.id),
            op.ripple,
            op.deleteCaptions ?? true,
            cascaded,
          );
        break;
      case "track.add":
        // Media overlays sit below titles/captions so B-roll cannot cover text.
        if (op.track.kind === "video") {
          const index = p.tracks.findIndex((t) => t.kind === "video");
          p.tracks.splice(index < 0 ? p.tracks.length : index, 0, op.track);
        } else if (op.track.kind === "audio") p.tracks.push(op.track);
        else p.tracks.unshift(op.track);
        break;
      case "track.move": {
        const index = p.tracks.findIndex((t) => t.id === op.id);
        if (index < 0) throw Error("Track missing");
        const next = index + (op.direction === "up" ? -1 : 1);
        if (next >= 0 && next < p.tracks.length) {
          const [track] = p.tracks.splice(index, 1);
          p.tracks.splice(next, 0, track);
        }
        break;
      }
      case "track.update": {
        const t = p.tracks.find((t) => t.id === op.id);
        if (!t) throw Error("Track missing");
        Object.assign(t, op.patch);
        break;
      }
      case "motion.put": {
        const i = p.motions.findIndex((m) => m.id === op.motion.id);
        if (i < 0) p.motions.push(op.motion);
        else p.motions[i] = keepUnknownMotionFields(p.motions[i], op.motion);
        putMotions.add(op.motion.id);
        break;
      }
      case "project.update":
        // Clip timing is counted in frames, so the rate is chosen first.
        if (
          op.patch.fps !== undefined &&
          op.patch.fps !== p.fps &&
          p.clips.length
        )
          throw Error(
            "Set the frame rate before adding clips; their timing is counted in frames.",
          );
        Object.assign(p, op.patch);
        break;
    }
  }
  checkTrackKinds(before, p);
  collectMotions(p, putMotions);
  p.revision++;
  return options.validate === false ? p : validateProject(p);
}

const motionFields = new Set(Object.keys(MotionSchema.shape));
/** Fields a newer Cutline stored on a motion survive this version's edits to it. */
function keepUnknownMotionFields(
  old: Project["motions"][number],
  next: Project["motions"][number],
) {
  const extra = Object.entries(old).filter(
    ([key]) => !motionFields.has(key) && !Object.hasOwn(next, key),
  );
  return extra.length ? { ...Object.fromEntries(extra), ...next } : next;
}
type ClipPatch = Partial<Omit<Clip, "id">>;
/**
 * Switching reverse on or off keeps the same footage on screen: sourceIn is
 * recounted from the other end of the source, unless the edit names one.
 */
function withDirection(p: Project, c: Clip, change: ClipPatch): ClipPatch {
  if (
    change.reverse === undefined ||
    change.reverse === c.reverse ||
    change.sourceIn !== undefined
  )
    return change;
  const asset = p.assets.find((a) => a.id === c.assetId);
  if (!asset || asset.kind === "image") return change;
  return {
    ...change,
    sourceIn: flippedSourceIn({ ...c, ...change }, asset.duration, p.fps),
  };
}
/**
 * Cuts long pauses out of a video or audio clip as one undoable edit. The
 * first kept part keeps the clip's ID, entrance and incoming transition; the
 * last keeps its exit and outgoing transition. Keyframes keep their phase,
 * linked captions are cut with the speech, and every other clip moves with
 * the moment it sat over.
 */
export function removePauses(
  p: Project,
  id: string,
  silences: { start: number; end: number }[],
): Command[] {
  const c = target(p, id);
  if (c.kind !== "video" && c.kind !== "audio")
    throw Error("Select a video or audio clip");
  if (!playsForward(c))
    throw Error(
      "This clip plays backwards or holds a frame, so its pauses can't be found. Turn off Reverse and Freeze frame first.",
    );
  const from = c.sourceIn,
    to = from + (c.duration / p.fps) * c.speed;
  /** The clip frame where a source time plays. */
  const frameOf = (seconds: number) => ((seconds - from) * p.fps) / c.speed;
  // Crossfades keep their whole overlap and one clear frame beside it.
  const { head, tail } = transitionOverlaps(p, c);
  const first = head ? head + 1 : 0,
    last = tail ? c.duration - tail - 1 : c.duration;
  const cuts = silences
    .map((s) => ({
      start: Math.max(from, s.start + 0.08),
      end: Math.min(to, s.end - 0.08),
    }))
    .filter((s) => s.end - s.start > 0.3)
    // Only whole frames inside the pause, so no speech is clipped.
    .map((s) => ({
      start: Math.max(first, Math.ceil(frameOf(s.start) - 1e-7)),
      end: Math.min(last, Math.floor(frameOf(s.end) + 1e-7)),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (!cuts.length) return [];
  /** Kept clip frames [from, to) and the timeline frame they now start at. */
  const parts: { id: string; from: number; to: number; at: number }[] = [];
  let cursor = 0,
    at = c.start;
  for (const cut of [...cuts, { start: c.duration, end: c.duration }]) {
    if (cut.start > cursor) {
      parts.push({
        id: parts.length ? uid() : c.id,
        from: cursor,
        to: cut.start,
        at,
      });
      at += cut.start - cursor;
    }
    cursor = Math.max(cursor, cut.end);
  }
  // A clip that is silent throughout is left alone.
  if (!parts.length) return [];
  const end = c.start + c.duration,
    removed = end - at;
  /** Where a frame of the old timeline plays once the pauses are gone. */
  const map = (frame: number) => {
    if (frame <= c.start) return frame;
    if (frame >= end) return frame - removed;
    const f = frame - c.start;
    for (const part of parts) {
      if (f < part.from) return part.at;
      if (f <= part.to) return part.at + f - part.from;
    }
    return at;
  };
  const piece = (clip: Clip, lo: number, hi: number) =>
    trimClip(p, trimClip(p, clip, "right", hi), "left", lo);
  const patches = new Map<string, ClipPatch>();
  const update = (clipId: string, patch: ClipPatch) =>
    patches.set(clipId, { ...patches.get(clipId), ...patch });
  const ops: Command[] = [];
  for (const [index, part] of parts.entries()) {
    const kept = piece(c, c.start + part.from, c.start + part.to);
    const fields = {
      start: part.at,
      duration: part.to - part.from,
      sourceIn: kept.sourceIn,
      animationOffset: kept.animationOffset,
      words: kept.words,
      fadeIn: index ? 0 : c.fadeIn,
      fadeOut: index === parts.length - 1 ? c.fadeOut : 0,
    };
    if (!index) update(c.id, fields);
    else
      ops.push({
        type: "clip.add",
        clip: { ...kept, ...fields, id: part.id, transition: undefined },
      });
  }
  const outgoing = outgoingTransition(p, c);
  if (outgoing?.transition && parts.length > 1)
    update(outgoing.id, {
      transition: { ...outgoing.transition, fromId: parts.at(-1)!.id },
    });
  const ids = new Set(p.clips.map((x) => x.id));
  for (const x of p.clips) {
    const xEnd = x.start + x.duration;
    if (x.id === c.id || xEnd <= c.start) continue;
    if (x.start >= end) {
      update(x.id, { start: x.start - removed });
      continue;
    }
    if (x.captionSourceId === c.id) {
      // Linked captions are cut with their words and owned by the part they show over.
      const cues = parts
        .flatMap((part) => {
          const lo = Math.max(x.start, c.start + part.from),
            hi = Math.min(xEnd, c.start + part.to);
          if (lo >= hi) return [];
          const cue = piece(x, lo, hi);
          return [
            {
              ...cue,
              start: part.at + lo - c.start - part.from,
              captionSourceId: part.id,
            },
          ];
        })
        .filter(
          (cue) => cue.text.trim() && (!x.words.length || cue.words.length),
        );
      if (!cues.length)
        ops.push({ type: "clip.delete", id: x.id, ripple: false });
      cues.forEach((cue, i) => {
        const { id: ignored, ...fields } = {
          ...cue,
          fadeIn: i ? 0 : x.fadeIn,
          fadeOut: i === cues.length - 1 ? x.fadeOut : 0,
        };
        if (!i) update(x.id, fields);
        else
          ops.push({
            type: "clip.add",
            clip: { ...fields, id: uid(), transition: undefined },
          });
      });
      continue;
    }
    const start = map(x.start),
      stop = map(xEnd);
    if (
      x.kind === "caption" &&
      x.words.length &&
      !(x.captionSourceId && ids.has(x.captionSourceId))
    ) {
      // Imported or hand-made subtitles keep each word on its speech.
      const words = x.words
        .map((w) => ({
          ...w,
          start: (map(x.start + w.start * p.fps) - start) / p.fps,
          end: (map(x.start + w.end * p.fps) - start) / p.fps,
        }))
        .filter((w) => w.end > w.start);
      if (!words.length) {
        ops.push({ type: "clip.delete", id: x.id, ripple: false });
        continue;
      }
      update(x.id, {
        start,
        duration: Math.max(1, stop - start),
        words,
        ...(words.length < x.words.length
          ? { text: words.map((w) => w.text).join(" ") }
          : {}),
      });
      continue;
    }
    // B-roll, titles and music keep their content and lose only the removed
    // time they spanned. One that sat only inside a pause moves to the cut.
    const duration = stop - start >= 1 ? stop - start : x.duration;
    if (start !== x.start || duration !== x.duration)
      update(x.id, { start, duration });
  }
  return [
    ...[...patches].map(([clipId, patch]): Command => ({
      type: "clip.update",
      id: clipId,
      patch,
    })),
    ...ops,
  ];
}
