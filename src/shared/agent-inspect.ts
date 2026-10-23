import { z } from "zod";
import { applyAgentEdit } from "./agent-edit";
import {
  ClipSchema,
  duration,
  publicRhythm,
  type Asset,
  type Clip,
  type Motion,
  type Project,
} from "./model";

/**
 * What agents read back. Everything here is sized for an assistant's tool
 * output cap (Claude Code allows 25,000 tokens, about 75,000 characters at
 * best): results stay near INSPECT_BUDGET characters and page beyond it.
 */
export const INSPECT_BUDGET = 40_000;
const LIST_CAP = 100;

export const InspectArgsSchema = z.strictObject({
  detail: z.enum(["summary", "full"]).default("summary"),
  clipIds: z.array(z.string().min(1).max(200)).min(1).max(2000).optional(),
  kinds: z.array(ClipSchema.shape.kind).min(1).max(5).optional(),
  fromFrame: z.number().int().min(0).optional(),
  toFrame: z.number().int().min(0).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(2000).optional(),
});
export type InspectArgs = z.input<typeof InspectArgsSchema>;

const size = (value: unknown) => JSON.stringify(value).length;
const excerpt = (text: string, max = 120) =>
  text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;

/** An asset without local paths, waveform samples or transcript words. */
export function publicAsset(asset: Asset) {
  const {
    path: _path,
    thumbnail: _thumbnail,
    proxy: _proxy,
    waveform: _waveform,
    words,
    rhythm,
    ...rest
  } = asset;
  return {
    ...rest,
    ...(words?.length ? { transcriptWords: words.length } : {}),
    ...(rhythm ? { rhythm: publicRhythm(rhythm) } : {}),
  };
}

const clipDefaults = new Map<string, Record<string, unknown>>();
function defaultsFor(kind: Clip["kind"]) {
  let defaults = clipDefaults.get(kind);
  if (!defaults) {
    defaults = ClipSchema.parse({
      id: "",
      trackId: "",
      kind,
      start: 0,
      duration: 1,
    }) as Record<string, unknown>;
    clipDefaults.set(kind, defaults);
  }
  return defaults;
}
const counted = <T>(items: T[], keys: (item: T) => string[]) => {
  const counts: Record<string, number> = {};
  for (const item of items)
    for (const key of keys(item)) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
};
const summaryHandled = new Set([
  "id",
  "kind",
  "trackId",
  "start",
  "duration",
  "text",
  "words",
  "keyframes",
  "transition",
  "musicReactive",
]);

/** A clip's identity, timing and every field that differs from the defaults. */
export function clipSummary(clip: Clip) {
  const defaults = defaultsFor(clip.kind);
  const summary: Record<string, unknown> = {
    id: clip.id,
    kind: clip.kind,
    trackId: clip.trackId,
    start: clip.start,
    duration: clip.duration,
  };
  if (clip.text) summary.text = excerpt(clip.text);
  for (const [key, value] of Object.entries(clip)) {
    if (summaryHandled.has(key) || value === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(defaults[key]))
      summary[key] = value;
  }
  if (clip.keyframes.length)
    summary.keyframes = counted(clip.keyframes, (key) => [key.property]);
  if (clip.transition)
    summary.transition = {
      kind: clip.transition.kind,
      frames: clip.transition.frames,
    };
  if (clip.musicReactive) {
    const { musicClipId, mode, style, scope } = clip.musicReactive;
    summary.musicReactive = { musicClipId, mode, style, scope };
  }
  return summary;
}

/** A motion's layers by index, with type, name, text and which properties are keyed. */
export function motionSummary(motion: Motion) {
  return {
    id: motion.id,
    name: motion.name,
    layers: motion.layers.map((layer, index) => {
      const summary: Record<string, unknown> = { index, type: layer.type };
      if (layer.name) summary.name = layer.name;
      if (layer.text) summary.text = excerpt(layer.text, 60);
      if (layer.hidden) summary.hidden = true;
      if (layer.keyframes.length)
        summary.keys = counted(layer.keyframes, (key) =>
          Object.keys(key).filter(
            (name) =>
              !["frame", "easing", "bezier"].includes(name) &&
              (key as Record<string, unknown>)[name] !== undefined,
          ),
        );
      if (layer.loop !== "none") summary.loop = layer.loop;
      return summary;
    }),
  };
}

