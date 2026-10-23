import { existsSync } from "node:fs";
import { z } from "zod";
import { WordSchema, type Asset, type Job, type Word } from "../shared/model";
import { storyNarrationSignature } from "../shared/story";
import { SpeechInputSchema } from "../shared/tts";
import type { Jobs, Media } from "./media";
import type { Speech } from "./tts";
import type { Store } from "./store";

const VoiceRequestSchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().min(0),
  sceneId: z.string().min(1),
});

export type StoryProductionDependencies = {
  store: Pick<Store, "project" | "commit" | "openSession">;
  speech: Pick<Speech, "status" | "generate">;
  media: Pick<Media, "import" | "transcribe">;
  jobs: Jobs;
};
export type StoryVoiceResult = {
  asset: Asset;
  sceneId: string;
  revision: number;
  warnings: string[];
  /** An unchanged voiceover was reused, optionally retrying its transcript. */
  reused: boolean;
};

const normalized = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function closeSpelling(left: string, right: string) {
  if (Math.abs(left.length - right.length) > 2) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++)
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[right.length] <= 2;
}
/** Correct small recognition slips only when tokens map one-to-one. Timing
 * always comes from the actual recording, never estimated script durations. */
function authoredCaptionWords(text: string, words: Word[]) {
  const script = text.trim().split(/\s+/);
  const spoken = words.map((word) => normalized(word.text));
  const written = script.map(normalized);
  const matches = written.filter(
    (word, index) => word === spoken[index],
  ).length;
  const safe =
    script.length === words.length &&
    matches / script.length >= 0.8 &&
    written.every((word, index) => closeSpelling(word, spoken[index]));
  return {
    words: safe
      ? words.map((word, index) => ({ ...word, text: script[index] }))
      : words,
    needsReview: !safe,
  };
}

/** Local narration and measured word timing for the story being edited. */
export class StoryProduction {
  private busy = false;
  constructor(private readonly deps: StoryProductionDependencies) {}

