import React from "react";
import type { Clip } from "../shared/model";
import {
  presetEntranceOpacity,
  presetTiming,
  type AnimationSpan,
} from "../shared/text-presets";
import {
  captionAccentInk,
  captionActiveWord,
  captionFocusWord,
  captionLayout,
  captionTokens,
  captionTextWidth,
  type CaptionToken,
} from "../shared/caption-layout";

/** Pure frame-driven component shared by the canvas, export, and style previews. */
export function CaptionText({
  clip: c,
  frame,
  fps,
  span,
}: {
  clip: Clip;
  frame: number;
  fps: number;
  /** A split caption keeps one entrance and exit across the cut. */
  span?: AnimationSpan;
}) {
  const seconds = frame / fps,
    active = captionActiveWord(c, seconds),
    style = c.captionStyle;
  const tokens = captionTokens(c),
    focus = style === "focus" && c.words.length > 0;
  const focusWords = focus
    ? Array.from(new Set(tokens.map((token) => token.wordIndex))).map(
        (wordIndex) => ({
          wordIndex,
          text: tokens
            .filter((token) => token.wordIndex === wordIndex)
            .map((token) => token.text)
            .join(" "),
        }),
      )
    : [];
  const measure = (text: string) =>
    captionTextWidth(
      text,
      c.fontSize,
      c.fontFamily,
      c.fontWeight,
      c.captionTracking ?? 0,
    );
  const longest = focus
    ? focusWords.reduce(
        (longest, token) =>
          measure(token.text) > measure(longest.text) ? token : longest,
        { text: "", wordIndex: 0 },
      )
    : undefined;
  const layout = captionLayout(
    longest
      ? {
          ...c,
          words: [{ text: longest.text, start: 0, end: 1 }],
          text: longest.text,
          captionMaxLines: 1,
        }
      : c,
  );
  const align =
    c.align === "left"
      ? "flex-start"
      : c.align === "right"
        ? "flex-end"
        : "center";
  const timing = presetTiming(c, frame, span);
  const { move, pop, exitEased } = timing;
  const loopSeconds = timing.at / fps;
  const transforms: string[] = [];
  if (c.preset === "spring") transforms.push(`scale(${0.86 + 0.14 * pop})`);
  if (["slide", "rise", "lower-third"].includes(c.preset))
    transforms.push(
      `translateY(${(1 - move) * (c.preset === "rise" ? 24 : 35)}px)`,
    );
  if (c.preset === "callout") transforms.push(`scale(${0.94 + 0.06 * pop})`);
  if (c.preset === "flip")
    transforms.push(`perspective(900px) rotateX(${(1 - move) * 90}deg)`);
  if (c.preset === "pulse")
    transforms.push(
      `scale(${1 + 0.025 * Math.sin(loopSeconds * Math.PI * 3)})`,
    );
  if (c.preset === "swing") transforms.push(`rotate(${(1 - pop) * -10}deg)`);
  if (c.exitAnimation === "slide")
    transforms.push(`translateY(${exitEased * 35}px)`);
  if (c.exitAnimation === "shrink")
    transforms.push(`scale(${1 - exitEased * 0.2})`);
  const stroke = layout.strokeWidth;
  // Dark words on a light canvas read cleanly without a dark halo.
  const darkInk =
    /^#[0-9a-f]{6}/iu.test(c.color) &&
    Number.parseInt(c.color.slice(1, 3), 16) * 0.299 +
      Number.parseInt(c.color.slice(3, 5), 16) * 0.587 +
      Number.parseInt(c.color.slice(5, 7), 16) * 0.114 <
      90;
  const textShadow =
    (style === "box" && c.background !== "transparent") ||
    (style === "clean" && darkInk)
      ? "none"
      : style === "minimal"
        ? "0 1px 5px #000b"
        : `0 ${Math.max(1, layout.fontSize * 0.035)}px ${Math.max(3, layout.fontSize * 0.1)}px #000b`;
  const renderWord = (token: CaptionToken, index: number) => {
    const isActive = c.highlight && active === token.wordIndex,
      word = c.words[token.wordIndex];
    const elapsed = Math.max(0, seconds - (word?.start ?? 0));
    const visible = style !== "typewriter" || !word || seconds >= word.start;
    const filled = style === "karaoke" && isActive;
    // A long word gets the same small amount of movement as a short one.
    // Fixed expansion room avoids wide spaces and never pushes its neighbors.
    const popScale = Math.min(
      layout.maxScale,
      token.width / token.contentWidth,
    );
    const scale =
      style === "pop" && isActive
        ? 1 + (popScale - 1) * Math.exp(-elapsed * 15)
        : 1;
    return (
      <span
        key={`${token.wordIndex}:${index}`}
        data-caption-word={token.wordIndex}
        data-active={isActive ? "true" : "false"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 auto",
          width: token.width,
          height: layout.lineHeight,
        }}
      >
        <span
          style={{
            display: "inline-block",
            position: "relative",
            isolation: "isolate",
            boxSizing: "border-box",
            width: token.contentWidth,
            lineHeight: 1.12,
            whiteSpace: "nowrap",
            textAlign: "center",
            color: filled
              ? captionAccentInk(c.accent)
              : isActive
                ? c.accent
                : c.color,
            opacity: visible ? 1 : 0,
            transform: `scale(${scale})`,
            WebkitTextStroke: filled
              ? "0px transparent"
              : `${stroke}px #101511`,
            paintOrder: "stroke fill",
            textShadow: filled ? "none" : textShadow,
          }}
        >
          {filled && (
            <span
              aria-hidden="true"
              data-caption-pill="true"
              style={{
                position: "absolute",
                inset: `${-layout.fontSize * 0.045}px ${-layout.wordPadding}px`,
                borderRadius: Math.max(4, layout.fontSize * 0.15),
                background: c.accent,
                zIndex: -1,
              }}
            />
          )}
          {token.text}
        </span>
      </span>
    );
  };
  let lines = layout.lines;
  if (focus) {
    const focusIndex = captionFocusWord(c, seconds),
      word =
        tokens
          .filter((token) => token.wordIndex === focusIndex)
          .map((token) => token.text)
          .join(" ") ||
        tokens[0]?.text ||
        "";
    const focusLayout = captionLayout({
      ...c,
      captionStyle: "standard",
      fontSize: layout.fontSize,
      captionTracking: layout.tracking,
      captionStrokeWidth: layout.strokeWidth,
      words: [{ text: word, start: 0, end: 1 }],
      text: word,
      captionMaxLines: 1,
    });
    lines = focusLayout.lines.map((line) => ({
      ...line,
      tokens: line.tokens.map((token) => ({ ...token, wordIndex: focusIndex })),
    }));
  }
  const pill = style === "pill" && c.background !== "transparent";
  const wrap = (children: React.ReactNode) =>
    pill ? (
      <div
        data-caption-pill="true"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: `${layout.fontSize * 0.16}px ${layout.fontSize * 0.42}px`,
          background: c.background,
          borderRadius: layout.fontSize * 0.3,
        }}
      >
        {children}
      </div>
    ) : (
      children
    );
  return (
    <div
      data-caption-layout="balanced"
      data-caption-style={style}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: align,
        justifyContent: "center",
        boxSizing: "border-box",
        padding: `${layout.paddingY}px ${layout.paddingX}px`,
        // A pill hugs its words; other styles fill the caption box.
        background: pill ? "transparent" : c.background,
        borderRadius: Math.max(6, Math.min(22, layout.fontSize * 0.25)),
        fontFamily: c.fontFamily,
        fontWeight: c.fontWeight,
        fontSize: layout.fontSize,
        fontKerning: "none",
        fontVariantLigatures: "none",
        letterSpacing: layout.tracking,
        color: c.color,
        textAlign: c.align,
        overflow: "hidden",
        opacity:
          presetEntranceOpacity(c.preset, timing) *
          (c.exitAnimation && c.exitAnimation !== "none" ? 1 - exitEased : 1),
        transform: transforms.join(" ") || "none",
        filter:
          c.preset === "blur-in" ? `blur(${(1 - move) * 12}px)` : undefined,
        clipPath:
          c.preset === "wipe" ? `inset(0 ${(1 - move) * 100}% 0 0)` : undefined,
      }}
    >
      {wrap(
        lines.map((line, index) => (
          <div
            key={index}
            data-caption-line={index}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: align,
              gap: layout.gap,
              flex: "0 0 auto",
              height: layout.lineHeight,
              width: pill ? "auto" : "100%",
              whiteSpace: "nowrap",
              transform:
                c.align === "center" && line.centerOffset
                  ? `translateX(${line.centerOffset}px)`
                  : undefined,
            }}
          >
            {line.tokens.map(renderWord)}
          </div>
        )),
      )}
    </div>
  );
}
