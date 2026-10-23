import { describe, expect, it } from "vitest";
import {
  evaluatedMotionLayer,
  motionTextLines,
  motionValue,
} from "../src/shared/motion";
import { duration, newProject, validateProject } from "../src/shared/model";
import {
  createMotionScene,
  createSignatureDemoProject,
  signaturePalette,
  signatureSceneIds,
} from "../src/shared/motion-presets";

describe("Signature connected motion sequence", () => {
  it("gives every editable layer a unique role and targets music only to restrained accents", () => {
    const p = { ...newProject(), width: 1280, height: 720 };
    for (const id of signatureSceneIds) {
      const { motion, clip } = createMotionScene(p, 0, id);
      expect(motion.source).toBe(id);
      expect(clip.fontFamily).toBe("Helvetica");
      const names = motion.layers.map((layer) => layer.name);
      expect(names.every((name) => name && name.length <= 80)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
      expect(
        motion.layers.every((layer) => typeof layer.musicAccent === "boolean"),
      ).toBe(true);
      expect(
        motion.layers
          .filter((layer) => layer.musicAccent)
          .map((layer) => layer.name),
      ).toEqual([
        "Orbit · copper baton",
        "Orbit · traveling point",
        "Accent · underline",
      ]);
      for (const layer of motion.layers) {
        expect(layer.glow).toBe(0);
        expect(layer.blur).toBe(0);
        if (layer.type === "text") {
          expect(layer.textAnimation).toBe("line-reveal");
          expect(layer.musicAccent).toBe(false);
        }
      }
    }
  });

  it("matches the actual final and first motif geometry across both cuts at every project rate", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      for (const [width, height] of [
        [1280, 720],
        [1080, 1920],
      ]) {
        const p = createSignatureDemoProject({ width, height, fps });
        for (let index = 0; index < p.motions.length - 1; index++) {
          const outgoing = p.motions[index],
            incoming = p.motions[index + 1];
          const lastFrame = p.clips[index].duration - 1;
          for (const name of [
            "Orbit · shell",
            "Orbit · counterform",
            "Orbit · drawn contour",
            "Orbit · copper baton",
            "Orbit · traveling point",
          ]) {
            const last = evaluatedMotionLayer(
              outgoing.layers.find((layer) => layer.name === name)!,
              lastFrame,
            );
            const first = evaluatedMotionLayer(
              incoming.layers.find((layer) => layer.name === name)!,
              0,
            );
            for (const property of [
              "x",
              "y",
              "width",
              "height",
              "rotate",
              "scale",
              "opacity",
              "trim",
            ] as const)
              expect(
                last[property],
                `${name} ${property}, cut ${index}`,
              ).toBeCloseTo(first[property], 6);
          }
        }
      }
    }
  });

  it("keeps the mark alive throughout the readable hold and avoids blank bookends", () => {
    const p = { ...newProject(), width: 1280, height: 720 };
    for (const id of signatureSceneIds) {
      const { motion } = createMotionScene(p, 0, id);
      const shell = motion.layers.find(
        (layer) => layer.name === "Orbit · shell",
      )!;
      const baton = motion.layers.find(
        (layer) => layer.name === "Orbit · copper baton",
      )!;
      const dot = motion.layers.find(
        (layer) => layer.name === "Orbit · traveling point",
      )!;
      const headline = motion.layers.find(
        (layer) => layer.name === "Headline · masked reveal",
      )!;
      expect(motionValue(shell, "opacity", 0)).toBe(1);
      expect(motionValue(shell, "opacity", 119)).toBe(1);
      expect(
        Math.abs(
          motionValue(baton, "rotate", 58) - motionValue(baton, "rotate", 86),
        ),
      ).toBeGreaterThan(15);
      const a = evaluatedMotionLayer(dot, 32),
        b = evaluatedMotionLayer(dot, 76);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(100);
      expect(motionTextLines(headline, headline.text, 13)[0].progress).toBe(1);
      expect(
        motionTextLines(headline, headline.text, 13)[1].progress,
      ).toBeLessThan(1);
      expect(
        motionTextLines(headline, headline.text, 28).every(
          (line) => line.progress === 1,
        ),
      ).toBe(true);
      expect(motionValue(headline, "opacity", 70)).toBe(1);
      expect(motionValue(headline, "opacity", 119)).toBe(
        id === "signature-close" ? 1 : 0,
      );
    }
  });

  it("builds a cumulative eight-beat sequence and persists the full editable scene data", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = createSignatureDemoProject({ fps });
      const edges = Array.from({ length: 4 }, (_, index) =>
        Math.round(((index * 8 * 60) / 104) * fps),
      );
      expect(p.clips.map((clip) => clip.start)).toEqual(edges.slice(0, 3));
      expect(p.clips.map((clip) => clip.duration)).toEqual(
        edges.slice(1).map((edge, index) => edge - edges[index]),
      );
      expect(duration(p)).toBe(edges[3]);
      expect(p.motions.map((motion) => motion.source)).toEqual(
        signatureSceneIds,
      );
      expect(new Set(p.clips.map((clip) => clip.trackId)).size).toBe(1);
      expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    }
    expect(createSignatureDemoProject().background).toBe(
      signaturePalette.ivory,
    );
    for (const bpm of [0, 301, Infinity])
      expect(() => createSignatureDemoProject({ bpm })).toThrow(/tempo/);
    for (const beatsPerScene of [0, 1.5, 65])
      expect(() => createSignatureDemoProject({ beatsPerScene })).toThrow(
        /beats/,
      );
  });

  it("retimes all named typography and geometry without changing the legacy scene defaults", () => {
    const p = { ...newProject(), width: 1080, height: 1920 };
    const properties = ["x", "y", "rotate", "trim", "opacity"] as const;
    for (const id of signatureSceneIds) {
      const base = createMotionScene(p, 0, id);
      const twice = createMotionScene(p, 0, id, { durationFrames: 240 });
      for (const [index, layer] of base.motion.layers.entries()) {
        const next = twice.motion.layers[index];
        expect(next.name).toBe(layer.name);
        const frames = layer.keyframes.map((key) => key.frame);
        const nextFrames = next.keyframes.map((key) => key.frame);
        const even =
          frames.some((frame) => frame > 0) &&
          nextFrames.join() === frames.map((frame) => Math.min(239, frame * 2)).join();
        if (even) {
          // Constant motion across the scene, such as the orbit, scales evenly.
          expect(layer.type).not.toBe("text");
          for (const frame of [0, 18, 34, 58, 91, 119])
            for (const property of properties)
              expect(motionValue(next, property, frame * 2)).toBeCloseTo(
                motionValue(layer, property, frame),
              );
          continue;
        }
        // Everything else keeps its entrance and reveal timing, and its exit
        // moves to the new end.
        expect(next.textRevealStart).toBe(layer.textRevealStart);
        expect(next.textRevealFrames).toBe(layer.textRevealFrames);
        const moved = nextFrames.findIndex((frame, i) => frame !== frames[i]);
        expect(nextFrames).toEqual(
          frames.map((frame, i) =>
            moved >= 0 && i >= moved ? Math.min(239, frame + 120) : frame,
          ),
        );
        const split = moved >= 0 ? frames[moved] : Infinity;
        for (const frame of [0, 18, 34, 58, 91, 119])
          for (const property of properties)
            expect(
              motionValue(next, property, frame >= split ? frame + 120 : frame),
            ).toBeCloseTo(motionValue(layer, property, frame));
      }
    }
    expect(
      createMotionScene(p, 0, "signature-open", { durationFrames: 240 }).motion.layers.find(
        (layer) => layer.name === "Orbit · traveling point",
      )!.keyframes.at(-1)!.frame,
    ).toBe(238);
    expect(createMotionScene(p, 0, "studio-title").clip.duration).toBe(120);
    expect(
      createMotionScene(p, 0, "kinetic-title").motion.layers[1].keyframes[0]
        .easing,
    ).toBe("back");
  });
});
