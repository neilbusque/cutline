import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionGraphicAtFrame } from "../src/composition/MotionGraphic";
import { TextGraphicAtFrame } from "../src/composition/Video";
import { CaptionText } from "../src/composition/CaptionText";
import {
  makeClip,
  MotionLayerSchema,
  MotionSchema,
  newProject,
  PropertyKeyframeSchema,
  validateProject,
  type Clip,
  type MotionLayer,
  type Project,
} from "../src/shared/model";
import { applyCommands, type Command } from "../src/shared/commands";
import { applyAgentEdit } from "../src/shared/agent-edit";
import { animatedValue } from "../src/shared/animation";
import {
  motionEase,
  motionTextTokens,
  motionValue,
} from "../src/shared/motion";
import {
  createMotionScene,
  motionSceneIds,
} from "../src/shared/motion-presets";
import { captionTextWidth } from "../src/shared/caption-layout";
import {
  animationSpans,
  presetTiming,
  type AnimationSpan,
} from "../src/shared/text-presets";
import { createVectorScene } from "../src/shared/vector-scenes";
import { parseEditableSvg } from "../src/shared/vector-path";
import { cameraTransform } from "../src/shared/effects";
import { Thumbnail } from "@remotion/player";
import { Film } from "../src/composition/Video";
import { transitionGain } from "../src/composition/compositing";

const edit = (p: Project, commands: Command[]) =>
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Render fix",
    commands,
  });
const samples = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const outerStyle = (markup: string) => markup.match(/style="([^"]*)"/)![1];
const css = (style: string, property: string) =>
  style.match(new RegExp(`(?:^|;)${property}:([^;]+)`))?.[1];
const opacityOf = (markup: string) =>
  Number(css(outerStyle(markup), "opacity") ?? 1);
const scaleOf = (markup: string) =>
  Number(
    css(outerStyle(markup), "transform")?.match(/scale\(([^)]+)\)/)?.[1] ?? 1,
  );
const translateOf = (markup: string) =>
  Number(
    css(outerStyle(markup), "transform")?.match(
      /translateY\(([^)]+)px\)/,
    )?.[1] ?? 0,
  );
const title = (patch: Partial<Clip> = {}): Clip => ({
  ...makeClip(newProject(), "text", "titles", 0),
  text: "Your story starts here",
  duration: 90,
  ...patch,
});
const text = (c: Clip, frame: number, span?: AnimationSpan) =>
  renderToStaticMarkup(
    React.createElement(TextGraphicAtFrame, { c, frame, fps: 30, span }),
  );
const caption = (c: Clip, frame: number, span?: AnimationSpan) =>
  renderToStaticMarkup(
    React.createElement(CaptionText, { clip: c, frame, fps: 30, span }),
  );

const attribute = (markup: string, name: string) =>
  [...markup.matchAll(new RegExp(` ${name}="([^"]*)"`, "g"))].map(
    (match) => match[1],
  );
