import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClipSchema, makeClip, newProject } from "../src/shared/model";
import {
  cameraMoveDescriptions,
  cameraMoves,
  cameraTransform,
  overlayDescriptions,
  overlayNames,
} from "../src/shared/effects";
import { FinishingOverlay } from "../src/composition/FinishingOverlay";
import { finishingEffect } from "../src/composition/compositing";

const clip = () => ({
  ...makeClip(newProject(), "video", "video"),
  duration: 90,
  width: 1080,
  height: 1920,
});

describe("impact camera moves", () => {
  it("every move the model accepts is listed and described", () => {
    for (const move of cameraMoves) {
      expect(cameraMoveDescriptions[move]).toMatch(/\.$/);
      expect(() =>
        ClipSchema.parse({ ...clip(), cameraMotion: move }),
      ).not.toThrow();
    }
    expect(ClipSchema.shape.cameraMotion.removeDefault().options).toEqual(
      cameraMoves,
    );
  });
  it("punch-out starts tight and settles to full frame in a fifth of a second", () => {
    const c = { ...clip(), cameraMotion: "punch-out" as const };
    expect(cameraTransform(c, 0)).toBe("scale(1.18)");
    expect(cameraTransform(c, 6)).toBe("scale(1)");
    expect(cameraTransform(c, 60)).toBe("scale(1)");
  });
  it("pop-in springs from 82% and rests at full size", () => {
    const c = { ...clip(), cameraMotion: "pop-in" as const };
    expect(cameraTransform(c, 0)).toBe("scale(0.82)");
    const peak = Math.max(
      ...Array.from({ length: 13 }, (_, f) =>
        Number(cameraTransform(c, f).match(/scale\(([\d.]+)\)/)![1]),
      ),
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.06);
    expect(cameraTransform(c, 12)).toBe("scale(1)");
    expect(cameraTransform(c, 80)).toBe("scale(1)");
  });
  it("shake knocks the frame at the cut and is still within half a second", () => {
    const c = { ...clip(), cameraMotion: "shake" as const };
    const first = cameraTransform(c, 1);
    expect(first).toMatch(/^scale\(1\.05\) translate\(.*px,.*px\) rotate\(.*deg\)$/);
    const offset = (t: string) =>
      Math.abs(Number(t.match(/translate\((-?[\d.]+)px/)?.[1] ?? 0));
    const early = Math.max(
      ...Array.from({ length: 8 }, (_, f) => offset(cameraTransform(c, f))),
    );
    const late = Math.max(
      ...Array.from({ length: 8 }, (_, f) => offset(cameraTransform(c, 14 + f))),
    );
    expect(early).toBeGreaterThan(5);
    expect(late).toBeLessThan(early / 2);
    expect(cameraTransform(c, 30)).toBe("scale(1.05)");
    // The same at 60 fps, measured in seconds.
    expect(cameraTransform(c, 60, { fps: 60 })).toBe("scale(1.05)");
    // A split keeps the same knock going instead of restarting it.
    expect(
      cameraTransform(c, 0, { span: { phase: 12, length: 90 } }),
    ).toBe(cameraTransform(c, 12));
  });
});

describe("finishing overlays", () => {
  const render = (overlay: string, frame: number, amount = 0.5) =>
    renderToStaticMarkup(
      React.createElement(FinishingOverlay, {
        clip: { ...clip(), overlay: overlay as never, overlayAmount: amount },
        frame,
      }),
    );
  it("every overlay the model accepts is named and described", () => {
    expect(Object.keys(overlayNames)).toEqual(
      ClipSchema.shape.overlay.removeDefault().options,
    );
    for (const key of Object.keys(overlayNames))
      expect(overlayDescriptions[key as keyof typeof overlayNames]).toMatch(
        /\.$/,
      );
  });
  it("letterbox draws two black bars sized by strength", () => {
    const half = render("letterbox", 10);
    expect(half.match(/height:13%/g)?.length).toBe(2);
    expect(render("letterbox", 10, 1)).toContain("height:26%");
    expect(render("letterbox", 10)).toBe(render("letterbox", 400));
  });
  it("flash cut is white on the first frame and gone by the sixth", () => {
    expect(render("flash-in", 0)).toContain("opacity:1");
    expect(render("flash-in", 3)).toMatch(/opacity:0\.2[45]/);
    expect(render("flash-in", 6)).toBe("");
    expect(render("flash-in", 0, 0.25)).toContain("opacity:0.5");
  });
  it("glitch overlays faint scan lines and tears the picture only in bursts", () => {
    expect(render("glitch", 4)).toContain("repeating-linear-gradient");
    const c = { ...clip(), overlay: "glitch" as const, overlayAmount: 0.5 };
    const bursts = Array.from({ length: 120 }, (_, f) =>
      finishingEffect(c, f),
    ).filter(Boolean);
    expect(bursts.length).toBeGreaterThan(15);
    expect(bursts.length).toBeLessThan(60);
    expect(finishingEffect(c, 0)).toEqual(finishingEffect(c, 2));
    const burst = bursts[0]!;
    expect(burst.displace).toBe(32.4);
    expect(burst.rgb).toBeGreaterThan(5);
    expect(finishingEffect({ ...c, overlayAmount: 0 }, 0)).toBeUndefined();
  });
  it("halation glows from the highlights with a radius that follows the strength", () => {
    const c = { ...clip(), overlay: "halation" as const, overlayAmount: 0.5 };
    expect(finishingEffect(c, 7)).toMatchObject({
      bloom: 0.675,
      bloomRadius: 29.16,
      displace: 0,
    });
    expect(finishingEffect({ ...c, overlayAmount: 1 }, 7)?.bloom).toBe(1);
    expect(render("halation", 7)).toBe("");
    expect(
      finishingEffect({ ...c, overlay: "film-grain" }, 7),
    ).toBeUndefined();
  });
});
