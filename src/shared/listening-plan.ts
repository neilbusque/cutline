import { validateProject, type Clip, type Project } from "./model";
import { transcriptTokens } from "./transcript";

export type AudioRole = "voice" | "music" | "sfx";
export type AudioMeasurements = {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  samplePeakDbfs: number | null;
  clippedSampleCount: number;
  analyzedSeconds: number;
  complete: boolean;
  activity: { stepSeconds: number; rmsDbfs: number[]; peakDbfs: number[] };
};
export type ListeningWord = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  anchorSeconds: number;
  lastAnchorSeconds: number;
  confidence: number;
};
export type ListeningEvidence = {
  durationSeconds: number;
  mix: AudioMeasurements;
  stems: Partial<Record<AudioRole, AudioMeasurements>>;
  alignment: {
    status: "complete" | "unavailable" | "not-needed";
    language?: string;
    words: ListeningWord[];
    method: string;
  };
  limitations: string[];
};
export type ListeningModelIssue = {
  category: "voice" | "music" | "sfx" | "captions";
  kind: string;
  startSeconds: number;
  endSeconds: number;
  severity: "warning" | "error";
  confidence: number;
  description: string;
};
export type ListeningFix = {
  category: AudioRole | "captions" | "mix";
  kind: string;
  clipIds: string[];
  description: string;
  before?: unknown;
  after?: unknown;
};
const roleOf = (clip: Clip): AudioRole | "mixed" | undefined =>
  (clip as Clip & { audioRole?: AudioRole | "mixed" }).audioRole;
