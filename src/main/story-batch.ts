import { existsSync } from "node:fs";
import { z } from "zod";
import type { Project } from "../shared/model";
import { sceneNeedsMedia, sceneVisualReady } from "../shared/product-scenes";
import { StoryPlanSchema, type StoryPlan } from "../shared/story-schema";
import { storyNarrationSignature } from "../shared/story";
import type { Store } from "./store";
import type { Jobs } from "./media";
import type { StoryControl } from "./story-control";
import type { StoryProduction } from "./story-production";

export const StoryProduceSchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().min(0),
  mode: z.enum(["append", "rebuild"]).optional(),
});

// Voice attachments are the only plan fields this operation is allowed to
// change between scenes. Any authored edit stops automatic assembly.
function planSignature(plan: StoryPlan) {
  return JSON.stringify({
    ...plan,
    scenes: plan.scenes.map(
      ({ voiceAssetId, voiceSignature, ...scene }) => scene,
    ),
  });
}

function ownedTimeline(project: Project, plan: StoryPlan) {
  const clips = new Set(plan.assembly?.clipIds ?? []);
  const tracks = new Set(plan.assembly?.trackIds ?? []);
  const motions = new Set(plan.assembly?.motionIds ?? []);
  return JSON.stringify({
    width: project.width,
    height: project.height,
    fps: project.fps,
    clips: project.clips.filter((clip) => clips.has(clip.id)),
    tracks: project.tracks.filter((track) => tracks.has(track.id)),
    motions: project.motions.filter((motion) => motions.has(motion.id)),
  });
}

/** One local, cancellable workflow. Finished narration remains reusable if the
 * user cancels or changes their plan; unrelated timeline work is never rolled back. */
export class StoryBatchProduction {
  private busy = false;

  constructor(
    private readonly deps: {
      store: Pick<Store, "project" | "openSession">;
      production: Pick<StoryProduction, "voice">;
      control: Pick<StoryControl, "assemble">;
      jobs: Jobs;
    },
  ) {}

  async produce(raw: unknown) {
    const args = StoryProduceSchema.parse(raw);
    const { store, production, control, jobs } = this.deps;
    const initial = store.project;
    if (initial.id !== args.projectId || initial.revision !== args.revision)
      throw Error("Project changed. Save your latest storyline and try again.");
    if (this.busy)
      throw Error(
        "A story is already being produced. Wait or cancel it first.",
      );
    if (!initial.story?.scenes.length)
      throw Error("Create and save an outline first.");
    const plan = StoryPlanSchema.parse(initial.story);
    // Reject unavailable visual evidence before spending time on narration.
    for (const [index, scene] of plan.scenes.entries()) {
      if (!sceneVisualReady(scene, initial))
        throw Error(
          `Scene ${index + 1} (${scene.title}): choose a real screenshot or video first.`,
        );
      if (sceneNeedsMedia(scene)) {
        const asset = initial.assets.find((item) => item.id === scene.assetId)!;
        if (!existsSync(asset.path))
          throw Error(`Relink the missing visual for ${scene.title}.`);
      }
    }
    if (plan.musicAssetId) {
      const music = initial.assets.find(
        (asset) => asset.id === plan.musicAssetId,
      );
      if (
        !music ||
        music.kind !== "audio" ||
        music.duration <= 0 ||
        !existsSync(music.path)
      )
        throw Error(
          "Choose an available music file, or remove the music selection.",
        );
    }
    const signature = planSignature(plan);
    const timeline = ownedTimeline(initial, plan);
    const session = store.openSession;
    const mode = args.mode ?? (plan.assembly ? "rebuild" : "append");
    const spoken = plan.scenes.filter((scene) => scene.narration.trim());
    this.busy = true;
    try {
      return await jobs.run(
        "story-produce",
        "Preparing your explainer",
        async (job) => {
          const check = () => {
            if (job.state === "cancelled")
              throw Error(
                "Story production cancelled. Finished narration is kept.",
              );
            const current = store.project;
            if (current.id !== args.projectId || store.openSession !== session)
              throw Error("Another project was opened. No timeline was built.");
            if (!current.story || planSignature(current.story) !== signature)
              throw Error(
                "The storyline changed. Finished narration is kept; save your edits and try again.",
              );
            if (ownedTimeline(current, plan) !== timeline)
              throw Error(
                "The canvas or previous story sequence changed. Your edits were kept; try again when ready.",
              );
            return current;
          };
          let voicesCreated = 0;
          let voicesReused = 0;
          const warnings: string[] = [];
          for (const [index, scene] of spoken.entries()) {
            const current = check();
            jobs.update(job, {
              message: `Narration ${index + 1} of ${spoken.length}: ${scene.title}`,
              progress: (index / Math.max(1, spoken.length)) * 0.9,
            });
            check();
            const result = await production.voice({
              projectId: current.id,
              revision: current.revision,
              sceneId: scene.id,
            });
            const latest = check();
            const attached = latest.story!.scenes.find(
              (item) => item.id === scene.id,
            )!;
            if (
              attached.voiceAssetId !== result.asset.id ||
              attached.voiceSignature !==
                storyNarrationSignature(attached, latest.story!)
            )
              throw Error(
                "Narration changed during production. Finished audio is kept; try again.",
              );
            if (result.reused) voicesReused += 1;
            else voicesCreated += 1;
            warnings.push(
              ...result.warnings.map((warning) => `${scene.title}: ${warning}`),
            );
            if (
              plan.captions &&
              !result.asset.words?.some(
                (word) =>
                  word.text.trim() &&
                  word.end > word.start &&
                  word.start >= 0 &&
                  word.start < result.asset.duration &&
                  word.end <= result.asset.duration + 1 / latest.fps,
              )
            )
              throw Error(
                `Narration for ${scene.title} is saved, but captions could not be aligned. Retry Create explainer to reuse the audio and align it, or turn captions off. No timeline was built.`,
              );
          }
          const current = check();
          jobs.update(job, {
            message: "Building editable scenes",
            progress: 0.95,
          });
          check();
          // This synchronous commit happens only after all async work and guards.
          const assembled = control.assemble({
            projectId: current.id,
            revision: current.revision,
            mode,
          });
          return {
            ...assembled,
            story: structuredClone(store.project.story!),
            voicesCreated,
            voicesReused,
            warnings: [...warnings, ...assembled.warnings],
          };
        },
      );
    } finally {
      this.busy = false;
    }
  }
}
