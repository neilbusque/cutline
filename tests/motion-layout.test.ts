import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MotionLayerSchema, type MotionLayer } from "../src/shared/model";
import { motionValue, motionRevealStart } from "../src/shared/motion";
import {
  alignMotionLayers,
  distributeMotionLayers,
  motionLayerBounds,
  orderedMotionLayers,
  scaleMotionLayerTiming,
  shiftMotionLayerTiming,
} from "../src/shared/motion-layout";
const shape = (patch: Partial<z.input<typeof MotionLayerSchema>> = {}) =>
  MotionLayerSchema.parse({
    type: "rectangle",
    width: 100,
    height: 80,
    ...patch,
  });

describe("motion layer layout", () => {
  it("shifts and stretches a counter even when it has no keyframes", () => {
    const layer = shape({
      type: "text",
      counter: { from: 0, to: 20, startFrame: 12, durationFrames: 60 },
    });
    const shifted = shiftMotionLayerTiming([layer], [0], 8);
    expect(shifted.layers![0].counter).toMatchObject({
      startFrame: 20,
      durationFrames: 60,
    });
    const scaled = scaleMotionLayerTiming([layer], [0], 200);
    expect(scaled.layers![0].counter).toMatchObject({
      startFrame: 24,
      durationFrames: 120,
    });
    expect(shiftMotionLayerTiming([layer], [0], -13).error).toMatch(
      /before frame 0/,
    );
    expect(layer.counter?.startFrame).toBe(12);
  });
  it("measures scaled and rotated boxes around their native anchor", () => {
    const box = motionLayerBounds(
      shape({
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        rotate: 90,
        scale: 2,
        anchorX: 0,
        anchorY: 0,
      }),
      0,
    );
    expect(box.left).toBeCloseTo(-70);
    expect(box.top).toBeCloseTo(20);
    expect(box.right).toBeCloseTo(10);
    expect(box.bottom).toBeCloseTo(220);
  });
  it("aligns an animated pose without flattening its keyframes", () => {
    const layer = shape({
      x: 100,
      keyframes: [
        { frame: 0, x: 0, scale: 1, easing: "linear" },
        {
          frame: 20,
          x: 200,
          scale: 2,
          easing: "cubic-bezier",
          bezier: [0.16, 1, 0.3, 1],
        },
      ],
    });
    const before = structuredClone(layer);
    const result = alignMotionLayers(
      [layer],
      [0],
      { width: 1000, height: 500 },
      "right",
      "canvas",
      10,
    );
    expect(result.error).toBeUndefined();
    const aligned = result.layers![0];
    expect(motionLayerBounds(aligned, 10).right).toBeCloseTo(1000);
    expect(aligned.keyframes).toBe(layer.keyframes);
    expect(motionValue(aligned, "x", 4)).toBe(motionValue(layer, "x", 4));
    expect(layer).toEqual(before);
  });
  it.each([
    ["left", "left", 0],
    ["right", "right", 1000],
    ["top", "top", 0],
    ["bottom", "bottom", 500],
  ] as const)("aligns %s to the canvas", (alignment, edge, expected) => {
    const result = alignMotionLayers(
      [shape({ x: 40, y: 50 })],
      [0],
      { width: 1000, height: 500 },
      alignment,
      "canvas",
    );
    expect(motionLayerBounds(result.layers![0], 0)[edge]).toBeCloseTo(expected);
  });
  it("aligns centers and selection bounds while leaving excluded layers intact", () => {
    const layers = [
      shape({ x: 10, y: 20 }),
      shape({ x: 200, y: 300, width: 200, height: 50 }),
      shape({ x: 600 }),
    ];
    const result = alignMotionLayers(
      layers,
      [0, 1],
      { width: 1000, height: 500 },
      "center-x",
      "selection",
    );
    for (const item of result.layers!.slice(0, 2)) {
      const box = motionLayerBounds(item, 0);
      expect((box.left + box.right) / 2).toBe(205);
    }
    expect(result.layers![2]).toBe(layers[2]);
    const vertical = alignMotionLayers(
      layers,
      [1],
      { width: 1000, height: 500 },
      "center-y",
      "canvas",
    );
    const box = motionLayerBounds(vertical.layers![1], 0);
    expect((box.top + box.bottom) / 2).toBe(250);
  });
  it("distributes unequal sizes into equal gaps without moving endpoints", () => {
    const layers = [
      shape({ x: 50, width: 100 }),
      shape({ x: 220, width: 30 }),
      shape({ x: 700, width: 200 }),
      shape({ x: 500, width: 60 }),
    ];
    const before = structuredClone(layers);
    const result = distributeMotionLayers(layers, [3, 0, 2, 1], "x");
    expect(result.error).toBeUndefined();
    const boxes = result
      .layers!.map((layer) => motionLayerBounds(layer, 0))
      .sort((a, b) => a.left - b.left);
    const gaps = boxes.slice(1).map((box, i) => box.left - boxes[i].right);
    expect(gaps[0]).toBeCloseTo(gaps[1]);
    expect(gaps[1]).toBeCloseTo(gaps[2]);
    expect(result.layers![0].x).toBe(50);
    expect(result.layers![2].x).toBeCloseTo(700);
    expect(layers).toEqual(before);
  });
  it("distributes vertically and supports overlap without swapping layer order", () => {
    const layers = [
      shape({ y: 0, height: 100 }),
      shape({ y: 20, height: 100 }),
      shape({ y: 40, height: 100 }),
    ];
    const result = distributeMotionLayers(layers, [2, 0, 1], "y");
    expect(result.layers!.map((layer) => layer.y)).toEqual([0, 20, 40]);
  });
  it("rejects invalid selection and over-limit moves atomically", () => {
    const layers = [shape({ x: -3990, scale: 10 }), shape({ x: 20 })];
    const before = structuredClone(layers);
    expect(
      alignMotionLayers(
        layers,
        [0],
        { width: 10000, height: 500 },
        "right",
        "canvas",
      ).error,
    ).toMatch(/position limits/);
    expect(
      alignMotionLayers(
        layers,
        [0],
        { width: 100, height: 500 },
        "left",
        "selection",
      ).error,
    ).toBeTruthy();
    expect(
      alignMotionLayers(
        layers,
        [-1],
        { width: 100, height: 500 },
        "left",
        "canvas",
      ).error,
    ).toBeTruthy();
    expect(distributeMotionLayers(layers, [0, 0, 1], "x").error).toBeTruthy();
    expect(layers).toEqual(before);
  });
  it("uses loop phase at the chosen playhead for spatial order", () => {
    const layers = [
      shape({
        x: 0,
        loop: "cycle",
        loopFrames: 20,
        keyframes: [
          { frame: 0, x: 200 },
          { frame: 20, x: 0 },
        ],
      }),
      shape({ x: 100 }),
      shape({ x: 200 }),
    ];
    expect(orderedMotionLayers(layers, [1, 0, 2], "top-first", 35)).toEqual([
      2, 1, 0,
    ]);
    expect(orderedMotionLayers(layers, [1, 0, 2], "bottom-first", 35)).toEqual([
      0, 1, 2,
    ]);
    expect(orderedMotionLayers(layers, [1, 0, 2], "left-first", 35)).toEqual([
      0, 1, 2,
    ]);
  });
});

