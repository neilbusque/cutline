import type { Clip } from "./model";
import { captionFontMetrics } from "./caption-font-metrics";

export type CaptionToken = {
  text: string;
  wordIndex: number;
  width: number;
  contentWidth: number;
};
export type CaptionLine = {
  wordIndices: number[];
  text: string;
  tokens: CaptionToken[];
  width: number;
  centerOffset: number;
};
export type CaptionLayout = {
  lines: CaptionLine[];
  fontSize: number;
  gap: number;
  lineHeight: number;
  paddingX: number;
  paddingY: number;
  wordPadding: number;
  maxScale: number;
  strokeWidth: number;
  tracking: number;
  contentWidth: number;
  contentHeight: number;
};
type LayoutClip = Pick<
  Clip,
  | "text"
  | "words"
  | "width"
  | "height"
  | "fontSize"
  | "fontFamily"
  | "fontWeight"
  | "captionStyle"
> &
  Partial<
    Pick<
      Clip,
      | "captionCase"
      | "captionTracking"
      | "captionStrokeWidth"
      | "captionMaxLines"
    >
  >;

export function captionTokens(
  clip: Pick<LayoutClip, "text" | "words" | "captionCase">,
): { text: string; wordIndex: number }[] {
  const words = clip.words.length
    ? clip.words.map((word, wordIndex) => ({ text: word.text, wordIndex }))
    : clip.text
        .trim()
        .split(/\s+/u)
        .map((text, wordIndex) => ({ text, wordIndex }));
  return words.flatMap((word) =>
    word.text
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map((text) => ({
        text:
          clip.captionCase === "upper" ? text.toLocaleUpperCase("en-US") : text,
        wordIndex: word.wordIndex,
      })),
  );
}

/** Matching font metrics and disabled kerning make preview/export layout deterministic. */
export function captionTextWidth(
  text: string,
  fontSize: number,
  fontFamily: Clip["fontFamily"],
  fontWeight: Clip["fontWeight"],
  tracking = 0,
): number {
  const metrics =
    captionFontMetrics[`${fontFamily}:${fontWeight}`] ??
    captionFontMetrics["Arial:800"];
  const chars = Array.from(text.normalize("NFD"));
  let units = 0,
    count = 0;
  for (const char of chars) {
    if (/\p{Mark}|\u200d|\ufe0f/u.test(char)) continue;
    const point = char.codePointAt(0)!;
    const punctuation: Record<string, string> = {
      "’": "'",
      "‘": "'",
      "“": '"',
      "”": '"',
    };
    if (point >= 32 && point < 127) units += metrics[point - 32];
    else if (punctuation[char])
      units += Array.from(punctuation[char]).reduce(
        (sum, c) => sum + metrics[c.charCodeAt(0) - 32],
        0,
      );
    else units += fontFamily === "Courier New" ? 650 : 1150;
    count++;
  }
  return Math.max(0.01, (units / 1000) * fontSize + count * tracking);
}