const finite = (value: number | null): value is number =>
  value !== null && Number.isFinite(value);
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const dbGain = (db: number) => 10 ** (db / 20);
const end = (clip: Clip) => clip.start + clip.duration;
function audible(p: Project, c: Clip) {
  const track = p.tracks.find((item) => item.id === c.trackId);
  const asset = p.assets.find((item) => item.id === c.assetId);
  return (
    !!asset?.hasAudio &&
    !c.freeze &&
    !track?.muted &&
    !(c.kind === "video" && track?.hidden) &&
    (c.kind === "video" || c.kind === "audio") &&
    (c.volume > 0 ||
      c.keyframes.some((key) => key.property === "volume" && key.value > 0))
  );
}
function gainClip(clip: Clip, db: number) {
  const gain = dbGain(db);
  clip.volume = round(Math.min(2, clip.volume * gain));
  clip.keyframes = clip.keyframes.map((key) =>
    key.property === "volume"
      ? { ...key, value: round(Math.min(2, key.value * gain)) }
      : key,
  );
}
function intervalRms(
  measure: AudioMeasurements,
  from: number,
  to: number,
  gate?: AudioMeasurements,
) {
  const values: number[] = [];
  const step = measure.activity.stepSeconds;
  for (
    let i = Math.max(0, Math.floor(from / step));
    i < Math.min(measure.activity.rmsDbfs.length, Math.ceil(to / step));
    i++
  ) {
    if (gate) {
      const voice =
        gate.activity.rmsDbfs[
          Math.floor((i * step) / gate.activity.stepSeconds)
        ];
      if (!Number.isFinite(voice) || voice < -40) continue;
    }
    const value = measure.activity.rmsDbfs[i];
    if (Number.isFinite(value)) values.push(10 ** (value / 10));
  }
  if (values.length * step < 0.12) return null;
  return (
    10 *
    Math.log10(
      Math.max(
        1e-20,
        values.reduce((sum, value) => sum + value, 0) / values.length,
      ),
    )
  );
}
function atActivity(e: ListeningEvidence, seconds: number) {
  const a = e.stems.voice?.activity ?? e.mix.activity;
  return a.rmsDbfs[Math.max(0, Math.floor(seconds / a.stepSeconds))] ?? -200;
}
function matchedWords(c: Clip, e: ListeningEvidence, fps: number) {
  const expected = transcriptTokens(c.text);
  if (!expected.length) return null;
  const words = e.alignment.words;
  const found: ListeningWord[][] = [];
  for (let i = 0; i < words.length; i++) {
    if (
      words[i].anchorSeconds < c.start / fps - 0.5 ||
      words[i].anchorSeconds > end(c) / fps + 0.5
    )
      continue;
    const match: ListeningWord[] = [];
    let tokens: string[] = [];
    for (let j = i; j < words.length && tokens.length < expected.length; j++) {
      match.push(words[j]);
      tokens.push(...transcriptTokens(words[j].text));
    }
    if (
      tokens.join(" ") === expected.join(" ") &&
      match.every(
        (w) => w.confidence >= 0.7 && w.lastAnchorSeconds >= w.anchorSeconds,
      )
    )
      found.push(match);
  }
  return found.length === 1 ? found[0] : null;
}
/** Keep authored spelling and highlights; only use actual recognized local offsets. */
function retimedWords(
  c: Clip,
  matched: ListeningWord[],
  start: number,
  duration: number,
  fps: number,
) {
  if (!c.words.length) return [];
  if (
    c.words.length !== matched.length ||
    c.words.some(
      (w, i) =>
        transcriptTokens(w.text).join(" ") !==
        transcriptTokens(matched[i].text).join(" "),
    )
  )
    return null;
  const seconds = duration / fps;
  const result = c.words.map((w, i) => {
    const m = matched[i];
    const from = Math.max(0, m.startSeconds - start / fps);
    const to = Math.min(seconds, m.endSeconds - start / fps);
    return { ...w, start: round(from), end: round(to) };
  });
  if (
    result.some(
      (w, i) =>
        w.end <= w.start ||
        w.end > seconds + 1e-6 ||
        w.start < 0 ||
        (i > 0 && w.start < result[i - 1].start),
    )
  )
    return null;
  return result;
}
const ordinaryAdvanceWords = new Set(
  "a an the and or but if to of for from with in on at is it its i ill im ive you your we our they their he she this that these those just can will would should want use send link free tool built deletes every trace anything paste finds all giveaways now right called checks writing as people identify".split(
    " ",
  ),
);
function protectedReveal(c: Clip) {
  return (
    transcriptTokens(c.text).some(
      (token) => !ordinaryAdvanceWords.has(token),
    ) ||
    transcriptTokens(c.text).length < 2 ||
    /\b[A-Z][A-Za-z]*[A-Z][A-Za-z]*\b|\b[A-Z]{2,}\b/u.test(c.text) ||
    c.text
      .split(/\s+/u)
      .some(
        (word, i) =>
          i > 0 &&
          /^[A-Z]/u.test(word) &&
          !/^I(?:['’]ll|['’]m|['’]ve)?$/u.test(word),
      )
  );
}

/** Conservative local-evidence corrections. Model prose is never executable edit input. */
export function planListeningFixes(
  project: Project,
  evidence: ListeningEvidence,
  modelIssues: ListeningModelIssue[],
) {
  const next = structuredClone(project);
  const fixes: ListeningFix[] = [];
  const unresolved = [...evidence.limitations];
  if (!evidence.mix.complete)
    return {
      project: next,
      fixes,
      unresolved: [
        ...unresolved,
        "Full local audio measurement was incomplete; no automatic fixes were applied.",
      ],
    };
  const valid = modelIssues.filter(
    (issue) =>
      Number.isFinite(issue.startSeconds) &&
      Number.isFinite(issue.endSeconds) &&
      issue.startSeconds >= 0 &&
      issue.endSeconds > issue.startSeconds &&
      issue.endSeconds <= evidence.durationSeconds + 0.05 &&
      Number.isFinite(issue.confidence) &&
      issue.confidence >= 0.8 &&
      issue.confidence <= 1,
  );
  const handled = new Set<ListeningModelIssue>();
  const changed = new Set<string>();
  const measuredPeak = evidence.mix.truePeakDbtp;
  if (finite(measuredPeak) && measuredPeak > -0.1) {
    const db = Math.max(-6, -1 - measuredPeak);
    const clips = next.clips.filter((c) => audible(next, c));
    clips.forEach((c) => {
      gainClip(c, db);
      changed.add(c.id);
    });
    if (clips.length)
      fixes.push({
        category: "mix",
        kind: "peak_headroom",
        clipIds: clips.map((c) => c.id),
        description: `Reduced audible clip gains by ${Math.abs(db).toFixed(1)} dB to add measured output headroom. This does not repair source distortion.`,
        before: measuredPeak,
        after: measuredPeak + db,
      });
    if (measuredPeak + db > -1)
      unresolved.push(
        "The measured peak needs more than the maximum automatic 6 dB reduction; inspect the source mix.",
      );
  }
  for (const issue of valid) {
    const role = issue.category;
    if (role === "captions") continue;
    const stem = evidence.stems[role];
    const voice = evidence.stems.voice;
    const clips = next.clips.filter(
      (c) =>
        audible(next, c) &&
        roleOf(c) === role &&
        c.start / next.fps < issue.endSeconds &&
        end(c) / next.fps > issue.startSeconds &&
        !changed.has(c.id),
    );
    if (!stem?.complete || !clips.length) continue;
    let db: number | undefined;
    if (
      (issue.kind === "music_masking" || issue.kind === "sfx_masking") &&
      role !== "voice" &&
      voice?.complete
    ) {
      const bedLevel = intervalRms(
        stem,
        issue.startSeconds,
        issue.endSeconds,
        voice,
      );
      const voiceLevel = intervalRms(
        voice,
        issue.startSeconds,
        issue.endSeconds,
        voice,
      );
      const threshold = role === "music" ? -12 : -8;
      const target = role === "music" ? -16 : -12;
      if (
        finite(bedLevel) &&
        finite(voiceLevel) &&
        bedLevel - voiceLevel > threshold
      )
        db = Math.max(
          role === "music" ? -6 : -4,
          target - (bedLevel - voiceLevel),
        );
    } else if (
      issue.kind === "voice_quiet" &&
      role === "voice" &&
      finite(stem.integratedLufs) &&
      stem.integratedLufs < -25 &&
      finite(stem.truePeakDbtp) &&
      finite(measuredPeak)
    ) {
      const headroom = Math.min(-2 - stem.truePeakDbtp, -2 - measuredPeak);
      if (headroom >= 1) db = Math.min(3, headroom, -22 - stem.integratedLufs);
    } else if (
      issue.kind === "voice_loud" &&
      role === "voice" &&
      finite(stem.integratedLufs) &&
      stem.integratedLufs > -12
    ) {
      db = Math.max(-3, -14 - stem.integratedLufs);
    }
    if (db !== undefined && db > 0) {
      const maximum = Math.max(
        ...clips.flatMap((c) => [
          c.volume,
          ...c.keyframes
            .filter((key) => key.property === "volume")
            .map((key) => key.value),
        ]),
      );
      if (maximum > 0) db = Math.min(db, 20 * Math.log10(2 / maximum));
    }
    if (db !== undefined && Math.abs(db) >= 0.5) {
      clips.forEach((c) => {
        gainClip(c, db!);
        changed.add(c.id);
      });
      fixes.push({
        category: role,
        kind: issue.kind,
        clipIds: clips.map((c) => c.id),
        description: `${db < 0 ? "Lowered" : "Raised"} explicit ${role} clips by ${Math.abs(db).toFixed(1)} dB after model and local stem evidence agreed.`,
        after: { gainDb: db },
      });
      handled.add(issue);
    }
    if (issue.kind === "abrupt_ending" && role !== "voice") {
      const last = intervalRms(
        stem,
        Math.max(0, evidence.durationSeconds - 0.2),
        evidence.durationSeconds,
      );
      const ending = clips.filter(
        (c) =>
          c.kind === "audio" &&
          !c.fadeOut &&
          end(c) === Math.round(evidence.durationSeconds * next.fps) &&
          !c.keyframes.some(
            (k) => k.property === "volume" && k.frame >= c.duration - next.fps,
          ),
      );
      if (finite(last) && last > -35 && ending.length) {
        ending.forEach((c) => {
          c.fadeOut = Math.min(
            Math.round(next.fps * (role === "music" ? 0.4 : 0.12)),
            Math.floor((c.duration - 1) / 4),
          );
        });
        const applied = ending.filter((c) => c.fadeOut > 0);
        if (applied.length) {
          fixes.push({
            category: role,
            kind: "ending_fade",
            clipIds: applied.map((c) => c.id),
            description: `Added a short ending fade to explicit ${role} audio with a measured active tail and no existing fade.`,
          });
          handled.add(issue);
        }
      }
    }
  }
  const captions = next.clips
    .filter(
      (c) =>
        c.kind === "caption" &&
        !next.tracks.find((t) => t.id === c.trackId)?.hidden,
    )
    .sort((a, b) => a.start - b.start);
  if (evidence.alignment.status === "complete") {
    for (let i = 1; i < captions.length; i++) {
      const a = captions[i - 1],
        b = captions[i];
      if (a.trackId !== b.trackId || end(a) !== b.start) continue;
      const aw = matchedWords(a, evidence, next.fps),
        bw = matchedWords(b, evidence, next.fps);
      if (!aw || !bw) continue;
      const left = aw.at(-1)!.lastAnchorSeconds,
        right = bw[0].anchorSeconds;
      const boundary = b.start / next.fps;
      if (
        right <= left ||
        (left <= boundary + 0.15 && right >= boundary - 0.15)
      )
        continue;
      const proposed = Math.round(((left + right) / 2) * next.fps);
      if (
        Math.abs(proposed - b.start) > next.fps * 0.5 ||
        proposed <= a.start ||
        proposed >= end(b) ||
        (proposed < b.start && protectedReveal(b)) ||
        atActivity(evidence, left) < -40 ||
        atActivity(evidence, right) < -40
      )
        continue;
      const ad = proposed - a.start,
        bd = end(b) - proposed;
      if (ad < 3 || bd < 3) continue;
      const aWords = retimedWords(a, aw, a.start, ad, next.fps),
        bWords = retimedWords(b, bw, proposed, bd, next.fps);
      if (aWords === null || bWords === null) continue;
      const before = b.start;
      a.duration = ad;
      a.words = aWords;
      b.start = proposed;
      b.duration = bd;
      b.words = bWords;
      fixes.push({
        category: "captions",
        kind: "caption_boundary",
        clipIds: [a.id, b.id],
        description:
          "Moved an adjacent caption boundary using matching fresh local speech alignment and measured activity, preserving the words.",
        before,
        after: proposed,
      });
    }
    // A short measured decay can remove a lingering final cue, never spoken media.
    const voiceActivity = evidence.stems.voice?.complete
      ? evidence.stems.voice.activity
      : undefined;
    const last = captions.at(-1);
    if (last && voiceActivity) {
      const words = matchedWords(last, evidence, next.fps);
      const anchor = words?.at(-1)?.lastAnchorSeconds;
      if (words && anchor !== undefined) {
        const { stepSeconds: step, rmsDbfs } = voiceActivity;
        const needed = Math.max(1, Math.ceil(0.12 / step));
        const from = Math.ceil((anchor + 0.04) / step);
        const until = Math.min(
          rmsDbfs.length - needed,
          Math.ceil(Math.min(anchor + 0.5, end(last) / next.fps) / step),
        );
        for (let at = from; at <= until; at++) {
          if (
            !rmsDbfs
              .slice(at, at + needed)
              .every((level) => Number.isFinite(level) && level < -42)
          )
            continue;
          const proposed = Math.ceil((at * step + 0.04) * next.fps);
          const removed = end(last) - proposed;
          if (
            removed >= next.fps * 0.15 &&
            removed <= next.fps * 0.5 &&
            proposed > last.start + 3
          ) {
            const adjusted = retimedWords(
              last,
              words,
              last.start,
              proposed - last.start,
              next.fps,
            );
            if (adjusted !== null) {
              const before = end(last);
              last.duration = proposed - last.start;
              last.words = adjusted;
              fixes.push({
                category: "captions",
                kind: "caption_tail",
                clipIds: [last.id],
                description:
                  "Shortened the final caption hold after its matched final word and measured voice decay. No media or speech was trimmed.",
                before,
                after: proposed,
              });
            }
          }
          break;
        }
      }
    }
  }
  // An audio-only model cannot see captions. Every visible cue must have its
  // own local evidence; skipped or ambiguous text must never become a pass.
  if (captions.length && evidence.alignment.status !== "complete") {
    unresolved.push(
      `Caption coverage is incomplete: fresh local alignment was unavailable for ${captions.length} visible caption cues. Authored words and timing were kept.`,
    );
  } else {
    for (const caption of captions) {
      const words = matchedWords(caption, evidence, next.fps);
      const label = `Caption ${caption.id} (${JSON.stringify(caption.text.slice(0, 100))})`;
      if (!words) {
        unresolved.push(
          `${label}: no unique, confident fresh speech match was found. Check the authored wording and timing; it was not rewritten.`,
        );
      } else if (
        words.some(
          (word) =>
            word.anchorSeconds < caption.start / next.fps - 0.15 ||
            word.lastAnchorSeconds > end(caption) / next.fps + 0.15,
        )
      ) {
        unresolved.push(
          `${label}: fresh speech anchors remain outside the caption interval. Automatic timing changes were withheld to preserve the edit.`,
        );
      }
    }
  }
  for (const issue of modelIssues)
    if (!handled.has(issue))
      unresolved.push(
        `${issue.category}: ${issue.description} Automatic correction was withheld because the supporting evidence or safe scope was insufficient.`,
      );
  return {
    project: validateProject(next),
    fixes,
    unresolved: [...new Set(unresolved)],
  };
}
