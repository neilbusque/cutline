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
  editorialSceneIds,
  motionSceneCategories,
  motionScenes,
} from "../src/shared/motion-presets";

const named = (layers: MotionLayer[], name: string) => {
  const match = layers.find((layer) => layer.name === name);
  expect(match, `Missing editable layer: ${name}`).toBeDefined();
  return match!;
};

describe("native editorial story mechanisms", () => {
  it("discovers all three mechanisms and round-trips the editable schematic without assets", () => {
    expect(motionSceneCategories).toContain("Editorial");
    for (const id of editorialSceneIds) {
      const p = newProject();
      const created = createMotionScene(p, 17, id);
      const next = applyCommands(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Add editorial scene",
        commands: created.commands,
      });
      expect(motionScenes.find((scene) => scene.id === id)?.category).toBe(
        "Editorial",
      );
      expect(created.clip.fontFamily).toBe("Helvetica");
      expect(created.motion.source).toBe(id);
      expect(
        new Set(created.motion.layers.map((layer) => layer.name)).size,
      ).toBe(created.motion.layers.length);
      expect(
        created.motion.layers.every((layer) => layer.name && !layer.hidden),
      ).toBe(true);
      expect(next.assets).toHaveLength(0);
      expect(validateProject(JSON.parse(JSON.stringify(next))).motions).toEqual(
        next.motions,
      );
      expect(
        named(created.motion.layers, "Illustrative example label").text,
      ).toBe("Illustrative example");
    }
  });

  it("carries the same packet through both receivers in landscape and portrait", () => {
    for (const [width, height] of [
      [1920, 1080],
      [1080, 1920],
    ]) {
      for (const fps of [24, 25, 30, 60] as const) {
        const p = { ...newProject(), width, height, fps };
        const { motion } = createMotionScene(p, 0, "editorial-transfer");
        const packet = named(motion.layers, "Persistent packet");
        expect(
          motion.layers.filter((layer) => layer.name === "Persistent packet"),
        ).toHaveLength(1);
        for (const [receiverIndex, sourceFrame] of [
          [1, 0],
          [2, 42],
          [3, 76],
        ]) {
          const receiver = named(
            motion.layers,
            `Node ${receiverIndex} received`,
          );
          const frame = Math.round((sourceFrame * fps) / 30);
          expect(
            packet.x + motionValue(packet, "x", frame) + packet.width / 2,
          ).toBeCloseTo(receiver.x + receiver.width / 2, 5);
          expect(
            packet.y + motionValue(packet, "y", frame) + packet.height / 2,
          ).toBeCloseTo(receiver.y + receiver.height / 2, 5);
          if (receiverIndex > 1) {
            expect(motionValue(receiver, "opacity", frame - 1)).toBe(0);
            expect(
              motionValue(
                receiver,
                "opacity",
                Math.round(((sourceFrame + 8) * fps) / 30),
              ),
            ).toBe(1);
          }
        }
      }
    }
  });

  it("keeps the comparison surface, revealed strokes and moving divider synchronized after retiming", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      for (const length of [fps * 2, fps * 3, fps * 4, fps * 8]) {
        const { motion } = createMotionScene(p, 0, "editorial-compare", {
          durationFrames: length,
        });
        const surface = named(motion.layers, "Comparison reveal surface");
        const divider = named(motion.layers, "Moving comparison divider");
        const clean = named(motion.layers, "Aligned route 1");
        for (let frame = 0; frame < length; frame++) {
          const progress = motionValue(clean, "trim", frame);
          expect(motionValue(surface, "x", frame)).toBeCloseTo(
            (progress - 1) * surface.width,
            5,
          );
          expect(motionValue(divider, "x", frame)).toBeCloseTo(
            progress * surface.width,
            5,
          );
        }
        expect(motionValue(clean, "trim", length - 1)).toBe(1);
        expect(
          motionValue(
            named(motion.layers, "Before state label"),
            "opacity",
            length - 1,
          ),
        ).toBe(0);
        expect(
          motionValue(
            named(motion.layers, "After state label"),
            "opacity",
            length - 1,
          ),
        ).toBe(1);
      }
    }
  });

  it("gives focus an ordered context, selection, enlarged detail and settled outcome", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      const { motion } = createMotionScene(p, 0, "editorial-focus");
      const at = (frame: number) => Math.round((frame * fps) / 30);
      const context = named(motion.layers, "Document context");
      const focus = named(motion.layers, "Selected passage focus frame");
      const detail = named(motion.layers, "Enlarged editable passage");
      const outcome = named(motion.layers, "Settled outcome label");
      expect(motionValue(context, "opacity", 0)).toBe(1);
      expect(motionValue(detail, "opacity", 0)).toBe(0);
      expect(motionValue(focus, "trim", at(26))).toBe(1);
      expect(motionValue(focus, "opacity", at(26))).toBe(1);
      expect(motionValue(context, "opacity", at(54))).toBe(0);
      expect(motionValue(detail, "opacity", at(54))).toBe(1);
      expect(motionValue(detail, "scale", at(54))).toBe(1);
      expect(motionValue(outcome, "opacity", at(84))).toBe(1);
      expect(motionValue(detail, "opacity", fps * 4 - 1)).toBe(1);
    }
  });

  it("bounds and deduplicates keys for tiny and extended scenes at every supported frame rate", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      for (const id of editorialSceneIds) {
        for (const length of [2, 3, 12, fps * 2, fps * 8]) {
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
        }
      }
    }
  });
});
