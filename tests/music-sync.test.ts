import { describe, expect, it } from "vitest";
import {
  makeClip,
  newProject,
  RhythmSchema,
  validateProject,
  type Asset,
  type Clip,
  type Project,
} from "../src/shared/model";
import { applyCommands } from "../src/shared/commands";
import { animatedValue } from "../src/shared/animation";
import {
  beatFrames,
  manualBeatGrid,
  nearestBeatFrame,
  syncClipTiming,
  type MusicRhythm,
} from "../src/shared/music-sync";

function fixture() {
  const p = newProject();
  const music: Asset & { rhythm: MusicRhythm } = {
    id: "music-asset",
    name: "Music",
    kind: "audio",
    path: "/tmp/music.wav",
    duration: 20,
    hasAudio: true,
    rhythm: manualBeatGrid({ bpm: 120, duration: 20 }),
  };
  const video: Asset = {
    id: "video-asset",
    name: "Silent footage",
    kind: "video",
    path: "/tmp/video.mp4",
    duration: 20,
    hasAudio: false,
  };
  const image: Asset = {
    id: "image-asset",
    name: "Poster",
    kind: "image",
    path: "/tmp/image.png",
    duration: 0,
    hasAudio: false,
  };
  p.assets = [music, video, image];
  p.clips = [
    { ...makeClip(p, "audio", "audio", 0, music), id: "music", duration: 600 },
  ];
  return p;
}
function addVisual(
  p: Project,
  id: string,
  start: number,
  duration: number,
  kind: "video" | "image" | "text" = "video",
) {
  const clip = {
    ...makeClip(
      p,
      kind,
      kind === "text" ? "titles" : "video",
      start,
      kind === "text"
        ? undefined
        : p.assets.find((asset) => asset.id === `${kind}-asset`),
    ),
    id,
    duration,
    volume: 0,
  };
  p.clips.push(clip);
  return clip;
}
function apply(p: Project, plan: ReturnType<typeof syncClipTiming>) {
  return plan.commands.length ? applyCommands(p, plan) : p;
}

describe("music beat grids", () => {
  it("maps trimmed, offset and sped-up music from source seconds into project frames", () => {
    const p = fixture(),
      music = p.clips[0];
    p.fps = 24;
    music.start = 72;
    music.sourceIn = 1.2;
    music.speed = 2;
    music.duration = 48;
    expect(beatFrames(p, "music")).toEqual([
      76, 82, 88, 94, 100, 106, 112, 118,
    ]);
    // Bars retain source phase: the first source downbeat after a 1.2-second trim is at two seconds.
    expect(beatFrames(p, "music", "bar")).toEqual([82, 106]);
    music.speed = 0.5;
    music.duration = 48;
    expect(beatFrames(p, "music")).toEqual([86, 110]);
  });

  it("clips the source end, deduplicates frame-quantized beats and never returns an exclusive clip end", () => {
    const p = fixture(),
      music = p.clips[0];
    const asset = p.assets[0] as Asset & { rhythm: MusicRhythm };
    music.start = 30;
    music.sourceIn = 0;
    music.duration = 15;
    asset.rhythm.beats = [
      { time: 0, strength: 1 },
      { time: 0.001, strength: 0.8 },
      { time: 0.49, strength: 0.8 },
      { time: 0.5, strength: 1 },
    ];
    expect(beatFrames(p, "music")).toEqual([30]);
  });

  it("chooses earlier ties, supports bounded snapping and rejects foreign music references", () => {
    expect(nearestBeatFrame([30, 10, 20], 15)).toBe(10);
    expect(nearestBeatFrame([10, 20], 15, 4)).toBeUndefined();
    expect(nearestBeatFrame([], 15)).toBeUndefined();
    expect(() => beatFrames(fixture(), "another-projects-music")).toThrow(
      /open project/,
    );
    expect(() => beatFrames(fixture(), "music", "half" as any)).toThrow(
      /beat or bar/,
    );
  });

  it("creates manual source grids with the supplied phase and no invented energy measurements", () => {
    const grid = manualBeatGrid({ bpm: 120, offsetSeconds: 0.2, duration: 2 });
    expect(grid.beats.map((beat) => beat.time)).toEqual([0.2, 0.7, 1.2, 1.7]);
    expect(grid).toMatchObject({
      source: "manual",
      confidence: 1,
      envelope: { step: 0.05, values: [] },
    });
    const longest = manualBeatGrid({ bpm: 300, duration: 1200 });
    expect(() => RhythmSchema.parse(longest)).not.toThrow();
    expect(longest.beats.at(-1)?.time).toBe(1200);
    expect(() => manualBeatGrid({ bpm: 120, duration: 1201 })).toThrow(
      /20 minutes/,
    );
    for (const invalid of [
      { bpm: 0, duration: 5 },
      { bpm: 120, duration: Infinity },
      { bpm: 120, duration: 5, offsetSeconds: 5 },
    ])
      expect(() => manualBeatGrid(invalid)).toThrow();
  });
});

