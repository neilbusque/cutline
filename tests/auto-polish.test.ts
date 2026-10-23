import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import { animatedValue } from "../src/shared/animation";
import { newProject, type Asset } from "../src/shared/model";
import { analyzeAutoReel, finalizeAutoReelPlan } from "../src/shared/auto-reel";

function fixture(
  fps: 24 | 25 | 30 | 60,
  style: "clean" | "bold" | "cinematic",
) {
  const source: Asset = {
    id: "source",
    kind: "video",
    name: "Coffee.mp4",
    path: "/coffee.mp4",
    hasAudio: true,
    duration: 28,
    words: [
      ..."Fresh coffee tastes wonderful with the right preparation every morning."
        .split(" ")
        .map((text, i) => ({ text, start: 1 + i * 0.5, end: 1.4 + i * 0.5 })),
      ..."Ocean waves roll towards the beach in the evening light."
        .split(" ")
        .map((text, i) => ({ text, start: 18 + i * 0.5, end: 18.4 + i * 0.5 })),
    ],
  };
  const project = newProject();
  project.fps = fps;
  project.assets = [
    source,
    {
      id: "photo",
      kind: "image",
      name: "Coffee.jpg",
      path: "/coffee.jpg",
      duration: 0,
      hasAudio: false,
    },
  ];
  const analysis = analyzeAutoReel(source, { fps, style });
  const beat = analysis.beats[0];
  expect(beat).toBeDefined();
  const plan = finalizeAutoReelPlan(
    project,
    analysis,
    [{ ...beat, assetId: "photo" }],
    undefined,
    { music: false, openingTitle: false },
  );
  const next = applyCommands(project, {
    projectId: project.id,
    revision: project.revision,
    label: plan.label,
    commands: plan.commands,
  });
  return { next, plan, analysis };
}

describe("Automatic editorial finishing", () => {
  it.each([24, 25, 30, 60] as const)(
    "keeps framing continuous across removed pauses at %ifps without moving captions or fading speech",
    (fps) => {
      const { next, plan, analysis } = fixture(fps, "bold");
      const source = next.clips
        .filter((c) => c.assetId === "source")
        .sort((a, b) => a.start - b.start);
      expect(source).toHaveLength(2);
      const before = animatedValue(source[0], "scale", source[0].duration - 1);
      const after = animatedValue(source[1], "scale", 0);
      expect(after - before).toBeCloseTo(0.025 / (plan.durationFrames - 1), 8);
      expect(
        source.every(
          (c) => c.fadeIn === 0 && c.fadeOut === 0 && c.volume === 1,
        ),
      ).toBe(true);
      expect(plan.durationFrames / fps).toBeCloseTo(analysis.durationSeconds);
      const last = source.at(-1)!;
      expect(animatedValue(last, "scale", last.duration - 1)).toBeCloseTo(
        1.025,
      );
    },
  );

  it.each(["clean", "bold", "cinematic"] as const)(
    "matches %s color treatment and gives still cutaways a restrained eased move",
    (style) => {
      const { next } = fixture(30, style);
      const base = next.clips.find((c) => c.assetId === "source")!;
      const shot = next.clips.find((c) => c.assetId === "photo")!;
      expect([
        shot.look,
        shot.effectAmount,
        shot.overlay,
        shot.overlayAmount,
      ]).toEqual([
        base.look,
        base.effectAmount,
        base.overlay,
        base.overlayAmount,
      ]);
      expect(shot.cameraMotion).toBe("none");
      expect(animatedValue(shot, "scale", 0)).toBe(1);
      expect(animatedValue(shot, "scale", shot.duration - 1)).toBe(1.035);
      expect(shot.keyframes[0].easing).toBe("ease-in-out");
      expect(shot.fadeIn).toBeGreaterThanOrEqual(5);
      expect(shot.fadeIn + shot.fadeOut).toBeLessThan(shot.duration / 2);
      expect(shot.volume).toBe(0);
      expect(next.tracks.find((t) => t.id === shot.trackId)?.muted).toBe(true);
    },
  );
});
