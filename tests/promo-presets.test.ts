import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import { captionTextWidth } from "../src/shared/caption-layout";
import { newProject, validateProject, type Project } from "../src/shared/model";
import { motionValue } from "../src/shared/motion";
import { motionLayerBounds } from "../src/shared/motion-layout";
import { animatedValue } from "../src/shared/animation";
import {
  createMotionScene,
  motionSceneCategories,
  motionScenes,
  promoSceneIds,
} from "../src/shared/motion-presets";

const commit = (p: Project, created: ReturnType<typeof createMotionScene>) =>
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Add editable promo scene",
    commands: created.commands,
  });

describe("native promo scenes", () => {
  it("exposes every promo in the scene catalog and keeps overlays transparent and editable", () => {
    expect(motionSceneCategories).toContain("Promo");
    expect(new Set(motionSceneCategories).size).toBe(
      motionSceneCategories.length,
    );
    const p = newProject();
    for (const id of promoSceneIds) {
      expect(motionScenes.find((scene) => scene.id === id)?.category).toBe(
        "Promo",
      );
      const created = createMotionScene(p, 17, id);
      const next = commit(p, created);
      expect(created.clip.fontFamily).toBe("Helvetica");
      expect(next.motions[0].source).toBe(id);
      expect(
        new Set(created.motion.layers.map((layer) => layer.name)).size,
      ).toBe(created.motion.layers.length);
      expect(
        created.motion.layers.every((layer) => layer.name && !layer.hidden),
      ).toBe(true);
      if (id !== "promo-invert") {
        expect(
          created.motion.layers.every(
            (layer) =>
              layer.type === "text" && layer.background === "transparent",
          ),
        ).toBe(true);
        expect(
          new Set(created.motion.layers.map((layer) => layer.text)).size,
        ).toBe(created.motion.layers.length);
      }
      const restored = validateProject(JSON.parse(JSON.stringify(next)));
      expect(restored.motions).toEqual(next.motions);
      expect(restored.clips[0].keyframes).toEqual(created.clip.keyframes);
    }
  });

  it("fits actual headline advances and hold poses on wide, square and portrait canvases at every supported rate", () => {
    for (const [width, height] of [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
      [320, 320],
      [3840, 3840],
      [320, 3840],
      [3840, 320],
    ]) {
      for (const fps of [24, 25, 30, 60] as const) {
        const p = { ...newProject(), width, height, fps };
        for (const id of promoSceneIds) {
          const created = createMotionScene(p, fps, id);
          expect(() => validateProject(commit(p, created))).not.toThrow();
          for (const layer of created.motion.layers.filter(
            (item) => item.type === "text",
          )) {
            for (const line of layer.text.split("\n")) {
              expect(
                captionTextWidth(
                  line,
                  layer.fontSize,
                  created.clip.fontFamily,
                  "800",
                  layer.letterSpacing,
                ),
              ).toBeLessThanOrEqual(layer.width * 0.95);
            }
            expect(layer.height).toBeGreaterThanOrEqual(
              layer.fontSize * layer.lineHeight * layer.text.split("\n").length,
            );
            for (const frame of [Math.round(fps * 0.6), fps * 2]) {
              if (motionValue(layer, "opacity", frame) === 0) continue;
              const bounds = motionLayerBounds(layer, frame);
              expect(bounds.left).toBeGreaterThanOrEqual(width * 0.04);
              expect(bounds.right).toBeLessThanOrEqual(width * 0.96);
              expect(bounds.top).toBeGreaterThanOrEqual(height * 0.1);
              expect(bounds.bottom).toBeLessThanOrEqual(height * 0.9);
              expect(motionValue(layer, "blur", frame)).toBe(0);
            }
          }
        }
      }
    }
  });

  it("preserves quick entrances, readable holds and end-anchored exits when scenes change length", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      for (const id of promoSceneIds.filter(
        (value) => value !== "promo-invert",
      )) {
        const original = createMotionScene(p, 0, id);
        for (const seconds of [2, 3, 8]) {
          const length = fps * seconds;
          const resized = createMotionScene(p, 0, id, {
            durationFrames: length,
          });
          for (const [index, layer] of resized.motion.layers.entries()) {
            const source = original.motion.layers[index];
            const arrival = source.keyframes.find((key) => key.opacity === 1)!;
            expect(motionValue(layer, "opacity", arrival.frame)).toBe(1);
            expect(motionValue(layer, "scale", arrival.frame)).toBe(1);
            expect(motionValue(layer, "opacity", Math.floor(length / 2))).toBe(
              1,
            );
            expect(motionValue(layer, "scale", Math.floor(length / 2))).toBe(1);
            expect(motionValue(layer, "blur", Math.floor(length / 2))).toBe(0);
            expect(motionValue(layer, "opacity", length - 1)).toBe(0);
            const exitStart = layer.keyframes.find(
              (key) => key.frame > arrival.frame && key.opacity === 1,
            )!;
            expect(length - exitStart.frame).toBeGreaterThanOrEqual(
              Math.round(fps * 0.25),
            );
            expect(length - exitStart.frame).toBeLessThanOrEqual(
              Math.round(fps * 0.35),
            );
          }
        }
      }
    }
  });

  it("makes one real black-to-white cut with synchronized ink and background after retiming", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      for (const length of [Math.round(fps * 1.6), fps * 2, fps * 4, fps * 8]) {
        const { motion } = createMotionScene(p, 0, "promo-invert", {
          durationFrames: length,
        });
        const [blackCard, whiteText, whiteCard, blackText] = motion.layers;
        expect(blackCard.background).toBe("#000000");
        expect(whiteCard.background).toBe("#ffffff");
        let cuts = 0;
        let previous = 0;
        for (let frame = 0; frame < length; frame++) {
          const light = motionValue(whiteCard, "opacity", frame);
          expect([0, 1]).toContain(light);
          if (light !== previous) cuts++;
          previous = light;
          if (light === 0)
            expect(motionValue(blackText, "opacity", frame)).toBe(0);
          else expect(motionValue(whiteText, "opacity", frame)).toBe(0);
        }
        expect(cuts).toBe(1);
        const cut = whiteCard.keyframes.find((key) => key.opacity === 1)!.frame;
        expect(motionValue(whiteText, "opacity", cut - 1)).toBe(1);
        expect(motionValue(blackText, "opacity", cut)).toBe(1);
        expect(whiteText.text).toBe(blackText.text);
      }
    }
  });

  it("uses RGB only during the cut accents and preserves bounded unique keys even for tiny scenes", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      for (const id of promoSceneIds) {
        for (const length of [2, 3, 12, fps * 2, fps * 8]) {
          const created = createMotionScene(p, 0, id, {
            durationFrames: length,
          });
          expect(() => validateProject(commit(p, created))).not.toThrow();
          for (const layer of created.motion.layers) {
            expect(new Set(layer.keyframes.map((key) => key.frame)).size).toBe(
              layer.keyframes.length,
            );
            expect(
              layer.keyframes.every(
                (key) => key.frame >= 0 && key.frame < length,
              ),
            ).toBe(true);
          }
          expect(
            new Set(
              created.clip.keyframes.map(
                (key) => `${key.property}:${key.frame}`,
              ),
            ).size,
          ).toBe(created.clip.keyframes.length);
          expect(
            created.clip.keyframes.every(
              (key) =>
                key.frame >= 0 &&
                key.frame < length &&
                key.value >= 0 &&
                key.value <= 30,
            ),
          ).toBe(true);
          if (
            length >= fps * 2 &&
            (id === "promo-punch" || id === "promo-zoom")
          ) {
            expect(animatedValue(created.clip, "rgbSplit", 0)).toBeGreaterThan(
              0,
            );
            expect(
              animatedValue(created.clip, "rgbSplit", Math.floor(length / 2)),
            ).toBe(0);
            expect(animatedValue(created.clip, "rgbSplit", length - 1)).toBe(0);
          }
        }
      }
    }
  });
});
