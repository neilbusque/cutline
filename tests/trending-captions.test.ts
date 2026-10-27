import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CaptionText } from "../src/composition/CaptionText";
import { TextGraphicAtFrame } from "../src/composition/Video";
import {
  ClipSchema,
  fontFamilies,
  makeClip,
  newProject,
  captionStyleIds,
  type Clip,
  type Word,
} from "../src/shared/model";
import {
  captionBounceScale,
  captionStylePatch,
  captionStyles,
  captionWordStyle,
} from "../src/shared/caption-styles";
import { captionFontMetrics } from "../src/shared/caption-font-metrics";
import { captionLayout, captionTextWidth } from "../src/shared/caption-layout";
import { StoryPlanSchema } from "../src/shared/story-schema";

const words: Word[] = [
  { text: "This", start: 0, end: 0.3 },
  { text: "changes", start: 0.3, end: 0.7 },
  { text: "everything", start: 0.7, end: 1.2 },
];
function caption(style: Clip["captionStyle"]): Clip {
  const p = newProject();
  p.width = 1080;
  p.height = 1920;
  return {
    ...makeClip(p, "caption", "captions"),
    ...captionStylePatch(style, p),
    width: 900,
    height: 400,
    duration: 60,
    words,
    text: words.map((w) => w.text).join(" "),
  };
}
const render = (c: Clip, frame: number) =>
  renderToStaticMarkup(
    React.createElement(CaptionText, { clip: c, frame, fps: 30 }),
  );

describe("trending caption looks", () => {
  it("the catalogue, the model and the story plan agree on the looks", () => {
    expect(captionStyles.map((s) => s.id)).toEqual([...captionStyleIds]);
    expect(ClipSchema.shape.captionStyle.removeDefault().options).toEqual(
      captionStyleIds,
    );
    expect(
      StoryPlanSchema.shape.captionStyle.removeDefault().options,
    ).toEqual(captionStyleIds);
    for (const style of captionStyles) expect(style.name).toMatch(/^[A-Z]/);
  });
  it("the heavy fonts are real choices with layout metrics for every weight", () => {
    expect(fontFamilies).toContain("Arial Black");
    expect(fontFamilies).toContain("Impact");
    for (const family of fontFamilies)
      for (const weight of ["400", "600", "800"] as const)
        expect(captionFontMetrics[`${family}:${weight}`]).toHaveLength(95);
    // Arial Black is far wider than Arial Bold, so layout must know it.
    expect(
      captionTextWidth("EVERYTHING", 100, "Arial Black", "800"),
    ).toBeGreaterThan(captionTextWidth("EVERYTHING", 100, "Arial", "800") * 1.1);
    expect(captionTextWidth("EVERYTHING", 100, "Impact", "800")).toBeLessThan(
      captionTextWidth("EVERYTHING", 100, "Arial", "800"),
    );
  });
  it("Impact is uppercase Arial Black with a thick outline and a yellow word pop", () => {
    const c = caption("impact");
    expect(c).toMatchObject({
      fontFamily: "Arial Black",
      captionCase: "upper",
      accent: "#ffd93d",
      highlight: true,
    });
    expect(c.captionStrokeWidth).toBeGreaterThanOrEqual(8);
    const active = render(c, 12);
    expect(active).toContain('data-active="true"');
    expect(active).toContain("THIS");
    expect(active).toContain("color:#ffd93d");
    // The spoken word pops and settles like the Punch look.
    expect(captionWordStyle(c, 0, 0.001).scale).toBeGreaterThan(1.05);
    expect(captionWordStyle(c, 0, 0.29).scale).toBeLessThan(1.01);
    expect(captionLayout(c).maxScale).toBe(1.06);
  });
  it("Bounce words arrive as they are spoken, spring past full size and settle", () => {
    const c = caption("bounce");
    expect(captionBounceScale(0)).toBe(0.5);
    const peak = Math.max(
      ...Array.from({ length: 30 }, (_, i) => captionBounceScale(i / 100)),
    );
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.1);
    expect(captionBounceScale(0.5)).toBe(1);
    // Not yet spoken: hidden; just spoken: small; later: full size.
    expect(captionWordStyle(c, 2, 0.5)).toMatchObject({
      visible: false,
      scale: 1,
    });
    expect(captionWordStyle(c, 2, 0.7).scale).toBe(0.5);
    expect(captionWordStyle(c, 0, 1.0).scale).toBe(1);
    const early = render(c, 0);
    expect(early).toContain("opacity:0");
    expect(early).toContain("scale(0.5)");
    expect(captionLayout(c).maxScale).toBe(1.1);
    // The layout reserves room, so the overshoot never pushes neighbours.
    const layout = captionLayout(c);
    for (const token of layout.lines.flatMap((line) => line.tokens))
      expect(token.width).toBeGreaterThan(token.contentWidth);
  });
  it("Neon glows in the accent and lights the spoken word brightest", () => {
    const c = caption("neon");
    const markup = render(c, 12);
    expect(markup).toContain("#4df3ff");
    const glows = markup.match(/text-shadow:[^;"]+/g) ?? [];
    expect(glows.length).toBe(3);
    const lit = glows.find((g) => g.split("#4df3ff").length > 2);
    expect(lit).toBeDefined();
    expect(c.captionStrokeWidth).toBe(0);
  });
  it("older projects keep their look: the legacy caption layout follows the same rules", () => {
    const c = { ...caption("bounce"), captionLayout: "legacy" as const };
    const markup = renderToStaticMarkup(
      React.createElement(TextGraphicAtFrame, { c, frame: 0, fps: 30 }),
    );
    expect(markup).toContain("opacity:0");
    expect(markup).toContain("scale(0.5)");
    for (const style of captionStyleIds)
      expect(() =>
        renderToStaticMarkup(
          React.createElement(CaptionText, {
            clip: caption(style),
            frame: 15,
            fps: 30,
          }),
        ),
      ).not.toThrow();
  });
});
