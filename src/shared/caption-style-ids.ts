/** Caption looks, in the order the Captions panel shows them. */
export const captionStyleIds = [
  "standard",
  "karaoke",
  "pop",
  "box",
  "typewriter",
  "outline",
  "focus",
  "minimal",
  "pill",
  "clean",
  "heavy",
  "impact",
  "bounce",
  "neon",
] as const;
export type CaptionStyleId = (typeof captionStyleIds)[number];
/** Looks whose spoken word grows a little, so their layout reserves room for it. */
export const growingCaptionStyles: ReadonlySet<CaptionStyleId> = new Set([
  "pop",
  "impact",
  "bounce",
]);
/** Looks whose words appear as they are spoken instead of all at once. */
export const arrivingCaptionStyles: ReadonlySet<CaptionStyleId> = new Set([
  "typewriter",
  "bounce",
]);