  async voice(raw: unknown): Promise<StoryVoiceResult> {
    const args = VoiceRequestSchema.parse(raw);
    const { store, speech, media, jobs } = this.deps;
    if (
      store.project.id !== args.projectId ||
      store.project.revision !== args.revision
    )
      throw Error("Project changed. Inspect the project and retry.");
    if (this.busy)
      throw Error(
        "A story voiceover is already running. Wait or cancel it first.",
      );
    const plan = store.project.story;
    const scene = plan?.scenes.find((item) => item.id === args.sceneId);
    if (!plan || !scene)
      throw Error("That story scene is no longer available.");
    const input = SpeechInputSchema.parse({
      text: scene.narration,
      voice: plan.voice,
      speed: plan.speed,
      name: `${scene.title || "Scene"} narration`.slice(0, 100),
    });
    const signature = storyNarrationSignature(scene, plan);
    const session = store.openSession;
    const previousAssetId = scene.voiceAssetId;
    const previousSignature = scene.voiceSignature;
    const candidate = store.project.assets.find(
      (asset) => asset.id === previousAssetId,
    );
    const reusable =
      candidate &&
      previousSignature === signature &&
      candidate.kind === "audio" &&
      candidate.hasAudio &&
      candidate.duration > 0 &&
      existsSync(candidate.path)
        ? candidate
        : undefined;
    if (
      reusable?.words?.some(
        (word) =>
          word.text.trim() &&
          word.start >= 0 &&
          word.end > word.start &&
          word.end <= reusable.duration &&
          word.start < reusable.duration,
      )
    )
      return {
        asset: structuredClone(reusable),
        sceneId: scene.id,
        revision: store.project.revision,
        warnings: [],
        reused: true,
      };
    if (!reusable && store.project.assets.length >= 1000)
      throw Error(
        "The media library is full. Remove unused media before creating narration.",
      );

    const checkOpen = (job: Job) => {
      if (job.state === "cancelled") throw Error("Story narration cancelled.");
      if (store.openSession !== session || store.project.id !== args.projectId)
        throw Error(
          "Another project was opened while creating narration. Finished audio remains in Cutline's local speech folder; no project was changed.",
        );
    };
    const unchangedScene = () => {
      const currentPlan = store.project.story;
      const current = currentPlan?.scenes.find((item) => item.id === scene.id);
      return currentPlan &&
        current &&
        storyNarrationSignature(current, currentPlan) === signature &&
        current.voiceAssetId === previousAssetId &&
        current.voiceSignature === previousSignature
        ? current
        : undefined;
    };

    this.busy = true;
    try {
      return await jobs.run(
        "story-voice",
        reusable ? "Aligning narration captions" : `Creating ${input.name}`,
        async (job) => {
          let asset: Asset;
          if (reusable) asset = structuredClone(reusable);
          else {
            const status = await speech.status();
            checkOpen(job);
            if (!unchangedScene())
              throw Error(
                "The scene or voice settings changed. Try creating narration again.",
              );
            if (!status.ready)
              throw Error(
                "Download the Kokoro voice engine in Story or Audio before creating narration.",
              );
            const generated = await speech.generate(input);
            checkOpen(job);
            asset = await media.import(generated.path);
            checkOpen(job);
            if (
              asset.kind !== "audio" ||
              !asset.hasAudio ||
              asset.duration <= 0
            )
              throw Error(
                "The generated narration did not contain playable audio.",
              );
            asset.name = input.name!;
          }
          const warnings: string[] = [];
          jobs.update(job, {
            message: "Aligning captions to the recorded voice",
            progress: 0.75,
          });
          try {
            const words = z
              .array(WordSchema)
              .parse(await media.transcribe(asset));
            checkOpen(job);
            // Keep actual speech timings. Out-of-range recognition artifacts
            // must not extend captions beyond this audio file.
            asset.words = words
              .filter(
                (word) =>
                  word.text.trim() &&
                  word.end > word.start &&
                  word.start < asset.duration,
              )
              .map((word) => ({
                ...word,
                end: Math.min(word.end, asset.duration),
              }));
            if (!asset.words.length)
              throw Error("No spoken words were found in the audio.");
            const corrected = authoredCaptionWords(input.text, asset.words);
            asset.words = corrected.words;
            if (corrected.needsReview)
              warnings.push("Review auto captions against your script.");
          } catch (error) {
            // Cancellation and project switches are not caption failures and
            // must never commit into the new editing session.
            checkOpen(job);
            delete asset.words;
            const reason = (
              error instanceof Error ? error.message : String(error)
            )
              .replace(/\s+/g, " ")
              .slice(0, 240);
            warnings.push(
              `Voiceover is ready, but captions are not: ${reason} Retry this voiceover to align captions without regenerating the audio, or use Captions after building the timeline.`,
            );
          }
          checkOpen(job);
          const now = store.project;
          if (reusable) {
            const currentAsset = now.assets.find(
              (item) => item.id === asset.id,
            );
            if (!currentAsset || currentAsset.path !== reusable.path)
              throw Error(
                "That narration was removed or relinked while captions were being aligned. Your media edits were kept.",
              );
            // Preserve renaming or other asset edits made during transcription.
            const { words: previousWords, ...currentWithoutWords } =
              currentAsset;
            asset = {
              ...currentWithoutWords,
              ...(asset.words ? { words: asset.words } : {}),
            };
          } else if (now.assets.length >= 1000) {
            throw Error(
              "The media library filled up while creating narration. The audio remains in Cutline's local speech folder.",
            );
          }
          const target = unchangedScene();
          if (!target)
            warnings.push(
              "The scene, script, or voice settings changed while narration was being made. The finished audio is in Media; the scene's voiceover was not replaced.",
            );
          const next = {
            ...now,
            assets: reusable
              ? now.assets.map((item) => (item.id === asset.id ? asset : item))
              : [...now.assets, asset],
            ...(target && now.story
              ? {
                  story: {
                    ...now.story,
                    scenes: now.story.scenes.map((item) =>
                      item.id === scene.id
                        ? {
                            ...item,
                            voiceAssetId: asset.id,
                            voiceSignature: signature,
                          }
                        : item,
                    ),
                  },
                }
              : {}),
          };
          store.commit(
            next,
            reusable ? "Align story captions" : "Create story voiceover",
          );
          return {
            asset,
            sceneId: scene.id,
            revision: store.project.revision,
            warnings,
            reused: !!reusable,
          };
        },
      );
    } finally {
      this.busy = false;
    }
  }
}