/** Style attributes in document order. */
const styles = (markup: string) =>
  [...markup.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
/** The whole Film at one frame, as preview and export render it. */
const film = (p: Project, frame: number) =>
  renderToStaticMarkup(
    React.createElement(Thumbnail, {
      component: Film as React.ComponentType<Record<string, unknown>>,
      inputProps: { project: p, mediaBase: "http://media", preview: false },
      durationInFrames: Math.max(
        1,
        ...p.clips.map((c) => c.start + c.duration),
      ),
      compositionWidth: p.width,
      compositionHeight: p.height,
      fps: p.fps,
      frameToDisplay: frame,
    }),
  );
const scaleIn = (transform: string) =>
  Number(transform.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
const imageProject = () => {
  const p = newProject();
  p.assets = [
    {
      id: "still",
      name: "Still",
      kind: "image",
      path: "/still.jpg",
      duration: 0,
      hasAudio: false,
    },
    {
      id: "still-2",
      name: "Still 2",
      kind: "image",
      path: "/still-2.jpg",
      duration: 0,
      hasAudio: false,
    },
  ];
  return p;
};
const image = (p: Project, patch: Partial<Clip> = {}): Clip => ({
  ...makeClip(p, "image", "video", 0, p.assets[0]),
  duration: 120,
  ...patch,
});

describe("vector path outlines", () => {
  it("draws imported strokes in path units so the dash reveal covers the whole outline", () => {
    const p = newProject();
    const created = createVectorScene(
      p,
      0,
      parseEditableSvg(
        '<svg viewBox="0 0 24 24"><path d="M4 4H20V20H4Z" fill="none" stroke="#000000" stroke-width="2"/></svg>',
      ),
    );
    const layer = created.motion.layers[0];
    // Stored in canvas pixels: 2 SVG units at 29.25 px per unit.
    expect(layer.strokeWidth).toBeCloseTo(58.5);
    const render = (trim: number) =>
      renderToStaticMarkup(
        React.createElement(MotionGraphicAtFrame, {
          motion: {
            ...created.motion,
            layers: [{ ...layer, trim }],
          },
          c: created.clip,
          frame: 0,
        }),
      );
    const full = render(1);
    // A non-scaling stroke sizes the dash in path units but draws it in screen
    // pixels, so the outline came out dotted. The stroke now scales with the path.
    expect(full).not.toContain("vector-effect");
    expect(Number(attribute(full, "stroke-width")[0])).toBeCloseTo(2);
    // A finished outline has no dash pattern left to break its closing corner.
    expect(full).not.toContain("stroke-dasharray");
    const half = render(0.5);
    expect(half).toContain('pathLength="1"');
    expect(half).toContain('stroke-dashoffset="0.5"');
    expect(half).not.toContain("vector-effect");
  });

  it("keeps the stored canvas width when the layer is resized or stretched", () => {
    const p = newProject();
    const created = createVectorScene(
      p,
      0,
      parseEditableSvg(
        '<svg viewBox="0 0 100 50"><path d="M0 0L40 0" stroke="#000000" stroke-width="4" transform="scale(2)"/></svg>',
      ),
      { width: 500, height: 250 },
    );
    const layer = created.motion.layers[0];
    // 4 units, path scale 2, 5 px per unit.
    expect(layer.strokeWidth).toBeCloseTo(40);
    const render = (patch: Partial<typeof layer>) =>
      Number(
        attribute(
          renderToStaticMarkup(
            React.createElement(MotionGraphicAtFrame, {
              motion: { ...created.motion, layers: [{ ...layer, ...patch }] },
              c: created.clip,
              frame: 0,
            }),
          ),
          "stroke-width",
        )[0],
      );
    expect(render({})).toBeCloseTo(4);
    // Twice as large on screen: half the path units keeps the 40 px outline.
    expect(render({ width: 1000, height: 500 })).toBeCloseTo(2);
    // Stretched without keeping the aspect ratio: the average scale is used.
    expect(
      render({ width: 1000, height: 250, vectorAspectRatio: "none" }),
    ).toBeCloseTo(40 / (2 * Math.sqrt(10 * 5)));
  });
});

describe("clip keyframe easing", () => {
  const titled = () => {
    const p = newProject();
    p.clips = [{ ...makeClip(p, "text", "titles", 0), duration: 60 }];
    return p;
  };
  const key = (
    id: string,
    property: "opacity" | "scale" | "volume" | "x",
    frame: number,
    value: number,
    easing: string,
    bezier?: [number, number, number, number],
  ) =>
    ({
      type: "clip.keyframe",
      id,
      property,
      frame,
      value,
      easing,
      ...(bezier ? { bezier } : {}),
      remove: false,
    }) as Command;

  it("accepts cubic-bezier, spring and back on clip keys and keeps older keys valid", () => {
    expect(
      PropertyKeyframeSchema.parse({
        property: "x",
        frame: 0,
        value: 0,
        easing: "cubic-bezier",
        bezier: [0.16, 1, 0.3, 1],
      }),
    ).toMatchObject({ easing: "cubic-bezier", bezier: [0.16, 1, 0.3, 1] });
    for (const easing of ["spring", "back"])
      expect(
        PropertyKeyframeSchema.parse({
          property: "x",
          frame: 0,
          value: 0,
          easing,
        }).easing,
      ).toBe(easing);
    expect(
      PropertyKeyframeSchema.parse({ property: "x", frame: 0, value: 0 }),
    ).toEqual({ property: "x", frame: 0, value: 0, easing: "ease-in-out" });
    expect(() =>
      PropertyKeyframeSchema.parse({
        property: "x",
        frame: 0,
        value: 0,
        easing: "cubic-bezier",
        bezier: [2, 0, 1, 1],
      }),
    ).toThrow();
  });

  it("evaluates a stored Bezier curve and survives the project round trip", () => {
    const p = titled(),
      id = p.clips[0].id;
    const next = edit(p, [
      key(id, "x", 0, 0, "cubic-bezier", [0.16, 1, 0.3, 1]),
      key(id, "x", 20, 100, "linear"),
    ]);
    const c = validateProject(JSON.parse(JSON.stringify(next))).clips[0];
    expect(c.keyframes[0].bezier).toEqual([0.16, 1, 0.3, 1]);
    for (const frame of [2, 5, 10, 15])
      expect(animatedValue(c, "x", frame)).toBeCloseTo(
        100 * motionEase(frame / 20, "cubic-bezier", [0.16, 1, 0.3, 1]),
      );
    // An expo ease-out covers most of the move early, unlike quadratic.
    expect(animatedValue(c, "x", 4)).toBeGreaterThan(70);
  });

  it("lets position and scale overshoot gently while opacity and volume settle without a bump", () => {
    const p = titled(),
      id = p.clips[0].id;
    const c = edit(p, [
      key(id, "scale", 0, 0.85, "spring"),
      key(id, "scale", 20, 1, "linear"),
      key(id, "opacity", 0, 0, "spring"),
      key(id, "opacity", 20, 1, "linear"),
      key(id, "volume", 0, 0.2, "back"),
      key(id, "volume", 20, 1, "linear"),
    ]).clips[0];
    const scale = samples(0, 20).map((f) => animatedValue(c, "scale", f));
    expect(Math.max(...scale)).toBeGreaterThan(1);
    expect(Math.max(...scale)).toBeLessThan(1.03);
    expect(scale.at(-1)).toBe(1);
    for (const property of ["opacity", "volume"] as const) {
      const values = samples(0, 20).map((f) => animatedValue(c, property, f));
      expect(Math.max(...values)).toBeLessThanOrEqual(1);
      // Monotonic settle: no clamp kink, no dip after reaching the target.
      for (let i = 1; i < values.length; i++)
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
      expect(values[1]).toBeGreaterThan(values[0]);
      expect(values.at(-1)).toBe(1);
    }
  });

  it("passes curve handles through the agent keyframe action", () => {
    const p = titled(),
      id = p.clips[0].id;
    const result = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Agent curve",
      actions: [
        {
          type: "clip.keyframe",
          clipId: id,
          property: "y",
          frame: 0,
          value: 40,
          easing: "cubic-bezier",
          bezier: [0.34, 1.56, 0.64, 1],
        },
        {
          type: "clip.keyframe",
          clipId: id,
          property: "y",
          frame: 15,
          value: 0,
        },
      ],
    });
    expect(result.project.clips[0].keyframes[0]).toMatchObject({
      easing: "cubic-bezier",
      bezier: [0.34, 1.56, 0.64, 1],
    });
  });
});

