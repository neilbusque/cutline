import { type Project, type Word, type Clip } from "./model";
import { buildCaptionClips } from "./caption-grouping";
import { captionLayout } from "./caption-layout";
import { captionCutoffs } from "./transitions";

export function parseSrt(srt: string): Word[] {
  return srt
    .replace(/^\uFEFF/u, "")
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const lines = block.split("\n");
      const i = lines.findIndex((line) => line.includes("-->"));
      if (i < 0) return [];
      const times = lines[i].match(/(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})/g);
      if (times?.length !== 2) throw Error("Invalid subtitle timestamp");
      const seconds = (s: string) => {
        const [h, m, t, ms] = s.split(/[:,.]/).map(Number);
        if (m > 59 || t > 59) throw Error("Invalid subtitle timestamp");
        return h * 3600 + m * 60 + t + ms / 1000;
      };
      const start = seconds(times[0]),
        end = seconds(times[1]);
      if (end <= start) throw Error("Subtitle ends before it starts");
      const text = lines
        .slice(i + 1)
        .join("\n")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .trim();
      return text ? [{ text, start, end }] : [];
    });
}

export function toSrt(clips: Clip[], fps: number) {
  const stamp = (s: number) => {
    const ms = Math.round(s * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  // A cue ends where the next caption on its track takes over, as on screen.
  const cutoffs = captionCutoffs({ clips });
  // A blank caption would be an empty cue, which some players reject.
  return clips
    .filter((c) => c.kind === "caption" && c.text.trim())
    .sort((a, b) => a.start - b.start)
    .map((c, i) => {
      // Existing projects retain their exact text. Balanced captions export the
      // same case and two-line grouping shown in the preview and rendered video.
      const text =
        c.captionLayout === "balanced"
          ? captionLayout(c)
              .lines.map((line) => line.text)
              .join("\n")
          : c.text;
      const end = cutoffs.get(c.id) ?? c.start + c.duration;
      return `${i + 1}\n${stamp(c.start / fps)} --> ${stamp(end / fps)}\n${text}\n`;
    })
    .join("\n");
}

/**
 * Captions for a subtitle file, the same in the app and for agents: each cue
 * stays one caption at its own times, and cues are built together so
 * back-to-back cues share a frame boundary instead of overlapping by one.
 */
export function srtCaptionClips(
  p: Project,
  srt: string,
  startFrame = 0,
): Clip[] {
  return buildCaptionClips(p, parseSrt(srt), { startFrame, cues: true });
}

export function captionClips(
  p: Project,
  words: Word[],
  offset = 0,
  maxDurationFrames?: number,
): Clip[] {
  return buildCaptionClips(p, words, {
    startFrame: Math.round(offset * p.fps),
    maxDurationFrames,
  });
}
