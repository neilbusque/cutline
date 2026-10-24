import { existsSync } from "node:fs";
import { z } from "zod";
import { uid } from "../shared/model";
import {
  mergedStoryReferenceIds,
  STORY_REFERENCE_LIMIT,
  StoryPlanSchema,
} from "../shared/story-schema";
import { buildStoryTimeline } from "../shared/story";
import { sceneNeedsMedia } from "../shared/product-scenes";
import type { Store } from "./store";
import type { GenerationLibrary } from "./generation";

const guarded = z.object({ projectId: z.string(), revision: z.number().int() });
const sceneArgs = guarded.extend({ sceneId: z.string() });

/** Scene operations share the editor's revision and durable provider ledger. */
export class StoryControl {
  private active = new Set<string>();
  constructor(
    private deps: {
      store: Store;
      generation: Pick<
        GenerationLibrary,
        "list" | "submit" | "refresh" | "importAsset" | "pickReference"
      >;
      configured: () => Promise<boolean>;
    },
  ) {}

  private current(projectId: string, revision?: number) {
    const p = this.deps.store.project;
    if (
      p.id !== projectId ||
      (revision !== undefined && p.revision !== revision)
    )
      throw Error(
        "Project changed. Your draft is kept; reload the saved storyline before trying again.",
      );
    return p;
  }

  inspect() {
    const p = this.deps.store.project;
    return { projectId: p.id, revision: p.revision, story: p.story ?? null };
  }

  save(value: unknown) {
    const args = guarded.extend({ story: StoryPlanSchema }).parse(value);
    const p = this.current(args.projectId, args.revision);
    // Assembly ownership belongs to the editor, never to caller-supplied IDs.
    const story = {
      ...args.story,
      assembly: p.story?.assembly,
      scenes: args.story.scenes.map((scene) => {
        const before = p.story?.scenes.find((s) => s.id === scene.id);
        return before &&
          scene.assetId !== before.assetId &&
          scene.assetId !== before.generationId
          ? { ...scene, generationId: undefined }
          : scene;
      }),
    };
    this.deps.store.commit({ ...p, story }, "Save storyline");
    return {
      story: this.deps.store.project.story,
      revision: this.deps.store.project.revision,
    };
  }

  async generate(value: unknown) {
    const args = sceneArgs.parse(value);
    let p = this.current(args.projectId, args.revision);
    const session = this.deps.store.openSession;
    const scene = p.story?.scenes.find((s) => s.id === args.sceneId);
    if (!scene || !p.story)
      throw Error("Save this scene before generating its shot.");
    if (!sceneNeedsMedia(scene))
      throw Error(
        "This scene uses editable graphics. Build the story to create them locally, or choose a media layout to generate a shot.",
      );
    if (!scene.visualPrompt.trim())
      throw Error("Write a shot prompt for this scene first.");
    const lock = `${session}:${scene.id}`;
    if (this.active.has(lock))
      throw Error("This scene already has an operation running.");
    this.active.add(lock);
    try {
      if (!(await this.deps.configured()))
        throw Error("Connect Higgsfield in Settings first.");
      if (this.deps.store.openSession !== session)
        throw Error("Project changed. No new request was submitted.");
      p = this.current(args.projectId, args.revision);
      const prior = scene.generationId
        ? this.deps.generation.list().find((j) => j.id === scene.generationId)
        : undefined;
      if (
        prior &&
        ["submitting", "queued", "in_progress", "unknown"].includes(
          prior.status,
        )
      )
        return { generation: prior, revision: p.revision };
      const prompt = [p.story!.style.trim(), scene.visualPrompt.trim()]
        .filter(Boolean)
        .join("\n\n");
      if (prompt.length > 5000)
        throw Error(
          "Keep the visual direction and shot prompt under 5,000 characters together.",
        );
      const referenceAssetIds = mergedStoryReferenceIds(p.story!, scene);
      if (referenceAssetIds.length > STORY_REFERENCE_LIMIT)
        throw Error(
          "Use at most 9 shared and scene reference images together.",
        );
      const references = referenceAssetIds.map((assetId) => {
        const asset = p.assets.find((a) => a.id === assetId);
        if (!asset || asset.kind !== "image")
          throw Error("Choose an available image for every story reference.");
        if (!existsSync(asset.path))
          throw Error(`Relink the missing reference image: ${asset.name}.`);
        return asset;
      });
      const selectedReferences = await Promise.all(
        references.map((asset) =>
          this.deps.generation.pickReference(asset.path),
        ),
      );
      if (this.deps.store.openSession !== session)
        throw Error("Project changed. No new request was submitted.");
      p = this.current(args.projectId, args.revision);
      if (
        new Set(selectedReferences.map((reference) => reference.id)).size !==
        selectedReferences.length
      )
        throw Error(
          "The same image was selected more than once. Remove the duplicate from shared or scene references before generating.",
        );
      const id = uid();
      // Persist scene linkage before the paid request, just as the generation
      // library saves its idempotency key before contacting the provider.
      this.deps.store.commit(
        {
          ...p,
          story: {
            ...p.story!,
            scenes: p.story!.scenes.map((s) =>
              s.id === scene.id ? { ...s, generationId: id } : s,
            ),
          },
        },
        "Generate story shot",
      );
      const generation = await this.deps.generation.submit({
        clientId: id,
        projectId: p.id,
        prompt,
        model: "seedance-2",
        duration: Math.max(4, Math.min(15, Math.ceil(scene.duration))),
        aspectRatio:
          p.width === p.height ? "1:1" : p.width > p.height ? "16:9" : "9:16",
        resolution: "720p",
        audio: false,
        ...(selectedReferences.length
          ? {
              referenceIds: selectedReferences.map((reference) => reference.id),
            }
          : {}),
      });
      return { generation, revision: this.deps.store.project.revision };
    } finally {
      this.active.delete(lock);
    }
  }

