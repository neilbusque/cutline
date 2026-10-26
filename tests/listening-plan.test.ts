import { describe, expect, it } from "vitest";
import { makeClip, newProject, type Clip } from "../src/shared/model";
import {
  planListeningFixes,
  type AudioMeasurements,
  type ListeningEvidence,
  type ListeningModelIssue,
  type ListeningWord,
} from "../src/shared/listening-plan";
function measure(level = -20, peak = -4): AudioMeasurements {
  return {
    integratedLufs: level,
    truePeakDbtp: peak,
    samplePeakDbfs: peak - 0.1,
    clippedSampleCount: 0,
    analyzedSeconds: 4,
    complete: true,
    activity: {
      stepSeconds: 0.02,
      rmsDbfs: Array(200).fill(level),
      peakDbfs: Array(200).fill(peak),
    },
  };
}
function evidence(): ListeningEvidence {
  return {
    durationSeconds: 4,
    mix: measure(),
    stems: {},
    alignment: { status: "unavailable", words: [], method: "test" },
    limitations: [],
  };
}
function fixture() {
  const p = newProject();
  p.assets = [
    {
      id: "voice-asset",
      name: "Voice",
      kind: "audio",
      path: "/voice.wav",
      duration: 4,
      hasAudio: true,
    },
    {
      id: "music-asset",
      name: "Music",
      kind: "audio",
      path: "/music.wav",
      duration: 4,
      hasAudio: true,
    },
  ];
  const v = {
    ...makeClip(p, "audio", "audio", 0, p.assets[0]),
    id: "voice",
    duration: 120,
    audioRole: "voice" as const,
    volume: 1,
  };
  const m = {
    ...makeClip(p, "audio", "audio", 0, p.assets[1]),
    id: "music",
    duration: 120,
    audioRole: "music" as const,
    volume: 0.5,
  };
  p.clips = [v, m];
  return { p, v, m };
}
const issue = (
  category: ListeningModelIssue["category"],
  kind: string,
  extra: Partial<ListeningModelIssue> = {},
): ListeningModelIssue => ({
  category,
  kind,
  startSeconds: 0,
  endSeconds: 4,
  severity: "warning",
  confidence: 0.95,
  description: kind,
  ...extra,
});
const word = (
  text: string,
  anchor: number,
  start = anchor - 0.08,
  stop = anchor + 0.08,
): ListeningWord => ({
  text,
  startSeconds: start,
  endSeconds: stop,
  anchorSeconds: anchor,
  lastAnchorSeconds: anchor,
  confidence: 0.97,
});
describe("Evidence-gated listening fixes", () => {
  it("preserves the input and scales keyed audio, never replacing source media or fading camera pictures", () => {
    const { p, v } = fixture();
    v.kind = "video";
    v.trackId = "video";
    p.assets[0].kind = "video";
    v.keyframes = [
      { property: "volume", frame: 0, value: 0.8, easing: "linear" },
      { property: "volume", frame: 90, value: 0.4, easing: "linear" },
      { property: "x", frame: 0, value: 10, easing: "linear" },
    ];
    const before = structuredClone(p),
      e = evidence();
    e.mix.truePeakDbtp = 0.5;
    const result = planListeningFixes(p, e, []);
    const after = result.project.clips.find((c) => c.id === v.id)!;
    expect(p).toEqual(before);
    expect(result.fixes[0].kind).toBe("peak_headroom");
    expect(after.volume).toBeCloseTo(10 ** (-1.5 / 20), 5);
    expect(after.keyframes[0].value).toBeCloseTo(0.8 * 10 ** (-1.5 / 20), 5);
    expect(after.keyframes[2]).toEqual(v.keyframes[2]);
    expect(after.fadeOut).toBe(v.fadeOut);
    expect(result.project.assets[0].path).toBe("/voice.wav");
  });
  it("does not turn a model distortion claim into invented voice processing", () => {
    const { p } = fixture();
    const result = planListeningFixes(p, evidence(), [
      issue("voice", "distortion"),
    ]);
    expect(result.fixes).toHaveLength(0);
    expect(result.unresolved.join(" ")).toContain("withheld");
    expect(result.project.clips).toEqual(p.clips);
  });
  it("attenuates explicit music only when model masking and measured overlapping stems agree", () => {
    const { p } = fixture(),
      e = evidence();
    e.stems = { voice: measure(-20, -4), music: measure(-25, -10) };
    const result = planListeningFixes(p, e, [issue("music", "music_masking")]);
    expect(result.fixes).toHaveLength(1);
    expect(result.project.clips[1].volume).toBeCloseTo(
      0.5 * 10 ** (-6 / 20),
      5,
    );
    expect(result.project.clips[0].volume).toBe(1);
    delete (p.clips[1] as Clip & { audioRole?: string }).audioRole;
    expect(
      planListeningFixes(p, e, [issue("music", "music_masking")]).fixes,
    ).toHaveLength(0);
  });
  it("does not boost quiet voice without measured mix headroom or change ambiguous audio", () => {
    const { p } = fixture(),
      e = evidence();
    e.stems.voice = measure(-30, -8);
    e.mix.truePeakDbtp = -1;
    expect(
      planListeningFixes(p, e, [issue("voice", "voice_quiet")]).fixes,
    ).toHaveLength(0);
    e.mix.truePeakDbtp = -8;
    const result = planListeningFixes(p, e, [issue("voice", "voice_quiet")]);
    expect(result.fixes).toHaveLength(1);
    expect(result.project.clips[0].volume).toBeCloseTo(10 ** (3 / 20), 5);
  });
  it("rejects out-of-range model timestamps and incomplete local coverage", () => {
    const { p } = fixture(),
      e = evidence();
    e.stems.music = measure(-10, -4);
    e.stems.voice = measure(-20, -4);
    expect(
      planListeningFixes(p, e, [
        issue("music", "music_masking", { endSeconds: 40 }),
      ]).fixes,
    ).toHaveLength(0);
    e.mix.complete = false;
    e.mix.truePeakDbtp = 1;
    expect(planListeningFixes(p, e, []).fixes).toHaveLength(0);
  });
  it("preserves existing fades and does not fade the video when a music role is a video clip", () => {
    const { p, m } = fixture(),
      e = evidence();
    e.stems.music = measure(-20, -6);
    m.fadeOut = 12;
    expect(
      planListeningFixes(p, e, [issue("music", "abrupt_ending")]).fixes,
    ).toHaveLength(0);
    m.fadeOut = 0;
    m.kind = "video";
    m.trackId = "video";
    p.assets[1].kind = "video";
    expect(
      planListeningFixes(p, e, [issue("music", "abrupt_ending")]).fixes,
    ).toHaveLength(0);
  });
  it("corrects an early adjacent phrase boundary with fresh matching DTW and activity, leaving wording unchanged", () => {
    const { p } = fixture(),
      e = evidence();
    const a = {
        ...makeClip(p, "caption", "captions", 0),
        id: "a",
        duration: 30,
        text: "free tool",
        words: [],
      },
      b = {
        ...makeClip(p, "caption", "captions", 30),
        id: "b",
        duration: 50,
        text: "that deletes",
        words: [],
      };
    p.clips.push(a, b);
    e.alignment = {
      status: "complete",
      method: "DTW",
      words: [
        word("free", 0.8),
        word("tool", 1.22),
        word("that", 1.38),
        word("deletes", 1.8),
      ],
    };
    const result = planListeningFixes(p, e, []);
    expect(result.fixes[0].kind).toBe("caption_boundary");
    expect(result.project.clips.find((c) => c.id === "b")!.start).toBe(39);
    expect(result.project.clips.find((c) => c.id === "a")!.text).toBe(a.text);
  });
  it("does not advance a named reveal or use stale asset words when fresh alignment failed", () => {
    const { p } = fixture(),
      e = evidence();
    p.clips.push(
      {
        ...makeClip(p, "caption", "captions", 0),
        id: "a",
        duration: 45,
        text: "its called",
        words: [],
      },
      {
        ...makeClip(p, "caption", "captions", 45),
        id: "b",
        duration: 40,
        text: "SLOP MONSTER",
        words: [],
      },
    );
    e.alignment = {
      status: "complete",
      method: "DTW",
      words: [
        word("its", 0.4),
        word("called", 0.9),
        word("slop", 1.25),
        word("monster", 1.45),
      ],
    };
    expect(planListeningFixes(p, e, []).fixes).toHaveLength(0);
    e.alignment.status = "unavailable";
    p.assets[0].words = [{ text: "new", start: 0, end: 3 }];
    expect(planListeningFixes(p, e, []).fixes).toHaveLength(0);
  });
  it("shortens a lingering final caption only after measured voice decay, preserving media duration", () => {
    const { p } = fixture(),
      e = evidence();
    const cue = {
      ...makeClip(p, "caption", "captions", 60),
      id: "last",
      duration: 40,
      text: "the link",
      words: [],
    };
    p.clips.push(cue);
    e.stems.voice = measure(-20, -4);
    e.stems.voice.activity.rmsDbfs.fill(-60, 145);
    e.alignment = {
      status: "complete",
      method: "DTW",
      words: [word("the", 2.6), word("link", 2.8)],
    };
    const result = planListeningFixes(p, e, []);
    expect(result.fixes.some((f) => f.kind === "caption_tail")).toBe(true);
    expect(
      result.project.clips.find((c) => c.id === "last")!.duration,
    ).toBeLessThan(40);
    expect(result.project.clips.find((c) => c.id === "voice")!.duration).toBe(
      120,
    );
  });
  it("reports wrong visible caption wording even when the audio model returns no issues", () => {
    const { p } = fixture(),
      e = evidence();
    p.clips.push({
      ...makeClip(p, "caption", "captions", 0),
      id: "wrong-cue",
      duration: 60,
      text: "Unrelated authored words",
      words: [],
    });
    e.alignment = {
      status: "complete",
      method: "DTW",
      words: [word("actual", 0.4), word("spoken", 0.8), word("phrase", 1.3)],
    };
    const result = planListeningFixes(p, e, []);
    expect(result.fixes).toHaveLength(0);
    expect(result.unresolved.join(" ")).toContain("wrong-cue");
    expect(result.unresolved.join(" ")).toContain("Unrelated authored words");
    expect(result.project.clips.at(-1)!.text).toBe("Unrelated authored words");
  });
  it("reports missing fresh caption coverage but does not treat text titles as speech captions", () => {
    const { p } = fixture(),
      e = evidence();
    p.clips.push({
      ...makeClip(p, "text", "titles", 0),
      id: "title",
      duration: 60,
      text: "A title",
      words: [],
    });
    expect(planListeningFixes(p, e, []).unresolved).toHaveLength(0);
    p.clips.push({
      ...makeClip(p, "caption", "captions", 0),
      id: "cue",
      duration: 60,
      text: "spoken words",
      words: [],
    });
    expect(planListeningFixes(p, e, []).unresolved.join(" ")).toContain(
      "fresh local alignment was unavailable for 1 visible caption cues",
    );
    p.tracks.find((t) => t.id === "captions")!.hidden = true;
    expect(planListeningFixes(p, e, []).unresolved).toHaveLength(0);
  });
  it("keeps caption corrections inside half a second and skips acoustic silence", () => {
    const { p } = fixture(),
      e = evidence();
    p.clips.push(
      {
        ...makeClip(p, "caption", "captions", 0),
        id: "a",
        duration: 30,
        text: "free tool",
        words: [],
      },
      {
        ...makeClip(p, "caption", "captions", 30),
        id: "b",
        duration: 50,
        text: "that deletes",
        words: [],
      },
    );
    e.alignment = {
      status: "complete",
      method: "DTW",
      words: [
        word("free", 0.8),
        word("tool", 1.22),
        word("that", 1.38),
        word("deletes", 1.8),
      ],
    };
    e.mix.activity.rmsDbfs.fill(-80);
    expect(planListeningFixes(p, e, []).fixes).toHaveLength(0);
  });
});
