import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import { applyAgentEdit } from "../src/shared/agent-edit";
import { evaluatedClip } from "../src/shared/animation";
import {
  newProject,
  validateProject,
  type MotionLayer,
} from "../src/shared/model";
import {
  evaluatedMotionLayer,
  motionCounterText,
  motionTextLines,
  motionValue,
} from "../src/shared/motion";
import {
  createMotionScene,
  motionSceneCategories,
  motionScenes,
  premiumSceneIds,
} from "../src/shared/motion-presets";

function named(layers: MotionLayer[], name: string) {
  const layer = layers.find((item) => item.name === name);
  expect(layer, `Missing native layer ${name}`).toBeDefined();
  return layer!;
}

describe("explainer motion collection", () => {
  it("keeps every scene native, individually editable and inside portrait and landscape canvases", () => {
    expect(motionSceneCategories).toContain("Explainer motion");
    for (const [width, height] of [
      [1080, 1920],
      [1920, 1080],
      [320, 320],
      [3840, 3840],
      [320, 3840],
      [3840, 320],
    ]) {
      const p = { ...newProject(), width, height };
      for (const id of premiumSceneIds) {
        const created = createMotionScene(p, 17, id);
        expect(motionScenes.find((scene) => scene.id === id)?.category).toBe(
          "Explainer motion",
        );
        expect(created.motion.source).toBe(id);
        expect(created.clip.fontFamily).toBe("Helvetica");
        expect(
          new Set(created.motion.layers.map((layer) => layer.name)).size,
        ).toBe(created.motion.layers.length);
        for (const layer of created.motion.layers) {
          expect(layer.x).toBeGreaterThanOrEqual(0);
          expect(layer.y).toBeGreaterThanOrEqual(0);
          expect(layer.x + layer.width).toBeLessThanOrEqual(width + 0.0001);
          expect(layer.y + layer.height).toBeLessThanOrEqual(height + 0.0001);
          expect(layer.fontSize).toBeGreaterThanOrEqual(8);
          expect(layer.fontSize).toBeLessThanOrEqual(500);
        }
        const next = applyCommands(p, {
          projectId: p.id,
          revision: p.revision,
          label: "Add explainer",
          commands: created.commands,
        });
        expect(next.assets).toHaveLength(0);
        expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
      }
    }
  });

  it("keeps the displayed count equal to the visible quantity at every frame after retiming", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps, width: 1080, height: 1920 };
      for (const frames of [2, 37, 90, 120, 300, fps * 4, fps * 8]) {
        const { motion } = createMotionScene(p, 0, "explainer-count", {
          durationFrames: frames,
        });
        const quantity = named(motion.layers, "Quantity");
        const units = motion.layers.filter((layer) =>
          /^Task \d+ completed$/.test(layer.name ?? ""),
        );
        expect(units).toHaveLength(20);
        for (let frame = 0; frame < frames; frame++) {
          const visible = units.filter(
            (layer) => motionValue(layer, "opacity", frame) === 1,
          ).length;
          expect(
            visible,
            `fps ${fps}, duration ${frames}, frame ${frame}`,
          ).toBe(Number(motionCounterText(quantity, frame)));
        }
        expect(motionCounterText(quantity, frames - 1)).toBe("20");
      }
    }
  });

  it("preserves the route's endpoints and paired trace at all supported frame rates and durations", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      for (const frames of [2, 45, 90, 120, 300]) {
        const p = { ...newProject(), width: 1080, height: 1920, fps };
        const { motion } = createMotionScene(p, 0, "explainer-signal", {
          durationFrames: frames,
        });
        const packet = named(motion.layers, "Travelling request");
        const route = named(motion.layers, "Route drawn");
        expect(packet.motionPath?.autoOrient).toBe(true);
        const last = evaluatedMotionLayer(packet, frames - 1);
        expect(last.x + last.width / 2).toBeCloseTo(p.width * 0.78);
        expect(last.y + last.height / 2).toBeCloseTo(p.height * 0.72);
        expect(motionValue(packet, "pathProgress", frames - 1)).toBe(1);
        expect(motionValue(route, "trim", frames - 1)).toBe(1);
        for (let frame = 0; frame < frames; frame++) {
          expect(motionValue(packet, "pathProgress", frame)).toBeCloseTo(
            motionValue(route, "trim", frame),
          );
        }
      }
    }
  });

  it("retimes connected action while retaining readable title and result holds", () => {
    for (const fps of [30, 60] as const) {
      for (const frames of [90, 120, 300]) {
        const p = { ...newProject(), width: 1080, height: 1920, fps };
        const create = (id: (typeof premiumSceneIds)[number]) =>
          createMotionScene(p, 0, id, { durationFrames: frames });
        const signal = create("explainer-signal");
        const title = named(signal.motion.layers, "Signal title");
        const titleSettled =
          title.textRevealStart + title.textRevealFrames + title.staggerFrames;
        expect(titleSettled).toBeLessThanOrEqual(Math.ceil(frames * 0.18));
        // This short three-word title is fully readable for most of even a 1.5s scene.
        expect((frames - titleSettled) / fps).toBeGreaterThanOrEqual(1);
        expect(
          motionTextLines(title, title.text, titleSettled).every(
            (line) => line.progress === 1,
          ),
        ).toBe(true);

        const comparison = create("explainer-compare");
        const field = named(comparison.motion.layers, "Comparison wipe");
        const diagram = named(comparison.motion.layers, "Clear route");
        const afterTitle = named(comparison.motion.layers, "After title");
        const resultAt = Math.ceil((frames - 1) * 0.73);
        expect(motionValue(afterTitle, "reveal", resultAt)).toBe(1);
        for (let frame = resultAt; frame < frames; frame++) {
          expect(motionValue(afterTitle, "reveal", frame)).toBe(1);
          expect(motionValue(field, "reveal", frame)).toBe(1);
          expect(motionValue(diagram, "reveal", frame)).toBe(1);
        }
        // Hold the completed comparison for the final quarter instead of cutting
        // on its reveal. Very short requested runtimes necessarily shorten reading time.
        expect(frames - resultAt).toBeGreaterThanOrEqual(
          Math.floor(frames * 0.25),
        );
        expect(field.keyframes).toEqual(diagram.keyframes);

        const editorial = create("explainer-reveal");
        const payoff = named(editorial.motion.layers, "Editorial payoff");
        const settled =
          payoff.textRevealStart +
          payoff.textRevealFrames +
          payoff.staggerFrames * 2;
        expect(settled).toBeLessThanOrEqual(Math.ceil(frames * 0.48));
        expect(
          motionTextLines(payoff, payoff.text, settled).every(
            (line) => line.progress === 1,
          ),
        ).toBe(true);
        expect(frames - settled).toBeGreaterThanOrEqual(
          Math.floor(frames * 0.5),
        );

        const focus = create("explainer-focus");
        const focusedAt = Math.ceil((frames - 1) * 0.66);
        expect(evaluatedClip(focus.clip, focusedAt).scale).toBe(3.1);
        expect(evaluatedClip(focus.clip, frames - 1).scale).toBe(3.1);
      }
    }
  });

  it("wipes the replacement background and native diagram in one coordinate space", () => {
    for (const frames of [60, 120, 240]) {
      const p = { ...newProject(), width: 1080, height: 1920 };
      const { motion } = createMotionScene(p, 0, "explainer-compare", {
        durationFrames: frames,
      });
      const layers = ["Comparison wipe", "Clear route", "Clear nodes"].map(
        (name) => named(motion.layers, name),
      );
      for (const layer of layers) {
        expect(layer).toMatchObject({
          x: 0,
          y: 0,
          width: p.width,
          height: p.height,
          revealMask: "wipe-right",
        });
        expect(layer.keyframes).toEqual(layers[0].keyframes);
        expect(motionValue(layer, "reveal", 0)).toBe(0);
        expect(motionValue(layer, "reveal", frames - 1)).toBe(1);
      }
    }
  });

  it("zooms the whole editable diagram, preserving its central detail after trimming", () => {
    const p = { ...newProject(), width: 1080, height: 1920 };
    const { clip, motion } = createMotionScene(p, 0, "explainer-focus");
    expect(evaluatedClip(clip, 0).scale).toBe(1);
    expect(evaluatedClip(clip, clip.duration - 1).scale).toBe(3.1);
    const trimmed = {
      ...clip,
      animationOffset: 50,
      duration: clip.duration - 50,
    };
    expect(evaluatedClip(trimmed, 0).scale).toBe(evaluatedClip(clip, 50).scale);
    const detail = named(motion.layers, "Why plane");
    expect(detail.x + detail.width / 2).toBe(p.width / 2);
    expect(detail.y + detail.height / 2).toBe(p.height / 2);
    expect(
      motion.layers.filter((layer) => layer.type === "text").length,
    ).toBeGreaterThan(8);
  });

  it("creates and edits the new scenes in one ordinary assistant transaction", () => {
    const p = newProject();
    const { project, references } = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Compose a measured result",
      actions: [
        {
          type: "motion.scene",
          scene: "explainer-count",
          at: { frame: 0 },
          ref: "count",
        },
        {
          type: "motion.layer.update",
          motionId: "$count.motion",
          layer: 1,
          patch: {
            color: "#123456",
            counter: {
              from: 10,
              to: 30,
              startFrame: 0,
              durationFrames: 90,
              suffix: "%",
            },
          },
        },
      ],
    });
    const edited = project.motions.find(
      (motion) => motion.id === references["count.motion"],
    )!;
    expect(edited.layers[1].color).toBe("#123456");
    expect(motionCounterText(edited.layers[1], 119)).toBe("30%");
    expect(edited.layers[2].text).toBe("tasks completed");
    expect(p.motions).toHaveLength(0);
  });
});
