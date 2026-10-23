import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AssetSchema,
  MotionSchema,
  makeClip,
  newProject,
  validateProject,
  type Clip,
  type Project,
} from "../src/shared/model";
import { buildCaptionClips } from "../src/shared/caption-grouping";
import { createStoryFromScript } from "../src/shared/story";
import { analyzeVideoQuality } from "../src/shared/video-quality";

function setup() {
  const project = newProject();
  project.id = "quality-fixture";
  project.revision = 7;
  const image = AssetSchema.parse({
    id: "screen",
    kind: "image",
    name: "Screen",
    path: "/screen.png",
    duration: 0,
  });
  const voice = AssetSchema.parse({
    id: "voice",
    kind: "audio",
    name: "Voice",
    path: "/voice.wav",
    duration: 4,
    words: [
      { text: "Make", start: 0.2, end: 0.6 },
      { text: "a", start: 0.6, end: 0.8 },
      { text: "film.", start: 0.8, end: 1.8 },
    ],
  });
  project.assets.push(image, voice);
  const screen = {
    ...makeClip(project, "image", "video", 0, image),
    id: "screen-clip",
    duration: 120,
  };
  const speech = {
    ...makeClip(project, "audio", "audio", 0, voice),
    id: "voice-clip",
    duration: 120,
  };
  project.clips.push(
    screen,
    speech,
    ...buildCaptionClips(project, voice.words!, {
      sourceId: speech.id,
      maxDurationFrames: speech.duration,
    }),
  );
  return { project, screen, speech, voice };
}
const codes = (project: Project) =>
  analyzeVideoQuality(project).issues.map((issue) => issue.code);
const appendCaption = (project: Project, patch: Partial<Clip> = {}) => {
  const caption = {
    ...makeClip(project, "caption", "captions"),
    id: `caption-${project.clips.length}`,
    text: "A caption",
    duration: 30,
    ...patch,
  };
  project.clips.push(caption);
  return caption;
};

