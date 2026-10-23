import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import {
  duration,
  newProject,
  validateProject,
  type Project,
} from "../src/shared/model";
import { motionTextLines, motionValue } from "../src/shared/motion";
import {
  createMotionScene,
  createStudioDemoProject,
  studioAccentLayers,
  studioPalette,
  studioSceneIds,
} from "../src/shared/motion-presets";

const commit = (p: Project, created: ReturnType<typeof createMotionScene>) =>
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Studio scene",
    commands: created.commands,
  });

describe("Studio motion art direction", () => {
  it("uses a coherent palette, genuine masked line reveals and explicit accent-only music targets", () => {
    const p = { ...newProject(), width: 1280, height: 720 };
    const visibleColors = new Set<string>([
      ...Object.values(studioPalette),
      "transparent",
    ]);
    for (const id of studioSceneIds) {
      const created = createMotionScene(p, 0, id);
      expect(created.motion.source).toBe(id);
      expect(created.clip.fontFamily).toBe("Helvetica");
      const targets = created.motion.layers.flatMap((layer, index) =>
        layer.musicAccent ? [index] : [],
      );
      expect(targets).toEqual(studioAccentLayers[id]);
      expect(created.motion.layers[0].musicAccent).toBe(false);
      for (const layer of created.motion.layers) {
        expect(
          visibleColors.has(
            layer.type === "text" ? layer.color : layer.background,
          ),
        ).toBe(true);
        expect(layer).toMatchObject({
          fillStyle: "solid",
          glow: 0,
          blur: 0,
          loop: "none",
        });
        expect(
          layer.keyframes.some(
            (key) => key.easing === "spring" || key.easing === "back",
          ),
        ).toBe(false);
        if (layer.type === "text") {
          expect(layer.textAnimation).toBe("line-reveal");
          expect(layer.fontWeight).toBeDefined();
          expect(layer.musicAccent).toBe(false);
        }
      }
      expect(
        created.motion.layers.some((layer) =>
          layer.keyframes.some(
            (key) =>
              key.easing === "cubic-bezier" &&
              key.bezier?.join() === "0.16,1,0.3,1",
          ),
        ),
      ).toBe(true);
    }
  });

  it("stages its typography, settles into a stable hold, then deliberately clears its foreground", () => {
    const p = { ...newProject(), width: 1280, height: 720 };
    for (const id of studioSceneIds) {
      const { motion } = createMotionScene(p, 0, id);
      const headline = motion.layers.find(
        (layer) =>
          layer.type === "text" &&
          layer.text.includes("\n") &&
          layer.fontWeight === 600,
      )!;
      const firstCompleted =
        headline.textRevealStart + headline.textRevealFrames;
      expect(
        motionTextLines(headline, headline.text, 0).every(
          (line) => line.progress === 0,
        ),
      ).toBe(true);
      const lines = motionTextLines(headline, headline.text, firstCompleted);
      expect(lines[0].progress).toBe(1);
      expect(lines[1].progress).toBeLessThan(1);
      for (const layer of motion.layers.slice(1)) {
        expect(motionValue(layer, "opacity", 72)).toBe(1);
        expect(motionValue(layer, "opacity", 94)).toBe(1);
        expect(motionValue(layer, "y", 72)).toBe(0);
        expect(motionValue(layer, "y", 94)).toBe(0);
        expect(motionValue(layer, "scale", 72)).toBe(1);
        expect(motionValue(layer, "scale", 94)).toBe(1);
        expect(motionValue(layer, "opacity", 119)).toBe(0);
      }
      expect(motionValue(motion.layers[0], "opacity", 119)).toBe(1);
    }
  });

  it("keeps tracked footer and closing labels on one line in portrait and landscape", () => {
    // Rounded-up Helvetica advances measured independently in Chromium. The
    // positive tracking belongs in the line width too, including at small sizes.
    const labels = [
      { id: "studio-title", text: "FORM FOLLOWS FEELING", advance: 13 },
      { id: "studio-outro", text: "MADE IN CUTLINE", advance: 9 },
    ] as const;
    for (const [width, height] of [
      [1080, 1920],
      [1280, 720],
      [640, 360],
    ]) {
      const p = { ...newProject(), width, height };
      for (const expected of labels) {
        const { motion } = createMotionScene(p, 0, expected.id);
        const label = motion.layers.find(
          (layer) => layer.text === expected.text,
        )!;
        const trackedWidth =
          label.fontSize * expected.advance +
          (label.text.length - 1) * label.letterSpacing;
        expect(trackedWidth).toBeLessThan(label.width - 2);
        expect(label.text).not.toContain("\n");
        if (expected.id === "studio-title")
          expect(label.x + label.width).toBeCloseTo(width * 0.93);
      }
    }
  });

  it("keeps entrance curves and line-reveal phase and anchors exits at an explicitly doubled scene duration", () => {
    const p = { ...newProject(), width: 1280, height: 720 };
    for (const id of studioSceneIds) {
      const original = createMotionScene(p, 101, id);
      const doubled = createMotionScene(p, 101, id, { durationFrames: 240 });
      expect(doubled.clip).toMatchObject({
        start: 101,
        duration: 240,
        animationOffset: 0,
      });
      for (const [index, layer] of original.motion.layers.entries()) {
        const next = doubled.motion.layers[index];
        expect(next.fontSize).toBe(layer.fontSize);
        expect(next.fontWeight).toBe(layer.fontWeight);
        expect(next.keyframes.map((key) => key.easing)).toEqual(
          layer.keyframes.map((key) => key.easing),
        );
        // Entrances keep their pace, exits keep theirs at the new end, and
        // the hold between them takes the extra time.
        const later = (frame: number) => (frame >= 99 ? frame + 120 : frame);
        for (const frame of [0, 10, 25, 48, 80, 108, 119]) {
          for (const property of [
            "x",
            "y",
            "opacity",
            "scale",
            "trim",
          ] as const)
            expect(motionValue(next, property, later(frame))).toBeCloseTo(
              motionValue(layer, property, frame),
            );
          if (layer.type === "text") {
            const originalLines = motionTextLines(layer, layer.text, frame),
              nextLines = motionTextLines(next, next.text, frame);
            for (const [lineIndex, line] of originalLines.entries())
              expect(nextLines[lineIndex].progress).toBeCloseTo(line.progress);
          }
        }
      }
    }
  });

  it("keeps short and long duration plans schema-valid with ordered keys inside their clips at every project rate", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), width: 1080, height: 1920, fps };
      for (const frames of [2, 3, 5, 24, 90, 138, 240, 18000]) {
        for (const id of studioSceneIds) {
          const created = createMotionScene(p, 79, id, {
            durationFrames: frames,
          });
          const next = commit(p, created);
          expect(() => validateProject(next)).not.toThrow();
          expect(created.clip.duration).toBe(frames);
          for (const layer of created.motion.layers) {
            expect(layer.textRevealStart).toBeLessThan(frames);
            expect(layer.textRevealFrames).toBeGreaterThanOrEqual(1);
            expect(layer.loopFrames).toBeGreaterThanOrEqual(1);
            expect(layer.staggerFrames).toBeGreaterThanOrEqual(1);
            expect(
              layer.keyframes.every(
                (key, index) =>
                  key.frame < frames &&
                  (index === 0 || key.frame > layer.keyframes[index - 1].frame),
              ),
            ).toBe(true);
          }
        }
      }
    }
  });

  it("leaves the legacy default timing intact and retimes legacy scenes only when explicitly requested", () => {
    const p = { ...newProject(), width: 1280, height: 720 };
    const original = createMotionScene(p, 0, "kinetic-title");
    expect(original.motion.source).toBe("kinetic-title");
    expect(original.motion.layers[1].keyframes).toEqual([
      { frame: 0, scale: 0.05, opacity: 0, rotate: -8, easing: "back" },
      { frame: 26, scale: 1, opacity: 1, rotate: 0, easing: "linear" },
      { frame: 104, scale: 1, opacity: 1, easing: "ease-in" },
      { frame: 119, scale: 0.05, opacity: 0, easing: "linear" },
    ]);
    expect(
      createMotionScene(p, 0, "kinetic-title", { durationFrames: 120 }).motion
        .layers,
    ).toEqual(original.motion.layers);
    const doubled = createMotionScene(p, 0, "kinetic-title", {
      durationFrames: 240,
    });
    // The entrance keeps its 26 frames and the exit stays on the last 15.
    for (const frame of [0, 10, 26, 90, 110, 119])
      expect(
        motionValue(
          doubled.motion.layers[1],
          "scale",
          frame >= 104 ? frame + 120 : frame,
        ),
      ).toBeCloseTo(motionValue(original.motion.layers[1], "scale", frame));
    for (const durationFrames of [0, 1, 2.5, 18001, Infinity])
      expect(() =>
        createMotionScene(p, 0, "studio-title", { durationFrames }),
      ).toThrow(/2 to 18,000/);
  });

  it("builds a continuous four-scene study on cumulative eight-beat boundaries and persists its editable choreography", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = createStudioDemoProject({ fps, bpm: 104, beatsPerScene: 8 });
      const edges = Array.from({ length: 5 }, (_, index) =>
        Math.round(((index * 8 * 60) / 104) * fps),
      );
      expect(p.clips.map((clip) => clip.start)).toEqual(edges.slice(0, 4));
      expect(p.clips.map((clip) => clip.duration)).toEqual(
        edges.slice(1).map((edge, index) => edge - edges[index]),
      );
      expect(duration(p)).toBe(edges[4]);
      expect(p.motions.map((motion) => motion.source)).toEqual(studioSceneIds);
      expect(new Set(p.clips.map((clip) => clip.trackId)).size).toBe(1);
      expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    }
  });
});