/** Fixed word slots and explicit gaps keep highlights from changing line breaks. */
export function captionLayout(clip: LayoutClip): CaptionLayout {
  const source = captionTokens(clip),
    maxLines = clip.captionMaxLines ?? 2;
  const paddingX = Math.min(28, Math.max(2, clip.width * 0.035)),
    paddingY = Math.min(16, Math.max(2, clip.height * 0.07));
  const availableWidth = Math.max(1, clip.width - paddingX * 2),
    availableHeight = Math.max(1, clip.height - paddingY * 2);
  const maxScale = clip.captionStyle === "pop" ? 1.06 : 1;
  const build = (fontSize: number) => {
    const stroke = ((clip.captionStrokeWidth ?? 2) * fontSize) / clip.fontSize,
      tracking = ((clip.captionTracking ?? 0) * fontSize) / clip.fontSize;
    // Highlight decoration sits outside the text advance. Reserving pill
    // padding on every word used to make ordinary spaces almost twice as wide.
    const wordPadding = clip.captionStyle === "karaoke" ? fontSize * 0.065 : 0;
    const popRoom = clip.captionStyle === "pop" ? fontSize * 0.08 : 0;
    const naturalSpace = captionTextWidth(
      " ",
      fontSize,
      clip.fontFamily,
      clip.fontWeight,
      tracking,
    );
    const gap = Math.max(fontSize * 0.08, naturalSpace - stroke * 2 - popRoom);
    const lineHeight =
      fontSize * 1.16 * maxScale +
      stroke * 2 +
      (clip.captionStyle === "karaoke" ? fontSize * 0.03 : 0);
    const tokens: CaptionToken[] = source.map((token) => {
      const contentWidth =
        captionTextWidth(
          token.text,
          fontSize,
          clip.fontFamily,
          clip.fontWeight,
          tracking,
        ) +
        stroke * 2;
      return { ...token, contentWidth, width: contentWidth + popRoom };
    });
    const line = (items: CaptionToken[]): CaptionLine => ({
      wordIndices: items.map((token) => token.wordIndex),
      text: items.map((token) => token.text).join(" "),
      tokens: items,
      width:
        items.reduce((sum, token) => sum + token.width, 0) +
        Math.max(0, items.length - 1) * gap,
      // Every word reserves the same room, so text and slot centers coincide.
      centerOffset: 0,
    });
    let lines = [line(tokens)];
    if (
      maxLines === 2 &&
      tokens.length > 1 &&
      lines[0].width > availableWidth
    ) {
      let score = Infinity,
        chosen = 1,
        leftTokensWidth = 0;
      const totalTokensWidth = tokens.reduce(
        (sum, token) => sum + token.width,
        0,
      );
      for (let split = 1; split < tokens.length; split++) {
        leftTokensWidth += tokens[split - 1].width;
        const leftWidth = leftTokensWidth + (split - 1) * gap,
          rightWidth =
            totalTokensWidth -
            leftTokensWidth +
            (tokens.length - split - 1) * gap;
        // The widest row governs fit; the difference is the visual balance.
        const value =
          Math.max(leftWidth, rightWidth) +
          Math.abs(leftWidth - rightWidth) * 0.16;
        if (value < score) {
          score = value;
          chosen = split;
        }
      }
      lines = [line(tokens.slice(0, chosen)), line(tokens.slice(chosen))];
    }
    return {
      lines,
      fontSize,
      gap,
      lineHeight,
      paddingX,
      paddingY,
      wordPadding,
      maxScale,
      strokeWidth: stroke,
      tracking,
      contentWidth: Math.max(0, ...lines.map((line) => line.width)),
      contentHeight: lines.length * lineHeight,
    };
  };
  const fits = (layout: CaptionLayout) =>
    layout.contentWidth <= availableWidth + 0.001 &&
    layout.contentHeight <= availableHeight + 0.001;
  let result = build(Math.max(0.01, clip.fontSize));
  if (fits(result)) return result;
  let low = 0.01,
    high = clip.fontSize;
  for (let i = 0; i < 28; i++) {
    const middle = (low + high) / 2,
      next = build(middle);
    if (fits(next)) low = middle;
    else high = middle;
  }
  result = build(low);
  return result;
}

export function captionActiveWord(
  clip: Pick<Clip, "words">,
  seconds: number,
): number {
  return clip.words.findIndex(
    (word) => seconds >= word.start && seconds < word.end,
  );
}

/** Focus captions hold the preceding word through a pause, avoiding blank flashes. */
export function captionFocusWord(
  clip: Pick<Clip, "words">,
  seconds: number,
): number {
  const active = captionActiveWord(clip, seconds);
  if (active >= 0) return active;
  for (let i = clip.words.length - 1; i >= 0; i--)
    if (seconds >= clip.words[i].start) return i;
  return 0;
}

export function captionAccentInk(accent: string): string {
  let value = accent.replace("#", "");
  if (value.length === 3 || value.length === 4)
    value = value
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value)) return "#000000";
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#000000" : "#ffffff";
}
