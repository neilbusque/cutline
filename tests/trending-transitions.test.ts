import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  makeClip,
  newProject,
  transitionKinds,
  validateProject,
} from "../src/shared/model";
import { applyCommands } from "../src/shared/commands";
import { applyAgentEdit } from "../src/shared/agent-edit";
import {
  activeTransition,
  cutsInTheMiddle,
  transitionDefaultSeconds,
  transitionDescriptions,
  transitionNames,
} from "../src/shared/transitions";
import {
  clipWrapperStyle,
  transitionDip,
  transitionEffect,
  transitionStyle,
  shakeTransform,
  glitchSlip,
} from "../src/composition/compositing";
import { EffectFilter } from "../src/composition/EffectFilter";

function fixture() {
  const p = newProject();
  p.assets = [
    {
      id: "image",
      name: "image",
      path: "/tmp/image.png",
      kind: "image",
      duration: 0,
      hasAudio: false,
    },
  ];
  p.clips = [0, 120, 240].map((start) => ({
    ...makeClip(p, "image", "video", start, p.assets[0]),
    duration: 120,
  }));
  return p;
}
const change = (
  p: ReturnType<typeof fixture>,
  kind: string,
  frames?: number,
) =>
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Transition",
    commands: [
      {
        type: "clip.transition",
        id: p.clips[1].id,
        kind,
        ...(frames ? { frames } : {}),
      },
    ],
  });

describe("the transition catalogue", () => {
  it("names and describes every kind the model accepts", () => {
    for (const kind of transitionKinds) {
      expect(transitionNames[kind]).toMatch(/^[A-Z]/);
      expect(transitionDescriptions[kind]).toMatch(/\.$/);
      expect(transitionDefaultSeconds(kind)).toBeGreaterThanOrEqual(0.2);
      expect(transitionDefaultSeconds(kind)).toBeLessThanOrEqual(0.5);
    }
    expect(transitionKinds.length).toBe(16);
  });
  it("accepts every kind as a timeline command and keeps the project valid", () => {
    for (const kind of transitionKinds) {
      const n = change(fixture(), kind, 12);
      expect(() => validateProject(n)).not.toThrow();
      expect(activeTransition(n, n.clips[1])?.kind).toBe(kind);
      expect(n.clips[1].start).toBe(108);
    }
  });
  it("quick cuts default to a few frames and dissolves to half a second", () => {
    expect(transitionDefaultSeconds("flash")).toBe(0.2);
    expect(transitionDefaultSeconds("whip-left")).toBe(0.3);
    expect(transitionDefaultSeconds("crossfade")).toBe(0.5);
    expect(cutsInTheMiddle("flash")).toBe(true);
    expect(cutsInTheMiddle("shake")).toBe(true);
    expect(cutsInTheMiddle("zoom-in")).toBe(false);
  });
  it("an assistant may leave frames out and gets the kind's usual length", () => {
    const p = fixture();
    const n = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Whip",
      actions: [
        { type: "clip.transition", clipId: p.clips[1].id, kind: "whip-left" },
      ],
    }).project;
    expect(activeTransition(n, n.clips[1])?.frames).toBe(9);
    const m = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Glitch",
      actions: [
        {
          type: "clip.transition",
          clipId: p.clips[1].id,
          kind: "glitch",
          frames: 6,
        },
      ],
    }).project;
    expect(activeTransition(m, m.clips[1])?.frames).toBe(6);
  });
});

