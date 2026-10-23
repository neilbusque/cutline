import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeClip, newProject, type Clip } from "../src/shared/model";
import {
  captionLayout,
  captionTextWidth,
  captionTokens,
  captionActiveWord,
  captionFocusWord,
  captionAccentInk,
} from "../src/shared/caption-layout";
import { CaptionText } from "../src/composition/CaptionText";

function fixture(
  text = "Small moments make better stories",
  patch: Partial<Clip> = {},
): Clip {
  const p = newProject();
  return {
    ...makeClip(p, "caption", "captions", 0),
    width: 850,
    height: 240,
    fontSize: 82,
    captionLayout: "balanced",
    captionMaxLines: 2,
    text,
    words: text.split(/\s+/).map((text, index) => ({
      text,
      start: index * 0.4,
      end: index * 0.4 + 0.32,
    })),
    duration: 120,
    ...patch,
  };
}
function assertFits(c: Clip) {
  const layout = captionLayout(c);
  expect(layout.lines.length).toBeLessThanOrEqual(c.captionMaxLines);
  expect(layout.contentWidth).toBeLessThanOrEqual(
    c.width - layout.paddingX * 2 + 0.01,
  );
  expect(layout.contentHeight).toBeLessThanOrEqual(
    c.height - layout.paddingY * 2 + 0.01,
  );
  expect(
    layout.lines.flatMap((line) => line.tokens).map((token) => token.text),
  ).toEqual(captionTokens(c).map((token) => token.text));
  expect(layout.fontSize).toBeGreaterThan(0);
  expect(layout.fontSize).toBeLessThanOrEqual(c.fontSize);
  return layout;
}
describe("deterministic balanced caption layout", () => {
  it("keeps boxed caption ink crisp while preserving shadows over footage", () => {
    const clip = fixture("One clear idea", {
      captionStyle: "box",
      background: "#faf7ef",
      color: "#26352f",
      captionStrokeWidth: 0,
    });
    const render = (background: string) =>
      renderToStaticMarkup(
        React.createElement(CaptionText, {
          clip: { ...clip, background },
          frame: 1,
          fps: 30,
        }),
      );
    const boxed = render(clip.background);
    expect(boxed).toContain("text-shadow:none");
    expect(boxed).not.toContain("#000b");
    expect(render("transparent")).toContain("#000b");
  });
  it("keeps short and long Punch words centered without proportional empty space", () => {
    const clip = fixture("I choose extraordinary opportunities", {
      captionStyle: "pop",
      captionCase: "upper",
      width: 842.4,
      height: 259.2,
    });
    const layout = captionLayout(clip);
    expect(
      layout.lines.every((line) => Math.abs(line.centerOffset) < 0.001),
    ).toBe(true);
    for (const line of layout.lines) {
      const first = line.tokens[0],
        last = line.tokens.at(-1)!;
      const leftMargin = (first.width - first.contentWidth) / 2,
        rightMargin = (last.width - last.contentWidth) / 2;
      expect((leftMargin - rightMargin) / 2 + line.centerOffset).toBeCloseTo(
        0,
        10,
      );
      for (const token of line.tokens)
        expect(token.width - token.contentWidth).toBeCloseTo(
          layout.fontSize * 0.08,
          10,
        );
    }
    const centered = renderToStaticMarkup(
      React.createElement(CaptionText, { clip, frame: 100, fps: 30 }),
    );
    expect(centered).not.toContain("transform:translateX(");
    for (const align of ["left", "right"] as const) {
      const aligned = renderToStaticMarkup(
        React.createElement(CaptionText, {
          clip: { ...clip, align },
          frame: 100,
          fps: 30,
        }),
      );
      expect(aligned).not.toContain("transform:translateX(");
    }
    expect(
      captionLayout({ ...clip, captionStyle: "standard" }).lines.every(
        (line) => line.centerOffset === 0,
      ),
    ).toBe(true);
  });
  it("balances two rows, retains every word and reserves explicit readable gaps", () => {
    const c = fixture(),
      layout = assertFits(c);
    expect(layout.lines).toHaveLength(2);
    expect(layout.gap).toBeGreaterThanOrEqual(layout.fontSize * 0.08);
    expect(
      Math.min(...layout.lines.map((line) => line.width)) /
        Math.max(...layout.lines.map((line) => line.width)),
    ).toBeGreaterThan(0.55);
    expect(layout.lines.map((line) => line.text).join(" ")).toBe(c.text);
  });
  it("uses the font's natural word space without doubling pill padding or animation room", () => {
    for (const captionStyle of [
      "standard",
      "karaoke",
      "pop",
      "outline",
    ] as const) {
      const c = fixture("A better morning starts", {
        captionStyle,
        fontSize: 74,
        captionStrokeWidth: 2,
        width: 1600,
      });
      const layout = assertFits(c),
        tokens = layout.lines[0].tokens;
      for (let i = 1; i < tokens.length; i++) {
        const left = tokens[i - 1],
          right = tokens[i];
        const advance = (text: string) =>
          captionTextWidth(
            text,
            layout.fontSize,
            c.fontFamily,
            c.fontWeight,
            layout.tracking,
          );
        const restingSpace =
          layout.gap +
          (left.width - advance(left.text)) / 2 +
          (right.width - advance(right.text)) / 2;
        expect(restingSpace).toBeCloseTo(advance(" "), 8);
      }
      expect(layout.lineHeight).toBeLessThan(layout.fontSize * 1.32);
    }
  });
  it("draws Spotlight pills outside fixed word slots and keeps neighboring words still", () => {
    const clip = fixture("A better morning starts", {
      captionStyle: "karaoke",
    });
    const html = renderToStaticMarkup(
      React.createElement(CaptionText, { clip, frame: 1, fps: 30 }),
    );
    expect(html).toContain(
      'data-caption-pill="true" style="position:absolute;',
    );
    const layout = assertFits(clip);
    for (const token of layout.lines.flatMap((line) => line.tokens))
      expect(token.width).toBe(token.contentWidth);
    expect(layout.wordPadding).toBeLessThan(layout.gap / 2);
  });
  it("fits long phrases, unbroken words, tracking, stroke and supported fonts inside one or two rows", () => {
    for (const text of [
      "Supercalifragilisticexpialidocious",
      "An exceptionally complicated sentence with many extraordinary opportunities",
      "WWW iii café déjà vu 2026",
      "東京都の静かな朝",
      "A ".repeat(400).trim(),
    ])
      for (const fontFamily of [
        "Arial",
        "Helvetica",
        "Georgia",
        "Courier New",
      ] as const)
        for (const captionMaxLines of [1, 2] as const)
          for (const captionTracking of [-5, 0, 20])
            assertFits(
              fixture(text, {
                fontFamily,
                captionMaxLines,
                captionTracking,
                captionStrokeWidth: 12,
                captionCase: "upper",
                width: 620,
                height: 150,
              }),
            );
  });
  it("splits phrase tokens without losing their exact source word identity", () => {
    const c = fixture("New York feels alive", {
      words: [
        { text: "New York", start: 0, end: 0.8 },
        { text: "feels alive", start: 0.8, end: 1.4 },
      ],
      captionCase: "upper",
    });
    expect(captionTokens(c)).toEqual([
      { text: "NEW", wordIndex: 0 },
      { text: "YORK", wordIndex: 0 },
      { text: "FEELS", wordIndex: 1 },
      { text: "ALIVE", wordIndex: 1 },
    ]);
    assertFits(c);
  });
  it("fits every style using constant word slots throughout active highlights and reveals", () => {
    for (const captionStyle of [
      "standard",
      "karaoke",
      "pop",
      "box",
      "typewriter",
      "outline",
      "focus",
      "minimal",
    ] as const) {
      const c = fixture(undefined, { captionStyle });
      assertFits(c);
      const markup = (frame: number) =>
        renderToStaticMarkup(
          React.createElement(CaptionText, { clip: c, frame, fps: 30 }),
        );
      const slots = (html: string) =>
        [
          ...html.matchAll(/data-caption-word="(\d+)"[^>]*style="([^"]+)"/g),
        ].map((match) => ({ word: match[1], style: match[2] }));
      if (captionStyle !== "focus")
        expect(slots(markup(2))).toEqual(slots(markup(40)));
      expect(markup(2)).toContain("gap:");
      expect(markup(2)).toContain("font-kerning:none");
    }
  });
});
describe("caption timing and active-word contrast", () => {
  it("uses half-open word boundaries and keeps a focus word visible through pauses", () => {
    const c = fixture("one two", {
      words: [
        { text: "one", start: 0, end: 0.3 },
        { text: "two", start: 0.5, end: 0.8 },
      ],
    });
    expect(captionActiveWord(c, 0.299)).toBe(0);
    expect(captionActiveWord(c, 0.3)).toBe(-1);
    expect(captionActiveWord(c, 0.5)).toBe(1);
    expect(captionFocusWord(c, 0.4)).toBe(0);
    expect(captionFocusWord(c, 0.9)).toBe(1);
  });
  it("uses contrasting text on light and dark filled highlights and honors disabled highlighting", () => {
    expect(captionAccentInk("#c6f16d")).toBe("#000000");
    expect(captionAccentInk("#172068")).toBe("#ffffff");
    const clip = fixture(undefined, {
      captionStyle: "karaoke",
      highlight: false,
    });
    const html = renderToStaticMarkup(
      React.createElement(CaptionText, { clip, frame: 1, fps: 30 }),
    );
    expect(html).not.toContain('data-active="true"');
    expect(html).not.toContain(`background:${clip.accent}`);
  });
  it("reveals only elapsed words without removing their fixed slots", () => {
    const c = fixture("one two three", { captionStyle: "typewriter" });
    const html = renderToStaticMarkup(
      React.createElement(CaptionText, { clip: c, frame: 1, fps: 30 }),
    );
    expect([...html.matchAll(/data-caption-word=/g)]).toHaveLength(3);
    expect([...html.matchAll(/opacity:0/g)]).toHaveLength(2);
  });
  it("shows the entire corrected phrase in Focus when alignment was deliberately removed", () => {
    const text = "This corrected sentence keeps every word visible";
    const clip = fixture(text, {
      captionStyle: "focus",
      words: [],
      width: 850,
      height: 240,
    });
    const html = renderToStaticMarkup(
      React.createElement(CaptionText, { clip, frame: 25, fps: 30 }),
    );
    expect([...html.matchAll(/data-caption-word=/g)]).toHaveLength(
      text.split(" ").length,
    );
    expect(html).not.toContain('data-active="true"');
    for (const word of text.split(" "))
      expect(html).toContain(`>${word}</span>`);
    const layout = assertFits(clip);
    expect(layout.fontSize).toBeGreaterThan(40);
  });
});
