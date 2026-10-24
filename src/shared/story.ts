import {
  makeClip,
  MOTION_LIMIT,
  uid,
  validateProject,
  type Asset,
  type Clip,
  type Project,
  type Track,
} from "./model";
import { buildCaptionClips } from "./caption-grouping";
import {
  StoryPlanSchema,
  STORY_SCENE_LIMIT,
  type StoryPlan,
  type StoryScene,
} from "./story-schema";
import {
  createProductScene,
  productBrand,
  sceneNeedsMedia,
  sceneVisualReady,
} from "./product-scenes";
import { ProductDesignSchema } from "./story-schema";
export {
  StoryPlanSchema,
  StorySceneSchema,
  STORY_SCENE_LIMIT,
} from "./story-schema";
export type { StoryPlan, StoryScene } from "./story-schema";
export {
  createExplainerStory,
  explainerStyles,
  ExplainerInputSchema,
} from "./explainer";
export type { ExplainerInput, ExplainerStyleId } from "./explainer";

export type StoryTemplate = "story" | "explainer" | "promo";

/** Original editable product-film starters; they make no provider calls. */
export function createProductStory(
  style: "launch" | "walkthrough" | "type-led",
  brandName = productBrand.name,
): StoryPlan {
  if (!["launch", "walkthrough", "type-led"].includes(style))
    throw Error("Choose a launch, walkthrough, or type-led product film.");
  const name = brandName.trim().slice(0, 80) || productBrand.name;
  const layouts =
    style === "type-led"
      ? (["title", "quote", "features", "title", "quote", "cta"] as const)
      : style === "walkthrough"
        ? (["title", "screen", "split", "screen", "features", "cta"] as const)
        : (["title", "screen", "split", "features", "quote", "cta"] as const);
  const copy =
    style === "walkthrough"
      ? [
          [
            "Start with the idea.",
            "A CLOSER LOOK",
            "A short tour of the moments that matter.",
          ],
          [
            "Make the first move.",
            "01 / GET STARTED",
            "Add a real screenshot or recording of the starting point.",
          ],
          [
            "Show how it works.",
            "02 / THE DETAILS",
            "Let the product tell this part of the story.",
          ],
          [
            "Bring it together.",
            "03 / THE RESULT",
            "Show the finished result in your own product.",
          ],
          [
            "A clear path forward.",
            "RECAP",
            "One idea. Three moments. A useful next step.",
          ],
          [name, "YOUR NEXT STEP", "Explore what you can make."],
        ]
      : [
          ["Your idea.\nIn motion.", "INTRODUCING", `Meet ${name}.`],
          [
            "Make room for\nthe big idea.",
            "THE MOMENT",
            "Give your audience one thing to remember.",
          ],
          [
            "Show the details\nthat matter.",
            "A CLOSER LOOK",
            "Turn a feature into a clear, visual story.",
          ],
          [
            "From first thought\nto final frame.",
            "BRING IT TOGETHER",
            "Keep the story moving.",
          ],
          [
            "Make something\nworth watching.",
            "THE TAKEAWAY",
            "A clear message. A deliberate finish.",
          ],
          [name, "START SOMETHING", "Your next story starts here."],
        ];
  return StoryPlanSchema.parse({
    brief: `${name} product film. Replace starter copy with your own facts and choose real product screenshots for screen scenes.`,
    style: "Clean product film with purposeful motion and readable typography.",
    brand: { ...productBrand, name },
    captions: true,
    scenes: layouts.map((layout, index) => ({
      id: uid(),
      title: [
        "Opening",
        "The idea",
        "The details",
        "Bring it together",
        "Takeaway",
        "Closing",
      ][index],
      duration: [3, 5, 5, 4, 4, 3][index],
      narration: "",
      visualPrompt:
        layout === "screen" || layout === "split"
          ? "Choose a real product screenshot or screen recording. The native frame keeps it editable and the interface accurate."
          : "",
      design: ProductDesignSchema.parse({
        layout,
        headline: copy[index][0],
        eyebrow: copy[index][1],
        body: copy[index][2],
        points:
          layout === "features"
            ? ["Shape the idea", "Show the details", "Make the next step clear"]
            : [],
        motion: style === "type-led" ? "snappy" : "smooth",
      }),
    })),
  });
}

