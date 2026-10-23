import { describe, expect, it } from "vitest";
import {
  ClipSchema,
  newProject,
  validateProject,
  RhythmSchema,
} from "../src/shared/model";
import {
  musicBindings,
  musicResponse,
  reactiveVisual,
  reactiveClipVisual,
} from "../src/shared/music-reactive";
import { manualBeatGrid } from "../src/shared/music-sync";
import { applyCommands } from "../src/shared/commands";
const fixture = () => {
  const p = newProject();
  p.fps = 30;
  p.width = 640;
  p.height = 360;
  p.tracks = [
    { id: "audio", name: "Music", kind: "audio", muted: false, hidden: false },
    { id: "text", name: "Titles", kind: "text", muted: false, hidden: false },
  ];
  p.assets = [
    {
      id: "song",
      kind: "audio",
      path: "/music.wav",
      name: "Song",
      duration: 8,
      hasAudio: true,
      rhythm: manualBeatGrid({ bpm: 120, duration: 8 }),
    },
  ];
  const music = ClipSchema.parse({
    id: "music",
    trackId: "audio",
    kind: "audio",
    assetId: "song",
    start: 30,
    duration: 120,
    sourceIn: 1,
    speed: 1,
    volume: 0.1,
  });
  const target = ClipSchema.parse({
    id: "title",
    trackId: "text",
    kind: "text",
    start: 0,
    duration: 180,
    scale: 2,
    musicReactive: {
      musicClipId: "music",
      style: "both",
      amount: 1,
      releaseFrames: 6,
    },
  });
  p.clips = [music, target];
  const valid = validateProject(p);
  return { p: valid, target: valid.clips[1], music: valid.clips[0] };
};
describe("music-reactive composition timing", () => {
  it("anchors pulses to source trim and timeline placement and decays between beats", () => {
    const { p, target } = fixture();
    const b = musicBindings(p).get("music");
    expect(musicResponse(target, 29, b)).toBe(0);
    expect(musicResponse(target, 30, b)).toBe(0.72);
    expect(musicResponse(target, 33, b)).toBeCloseTo(0.18);
    expect(musicResponse(target, 36, b)).toBeCloseTo(0);
    expect(musicResponse(target, 60, b)).toBe(1);
    expect(musicResponse(target, 150, b)).toBe(0);
    expect(reactiveVisual(target, 60, b)).toEqual({ scale: 1.22, glow: 48 });
  });
  it("follows playback speed without using the visual clip animation phase", () => {
    const { p, target, music } = fixture();
    music.speed = 2;
    music.duration = 90;
    p.clips[0] = music;
    target.animationOffset = 80;
    const b = musicBindings(p).get("music");
    expect(musicResponse(target, 45, b)).toBe(1);
    expect(musicResponse(target, 41, b)).toBeCloseTo(0.125);
  });

  it("keeps reading position and canvas steady for accent scope without losing the musical signal", () => {
    const { p, target } = fixture();
    target.musicReactive!.scope = "accents";
    const binding = musicBindings(p).get("music");
    expect(reactiveVisual(target, 60, binding)).toEqual({
      scale: 1.22,
      glow: 48,
    });
    expect(reactiveClipVisual(target, 60, binding)).toEqual({
      scale: 1,
      glow: 0,
    });
    target.musicReactive!.scope = "clip";
    expect(reactiveClipVisual(target, 60, binding)).toEqual({
      scale: 1.22,
      glow: 48,
    });
  });
  it("disables missing, muted, zero-volume and out-of-analysis music", () => {
    const { p, target, music } = fixture();
    expect(musicResponse(target, 60)).toBe(0);
    p.tracks.find((t) => t.kind === "audio")!.muted = true;
    expect(musicResponse(target, 60, musicBindings(p).get("music"))).toBe(0);
    p.tracks.find((t) => t.kind === "audio")!.muted = false;
    music.volume = 0;
    p.clips[0] = music;
    expect(musicResponse(target, 60, musicBindings(p).get("music"))).toBe(0);
    music.volume = 1;
    p.assets[0].rhythm!.duration = 1;
    expect(musicResponse(target, 60, musicBindings(p).get("music"))).toBe(0);
  });
  it("follows animated audio volume and clip fades", () => {
    const { p, target, music } = fixture();
    music.sourceIn = 0;
    music.fadeIn = 30;
    music.fadeOut = 30;
    music.keyframes = [
      { property: "volume", frame: 0, value: 0, easing: "hold" },
      { property: "volume", frame: 30, value: 1, easing: "hold" },
    ];
    p.clips[0] = music;
    const b = musicBindings(p).get("music");
    expect(musicResponse(target, 30, b)).toBe(0);
    expect(musicResponse(target, 45, b)).toBe(0);
    expect(musicResponse(target, 60, b)).toBe(0.72);
    expect(musicResponse(target, 135, b)).toBeGreaterThan(0.3);
    expect(musicResponse(target, 135, b)).toBeLessThan(0.36);
    expect(musicResponse(target, 149, b)).toBe(0);
  });
  it("interpolates measured energy and applies only the chosen visual property", () => {
    const { p, target } = fixture();
    p.assets[0].rhythm!.envelope = { step: 1, values: [0, 0.2, 1, 0] };
    target.musicReactive!.mode = "energy";
    target.musicReactive!.style = "scale";
    const b = musicBindings(p).get("music");
    expect(musicResponse(target, 45, b)).toBeCloseTo(0.6);
    expect(reactiveVisual(target, 60, b)).toEqual({ scale: 1.22, glow: 0 });
    target.musicReactive!.style = "glow";
    expect(reactiveVisual(target, 60, b)).toEqual({ scale: 1, glow: 48 });
  });
  it("keeps the same pulse after splitting a visual and round-tripping the project", () => {
    const { p } = fixture();
    const next = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Split",
      commands: [{ type: "clip.split", id: "title", frame: 45 }],
    });
    const reopened = validateProject(JSON.parse(JSON.stringify(next)));
    const right = reopened.clips.find(
      (c) => c.kind === "text" && c.start === 45,
    )!;
    expect(
      reactiveVisual(right, 60, musicBindings(reopened).get("music")),
    ).toEqual({ scale: 1.22, glow: 48 });
  });
  it("validates bounded, sorted source rhythm while old projects remain neutral", () => {
    expect(() =>
      RhythmSchema.parse({
        ...manualBeatGrid({ bpm: 120, duration: 8 }),
        envelope: { step: Number.MIN_VALUE, values: [1] },
      }),
    ).toThrow();
    expect(() =>
      RhythmSchema.parse({
        ...manualBeatGrid({ bpm: 120, duration: 8 }),
        beats: [
          { time: 1, strength: 1 },
          { time: 0.5, strength: 1 },
        ],
      }),
    ).toThrow();
    const target = ClipSchema.parse({
      id: "old",
      trackId: "text",
      kind: "text",
      start: 0,
      duration: 30,
    });
    expect(reactiveVisual(target, 0)).toEqual({ scale: 1, glow: 0 });
  });
});
