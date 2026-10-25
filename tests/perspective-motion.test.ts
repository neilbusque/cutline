import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ClipSchema,
  KeyframeSchema,
  MotionLayerSchema,
  MotionSchema,
  PropertyKeyframeSchema,
  makeClip,
  newProject,
} from "../src/shared/model";
import {
  animatedValue,
  evaluatedClip,
  propertyBounds,
} from "../src/shared/animation";
import {
  evaluatedMotionLayer,
  motionPropertyBounds,
} from "../src/shared/motion";
import { planeTransform } from "../src/shared/plane-transform";
import { clipBoxStyle } from "../src/composition/compositing";
import { MotionGraphicAtFrame } from "../src/composition/MotionGraphic";
import { applyCommands } from "../src/shared/commands";

const clip = () => makeClip(newProject(), "text", "titles");
const layer = () =>
  MotionLayerSchema.parse({
    type: "rectangle",
    x: 120,
    y: 240,
    width: 480,
    height: 280,
    background: "#ffffff",
  });

describe("editable 2.5D planes", () => {
  it("loads old clips and layers with neutral tilt without changing their CSS transform", () => {
    const legacy: any = clip();
    delete legacy.rotateX;
    delete legacy.rotateY;
    delete legacy.perspective;
    const restored = ClipSchema.parse(legacy);
    expect(restored).toMatchObject({
      rotateX: 0,
      rotateY: 0,
      perspective: 1000,
    });
    expect(layer()).toMatchObject({
      rotateX: 0,
      rotateY: 0,
      perspective: 1000,
    });
    expect(clipBoxStyle(restored, 1).transform).toBe(
      `rotate(${restored.rotation}deg) scale(${restored.scale})`,
    );
    expect(planeTransform({})).toBe("");
    expect(planeTransform({ rotateX: 0, rotateY: 0, perspective: 200 })).toBe(
      "",
    );
  });

  it("bounds finite static and animated values for both clips and motion layers", () => {
    for (const [property, bounds] of Object.entries({
      rotateX: [-85, 85],
      rotateY: [-85, 85],
      perspective: [200, 8000],
    })) {
      expect(propertyBounds[property as "rotateX"]).toEqual(bounds);
      expect(motionPropertyBounds[property as "rotateX"]).toEqual(bounds);
      for (const value of [bounds[0] - 1, bounds[1] + 1, NaN, Infinity]) {
        expect(() =>
          ClipSchema.parse({ ...clip(), [property]: value }),
        ).toThrow();
        expect(() =>
          MotionLayerSchema.parse({ ...layer(), [property]: value }),
        ).toThrow();
        expect(() =>
          KeyframeSchema.parse({ frame: 0, [property]: value }),
        ).toThrow();
        expect(() =>
          PropertyKeyframeSchema.parse({ property, frame: 0, value }),
        ).toThrow();
      }
    }
  });

  it("interpolates clip plane keys as absolute values and preserves phase through splits", () => {
    const p = newProject();
    const c = ClipSchema.parse({
      ...clip(),
      duration: 60,
      rotateX: 7,
      rotateY: 8,
      perspective: 1200,
      keyframes: [
        { property: "rotateX", frame: 0, value: 0, easing: "linear" },
        { property: "rotateX", frame: 30, value: 40 },
        { property: "rotateY", frame: 0, value: -20, easing: "linear" },
        { property: "rotateY", frame: 30, value: 20 },
        { property: "perspective", frame: 0, value: 1000, easing: "linear" },
        { property: "perspective", frame: 30, value: 2000 },
      ],
    });
    expect(evaluatedClip(c, 15)).toMatchObject({
      rotateX: 20,
      rotateY: 0,
      perspective: 1500,
    });
    expect(evaluatedClip({ ...c, animationOffset: 10 }, 5)).toMatchObject({
      rotateX: 20,
      rotateY: 0,
      perspective: 1500,
    });
    p.clips = [c];
    const split = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Split tilted plane",
      commands: [{ type: "clip.split", id: c.id, frame: 20 }],
    });
    const right = split.clips.find((piece) => piece.start === 20)!;
    expect(evaluatedClip(right, 0)).toMatchObject({
      rotateX: animatedValue(c, "rotateX", 20),
      rotateY: animatedValue(c, "rotateY", 20),
      perspective: animatedValue(c, "perspective", 20),
    });
  });

  it("interpolates motion plane keys without changing the established x/y offset semantics", () => {
    const l = MotionLayerSchema.parse({
      ...layer(),
      rotateX: 7,
      rotateY: 8,
      perspective: 1200,
      keyframes: [
        {
          frame: 0,
          x: 0,
          y: 0,
          rotateX: 0,
          rotateY: -20,
          perspective: 1000,
          easing: "linear",
        },
        {
          frame: 30,
          x: 60,
          y: 30,
          rotateX: 40,
          rotateY: 20,
          perspective: 2000,
        },
      ],
    });
    expect(evaluatedMotionLayer(l, 15)).toMatchObject({
      x: 150,
      y: 255,
      rotateX: 20,
      rotateY: 0,
      perspective: 1500,
    });
  });

  it("applies perspective before tilt in the same canvas units around the clip center", () => {
    const c = {
      ...clip(),
      x: 130,
      y: 240,
      width: 480,
      height: 280,
      rotation: 8,
      scale: 1.5,
      rotateX: -12,
      rotateY: 20,
      perspective: 1400,
    };
    const style = clipBoxStyle(c, 0.8, 1.1);
    expect(style).toMatchObject({
      left: 130,
      top: 240,
      width: 480,
      height: 280,
      opacity: 0.8,
    });
    expect(style.transform).toBe(
      `perspective(1400px) rotateX(-12deg) rotateY(20deg) rotate(8deg) scale(${1.5 * 1.1})`,
    );
    // CSS's default clip origin is the center. Canvas/Player scaling applies
    // to the complete projection instead of changing this authored distance.
    expect(style.transformOrigin).toBeUndefined();
    expect(
      planeTransform({ rotateX: -12, rotateY: 20, perspective: 1400 }),
    ).toBe("perspective(1400px) rotateX(-12deg) rotateY(20deg)");
  });

  it("renders evaluated plane tilt in the shared motion component and retains the layer anchor", () => {
    const l = MotionLayerSchema.parse({
      ...layer(),
      anchorX: 0.25,
      anchorY: 0.75,
      keyframes: [
        {
          frame: 0,
          rotateX: 0,
          rotateY: -20,
          perspective: 1000,
          easing: "linear",
        },
        { frame: 30, rotateX: 40, rotateY: 20, perspective: 2000 },
      ],
    });
    const motion = MotionSchema.parse({
      id: "plane",
      name: "Editable perspective",
      layers: [l],
    });
    const c = { ...clip(), motionId: motion.id, preset: "custom" as const };
    const html = renderToStaticMarkup(
      createElement(MotionGraphicAtFrame, { motion, c, frame: 15 }),
    );
    expect(html).toContain(
      "perspective(1500px) rotateX(20deg) rotateY(0deg) scale(1) rotate(0deg)",
    );
    expect(html).toContain("transform-origin:25% 75%");
    expect(html).toContain("left:120px");
    expect(html).toContain("top:240px");
  });

  it("keeps per-layer family and italic accents editable and rendered independently of the clip font", () => {
    const editorial = MotionLayerSchema.parse({
      ...layer(),
      type: "text",
      text: "The idea unfolds",
      fontFamily: "Georgia",
      fontStyle: "italic",
      fontWeight: 400,
    });
    const motion = MotionSchema.parse({
      id: "editorial",
      name: "Editorial accent",
      layers: [editorial],
    });
    const c = { ...clip(), fontFamily: "Helvetica" as const };
    const html = renderToStaticMarkup(
      createElement(MotionGraphicAtFrame, { motion, c, frame: 0 }),
    );
    expect(html).toContain("font-family:Georgia");
    expect(html).toContain("font-style:italic");
    expect(
      MotionLayerSchema.parse({ ...layer(), type: "text" }).fontFamily,
    ).toBeUndefined();
    expect(() =>
      MotionLayerSchema.parse({ ...editorial, fontFamily: "unavailable-font" }),
    ).toThrow();
    expect(() =>
      MotionLayerSchema.parse({ ...editorial, fontStyle: "oblique" }),
    ).toThrow();
  });

  it("keeps spring overshoot inside safe tilt and perspective bounds", () => {
    const c = ClipSchema.parse({
      ...clip(),
      keyframes: [
        { property: "rotateX", frame: 0, value: 0, easing: "spring" },
        { property: "rotateX", frame: 30, value: 85 },
        { property: "perspective", frame: 0, value: 8000, easing: "spring" },
        { property: "perspective", frame: 30, value: 200 },
      ],
    });
    for (let frame = 0; frame <= 30; frame++) {
      expect(animatedValue(c, "rotateX", frame)).toBeGreaterThanOrEqual(-85);
      expect(animatedValue(c, "rotateX", frame)).toBeLessThanOrEqual(85);
      expect(animatedValue(c, "perspective", frame)).toBeGreaterThanOrEqual(
        200,
      );
      expect(animatedValue(c, "perspective", frame)).toBeLessThanOrEqual(8000);
    }
  });
});
