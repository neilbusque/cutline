import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionGraphicAtFrame } from "../src/composition/MotionGraphic";
import { applyCommands } from "../src/shared/commands";
import {
  MotionLayerSchema,
  MotionSchema,
  MusicReactiveSchema,
  makeClip,
  newProject,
  validateProject,
} from "../src/shared/model";
import {
  evaluatedMotionLayer,
  defaultMotionBezier,
  entranceFadeBezier,
  settleBezier,
  isMotionAccentLayer,
  motionEase,
  motionFrame,
  motionShapePath,
  motionTextTokens,
  motionTextLines,
  motionValue,
} from "../src/shared/motion";
import { trimClip } from "../src/shared/timeline";

const layer = (patch: Record<string, unknown> = {}) =>
  MotionLayerSchema.parse({ type: "rectangle", ...patch });
/** Letters fade in on an ease-out curve. */
const letterFade = (progress: number) =>
  motionEase(progress, "cubic-bezier", entranceFadeBezier);

describe("motion schema and curves", () => {
  it("opens legacy projects with bounded static defaults and optional animation", () => {
    const old = layer({
      keyframes: [
        { frame: 0, x: 0 },
        { frame: 18, x: 50 },
      ],
    });
    expect(old).toMatchObject({
      opacity: 1,
      scale: 1,
      rotate: 0,
      stroke: "#ffffff",
      strokeWidth: 0,
      fillStyle: "solid",
      gradientColor: "#6c5ce7",
      gradientAngle: 135,
      glow: 0,
      blur: 0,
      trim: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      textAnimation: "none",
      staggerFrames: 2,
      loop: "none",
      loopFrames: 60,
      hidden: false,
      letterSpacing: 0,
      lineHeight: 1.18,
      textRevealStart: 0,
      textRevealFrames: 18,
    });
    expect(old.fontWeight).toBeUndefined();
    expect(old.name).toBeUndefined();
    expect(old.align).toBeUndefined();
    expect(old.keyframes[0].easing).toBe("linear");
    expect(motionValue(old, "x", 4.5)).toBe(12.5);
    expect(layer().keyframes).toEqual([]);
    for (const type of [
      "text",
      "rectangle",
      "ellipse",
      "triangle",
      "star",
      "line",
    ])
      expect(layer({ type }).type).toBe(type);
    for (const invalid of [
      { opacity: 2 },
      { trim: -1 },
      { blur: 101 },
      { strokeWidth: 101 },
      { anchorX: 1.1 },
      { loopFrames: 0 },
      { staggerFrames: 31 },
      { keyframes: [{ frame: 0, trim: 2 }] },
      { name: "x".repeat(81) },
      { hidden: "yes" },
    ])
      expect(() => layer(invalid)).toThrow();
  });

  it("accepts bounded typography and custom curves while keeping music scope optional", () => {
    const typography = layer({
      type: "text",
      fontWeight: 500,
      align: "left",
      letterSpacing: -1.5,
      lineHeight: 1.05,
      textAnimation: "line-reveal",
      textRevealStart: 12,
      textRevealFrames: 30,
      keyframes: [
        { frame: 0, x: 0, easing: "cubic-bezier", bezier: [0, -2, 1, 3] },
      ],
    });
    expect(typography.keyframes[0].bezier).toEqual([0, -2, 1, 3]);
    expect(
      MusicReactiveSchema.parse({ musicClipId: "music" }).scope,
    ).toBeUndefined();
    expect(
      MusicReactiveSchema.parse({ musicClipId: "music", scope: "accents" })
        .scope,
    ).toBe("accents");
    for (const invalid of [
      { fontWeight: 99 },
      { fontWeight: 901 },
      { fontWeight: 500.5 },
      { align: "justified" },
      { letterSpacing: -31 },
      { letterSpacing: 101 },
      { lineHeight: 0.79 },
      { lineHeight: 2.41 },
      { textRevealStart: -1 },
      { textRevealFrames: 0 },
      { textRevealFrames: 1801 },
      ...[
        [0, 0, 1],
        [-0.01, 0, 1, 1],
        [0, 0, 1.01, 1],
        [0, -2.01, 1, 1],
        [0, 0, 1, 3.01],
        [NaN, 0, 1, 1],
      ].map((bezier) => ({
        keyframes: [{ frame: 0, x: 0, easing: "cubic-bezier", bezier }],
      })),
    ])
      expect(() => layer(invalid)).toThrow();
  });

  it("solves cubic time for flat and reversed handles, preserves endpoints and allows overshoot", () => {
    const coordinate = (u: number, a: number, b: number) =>
      3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u ** 2 * b + u ** 3;
    for (const bezier of [
      [0, 0, 0, 1],
      [1, 0, 1, 1],
      [1, 0, 0, 1],
      [0.76, 0, 0.24, 1],
    ] as [number, number, number, number][]) {
      for (const u of [0, 0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999, 1]) {
        const x = coordinate(u, bezier[0], bezier[2]);
        const y = coordinate(u, bezier[1], bezier[3]);
        expect(motionEase(x, "cubic-bezier", bezier)).toBeCloseTo(y, 7);
      }
    }
    expect(motionEase(0.5, "cubic-bezier")).toBeCloseTo(
      motionEase(0.5, "cubic-bezier", defaultMotionBezier),
      12,
    );
    expect(
      motionEase(0.4, "cubic-bezier", [1 / 3, 1 / 3, 2 / 3, 2 / 3]),
    ).toBeCloseTo(0.4, 12);
    expect(motionEase(0.5, "cubic-bezier", [0, 3, 1, 3])).toBeGreaterThan(1);
    expect(motionEase(0.5, "cubic-bezier", [0, -2, 1, -2])).toBeLessThan(0);
    for (const t of [-Infinity, -1, 0, 1, 2, Infinity])
      expect(motionEase(t, "cubic-bezier", [0, 3, 1, 3])).toBe(t <= 0 ? 0 : 1);
    expect(motionEase(NaN, "cubic-bezier")).toBe(0);
    expect(motionEase(0.5, "cubic-bezier", [NaN, 0, 1, 1])).toBe(
      motionEase(0.5, "cubic-bezier"),
    );
  });

  it("keeps outgoing custom handles per sparse duplicate curve and clamps visual overshoot", () => {
    const custom = layer({
      keyframes: [
        {
          frame: 0,
          x: 0,
          opacity: 0,
          easing: "cubic-bezier",
          bezier: [0, 3, 1, 3],
        },
        { frame: 0, x: 10, easing: "cubic-bezier", bezier: [0, 0, 1, 1] },
        {
          frame: 20,
          x: 100,
          opacity: 1,
          easing: "cubic-bezier",
          bezier: [1, -2, 0, -2],
        },
      ],
    });
    expect(motionValue(custom, "x", 10)).toBeCloseTo(55, 10);
    expect(motionValue(custom, "opacity", 10)).toBe(1);
    const position = layer({
      keyframes: [
        { frame: 0, x: 0, easing: "cubic-bezier", bezier: [0, 3, 1, 3] },
        { frame: 20, x: 100 },
      ],
    });
    expect(motionValue(position, "x", 10)).toBeGreaterThan(100);
    expect(motionValue(custom, "x", 20)).toBe(100);
  });

  it("keeps static position plus animated movement offsets without mutating the source", () => {
    const shape = layer({
      x: 200,
      y: 90,
      opacity: 0.7,
      scale: 1.2,
      rotate: 12,
      keyframes: [
        { frame: 0, x: -100, easing: "linear" },
        { frame: 20, x: 0 },
      ],
    });
    expect(motionValue(shape, "x", 10)).toBe(-50);
    expect(motionValue(shape, "y", 10)).toBe(0);
    expect(evaluatedMotionLayer(shape, 10)).toMatchObject({
      x: 150,
      y: 90,
      opacity: 0.7,
      scale: 1.2,
      rotate: 12,
    });
    expect(shape.x).toBe(200);
    expect(
      [-1, 0, 10, 20, 99].map((frame) => motionValue(shape, "x", frame)),
    ).toEqual([-100, -100, -50, 0, 0]);
  });

  it("uses outgoing easing and keeps hold values until the exact next key", () => {
    const shape = layer({
      keyframes: [
        { frame: 0, x: 0, opacity: 0, easing: "hold" },
        { frame: 20, x: 100, opacity: 1, easing: "linear" },
      ],
    });
    expect(motionValue(shape, "x", 19)).toBe(0);
    expect(motionValue(shape, "x", 20)).toBe(100);
    expect(
      motionValue(
        layer({
          keyframes: [
            { frame: 0, x: 0, easing: "ease-in" },
            { frame: 20, x: 100, easing: "ease-out" },
          ],
        }),
        "x",
        5,
      ),
    ).toBe(6.25);
    expect(motionEase(0.25, "ease-in")).toBe(0.0625);
    expect(motionEase(0.25, "ease-out")).toBe(0.4375);
    expect(motionEase(0.5, "ease-in-out")).toBe(0.5);
    for (const easing of ["spring", "back"] as const) {
      expect(motionEase(0, easing)).toBe(0);
      expect(motionEase(1, easing)).toBe(1);
      expect(
        Math.max(
          ...[0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((t) => motionEase(t, easing)),
        ),
      ).toBeGreaterThan(1);
    }
  });

  it("normalizes unordered and duplicate keys per property with the last specified value winning", () => {
    const shape = layer({
      keyframes: [
        { frame: 20, x: 100 },
        { frame: 0, x: -10, opacity: 0, easing: "linear" },
        { frame: 0, x: 0, easing: "linear" },
        { frame: 20, opacity: 1 },
      ],
    });
    expect(motionValue(shape, "x", 0)).toBe(0);
    expect(motionValue(shape, "x", 10)).toBe(50);
    expect(motionValue(shape, "opacity", 10)).toBe(0.5);
    const p = newProject();
    p.motions = [
      MotionSchema.parse({
        id: "duplicate-frames",
        name: "Compatible keys",
        layers: [shape],
      }),
    ];
    expect(validateProject(p).motions[0].layers[0].keyframes).toHaveLength(4);
  });

  it("allows position overshoot, clamps scale and stroke, and settles amounts without a bounce", () => {
    const shape = layer({
      keyframes: [
        {
          frame: 0,
          x: 0,
          opacity: 0,
          scale: 0,
          blur: 0,
          trim: 0,
          strokeWidth: 0,
          easing: "back",
        },
        {
          frame: 20,
          x: 100,
          opacity: 1,
          scale: 10,
          blur: 100,
          trim: 1,
          strokeWidth: 100,
        },
      ],
    });
    const at = evaluatedMotionLayer(shape, 10);
    expect(at.x).toBeGreaterThan(100);
    expect(at).toMatchObject({ scale: 10, strokeWidth: 100 });
    // Opacity, blur and trim take back's timing without overshooting and clamping.
    const settled = motionEase(0.5, "cubic-bezier", settleBezier);
    expect(at.opacity).toBeCloseTo(settled);
    expect(at.blur).toBeCloseTo(100 * settled);
    expect(at.trim).toBeCloseTo(settled);
    expect(evaluatedMotionLayer(shape, 0)).toMatchObject({
      opacity: 0,
      scale: 0,
      blur: 0,
      trim: 0,
      strokeWidth: 0,
    });
  });
});

describe("motion time and text", () => {
  it("reveals individual lines with delayed stagger, exact loop phase and no legacy token timing change", () => {
    const text = layer({
      type: "text",
      textAnimation: "line-reveal",
      textRevealStart: 5,
      textRevealFrames: 20,
      staggerFrames: 4,
    });
    const source = "First  line\r\n\r\nLast line";
    expect(
      motionTextLines(text, source, 5).map((line) => line.progress),
    ).toEqual([0, 0, 0]);
    expect(
      motionTextLines(text, source, 15).map((line) => line.progress),
    ).toEqual([0.5, 0.3, 0.1]);
    expect(motionTextLines(text, source, 15).map((line) => line.text)).toEqual([
      "First  line",
      "",
      "Last line",
    ]);
    expect(
      motionTextLines(text, source, 33).every(
        (line) => line.progress === 1 && line.y === 0,
      ),
    ).toBe(true);
    expect(motionTextLines(text, source, 4)[0].y).toBe(105);
    const cyclic = { ...text, loop: "cycle" as const, loopFrames: 40 };
    expect(motionTextLines(cyclic, source, 55)).toEqual(
      motionTextLines(text, source, 15),
    );
    const pingPong = { ...text, loop: "ping-pong" as const, loopFrames: 40 };
    expect(motionTextLines(pingPong, source, 65)).toEqual(
      motionTextLines(text, source, 15),
    );
    const legacy = { ...text, textAnimation: "character-rise" as const };
    expect(
      motionTextTokens(legacy, "AB", 12).map((token) => token.opacity),
    ).toEqual([1, letterFade(2 / 3)]);
  });

  it("preserves line reveal masks and typography through a clip split", () => {
    const p = newProject();
    const motion = MotionSchema.parse({
      id: "line-reveal",
      name: "Editorial reveal",
      layers: [
        {
          type: "text",
          text: "MOVE\nTOGETHER",
          textAnimation: "line-reveal",
          textRevealStart: 8,
          textRevealFrames: 28,
          staggerFrames: 6,
          fontWeight: 500,
          align: "left",
          letterSpacing: -1.25,
          lineHeight: 1.05,
        },
      ],
    });
    p.motions = [motion];
    const clip = {
      ...makeClip(p, "text", "titles"),
      preset: "custom" as const,
      motionId: motion.id,
    };
    p.clips = [clip];
    const original = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, { motion, c: clip, frame: 24 }),
    );
    const after = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Split reveal",
      commands: [{ type: "clip.split", id: clip.id, frame: 20 }],
    });
    const right = after.clips[1];
    expect(
      renderToStaticMarkup(
        React.createElement(MotionGraphicAtFrame, {
          motion,
          c: right,
          frame: 4,
        }),
      ),
    ).toBe(original);
    expect(original).toContain('data-motion-line="0"');
    expect(original).toContain('data-motion-line="1"');
    expect(original.match(/overflow:hidden/g)).toHaveLength(2);
    expect(original).toContain("font-weight:500");
    expect(original).toContain("text-align:left");
    expect(original).toContain("line-height:1.05");
    expect(original).toContain("letter-spacing:-1.25px");
    expect(original).not.toContain("blur(");
  });
  it("cycles and ping-pongs on predictable endpoints", () => {
    const shape = layer({
      loop: "cycle",
      loopFrames: 20,
      keyframes: [
        { frame: 0, x: 0, easing: "linear" },
        { frame: 20, x: 100 },
      ],
    });
    expect(
      [0, 10, 19, 20, 25, 40].map((frame) => motionValue(shape, "x", frame)),
    ).toEqual([0, 50, 95, 0, 25, 0]);
    const reverse = { ...shape, loop: "ping-pong" as const };
    expect(
      [0, 10, 20, 25, 30, 40, 50].map((frame) =>
        motionValue(reverse, "x", frame),
      ),
    ).toEqual([0, 50, 100, 75, 50, 0, 50]);
    expect(motionFrame(reverse, -10)).toBe(0);
    expect(motionFrame(reverse, Number.NaN)).toBe(0);
  });

  it("preserves custom motion phase across left trim and split, including loops and text", () => {
    const p = newProject();
    const shape = layer({
      loop: "ping-pong",
      loopFrames: 30,
      textAnimation: "character-rise",
      text: "MOVE",
      keyframes: [
        { frame: 0, x: 0, easing: "linear" },
        { frame: 30, x: 90 },
      ],
    });
    const motion = MotionSchema.parse({
      id: "motion",
      name: "Phase test",
      layers: [shape],
    });
    p.motions = [motion];
    const clip = {
      ...makeClip(p, "text", "titles"),
      preset: "custom" as const,
      motionId: motion.id,
    };
    p.clips = [clip];
    const original = motionValue(shape, "x", 47);
    const trimmed = trimClip(p, clip, "left", 35);
    expect(motionValue(shape, "x", 12 + trimmed.animationOffset)).toBe(
      original,
    );
    const split = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Split motion",
      commands: [{ type: "clip.split", id: clip.id, frame: 35 }],
    });
    const right = split.clips[1];
    expect(motionValue(shape, "x", 12 + right.animationOffset)).toBe(original);
    const markup = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion,
        c: right,
        frame: 12,
      }),
    );
    expect(markup).toContain(`left:${original}px`);
    expect(motionTextTokens(shape, "MOVE", 12 + right.animationOffset)).toEqual(
      motionTextTokens(shape, "MOVE", 47),
    );
  });

  it("staggered character/word reveals keep spaces and use layer loop time", () => {
    const characters = layer({
      type: "text",
      textAnimation: "character-rise",
      staggerFrames: 3,
    });
    expect(motionTextTokens(characters, "AB", 0).map((t) => t.opacity)).toEqual(
      [0, 0],
    );
    expect(
      motionTextTokens(characters, "AB", 12).map((t) => t.opacity),
    ).toEqual([1, letterFade(0.75)]);
    expect(
      motionTextTokens(characters, "AB", 30).every(
        (t) => t.opacity === 1 && t.y === 0 && t.blur === 0,
      ),
    ).toBe(true);
    const words = layer({
      type: "text",
      textAnimation: "word-rise",
      staggerFrames: 6,
    });
    const tokens = motionTextTokens(words, "Hello  world\nnow", 6);
    expect(tokens.map((t) => t.text).join("")).toBe("Hello  world\nnow");
    expect(
      tokens.filter((t) => /\S/u.test(t.text)).map((t) => t.opacity),
    ).toEqual([letterFade(0.5), 0, 0]);
    const typewriter = layer({
      type: "text",
      textAnimation: "typewriter",
      staggerFrames: 2,
      loop: "cycle",
      loopFrames: 12,
    });
    expect(
      motionTextTokens(typewriter, "A🌟B", 2).map((t) => t.opacity),
    ).toEqual([1, 1, 0]);
    expect(
      motionTextTokens(typewriter, "A🌟B", 12).map((t) => t.opacity),
    ).toEqual([1, 0, 0]);
  });
});