describe("transition rendering", () => {
  const incoming = (kind: (typeof transitionKinds)[number], frame: number) =>
    transitionStyle({ frame, incoming: { kind, frames: 10, isolated: true } });
  const outgoing = (kind: (typeof transitionKinds)[number], frame: number) =>
    transitionStyle({
      frame: 100 + frame,
      outgoing: { kind, start: 100, frames: 10, isolated: true },
    });
  it("whips move both shots the same way with a little zoom at the peak", () => {
    expect(incoming("whip-left", 0).transform).toContain("translateX(100%)");
    expect(incoming("whip-left", 9).transform).toContain("translateX(0%)");
    expect(outgoing("whip-left", 9).transform).toContain("translateX(-100%)");
    expect(incoming("whip-right", 0).transform).toContain("translateX(-100%)");
    expect(incoming("whip-left", 5).transform).toMatch(/scale\(1\.1\d+\)/);
  });
  it("pushes move vertically and slides keep their old behaviour", () => {
    expect(incoming("push-up", 0).transform).toBe("translateY(100%)");
    expect(outgoing("push-up", 9).transform).toBe("translateY(-100%)");
    expect(incoming("push-down", 0).transform).toBe("translateY(-100%)");
    expect(incoming("slide-left", 0).transform).toBe("translateX(100%)");
  });
  it("zooms and spins put the outgoing shot on top of its own group and fade it", () => {
    for (const kind of ["zoom-in", "zoom-out", "spin"] as const) {
      const style = outgoing(kind, 5);
      expect(style.zIndex).toBe(1);
      expect(style.opacity).toBeGreaterThan(0.3);
      expect(style.opacity).toBeLessThan(0.7);
      expect(style.filter).toMatch(/blur\(/);
      // Behind it, the next shot is fully visible and settles to full frame.
      expect(incoming(kind, 5).opacity).toBeUndefined();
      expect(incoming(kind, 9).transform).toMatch(/scale\(1\)/);
    }
    expect(outgoing("zoom-in", 9).transform).toContain("scale(1.9)");
    expect(outgoing("zoom-out", 9).transform).toContain("scale(0.55)");
    expect(outgoing("spin", 9).transform).toContain("rotate(90deg)");
    expect(incoming("spin", 0).transform).toContain("rotate(-90deg)");
    // Without its own group it falls back to fading the next shot in on top.
    const plain = transitionStyle({
      frame: 105,
      outgoing: { kind: "zoom-in", start: 100, frames: 10 },
    });
    expect(plain.zIndex).toBeUndefined();
    expect(plain.opacity).toBeUndefined();
    expect(
      transitionStyle({ frame: 5, incoming: { kind: "zoom-in", frames: 10 } })
        .opacity,
    ).toBeCloseTo(0.58, 1);
  });
  it("blur dissolves soften the outgoing shot as the next one sharpens", () => {
    expect(outgoing("blur", 9).filter).toBe("blur(22px)");
    expect(incoming("blur", 0).filter).toBe("blur(22px)");
    expect(incoming("blur", 9).filter).toBeUndefined();
    expect(incoming("blur", 9).opacity).toBeUndefined();
  });
  it("flash, shake and glitch are a hard cut in the middle", () => {
    for (const kind of ["flash", "shake", "glitch"] as const) {
      expect(incoming(kind, 0).opacity).toBe(0);
      expect(incoming(kind, 9).opacity).toBeUndefined();
      expect(outgoing(kind, 0).opacity).toBeUndefined();
      expect(outgoing(kind, 9).opacity).toBe(0);
    }
    // The shake is strongest at the cut and gone at the ends.
    expect(incoming("shake", 9).transform).toBeUndefined();
    expect(incoming("shake", 5).transform).toMatch(/translate\(/);
    expect(shakeTransform(3, 0)).toBe("");
    expect(shakeTransform(3, 1)).toMatch(/rotate\(.*deg\) scale\(1\.07\)/);
    expect(glitchSlip(4, 1)).toBe(glitchSlip(5, 1));
    expect(glitchSlip(4, 1)).not.toBe(glitchSlip(6, 1));
  });
  it("flash dips through white, black through black, and nothing else dips", () => {
    expect(transitionDip(5, { kind: "flash", frames: 10 })).toEqual({
      color: "white",
      amount: 1,
    });
    expect(transitionDip(5, { kind: "black", frames: 10 })?.color).toBe(
      "black",
    );
    expect(transitionDip(0, { kind: "flash", frames: 10 })?.amount).toBe(0);
    expect(transitionDip(5, { kind: "whip-left", frames: 10 })).toBeUndefined();
    expect(transitionDip(12, { kind: "flash", frames: 10 })).toBeUndefined();
  });
  it("whips get horizontal motion blur and glitches get tearing, sized to the canvas", () => {
    const whip = transitionEffect({
      frame: 5,
      incoming: { kind: "whip-left", frames: 10 },
      size: 1080,
    });
    expect(whip?.blurX).toBeCloseTo(31.3, 0);
    expect(whip?.blurY).toBe(0);
    expect(whip?.displace).toBe(0);
    expect(
      transitionEffect({
        frame: 0,
        incoming: { kind: "whip-left", frames: 10 },
        size: 1080,
      }),
    ).toBeUndefined();
    const glitch = transitionEffect({
      frame: 104,
      outgoing: { kind: "glitch", start: 100, frames: 10 },
      size: 1080,
    });
    expect(glitch?.displace).toBeGreaterThan(40);
    expect(glitch?.rgb).toBeGreaterThan(8);
    expect(glitch?.seed).toBe(2);
    expect(
      transitionEffect({
        frame: 5,
        incoming: { kind: "crossfade", frames: 10 },
        size: 1080,
      }),
    ).toBeUndefined();
    const push = transitionEffect({
      frame: 5,
      incoming: { kind: "push-up", frames: 10 },
      size: 1080,
    });
    expect(push?.blurY).toBeGreaterThan(10);
    expect(push?.blurX).toBe(0);
  });
  it("the SVG filter only builds the steps the effect needs", () => {
    const whip = renderToStaticMarkup(
      React.createElement(EffectFilter, {
        id: "t",
        effect: {
          blurX: 20,
          blurY: 0,
          displace: 0,
          rgb: 0,
          seed: 0,
          bloom: 0,
          bloomRadius: 0,
        },
      }),
    );
    expect(whip).toContain('stdDeviation="20 0"');
    expect(whip).not.toContain("feDisplacementMap");
    const glitch = renderToStaticMarkup(
      React.createElement(EffectFilter, {
        id: "t",
        effect: {
          blurX: 0,
          blurY: 0,
          displace: 40,
          rgb: 8,
          seed: 7,
          bloom: 0,
          bloomRadius: 0,
        },
      }),
    );
    const halation = renderToStaticMarkup(
      React.createElement(EffectFilter, {
        id: "t",
        effect: {
          blurX: 0,
          blurY: 0,
          displace: 0,
          rgb: 0,
          seed: 0,
          bloom: 0.5,
          bloomRadius: 24,
        },
      }),
    );
    expect(halation).toContain("feComponentTransfer");
    expect(halation).toContain('mode="screen"');
    expect(halation).toContain('stdDeviation="24"');
    expect(glitch).toContain('seed="7"');
    expect(glitch).toContain('scale="40"');
    expect(glitch).toContain('yChannelSelector="G"');
    expect(glitch).toContain('dx="8"');
    expect(glitch).not.toContain("feGaussianBlur");
  });
  it("the wrapper keeps its shadow when a transition adds a filter", () => {
    const p = fixture();
    const c = { ...p.clips[1], shadowBlur: 20 };
    const style = clipWrapperStyle({
      c,
      frame: 105,
      outgoing: { kind: "zoom-in", start: 100, frames: 10, isolated: true },
      filterUrl: "url(#fx)",
    });
    expect(style.filter).toMatch(
      /^url\(#fx\) blur\([\d.]+px\) drop-shadow\(0px 8px 20px #000000\)$/,
    );
    expect(style.zIndex).toBe(1);
  });
});
