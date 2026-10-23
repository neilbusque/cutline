import { captionClips } from "./subtitles";
import type { Clip, Project, Word } from "./model";

/** Replace only captions linked to this source; handwritten and other sources survive. */
export function replaceGeneratedCaptions(
  project: Project,
  sourceId: string,
  relativeWords: Word[],
): { project: Project; count: number } {
  const source = project.clips.find((clip) => clip.id === sourceId);
  if (!source || !["video", "audio"].includes(source.kind))
    throw Error("Select a video or audio clip to caption.");
  const seconds = source.duration / project.fps;
  const words = relativeWords
    .filter(
      (word) =>
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start &&
        word.start < seconds &&
        word.end > 0 &&
        word.text.trim(),
    )
    .map((word) => ({
      ...word,
      start: Math.max(0, word.start),
      end: Math.min(seconds, word.end),
    }));
  if (!words.length)
    throw Error(
      "No speech was found in this clip range. Your existing captions were kept.",
    );
  const previous = project.clips.find(
    (clip) => clip.kind === "caption" && clip.captionSourceId === sourceId,
  );
  const presentation: Partial<Clip> = previous
    ? {
        trackId: previous.trackId,
        x: previous.x,
        y: previous.y,
        width: previous.width,
        height: previous.height,
        fontSize: previous.fontSize,
        fontFamily: previous.fontFamily,
        fontWeight: previous.fontWeight,
        color: previous.color,
        accent: previous.accent,
        background: previous.background,
        align: previous.align,
        highlight: previous.highlight,
        captionStyle: previous.captionStyle,
        captionCase: previous.captionCase,
        captionLayout: previous.captionLayout,
        captionMaxLines: previous.captionMaxLines,
        captionStrokeWidth: previous.captionStrokeWidth,
        captionTracking: previous.captionTracking,
      }
    : {};
  const captions = captionClips(
    project,
    words,
    source.start / project.fps,
    source.duration,
  ).map((clip) => ({ ...clip, ...presentation, captionSourceId: sourceId }));
  const next = structuredClone(project);
  next.clips = next.clips.filter(
    (clip) => !(clip.kind === "caption" && clip.captionSourceId === sourceId),
  );
  next.clips.push(...captions);
  return { project: next, count: captions.length };
}
