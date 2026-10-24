import { describe, expect, it } from "vitest";
import { checkFrames } from "../src/shared/check-frames";
import { makeClip, newProject, type Asset } from "../src/shared/model";
import { buildStyleReel } from "../src/shared/style-reel";
import { createReelPlan } from "../src/shared/reel";
import {
  buildStoryTimeline,
  createStoryFromScript,
  storyNarrationSignature,
} from "../src/shared/story";

describe("builders say which frames to check", () => {
  it("lists the opening, each beat once settled and the ending, at most 12", () => {
    // 30 fps: beats at 2 s and 5 s settle 0.6 s in; a 10-frame beat settles on its last frame.
    expect(
      checkFrames(30, 0, 300, [
        { start: 60, duration: 90 },
        { start: 150, duration: 90 },
        { start: 250, duration: 10 },
        { start: 60, duration: 90 },
      ]),
    ).toEqual([0, 78, 168, 259, 299]);
    const many = Array.from({ length: 40 }, (_, i) => ({
      start: 30 + i * 30,
      duration: 30,
    }));
    const frames = checkFrames(30, 0, 1300, many);
    expect(frames).toHaveLength(12);
    expect(frames[0]).toBe(0);
    expect(frames.at(-1)).toBe(1299);
    expect(frames[1]).toBe(48);
    expect(frames[10]).toBe(30 + 39 * 30 + 18);
  });

  it("style reels return the moments each visual lands", () => {
    const p = { ...newProject(), width: 1080, height: 1920 };
    const speaker: Asset = {
      id: "speaker",
      name: "Speaker",
      kind: "video",
      path: "/tmp/speaker.mov",
      duration: 12,
      hasAudio: true,
    };
    p.assets = [speaker];
    p.clips = [{ ...makeClip(p, "video", "video", 0, speaker), duration: 360 }];
    const { summary } = buildStyleReel(p, {
      style: "split",
      beats: [
        { from: 0, to: 2, visual: { kind: "text", text: "Free tool" } },
        { from: 2, to: 4, layout: "speaker" },
        { from: 4.5, to: 5.5, layout: "face" },
        { from: 6, to: 8, visual: { kind: "text", text: "Open source" } },
      ],
    });
    // The plain speaker beat changes nothing on screen, so it is not listed.
    expect(summary.checkFrames).toEqual([0, 18, 153, 198, 359]);
  });

  it("Reel plans and story builds return them too", () => {
    const p = newProject();
    p.assets = [
      {
        id: "voice",
        name: "Speaker",
        path: "/local/speaker.mp4",
        kind: "video",
        duration: 60,
        hasAudio: true,
        words: Array.from({ length: 60 }, (_, index) => ({
          text: index % 4 === 3 ? `point${index}.` : `word${index}`,
          start: index,
          end: index + 0.7,
        })),
      },
    ];
    const plan = createReelPlan(p, {
      sources: [{ assetId: "voice" }],
      targetSeconds: 30,
      mode: "replace",
      format: "explainer",
    });
    expect(plan.beatCount).toBeGreaterThan(0);
    const frames = plan.checkFrames!;
    expect(frames[0]).toBe(plan.startFrame);
    expect(frames.at(-1)).toBe(plan.startFrame + plan.durationFrames - 1);
    expect(frames.length).toBeGreaterThanOrEqual(2 + Math.min(10, plan.beatCount));
    expect(frames.length).toBeLessThanOrEqual(12);

    const story = newProject();
    story.story = createStoryFromScript("A ninja crosses the stream.");
    story.story.scenes[0].duration = 3;
    story.assets.push({
      id: "ninja",
      name: "Ninja",
      kind: "video",
      path: "/ninja.mp4",
      duration: 5,
      hasAudio: false,
    });
    story.story.scenes[0].assetId = "ninja";
    story.story.scenes[0].narration = "";
    story.story.scenes[0].voiceSignature = storyNarrationSignature(
      story.story.scenes[0],
      story.story,
    );
    expect(buildStoryTimeline(story, { mode: "append" }).checkFrames).toEqual([
      0, 30, 89,
    ]);
  });
});
