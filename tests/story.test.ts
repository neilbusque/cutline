import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssetSchema,
  makeClip,
  newProject,
  validateProject,
  type Project,
} from "../src/shared/model";
import {
  buildStoryTimeline,
  createStoryFromScript,
  StoryPlanSchema,
  storyNarrationSignature,
} from "../src/shared/story";
import { Store } from "../src/main/store";
import { ProjectLibrary } from "../src/main/projects";
import { hasUnsavedWork } from "../src/renderer/edit-gestures";
import { mergedStoryReferenceIds } from "../src/shared/story-schema";

const folders: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.flush();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function storeSetup() {
  const folder = mkdtempSync(path.join(os.tmpdir(), "cutline-story-"));
  folders.push(folder);
  const store = new Store(path.join(folder, "data", "recovery.cutline"));
  stores.push(store);
  return { folder, store };
}
function preparedStory(): Project {
  const project = newProject();
  project.story = createStoryFromScript("A ninja crosses the stream.");
  project.story.scenes[0].duration = 3;
  const visual = AssetSchema.parse({
    id: "ninja-video",
    name: "Ninja",
    kind: "video",
    path: "/ninja.mp4",
    duration: 1.1,
  });
  const voice = AssetSchema.parse({
    id: "voice-a",
    name: "Narration",
    kind: "audio",
    path: "/voice.wav",
    duration: 4.27,
    words: [
      { text: "A", start: 0.14, end: 0.3 },
      { text: "ninja", start: 0.32, end: 0.9 },
      { text: "crosses", start: 1.14, end: 1.8 },
      { text: "the", start: 1.83, end: 2 },
      { text: "stream.", start: 2.1, end: 2.8 },
    ],
  });
  project.assets.push(visual, voice);
  Object.assign(project.story.scenes[0], {
    assetId: visual.id,
    voiceAssetId: voice.id,
    voiceSignature: storyNarrationSignature(
      project.story.scenes[0],
      project.story,
    ),
  });
  return project;
}

describe("Story planning and persistence", () => {
  it("splits authored paragraphs without dropping punctuation or rewriting the narration", () => {
    const parts = [
      "...Wait! Is that a ninja?",
      'Dr. Lee says: "Watch the water."',
      "Follow the quiet path.",
    ];
    const story = createStoryFromScript(parts.join("\n\n"), "promo");
    expect(story.scenes.map((scene) => scene.narration)).toEqual(parts);
    expect(story.scenes.map((scene) => scene.title)).toEqual([
      "Hook",
      "Benefit 1",
      "Call to action",
    ]);
    expect(story.scenes.map((scene) => scene.visualPrompt)).toEqual(parts);
    expect(createStoryFromScript(parts[0]).scenes).toHaveLength(1);
    expect(createStoryFromScript("").scenes).toEqual([]);
  });

  it("bounds scenes and scripts and rejects duplicate scene IDs", () => {
    expect(() =>
      createStoryFromScript(Array(61).fill("One.").join("\n\n")),
    ).toThrow(/60 paragraphs/);
    expect(() => createStoryFromScript("x".repeat(5001))).toThrow(/5,000/);
    const story = createStoryFromScript("First.\n\nSecond.");
    story.scenes[1].id = story.scenes[0].id;
    expect(() => StoryPlanSchema.parse(story)).toThrow(/unique ID/);
  });

  it("retains a long script while bounding its editable visual prompt", () => {
    const script = "word ".repeat(950).trim();
    const story = createStoryFromScript(script);
    expect(story.scenes[0].narration).toBe(script);
    expect(story.scenes[0].visualPrompt.length).toBeLessThanOrEqual(4000);
    expect(story.brief).toBe(script);
  });

  it("keeps old projects valid and round trips story settings and scene references", () => {
    const old = newProject();
    expect(
      validateProject(JSON.parse(JSON.stringify(old))).story,
    ).toBeUndefined();
    const project = preparedStory();
    project.story!.style = "Blue moonlight";
    project.story!.referenceAssetIds = ["hero", "forest"];
    project.story!.scenes[0].referenceAssetIds = ["hero", "lantern"];
    expect(validateProject(JSON.parse(JSON.stringify(project))).story).toEqual(
      project.story,
    );
  });

  it("caps inherited and scene references together while sharing duplicate images only once", () => {
    const story = createStoryFromScript("First.\n\nSecond.");
    story.referenceAssetIds = ["hero", "forest"];
    story.scenes[0].referenceAssetIds = ["hero", "lantern"];
    expect(mergedStoryReferenceIds(story, story.scenes[0])).toEqual([
      "hero",
      "forest",
      "lantern",
    ]);
    expect(StoryPlanSchema.parse(story)).toEqual(story);
    story.scenes[0].referenceAssetIds = Array.from(
      { length: 8 },
      (_, index) => `image-${index}`,
    );
    expect(() => StoryPlanSchema.parse(story)).toThrow(/at most 9/);
    story.scenes[0].referenceAssetIds.pop();
    expect(StoryPlanSchema.parse(story)).toEqual(story);
    expect(mergedStoryReferenceIds(story, story.scenes[1])).toEqual([
      "hero",
      "forest",
    ]);
  });

  it("saves and recovers a storyboard before any media or timeline exists", () => {
    const { store, folder } = storeSetup();
    store.commit(
      { ...store.project, story: createStoryFromScript("Keep this story.") },
      "Write story",
    );
    expect(store.hasUnsavedWork()).toBe(true);
    expect(
      hasUnsavedWork({
        project: store.project,
        filePath: null,
        canUndo: false,
      }),
    ).toBe(true);
    const library = new ProjectLibrary(
      path.join(folder, "Projects"),
      path.join(folder, "recent.json"),
    );
    expect(library.fileIfNeeded(store)).toBe(true);
    const file = store.filePath!;
    store.fresh();
    store.load(file);
    expect(store.project.story?.scenes[0].narration).toBe("Keep this story.");
    store.commit(
      { ...store.project, story: createStoryFromScript("Changed story.") },
      "Edit story",
    );
    store.undo();
    expect(store.project.story?.scenes[0].narration).toBe("Keep this story.");
    const reopened = new Store(store.recovery);
    stores.push(reopened);
    expect(reopened.project.story).toEqual(store.project.story);
  });

  it("backs up an unsaved storyboard and rotates openSession across same-file reopen", () => {
    const { store, folder } = storeSetup();
    store.commit(
      { ...store.project, story: createStoryFromScript("Unsaved storyboard.") },
      "Write story",
    );
    const initial = store.openSession;
    store.fresh();
    expect(store.openSession).not.toBe(initial);
    expect(
      readdirSync(store.backupDirectory).some((name) =>
        name.endsWith(".cutline"),
      ),
    ).toBe(true);
    const file = path.join(folder, "same.cutline");
    store.save(file);
    const beforeLoad = store.openSession;
    store.load(file);
    expect(store.openSession).not.toBe(beforeLoad);
    const afterLoad = store.openSession;
    store.load(file);
    expect(store.openSession).not.toBe(afterLoad);
    const beforeFailedLoad = store.openSession;
    expect(() => store.load(path.join(folder, "missing.cutline"))).toThrow();
    expect(store.openSession).toBe(beforeFailedLoad);
  });
});

