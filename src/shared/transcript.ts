import { z } from "zod";
import type { Asset, Clip, Project, Word } from "./model";
import { playsForward } from "./timeline";

/** Lowercase words without accents or punctuation, so "Thank you," matches "thank you". */
export function transcriptTokens(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

type Placement = {
  clipId: string | null;
  startFrame?: number;
  endFrame?: number;
  partial?: boolean;
};
/** Seconds of tolerance for word times that touch a cut. */
const SLIVER = 0.02;
/**
 * Where a source-time range plays on the timeline: one entry per clip that
 * plays it. Word times run edge to edge, so a phrase's first word often starts
 * inside the pause before it; a clip trimmed to the speech (or a piece left by
 * pause removal) still plays the phrase. Each clip that plays more than a
 * sliver of it is listed with its part, marked partial when it misses some.
 */
function placements(
  project: Project,
  asset: Asset,
  start: number,
  end: number,
): Placement[] {
  const fps = project.fps;
  const found = project.clips
    .filter(
      (clip) =>
        clip.assetId === asset.id &&
        (clip.kind === "video" || clip.kind === "audio") &&
        // A reversed or held clip never plays the words forward.
        playsForward(clip),
    )
    .flatMap((clip) => {
      const sourceEnd = clip.sourceIn + (clip.duration / fps) * clip.speed;
      const startsHere = start >= clip.sourceIn - SLIVER && start < sourceEnd;
      const overlap = Math.min(end, sourceEnd) - Math.max(start, clip.sourceIn);
      if (!startsHere && overlap <= SLIVER) return [];
      const frameAt = (seconds: number) =>
        clip.start + Math.round(((seconds - clip.sourceIn) / clip.speed) * fps);
      const startFrame = Math.max(clip.start, frameAt(start));
      const last = clip.start + clip.duration;
      const endFrame = Math.min(last, Math.max(startFrame + 1, frameAt(end)));
      return [
        {
          clipId: clip.id,
          startFrame,
          endFrame,
          ...(start < clip.sourceIn - SLIVER || end > sourceEnd + SLIVER
            ? { partial: true }
            : {}),
        },
      ];
    });
  return found.length ? found : [{ clipId: null }];
}

export const TranscriptSearchSchema = z.strictObject({
  query: z.string().max(500),
  limit: z.number().int().min(1).max(150).default(30),
  clipId: z.string().min(1).optional(),
});

/**
 * cutline_search_transcript: phrase search over word-level transcripts.
 * Each hit names the clip that plays it and its timeline frames (end
 * exclusive); start and end stay in source seconds. Hits cut out of the
 * timeline have clipId null.
 */
export function searchTranscript(project: Project, raw: unknown) {
  const args = TranscriptSearchSchema.parse(raw ?? {});
  const query = transcriptTokens(args.query);
  if (!query.length) throw Error("Search for at least one word.");
  const onlyClip = args.clipId
    ? project.clips.find((clip) => clip.id === args.clipId)
    : undefined;
  if (args.clipId && !onlyClip) throw Error(`Clip ${args.clipId} is missing.`);
  const hits: Record<string, unknown>[] = [];
  for (const asset of project.assets) {
    if (!asset.words?.length) continue;
    if (onlyClip && onlyClip.assetId !== asset.id) continue;
    const words = asset.words;
    const tokens: { text: string; word: number }[] = [];
    words.forEach((word, index) => {
      for (const text of transcriptTokens(word.text))
        tokens.push({ text, word: index });
    });
    let previous = -1;
    for (let index = 0; index + query.length <= tokens.length; index++) {
      // One word is a substring match; a phrase matches whole words in order.
      const matched = query.every((part, offset) =>
        query.length === 1
          ? tokens[index].text.includes(part)
          : tokens[index + offset].text === part,
      );
      const first = tokens[index].word,
        last = tokens[index + query.length - 1].word;
      // A word split into several tokens is one hit.
      if (!matched || first === previous) continue;
      previous = first;
      const text = (from: number, to: number) =>
        words
          .slice(Math.max(0, from), Math.min(words.length, to))
          .map((word) => word.text.trim())
          .join(" ");
      const start = words[first].start,
        end = words[last].end;
      for (const placement of placements(project, asset, start, end)) {
        if (onlyClip && placement.clipId !== onlyClip.id) continue;
        hits.push({
          ...placement,
          assetId: asset.id,
          text: text(first, last + 1),
          start,
          end,
          context: text(first - 6, last + 7).slice(0, 160),
        });
      }
    }
  }
  // Placed hits in timeline order first, then hits that were cut out.
  hits.sort(
    (a, b) =>
      Number(a.clipId === null) - Number(b.clipId === null) ||
      Number(a.startFrame ?? 0) - Number(b.startFrame ?? 0) ||
      Number(a.start) - Number(b.start),
  );
  return hits.slice(0, args.limit);
}

export const TranscriptReadSchema = z
  .strictObject({
    clipId: z.string().min(1).optional(),
    assetId: z.string().min(1).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(250).default(120),
  })
  .refine(
    (args) => (args.clipId === undefined) !== (args.assetId === undefined),
    "Give clipId (timeline frames) or assetId (whole source), not both.",
  );

/** Lines of speech: a new line after a pause, end punctuation or 14 words. */
function lines(words: Word[]) {
  const result: Word[][] = [];
  let current: Word[] = [];
  for (const [index, word] of words.entries()) {
    current.push(word);
    const next = words[index + 1];
    if (
      !next ||
      current.length >= 14 ||
      /[.?!]["')\]]*$/.test(word.text.trim()) ||
      next.start - word.end > 0.6
    ) {
      result.push(current);
      current = [];
    }
  }
  return result;
}

/**
 * cutline_transcript: the words of a clip (with timeline frames) or of a whole
 * source (seconds only), as lines, paged.
 */
export function readTranscript(project: Project, raw: unknown) {
  const args = TranscriptReadSchema.parse(raw ?? {});
  let clip: Clip | undefined;
  let asset: Asset | undefined;
  if (args.clipId) {
    clip = project.clips.find((item) => item.id === args.clipId);
    if (!clip) throw Error(`Clip ${args.clipId} is missing.`);
    asset = project.assets.find((item) => item.id === clip!.assetId);
    if (!asset)
      throw Error(
        "This clip has no source media. Captions keep their own text; inspect them instead.",
      );
    if (!playsForward(clip))
      throw Error(
        "This clip plays backwards or holds a frame, so its speech doesn't line up with the timeline. Read the media's transcript with its assetId instead.",
      );
  } else {
    asset = project.assets.find((item) => item.id === args.assetId);
    if (!asset) throw Error(`Asset ${args.assetId} is missing.`);
  }
  if (!asset.words?.length)
    throw Error(
      "This media has no transcript yet. Run cutline_transcribe on a clip that uses it.",
    );
  const fps = project.fps;
  const sourceEnd = clip
    ? clip.sourceIn + (clip.duration / fps) * clip.speed
    : Infinity;
  const words = clip
    ? asset.words.filter(
        (word) => word.end > clip!.sourceIn && word.start < sourceEnd,
      )
    : asset.words;
  const all = lines(words);
  let used = 0;
  const page = all
    .slice(args.offset, args.offset + args.limit)
    .map((line) => {
      const start = line[0].start,
        end = line[line.length - 1].end;
      const text = line.map((word) => word.text.trim()).join(" ");
      if (!clip) return { start, end, text };
      const frameAt = (seconds: number) =>
        clip!.start +
        Math.round(((seconds - clip!.sourceIn) / clip!.speed) * fps);
      return {
        startFrame: Math.max(clip.start, frameAt(start)),
        endFrame: Math.min(clip.start + clip.duration, frameAt(end)),
        start,
        end,
        text,
      };
    })
    // Stay inside an assistant's tool output budget.
    .filter((line) => (used += JSON.stringify(line).length) < 40_000);
  const next = args.offset + page.length;
  return {
    ...(clip ? { clipId: clip.id } : {}),
    assetId: asset.id,
    lines: page,
    total: all.length,
    ...(next < all.length ? { nextOffset: next } : {}),
  };
}
