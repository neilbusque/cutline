import type { Asset, Clip, MotionLayer, Project, Word } from "./model";

export type VideoQualityIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  clipIds?: string[];
  /** Inclusive timeline frames to inspect, not a claim about rendered pixels. */
  frames?: number[];
  suggestion: string;
};

export type VideoQualityOptions = {
  /** Optional host check; the analyzer itself performs no I/O. */
  assetAvailable?: (asset: Asset) => boolean;
};

type Interval = { start: number; end: number };
const ISSUE_LIMIT = 100;
const PAIR_LIMIT = 50_000;
const TRANSCRIPT_LIMIT = 50_000;
const endOf = (clip: Clip) => clip.start + clip.duration;
const hasValue = (clip: Clip, property: "opacity" | "volume") =>
  clip[property] > 0 ||
  clip.keyframes.some((key) => key.property === property && key.value > 0);
const layerVisible = (layer: MotionLayer) =>
  !layer.hidden &&
  (layer.opacity > 0 || layer.keyframes.some((key) => (key.opacity ?? 0) > 0));
const hasGeometryAnimation = (clip: Clip) =>
  clip.keyframes.some((key) =>
    ["x", "y", "width", "height", "scale", "rotation"].includes(key.property),
  );
const mergeIntervals = (input: Interval[]): Interval[] => {
  const merged: Interval[] = [];
  for (const interval of [...input].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end)
      previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
};
const intersects = (a: Clip, b: Clip) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

/**
 * Read-only structural review. Warnings identify places to inspect, not a
 * subjective quality score or proof that an export renders/sounds correct.
 */