describe("structural video quality review", () => {
  it("is deterministic, serializable, read-only, and does not claim a subjective score", () => {
    const { project } = setup();
    const before = JSON.stringify(project);
    const report = analyzeVideoQuality(project);
    expect(report).toEqual(analyzeVideoQuality(project));
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(JSON.stringify(project)).toBe(before);
    expect(report.issues).toEqual([]);
    expect(report.projectId).toBe(project.id);
    expect(report.revision).toBe(7);
    expect(report.summary).toMatchObject({
      durationFrames: 120,
      errorCount: 0,
      warningCount: 0,
    });
    expect(report).not.toHaveProperty("score");
    expect(report.checksRequiringReview.join(" ")).toMatch(
      /loudness.*filesystem/,
    );
  });

  it("reports used missing assets, designs and tracks without checking unused files", () => {
    const { project, screen } = setup();
    screen.assetId = "missing";
    project.clips.push({
      ...makeClip(project, "text", "titles"),
      id: "motion",
      motionId: "missing-design",
    });
    project.clips.push({
      ...makeClip(project, "text", "deleted-track"),
      id: "orphan",
    });
    project.assets.push(
      AssetSchema.parse({
        id: "unused",
        kind: "image",
        name: "Unused",
        path: "/unused.png",
        duration: 0,
      }),
    );
    const checked: string[] = [];
    const report = analyzeVideoQuality(project, {
      assetAvailable: (asset) => {
        checked.push(asset.id);
        return true;
      },
    });
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "missing_media",
        "missing_motion",
        "missing_track",
        "visual_gap",
      ]),
    );
    expect(checked).toEqual(["voice"]);
    expect(report.summary.errorCount).toBe(3);
  });

  it("reports callback-confirmed missing files and blank media paths", () => {
    const { project } = setup();
    expect(
      analyzeVideoQuality(project, {
        assetAvailable: (asset) => asset.id !== "screen",
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_media",
          clipIds: ["screen-clip"],
        }),
      ]),
    );
    project.assets[0].path = " ";
    expect(codes(project)).toContain("missing_media");
    project.assets[0].path = "/screen.png";
    const report = analyzeVideoQuality(project, {
      assetAvailable: () => {
        throw Error("permission unavailable");
      },
    });
    expect(report.issues).toEqual([]);
    expect(report.checksRequiringReview.join(" ")).toContain(
      "availability check failed",
    );
  });

  it("merges overlapping visuals and keeps an intentional gap as a review warning", () => {
    const { project, screen } = setup();
    project.clips = [screen];
    screen.duration = 30;
    project.clips.push({ ...screen, id: "b", start: 20, duration: 40 });
    project.clips.push({ ...screen, id: "c", start: 75, duration: 45 });
    const gaps = analyzeVideoQuality(project).issues.filter(
      (issue) => issue.code === "visual_gap",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ severity: "warning", frames: [60, 74] });
    expect(gaps[0].suggestion).toContain("intentional");
  });

  it("does not mistake a text or motion title sequence for a blank video", () => {
    const project = newProject();
    project.motions.push(
      MotionSchema.parse({
        id: "graphic",
        name: "Title",
        layers: [{ type: "text", text: "A story" }],
      }),
    );
    project.clips.push({
      ...makeClip(project, "text", "titles"),
      duration: 60,
    });
    project.clips.push({
      ...makeClip(project, "text", "titles", 60),
      duration: 60,
      motionId: "graphic",
    });
    expect(codes(project)).not.toContain("visual_gap");
    project.motions[0].layers[0].hidden = true;
    expect(
      analyzeVideoQuality(project).issues.find(
        (issue) => issue.code === "visual_gap",
      )?.frames,
    ).toEqual([60, 119]);
  });

  it("follows renderer visibility and muting, including hidden audio-only tracks", () => {
    const { project, screen, speech } = setup();
    project.tracks.find((track) => track.id === "video")!.hidden = true;
    project.tracks.find((track) => track.id === "audio")!.hidden = true;
    project.tracks.find((track) => track.id === "audio")!.muted = true;
    screen.assetId = "missing-video";
    speech.assetId = "missing-audio";
    expect(codes(project)).not.toContain("missing_media");
    project.tracks.find((track) => track.id === "audio")!.muted = false;
    expect(
      analyzeVideoQuality(project)
        .issues.filter((issue) => issue.code === "missing_media")
        .map((issue) => issue.clipIds),
    ).toEqual([["voice-clip"]]);
    project.tracks.find((track) => track.id === "video")!.hidden = false;
    screen.opacity = 0;
    expect(
      analyzeVideoQuality(project).issues.filter(
        (issue) => issue.code === "missing_media",
      ),
    ).toHaveLength(1);
    screen.keyframes.push({
      property: "opacity",
      frame: 15,
      value: 1,
      easing: "linear",
    });
    expect(
      analyzeVideoQuality(project).issues.filter(
        (issue) => issue.code === "missing_media",
      ),
    ).toHaveLength(2);
  });

  it("checks source audio ranges with speed and trim, tolerates frame rounding, and skips freeze/mute", () => {
    const { project, speech, voice } = setup();
    speech.sourceIn = 1;
    speech.speed = 2;
    speech.duration = 45;
    expect(codes(project)).not.toContain("audio_source_overrun");
    speech.duration = 46;
    expect(codes(project)).not.toContain("audio_source_overrun");
    speech.duration = 48;
    expect(codes(project)).toContain("audio_source_overrun");
    speech.freeze = true;
    expect(codes(project)).not.toContain("audio_source_overrun");
    speech.freeze = false;
    speech.volume = 0;
    expect(codes(project)).not.toContain("audio_source_overrun");
    speech.volume = 1;
    speech.sourceIn = 0;
    speech.speed = 1;
    voice.duration = 1.575;
    speech.duration = Math.ceil(voice.duration * project.fps);
    expect(codes(project)).not.toContain("audio_source_overrun");
  });

  it("finds spatial caption overlaps, invalid word bounds, canvas overflow, and broken links", () => {
    const { project } = setup();
    project.clips = project.clips.filter((clip) => clip.kind !== "caption");
    appendCaption(project, {
      duration: 60,
      y: 1800,
      words: [{ text: "Late", start: 1, end: 3 }],
      captionSourceId: "lost",
    });
    appendCaption(project, { start: 30, y: 1800 });
    appendCaption(project, { start: 30, y: 100 });
    const report = analyzeVideoQuality(project);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "caption_overlap",
        "caption_word_bounds",
        "caption_canvas_bounds",
        "caption_missing_source",
      ]),
    );
    expect(
      report.issues.filter((issue) => issue.code === "caption_overlap"),
    ).toHaveLength(1);
    expect(
      report.issues.find((issue) => issue.code === "caption_overlap")?.frames,
    ).toEqual([30, 59]);
  });

  it("does not call sequential cues overlapping and defers transformed caption geometry", () => {
    const { project } = setup();
    project.clips = project.clips.filter((clip) => clip.kind !== "caption");
    appendCaption(project, { duration: 30 });
    appendCaption(project, { start: 30, duration: 30 });
    appendCaption(project, { start: 0, scale: 1.2, x: -100, rotation: 10 });
    const report = analyzeVideoQuality(project);
    expect(report.issues.map((issue) => issue.code)).not.toContain(
      "caption_overlap",
    );
    expect(report.issues.map((issue) => issue.code)).not.toContain(
      "caption_canvas_bounds",
    );
    expect(report.checksRequiringReview.join(" ")).toContain("motion extremes");
  });

  it("finds missing speech captions after source trims/speed changes, not only missing whole tracks", () => {
    const { project, speech, voice } = setup();
    speech.start = 30;
    speech.sourceIn = 0.6;
    speech.speed = 2;
    speech.duration = 21;
    project.clips = project.clips.filter((clip) => clip.kind !== "caption");
    const selected = voice
      .words!.filter((word) => word.end > speech.sourceIn)
      .map((word) => ({
        ...word,
        start: Math.max(0, (word.start - speech.sourceIn) / speech.speed),
        end: (word.end - speech.sourceIn) / speech.speed,
      }));
    project.clips.push(
      ...buildCaptionClips(project, selected, {
        startFrame: speech.start,
        sourceId: speech.id,
        maxDurationFrames: speech.duration,
      }),
    );
    expect(codes(project)).not.toContain("caption_coverage");
    project.clips.find((clip) => clip.kind === "caption")!.duration = 4;
    expect(codes(project)).toContain("caption_coverage");
    project.tracks.find((track) => track.id === "audio")!.muted = true;
    expect(codes(project)).not.toContain("caption_coverage");
  });

  it("accepts unlinked imported captions and explicit story caption opt-out", () => {
    const { project } = setup();
    for (const clip of project.clips)
      if (clip.kind === "caption") delete clip.captionSourceId;
    expect(codes(project)).not.toContain("caption_coverage");
    project.clips = project.clips.filter((clip) => clip.kind !== "caption");
    expect(codes(project)).toContain("caption_coverage");
    project.story = createStoryFromScript("Make a film.");
    project.story.captions = false;
    expect(codes(project)).not.toContain("caption_coverage");
  });

  it("warns conservatively on fast prose and repeated storyboard layout without enforcing decorative style", () => {
    const { project } = setup();
    project.clips.push({
      ...makeClip(project, "text", "titles"),
      text: "This headline needs time to read",
      duration: 5,
    });
    project.clips.push({
      ...makeClip(project, "text", "titles"),
      text: "CUTLINE",
      duration: 5,
    });
    project.story = createStoryFromScript("One.\n\nTwo.\n\nThree.\n\nFour.");
    for (const scene of project.story.scenes)
      scene.design = {
        layout: "title",
        headline: scene.title,
        eyebrow: "",
        body: "",
        points: [],
        motion: "minimal",
      };
    const report = analyzeVideoQuality(project);
    expect(
      report.issues.filter((issue) => issue.code === "short_reading_time"),
    ).toHaveLength(1);
    expect(
      report.issues.filter((issue) => issue.code === "repeated_story_layout"),
    ).toHaveLength(1);
    expect(JSON.stringify(report)).not.toMatch(/underline|must.*layout|score/);
    project.story.assembly = {
      clipIds: project.clips.map((clip) => clip.id),
      trackIds: project.tracks.map((track) => track.id),
      startFrame: 0,
    };
    const assembled = analyzeVideoQuality(project);
    expect(assembled.issues.map((issue) => issue.code)).not.toContain(
      "repeated_story_layout",
    );
    expect(assembled.checksRequiringReview.join(" ")).toContain(
      "customized timeline",
    );
  });

  it("caps returned issues and contact frames while retaining counts and valid bounds", () => {
    const project = newProject();
    for (let i = 0; i < 250; i++)
      project.clips.push({
        ...makeClip(project, "image", "video", i * 30),
        id: `missing-${i}`,
        assetId: "absent",
        duration: 30,
      });
    const report = analyzeVideoQuality(project);
    expect(report.issues).toHaveLength(100);
    expect(report.summary.errorCount).toBe(250);
    expect(report.summary.omittedIssueCount).toBe(151);
    expect(report.previewFrames).toHaveLength(12);
    expect(
      report.previewFrames.every(
        (frame) => Number.isInteger(frame) && frame >= 0 && frame < 7500,
      ),
    ).toBe(true);
    expect(new Set(report.previewFrames).size).toBe(
      report.previewFrames.length,
    );
    expect(analyzeVideoQuality(newProject()).previewFrames).toEqual([]);
    expect(codes(newProject())).toEqual(["empty_timeline"]);
  });

  // Local regression against the actual delivered film, without making tests
  // depend on personal media being installed in another checkout or CI runner.
  const demo = path.resolve(
    process.cwd(),
    "../../outputs/Cutline-Dynamic-Demo/Cutline-Dynamic-Demo.cutline",
  );
  it.skipIf(!existsSync(demo))(
    "accepts the delivered dynamic film's timed audio, caption cues, and editable motion",
    () => {
      const saved = JSON.parse(readFileSync(demo, "utf8"));
      const project = validateProject(saved.project ?? saved);
      const report = analyzeVideoQuality(project, {
        assetAvailable: (asset) => existsSync(asset.path),
      });
      expect(report.issues).toEqual([]);
      expect(report.summary.durationSeconds).toBeGreaterThan(39);
      expect(report.summary.captionClips).toBeGreaterThan(10);
      expect(report.previewFrames.length).toBeLessThanOrEqual(12);
    },
  );
});