  async refresh(value: unknown) {
    const args = z
      .object({ projectId: z.string(), sceneId: z.string() })
      .parse(value);
    const p = this.current(args.projectId);
    const session = this.deps.store.openSession;
    const scene = p.story?.scenes.find((s) => s.id === args.sceneId);
    if (!scene?.generationId)
      throw Error("This scene has no generated shot yet.");
    const generation = await this.deps.generation.refresh(scene.generationId);
    const check = () => {
      if (this.deps.store.openSession !== session)
        throw Error("Project changed. The shot remains in Generate.");
      const latest = this.current(args.projectId);
      const current = latest.story?.scenes.find((s) => s.id === args.sceneId);
      if (!current || current.generationId !== scene.generationId)
        throw Error("Scene changed. The shot remains in Generate.");
      return { latest, current };
    };
    check();
    if (!generation.downloaded)
      return {
        generation,
        revision: this.deps.store.project.revision,
        warnings: [],
      };
    const asset =
      this.deps.store.project.assets.find((a) => a.id === generation.id) ??
      (await this.deps.generation.importAsset(generation.id));
    const { latest, current } = check();
    // Never overwrite a visual the person chose while the request was running.
    if (
      current.assetId &&
      current.assetId !== scene.assetId &&
      current.assetId !== asset.id
    )
      return {
        generation,
        revision: latest.revision,
        warnings: [
          "The scene's media changed during import. Choose the finished shot from Generate.",
        ],
      };
    if (
      current.assetId !== asset.id ||
      !latest.assets.some((a) => a.id === asset.id)
    ) {
      this.deps.store.commit(
        {
          ...latest,
          assets: latest.assets.some((a) => a.id === asset.id)
            ? latest.assets
            : [...latest.assets, asset],
          story: {
            ...latest.story!,
            scenes: latest.story!.scenes.map((s) =>
              s.id === scene.id ? { ...s, assetId: asset.id } : s,
            ),
          },
        },
        "Use generated story shot",
      );
    }
    return {
      generation,
      asset,
      revision: this.deps.store.project.revision,
      warnings: [],
    };
  }

  assemble(value: unknown) {
    const args = guarded
      .extend({ mode: z.enum(["append", "rebuild"]) })
      .parse(value);
    const p = this.current(args.projectId, args.revision);
    const used = new Set(
      p.story?.scenes.flatMap((s) => [
        ...(sceneNeedsMedia(s) ? [s.assetId] : []),
        ...(s.narration.trim() ? [s.voiceAssetId] : []),
      ]) ?? [],
    );
    if (p.story?.musicAssetId) used.add(p.story.musicAssetId);
    if (p.assets.some((a) => used.has(a.id) && !existsSync(a.path)))
      throw Error("Relink missing story media before assembling.");
    const { project, ...result } = buildStoryTimeline(p, { mode: args.mode });
    this.deps.store.commit(
      project,
      args.mode === "rebuild"
        ? "Rebuild story sequence"
        : "Assemble story sequence",
    );
    return { ...result, revision: this.deps.store.project.revision };
  }
}