describe("Story timeline assembly", () => {
  it("fits narration and safely loops a shorter source until every frame is covered", () => {
    const source = preparedStory();
    const before = structuredClone(source);
    const result = buildStoryTimeline(source, { mode: "append" });
    expect(source).toEqual(before);
    expect(result.durationFrames).toBe(129);
    const visuals = result.project.clips.filter(
      (clip) => clip.kind === "video",
    );
    expect(visuals.map((clip) => clip.duration)).toEqual([33, 33, 33, 30]);
    expect(visuals.map((clip) => clip.start)).toEqual([0, 33, 66, 99]);
    expect(
      visuals.every((clip) => clip.sourceIn === 0 && clip.volume === 0),
    ).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/extended.*loops/);
    expect(() => validateProject(result.project)).not.toThrow();
  });

  it("offsets actual word timings and narration when appending after existing work", () => {
    const project = preparedStory();
    const existing = {
      ...makeClip(project, "text", "titles", 15),
      duration: 120,
      text: "Existing work",
    };
    project.clips.push(existing);
    const result = buildStoryTimeline(project, { mode: "append" });
    expect(result.startFrame).toBe(135);
    expect(
      result.project.clips.find((clip) => clip.id === existing.id),
    ).toEqual(existing);
    const voice = result.project.clips.find((clip) => clip.kind === "audio")!;
    expect(voice.start).toBe(135);
    const captions = result.project.clips.filter(
      (clip) => clip.kind === "caption",
    );
    expect(result.captionCount).toBeGreaterThan(0);
    const actualWords = captions.flatMap((clip) =>
      clip.words.map((word) => ({
        ...word,
        start: word.start + (clip.start - result.startFrame) / project.fps,
        end: word.end + (clip.start - result.startFrame) / project.fps,
      })),
    );
    expect(actualWords.map((word) => word.text)).toEqual(
      project.assets[1].words!.map((word) => word.text),
    );
    actualWords.forEach((word, i) => {
      expect(word.start).toBeCloseTo(project.assets[1].words![i].start, 10);
      expect(word.end).toBeCloseTo(project.assets[1].words![i].end, 10);
    });
    expect(captions.every((clip) => clip.captionSourceId === voice.id)).toBe(
      true,
    );
  });

  it("puts the story's visuals under the project's Titles and Captions, so a later title still shows", () => {
    const result = buildStoryTimeline(preparedStory(), { mode: "append" });
    const names = result.project.tracks.map((track) => track.name);
    expect(names).toEqual([
      "Story captions",
      "Titles",
      "Captions",
      "Story visuals",
      "Video",
      "Music & audio",
      "Story voiceover",
    ]);
    // Earlier tracks draw on top: a toolbar or agent title goes on Titles.
    expect(names.indexOf("Titles")).toBeLessThan(
      names.indexOf("Story visuals"),
    );
    expect(result.project.story!.assembly!.trackIds).toHaveLength(3);
  });

  it("rebuilds only its recorded clips and preserves custom work even on an owned track", () => {
    const first = buildStoryTimeline(preparedStory(), {
      mode: "append",
    }).project;
    const old = first.story!.assembly!;
    const custom = {
      ...makeClip(first, "text", old.trackIds[0], 4),
      text: "Keep my addition",
    };
    first.clips.push(custom);
    first.story!.scenes[0].duration = 6;
    const rebuilt = buildStoryTimeline(first, { mode: "rebuild" });
    expect(rebuilt.startFrame).toBe(0);
    expect(rebuilt.project.clips.find((clip) => clip.id === custom.id)).toEqual(
      custom,
    );
    expect(
      rebuilt.project.tracks.some((track) => track.id === custom.trackId),
    ).toBe(true);
    expect(
      rebuilt.project.clips.some((clip) => old.clipIds.includes(clip.id)),
    ).toBe(false);
    expect(rebuilt.project.story!.assembly!.clipIds).not.toContain(custom.id);
    expect(rebuilt.warnings.join(" ")).toMatch(/overlaps/);
  });

  it.each(["narration", "voice", "speed"] as const)(
    "blocks stale speech after changing %s",
    (field) => {
      const project = preparedStory();
      if (field === "narration")
        project.story!.scenes[0].narration = "A different script.";
      if (field === "voice") project.story!.voice = "af_bella";
      if (field === "speed") project.story!.speed = 1.2;
      expect(() => buildStoryTimeline(project, { mode: "append" })).toThrow(
        /Regenerate its voiceover/,
      );
      expect(project.clips).toEqual([]);
    },
  );

  it("requires available visuals and narration, but permits an explicitly silent scene", () => {
    const project = preparedStory();
    delete project.story!.scenes[0].assetId;
    expect(() => buildStoryTimeline(project, { mode: "append" })).toThrow(
      /choose a video or image/,
    );
    project.story!.scenes[0].assetId = project.assets[0].id;
    delete project.story!.scenes[0].voiceAssetId;
    expect(() => buildStoryTimeline(project, { mode: "append" })).toThrow(
      /generate its voiceover/,
    );
    project.story!.scenes[0].narration = "";
    const silent = buildStoryTimeline(project, { mode: "append" });
    expect(silent.project.clips.every((clip) => clip.kind === "video")).toBe(
      true,
    );
    expect(silent.durationFrames).toBe(90);
  });

  it("never invents caption timing when narration audio has no transcript", () => {
    const project = preparedStory();
    delete project.assets[1].words;
    const result = buildStoryTimeline(project, { mode: "append" });
    expect(result.captionCount).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/captions need word timing/);
    expect(result.project.clips.some((clip) => clip.kind === "audio")).toBe(
      true,
    );
  });

  it("holds still images and loops a quiet music bed with end fades", () => {
    const project = preparedStory();
    project.assets[0].kind = "image";
    project.assets[0].duration = 0;
    const music = AssetSchema.parse({
      id: "music",
      name: "Music",
      kind: "audio",
      path: "/music.wav",
      duration: 1.5,
    });
    project.assets.push(music);
    project.story!.musicAssetId = music.id;
    project.story!.captionStyle = "pop";
    const result = buildStoryTimeline(project, { mode: "append" });
    expect(
      result.project.clips.filter((clip) => clip.kind === "image"),
    ).toHaveLength(1);
    const musicClips = result.project.clips.filter(
      (clip) => clip.assetId === music.id,
    );
    expect(musicClips.map((clip) => clip.duration)).toEqual([45, 45, 39]);
    expect(musicClips.every((clip) => clip.volume === 0.12)).toBe(true);
    expect(musicClips[0].fadeIn).toBeGreaterThan(0);
    expect(musicClips.at(-1)!.fadeOut).toBeGreaterThan(0);
    expect(
      result.project.clips
        .filter((clip) => clip.kind === "caption")
        .every((clip) => clip.captionStyle === "pop"),
    ).toBe(true);
  });

  it("bounds pathological looping without partially mutating the project", () => {
    const project = preparedStory();
    project.story!.scenes[0].duration = 120;
    project.fps = 60;
    project.assets[0].duration = 0.01;
    project.story!.scenes.push({
      ...project.story!.scenes[0],
      id: "second-scene",
    });
    expect(() => buildStoryTimeline(project, { mode: "append" })).toThrow(
      /10,000 clips/,
    );
    expect(project.clips).toEqual([]);
  });
});
