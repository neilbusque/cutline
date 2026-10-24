/**
 * The part of a vertical video that Instagram, TikTok and YouTube Shorts
 * leave clear: their top bar, the buttons down the right side and the
 * description at the bottom cover the rest. Fractions of the canvas width
 * (left, right) and height (top, bottom). The preview's Reel safe area guide
 * draws this box, and built-in caption and title placements stay inside it.
 */
export const reelSafeArea = {
  left: 0.08,
  right: 0.85,
  top: 0.12,
  bottom: 0.79,
} as const;
