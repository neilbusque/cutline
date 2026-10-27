import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionGraphicAtFrame } from "../src/composition/MotionGraphic";
import { applyAgentEdit } from "../src/shared/agent-edit";
import { applyCommands } from "../src/shared/commands";
import {
  MotionLayerSchema,
  MotionSchema,
  makeClip,
  newProject,
} from "../src/shared/model";
import {
  evaluatedMotionLayer,
  motionCounterText,
  motionLayerClipPath,
  motionValue,
} from "../src/shared/motion";
import { sampleMotionPath } from "../src/shared/motion-path";

const layer = (patch: Record<string, unknown> = {}) =>
  MotionLayerSchema.parse({ type: "text", ...patch });
const path = {
  points: [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 200, y: 100 },
    { x: 200, y: 0 },
  ],
  autoOrient: true,
};
const counter = {
  from: 0,
  to: 100,
  startFrame: 10,
  durationFrames: 20,
  easing: "linear",
};

describe("premium native motion", () => {
  it("keeps optional features absent from legacy saved layers and their evaluated pose", () => {
    const old = layer();
    for (const value of [old, evaluatedMotionLayer(old, 12)]) {
      expect(value).not.toHaveProperty("motionPath");
      expect(value).not.toHaveProperty("counter");
      expect(value).not.toHaveProperty("revealMask");
      expect(value).not.toHaveProperty("pathProgress");
      expect(value).not.toHaveProperty("reveal");
    }
    expect(motionValue(old, "reveal", 10)).toBe(1);
    expect(motionValue(old, "pathProgress", 10)).toBe(0);
    expect(motionLayerClipPath(old)).toBeUndefined();
  });

  it("rejects malformed paths, unbounded animation, and invalid counter configuration", () => {
    for (const patch of [
      { motionPath: { points: path.points.slice(0, 3) } },
      {
        motionPath: {
          points: [...path.points.slice(0, 3), { x: Infinity, y: 0 }],
        },
      },
      {
        motionPath: { points: [...path.points.slice(0, 3), { x: 4001, y: 0 }] },
      },
      { pathProgress: -0.1 },
      { reveal: 1.1 },
      { keyframes: [{ frame: 0, pathProgress: 2 }] },
      { keyframes: [{ frame: 0, reveal: -1 }] },
      { counter: { ...counter, durationFrames: 0 } },
      { counter: { ...counter, startFrame: -1 } },
      { counter: { ...counter, decimals: 7 } },
      { counter: { ...counter, from: NaN } },
      { counter: { ...counter, to: 1e13 } },
      { counter: { ...counter, prefix: "x".repeat(65) } },
      { counter, type: "rectangle" },
    ])
      expect(() => layer(patch)).toThrow();
  });

  it("follows a true Bezier curve, reaches its endpoints and adds placement/keyframe offsets", () => {
    const moving = layer({
      x: 20,
      y: 30,
      rotate: 5,
      motionPath: path,
      keyframes: [
        { frame: 0, pathProgress: 0, x: 10 },
        { frame: 30, pathProgress: 1, x: 10 },
      ],
    });
    expect(evaluatedMotionLayer(moving, 0)).toMatchObject({
      x: 30,
      y: 30,
      rotate: 95,
    });
    const middle = evaluatedMotionLayer(moving, 15);
    expect(middle.x).toBeCloseTo(130, 5);
    expect(middle.y).toBeCloseTo(105, 5);
    expect(middle.rotate).toBeCloseTo(5, 5);
    expect(evaluatedMotionLayer(moving, 30)).toMatchObject({
      x: 230,
      y: 30,
      rotate: -85,
    });
    expect(
      evaluatedMotionLayer(
        layer({ ...moving, motionPath: { ...path, autoOrient: false } }),
        0,
      ).rotate,
    ).toBe(5);
  });

  it("maps linear progress to distance, avoiding Bezier handle speed surges", () => {
    const straight = layer({
      motionPath: {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 1000, y: 0 },
        ],
      },
    }).motionPath!;
    for (const progress of [0, 0.1, 0.25, 0.5, 0.9, 1])
      expect(
        Math.abs(sampleMotionPath(straight, progress).x - progress * 1000),
      ).toBeLessThan(0.06);
  });

  it("handles coincident handles and zero-length paths without NaN or lost endpoint orientation", () => {
    const vertical = layer({
      motionPath: {
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 100 },
          { x: 0, y: 100 },
        ],
      },
    }).motionPath!;
    expect(sampleMotionPath(vertical, 0).angle).toBe(90);
    expect(sampleMotionPath(vertical, 1).angle).toBe(90);
    const still = layer({
      motionPath: { points: Array.from({ length: 4 }, () => ({ x: 8, y: 9 })) },
    }).motionPath!;
    for (const progress of [0, 0.5, 1, NaN])
      expect(sampleMotionPath(still, progress)).toEqual({
        x: 8,
        y: 9,
        angle: 0,
      });
  });

  it("applies every reveal direction locally and releases clipping at the full hold", () => {
    const directions = {
      "wipe-right": "inset(0 75% 0 0)",
      "wipe-left": "inset(0 0 0 75%)",
      "wipe-down": "inset(0 0 75% 0)",
      "wipe-up": "inset(75% 0 0 0)",
      iris: "circle(62.5px at 50% 50%)",
    };
    for (const [revealMask, expected] of Object.entries(directions)) {
      expect(
        motionLayerClipPath(
          layer({ revealMask, reveal: 0.25, width: 300, height: 400 }),
        ),
      ).toBe(expected);
      expect(
        motionLayerClipPath(layer({ revealMask, reveal: 1 })),
      ).toBeUndefined();
      expect(
        motionLayerClipPath(layer({ revealMask, reveal: 0 })),
      ).toBeDefined();
    }
    expect(
      motionLayerClipPath(layer({ revealMask: "none", reveal: 0 })),
    ).toBeUndefined();
  });

  it("uses the outgoing tangent at an interior cusp instead of flashing sideways", () => {
    const turn = layer({
      motionPath: {
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 100 },
          { x: 0, y: 100 },
          { x: 0, y: 0 },
        ],
      },
    }).motionPath!;
    expect(sampleMotionPath(turn, 0.49).angle).toBe(90);
    expect(sampleMotionPath(turn, 0.5).angle).toBe(-90);
    expect(sampleMotionPath(turn, 0.51).angle).toBe(-90);
  });

  it("bounds spring path/reveal progress without a clamp-and-rebound artifact", () => {
    const moving = layer({
      keyframes: [
        { frame: 0, reveal: 0, pathProgress: 0, easing: "spring" },
        { frame: 30, reveal: 1, pathProgress: 1 },
      ],
    });
    for (const property of ["reveal", "pathProgress"] as const) {
      let previous = -1;
      for (let frame = 0; frame <= 30; frame++) {
        const value = motionValue(moving, property, frame);
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(1);
        previous = value;
      }
    }
  });

  it("formats deterministic increasing/decreasing counters with exact holds and no negative zero", () => {
    const count = layer({
      counter: { ...counter, decimals: 2, prefix: "$", suffix: " saved" },
    });
    expect(motionCounterText(count, 0)).toBe("$0.00 saved");
    expect(motionCounterText(count, 20)).toBe("$50.00 saved");
    expect(motionCounterText(count, 30)).toBe("$100.00 saved");
    expect(motionCounterText(count, 300)).toBe("$100.00 saved");
    expect(
      motionCounterText(
        layer({ counter: { ...counter, from: 10, to: -10, decimals: 1 } }),
        25,
      ),
    ).toBe("-5.0");
    expect(
      motionCounterText(
        layer({ counter: { ...counter, from: -0.0001, to: 0, decimals: 2 } }),
        10,
      ),
    ).toBe("0.00");
    expect(evaluatedMotionLayer(count, 20).text).toBe("$50.00 saved");
  });

  it("preserves path, mask and counter phase across loops and out-of-order frame samples", () => {
    const moving = layer({
      motionPath: path,
      revealMask: "wipe-right",
      counter: { ...counter, startFrame: 0 },
      loop: "ping-pong",
      loopFrames: 30,
      keyframes: [
        { frame: 0, pathProgress: 0, reveal: 0 },
        { frame: 30, pathProgress: 1, reveal: 1 },
      ],
    });
    expect(evaluatedMotionLayer(moving, 45)).toEqual(
      evaluatedMotionLayer(moving, 15),
    );
    expect(evaluatedMotionLayer(moving, 60)).toEqual(
      evaluatedMotionLayer(moving, 0),
    );
    const cycle = { ...moving, loop: "cycle" as const };
    expect(evaluatedMotionLayer(cycle, 38)).toEqual(
      evaluatedMotionLayer(cycle, 8),
    );
    const first = evaluatedMotionLayer(moving, 12);
    evaluatedMotionLayer(moving, 28);
    expect(evaluatedMotionLayer(moving, 12)).toEqual(first);
  });

  it("keeps custom counter curves inside the authored numeric range", () => {
    for (const [from, to] of [
      [10, 90],
      [90, 10],
    ]) {
      const overshoot = layer({
        counter: {
          ...counter,
          from,
          to,
          easing: "cubic-bezier",
          bezier: [0.2, 3, 0.8, 3],
        },
      });
      const undershoot = layer({
        counter: {
          ...counter,
          from,
          to,
          easing: "cubic-bezier",
          bezier: [0.2, -2, 0.8, -2],
        },
      });
      expect(motionCounterText(overshoot, 20)).toBe(String(to));
      expect(motionCounterText(undershoot, 20)).toBe(String(from));
      for (let frame = 10; frame <= 30; frame++) {
        for (const count of [overshoot, undershoot]) {
          const value = Number(motionCounterText(count, frame));
          expect(value).toBeGreaterThanOrEqual(10);
          expect(value).toBeLessThanOrEqual(90);
        }
      }
    }
  });

  it("uses the same frame result in native markup after splitting a clip", () => {
    const p = newProject();
    const motion = MotionSchema.parse({
      id: "premium",
      name: "Premium",
      layers: [
        layer({
          motionPath: path,
          revealMask: "wipe-right",
          counter,
          keyframes: [
            { frame: 0, pathProgress: 0, reveal: 0 },
            { frame: 60, pathProgress: 1, reveal: 1 },
          ],
        }),
      ],
    });
    const clip = {
      ...makeClip(p, "text", "titles"),
      motionId: motion.id,
      preset: "custom" as const,
      duration: 90,
    };
    p.motions = [motion];
    p.clips = [clip];
    const original = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, { motion, c: clip, frame: 24 }),
    );
    const split = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Split",
      commands: [{ type: "clip.split", id: clip.id, frame: 20 }],
    });
    const after = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion,
        c: split.clips[1],
        frame: 4,
      }),
    );
    expect(after).toBe(original);
    expect(original).toContain("clip-path:inset(0 60% 0 0)");
    expect(original).toContain(">70<");
  });

  it("accepts the native fields through atomic assistant edits and rejects an invalid whole transaction", () => {
    const p = newProject();
    p.motions = [
      MotionSchema.parse({ id: "premium", name: "Premium", layers: [layer()] }),
    ];
    const run = (actions: unknown[]) =>
      applyAgentEdit(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Premium edit",
        actions,
      });
    const result = run([
      {
        type: "motion.layer.update",
        motionId: "premium",
        layer: 0,
        patch: { motionPath: path, revealMask: "iris", counter },
      },
      {
        type: "motion.keyframe",
        motionId: "premium",
        layer: 0,
        property: "pathProgress",
        frame: 0,
        value: 0,
      },
      {
        type: "motion.keyframe",
        motionId: "premium",
        layer: 0,
        property: "pathProgress",
        frame: 30,
        value: 1,
      },
      {
        type: "motion.keyframe",
        motionId: "premium",
        layer: 0,
        property: "reveal",
        frame: 0,
        value: 0,
      },
    ]);
    expect(result.project.motions[0].layers[0].motionPath).toEqual(path);
    expect(result.project.motions[0].layers[0].counter?.decimals).toBe(0);
    expect(result.project.revision).toBe(p.revision + 1);
    expect(p.motions[0].layers[0].motionPath).toBeUndefined();
    expect(() =>
      run([
        {
          type: "motion.layer.update",
          motionId: "premium",
          layer: 0,
          patch: { motionPath: path },
        },
        {
          type: "motion.keyframe",
          motionId: "premium",
          layer: 0,
          property: "pathProgress",
          frame: 30,
          value: 2,
        },
      ]),
    ).toThrow();
    expect(p.motions[0].layers[0].motionPath).toBeUndefined();
  });

  it("disables and re-enables paths and counters through JSON assistant patches", () => {
    const p = newProject();
    p.motions = [
      MotionSchema.parse({
        id: "premium",
        name: "Premium",
        layers: [
          layer({
            x: 10,
            y: 20,
            text: "Original text",
            motionPath: path,
            pathProgress: 1,
            counter,
          }),
        ],
      }),
    ];
    const update = (project: typeof p, patch: Record<string, unknown>) =>
      applyAgentEdit(
        project,
        JSON.parse(
          JSON.stringify({
            projectId: project.id,
            revision: project.revision,
            label: "Set optional motion",
            actions: [
              {
                type: "motion.layer.update",
                motionId: "premium",
                layer: 0,
                patch,
              },
            ],
          }),
        ),
      ).project;
    const disabled = update(p, { motionPath: null, counter: null });
    const off = disabled.motions[0].layers[0];
    expect(off.motionPath).toBeNull();
    expect(off.counter).toBeNull();
    expect(evaluatedMotionLayer(off, 30)).toMatchObject({
      x: 10,
      y: 20,
      text: "Original text",
    });
    const enabled = update(disabled, { motionPath: path, counter });
    expect(
      evaluatedMotionLayer(enabled.motions[0].layers[0], 30),
    ).toMatchObject({ x: 210, y: 20, text: "100" });
    expect(p.motions[0].layers[0].motionPath).toEqual(path);
    expect(p.motions[0].layers[0].counter).not.toBeNull();
  });
});