/** A lossless identity for the speech request, used to detect stale narration. */
export function storyNarrationSignature(
  scene: Pick<StoryScene, "narration">,
  plan: Pick<StoryPlan, "voice" | "speed">,
): string {
  return `story-voice-v1:${JSON.stringify([scene.narration.trim(), plan.voice, plan.speed])}`;
}

/** Organizes the user's paragraphs; it does not generate or rewrite their script. */
export function createStoryFromScript(
  script: string,
  template: StoryTemplate = "story",
): StoryPlan {
  const text = script.trim();
  if (!text) return StoryPlanSchema.parse({});
  if (text.length > 60000)
    throw Error("Keep the total story script under 60,000 characters.");
  const parts = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > STORY_SCENE_LIMIT)
    throw Error(
      `Use at most ${STORY_SCENE_LIMIT} paragraphs. Combine a few before building the story.`,
    );
  if (parts.some((part) => part.length > 5000))
    throw Error(
      "Keep each scene under 5,000 characters. Separate longer passages with a blank line.",
    );
  const names =
    template === "promo"
      ? ["Hook", "Benefit", "Call to action"]
      : template === "explainer"
        ? ["Question", "Explanation", "Takeaway"]
        : ["Hook", "Story", "Resolution"];
  return StoryPlanSchema.parse({
    brief: text.slice(0, 12000),
    scenes: parts.map((narration, index) => ({
      id: uid(),
      title:
        parts.length === 1
          ? names[1]
          : index === 0
            ? names[0]
            : index === parts.length - 1
              ? names[2]
              : `${names[1]} ${index}`,
      narration,
      // A visual prompt is an editable starting point. Keep the entire script
      // in narration even when it is longer than the visual prompt budget.
      visualPrompt: narration.slice(0, 4000),
      // Estimated reading time is only planning metadata; actual audio decides
      // the final scene length when the timeline is built.
      duration: Math.min(
        120,
        Math.max(3, Math.ceil(narration.split(/\s+/).length / 2.5)),
      ),
    })),
  });
}

export type StoryTimelineResult = {
  project: Project;
  startFrame: number;
  durationFrames: number;
  sceneCount: number;
  captionCount: number;
  warnings: string[];
};