describe("text preset timing", () => {
  it("reaches full opacity on short clips that have both an entrance and an exit", () => {
    for (const duration of [3, 20, 24, 36]) {
      const c = title({
        duration,
        preset: "fade",
        exitAnimation: "fade",
        animationFrames: 18,
      });
      const levels = samples(0, duration - 1).map((f) => opacityOf(text(c, f)));
      expect(Math.max(...levels), `${duration} frames`).toBe(1);
      expect(levels[0]).toBe(0);
      expect(levels.at(-1)).toBe(0);
      const balanced: Clip = {
        ...c,
        kind: "caption",
        captionLayout: "balanced",
        text: "Short phrase",
      };
      expect(
        Math.max(
          ...samples(0, duration - 1).map((f) =>
            opacityOf(caption(balanced, f)),
          ),
        ),
      ).toBe(1);
    }
    // Long enough clips keep their requested timing.
    const long = title({ preset: "fade", exitAnimation: "fade", duration: 45 });
    expect(presetTiming(long, 18)).toMatchObject({ window: 18, progress: 1 });
    expect(presetTiming(long, 26).exit).toBe(0);
    // One- and two-frame clips have no room for both, so they show plainly.
    expect(
      opacityOf(
        text(title({ duration: 2, preset: "fade", exitAnimation: "fade" }), 0),
      ),
    ).toBe(1);
  });

  it("eases entrances out and exits in, with no linear moves", () => {
    const rise = title({
      preset: "rise",
      exitAnimation: "slide",
      duration: 60,
    });
    const travel = samples(0, 18).map((f) => translateOf(text(rise, f)));
    expect(travel[0]).toBeGreaterThanOrEqual(24);
    expect(travel[0]).toBeLessThanOrEqual(40);
    // Ahead of a linear move early, and settling with shrinking steps.
    expect(travel[3]).toBeLessThan(travel[0] * (1 - 3 / 18));
    for (let i = 2; i < travel.length; i++)
      expect(travel[i - 1] - travel[i]).toBeLessThanOrEqual(
        travel[i - 2] - travel[i - 1] + 1e-9,
      );
    expect(travel[18]).toBe(0);
    // The exit holds first, then accelerates away.
    const exitStart = 59 - 18;
    const fading = samples(exitStart, 59).map((f) => opacityOf(text(rise, f)));
    expect(fading[9]).toBeGreaterThan(0.6);
    expect(fading.at(-1)).toBe(0);
  });

  it("makes 'Make it pop' grow from near full size with a short fade and a small settle", () => {
    const pop = title({ preset: "spring" });
    const frames = samples(0, 30).map((f) => text(pop, f));
    const scales = frames.map(scaleOf),
      levels = frames.map(opacityOf);
    expect(scales[0]).toBeGreaterThanOrEqual(0.85);
    expect(Math.max(...scales)).toBeGreaterThan(1);
    expect(Math.max(...scales)).toBeLessThanOrEqual(1.03);
    expect(scales[18]).toBe(1);
    expect(levels[0]).toBe(0);
    for (let i = 1; i < levels.length; i++)
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    expect(levels[9]).toBe(1);
  });

  it("keeps a split title and its exit continuous across the cut", () => {
    let p = newProject();
    const whole = title({
      preset: "spring",
      exitAnimation: "fade",
      duration: 60,
      animationFrames: 18,
    });
    p.clips = [whole];
    p = edit(p, [{ type: "clip.split", id: whole.id, frame: 9 }]);
    const spans = animationSpans(p);
    const left = p.clips.find((c) => c.start === 0)!,
      right = p.clips.find((c) => c.start === 9)!;
    expect(spans.get(left.id)).toEqual({ phase: 0, length: 60 });
    expect(spans.get(right.id)).toEqual({ phase: 9, length: 60 });
    for (const f of [0, 4, 8])
      expect(text(left, f, spans.get(left.id))).toBe(text(whole, f));
    for (const f of [0, 5, 30, 50])
      expect(text(right, f, spans.get(right.id))).toBe(text(whole, f + 9));
    // Moving the second piece makes it its own title again.
    const moved = {
      ...p,
      clips: p.clips.map((c) => (c.id === right.id ? { ...c, start: 40 } : c)),
    };
    expect(animationSpans(moved).size).toBe(0);
    expect(opacityOf(text(right, 0, animationSpans(moved).get(right.id)))).toBe(
      0,
    );
  });

  it("types without reflowing the line", () => {
    const typed = title({ preset: "typewriter", text: "One word." });
    const markup = text(typed, 9);
    expect(markup).toContain("One w");
    expect(markup).toContain('<span style="visibility:hidden">ord.</span>');
    expect(markup.replace(/<[^>]+>/g, "")).toBe("One word.");
  });

  it("wraps per-letter stagger only between words and fades each letter on a curve", () => {
    const stagger = title({ preset: "stagger", text: "Subscribe for more" });
    const markup = text(stagger, 6);
    // Spaces sit between word groups, never inside a letter box.
    expect(markup).not.toMatch(/inline-block[^"]*">\s<\/span>/);
    expect(markup.match(/<span style="display:inline-block">/g)).toHaveLength(
      3,
    );
    expect(markup.replace(/<[^>]+>/g, "")).toBe("Subscribe for more");
    const levels = [...markup.matchAll(/opacity:([\d.e-]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(levels.some((v) => v > 0 && v < 1)).toBe(true);
  });

  it("fades words in one after another instead of switching them on", () => {
    const words = title({ preset: "word-reveal", text: "Tell your story now" });
    const levels = (frame: number) =>
      [...text(words, frame).matchAll(/<span style="opacity:([\d.e-]+)"/g)].map(
        (m) => Number(m[1]),
      );
    expect(levels(0)).toEqual([0, 0, 0, 0]);
    expect(levels(6).some((v) => v > 0 && v < 1)).toBe(true);
    expect(levels(6)[0]).toBeGreaterThan(levels(6)[3]);
    expect(levels(18)).toEqual([1, 1, 1, 1]);
  });

  it("draws the callout ring inside the box so clipping cannot hide it", () => {
    expect(text(title({ preset: "callout" }), 40)).toContain(
      "box-shadow:inset 0 0 0 3px",
    );
  });
});

describe("camera moves", () => {
  const zoom = (
    c: Pick<Clip, "cameraMotion" | "duration">,
    frame: number,
    span?: AnimationSpan,
  ) => scaleIn(cameraTransform(c, frame, { fps: 30, span }));

  it("keeps one camera move across a split instead of restarting it at the cut", () => {
    let p = imageProject();
    const whole = image(p, { cameraMotion: "zoom-in", duration: 120 });
    p.clips = [whole];
    p = edit(p, [{ type: "clip.split", id: whole.id, frame: 60 }]);
    const spans = animationSpans(p);
    const left = p.clips.find((c) => c.start === 0)!,
      right = p.clips.find((c) => c.start === 60)!;
    for (const f of [0, 30, 59])
      expect(zoom(left, f, spans.get(left.id))).toBeCloseTo(zoom(whole, f));
    for (const f of [0, 1, 30, 59])
      expect(zoom(right, f, spans.get(right.id))).toBeCloseTo(
        zoom(whole, f + 60),
      );
    // The right piece picks up where the left one stopped.
    expect(
      zoom(right, 0, spans.get(right.id)) - zoom(left, 59, spans.get(left.id)),
    ).toBeLessThan(0.005);
    expect(zoom(right, 0, spans.get(right.id))).toBeGreaterThan(1.05);
    // The rendered Film uses the same continuous move.
    const transformAt = (frame: number) =>
      [...film(p, frame).matchAll(/transform:(scale\([^;"]+\))/g)].map(
        (m) => m[1],
      );
    expect(transformAt(60)).toContain(cameraTransform(whole, 60, { fps: 30 }));
  });

  it("scales drifts to the shot length and eases them in and out", () => {
    const short = { cameraMotion: "zoom-in" as const, duration: 69 }; // 2.3 seconds
    const long = { cameraMotion: "zoom-in" as const, duration: 180 }; // 6 seconds
    expect(zoom(short, 0)).toBe(1);
    expect(zoom(short, 68)).toBeLessThanOrEqual(1 + 0.03 * 2.3 + 1e-9);
    expect(zoom(short, 68)).toBeGreaterThan(1.05);
    expect(zoom(long, 179)).toBeCloseTo(1.18);
    expect(
      cameraTransform({ cameraMotion: "zoom-out", duration: 180 }, 0),
    ).toBe("scale(1.18)");
    const steps = samples(1, 179).map((f) => zoom(long, f) - zoom(long, f - 1));
    // Gentle at both ends of the shot, never stopped dead.
    expect(steps[0]).toBeLessThan(steps[89]);
    expect(steps.at(-1)!).toBeLessThan(steps[89]);
    expect(Math.min(...steps)).toBeGreaterThan(0);
    // Pans travel less on short shots too, and stay covered by their scale.
    const pan = cameraTransform({ cameraMotion: "pan-left", duration: 69 }, 0, {
      fps: 30,
    });
    const [, panScale, panShift] = pan.match(
      /scale\(([^)]+)\) translateX\(([^)]+)%\)/,
    )!;
    expect(Number(panShift)).toBeLessThan(5);
    expect((Number(panScale) - 1) / 2).toBeGreaterThan(
      (Number(panShift) / 100) * Number(panScale),
    );
  });

  it("snaps a punch-in over a fifth of a second instead of a slow linear ramp", () => {
    const punch = { cameraMotion: "punch-in" as const, duration: 120 };
    const levels = samples(0, 12).map((f) => zoom(punch, f));
    expect(levels[0]).toBe(1);
    // Most of the punch lands on the first frame, and it settles by 0.2 seconds.
    expect(levels[1] - 1).toBeGreaterThan(0.18 * 0.45);
    expect(levels[6]).toBeCloseTo(1.18);
    for (let i = 2; i < levels.length; i++)
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(
        levels[i - 1] - levels[i - 2] + 1e-9,
      );
    // The same timing in seconds at 60 frames per second.
    expect(scaleIn(cameraTransform(punch, 12, { fps: 60 }))).toBeCloseTo(1.18);
  });
});

describe("clip compositing", () => {
  const wrappers = (markup: string) =>
    styles(markup).filter((s) =>
      s.startsWith("position:absolute;inset:0;mix-blend-mode"),
    );
  const boxes = (markup: string) =>
    styles(markup).filter((s) => s.startsWith("position:absolute;left:"));
  const number = (style: string, property: string) =>
    Number(css(style, property) ?? 1);

  it("leaves uncropped clips unclipped so the callout ring and text glow stay whole", () => {
    const p = newProject();
    p.clips = [title({ preset: "callout" })];
    const markup = film(p, 40);
    expect(markup).toContain("box-shadow:inset 0 0 0 3px");
    expect(markup).not.toContain("clip-path:inset(0% 0% 0% 0%)");
    expect(boxes(markup)[0]).not.toContain("clip-path");
  });

  it("puts rounded and oval masks on the cropped area", () => {
    const p = imageProject();
    const shot = image(p, {
      x: 100,
      y: 100,
      width: 600,
      height: 400,
      mask: "rounded",
      cornerRadius: 32,
      crop: { top: 0, right: 10, bottom: 0, left: 10 },
    });
    p.clips = [shot];
    let markup = film(p, 10);
    expect(boxes(markup)[0]).toContain(
      "clip-path:inset(0% 10% 0% 10% round 32px)",
    );
    expect(markup).not.toContain("inset(0 round");
    p.clips = [{ ...shot, mask: "ellipse" }];
    markup = film(p, 10);
    expect(boxes(markup)[0]).toContain("clip-path:ellipse(40% 50% at 50% 50%)");
    p.clips = [
      {
        ...shot,
        mask: "ellipse",
        crop: { top: 10, right: 0, bottom: 0, left: 20 },
      },
    ];
    expect(boxes(film(p, 10))[0]).toContain(
      "clip-path:ellipse(40% 45% at 60% 55%)",
    );
  });

  it("draws the music glow outside the clipped box", () => {
    const p = imageProject();
    p.assets.push({
      id: "beat",
      name: "Beat",
      kind: "audio",
      path: "/beat.wav",
      duration: 10,
      hasAudio: true,
      rhythm: {
        version: 1,
        confidence: 1,
        duration: 10,
        beats: [{ time: 0, strength: 1 }],
        envelope: { step: 1, values: [] },
      },
    });
    const music = {
      ...makeClip(p, "audio", "audio", 0, p.assets[2]),
      duration: 120,
    };
    const shot = image(p, {
      crop: { top: 5, right: 5, bottom: 5, left: 5 },
      shadowBlur: 10,
      musicReactive: {
        musicClipId: music.id,
        mode: "beat",
        style: "glow",
        amount: 0.5,
        releaseFrames: 6,
      },
    });
    p.clips = [music, shot];
    const markup = film(p, 0);
    const [wrapper] = wrappers(markup),
      [box] = boxes(markup);
    expect(css(wrapper, "filter")).toBe(
      "drop-shadow(0px 8px 10px #000000) drop-shadow(0 0 24px #c6f16d)",
    );
    expect(box).toContain("clip-path:inset(5% 5% 5% 5%)");
    expect(box).not.toContain("drop-shadow");
  });

  it("scales blurred footage so the soft rim falls outside the frame", () => {
    const p = imageProject();
    p.clips = [image(p, { blur: 20 })];
    const media = styles(film(p, 0)).find((s) => s.includes("blur("))!;
    const scale = scaleIn(css(media, "transform")!);
    const blur = Number(css(media, "filter")!.match(/blur\(([^)]+)px\)/)![1]);
    // Same blur on screen, and three blur radii of footage past every edge.
    expect(blur * scale).toBeCloseTo(20);
    expect(((scale - 1) * 1080) / 2).toBeGreaterThanOrEqual(3 * 20);
    // Fitted footage and text keep their plain blur.
    p.clips = [image(p, { blur: 20, fit: "contain" })];
    expect(styles(film(p, 0)).find((s) => s.includes("blur("))).toContain(
      "blur(20px)",
    );
  });

  const pair = (
    kind: NonNullable<Clip["transition"]>["kind"],
    frames = 15,
    patch: Partial<Clip> = {},
  ) => {
    const p = imageProject();
    const a = image(p, { id: "a", duration: 60 });
    const b: Clip = {
      ...image(p, {
        id: "b",
        start: 60 - frames,
        duration: 60,
        assetId: "still-2",
      }),
      transition: { kind, frames, fromId: "a" },
      ...patch,
    };
    p.clips = [a, b];
    return p;
  };

  it("dissolves the outgoing shot too, so areas the new shot leaves uncovered never cut", () => {
    // Frame 52 is the middle of a 15-frame crossfade starting at 45.
    for (const fit of ["cover", "contain"] as const) {
      const markup = film(pair("crossfade", 15, { fit }), 52);
      expect(styles(markup)).toContain(
        "position:absolute;inset:0;isolation:isolate",
      );
      const [outgoing, incoming] = wrappers(markup);
      expect(number(outgoing, "opacity")).toBeCloseTo(0.5);
      expect(number(incoming, "opacity")).toBeCloseTo(0.5);
      expect(incoming).toContain("mix-blend-mode:plus-lighter");
    }
    // Outside the overlap both shots are untouched.
    const before = wrappers(film(pair("crossfade"), 30));
    expect(before[0]).not.toContain("opacity");
    // A blend mode keeps reaching the tracks below, so that pair is not isolated.
    const blended = film(pair("crossfade", 15, { blendMode: "screen" }), 52);
    expect(blended).not.toContain("isolation:isolate");
    expect(wrappers(blended)[0]).not.toContain("opacity");
    expect(wrappers(blended)[1]).toContain("mix-blend-mode:screen");
  });

  it("pushes the outgoing shot out on a slide and softens the wipe edge", () => {
    let [outgoing, incoming] = wrappers(film(pair("slide-left"), 52));
    expect(css(outgoing, "transform")).toBe("translateX(-50%)");
    expect(css(incoming, "transform")).toBe("translateX(50%)");
    [outgoing, incoming] = wrappers(film(pair("slide-right"), 52));
    expect(css(outgoing, "transform")).toBe("translateX(50%)");
    expect(css(incoming, "transform")).toBe("translateX(-50%)");
    [outgoing, incoming] = wrappers(film(pair("wipe"), 52));
    expect(css(incoming, "mask-image")).toBe(
      "linear-gradient(to right, #000 47%, transparent 53%)",
    );
    expect(css(outgoing, "mask-image")).toBe(
      "linear-gradient(to right, transparent 47%, #000 53%)",
    );
    expect(incoming).not.toContain("clip-path");
  });

  it("dips fully to black in the middle of a fade through black of any length", () => {
    const black = (markup: string) =>
      Number(
        styles(markup)
          .find((s) => s.includes("background:black"))
          ?.match(/opacity:([\d.e-]+)/)?.[1] ?? 0,
      );
    for (const frames of [12, 13, 15, 30]) {
      const p = pair("black", frames);
      const start = 60 - frames;
      const levels = samples(start, 59).map((f) => black(film(p, f)));
      expect(Math.max(...levels), `${frames} frames`).toBe(1);
      // The shots swap while the screen is fully black.
      const swap = start + Math.ceil((frames - 1) / 2);
      expect(black(film(p, swap))).toBe(1);
      expect(number(wrappers(film(p, swap))[0], "opacity")).toBe(0);
      expect(number(wrappers(film(p, swap - 1))[1], "opacity")).toBe(0);
      expect(wrappers(film(p, swap))[1]).not.toContain("opacity");
    }
  });

  it("keeps the loudness steady through an audio crossfade", () => {
    for (let k = 0; k < 15; k++) {
      const incoming = transitionGain(k, { frames: 15 });
      const outgoing = transitionGain(45 + k, undefined, {
        start: 45,
        frames: 15,
      });
      expect(incoming ** 2 + outgoing ** 2).toBeCloseTo(1);
    }
    expect(transitionGain(0, { frames: 15 })).toBe(0);
    expect(transitionGain(14, { frames: 15 })).toBeCloseTo(1);
    expect(transitionGain(30, undefined, { start: 45, frames: 15 })).toBe(1);
  });
});

describe("motion text", () => {
  const textLayer = (patch: Record<string, unknown> = {}) =>
    MotionLayerSchema.parse({
      type: "text",
      width: 330,
      height: 200,
      fontSize: 40,
      ...patch,
    });
  const motionMarkup = (layer: MotionLayer, frame: number) => {
    const p = newProject();
    const motion = MotionSchema.parse({
      id: "m",
      name: "Text",
      layers: [layer],
    });
    const c: Clip = {
      ...makeClip(p, "text", "titles"),
      preset: "custom",
      motionId: "m",
    };
    return renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, { motion, c, frame }),
    );
  };

  it("starts letter and word rises when the layer appears, so the stagger is seen", () => {
    let checked = 0;
    for (const id of motionSceneIds) {
      const { motion } = createMotionScene(newProject(), 0, id);
      for (const layer of motion.layers) {
        if (
          layer.type !== "text" ||
          !["character-rise", "word-rise"].includes(layer.textAnimation)
        )
          continue;
        const shown = samples(0, 119).find(
          (f) => motionValue(layer, "opacity", f) > 0.05,
        )!;
        const finished = motionTextTokens(layer, layer.text, shown).filter(
          (token) => /\S/u.test(token.text) && token.opacity === 1,
        );
        expect(
          finished.map((token) => token.text),
          `${id}: ${layer.text}`,
        ).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    // A layer that is visible from the start keeps its stagger timing.
    const plain = textLayer({
      textAnimation: "character-rise",
      staggerFrames: 3,
    });
    expect(motionTextTokens(plain, "AB", 3)[1].opacity).toBe(0);
    expect(motionTextTokens(plain, "AB", 4)[1].opacity).toBeGreaterThan(0);
  });

  it("rises over the same time at any frame rate and eases each letter in", () => {
    const rise = textLayer({ textAnimation: "character-rise" });
    expect(motionTextTokens(rise, "A", 12)[0].opacity).toBe(1);
    expect(motionTextTokens(rise, "A", 12, 60)[0].opacity).toBeLessThan(1);
    expect(motionTextTokens(rise, "A", 24, 60)[0]).toMatchObject({
      opacity: 1,
      y: 0,
      blur: 0,
    });
    const tokens = samples(0, 12).map((f) => motionTextTokens(rise, "A", f)[0]);
    // Ease out: most of the fade and travel happen early, then settle.
    expect(tokens[3].opacity).toBeGreaterThan(0.5);
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i].opacity).toBeGreaterThanOrEqual(tokens[i - 1].opacity);
      expect(tokens[i].y).toBeLessThanOrEqual(tokens[i - 1].y);
    }
    expect(tokens[1].y - tokens[2].y).toBeLessThan(tokens[0].y - tokens[1].y);
  });

  it("wraps letter-by-letter text only between words", () => {
    for (const textAnimation of ["character-rise", "typewriter"]) {
      const markup = motionMarkup(
        textLayer({ textAnimation, text: "Subscribe for more videos" }),
        60,
      );
      expect(markup.match(/<span style="display:inline-block">/g)).toHaveLength(
        4,
      );
      expect(markup).not.toMatch(/inline-block[^"]*">\s<\/span>/);
      expect(markup.replace(/<[^>]+>/g, "")).toBe("Subscribe for more videos");
    }
  });

  it("spreads a gradient across the whole line instead of repeating it on every letter", () => {
    const layer = textLayer({
      textAnimation: "character-rise",
      text: "GRADIENT",
      fontSize: 90,
      fillStyle: "gradient",
      color: "#ffffff",
      gradientColor: "#6c5ce7",
    });
    const letters = styles(motionMarkup(layer, 60)).filter((s) =>
      s.includes("background-clip:text"),
    );
    expect(letters).toHaveLength(8);
    const total = captionTextWidth("GRADIENT", 90, "Arial", "800");
    let before = "";
    for (const [i, style] of letters.entries()) {
      expect(css(style, "background-size")).toBe(`${total}px 100%`);
      expect(
        Number(css(style, "background-position")!.split("px")[0]),
      ).toBeCloseTo(i ? -captionTextWidth(before, 90, "Arial", "800") : 0);
      before += "GRADIENT"[i];
    }
    // Without a text animation the gradient already spans one run of text.
    expect(
      styles(motionMarkup({ ...layer, textAnimation: "none" }, 60)).filter(
        (s) => s.includes("background-clip:text"),
      ),
    ).toHaveLength(1);
  });
});

describe("scene timing", () => {
  const scene = (
    id: (typeof motionSceneIds)[number],
    durationFrames?: number,
    fps: Project["fps"] = 30,
  ) =>
    createMotionScene(
      { ...newProject(), fps },
      0,
      id,
      durationFrames ? { durationFrames } : {},
    ).motion;
  const values = (
    layer: MotionLayer,
    property: "x" | "opacity" | "trim" | "blur",
    from: number,
    to: number,
  ) => samples(from, to).map((f) => motionValue(layer, property, f));

  it("fades scene layers in smoothly instead of popping on a clamped spring", () => {
    const [, , makeIt] = scene("kinetic-title").layers;
    expect(makeIt.text).toBe("MAKE IT");
    const fade = values(makeIt, "opacity", 4, 26);
    // Not finished in four frames, never past 1, and no dip after arriving.
    expect(fade[4]).toBeLessThan(0.9);
    for (let i = 1; i < fade.length; i++)
      expect(fade[i]).toBeGreaterThanOrEqual(fade[i - 1]);
    expect(Math.max(...fade)).toBe(1);
    // Movement keeps its springy settle.
    const rise = samples(4, 26).map((f) => motionValue(makeIt, "y", f));
    expect(Math.min(...rise)).toBeLessThan(0);
  });

  it("settles amounts without a bounce on any spring or back key, while moves still overshoot", () => {
    const layer = MotionLayerSchema.parse({
      type: "rectangle",
      keyframes: [
        {
          frame: 0,
          x: 0,
          scale: 0.5,
          opacity: 0,
          trim: 0,
          blur: 20,
          fillOpacity: 0,
          easing: "spring",
        },
        {
          frame: 20,
          x: 100,
          scale: 1,
          opacity: 1,
          trim: 1,
          blur: 0,
          fillOpacity: 1,
        },
      ],
    });
    for (const property of ["opacity", "trim", "fillOpacity"] as const) {
      const curve = samples(0, 20).map((f) => motionValue(layer, property, f));
      for (let i = 1; i < curve.length; i++)
        expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
    }
    const blur = samples(0, 20).map((f) => motionValue(layer, "blur", f));
    for (let i = 1; i < blur.length; i++)
      expect(blur[i]).toBeLessThanOrEqual(blur[i - 1]);
    expect(
      Math.max(...samples(0, 20).map((f) => motionValue(layer, "x", f))),
    ).toBeGreaterThan(100);
    expect(
      Math.max(...samples(0, 20).map((f) => motionValue(layer, "scale", f))),
    ).toBeGreaterThan(1);
  });

  it("slides the lower third panel in with a small settle, not a 13% overshoot", () => {
    const p = newProject();
    const panel = scene("lower-third").layers[0];
    const travel = p.width * 0.8;
    const x = values(panel, "x", 0, 40);
    expect(Math.max(...x)).toBeGreaterThan(0);
    expect(Math.max(...x)).toBeLessThanOrEqual(travel * 0.03);
    expect(motionValue(panel, "x", 24)).toBeCloseTo(0);
  });

  /** Each layer keeps its entrance frames and moves the keys after its longest pause by `extra`. */
  const expectAnchored = (
    base: MotionLayer,
    next: MotionLayer,
    extra: number,
    durationFrames: number,
  ) => {
    const shift = next.keyframes.map(
      (key, i) => key.frame - base.keyframes[i].frame,
    );
    expect(next.keyframes).toHaveLength(base.keyframes.length);
    const first = shift.findIndex((d) => d !== 0);
    if (first >= 0)
      for (const [i, key] of base.keyframes.entries())
        if (i >= first)
          expect(next.keyframes[i].frame).toBe(
            Math.min(durationFrames - 1, key.frame + extra),
          );
    expect(
      shift.slice(0, first < 0 ? undefined : first).every((d) => d === 0),
    ).toBe(true);
    expect(next.textRevealStart).toBe(base.textRevealStart);
    expect(next.textRevealFrames).toBe(base.textRevealFrames);
    expect(next.staggerFrames).toBe(base.staggerFrames);
  };

  it("keeps entrances at their pace and exits anchored to the end when a scene changes length", () => {
    const long = scene("kinetic-title", 300);
    expect(long.layers[1].keyframes.map((key) => key.frame)).toEqual([
      0, 26, 284, 299,
    ]);
    expect(long.layers[2].keyframes.map((key) => key.frame)).toEqual([
      0, 4, 26, 286, 299,
    ]);
    let titles = 0;
    for (const id of motionSceneIds) {
      for (const fps of [30, 60] as const) {
        const original = scene(id, undefined, fps),
          longer = scene(id, fps * 10, fps);
        for (const [i, layer] of original.layers.entries())
          if (layer.type === "text") {
            expectAnchored(layer, longer.layers[i], fps * 6, fps * 10);
            titles++;
          }
      }
      // A shorter scene that still fits only loses hold time.
      const original = scene(id),
        shorter = scene(id, 90);
      for (const [i, layer] of original.layers.entries())
        if (layer.type === "text")
          expectAnchored(layer, shorter.layers[i], -30, 90);
    }
    expect(titles).toBeGreaterThan(80);
    expect(
      scene("kinetic-title", 90).layers[1].keyframes.map((key) => key.frame),
    ).toEqual([0, 26, 74, 89]);
  });

  it("scales a layer in constant motion across the scene evenly", () => {
    const point = (frames?: number) =>
      scene("signature-open", frames).layers.find(
        (layer) => layer.name === "Orbit · traveling point",
      )!;
    const base = point(),
      long = point(300);
    expect(long.keyframes.map((key) => key.frame)).toEqual(
      base.keyframes.map((key) => Math.min(299, Math.round(key.frame * 2.5))),
    );
    // Whole-frame keys move the path by at most a pixel or two along the way.
    for (const f of [0, 40, 80, 119])
      expect(
        Math.abs(
          motionValue(long, "x", Math.round(f * 2.5)) -
            motionValue(base, "x", f),
        ),
      ).toBeLessThan(3);
  });

  it("compresses a scene evenly only when it is too short to fit its entrances and exits", () => {
    expect(
      scene("kinetic-title", 45).layers[1].keyframes.map((key) => key.frame),
    ).toEqual([0, 10, 39, 44]);
  });

  it("keeps loops at their speed and lets a one-shot spin fill a longer scene", () => {
    const orbit = scene("orbit-logo"),
      longOrbit = scene("orbit-logo", 300);
    for (const [i, layer] of orbit.layers.entries())
      if (layer.loop !== "none") {
        expect(longOrbit.layers[i].keyframes).toEqual(layer.keyframes);
        expect(longOrbit.layers[i].loopFrames).toBe(layer.loopFrames);
      }
    const star = scene("social-pop").layers[1],
      longStar = scene("social-pop", 300).layers[1];
    expect(star.loop).toBe("cycle");
    // The entrance keeps its pace, and the spin never restarts inside the scene.
    for (const f of [0, 5, 15, 30])
      expect(motionValue(longStar, "scale", f)).toBeCloseTo(
        motionValue(star, "scale", f),
      );
    const spin = samples(30, 299).map((f) =>
      motionValue(longStar, "rotate", f),
    );
    for (let i = 1; i < spin.length; i++)
      expect(spin[i]).toBeGreaterThanOrEqual(spin[i - 1]);
    expect(motionValue(longStar, "rotate", 299)).toBeCloseTo(72, 0);
  });
});

describe("blur cover follows the clip's strongest blur (review follow-up)", () => {
  it("keeps the same cover scale while blur is animated", async () => {
    const { blurCoverScale } = await import("../src/composition/compositing");
    const base = {
      kind: "video",
      fit: "cover",
      width: 1080,
      height: 1920,
    } as const;
    const keyed = {
      ...base,
      keyframes: [
        { property: "blur", frame: 0, value: 0, easing: "linear" },
        { property: "blur", frame: 30, value: 20, easing: "linear" },
      ],
    } as any;
    const start = blurCoverScale({ ...keyed, blur: 0 });
    const middle = blurCoverScale({ ...keyed, blur: 10 });
    const end = blurCoverScale({ ...keyed, blur: 20 });
    expect(start).toBeGreaterThan(1);
    expect(middle).toBe(start);
    expect(end).toBe(start);
    expect(blurCoverScale({ ...base, blur: 0 } as any)).toBe(1);
  });
});
