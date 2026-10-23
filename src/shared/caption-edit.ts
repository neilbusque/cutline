import type { Clip } from "./model";

/** Text corrections never guess new speech timings or move the caption itself. */
export function captionTextPatch(
  clip: Pick<Clip, "text" | "words">,
  input: string,
): { patch: Partial<Clip>; timing: "preserved" | "cleared" } {
  const text = input.trim().replace(/\s+/g, " ");
  if (!text) throw new Error("Enter at least one word.");
  if (text.length > 10000)
    throw new Error("Keep this phrase under 10,000 characters.");
  const tokens = text.split(/\s+/);
  const aligned =
    clip.words.length > 0 &&
    tokens.length === clip.words.length &&
    clip.text.trim().split(/\s+/).length === clip.words.length &&
    tokens.every((word) => word.length <= 500);
  return {
    patch: {
      text,
      words: aligned
        ? clip.words.map((word, index) => ({ ...word, text: tokens[index] }))
        : [],
    },
    timing: aligned ? "preserved" : "cleared",
  };
}

export function captionReplacementPlan(
  captions: Clip[],
  find: string,
  replacement: string,
) {
  if (!find) return [];
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "gi");
  return captions.flatMap((clip) => {
    const text = clip.text.replace(pattern, () => replacement);
    if (text === clip.text) return [];
    const correction = captionTextPatch(clip, text);
    return [
      {
        id: clip.id,
        before: clip.text,
        after: correction.patch.text!,
        ...correction,
      },
    ];
  });
}

export function captionTimestamp(frame: number, fps: number) {
  const centiseconds = Math.floor((frame / fps) * 100 + 1e-6);
  return `${Math.floor(centiseconds / 6000)}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}