export function analyzeVideoQuality(
  project: Project,
  options: VideoQualityOptions = {},
) {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const motions = new Map(project.motions.map((motion) => [motion.id, motion]));
  const clipsById = new Map(project.clips.map((clip) => [clip.id, clip]));
  const durationFrames = project.clips.reduce(
    (max, clip) => Math.max(max, endOf(clip)),
    0,
  );
  const issues: VideoQualityIssue[] = [];
  let errorCount = 0,
    warningCount = 0;
  const review = new Set([
    "Inspect rendered frames and playback for legibility, contrast, occlusion, motion continuity, and intentional background-only beats.",
    "Listen to the full export and measure loudness and true peak; timeline metadata cannot verify the audio mix or distortion.",
    "Verify caption wording and synchronization against the spoken audio; transcript timing can be inaccurate.",
  ]);
  if (!options.assetAvailable)
    review.add(
      "Verify that referenced media files exist and decode; this report checks asset references, not filesystem availability.",
    );
  else
    review.add(
      "Decode referenced media and render the export; a file availability check does not establish media integrity.",
    );
  const add = (issue: VideoQualityIssue) => {
    if (issue.severity === "error") errorCount++;
    else warningCount++;
    if (issues.length < ISSUE_LIMIT) issues.push(issue);
    else if (issue.severity === "error") {
      for (let index = issues.length - 1; index >= 0; index--) {
        if (issues[index].severity === "warning") {
          issues[index] = issue;
          break;
        }
      }
    }
  };
  if (!project.clips.length)
    add({
      code: "empty_timeline",
      severity: "warning",
      message: "The timeline has no clips to review or export.",
      suggestion:
        "Assemble the storyboard or add footage, titles, and audio, then run the review again.",
    });
  const clipIssue = (
    clip: Clip,
    code: string,
    severity: VideoQualityIssue["severity"],
    message: string,
    suggestion: string,
  ) =>
    add({
      code,
      severity,
      message,
      suggestion,
      clipIds: [clip.id],
      frames: [clip.start, endOf(clip) - 1],
    });
  const available = new Map<string, boolean>();
  const assetIsAvailable = (asset: Asset) => {
    if (!available.has(asset.id)) {
      let result = !!asset.path.trim();
      if (result && options.assetAvailable) {
        try {
          result = options.assetAvailable(asset);
        } catch {
          review.add(
            "A media availability check failed; verify those source files manually.",
          );
          // A failed check is not evidence that the file is missing.
        }
      }
      available.set(asset.id, result);
    }
    return available.get(asset.id)!;
  };
  const visible: Clip[] = [],
    audible: Clip[] = [],
    captions: Clip[] = [];
  for (const clip of project.clips) {
    const track = tracks.get(clip.trackId);
    if (!track) {
      clipIssue(
        clip,
        "missing_track",
        "error",
        "A clip references a track that is missing.",
        "Assign the clip to an existing track or remove it.",
      );
      continue;
    }
    const asset = assets.get(clip.assetId ?? "");
    const isVisual =
      clip.kind !== "audio" && !track.hidden && hasValue(clip, "opacity");
    // The renderer ignores hidden on audio-only tracks; hidden video has no audio.
    const isAudible =
      !track.muted &&
      !clip.freeze &&
      hasValue(clip, "volume") &&
      (clip.kind === "audio" ||
        (clip.kind === "video" && !track.hidden && !!asset?.hasAudio));
    if (!isVisual && !isAudible) continue;
    if (isAudible) audible.push(clip);
    if (["audio", "video", "image"].includes(clip.kind)) {
      if (!asset || !assetIsAvailable(asset)) {
        clipIssue(
          clip,
          "missing_media",
          "error",
          "A used clip has no available source media.",
          "Relink or import the source media before exporting.",
        );
        continue;
      }
    }
    if (isVisual && clip.motionId && !motions.has(clip.motionId)) {
      clipIssue(
        clip,
        "missing_motion",
        "error",
        "A visible clip references a missing motion design.",
        "Restore the motion design or choose an available design.",
      );
      continue;
    }
    if (isVisual && clip.kind === "caption") captions.push(clip);
    if (isVisual && clip.kind !== "caption") {
      const motion = motions.get(clip.motionId ?? "");
      const hasContent =
        clip.kind !== "text" ||
        (motion
          ? motion.layers.some(layerVisible)
          : !!clip.text.trim() || clip.background !== "transparent");
      if (hasContent) visible.push(clip);
    }
    // One output frame of rounding at the end of a voice take is normal.
    if (
      isAudible &&
      asset &&
      clip.sourceIn + (clip.duration / project.fps) * clip.speed >
        asset.duration + clip.speed / project.fps + 0.001
    ) {
      clipIssue(
        clip,
        "audio_source_overrun",
        "warning",
        "An audible clip extends beyond its source audio after trim and playback speed are applied.",
        "Shorten the clip to the available audio or extend the source; check for an unintended silent tail.",
      );
    }
    if (isVisual && clip.kind === "text" && !clip.motionId) {
      const words = clip.text.trim().split(/\s+/u).filter(Boolean).length;
      // Deliberate one-word flashes and kinetic motion designs need visual review.
      const minimum = Math.min(1.4, 0.2 + words / 8);
      if (words >= 4 && clip.duration / project.fps < minimum)
        clipIssue(
          clip,
          "short_reading_time",
          "warning",
          `A ${words}-word text clip is visible for less than ${minimum.toFixed(1)} seconds.`,
          "Preview its reading time; simplify the copy or hold it longer if it carries essential information.",
        );
    }
  }

  const intervals = mergeIntervals(
    visible.map((clip) => ({ start: clip.start, end: endOf(clip) })),
  );
  let cursor = 0;
  for (const interval of [
    ...intervals,
    { start: durationFrames, end: durationFrames },
  ]) {
    if (interval.start > cursor) {
      const end = interval.start;
      add({
        code: "visual_gap",
        severity: "warning",
        message: `Frames ${cursor}–${end - 1} have no visible image, video, title, or motion clip; only the project background and any captions remain.`,
        frames: [cursor, end - 1],
        suggestion:
          "Preview this interval. Keep it if it is an intentional pause, otherwise extend or add a visual.",
      });
    }
    cursor = Math.max(cursor, interval.end);
  }

  const captionBySource = new Map<string, Clip[]>();
  const unlinked: Clip[] = [];
  for (const caption of captions) {
    if (caption.captionSourceId) {
      const group = captionBySource.get(caption.captionSourceId) ?? [];
      group.push(caption);
      captionBySource.set(caption.captionSourceId, group);
      const source = clipsById.get(caption.captionSourceId);
      if (!source)
        clipIssue(
          caption,
          "caption_missing_source",
          "warning",
          "A caption is linked to a source clip that no longer exists.",
          "Relink or regenerate the caption, or remove the obsolete source link if it is now independent.",
        );
      else if (
        caption.start < source.start - 1 ||
        endOf(caption) > endOf(source) + 1
      )
        clipIssue(
          caption,
          "caption_outside_source",
          "warning",
          "A linked caption extends beyond its source clip.",
          "Retiming or regenerating captions can restore alignment after a source trim.",
        );
    } else unlinked.push(caption);
    if (
      caption.words.some(
        (word) =>
          word.end <= word.start ||
          word.start < -1 / project.fps ||
          word.end > caption.duration / project.fps + 1 / project.fps,
      )
    )
      clipIssue(
        caption,
        "caption_word_bounds",
        "warning",
        "Caption word timing falls outside its visible cue or has no positive duration.",
        "Regenerate or adjust word timing so each word fits inside the caption cue.",
      );
    if (
      hasGeometryAnimation(caption) ||
      caption.rotation !== 0 ||
      caption.scale !== 1
    ) {
      review.add(
        "Inspect animated or transformed captions at their motion extremes; static bounds and overlap checks exclude them.",
      );
    } else if (
      caption.x < -1 ||
      caption.y < -1 ||
      caption.x + caption.width > project.width + 1 ||
      caption.y + caption.height > project.height + 1
    ) {
      clipIssue(
        caption,
        "caption_canvas_bounds",
        "warning",
        "A caption box extends outside the canvas.",
        "Preview the text and move or resize the caption box if any words are cropped.",
      );
    }
  }

  let comparisons = 0;
  const sortedCaptions = [...captions].sort(
    (a, b) => a.start - b.start || a.id.localeCompare(b.id),
  );
  let active: Clip[] = [];
  outer: for (const caption of sortedCaptions) {
    active = active.filter((other) => endOf(other) > caption.start);
    for (const other of active) {
      if (++comparisons > PAIR_LIMIT) {
        review.add(
          "Caption overlap comparisons were capped for this dense timeline; inspect remaining stacked caption tracks manually.",
        );
        break outer;
      }
      if (
        hasGeometryAnimation(caption) ||
        hasGeometryAnimation(other) ||
        caption.rotation ||
        other.rotation ||
        caption.scale !== 1 ||
        other.scale !== 1
      )
        continue;
      if (intersects(caption, other))
        add({
          code: "caption_overlap",
          severity: "warning",
          message:
            "Two visible caption boxes overlap in both time and position.",
          clipIds: [other.id, caption.id],
          frames: [caption.start, Math.min(endOf(other), endOf(caption)) - 1],
          suggestion:
            "Preview the overlap; separate the cues or their positions unless simultaneous speakers are intentional.",
        });
    }
    active.push(caption);
  }

  if (project.story?.captions !== false) {
    const unlinkedIntervals = mergeIntervals(
      unlinked.map((clip) => ({ start: clip.start, end: endOf(clip) })),
    );
    let transcriptWordsInspected = 0;
    for (const source of audible) {
      const asset = assets.get(source.assetId ?? "");
      if (!asset?.words?.length || source.reverse || !assetIsAvailable(asset))
        continue;
      const cues = mergeIntervals([
        ...(captionBySource.get(source.id) ?? []).map((clip) => ({
          start: clip.start,
          end: endOf(clip),
        })),
        ...unlinkedIntervals,
      ]);
      const sourceEnd =
        source.sourceIn + (source.duration / project.fps) * source.speed;
      let missing = 0,
        checked = 0,
        cueIndex = 0,
        firstMissing = source.start;
      const words: Word[] = [];
      for (const word of asset.words) {
        if (transcriptWordsInspected++ >= TRANSCRIPT_LIMIT) {
          review.add(
            "Transcript coverage inspection was capped at 50,000 source words; review remaining speech and captions manually.",
          );
          break;
        }
        if (
          word.text.trim() &&
          word.end > word.start &&
          word.end > source.sourceIn &&
          word.start < sourceEnd
        )
          words.push(word);
      }
      words.sort((a, b) => a.start - b.start);
      for (const word of words) {
        const start =
          source.start +
          Math.max(
            0,
            ((word.start - source.sourceIn) / source.speed) * project.fps,
          );
        const end = Math.min(
          endOf(source),
          source.start +
            ((word.end - source.sourceIn) / source.speed) * project.fps,
        );
        checked++;
        while (cueIndex < cues.length && cues[cueIndex].end < start - 1)
          cueIndex++;
        let covered = 0;
        for (let i = cueIndex; i < cues.length && cues[i].start < end + 1; i++)
          covered += Math.max(
            0,
            Math.min(end, cues[i].end) - Math.max(start, cues[i].start),
          );
        if (end - start - covered > Math.max(1.05, (end - start) * 0.35)) {
          if (!missing) firstMissing = Math.floor(start);
          missing++;
        }
      }
      if (missing)
        add({
          code: "caption_coverage",
          severity: "warning",
          message: `${missing} of ${checked} transcript word intervals lack visible caption coverage for an audible source.`,
          clipIds: [source.id],
          frames: [firstMissing],
          suggestion:
            "If captions are part of this delivery, generate or retime them for the selected source. Verify the transcript against the audio.",
        });
      if (transcriptWordsInspected >= TRANSCRIPT_LIMIT) {
        review.add(
          "Transcript coverage inspection was capped at 50,000 source words; review remaining speech and captions manually.",
        );
        break;
      }
    }
  }

  const scenes = project.story?.scenes ?? [];
  let run = 0,
    previousLayout: string | undefined;
  for (const scene of scenes) {
    const layout = scene.design?.layout;
    run = layout && layout === previousLayout ? run + 1 : layout ? 1 : 0;
    previousLayout = layout;
    if (run === 4) {
      if (project.story?.assembly)
        review.add(
          "Repeated storyboard layout labels may differ from a customized timeline; assess shot variety and pacing in the final edit.",
        );
      else
        add({
          code: "repeated_story_layout",
          severity: "warning",
          message: "Four consecutive storyboard scenes use the same layout.",
          suggestion:
            "Review whether the final edit needs a change of shot scale, composition, or pacing. Repetition can be intentional; inspect the timeline before changing it.",
        });
    }
  }

  const clampFrame = (frame: number) =>
    Math.max(0, Math.min(Math.max(0, durationFrames - 1), Math.round(frame)));
  const previewFrames: number[] = [];
  const take = (frame: number) => {
    const value = clampFrame(frame);
    if (!previewFrames.includes(value) && previewFrames.length < 12)
      previewFrames.push(value);
  };
  // Reserve half the contact sheet for varied scenes, even on a broken project.
  for (const issue of [
    ...issues.filter((issue) => issue.severity === "error"),
    ...issues.filter((issue) => issue.severity === "warning"),
  ]) {
    if (previewFrames.length >= 6) break;
    if (issue.frames?.length)
      take((issue.frames[0] + issue.frames.at(-1)!) / 2);
  }
  if (durationFrames) {
    const starts = [...new Set(visible.map((clip) => clip.start))].sort(
      (a, b) => a - b,
    );
    if (starts.length)
      for (let i = 0; i < 6; i++) {
        const index = Math.round((i * (starts.length - 1)) / 5);
        const start = starts[index],
          next = starts[index + 1] ?? durationFrames;
        take(
          start +
            Math.min(project.fps, Math.max(0, Math.floor((next - start) / 2))),
        );
      }
    for (let i = 0; i < 12; i++) take((i * (durationFrames - 1)) / 11);
  }
  return {
    projectId: project.id,
    revision: project.revision,
    summary: {
      durationFrames,
      durationSeconds: durationFrames / project.fps,
      visibleClips: visible.length,
      audibleClips: audible.length,
      captionClips: captions.length,
      errorCount,
      warningCount,
      omittedIssueCount: errorCount + warningCount - issues.length,
    },
    issues,
    previewFrames: previewFrames.sort((a, b) => a - b),
    checksRequiringReview: [...review],
  };
}
