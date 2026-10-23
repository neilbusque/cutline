import { describe, expect, it } from "vitest";
import { applyAgentEdit, AgentEditSchema } from "../src/shared/agent-edit";
import { newProject, validateProject } from "../src/shared/model";
import {
  motionValue,
  motionEase,
  isMotionAccentLayer,
} from "../src/shared/motion";
import { applyCommands } from "../src/shared/commands";
import { resizeCanvas } from "../src/shared/canvas";

describe("professional motion through the editing bridge", () => {
  it("creates a retimed Studio scene and edits independent outgoing curves and typography atomically", () => {
    const p = newProject();
    const first = [0.2, 0, 0.8, 1],
      sibling = [0.16, 1, 0.3, 1];
    const result = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Studio motion",
      actions: [
        {
          type: "motion.scene",
          scene: "studio-title",
          at: { frame: 60 },
          durationFrames: 180,
          ref: "title",
        },
        {
          type: "motion.layer.update",
          motionId: "$title.motion",
          layer: 4,
          patch: {
            fontWeight: 500,
            letterSpacing: -2,
            lineHeight: 1.1,
            textRevealStart: 5,
            textRevealFrames: 21,
          },
        },
        {
          type: "motion.keyframe",
          motionId: "$title.motion",
          layer: 4,
          property: "x",
          frame: 0,
          value: 0,
          easing: "cubic-bezier",
          bezier: first,
        },
        {
          type: "motion.keyframe",
          motionId: "$title.motion",
          layer: 4,
          property: "x",
          frame: 30,
          value: 100,
        },
        {
          type: "motion.keyframe",
          motionId: "$title.motion",
          layer: 4,
          property: "opacity",
          frame: 0,
          value: 0,
          easing: "cubic-bezier",
          bezier: sibling,
        },
        {
          type: "motion.keyframe",
          motionId: "$title.motion",
          layer: 4,
          property: "opacity",
          frame: 30,
          value: 1,
        },
      ],
    });
    expect(p.clips).toHaveLength(0);
    const clip = result.project.clips.find(
      (clip) => clip.id === result.references.title,
    )!;
    expect(clip).toMatchObject({ start: 60, duration: 180 });
    const layer = result.project.motions[0].layers[4];
    expect(layer).toMatchObject({
      fontWeight: 500,
      letterSpacing: -2,
      lineHeight: 1.1,
      textRevealStart: 5,
      textRevealFrames: 21,
    });
    expect(
      layer.keyframes.find((key) => key.frame === 0 && key.x !== undefined)
        ?.bezier,
    ).toEqual(first);
    expect(
      layer.keyframes.find(
        (key) => key.frame === 0 && key.opacity !== undefined,
      )?.bezier,
    ).toEqual(sibling);
    expect(motionValue(layer, "x", 15)).toBeCloseTo(50);
    expect(motionValue(layer, "opacity", 15)).toBeCloseTo(
      motionEase(
        0.5,
        "cubic-bezier",
        sibling as [number, number, number, number],
      ),
    );
    expect(() =>
      validateProject(JSON.parse(JSON.stringify(result.project))),
    ).not.toThrow();
  });

  it("rejects invalid control handles before any scene addition is applied", () => {
    const p = newProject(),
      before = JSON.stringify(p);
    expect(() =>
      applyAgentEdit(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Invalid curve",
        actions: [
          {
            type: "motion.scene",
            scene: "studio-title",
            at: { frame: 0 },
            ref: "title",
          },
          {
            type: "motion.keyframe",
            motionId: "$title.motion",
            layer: 1,
            property: "x",
            frame: 0,
            value: 0,
            easing: "cubic-bezier",
            bezier: [-0.1, 1, 0.3, 1],
          },
        ],
      }),
    ).toThrow();
    expect(JSON.stringify(p)).toBe(before);
    expect(() =>
      AgentEditSchema.parse({
        projectId: p.id,
        revision: 0,
        label: "Invalid duration",
        actions: [
          {
            type: "motion.scene",
            scene: "studio-title",
            at: { frame: 0 },
            durationFrames: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("scales text tracking with canvas size while retaining curves, leading, reveal timing and accent choices", () => {
    const p = newProject();
    p.width = 640;
    p.height = 360;
    const result = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Create",
      actions: [
        { type: "motion.scene", scene: "studio-title", at: { frame: 0 } },
      ],
    });
    const old = result.project;
    const next = applyCommands(old, {
      projectId: old.id,
      revision: old.revision,
      label: "Resize",
      commands: resizeCanvas(old, 1280, 720),
    });
    for (const [index, layer] of next.motions[0].layers.entries()) {
      const prior = old.motions[0].layers[index];
      expect(layer.letterSpacing).toBeCloseTo(prior.letterSpacing * 2);
      expect(layer.lineHeight).toBe(prior.lineHeight);
      expect(layer.textRevealFrames).toBe(prior.textRevealFrames);
      expect(layer.musicAccent).toBe(prior.musicAccent);
      expect(layer.keyframes.map((key) => key.bezier)).toEqual(
        prior.keyframes.map((key) => key.bezier),
      );
    }
    expect(
      isMotionAccentLayer(
        { type: "rectangle", width: 100, height: 100, musicAccent: false },
        old,
      ),
    ).toBe(false);
    expect(
      isMotionAccentLayer(
        { type: "rectangle", width: 640, height: 360, musicAccent: true },
        old,
      ),
    ).toBe(false);
  });
});