export function buildStoryTimeline(
  project: Project,
  { mode }: { mode: "append" | "rebuild" },
): StoryTimelineResult {
  if (mode !== "append" && mode !== "rebuild")
    throw Error("Choose append or rebuild for the story timeline.");
  if (!project.story) throw Error("Create a story first.");
  const plan = StoryPlanSchema.parse(project.story);
  if (!plan.scenes.length) throw Error("Add at least one scene to your story.");
  const warnings: string[] = [];
  const prepared = plan.scenes.map((scene, index) => {
    const name = `Scene ${index + 1} (${scene.title || "Untitled"})`;
    const visual = project.assets.find((asset) => asset.id === scene.assetId);
    if (!sceneVisualReady(scene, project))
      throw Error(
        `${name}: choose a video or image before building the timeline.`,
      );
    let voice: Asset | undefined;
    if (scene.narration.trim()) {
      voice = project.assets.find((asset) => asset.id === scene.voiceAssetId);
      if (!voice || voice.kind !== "audio" || voice.duration <= 0)
        throw Error(
          `${name}: generate its voiceover, or clear the narration to make a silent scene.`,
        );
      if (scene.voiceSignature !== storyNarrationSignature(scene, plan))
        throw Error(
          `${name}: narration or voice settings changed. Regenerate its voiceover before building.`,
        );
    }
    const frames = Math.max(
      1,
      Math.ceil(Math.max(scene.duration, voice?.duration ?? 0) * project.fps),
    );
    if (voice && voice.duration > scene.duration + 1 / project.fps)
      warnings.push(`${name} was extended to fit its voiceover.`);
    return { scene, name, visual, voice, frames };
  });
  const music = plan.musicAssetId
    ? project.assets.find((asset) => asset.id === plan.musicAssetId)
    : undefined;
  if (
    plan.musicAssetId &&
    (!music || music.kind !== "audio" || music.duration <= 0)
  )
    throw Error(
      "Choose an available audio asset for the music bed, or remove the music selection.",
    );
  // Work on a copy, including nested words and keyframes. A failed build cannot
  // partially replace the editor's open project or mutate its undo history.
  const next = structuredClone(project);
  const previous = mode === "rebuild" ? plan.assembly : undefined;
  const previousIds = new Set(previous?.clipIds ?? []);
  next.clips = next.clips.filter((clip) => !previousIds.has(clip.id));
  const previousMotions = new Set(previous?.motionIds ?? []);
  next.motions = next.motions.filter(
    (motion) =>
      !previousMotions.has(motion.id) ||
      next.clips.some((clip) => clip.motionId === motion.id),
  );
  const designedCount = prepared.filter(({ scene }) => scene.design).length;
  if (next.motions.length + designedCount > MOTION_LIMIT)
    throw Error(
      `This story needs ${designedCount} motion designs, but the project can hold at most ${MOTION_LIMIT}. Remove unused graphics or use a shorter story.`,
    );
  const previousTracks = new Set(previous?.trackIds ?? []);
  next.tracks = next.tracks.filter(
    (track) =>
      !previousTracks.has(track.id) ||
      next.clips.some((clip) => clip.trackId === track.id),
  );
  const startFrame =
    previous?.startFrame ??
    Math.max(0, ...next.clips.map((clip) => clip.start + clip.duration));
  const durationFrames = prepared.reduce((sum, scene) => sum + scene.frames, 0);
  if (startFrame + durationFrames > 864000)
    throw Error(
      "This story would exceed the timeline's frame limit. Shorten it or create a new project.",
    );
  if (
    previous &&
    next.clips.some(
      (clip) =>
        clip.start < startFrame + durationFrames &&
        clip.start + clip.duration > startFrame,
    )
  )
    warnings.push(
      "The rebuilt story overlaps other timeline clips. Those clips were kept; review their layers and audio.",
    );
  const newTracks: Track[] = [];
  const addTrack = (name: string, kind: Track["kind"]) => {
    const track = { id: uid(), name, kind, muted: false, hidden: false };
    newTracks.push(track);
    return track.id;
  };
  const captionTrack =
    plan.captions && prepared.some(({ voice }) => voice?.words?.length)
      ? addTrack("Story captions", "text")
      : undefined;
  const videoTrack = addTrack("Story visuals", "video");
  const graphicsTrack = designedCount
    ? addTrack("Story product graphics", "text")
    : undefined;
  const voiceTrack = prepared.some(({ voice }) => voice)
    ? addTrack("Story voiceover", "audio")
    : undefined;
  const musicTrack = music ? addTrack("Story music", "audio") : undefined;
  if (next.tracks.length + newTracks.length > 64)
    throw Error(
      "This story needs more timeline tracks than the project can hold. Remove unused tracks first.",
    );
  // Earlier tracks draw above later ones, in preview and export. Story
  // captions go on top like any new text track. The visuals, with the product
  // graphics drawn under them, go above the project's own video but below its
  // Titles and Captions, so a title added later still shows. Audio goes last.
  const media = newTracks.filter(
    (track) => track.id === videoTrack || track.id === graphicsTrack,
  );
  const firstMedia = next.tracks.findIndex((track) => track.kind !== "text");
  next.tracks.splice(
    firstMedia < 0 ? next.tracks.length : firstMedia,
    0,
    ...media,
  );
  next.tracks.unshift(...newTracks.filter((track) => track.id === captionTrack));
  next.tracks.push(...newTracks.filter((track) => track.kind === "audio"));
  const clips: Clip[] = [];
  const motionIds: string[] = [];
  const push = (...items: Clip[]) => {
    if (next.clips.length + clips.length + items.length > 10000)
      throw Error(
        "This story would exceed 10,000 clips. Choose longer source videos or shorten the story.",
      );
    clips.push(...items);
  };
  const loopMedia = (
    asset: Asset,
    trackId: string,
    start: number,
    frames: number,
    volume: number,
  ) => {
    const length =
      asset.kind === "image"
        ? frames
        : Math.max(1, Math.floor(asset.duration * project.fps));
    if (next.clips.length + clips.length + Math.ceil(frames / length) > 10000)
      throw Error(
        "This story would exceed 10,000 clips. Choose longer source media or shorten the story.",
      );
    for (let offset = 0; offset < frames; offset += length)
      push({
        ...makeClip(next, asset.kind, trackId, start + offset, asset),
        duration: Math.min(length, frames - offset),
        volume,
      });
    return frames > length;
  };
  let cursor = startFrame;
  let captionCount = 0;
  for (const { scene, name, visual, voice, frames } of prepared) {
    if (scene.design && graphicsTrack) {
      const created = createProductScene(next, {
        scene,
        brand: plan.brand,
        start: cursor,
        frames,
        graphicsTrackId: graphicsTrack,
        mediaTrackId: videoTrack,
        visual: sceneNeedsMedia(scene) ? visual : undefined,
      });
      next.motions.push(created.motion);
      motionIds.push(created.motion.id);
      push(...created.clips);
      warnings.push(...created.warnings);
    } else if (loopMedia(visual!, videoTrack, cursor, frames, 0))
      warnings.push(`${name}: the shorter visual loops to fill the scene.`);
    if (voice && voiceTrack) {
      const clip = {
        ...makeClip(next, "audio", voiceTrack, cursor, voice),
        duration: Math.max(1, Math.ceil(voice.duration * project.fps)),
      };
      push(clip);
      if (plan.captions) {
        const words =
          voice.words?.filter(
            (word) =>
              word.text.trim() &&
              word.end > word.start &&
              word.start >= 0 &&
              word.start < voice.duration &&
              word.end <= voice.duration + 1 / project.fps,
          ) ?? [];
        if (words.length && captionTrack) {
          const captions = buildCaptionClips(next, words, {
            trackId: captionTrack,
            startFrame: cursor,
            maxDurationFrames: clip.duration,
            style: plan.captionStyle,
            sourceId: clip.id,
          });
          push(...captions);
          captionCount += captions.length;
        } else
          warnings.push(
            `${name}: captions need word timing. Transcribe its voiceover, then rebuild.`,
          );
      }
    }
    cursor += frames;
  }
  if (music && musicTrack) {
    const first = clips.length;
    if (loopMedia(music, musicTrack, startFrame, durationFrames, 0.12))
      warnings.push("The music bed loops to fill the story.");
    const musicClips = clips.slice(first);
    musicClips[0].fadeIn = Math.min(
      Math.round(project.fps * 0.25),
      musicClips[0].duration,
    );
    musicClips.at(-1)!.fadeOut = Math.min(
      Math.round(project.fps * 0.5),
      musicClips.at(-1)!.duration,
    );
  }
  next.clips.push(...clips);
  next.story = {
    ...plan,
    assembly: {
      clipIds: clips.map((clip) => clip.id),
      trackIds: newTracks.map((track) => track.id),
      ...(motionIds.length ? { motionIds } : {}),
      startFrame,
    },
  };
  return {
    project: validateProject(next),
    startFrame,
    durationFrames,
    sceneCount: prepared.length,
    captionCount,
    warnings,
  };
}
