import { existsSync } from "node:fs";
import { createReelPlan, ReelOptionsSchema } from "../shared/reel";
import { applyCommands, removePauses } from "../shared/commands";
import { replaceGeneratedCaptions } from "../shared/caption-generation";
import { playsForward } from "../shared/timeline";
import type { Asset, Project, Word } from "../shared/model";
import type { Store } from "./store";
import type { Jobs, Media } from "./media";

/**
 * Long edits (captions, pause removal, the Reel builder) start from the
 * revision the person clicked on, but people keep editing while they run.
 * When the slow part is done, the result is built on the project as it is
 * then, so those edits are kept, and it fails only if the clip or media it
 * needs went away. Transcripts are kept by Media, so a retry is quick.
 */
export type EditJobDeps = {
  store: Store;
  media: Media;
  jobs: Jobs;
  /** Whether the local speech model and whisper are installed. */
  speechReady: () => boolean;
};
function assertRevision(store: Store, args: any) {
  if (
    args.projectId !== store.project.id ||
    args.revision !== store.project.revision
  )
    throw Error("Project changed. Inspect the project and retry.");
}
/** The project the job started on, as it is now. */
function stillOpen(store: Store, projectId: string, what: string) {
  if (store.project.id !== projectId)
    throw Error(
      `Another project was opened while ${what}. Open this project again and retry.`,
    );
  return store.project;
}
/** The clip and its media as they are now, if they are still the same source. */
function sameSource(project: Project, clipId: string, source: Asset) {
  const clip = project.clips.find((c) => c.id === clipId);
  const asset = clip && project.assets.find((a) => a.id === clip.assetId);
  return clip && asset && asset.path === source.path
    ? { clip, asset }
    : undefined;
}

/** Generate captions for a clip from a local transcript. */
export async function generateCaptions(
  { store, media }: EditJobDeps,
  args: any,
) {
  assertRevision(store, args);
  const before = store.project;
  const clip = before.clips.find((c) => c.id === args.clipId);
  if (!clip) throw Error("Select a media clip");
  const asset = before.assets.find((a) => a.id === clip.assetId);
  if (!asset) throw Error("Media is missing");
  if (!playsForward(clip))
    throw Error(
      "This clip plays backwards or holds a frame, so captions can't follow its speech. Turn off Reverse and Freeze frame first.",
    );
  const words = asset.words?.length
    ? asset.words
    : await media.transcribe(asset);
  const now = stillOpen(store, args.projectId, "the captions were being made");
  const current = sameSource(now, clip.id, asset);
  if (!current)
    throw Error(
      "That clip was removed or replaced while the captions were being made. Select it and try again; the transcript is ready, so it will be quick.",
    );
  // Captions follow the clip where it is now, even if it moved meanwhile.
  const { clip: target } = current;
  const selected = words
    .filter(
      (w) =>
        w.end > target.sourceIn &&
        w.start < target.sourceIn + (target.duration / now.fps) * target.speed,
    )
    .map((w) => ({
      ...w,
      start: Math.max(0, (w.start - target.sourceIn) / target.speed),
      end: Math.min(
        target.duration / now.fps,
        (w.end - target.sourceIn) / target.speed,
      ),
    }));
  const { project: next, count } = replaceGeneratedCaptions(
    now,
    target.id,
    selected,
  );
  next.assets.find((a) => a.id === current.asset.id)!.words = words;
  store.commit(next, "Generate subtitles");
  return { captions: count, revision: store.project.revision };
}