/** Many generated captions read as one line each: track, source clip, count and span. */
function captionGroups(captions: Clip[]) {
  const groups = new Map<string, Clip[]>();
  for (const caption of captions) {
    const key = `${caption.trackId}\u0000${caption.captionSourceId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), caption]);
  }
  return [...groups.values()].map((group) => {
    const styles = counted(group, (clip) => [clip.captionStyle]);
    return {
      trackId: group[0].trackId,
      sourceClipId: group[0].captionSourceId ?? null,
      count: group.length,
      firstFrame: Math.min(...group.map((clip) => clip.start)),
      endFrame: Math.max(...group.map((clip) => clip.start + clip.duration)),
      style: Object.entries(styles).sort((a, b) => b[1] - a[1])[0][0],
      firstText: excerpt(group[0].text, 60),
    };
  });
}

/**
 * cutline_inspect. summary (the default) lists each clip's timing and the
 * fields that differ from defaults, groups long caption runs and lists motion
 * layers by index. full returns complete clips and motions. Both leave out
 * local paths, transcript words and waveforms, and page past the budget.
 */
export function inspectProject(
  project: Project,
  raw: unknown = {},
  budget = INSPECT_BUDGET,
) {
  const args = InspectArgsSchema.parse(raw ?? {});
  const full = args.detail === "full";
  const filtered =
    !!args.clipIds ||
    !!args.kinds ||
    args.fromFrame !== undefined ||
    args.toFrame !== undefined;
  const ids = args.clipIds ? new Set(args.clipIds) : undefined;
  const order = new Map(
    project.tracks.map((track, index) => [track.id, index]),
  );
  let clips = project.clips.filter(
    (clip) =>
      (!ids || ids.has(clip.id)) &&
      (!args.kinds || args.kinds.includes(clip.kind)) &&
      (args.toFrame === undefined || clip.start < args.toFrame) &&
      (args.fromFrame === undefined ||
        clip.start + clip.duration > args.fromFrame),
  );
  // Summaries read in timeline order; full keeps the stored order.
  if (!full)
    clips = [...clips].sort(
      (a, b) =>
        a.start - b.start ||
        (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0),
    );
  const captions = clips.filter((clip) => clip.kind === "caption");
  const grouped = !full && !filtered && captions.length > 12;
  if (grouped) clips = clips.filter((clip) => clip.kind !== "caption");

  const assets = project.assets.slice(0, 200).map(publicAsset);
  const head = {
    detail: args.detail,
    id: project.id,
    name: project.name,
    revision: project.revision,
    width: project.width,
    height: project.height,
    fps: project.fps,
    background: project.background,
    durationFrames: duration(project),
    durationSeconds: Number((duration(project) / project.fps).toFixed(2)),
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      ...(track.muted ? { muted: true } : {}),
      ...(track.hidden ? { hidden: true } : {}),
    })),
    assets,
    ...(project.assets.length > assets.length
      ? { assetCount: project.assets.length }
      : {}),
  };
  let used = size(head) + 200;
  const listed: unknown[] = [];
  const motions = new Map<string, unknown>();
  const oversized: string[] = [];
  const motionView = (motion: Motion) => {
    if (!full) return motionSummary(motion);
    if (size(motion) <= budget / 2) return motion;
    oversized.push(motion.id);
    return motionSummary(motion);
  };
  const groups = grouped ? captionGroups(captions) : undefined;
  if (groups) used += size(groups);
  let index = args.offset;
  for (; index < clips.length; index++) {
    if (args.limit !== undefined && listed.length >= args.limit) break;
    const clip = clips[index];
    let view: unknown = full ? clip : clipSummary(clip);
    if (full && size(clip) > budget / 2) {
      oversized.push(clip.id);
      view = clipSummary(clip);
    }
    const motion =
      clip.motionId && !motions.has(clip.motionId)
        ? project.motions.find((item) => item.id === clip.motionId)
        : undefined;
    const motionEntry = motion ? motionView(motion) : undefined;
    const cost = size(view) + (motionEntry ? size(motionEntry) : 0) + 2;
    if (listed.length && used + cost > budget) break;
    listed.push(view);
    if (motion) motions.set(motion.id, motionEntry);
    used += cost;
  }
  const complete = index >= clips.length && args.offset === 0;
  // Unfiltered views also list motion definitions no listed clip uses.
  let unlistedMotions = 0;
  if (!filtered && complete)
    for (const motion of project.motions) {
      if (motions.has(motion.id)) continue;
      const entry = motionView(motion);
      if (used + size(entry) > budget) {
        unlistedMotions++;
        continue;
      }
      motions.set(motion.id, entry);
      used += size(entry);
    }
  // Full views keep the stored motion order.
  const motionList = full
    ? project.motions
        .filter((motion) => motions.has(motion.id))
        .map((motion) => motions.get(motion.id))
    : [...motions.values()];
  const notes: string[] = [];
  if (!full)
    notes.push(
      "Summary: clips show timing and the fields that differ from defaults. Use detail full with clipIds for every field.",
    );
  if (grouped)
    notes.push(
      'Captions are grouped. Use kinds ["caption"] (with fromFrame and toFrame) to list them, or cutline_search_transcript to find words.',
    );
  if (oversized.length)
    notes.push(
      `Too large to show in full, summarized instead: ${oversized.join(", ")}.`,
    );
  if (unlistedMotions)
    notes.push(
      `${unlistedMotions} unused motion definitions are not shown. Inspect the clips that use them.`,
    );
  return {
    ...head,
    clips: listed,
    ...(groups ? { captionGroups: groups } : {}),
    motions: motionList,
    ...(index < clips.length || args.offset > 0
      ? {
          page: {
            offset: args.offset,
            returned: listed.length,
            total: clips.length,
            ...(index < clips.length ? { nextOffset: index } : {}),
          },
        }
      : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

const capped = (ids: string[]) => ids.slice(0, LIST_CAP);
/** IDs of clips, motions, tracks and assets that differ between two versions. */
export function projectChanges(before: Project, after: Project) {
  const changed = <T extends { id: string }>(old: T[], next: T[]) => {
    const previous = new Map(
      old.map((item) => [item.id, JSON.stringify(item)]),
    );
    const kept = new Set(next.map((item) => item.id));
    return [
      ...next
        .filter((item) => previous.get(item.id) !== JSON.stringify(item))
        .map((item) => item.id),
      ...old.filter((item) => !kept.has(item.id)).map((item) => item.id),
    ];
  };
  return {
    clipIds: changed(before.clips, after.clips),
    motionIds: changed(before.motions, after.motions),
    trackIds: changed(before.tracks, after.tracks),
    assetIds: changed(before.assets, after.assets),
  };
}

/** A short change report for edit tools: what changed, never the whole project. */
export function changeSummary(before: Project, after: Project) {
  const changes = projectChanges(before, after);
  return {
    changedClipIds: capped(changes.clipIds),
    changedMotionIds: capped(changes.motionIds),
    changedTrackIds: capped(changes.trackIds),
    ...(changes.assetIds.length
      ? { changedAssetIds: capped(changes.assetIds) }
      : {}),
    ...(changes.clipIds.length > LIST_CAP
      ? { changedClipCount: changes.clipIds.length }
      : {}),
    durationBefore: duration(before),
    durationAfter: duration(after),
  };
}

/**
 * cutline_edit: checks every argument, prepares the whole edit, commits it
 * once (unless dryRun) and answers with editResult.
 */
export function performAgentEdit(
  store: {
    project: Project;
    commit: (next: Project, label: string) => unknown;
  },
  args: Record<string, unknown>,
) {
  const { detail, ...edit } = args;
  // Anything invalid is rejected before the project changes.
  const view = z.enum(["summary", "full"]).optional().parse(detail);
  const prepared = applyAgentEdit(store.project, edit);
  if (!prepared.dryRun) store.commit(prepared.project, prepared.label);
  return editResult(prepared, store.project, view);
}

type PreparedEdit = {
  project: Project;
  label: string;
  dryRun: boolean;
  created: { id: string; kind: string; ref?: string }[];
  references: Record<string, string>;
  summary: {
    actionCount: number;
    changedClipIds: string[];
    changedMotionIds: string[];
    changedTrackIds: string[];
    durationBefore: number;
    durationAfter: number;
    warnings: string[];
  };
};
/**
 * cutline_edit's result: the revision to use next, created IDs and refs and a
 * change summary. detail full adds every field of the changed clips and motions.
 */
export function editResult(
  prepared: PreparedEdit,
  live: Project,
  detail: "summary" | "full" = "summary",
  budget = INSPECT_BUDGET,
) {
  const { summary } = prepared;
  const references = Object.entries(prepared.references);
  const result: Record<string, unknown> = {
    revision: live.revision,
    label: prepared.label,
    dryRun: prepared.dryRun,
    created: prepared.created.slice(0, LIST_CAP),
    ...(prepared.created.length > LIST_CAP
      ? { createdCount: prepared.created.length }
      : {}),
    references: Object.fromEntries(references.slice(0, 200)),
    summary: {
      actionCount: summary.actionCount,
      changedClipIds: capped(summary.changedClipIds),
      changedMotionIds: capped(summary.changedMotionIds),
      changedTrackIds: capped(summary.changedTrackIds),
      ...(summary.changedClipIds.length > LIST_CAP
        ? { changedClipCount: summary.changedClipIds.length }
        : {}),
      durationBefore: summary.durationBefore,
      durationAfter: summary.durationAfter,
      warnings: summary.warnings.slice(0, 20),
    },
  };
  if (prepared.dryRun)
    result.note = `Dry run: nothing changed. To apply it, send the same actions with dryRun false and revision ${live.revision}.`;
  if (detail === "full") {
    const source = prepared.dryRun ? prepared.project : live;
    let used = size(result);
    const clips: Clip[] = [],
      motions: Motion[] = [];
    let omitted = 0;
    for (const id of summary.changedClipIds) {
      const clip = source.clips.find((item) => item.id === id);
      if (!clip) continue;
      if (used + size(clip) > budget) {
        omitted++;
        continue;
      }
      clips.push(clip);
      used += size(clip);
    }
    for (const id of summary.changedMotionIds) {
      const motion = source.motions.find((item) => item.id === id);
      if (!motion) continue;
      if (used + size(motion) > budget) {
        omitted++;
        continue;
      }
      motions.push(motion);
      used += size(motion);
    }
    result.clips = clips;
    result.motions = motions;
    if (omitted)
      result.note = [
        result.note,
        `${omitted} changed items did not fit; read them with cutline_inspect detail full and clipIds.`,
      ]
        .filter(Boolean)
        .join(" ");
  }
  return result;
}

/**
 * Rewrites a stale-revision error so the agent can recover in one step: the
 * revision to use, which edits happened since its revision and what they touched.
 */
export function conflictMessage(
  message: string,
  args: { projectId?: unknown; revision?: unknown },
  project: Project,
  history: { label: string; project: Project }[],
) {
  if (!/^Project changed/.test(message)) return message;
  if (typeof args.projectId === "string" && args.projectId !== project.id)
    return `Project changed: a different project is open now ("${project.name}", ID ${project.id}, revision ${project.revision}). Inspect it before editing.`;
  if (typeof args.revision !== "number")
    return `Project changed: the project is at revision ${project.revision}. Inspect it and retry.`;
  const sent = args.revision;
  const parts = [
    `Project changed: you sent revision ${sent}, but the project is now at revision ${project.revision}.`,
  ];
  // Undo steps are checked only when used, so a damaged one is skipped here.
  const at = history.findIndex(
    (entry) =>
      entry?.project?.id === project.id && entry.project.revision === sent,
  );
  if (at >= 0) {
    const labels = history.slice(at).map((entry) => entry.label);
    parts.push(
      `Edits since then: ${labels.slice(-5).join(", ")}${labels.length > 5 ? ` and ${labels.length - 5} more` : ""}.`,
    );
    let touched: string[] = [];
    try {
      const changes = projectChanges(history[at].project, project);
      touched = [
        ...changes.clipIds.map((id) => `clip ${id}`),
        ...changes.motionIds.map((id) => `motion ${id}`),
        ...changes.trackIds.map((id) => `track ${id}`),
        ...changes.assetIds.map((id) => `asset ${id}`),
      ];
    } catch {
      /* An unreadable step: name the edits without what they touched. */
    }
    if (touched.length)
      parts.push(
        `Changed: ${touched.slice(0, 12).join(", ")}${touched.length > 12 ? ` and ${touched.length - 12} more` : ""}.`,
      );
  }
  parts.push(
    `Retry with revision ${project.revision}. Inspect first if those changes touch what you are editing.`,
  );
  return parts.join(" ");
}

type Issue = { path?: PropertyKey[]; message?: string };
const describeIssues = (issues: Issue[]) =>
  issues
    .slice(0, 8)
    .map(
      (issue) =>
        `${issue.path?.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message ?? "invalid"}`,
    )
    .join("; ");
/**
 * Validation errors as one plain line ("actions.0.clipId: Invalid input")
 * instead of a JSON dump, with where to read the expected fields.
 */
export function readableError(error: unknown, args?: { actions?: unknown }) {
  if (error instanceof z.ZodError) {
    // Point at the schema section of the first action that failed.
    const failed = error.issues.find(
      (issue) =>
        issue.path[0] === "actions" && typeof issue.path[1] === "number",
    );
    const type =
      failed && Array.isArray(args?.actions)
        ? (args.actions[failed.path[1] as number] as { type?: unknown })?.type
        : undefined;
    return `Invalid input: ${describeIssues(error.issues)}. ${typeof type === "string" ? `Read cutline_editing_schema with section action:${type} for its fields.` : "Check the tool's input schema."}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  const action = message.match(/^Action (\d+) \(([^)]+)\): (\[[\s\S]*\])$/);
  if (action)
    try {
      return `Action ${action[1]} (${action[2]}): ${describeIssues(JSON.parse(action[3]))}. Read cutline_editing_schema with section action:${action[2]} for its fields.`;
    } catch {
      /* Not a list of validation issues. */
    }
  return message;
}
