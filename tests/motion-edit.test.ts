import { describe, it, expect } from "vitest";
import { MotionLayerSchema, makeClip, newProject } from "../src/shared/model";
import { motionValue } from "../src/shared/motion";
import type { MotionBezier } from "../src/shared/motion";
import {
  upsertMotionKey,
  motionKeySeekFrame,
  moveMotionKey,
} from "../src/shared/motion-edit";
describe("motion curve editing", () => {
  it("moves only the last effective property key and merges compatible destination siblings", () => {
    const bezier: MotionBezier = [0.16, 1, 0.3, 1];
    const layer = MotionLayerSchema.parse({
      type: "rectangle",
      keyframes: [
        { frame: 0, x: -30, opacity: 0.2, easing: "hold" },
        { frame: 0, x: -10, y: 4, easing: "cubic-bezier", bezier },
        { frame: 8, rotate: 15, easing: "cubic-bezier", bezier },
        {
          frame: 20,
          x: 100,
          opacity: 0.8,
          y: 30,
          rotate: 90,
          easing: "linear",
        },
      ],
    });
    const before = structuredClone(layer);
    const siblings = ["opacity", "y", "rotate"] as const;
    const values = [0, 4, 8, 12, 19, 20].map((frame) =>
      siblings.map((p) => motionValue(layer, p, frame)),
    );
    const keys = moveMotionKey(layer, "x", 0, 8)!;
    expect(keys.filter((key) => key.frame === 8)).toHaveLength(1);
    expect(keys.find((key) => key.frame === 8)).toMatchObject({
      x: -10,
      rotate: 15,
      easing: "cubic-bezier",
      bezier,
    });
    expect(keys.some((key) => key.frame === 0 && key.x !== undefined)).toBe(
      false,
    );
    expect(
      [0, 4, 8, 12, 19, 20].map((frame) =>
        siblings.map((p) =>
          motionValue({ ...layer, keyframes: keys }, p, frame),
        ),
      ),
    ).toEqual(values);
    expect(layer).toEqual(before);
    keys.find((key) => key.frame === 8)!.bezier![1] = 0;
    expect(layer.keyframes[1].bezier).toEqual(bezier);
  });

  it("keeps incompatible destination easing in an independent sparse entry", () => {
    const layer = MotionLayerSchema.parse({
      type: "ellipse",
      loop: "cycle",
      loopFrames: 30,
      keyframes: [
        { frame: 0, opacity: 0, x: 0, easing: "hold" },
        { frame: 10, y: 6, easing: "linear" },
        {
          frame: 30,
          x: 100,
          easing: "cubic-bezier",
          bezier: [0.34, 1.56, 0.64, 1],
        },
      ],
    });
    const keys = moveMotionKey(layer, "x", 30, 10)!;
    expect(keys.filter((key) => key.frame === 10)).toHaveLength(2);
    expect(
      keys.find((key) => key.frame === 10 && key.x !== undefined),
    ).toMatchObject({
      x: 100,
      easing: "cubic-bezier",
      bezier: [0.34, 1.56, 0.64, 1],
    });
    expect(
      keys.find((key) => key.frame === 10 && key.y !== undefined),
    ).toMatchObject({ y: 6, easing: "linear" });
    expect(keys.some((key) => key.frame === 30)).toBe(false);
    expect(
      moveMotionKey({ ...layer, keyframes: keys }, "x", 10, 30)?.find(
        (key) => key.frame === 30,
      )?.x,
    ).toBe(100);
  });

  it("rejects conflicts, missing keys and invalid frames atomically, and keeps same-frame moves neutral", () => {
    const layer = MotionLayerSchema.parse({
      type: "line",
      keyframes: [
        { frame: 0, x: 5 },
        { frame: 20, x: 5 },
      ],
    });
    const before = structuredClone(layer);
    expect(moveMotionKey(layer, "x", 0, 20)).toBeNull();
    expect(moveMotionKey(layer, "opacity", 0, 10)).toBeNull();
    expect(moveMotionKey(layer, "x", 10, 10)).toBeNull();
    for (const frame of [-1, 0.5, Infinity, NaN, 864001]) {
      expect(moveMotionKey(layer, "x", 0, frame)).toBeNull();
      expect(moveMotionKey(layer, "x", frame, 10)).toBeNull();
    }
    expect(moveMotionKey(layer, "x", 0, 0)).toBe(layer.keyframes);
    expect(layer).toEqual(before);
  });

  it("rejects capacity growth but allows merging at the 100-key limit", () => {
    const layer = MotionLayerSchema.parse({
      type: "line",
      keyframes: Array.from({ length: 100 }, (_, frame) => ({
        frame,
        y: frame,
        ...(frame === 0 ? { x: 5 } : {}),
        easing: "linear",
      })),
    });
    const before = structuredClone(layer);
    expect(moveMotionKey(layer, "x", 0, 101)).toBeNull();
    const merged = moveMotionKey(layer, "x", 0, 99)!;
    expect(merged).toHaveLength(100);
    expect(merged.find((key) => key.frame === 99)).toMatchObject({
      x: 5,
      y: 99,
    });
    expect(layer).toEqual(before);
  });
  it("retains each sibling's custom easing handles across grouped and duplicate sparse keys", () => {
    const reveal: MotionBezier = [0.16, 1, 0.3, 1];
    const wipe: MotionBezier = [0.76, 0, 0.24, 1];
    const overshoot: MotionBezier = [0.25, 2, 0.75, 2];
    const layer = MotionLayerSchema.parse({
      type: "rectangle",
      keyframes: [
        {
          frame: 0,
          x: -10,
          opacity: 0,
          blur: 8,
          easing: "cubic-bezier",
          bezier: reveal,
        },
        { frame: 0, opacity: 0.2, easing: "cubic-bezier", bezier: wipe },
        { frame: 20, x: 100, opacity: 1, blur: 0 },
      ],
    });
    const before = [2, 6, 10, 14, 18].map((frame) => [
      motionValue(layer, "opacity", frame),
      motionValue(layer, "blur", frame),
    ]);
    const keys = upsertMotionKey(
      layer,
      "x",
      0,
      -20,
      "cubic-bezier",
      overshoot,
    )!;
    const edited = { ...layer, keyframes: keys };
    expect(
      [2, 6, 10, 14, 18].map((frame) => [
        motionValue(edited, "opacity", frame),
        motionValue(edited, "blur", frame),
      ]),
    ).toEqual(before);
    expect(keys.filter((key) => key.frame === 0)).toHaveLength(3);
    expect(
      keys.find((key) => key.x !== undefined && key.frame === 0)?.bezier,
    ).toEqual(overshoot);
    expect(
      keys.find((key) => key.opacity !== undefined && key.frame === 0)?.bezier,
    ).toEqual(wipe);
    expect(
      keys.find((key) => key.blur !== undefined && key.frame === 0)?.bezier,
    ).toEqual(reveal);
    expect(layer.keyframes[0].x).toBe(-10);
    keys.find((key) => key.x !== undefined && key.frame === 0)!.bezier![1] = 0;
    expect(overshoot).toEqual([0.25, 2, 0.75, 2]);
    expect(layer.keyframes[0].bezier).toEqual(reveal);
  });

  it("groups matching tuples and guards capacity when a new tuple separates a sibling curve", () => {
    const reveal: MotionBezier = [0.16, 1, 0.3, 1];
    const layer = MotionLayerSchema.parse({
      type: "line",
      keyframes: Array.from({ length: 100 }, (_, frame) => ({
        frame,
        x: frame,
        y: frame,
        easing: "cubic-bezier",
        bezier: reveal,
      })),
    });
    const keys = upsertMotionKey(layer, "x", 0, 5, "cubic-bezier", [
      ...reveal,
    ])!;
    expect(keys).toHaveLength(100);
    expect(keys[0]).toMatchObject({ x: 5, y: 0, bezier: reveal });
    expect(
      upsertMotionKey(layer, "x", 0, 5, "cubic-bezier", [0.76, 0, 0.24, 1]),
    ).toBeNull();
    expect(layer.keyframes[0]).toMatchObject({ x: 0, y: 0, bezier: reveal });
  });
  it("isolates selected property easing from sparse and grouped siblings", () => {
    for (const first of [
      [
        { frame: 0, x: 0, easing: "hold" },
        { frame: 0, opacity: 0, easing: "linear" },
      ],
      [{ frame: 0, x: 0, opacity: 0, easing: "linear" }],
    ]) {
      const layer = MotionLayerSchema.parse({
        type: "rectangle",
        keyframes: [
          ...first,
          { frame: 20, x: 100, opacity: 1, easing: "linear" },
        ],
      });
      const before = motionValue(layer, "opacity", 10);
      const keys = upsertMotionKey(layer, "x", 0, -20, "back")!;
      const edited = { ...layer, keyframes: keys };
      expect(motionValue(edited, "opacity", 10)).toBe(before);
      expect(keys.find((k) => k.frame === 0 && k.x !== undefined)?.easing).toBe(
        "back",
      );
    }
  });
  it("uses the last duplicate property value while retaining other curves", () => {
    const layer = MotionLayerSchema.parse({
      type: "ellipse",
      keyframes: [
        { frame: 0, x: 4, opacity: 0.1 },
        { frame: 0, x: 8 },
        { frame: 10, x: 20, opacity: 0.9 },
      ],
    });
    const keys = upsertMotionKey(layer, "rotate", 0, 20, "linear")!;
    expect(motionValue({ ...layer, keyframes: keys }, "x", 0)).toBe(8);
    expect(motionValue({ ...layer, keyframes: keys }, "opacity", 0)).toBe(0.1);
  });
  it("guards the key limit after independent-easing insertion", () => {
    const layer = MotionLayerSchema.parse({
      type: "line",
      keyframes: Array.from({ length: 100 }, (_, frame) => ({
        frame,
        x: frame,
        y: frame,
        easing: "linear",
      })),
    });
    expect(upsertMotionKey(layer, "x", 0, 5, "linear")).toHaveLength(100);
    expect(upsertMotionKey(layer, "x", 0, 5, "back")).toBeNull();
    expect(upsertMotionKey(layer, "x", 101, 5, "linear")).toBeNull();
  });
  it("seeks loop keys within trimmed clips without treating the endpoint as the start edit target", () => {
    const clip = {
      ...makeClip(newProject(), "text", "titles", 100),
      animationOffset: 145,
      duration: 70,
    };
    const cycle = MotionLayerSchema.parse({
      type: "line",
      loop: "cycle",
      loopFrames: 60,
      keyframes: [
        { frame: 0, x: 0 },
        { frame: 60, x: 100 },
      ],
    });
    expect(motionKeySeekFrame(cycle, clip, 0, 100)).toBe(135);
    expect(motionKeySeekFrame(cycle, clip, 60, 100)).toBe(135);
    const keys = upsertMotionKey(cycle, "x", 60, 75, "back")!;
    expect(keys.find((k) => k.frame === 0)?.x).toBe(0);
    expect(keys.find((k) => k.frame === 60)?.x).toBe(75);
    expect(
      motionKeySeekFrame({ ...cycle, loop: "ping-pong" }, clip, 45, 100),
    ).toBe(120);
  });
});