/** Cut long pauses out of a clip. */
export async function removeLongPauses(
  { store, media }: EditJobDeps,
  args: any,
) {
  assertRevision(store, args);
  const p = store.project;
  const c = p.clips.find((c) => c.id === args.clipId);
  const a = p.assets.find((a) => a.id === c?.assetId);
  if (!c || !a) throw Error("Select a media clip");
  if (!playsForward(c))
    throw Error(
      "This clip plays backwards or holds a frame, so its pauses can't be found. Turn off Reverse and Freeze frame first.",
    );
  const silences = await media.silences(a);
  const now = stillOpen(store, args.projectId, "pauses were being found");
  // Pauses are in source time, so they still fit a clip that moved meanwhile.
  if (!sameSource(now, c.id, a))
    throw Error(
      "That clip was removed or replaced while pauses were being found. Select it and try again.",
    );
  const commands = removePauses(now, c.id, silences);
  if (commands.length)
    store.transact({
      projectId: now.id,
      revision: now.revision,
      label: "Remove long pauses",
      commands,
    });
  return { removed: commands.length > 0, revision: store.project.revision };
}

/** Build a whole Reel from imported media in one undoable edit. */
export async function buildReel(deps: EditJobDeps, args: any) {
  const { store, media, jobs } = deps;
  assertRevision(store, args);
  const options = ReelOptionsSchema.parse(args.options);
  const start = store.project;
  // Validate all source ranges and the edit before starting expensive transcription.
  const initial = createReelPlan(structuredClone(start), options);
  const plannedAssetIds = new Set(
    initial.commands.flatMap((command) =>
      command.type === "clip.add" && command.clip.assetId
        ? [command.clip.assetId]
        : [],
    ),
  );
  for (const id of plannedAssetIds) {
    const asset = start.assets.find((a) => a.id === id)!;
    if (!existsSync(asset.path))
      throw Error(`Relink ${asset.name} before building your Reel.`);
  }
  if (initial.missingTranscriptAssetIds.length && !deps.speechReady())
    throw Error(
      "Local speech tools are unavailable. Turn off captions and automatic animations, or reinstall the app with speech tools.",
    );
  if (
    jobs.jobs.size &&
    [...jobs.jobs.values()].some(
      (j) => j.kind === "transcribe" && j.state === "running",
    )
  )
    throw Error("Wait for the current transcription to finish.");
  return await jobs.run("reel", "Preparing your Reel…", async (job) => {
    const previousJobs = new Set(jobs.jobs.keys());
    jobs.cancellers.set(job.id, () => {
      for (const child of jobs.jobs.values())
        if (
          !previousJobs.has(child.id) &&
          child.kind === "transcribe" &&
          child.state === "running"
        )
          jobs.cancel(child.id);
    });
    const what = "your Reel was being prepared";
    try {
      const transcripts = new Map<string, { path: string; words: Word[] }>();
      const ids = initial.missingTranscriptAssetIds;
      for (let index = 0; index < ids.length; index++) {
        if (job.state === "cancelled") throw Error("Reel creation cancelled");
        stillOpen(store, args.projectId, what);
        const asset = start.assets.find((a) => a.id === ids[index])!;
        jobs.update(job, {
          message: `Speech timing · ${index + 1} of ${ids.length}: ${asset.name}`,
          progress: (index / Math.max(1, ids.length)) * 0.85,
        });
        transcripts.set(asset.id, {
          path: asset.path,
          words: await media.transcribe(asset),
        });
      }
      if (job.state === "cancelled") throw Error("Reel creation cancelled");
      // Build on the project as it is now, keeping edits made meanwhile. The
      // plan fails if a chosen source was removed.
      const prepared = structuredClone(stillOpen(store, args.projectId, what));
      if (options.mode === "replace" && prepared.revision !== args.revision)
        throw Error(
          "Project changed while the Reel was being prepared. Your edit is safe. Build again to replace the current timeline.",
        );
      for (const asset of prepared.assets) {
        const transcript = transcripts.get(asset.id);
        if (transcript && transcript.path === asset.path)
          asset.words = transcript.words;
      }
      const plan = createReelPlan(prepared, options);
      const next = applyCommands(prepared, {
        projectId: prepared.id,
        revision: prepared.revision,
        label: plan.label,
        commands: plan.commands,
      });
      store.commit(next, plan.label);
      const { commands, ...summary } = plan;
      return summary;
    } finally {
      jobs.cancellers.delete(job.id);
    }
  });
}