describe("motion layer choreography", () => {
  const animated = () =>
    shape({
      keyframes: [
        {
          frame: 10,
          x: -60,
          opacity: 0,
          easing: "cubic-bezier",
          bezier: [0.16, 1, 0.3, 1],
        },
        { frame: 10, scale: 0.6, easing: "spring" },
        { frame: 30, x: 0, opacity: 1, scale: 1, easing: "linear" },
      ],
    });
  it("offsets sparse keys and easings together while preserving other layers", () => {
    const layers = [animated(), animated(), shape()];
    const before = structuredClone(layers);
    const result = shiftMotionLayerTiming(layers, [1], -5);
    expect(result.error).toBeUndefined();
    expect(result.layers![1].keyframes.map((key) => key.frame)).toEqual([
      5, 5, 25,
    ]);
    expect(result.layers![1].keyframes[0].bezier).toEqual([0.16, 1, 0.3, 1]);
    expect(result.layers![1].keyframes[1].easing).toBe("spring");
    expect(result.layers![0]).toBe(layers[0]);
    expect(result.layers![2]).toBe(layers[2]);
    expect(layers).toEqual(before);
  });
  it("staggers in explicit order, skipping layers without animation", () => {
    const layers = [animated(), shape(), animated(), animated()];
    const result = shiftMotionLayerTiming(layers, [3, 1, 2, 0], 2, 4);
    expect(result.layers!.map((layer) => layer.keyframes[0]?.frame)).toEqual([
      20,
      undefined,
      16,
      12,
    ]);
  });
  it("rejects before-zero or loop shifts without partial results", () => {
    const layers = [
      animated(),
      shape({
        loop: "cycle",
        keyframes: [
          { frame: 0, scale: 0 },
          { frame: 30, scale: 1 },
        ],
      }),
    ];
    const before = structuredClone(layers);
    expect(shiftMotionLayerTiming(layers, [0, 1], 5).error).toMatch(
      /Play once/,
    );
    expect(shiftMotionLayerTiming(layers, [0], -11).error).toMatch(
      /before frame 0/,
    );
    expect(shiftMotionLayerTiming(layers, [0], 864000).error).toMatch(
      /timeline limit/,
    );
    expect(shiftMotionLayerTiming(layers, [0], 1.2).error).toMatch(
      /whole frames/,
    );
    expect(layers).toEqual(before);
  });
  it("moves masked text reveals with keys and word reveals with their opacity entrance", () => {
    const layers = [
      shape({
        type: "text",
        textAnimation: "line-reveal",
        textRevealStart: 10,
        textRevealFrames: 20,
      }),
      {
        ...animated(),
        type: "text" as const,
        textAnimation: "word-rise" as const,
      },
    ];
    const result = shiftMotionLayerTiming(layers, [0, 1], 5, 4);
    expect(result.layers![0].textRevealStart).toBe(15);
    expect(motionRevealStart(result.layers![1])).toBe(
      motionRevealStart(layers[1]) + 9,
    );
    expect(
      shiftMotionLayerTiming(
        [{ ...layers[1], keyframes: [{ frame: 0, x: 10, easing: "linear" }] }],
        [0],
        5,
      ).error,
    ).toMatch(/opacity entrance/);
  });
  it("stretches every curve while retaining distinct sparse easing and endpoint pose", () => {
    const layer = animated();
    const result = scaleMotionLayerTiming([layer], [0], 200);
    const changed = result.layers![0];
    expect(changed.keyframes.map((key) => key.frame)).toEqual([20, 20, 60]);
    expect(motionValue(changed, "x", 40)).toBeCloseTo(
      motionValue(layer, "x", 20),
    );
    expect(motionValue(changed, "scale", 40)).toBeCloseTo(
      motionValue(layer, "scale", 20),
    );
    expect(changed.keyframes.map((key) => key.easing)).toEqual(
      layer.keyframes.map((key) => key.easing),
    );
  });
  it("scales loop phase and masked line duration and spacing", () => {
    const layers = [
      shape({
        loop: "cycle",
        loopFrames: 60,
        keyframes: [
          { frame: 0, x: 0 },
          { frame: 60, x: 100 },
        ],
      }),
      shape({
        type: "text",
        textAnimation: "line-reveal",
        textRevealStart: 10,
        textRevealFrames: 20,
        staggerFrames: 4,
      }),
    ];
    const result = scaleMotionLayerTiming(layers, [0, 1], 150);
    expect(result.layers![0].loopFrames).toBe(90);
    expect(result.layers![0].keyframes[1].frame).toBe(90);
    expect(result.layers![1]).toMatchObject({
      textRevealStart: 15,
      textRevealFrames: 30,
      staggerFrames: 6,
    });
  });
  it("rejects merged property poses, native limits and missing animation atomically", () => {
    const layer = shape({
      keyframes: [
        { frame: 0, x: 0 },
        { frame: 1, x: 10 },
      ],
    });
    const before = structuredClone(layer);
    expect(scaleMotionLayerTiming([layer], [0], 10).error).toMatch(
      /merge keyframes/,
    );
    expect(
      scaleMotionLayerTiming(
        [shape({ ...animated(), loop: "cycle", loopFrames: 1000 })],
        [0],
        200,
      ).error,
    ).toMatch(/limits/);
    expect(scaleMotionLayerTiming([shape()], [0], 100).error).toMatch(
      /Add keyframes/,
    );
    expect(scaleMotionLayerTiming([layer], [0], NaN).error).toMatch(/10%/);
    expect(layer).toEqual(before);
  });
  it("allows disjoint sparse properties to share a rounded frame without losing any curve", () => {
    const layer = shape({
      keyframes: [
        { frame: 0, x: 10, easing: "hold" },
        { frame: 1, y: 20, easing: "spring" },
        { frame: 20, x: 0, y: 0 },
      ],
    });
    const result = scaleMotionLayerTiming([layer], [0], 10);
    expect(result.layers![0].keyframes.slice(0, 2)).toEqual([
      { frame: 0, x: 10, easing: "hold" },
      { frame: 0, y: 20, easing: "spring" },
    ]);
  });
});
