import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import {
  newProject,
  validateProject,
  type MotionLayer,
} from "../src/shared/model";
import { motionValue } from "../src/shared/motion";
import {
  createMotionScene,
  creatorStudioSceneIds,
  motionSceneCategories,
  motionScenes,
} from "../src/shared/motion-presets";

function named(layers: MotionLayer[], name: string) {
  const layer = layers.find((item) => item.name === name);
  expect(layer, `Missing editable studio layer: ${name}`).toBeDefined();
  return layer!;
}

function sphereArtwork(layer: MotionLayer, frame: number) {
  expect(layer.type).toBe("path");
  const geometry = layer.vectorPath?.match(
    /^M([-\d.e]+) ([-\d.e]+) A([-\d.e]+) /,
  );
  expect(geometry).not.toBeNull();
  const radius = Number(geometry![3]);
  const center = { x: Number(geometry![1]) + radius, y: Number(geometry![2]) };
  const gradient = layer.vectorGradient!;
  expect(gradient).toMatchObject({ type: "radial", units: "userSpaceOnUse" });
  return {
    x: layer.x + center.x + motionValue(layer, "x", frame),
    y: layer.y + center.y + motionValue(layer, "y", frame),
    diameter: radius * 2 * motionValue(layer, "scale", frame),
    lightX: (gradient.cx! - center.x) / (radius * 2),
    lightY: (gradient.cy! - center.y) / (radius * 2),
    lightRadius: gradient.r! / (radius * 2),
    stops: gradient.stops,
  };
}

describe("creator studio film scenes", () => {
  it("discovers original native scenes and retains depth and typography through project JSON", () => {
    expect(motionSceneCategories).toContain("Creator studio");
    for (const id of creatorStudioSceneIds) {
      const p = newProject();
      const created = createMotionScene(p, 17, id);
      expect(motionScenes.find((scene) => scene.id === id)?.category).toBe(
        "Creator studio",
      );
      expect(created.motion.source).toBe(id);
      expect(created.clip.fontFamily).toBe("Helvetica");
      expect(
        new Set(created.motion.layers.map((layer) => layer.name)).size,
      ).toBe(created.motion.layers.length);
      expect(
        created.motion.layers.every((layer) => layer.name && !layer.hidden),
      ).toBe(true);
      const next = applyCommands(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Add creator studio scene",
        commands: created.commands,
      });
      expect(next.assets).toHaveLength(0);
      expect(validateProject(JSON.parse(JSON.stringify(next))).motions).toEqual(
        next.motions,
      );
    }
  });

  it("projects the complete poster artwork on one coherent plane and settles face-on before type appears", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      const { motion } = createMotionScene(p, 0, "studio-depth-proof");
      const front = named(motion.layers, "Finished poster plane");
      const art = named(motion.layers, "Poster disc artwork");
      const type = named(motion.layers, "Poster hero type");
      expect(art.keyframes).toEqual(front.keyframes);
      expect(art.vectorGradient?.type).toBe("radial");
      expect(Math.abs(motionValue(front, "rotateY", 0))).toBeGreaterThan(0);
      expect(motionValue(front, "perspective", 0)).toBeGreaterThanOrEqual(600);
      const settled = Math.round((38 * fps) / 30);
      expect(motionValue(front, "rotateX", settled)).toBe(0);
      expect(motionValue(front, "rotateY", settled)).toBe(0);
      expect(motionValue(type, "opacity", settled)).toBe(0);
      expect(motionValue(type, "opacity", Math.round((54 * fps) / 30))).toBe(1);
    }
  });

  it("hands the path scene's final disc to the typography scene at the same size and position", () => {
    for (const [width, height] of [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
    ]) {
      for (const fps of [24, 25, 30, 60] as const) {
        const p = { ...newProject(), width, height, fps };
        const path = createMotionScene(p, 0, "studio-path-story");
        const type = createMotionScene(p, fps * 4, "studio-type-handoff");
        const outgoing = named(path.motion.layers, "Traveling studio disc");
        const incoming = named(type.motion.layers, "Handoff solid disc");
        const center = (layer: MotionLayer, frame: number) => ({
          x: layer.x + layer.width / 2 + motionValue(layer, "x", frame),
          y: layer.y + layer.height / 2 + motionValue(layer, "y", frame),
          diameter: layer.width * motionValue(layer, "scale", frame),
        });
        const final = center(outgoing, fps * 4 - 1),
          initial = center(incoming, 0);
        expect(initial.x).toBeCloseTo(final.x, 5);
        expect(initial.y).toBeCloseTo(final.y, 5);
        expect(initial.diameter).toBeCloseTo(final.diameter, 5);
        const letter = named(type.motion.layers, "Handoff letter O");
        expect(motionValue(letter, "opacity", fps * 4 - 1)).toBe(1);
        expect(motionValue(incoming, "opacity", fps * 4 - 1)).toBe(0);
        expect(letter.background).toBe("transparent");
        expect(
          named(type.motion.layers, "Result editorial accent"),
        ).toMatchObject({ fontFamily: "Georgia", fontStyle: "italic" });
      }
    }
  });

  it("preserves sphere geometry and radial material across both scene handoffs", () => {
    for (const [width, height] of [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
    ]) {
      for (const fps of [24, 25, 30, 60] as const) {
        const p = { ...newProject(), width, height, fps };
        const depth = createMotionScene(p, 0, "studio-depth-proof");
        const path = createMotionScene(p, fps * 4, "studio-path-story");
        const type = createMotionScene(p, fps * 8, "studio-type-handoff");
        const poster = sphereArtwork(
          named(depth.motion.layers, "Poster disc artwork"),
          fps * 4 - 1,
        );
        const travel = named(path.motion.layers, "Traveling studio disc");
        const opening = sphereArtwork(travel, 0);
        const closing = sphereArtwork(travel, fps * 4 - 1);
        const incoming = sphereArtwork(
          named(type.motion.layers, "Handoff solid disc"),
          0,
        );
        for (const [outgoing, next] of [
          [poster, opening],
          [closing, incoming],
        ]) {
          for (const property of [
            "x",
            "y",
            "diameter",
            "lightX",
            "lightY",
            "lightRadius",
          ] as const)
            expect(next[property]).toBeCloseTo(outgoing[property], 5);
          expect(next.stops).toEqual(outgoing.stops);
        }
        expect(named(type.motion.layers, "Handoff letter O").type).toBe(
          "ellipse",
        );
      }
    }
  });

  it("resolves every scene and preserves bounded unique key times when duration changes", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      for (const id of creatorStudioSceneIds) {
        for (const length of [2, 3, 12, fps * 2, fps * 4, fps * 8]) {
          const { motion, clip } = createMotionScene(p, 0, id, {
            durationFrames: length,
          });
          expect(clip.duration).toBe(length);
          for (const layer of motion.layers) {
            expect(new Set(layer.keyframes.map((key) => key.frame)).size).toBe(
              layer.keyframes.length,
            );
            expect(
              layer.keyframes.every(
                (key) => key.frame >= 0 && key.frame < length,
              ),
            ).toBe(true);
          }
          if (length >= fps * 2) {
            const hero = named(
              motion.layers,
              id === "studio-depth-proof"
                ? "Poster hero type"
                : id === "studio-path-story"
                  ? "Motion instruction"
                  : "Result editorial accent",
            );
            expect(motionValue(hero, "opacity", length - 1)).toBe(1);
          }
        }
      }
    }
  });
});