describe("shared motion rendering", () => {
  it("preserves named hidden layers without rendering them or assigning them music accents", () => {
    const motion = MotionSchema.parse({
      id: "named-layers",
      name: "Named layers",
      layers: [
        {
          type: "text",
          name: "Headline",
          hidden: true,
          text: "HIDDEN HEADLINE",
        },
        {
          type: "ellipse",
          name: "Quiet accent",
          hidden: true,
          background: "#ff0000",
          width: 10,
          height: 10,
        },
        { type: "text", name: "Visible label", text: "VISIBLE LABEL" },
        {
          type: "line",
          name: "Visible accent",
          strokeWidth: 2,
          width: 100,
          height: 10,
        },
      ],
    });
    const clip = makeClip(newProject(), "text", "titles");
    const markup = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion,
        c: clip,
        frame: 0,
        accentPulse: { scale: 1.1, glow: 8 },
      }),
    );
    expect(markup).not.toContain("HIDDEN HEADLINE");
    expect(markup).not.toContain('data-motion-layer="0"');
    expect(markup).not.toContain('data-motion-layer="1"');
    expect(markup).toContain('data-motion-layer="2"');
    expect(markup).toContain('data-motion-layer="3"');
    expect(markup).toContain("VISIBLE LABEL");
    expect(isMotionAccentLayer(motion.layers[1], clip)).toBe(false);
    expect(isMotionAccentLayer(motion.layers[3], clip)).toBe(true);
    expect(motion.layers[0]).toMatchObject({
      name: "Headline",
      hidden: true,
      text: "HIDDEN HEADLINE",
    });
    expect(MotionSchema.parse(JSON.parse(JSON.stringify(motion)))).toEqual(
      motion,
    );
  });
  it("inherits legacy clip typography when layer overrides are absent", () => {
    const motion = MotionSchema.parse({
      id: "legacy-type",
      name: "Legacy type",
      layers: [{ type: "text", text: "Same style" }],
    });
    const clip = {
      ...makeClip(newProject(), "text", "titles"),
      fontWeight: "600" as const,
      align: "right" as const,
    };
    const markup = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, { motion, c: clip, frame: 0 }),
    );
    expect(markup).toContain("font-weight:600");
    expect(markup).toContain("text-align:right");
    expect(markup).toContain("justify-content:flex-end");
    expect(markup).toContain("line-height:1.18");
    expect(markup).toContain("letter-spacing:0");
  });

  it("limits music accent pulses to smaller graphical layers and composes them with keyed motion", () => {
    const canvas = { width: 1000, height: 1000 };
    expect(
      isMotionAccentLayer(
        layer({ type: "text", width: 10, height: 10 }),
        canvas,
      ),
    ).toBe(false);
    expect(
      isMotionAccentLayer(layer({ width: 650, height: 1000 }), canvas),
    ).toBe(false);
    for (const type of [
      "rectangle",
      "ellipse",
      "triangle",
      "star",
      "line",
    ] as const)
      expect(
        isMotionAccentLayer(layer({ type, width: 649, height: 1000 }), canvas),
      ).toBe(true);
    const motion = MotionSchema.parse({
      id: "accents",
      name: "Graphic accents",
      layers: [
        {
          type: "rectangle",
          width: 1000,
          height: 1000,
          background: "#111111",
          scale: 1.1,
        },
        { type: "text", width: 10, height: 10, text: "Stay calm", scale: 0.9 },
        {
          type: "ellipse",
          width: 100,
          height: 100,
          background: "#abcdef",
          glow: 96,
          keyframes: [
            { frame: 0, scale: 1 },
            { frame: 20, scale: 2 },
          ],
        },
      ],
    });
    const clip = { ...makeClip(newProject(), "text", "titles"), ...canvas };
    const render = (accentPulse?: { scale: number; glow: number }) =>
      renderToStaticMarkup(
        React.createElement(MotionGraphicAtFrame, {
          motion,
          c: clip,
          frame: 10,
          accentPulse,
        }),
      );
    expect(render({ scale: 1, glow: 0 })).toBe(render());
    const markup = render({ scale: 1.2, glow: 12 });
    const wrapperStyles = [
      ...markup.matchAll(
        /data-motion-layer="(\d+)" data-motion-type="[^"]+" style="([^"]+)"/g,
      ),
    ].map((match) => match[2]);
    expect(wrapperStyles).toHaveLength(3);
    expect(wrapperStyles[0]).toContain("scale(1.1)");
    expect(wrapperStyles[1]).toContain("scale(0.9)");
    expect(wrapperStyles[0]).not.toContain("drop-shadow");
    expect(wrapperStyles[1]).not.toContain("drop-shadow");
    expect(wrapperStyles[2]).toContain(`scale(${1.5 * 1.2})`);
    expect(wrapperStyles[2]).toContain("drop-shadow(0 0 100px #abcdef)");
  });
  it("uses true vector fills and outlines, gradients, stroke trim, glow and anchor transforms", () => {
    const motion = MotionSchema.parse({
      id: "scene",
      name: "Vector scene",
      layers: [
        {
          type: "star",
          background: "#abcdef",
          fillStyle: "gradient",
          gradientColor: "#663399",
          width: 200,
          height: 200,
          strokeWidth: 6,
          stroke: "#ffcc00",
          glow: 12,
          anchorX: 0,
          anchorY: 1,
          rotate: 30,
        },
        {
          type: "line",
          width: 240,
          height: 10,
          strokeWidth: 4,
          keyframes: [
            { frame: 0, trim: 0, easing: "linear" },
            { frame: 20, trim: 1 },
          ],
        },
      ],
    });
    const clip = makeClip(newProject(), "text", "titles");
    const markup = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, { motion, c: clip, frame: 10 }),
    );
    expect(markup).toContain("<linearGradient");
    expect(markup).toContain('stop-color="#abcdef"');
    expect(markup).toContain('stop-color="#663399"');
    expect(markup).toContain('fill="url(#motion-gradient-');
    expect(markup).toContain('stroke="#ffcc00"');
    expect(markup).toContain('stroke-width="6"');
    expect(markup).toContain("transform-origin:0% 100%");
    expect(markup).toContain("drop-shadow(0 0 12px #abcdef)");
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('pathLength="1"');
    expect(markup).toContain('stroke-dashoffset="0.5"');
    expect(markup).not.toContain("NaN");
  });

  it("renders text outlines and gradient fill with staggered spans", () => {
    const motion = MotionSchema.parse({
      id: "text",
      name: "Animated text",
      layers: [
        {
          type: "text",
          text: "GO",
          textAnimation: "character-rise",
          fillStyle: "gradient",
          strokeWidth: 2,
          stroke: "#101010",
          blur: 3,
        },
      ],
    });
    const markup = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion,
        c: makeClip(newProject(), "text", "titles"),
        frame: 6,
      }),
    );
    expect(markup).toContain("linear-gradient(135deg, #ffffff, #6c5ce7)");
    expect(markup).toContain("-webkit-text-stroke:2px #101010");
    expect(markup).toContain(`opacity:${letterFade(0.5)}`);
    expect(markup).toContain("filter:blur(3px)");
  });

  it("keeps outlined gradient shapes unfilled when the user clears their fill", () => {
    const motion = MotionSchema.parse({
      id: "outline",
      name: "Outline only",
      layers: [
        {
          type: "ellipse",
          background: "transparent",
          fillStyle: "gradient",
          strokeWidth: 6,
          stroke: "#44ffaa",
        },
      ],
    });
    const markup = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion,
        c: makeClip(newProject(), "text", "titles"),
        frame: 0,
      }),
    );
    expect(markup).toContain('fill="none"');
    expect(markup).not.toContain('fill="url(');
    expect(markup).toContain('stroke="#44ffaa"');
  });

  it("preserves actual line breaks and spaces in staggered text layout", () => {
    const motion = MotionSchema.parse({
      id: "multiline",
      name: "Multiline type",
      layers: [
        { type: "text", text: "Hello  world\nnow", textAnimation: "word-rise" },
      ],
    });
    const markup = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion,
        c: makeClip(newProject(), "text", "titles"),
        frame: 60,
      }),
    );
    expect(markup).toContain(">Hello</span>  <span");
    expect(markup).toContain(">world</span>\n<span");
    expect(markup).toContain("white-space:pre-wrap");
  });

  it("produces finite closed geometry at narrow sizes and oversized outline/roundness", () => {
    for (const type of [
      "rectangle",
      "ellipse",
      "triangle",
      "star",
      "line",
    ] as const) {
      const shape = layer({
        type,
        width: 1,
        height: 1,
        radius: 2000,
        strokeWidth: 100,
      });
      const path = motionShapePath(shape);
      expect(path).toMatch(/^M/);
      expect(path).not.toMatch(/NaN|Infinity|undefined/);
      if (type !== "line") expect(path).toMatch(/Z$/);
    }
  });
});