describe("revision-checked music timing plans", () => {
  it("keeps 1,000 short shots valid against a dense 10,000-marker source", () => {
    const p = fixture();
    p.assets[0].duration = 400;
    p.assets[0].rhythm = {
      version: 1,
      source: "detected",
      confidence: 0.9,
      duration: 400,
      beats: Array.from({ length: 10_000 }, (_, index) => ({
        time: index / p.fps,
        strength: 0.7,
      })),
      envelope: { step: 0.05, values: [] },
    };
    p.clips[0].duration = 12_000;
    const clips = Array.from({ length: 1000 }, (_, index) =>
      addVisual(p, `shot-${index}`, index * 9, 9, "image"),
    );
    const before = structuredClone(p);
    const plan = syncClipTiming(p, {
      musicClipId: "music",
      clipIds: clips.map((clip) => clip.id),
      mode: "cuts",
      maxShiftFrames: p.fps * 5,
    });
    expect(plan.commands).toEqual([]);
    expect(plan.summary.changedClips).toBe(0);
    expect(p).toEqual(before);
  });

  it("snaps internal cuts while preserving sequence, outer edges, source offsets and animation phase", () => {
    const p = fixture();
    const clips = [
      addVisual(p, "a", 0, 43),
      addVisual(p, "b", 43, 40),
      addVisual(p, "c", 83, 37),
    ];
    clips[1].sourceIn = 2;
    clips[1].speed = 2;
    clips[1].animationOffset = 9;
    clips[1].keyframes = [
      { property: "x", frame: 0, value: 0, easing: "linear" },
      { property: "x", frame: 100, value: 100, easing: "linear" },
    ];
    const before = structuredClone(p);
    const plan = syncClipTiming(p, {
      musicClipId: "music",
      clipIds: clips.map((clip) => clip.id),
      mode: "cuts",
    });
    const next = apply(p, plan);
    expect(
      next.clips
        .filter((clip) => clips.some((chosen) => chosen.id === clip.id))
        .map((clip) => [clip.start, clip.duration]),
    ).toEqual([
      [0, 45],
      [45, 45],
      [90, 30],
    ]);
    expect(next.clips.find((clip) => clip.id === "b")).toMatchObject({
      sourceIn: 2,
      speed: 2,
      animationOffset: 9,
    });
    expect(
      animatedValue(
        next.clips.find((clip) => clip.id === "b")!,
        "x",
        12,
      ),
    ).toBe(animatedValue(clips[1], "x", 12));
    expect(next.clips.find((clip) => clip.id === "music")).toEqual(p.clips[0]);
    expect(plan.summary).toMatchObject({
      changedClips: 3,
      snappedBoundaries: 2,
      largestShiftFrames: 7,
    });
    expect(p).toEqual(before);
    expect(() =>
      applyCommands({ ...p, revision: p.revision + 1 }, plan),
    ).toThrow(/changed/);
  });

  it("uses feasible neighboring beats instead of extending source media past the final source frame", () => {
    const p = fixture();
    const a = addVisual(p, "a", 0, 43),
      b = addVisual(p, "b", 43, 47);
    a.sourceIn = 20 - 43 / p.fps;
    const plan = syncClipTiming(p, {
      musicClipId: "music",
      clipIds: [a.id, b.id],
      mode: "cuts",
      maxShiftFrames: 15,
    });
    const next = apply(p, plan),
      shot = next.clips.find((clip) => clip.id === "a")!;
    expect(shot.duration).toBe(30);
    expect(
      shot.sourceIn + (shot.duration / p.fps) * shot.speed,
    ).toBeLessThanOrEqual(20);
    expect(next.clips.find((clip) => clip.id === "b")!.start).toBe(30);
    expect(() => validateProject(next)).not.toThrow();
  });

  it("keeps short-shot boundaries strictly increasing when their nearest beat is the same", () => {
    const p = fixture();
    const clips = [
      addVisual(p, "a", 0, 44, "image"),
      addVisual(p, "b", 44, 2, "image"),
      addVisual(p, "c", 46, 44, "image"),
    ];
    const plan = syncClipTiming(p, {
      musicClipId: "music",
      clipIds: clips.map((clip) => clip.id),
      mode: "cuts",
      maxShiftFrames: 2,
    });
    const selected = apply(p, plan).clips.filter((clip) =>
      clips.some((chosen) => chosen.id === clip.id),
    );
    expect(selected.every((clip) => clip.duration >= 1)).toBe(true);
    expect(selected[0].start + selected[0].duration).toBe(selected[1].start);
    expect(selected[1].start + selected[1].duration).toBe(selected[2].start);
    expect(plan.warnings).toHaveLength(1);
  });

  it("supports a contiguous text scene sequence without changing its motion or keys", () => {
    const p = fixture(),
      a = addVisual(p, "text-a", 0, 43, "text"),
      b = addVisual(p, "text-b", 43, 47, "text");
    b.animationOffset = 17;
    const next = apply(
      p,
      syncClipTiming(p, {
        musicClipId: "music",
        clipIds: [a.id, b.id],
        mode: "cuts",
      }),
    );
    expect(next.clips.find((clip) => clip.id === b.id)).toMatchObject({
      start: 45,
      duration: 45,
      animationOffset: 17,
      text: b.text,
      preset: b.preset,
    });
  });

  it("protects audible dialogue and rejects captions, music, gaps, transitions and mixed cut tracks", () => {
    const p = fixture(),
      a = addVisual(p, "a", 0, 43),
      b = addVisual(p, "b", 43, 47);
    p.assets[1].hasAudio = true;
    a.volume = 1;
    const options = {
      musicClipId: "music",
      clipIds: [a.id, b.id],
      mode: "cuts" as const,
    };
    expect(() => syncClipTiming(p, options)).toThrow(/Audible video/);
    expect(() =>
      syncClipTiming(p, { ...options, allowAudibleVideo: true }),
    ).not.toThrow();
    a.volume = 0;
    b.start = 44;
    expect(() => syncClipTiming(p, options)).toThrow(/contiguous/);
    b.start = 43;
    b.transition = { kind: "crossfade", frames: 8, fromId: a.id };
    expect(() => syncClipTiming(p, options)).toThrow(/transitions/);
    delete b.transition;
    expect(() => syncClipTiming(p, { ...options, clipIds: ["music"] })).toThrow(
      /Music and captions/,
    );
    const title = addVisual(p, "title", 43, 47, "text");
    expect(() =>
      syncClipTiming(p, { ...options, clipIds: [a.id, title.id] }),
    ).toThrow(/one track/);
  });

  it("moves starts without changing source, duration or keyframe phase and avoids other track clips", () => {
    const p = fixture(),
      chosen = addVisual(p, "title", 43, 20, "text");
    chosen.animationOffset = 15;
    const next = apply(
      p,
      syncClipTiming(p, {
        musicClipId: "music",
        clipIds: [chosen.id],
        mode: "starts",
      }),
    );
    expect(next.clips.find((clip) => clip.id === chosen.id)).toMatchObject({
      start: 45,
      duration: 20,
      sourceIn: 0,
      animationOffset: 15,
    });
    addVisual(p, "independent", 64, 20, "text");
    const plan = syncClipTiming(p, {
      musicClipId: "music",
      clipIds: [chosen.id],
      mode: "starts",
    });
    expect(plan.commands).toHaveLength(0);
    expect(plan.warnings).toHaveLength(1);
  });

  it("retimes only source-owned captions, trims their word intervals and preserves caption animation phase", () => {
    const p = fixture(),
      a = addVisual(p, "a", 0, 43),
      b = addVisual(p, "b", 43, 47);
    const caption: Clip = {
      ...makeClip(p, "caption", "captions", 70),
      id: "caption",
      duration: 20,
      text: "Keep this",
      captionSourceId: b.id,
      animationOffset: 8,
      words: [
        { text: "Keep", start: 0, end: 0.3 },
        { text: "this", start: 0.3, end: 0.66 },
      ],
    };
    const independent = {
      ...makeClip(p, "caption", "titles", 5),
      id: "independent",
      text: "Independent",
    };
    p.clips.push(caption, independent);
    const plan = syncClipTiming(p, {
      musicClipId: "music",
      clipIds: [a.id, b.id],
      mode: "cuts",
    });
    const next = apply(p, plan),
      moved = next.clips.find((clip) => clip.id === caption.id)!;
    expect(moved).toMatchObject({
      start: 72,
      duration: 18,
      captionSourceId: b.id,
      animationOffset: 8,
      text: "Keep this",
    });
    expect(moved.words[1].end).toBe(0.6);
    expect(next.clips.find((clip) => clip.id === independent.id)).toEqual(
      independent,
    );
  });

  it("removes source-owned caption cues trimmed entirely outside the retained shot", () => {
    const p = fixture(),
      a = addVisual(p, "a", 0, 43),
      b = addVisual(p, "b", 43, 47);
    const caption: Clip = {
      ...makeClip(p, "caption", "captions", 88),
      id: "tail-caption",
      duration: 2,
      captionSourceId: b.id,
      text: "Tail",
      words: [{ text: "Tail", start: 0, end: 2 / p.fps }],
    };
    p.clips.push(caption);
    const plan = syncClipTiming(p, {
      musicClipId: "music",
      clipIds: [a.id, b.id],
      mode: "cuts",
    });
    expect(plan.commands).toContainEqual({
      type: "clip.delete",
      id: caption.id,
      ripple: false,
    });
    expect(apply(p, plan).clips.some((clip) => clip.id === caption.id)).toBe(
      false,
    );
    expect(p.clips.find((clip) => clip.id === caption.id)).toEqual(caption);
  });

  it("returns no edits for already-aligned cuts and rejects missing or duplicate selections", () => {
    const p = fixture(),
      a = addVisual(p, "a", 0, 45),
      b = addVisual(p, "b", 45, 45);
    expect(
      syncClipTiming(p, {
        musicClipId: "music",
        clipIds: [a.id, b.id],
        mode: "cuts",
      }).commands,
    ).toEqual([]);
    expect(() =>
      syncClipTiming(p, {
        musicClipId: "music",
        clipIds: [a.id, a.id],
        mode: "cuts",
      }),
    ).toThrow(/unique/);
    expect(() =>
      syncClipTiming(p, {
        musicClipId: "music",
        clipIds: ["foreign"],
        mode: "starts",
      }),
    ).toThrow(/no longer exists/);
  });
});
