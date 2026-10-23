import { makeClip, type Clip, type Project, type Word } from "./model";
import { captionPlacement, captionStylePatch } from "./caption-styles";

const sentenceEnd = /[.!?。！？]["'”’)]?$/u;
const clauseEnd = /[,;:，；：]["'”’)]?$/u;
const hangingWord =
  /^(a|an|the|my|your|our|their|its|of|to|in|for|with|and|or|but|that|this)$/iu;
const clauseStart = /^(and|but|because|so|while|when|although|however)$/iu;
const tokens = (text: string) =>
  text.trim().split(/\s+/u).filter(Boolean).length;

/** Group source words naturally; only actual overlaps form inseparable atoms. */
export function groupCaptionWords(input: Word[], fps: number): Word[][] {
  if (!Number.isFinite(fps) || fps <= 0)
    throw Error("Captions need a valid frame rate.");
  const words = input
    .filter(
      (word) =>
        word.text.trim() &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.start >= 0 &&
        word.end > word.start,
    )
    .map((word) => ({ ...word, text: word.text.trim() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!words.length) return [];

  // Touching Whisper word times are normal continuous speech, not overlaps.
  // Frame rounding belongs to the final phrase boundaries, never these atoms.
  const atoms: Word[][] = [];
  let latestEnd = -Infinity;
  for (const word of words) {
    if (!atoms.length || latestEnd <= word.start + 1e-9) atoms.push([word]);
    else atoms.at(-1)!.push(word);
    latestEnd = Math.max(latestEnd, word.end);
  }

  const blocks: Word[][][] = [];
  for (const atom of atoms) {
    const previous = blocks.at(-1)?.at(-1);
    // Keep imported phrase cues and explicit line breaks as a single timed cue.
    const phraseCue = (items: Word[]) =>
      items.some((word) => /\s/u.test(word.text));
    if (
      !previous ||
      atom[0].start - Math.max(...previous.map((word) => word.end)) > 0.65 ||
      phraseCue(previous) ||
      phraseCue(atom)
    )
      blocks.push([atom]);
    else blocks.at(-1)!.push(atom);
  }

  return blocks.flatMap((block) => {
    // A small dynamic program avoids a fixed-size bucket leaving one flashing
    // word at the end. Natural boundaries win over arbitrary word counts.
    const cost = Array<number>(block.length + 1).fill(Infinity);
    const next = Array<number>(block.length).fill(0);
    cost[block.length] = 0;
    for (let i = block.length - 1; i >= 0; i--) {
      const phrase: Word[] = [];
      for (let j = i; j < block.length; j++) {
        phrase.push(...block[j]);
        const count = phrase.reduce((sum, word) => sum + tokens(word.text), 0);
        if (j > i && count > 7) break;
        const first = phrase[0],
          last = phrase.at(-1)!;
        const duration =
          Math.max(...phrase.map((word) => word.end)) - first.start;
        const length = phrase.map((word) => word.text).join(" ").length;
        let score = 2 + Math.pow(count - 4, 2) * 0.4;
        if (count === 1) score += duration < 0.8 ? 12 : 6;
        if (count === 2) score += 1;
        score += Math.max(0, 0.7 - duration) * 4;
        score += Math.pow(Math.max(0, duration - 3), 2) * 5;
        score += Math.pow(Math.max(0, length - 44), 2) * 0.03;
        score +=
          phrase.slice(0, -1).filter((word) => sentenceEnd.test(word.text))
            .length * 5;
        if (j + 1 < block.length) {
          if (hangingWord.test(last.text)) score += 5;
          if (sentenceEnd.test(last.text)) score -= 3;
          else if (clauseEnd.test(last.text)) score -= 1.5;
          if (clauseStart.test(block[j + 1][0].text)) score -= 1;
        }
        score += cost[j + 1];
        if (score < cost[i]) {
          cost[i] = score;
          next[i] = j + 1;
        }
      }
    }
    const groups: Word[][] = [];
    for (let i = 0; i < block.length; i = next[i])
      groups.push(block.slice(i, next[i]).flat());
    return groups;
  });
}

export type CaptionBuildOptions = {
  trackId?: string;
  startFrame?: number;
  maxDurationFrames?: number;
  style?: Clip["captionStyle"];
  sourceId?: string;
};

/** Preserve source timing except sub-frame clipping at a shared phrase boundary. */
export function buildCaptionClips(
  p: Project,
  input: Word[],
  options: CaptionBuildOptions = {},
): Clip[] {
  const trackId =
    options.trackId ??
    p.tracks.find((track) => track.id === "captions")?.id ??
    p.tracks.find((track) => track.kind === "text")?.id;
  if (!trackId) throw Error("Add a text track first");
  const startFrame = Math.max(0, Math.round(options.startFrame ?? 0));
  const lastWordEnd = Math.max(
    0,
    ...input
      .filter((word) => Number.isFinite(word.end))
      .map((word) => word.end),
  );
  const duration = Math.max(
    0,
    Math.floor(options.maxDurationFrames ?? Math.ceil(lastWordEnd * p.fps)),
  );
  const sourceSeconds = duration / p.fps;
  const words = input
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end))
    .map((word) => ({
      ...word,
      start: Math.max(0, word.start),
      end: Math.min(sourceSeconds, word.end),
    }))
    .filter((word) => word.end > word.start);
  const groups = groupCaptionWords(words, p.fps);
  const starts = groups.map((group) =>
    Math.max(0, Math.floor(group[0].start * p.fps)),
  );
  for (let index = 1; index < groups.length;) {
    const previous = groups[index - 1],
      current = groups[index];
    const previousEnd = Math.max(...previous.map((word) => word.end));
    if (Math.ceil(previousEnd * p.fps) <= starts[index]) {
      index++;
      continue;
    }
    // Adjacent clips share exactly one frame boundary. Prefer the nearest
    // frame; retain all words with a positive visible interval on either side.
    const ideal = ((previousEnd + current[0].start) * p.fps) / 2;
    const rounded = Math.round(ideal);
    const candidates = [rounded, rounded - 1, rounded + 1]
      .filter((frame) => {
        const seconds = frame / p.fps;
        return (
          frame > starts[index - 1] &&
          previous.every((word) => word.start < seconds) &&
          current.every((word) => word.end > seconds) &&
          Math.abs(seconds - previousEnd) < 1 / p.fps + 1e-9 &&
          Math.abs(seconds - current[0].start) < 1 / p.fps + 1e-9
        );
      })
      .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
    if (!candidates.length) {
      // Extremely short sub-frame words cannot be separated without losing one.
      // Keep this rare boundary in one cue instead of silently dropping text.
      previous.push(...current);
      groups.splice(index, 1);
      starts.splice(index, 1);
      continue;
    }
    starts[index] = candidates[0];
    index++;
  }
  return groups.flatMap((group, index) => {
    const first = group[0],
      localStart = starts[index];
    const spokenEnd = Math.max(...group.map((word) => word.end));
    const nextStart = index + 1 < groups.length ? starts[index + 1] : duration;
    // Short phrases may hold briefly into silence, but never into another cue
    // or beyond the selected media. Only edge words may lose part of a frame.
    const phraseCount = group.reduce((sum, word) => sum + tokens(word.text), 0);
    const minimumSeconds = Math.min(1.35, 0.4 + phraseCount * 0.12);
    const readableEnd = Math.min(
      spokenEnd + 0.18,
      first.start + minimumSeconds,
    );
    const end = Math.min(
      duration,
      nextStart,
      Math.ceil(Math.max(spokenEnd, readableEnd) * p.fps),
    );
    if (end <= localStart) return [];
    const relative = group.map((word) => ({
      ...word,
      start: Math.max(0, word.start - localStart / p.fps),
      end: Math.min((end - localStart) / p.fps, word.end - localStart / p.fps),
    }));
    return [
      {
        ...makeClip(p, "caption", trackId, startFrame + localStart),
        ...captionStylePatch(options.style ?? "standard", p),
        ...captionPlacement(p),
        duration: end - localStart,
        text: group.map((word) => word.text).join(" "),
        words: relative,
        ...(options.sourceId ? { captionSourceId: options.sourceId } : {}),
      },
    ];
  });
}
