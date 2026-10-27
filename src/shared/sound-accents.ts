/**
 * The short sounds creators put on cuts and graphics. Cutline makes them on
 * this Mac from scratch (see main/sfx.ts), so there is nothing to download
 * and nothing to credit.
 */
export const soundAccentKinds = [
  "whoosh",
  "impact",
  "pop",
  "click",
  "riser",
  "ding",
] as const;
export type SoundAccentKind = (typeof soundAccentKinds)[number];
export const soundAccentNames: Record<SoundAccentKind, string> = {
  whoosh: "Whoosh",
  impact: "Impact",
  pop: "Pop",
  click: "Click",
  riser: "Riser",
  ding: "Ding",
};
/** Length in seconds; each is trimmed to its natural tail. */
export const soundAccentSeconds: Record<SoundAccentKind, number> = {
  whoosh: 0.4,
  impact: 0.55,
  pop: 0.14,
  click: 0.07,
  riser: 1.2,
  ding: 0.7,
};
export const soundAccentDescriptions: Record<SoundAccentKind, string> = {
  whoosh: "Air rushing past: a whip, slide or something flying in.",
  impact: "A low hit with a click on top: a zoom punch, a reveal, a big word.",
  pop: "A small bright pop: a word, a sticker or a logo appearing.",
  click: "A dry tick: a cut, a cursor click, a checklist item.",
  riser: "Rising tension over a second: put the reveal where it ends.",
  ding: "A soft bell: a result, a notification, a point made.",
};
/**
 * Where an accent sits against its event: a hair before the frame, so the
 * sound and the picture land together ("early is safe, late is fatal").
 */
export const soundAccentLeadFrames = 2;
