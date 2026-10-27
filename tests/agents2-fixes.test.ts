import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssetSchema,
  makeClip,
  newProject,
  validateProject,
  type Asset,
  type Clip,
  type MotionLayer,
  type Project,
} from "../src/shared/model";
import {
  agentEditingGuide,
  agentEditingSchema,
  applyAgentEdit,
  editingSchemaSections,
} from "../src/shared/agent-edit";
import { performAgentEdit } from "../src/shared/agent-inspect";
import { animatedValue } from "../src/shared/animation";
import {
  motionRevealStart,
  motionValue,
  motionProperties,
} from "../src/shared/motion";
import { duckingKeys } from "../src/shared/audio-duck";
import {
  createMotionRecipe,
  motionRecipeIds,
  motionRecipeStyles,
} from "../src/shared/motion-recipes";
import { cutlineWorkflow } from "../src/shared/assistant-instructions";
import { effectsGuideResult } from "../src/shared/agent-guide";
import { MotionGraphicAtFrame } from "../src/composition/MotionGraphic";
import { cutlineTools, longRunningTools } from "../src/main/agent-tools";
import { createAgentMedia } from "../src/main/agent-media";
import { AgentTasks } from "../src/main/agent-tasks";
import { Store } from "../src/main/store";
import { Jobs } from "../src/main/media";
import { toolActivity } from "../src/renderer/Assistant";

const root = path.resolve(__dirname, "..");
const size = (value: unknown) => JSON.stringify(value).length;
const directories: string[] = [];
const temporary = (prefix: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A small talking-head project: a voice clip with a transcript and a music bed.
// ---------------------------------------------------------------------------
const voiceWords = [
  { text: " Hello", start: 1.5, end: 2.0 },
  { text: " there.", start: 2.1, end: 2.6 },
  { text: " Next", start: 6.0, end: 6.5 },
  { text: " part.", start: 6.6, end: 7.2 },
];
function talkingHead(fps: Project["fps"] = 30) {
  const p = newProject();
  p.fps = fps;
  p.width = 1920;
  p.height = 1080;
  const voice = AssetSchema.parse({
    id: "voice-asset",
    name: "Talk.mp4",
    kind: "video",
    path: "/media/talk.mp4",
    duration: 30,
    width: 1920,
    height: 1080,
    hasAudio: true,
    words: voiceWords,
  });
  const silent = AssetSchema.parse({
    id: "silent-asset",
    name: "Narration.wav",
    kind: "audio",
    path: "/media/narration.wav",
    duration: 20,
    hasAudio: true,
  });
  const music = AssetSchema.parse({
    id: "music-asset",
    name: "Bed.wav",
    kind: "audio",
    path: "/media/bed.wav",
    duration: 60,
    hasAudio: true,
  });
  p.assets = [voice, silent, music];
  p.tracks.push({
    id: "voice-track",
    name: "Narration",
    kind: "audio",
    muted: false,
    hidden: false,
  });
  p.clips = [
    {
      ...makeClip(p, "video", "video", fps, voice),
      id: "voice",
      sourceIn: 1,
      duration: fps * 10,
    },
    {
      ...makeClip(p, "audio", "voice-track", fps * 12, silent),
      id: "narration",
      duration: fps * 4,
    },
    {
      ...makeClip(p, "audio", "audio", 0, music),
      id: "music",
      duration: fps * 20,
      volume: 0.8,
    },
  ];
  return validateProject({ ...p, revision: 4 });
}
const edit = (p: Project, actions: unknown[], extra: object = {}) =>
  applyAgentEdit(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Test edit",
    actions,
    ...extra,
  });
const clipOf = (p: Project, id: string) => p.clips.find((c) => c.id === id)!;
const volumeKeys = (c: Clip) =>
  c.keyframes.filter((key) => key.property === "volume");

describe("audio.duck lowers music under speech in one action", () => {
  it("stays ducked to the end when speech stops too close to it for a release", () => {
    const options = { level: 1, ducked: 0.2, attack: 6, release: 9 };
    // Speech ends 2 frames before the last frame of a 900-frame bed.
    const swell = duckingKeys(900, [{ start: 600, end: 897 }], options);
    expect(swell.at(-1)).toMatchObject({ frame: 899, value: 1 });
    const held = duckingKeys(900, [{ start: 600, end: 897 }], {
      ...options,
      holdToEnd: true,
    });
    expect(held.at(-1)).toMatchObject({ frame: 899, value: 0.2 });
    // With room for the release, the music still comes back up.
    const room = duckingKeys(900, [{ start: 600, end: 880 }], {
      ...options,
      holdToEnd: true,
    });
    expect(room.slice(-2)).toMatchObject([
      { frame: 889, value: 1 },
      { frame: 899, value: 1 },
    ]);
  });

  it("ducks about 14 dB under each spoken phrase with short attack and release ramps", () => {
    const p = talkingHead();
    const result = edit(p, [
      { type: "audio.duck", musicClipId: "music", speechClipIds: ["voice"] },
    ]);
    const music = clipOf(result.project, "music");
    const ducked = 0.8 * 10 ** (-14 / 20);
    // Words play at timeline frame 30 + (source - 1) * 30.
    expect(
      volumeKeys(music).map((key) => [key.frame, Number(key.value.toFixed(3))]),
    ).toEqual([
      [0, 0.8],
      [39, 0.8],
      [45, Number(ducked.toFixed(3))],
      [78, Number(ducked.toFixed(3))],
      [87, 0.8],
      [174, 0.8],
      [180, Number(ducked.toFixed(3))],
      [216, Number(ducked.toFixed(3))],
      [225, 0.8],
      [599, 0.8],
    ]);
    expect(volumeKeys(music).every((key) => key.easing === "ease-in-out")).toBe(
      true,
    );
    expect(animatedValue(music, "volume", 60)).toBeCloseTo(ducked, 3);
    expect(animatedValue(music, "volume", 130)).toBeCloseTo(0.8, 3);
    // The ramp is under way before the first word, so speech starts clean.
    const ramp = animatedValue(music, "volume", 42);
    expect(ramp).toBeLessThan(0.8);
    expect(ramp).toBeGreaterThan(ducked);
    expect(result.summary.changedClipIds).toEqual(["music"]);
    expect(result.summary.warnings).toEqual([]);
  });

  it("is one undo step through cutline_edit and a dry run changes nothing", () => {
    const directory = temporary("cutline-duck-");
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.commit(talkingHead(), "Talking head");
    const live = store.project;
    const args = {
      projectId: live.id,
      revision: live.revision,
      label: "Duck music",
      actions: [
        { type: "audio.duck", musicClipId: "music", speechClipIds: ["voice"] },
      ],
    };
    const dry = performAgentEdit(store, { ...args, dryRun: true }) as any;
    expect(store.project).toBe(live);
    expect(dry.summary.changedClipIds).toEqual(["music"]);
    const result = performAgentEdit(store, args) as any;
    expect(result.revision).toBe(store.project.revision);
    expect(volumeKeys(clipOf(store.project, "music")).length).toBe(10);
    expect(size(result)).toBeLessThan(2_000);
    store.undo();
    expect(volumeKeys(clipOf(store.project, "music"))).toEqual([]);
    expect(store.project.clips).toEqual(live.clips);
  });

  it("follows whole clips when asked, or when a voice has no transcript", () => {
    const p = talkingHead();
    const byClip = clipOf(
      edit(p, [
        {
          type: "audio.duck",
          musicClipId: "music",
          speechClipIds: ["voice"],
          by: "clips",
        },
      ]).project,
      "music",
    );
    // The voice clip covers frames 30 to 330.
    expect(animatedValue(byClip, "volume", 100)).toBeLessThan(0.2);
    expect(animatedValue(byClip, "volume", 130)).toBeLessThan(0.2);
    expect(animatedValue(byClip, "volume", 400)).toBeCloseTo(0.8, 3);
    const fallback = edit(p, [
      {
        type: "audio.duck",
        musicClipId: "music",
        speechClipIds: ["narration"],
      },
    ]);
    expect(fallback.summary.warnings.join(" ")).toMatch(/transcript/i);
    const music = clipOf(fallback.project, "music");
    expect(animatedValue(music, "volume", 360 + 60)).toBeLessThan(0.2);
    expect(animatedValue(music, "volume", 300)).toBeCloseTo(0.8, 3);
  });

  it("holds the duck through short gaps between phrases instead of pumping", () => {
    const p = talkingHead();
    p.assets[0].words = [
      { text: " One", start: 1.5, end: 2.0 },
      { text: " two.", start: 2.4, end: 3.0 },
    ];
    const music = clipOf(
      edit(validateProject(p), [
        { type: "audio.duck", musicClipId: "music", speechClipIds: ["voice"] },
      ]).project,
      "music",
    );
    // The 0.4 second gap stays ducked.
    const gap = 30 + Math.round((2.2 - 1) * 30);
    expect(animatedValue(music, "volume", gap)).toBeCloseTo(
      0.8 * 10 ** (-14 / 20),
      3,
    );
  });

  it("takes depth, level, attack and release, replaces earlier volume keys and keeps other keys", () => {
    const p = talkingHead();
    const music = clipOf(p, "music");
    music.keyframes = [
      { property: "volume", frame: 0, value: 0.5, easing: "linear" },
      { property: "volume", frame: 500, value: 0.6, easing: "linear" },
      { property: "blur", frame: 10, value: 2, easing: "linear" },
    ];
    const result = edit(validateProject(p), [
      {
        type: "audio.duck",
        musicClipId: "music",
        speechClipIds: ["voice"],
        depthDb: -18,
        attackFrames: 3,
        releaseFrames: 12,
      },
    ]);
    const next = clipOf(result.project, "music");
    expect(result.summary.warnings.join(" ")).toMatch(
      /Replaced 2 earlier volume keys/,
    );
    // The level outside speech is the loudest earlier key.
    expect(animatedValue(next, "volume", 130)).toBeCloseTo(0.6, 3);
    expect(animatedValue(next, "volume", 60)).toBeCloseTo(
      0.6 * 10 ** (-18 / 20),
      3,
    );
    const frames = volumeKeys(next).map((key) => key.frame);
    expect(frames).toContain(42);
    expect(frames).toContain(90);
    expect(next.keyframes.filter((key) => key.property === "blur")).toEqual([
      { property: "blur", frame: 10, value: 2, easing: "linear" },
    ]);
    const leveled = clipOf(
      edit(p, [
        {
          type: "audio.duck",
          musicClipId: "music",
          speechClipIds: ["voice"],
          level: 0.3,
        },
      ]).project,
      "music",
    );
    expect(animatedValue(leveled, "volume", 130)).toBeCloseTo(0.3, 3);
  });

  it("writes keys in the clip's animation phase after a trim", () => {
    const p = talkingHead();
    const music = clipOf(p, "music");
    // Trimmed so the clip starts 3 seconds into its animation.
    music.animationOffset = 90;
    const next = clipOf(
      edit(validateProject(p), [
        { type: "audio.duck", musicClipId: "music", speechClipIds: ["voice"] },
      ]).project,
      "music",
    );
    expect(Math.min(...volumeKeys(next).map((key) => key.frame))).toBe(90);
    expect(animatedValue(next, "volume", 60)).toBeLessThan(0.2);
    expect(animatedValue(next, "volume", 130)).toBeCloseTo(0.8, 3);
  });

  it("explains bad clips instead of guessing", () => {
    const p = talkingHead();
    p.clips.push({ ...makeClip(p, "text", "titles", 0), id: "title" });
    const bad = validateProject(p);
    expect(() =>
      edit(bad, [
        { type: "audio.duck", musicClipId: "title", speechClipIds: ["voice"] },
      ]),
    ).toThrow(/audio or video clip/);
    expect(() =>
      edit(bad, [
        { type: "audio.duck", musicClipId: "music", speechClipIds: ["music"] },
      ]),
    ).toThrow(/cannot duck under itself/);
    const late = structuredClone(bad);
    clipOf(late, "voice").start = 900;
    expect(() =>
      edit(validateProject(late), [
        { type: "audio.duck", musicClipId: "music", speechClipIds: ["voice"] },
      ]),
    ).toThrow(/plays while/);
  });

  it("stays inside the key limit for long interviews", () => {
    const p = talkingHead();
    // 1,200 short phrases, each separated by a second of silence.
    p.assets[0].duration = 3000;
    p.assets[0].words = Array.from({ length: 1200 }, (_, index) => ({
      text: " word",
      start: 1 + index * 2,
      end: 1.6 + index * 2,
    }));
    const voice = clipOf(p, "voice");
    voice.duration = 30 * 2400;
    clipOf(p, "music").duration = 30 * 2400;
    p.assets[2].duration = 3000;
    const result = edit(validateProject(p), [
      { type: "audio.duck", musicClipId: "music", speechClipIds: ["voice"] },
    ]);
    const keys = volumeKeys(clipOf(result.project, "music"));
    expect(keys.length).toBeLessThanOrEqual(2000);
    expect(result.summary.warnings.join(" ")).toMatch(/stay ducked/);
  });

  it("explains instead of looping when other keys leave no room for the curve", () => {
    const p = talkingHead();
    clipOf(p, "music").keyframes = Array.from({ length: 1998 }, (_, frame) => ({
      property: "blur" as const,
      frame,
      value: 0,
      easing: "linear" as const,
    }));
    expect(() =>
      edit(validateProject(p), [
        { type: "audio.duck", musicClipId: "music", speechClipIds: ["voice"] },
      ]),
    ).toThrow(/too many other keyframes/);
  });

  it("gives Auto Reel exactly the music curve it had before the helper was shared", () => {
    // The ducking Auto Reel used before it was shared.
    const oldVolumeKeys = (
      duration: number,
      ranges: { startSeconds: number; endSeconds: number }[],
      fps: number,
    ) => {
      const normal = 0.18,
        ducked = 0.075,
        last = duration - 1,
        ramp = Math.max(1, Math.round(fps * 0.2));
      const keys = new Map<number, number>([
        [0, normal],
        [last, normal],
      ]);
      for (const range of ranges) {
        const start = Math.max(0, Math.floor(range.startSeconds * fps)),
          end = Math.min(last, Math.ceil(range.endSeconds * fps));
        if (start > last || end < 0) continue;
        keys.set(Math.max(0, start - ramp), normal);
        keys.set(start, ducked);
        keys.set(end, ducked);
        if (end + ramp <= last) keys.set(end + ramp, normal);
      }
      return [...keys]
        .sort((a, b) => a[0] - b[0])
        .map(([frame, value]) => ({
          property: "volume" as const,
          frame,
          value,
          easing: "ease-in-out" as const,
        }));
    };
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const fps of [24, 25, 30, 60] as const)
      for (let run = 0; run < 40; run++) {
        // Speech ranges as Auto Reel merges them: gaps longer than 0.65 s.
        const ranges: { startSeconds: number; endSeconds: number }[] = [];
        let at = random() * 2;
        for (let index = 0; index < 1 + Math.floor(random() * 8); index++) {
          const start = at,
            end = start + 0.2 + random() * 4;
          ranges.push({ startSeconds: start, endSeconds: end });
          at = end + 0.66 + random() * 3;
        }
        const duration = Math.max(2, Math.round((at - 0.5 + random()) * fps));
        const ramp = Math.max(1, Math.round(fps * 0.2));
        expect(
          duckingKeys(
            duration,
            ranges.map((range) => ({
              start: Math.floor(range.startSeconds * fps),
              end: Math.ceil(range.endSeconds * fps),
            })),
            { level: 0.18, ducked: 0.075, attack: ramp, release: ramp },
          ),
        ).toEqual(oldVolumeKeys(duration, ranges, fps));
      }
  });
});

// ---------------------------------------------------------------------------
// Motion recipes
// ---------------------------------------------------------------------------
const canvases = [
  { width: 1920, height: 1080 },
  { width: 1080, height: 1920 },
];
const recipeText: Record<string, { text: string; subtitle: string }> = {
  "kinetic-title": {
    text: "Make it move",
    subtitle: "A short film about craft",
  },
  "lower-third": { text: "Jordan Lee", subtitle: "Head of product, Northwind" },
  callout: { text: "New export panel", subtitle: "One click to share" },
  "end-card": { text: "Thanks for watching", subtitle: "Subscribe for more" },
  "logo-sting": { text: "Northwind", subtitle: "Built to last" },
  "progress-bar": { text: "Morning routine", subtitle: "Loading" },
  notification: { text: "Messages", subtitle: "Your order has shipped" },
  subscribe: { text: "Subscribe", subtitle: "Subscribed" },
};
// The title recipes follow the house timing (ease-out in, 2 to 4 frame
// staggers, 1.5 s hold, ease-in out). The overlay recipes of 0.39 have their
// own motion: a linear fill, a press, a banner slide; see trending-tools.
const titleRecipes = motionRecipeIds.filter(
  (id) => !["progress-bar", "notification", "subscribe"].includes(id),
);
function canvas(width: number, height: number, fps: Project["fps"] = 30) {
  return validateProject({ ...newProject(), width, height, fps });
}
function recipe(
  p: Project,
  options: Record<string, unknown>,
  extra: unknown[] = [],
) {
  const result = edit(p, [
    { type: "motion.recipe", at: { seconds: 1 }, ref: "r", ...options },
    ...extra,
  ]);
  const clip = clipOf(result.project, result.references.r);
  const motion = result.project.motions.find(
    (m) => m.id === result.references["r.motion"],
  )!;
  return { result, clip, motion };
}
const named = (layers: MotionLayer[], name: string) =>
  layers.find((layer) => layer.name === name)!;
/** Every frame where a property's keyed value changes direction or settles. */
function overshoot(
  layer: MotionLayer,
  property: (typeof motionProperties)[number],
) {
  const keys = layer.keyframes.filter((key) => key[property] !== undefined);
  if (keys.length < 2) return 0;
  const values = keys.map((key) => key[property]!);
  const low = Math.min(...values),
    high = Math.max(...values),
    span = high - low;
  if (!span) return 0;
  let worst = 0;
  for (let frame = keys[0].frame; frame <= keys.at(-1)!.frame; frame += 0.25) {
    const value = motionValue(layer, property, frame);
    worst = Math.max(worst, (value - high) / span, (low - value) / span);
  }
  return worst;
}
/** The frame a text layer starts to reveal, as the engine times it. */
const revealStart = (layer: MotionLayer) =>
  layer.textAnimation === "line-reveal"
    ? layer.textRevealStart
    : motionRevealStart(layer);
/** The frame a layer's text has fully arrived, from the engine's own timing. */
function revealEnd(layer: MotionLayer, fps: number) {
  if (layer.textAnimation === "line-reveal")
    return (
      layer.textRevealStart +
      layer.textRevealFrames +
      layer.staggerFrames * (layer.text.split("\n").length - 1)
    );
  // Letter rises count every character, spaces included; word rises count words.
  const tokens =
    layer.textAnimation === "word-rise"
      ? layer.text.split(/\s+/).filter(Boolean).length
      : Array.from(layer.text).length;
  return (
    motionRevealStart(layer) +
    layer.staggerFrames * Math.max(0, tokens - 1) +
    Math.round((12 * fps) / 30)
  );
}
/** The first frame the layer starts to leave (its opacity heads to 0). */
function exitStart(layer: MotionLayer) {
  const keys = layer.keyframes.filter((key) => key.opacity !== undefined);
  const last = keys.at(-1)!;
  expect(last.opacity).toBe(0);
  return keys.at(-2)!.frame;
}
const isEaseOut = (key: MotionLayer["keyframes"][number]) =>
  key.easing === "cubic-bezier" && key.bezier![1] >= 1;
const isEaseIn = (key: MotionLayer["keyframes"][number]) =>
  key.easing === "cubic-bezier" &&
  key.bezier![1] === 0 &&
  key.bezier![3] <= 0.1;

describe("motion.recipe builds professional graphics in one call", () => {
  it("steps above captions on screen and sets type larger on vertical video", () => {
    const tall = canvas(1080, 1920);
    const text = tall.tracks.find((track) => track.kind === "text")!;
    const caption = {
      ...makeClip(tall, "caption", text.id, 0),
      id: "cap",
      duration: 300,
      y: 1330,
      height: 259,
      text: "A better morning starts",
    };
    const lower = (p: Project) =>
      recipe(p, { recipe: "lower-third", ...recipeText["lower-third"] }).motion
        .layers;
    const clear = lower(tall);
    const withCaptions = lower({ ...tall, clips: [caption] });
    const bottom = (layers: MotionLayer[]) =>
      Math.max(...layers.map((layer) => layer.y + layer.height));
    expect(bottom(clear)).toBeGreaterThan(1330);
    expect(bottom(withCaptions)).toBeLessThanOrEqual(1330);
    // A phone shows a vertical frame's width across the screen.
    const wide = lower(canvas(1920, 1080));
    const role = (layers: MotionLayer[]) => named(layers, "Role").fontSize;
    expect(role(clear) / role(wide)).toBeCloseTo(1.25, 1);
    expect(role(clear)).toBeGreaterThanOrEqual(36);
  });

  for (const id of motionRecipeIds)
    for (const { width, height } of canvases)
      it(`${id} on ${width}x${height}: named editable layers inside the frame with refs`, () => {
        const p = canvas(width, height);
        const { result, clip, motion } = recipe(p, {
          recipe: id,
          ...recipeText[id],
        });
        expect(clip.start).toBe(30);
        expect(clip.preset).toBe("custom");
        expect(clip.motionId).toBe(motion.id);
        expect(motion.layers.length).toBeLessThanOrEqual(24);
        for (const layer of motion.layers) {
          expect(layer.name, JSON.stringify(layer)).toBeTruthy();
          expect(layer.keyframes.length).toBeLessThanOrEqual(100);
          expect(layer.x).toBeGreaterThanOrEqual(-0.5);
          expect(layer.y).toBeGreaterThanOrEqual(-0.5);
          expect(layer.x + layer.width).toBeLessThanOrEqual(width + 0.5);
          expect(layer.y + layer.height).toBeLessThanOrEqual(height + 0.5);
        }
        const created = result.created.find((item) => item.kind === "motion")!;
        expect(created.ref).toBe("r.motion");
        expect((created as any).layers).toEqual(
          motion.layers.map((layer) => layer.name),
        );
        // Every word of the text is kept.
        const text = motion.layers
          .filter((layer) => layer.type === "text")
          .map((layer) => layer.text.replace(/\s+/g, " "))
          .join(" ");
        for (const word of `${recipeText[id].text} ${recipeText[id].subtitle}`.split(
          " ",
        ))
          expect(text).toContain(word);
        expect(result.summary.warnings).toEqual([]);
      });

  for (const id of titleRecipes)
    for (const style of motionRecipeStyles)
      it(`${id} (${style}) eases out on entrances, in on exits, staggers and holds long enough to read`, () => {
        const p = canvas(1920, 1080);
        const { clip, motion } = recipe(p, {
          recipe: id,
          style,
          ...recipeText[id],
        });
        const last = clip.duration - 1;
        const entrances: { frame: number; text: boolean; name?: string }[] = [];
        for (const layer of motion.layers) {
          if (layer.name === "Background") continue;
          // Exit: an ease-in that finishes by the clip's last frame.
          const exitKeys = layer.keyframes.filter(isEaseIn);
          expect(exitKeys.length, layer.name).toBeGreaterThan(0);
          expect(
            Math.max(...layer.keyframes.map((key) => key.frame)),
            layer.name,
          ).toBeLessThanOrEqual(last);
          for (const property of ["x", "y", "scale"] as const)
            expect(
              overshoot(layer, property),
              `${layer.name} ${property}`,
            ).toBeLessThan(0.06);
          if (layer.type === "text") {
            expect(layer.staggerFrames).toBeGreaterThanOrEqual(2);
            expect(layer.staggerFrames).toBeLessThanOrEqual(4);
            expect(layer.textAnimation).not.toBe("none");
            // Readable: at least 1.5 seconds between arriving and leaving.
            expect(
              exitStart(layer) - revealEnd(layer, p.fps),
              layer.name,
            ).toBeGreaterThanOrEqual(45);
            entrances.push({
              frame: revealStart(layer),
              text: true,
              name: layer.name,
            });
          } else {
            // Shapes enter on an ease-out curve.
            expect(layer.keyframes.some(isEaseOut), layer.name).toBe(true);
            entrances.push({
              frame: layer.keyframes.find(isEaseOut)!.frame,
              text: false,
              name: layer.name,
            });
          }
        }
        // Each text element follows the element before it by 2 to 4 frames.
        const sorted = [...entrances].sort((a, b) => a.frame - b.frame);
        for (let index = 1; index < sorted.length; index++) {
          if (!sorted[index].text) continue;
          const gap = sorted[index].frame - sorted[index - 1].frame;
          expect(gap, sorted[index].name).toBeGreaterThanOrEqual(2);
          expect(gap, sorted[index].name).toBeLessThanOrEqual(4);
        }
      });

  it("puts the lower third's panel, name and role three frames apart, then exits faster than it enters", () => {
    const { motion } = recipe(canvas(1920, 1080), {
      recipe: "lower-third",
      ...recipeText["lower-third"],
    });
    const panel = named(motion.layers, "Panel"),
      name = named(motion.layers, "Name"),
      role = named(motion.layers, "Role");
    const entrance = (layer: MotionLayer) =>
      layer.keyframes.find(isEaseOut)?.frame ??
      layer.keyframes.find((key) => (key.opacity ?? 0) > 0)!.frame;
    expect(entrance(name) - entrance(panel)).toBe(3);
    expect(entrance(role) - entrance(name)).toBe(3);
    const panelIn = panel.keyframes.filter((key) => key.x !== undefined);
    const enterFrames = panelIn[2].frame - panelIn[1].frame;
    const exitFrames = panelIn.at(-1)!.frame - panelIn.at(-2)!.frame;
    expect(enterFrames).toBeGreaterThanOrEqual(10);
    expect(exitFrames).toBeLessThan(enterFrames);
    // The role sits under the name, in the panel.
    expect(role.y).toBeGreaterThan(name.y);
    expect(name.x).toBeGreaterThanOrEqual(panel.x);
    expect(role.x + role.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
  });

  it("applies colors, position and duration, and fits long text", () => {
    const colors = {
      text: "#112233",
      accent: "#ff8800",
      panel: "#202020",
      background: "#000000",
    };
    const { clip, motion } = recipe(canvas(1920, 1080), {
      recipe: "kinetic-title",
      text: "Make it move",
      subtitle: "Now",
      colors,
      position: "top-left",
      durationFrames: 240,
    });
    expect(clip.duration).toBe(240);
    expect(named(motion.layers, "Background").background).toBe("#000000");
    const title = named(motion.layers, "Title");
    expect(title.color).toBe("#112233");
    expect(title.align).toBe("left");
    expect(title.x).toBeLessThan(200);
    expect(title.y).toBeLessThan(250);
    expect(named(motion.layers, "Accent line").stroke).toBe("#ff8800");
    const lower = recipe(canvas(1920, 1080), {
      recipe: "lower-third",
      text: "Jordan Lee",
      subtitle: "Role",
      colors,
      position: "bottom-right",
    }).motion;
    expect(named(lower.layers, "Panel").background).toBe("#202020");
    expect(named(lower.layers, "Name").align).toBe("right");
    expect(named(lower.layers, "Name").x).toBeGreaterThan(960);
    const long = recipe(canvas(1080, 1920), {
      recipe: "kinetic-title",
      text: "Everything you need to know about color grading in one minute",
      style: "bold",
    }).motion;
    const longTitle = named(long.layers, "Title");
    expect(longTitle.text.split("\n").length).toBeGreaterThan(1);
    expect(longTitle.x + longTitle.width).toBeLessThanOrEqual(1080);
    expect(longTitle.textAnimation).toBe("word-rise");
  });

  it("points a callout at a spot and keeps its label in frame", () => {
    const { motion } = recipe(canvas(1920, 1080), {
      recipe: "callout",
      text: "Export",
      point: { x: 1700, y: 300 },
    });
    const ring = named(motion.layers, "Ring"),
      label = named(motion.layers, "Label panel");
    expect(ring.x + ring.width / 2).toBeCloseTo(1700, 0);
    expect(ring.y + ring.height / 2).toBeCloseTo(300, 0);
    // Near the right edge, the label sits to the left of the point.
    expect(label.x + label.width).toBeLessThan(1700);
    expect(named(motion.layers, "Leader").vectorPath).toMatch(/^M1/);
    expect(() =>
      recipe(canvas(1920, 1080), {
        recipe: "lower-third",
        text: "Name",
        point: { x: 10, y: 10 },
      }),
    ).toThrow(/point/);
  });

  it("builds valid, in-frame layers on any canvas, frame rate, style and text", () => {
    const texts = [
      { text: "X" },
      { text: "Quarterly results", subtitle: "Q3" },
      {
        text: "An unusually long headline that keeps going well past what fits on one line",
        subtitle:
          "And a subtitle that is also much longer than a designer would ever choose to write",
      },
      { text: "Two lines\nby hand", subtitle: "First\nSecond" },
    ];
    for (const [width, height] of [
      [320, 320],
      [1080, 1080],
      [3840, 2160],
      [2160, 3840],
    ])
      for (const fps of [24, 60] as const)
        for (const id of motionRecipeIds)
          for (const style of motionRecipeStyles)
            for (const words of texts) {
              const p = canvas(width, height, fps);
              const { motion, clip } = recipe(p, {
                recipe: id,
                style,
                ...words,
              });
              const label = `${id} ${style} ${width}x${height}@${fps} ${words.text}`;
              for (const layer of motion.layers) {
                expect(layer.x, label).toBeGreaterThanOrEqual(-0.5);
                expect(layer.y, label).toBeGreaterThanOrEqual(-0.5);
                expect(layer.x + layer.width, label).toBeLessThanOrEqual(
                  width + 0.5,
                );
                expect(layer.y + layer.height, label).toBeLessThanOrEqual(
                  height + 0.5,
                );
                expect(
                  Math.max(0, ...layer.keyframes.map((key) => key.frame)),
                  label,
                ).toBeLessThan(clip.duration);
              }
              const text = motion.layers
                .filter((layer) => layer.type === "text")
                .map((layer) => layer.text)
                .join(" ");
              for (const word of `${words.text} ${words.subtitle ?? ""}`
                .split(/\s+/)
                .filter(Boolean))
                expect(text, label).toContain(word);
            }
  });

  it("adds its own track with a valid name when the title tracks are busy, even for long text", () => {
    let p = canvas(1920, 1080);
    // Both text tracks other than captions are taken at frame 30.
    p = edit(p, [
      {
        type: "clip.add",
        kind: "text",
        at: { frame: 0 },
        duration: { seconds: 10 },
      },
    ]).project;
    const long = "A".repeat(20) + " " + "very long title ".repeat(8);
    const { clip, result } = recipe(p, {
      recipe: "kinetic-title",
      text: long.trim().slice(0, 160),
    });
    const track = result.project.tracks.find((t) => t.id === clip.trackId)!;
    expect(track.kind).toBe("text");
    expect(track.name.length).toBeLessThanOrEqual(100);
    expect(clipOf(result.project, clip.id).trackId).not.toBe("titles");
  });

  it("fits a three second end card without squeezing its call to action", () => {
    const { result, motion } = recipe(canvas(1080, 1920), {
      recipe: "end-card",
      ...recipeText["end-card"],
      durationFrames: 90,
    });
    expect(result.summary.warnings).toEqual([]);
    const cta = named(motion.layers, "Call to action");
    expect(exitStart(cta) - revealEnd(cta, 30)).toBeGreaterThanOrEqual(45);
  });

  it("compresses a recipe that is shorter than it needs and says so", () => {
    const { result, clip, motion } = recipe(canvas(1920, 1080), {
      recipe: "lower-third",
      ...recipeText["lower-third"],
      durationFrames: 40,
    });
    expect(clip.duration).toBe(40);
    expect(result.summary.warnings.join(" ")).toMatch(/shorter/);
    for (const layer of motion.layers)
      expect(Math.max(...layer.keyframes.map((key) => key.frame))).toBeLessThan(
        40,
      );
  });

  it("scales its timing to the project frame rate", () => {
    const at30 = recipe(canvas(1920, 1080, 30), {
      recipe: "lower-third",
      ...recipeText["lower-third"],
    }).motion;
    const at60 = recipe(canvas(1920, 1080, 60), {
      recipe: "lower-third",
      ...recipeText["lower-third"],
    }).motion;
    const frames = (layer: MotionLayer) => layer.keyframes.map((k) => k.frame);
    const first = frames(named(at30.layers, "Panel"));
    const second = frames(named(at60.layers, "Panel"));
    expect(second.slice(0, 3)).toEqual(first.slice(0, 3).map((f) => f * 2));
  });

  it("returns refs that later actions in the same edit can tweak", () => {
    const p = canvas(1920, 1080);
    const first = recipe(p, { recipe: "lower-third", text: "Jordan Lee" });
    const nameIndex = first.motion.layers.findIndex((l) => l.name === "Name");
    const { motion } = recipe(
      p,
      { recipe: "lower-third", text: "Jordan Lee" },
      [
        {
          type: "motion.layer.update",
          motionId: "$r.motion",
          layer: nameIndex,
          patch: { color: "#ff0000" },
        },
      ],
    );
    expect(motion.layers[nameIndex].color).toBe("#ff0000");
  });

  it("renders with the shared composition at entrance, hold and exit", () => {
    for (const id of motionRecipeIds) {
      const { clip, motion } = recipe(canvas(1920, 1080), {
        recipe: id,
        ...recipeText[id],
      });
      for (const frame of [
        0,
        10,
        Math.round(clip.duration / 2),
        clip.duration - 1,
      ]) {
        const html = renderToStaticMarkup(
          React.createElement(MotionGraphicAtFrame, {
            motion,
            c: clip,
            frame,
            fps: 30,
          }),
        );
        expect(html).toContain("data-motion-layer");
      }
      const hold = renderToStaticMarkup(
        React.createElement(MotionGraphicAtFrame, {
          motion,
          c: clip,
          frame: Math.round(clip.duration / 2),
          fps: 30,
        }),
      );
      for (const word of recipeText[id].text.split(" "))
        expect(hold).toContain(word);
    }
  });
});

describe("the editing schema documents audio.duck and motion.recipe", () => {
  it("lists both actions in the guide with their fields and a recipes section", () => {
    const guide = agentEditingGuide() as any;
    expect(guide.actions["audio.duck"]).toMatch(/^musicClipId, speechClipIds/);
    expect(guide.actions["motion.recipe"]).toMatch(/recipe, at, text/);
    expect(JSON.stringify(guide)).toMatch(/audio\.duck/);
    for (const name of mediaToolNames) expect(guide.media).toContain(name);
    expect(guide.values.motionRecipes.map((r: any) => r.id)).toEqual([
      ...motionRecipeIds,
    ]);
    expect(editingSchemaSections).toContain("motionRecipes");
    const recipes = agentEditingSchema({ section: "motionRecipes" }) as any;
    expect(recipes.schema.recipes.map((r: any) => r.id)).toEqual([
      ...motionRecipeIds,
    ]);
    expect(size(recipes)).toBeLessThan(8_000);
    const duck = agentEditingSchema({ section: "action:audio.duck" }) as any;
    expect(duck.schema.properties.depthDb.default).toBe(-14);
    const motionRecipe = agentEditingSchema({
      section: "action:motion.recipe",
    }) as any;
    expect(motionRecipe.schema.properties.recipe.enum).toEqual([
      ...motionRecipeIds,
    ]);
  });

  it("keeps the tool list compact with colors described once", () => {
    const editTool = cutlineTools.find((tool) => tool.name === "cutline_edit")!;
    const text = JSON.stringify(editTool.inputSchema);
    expect(text).toContain("audio.duck");
    expect(text).toContain("motion.recipe");
    // The long hex pattern is replaced by a short description.
    expect(text).not.toContain("[0-9a-fA-F]{8}");
    expect(size(editTool)).toBeLessThan(24_000);
    // 52,000 since 0.39 (see agents-fixes: value lists and two new actions).
    expect(size({ tools: cutlineTools })).toBeLessThan(52_000);
  });

  it("points agents at the new tools and actions", () => {
    for (const name of [
      "cutline_stock_import",
      "cutline_voiceover",
      "cutline_auto_edit",
      "audio.duck",
      "motion.recipe",
    ])
      expect(cutlineWorkflow).toContain(name);
    const docs = readFileSync(path.join(root, "docs/agent-control.md"), "utf8");
    for (const name of [
      "cutline_stock_import",
      "cutline_voiceover",
      "cutline_auto_edit",
      "cutline_relink",
      "audio.duck",
      "motion.recipe",
    ])
      expect(docs).toContain(name);
    expect(docs).toContain("cutline_editing_schema");
    expect(JSON.stringify(effectsGuideResult())).toContain("audio.duck");
    expect(toolActivity("cutline_stock_import")).toBe("Getting stock media…");
    expect(toolActivity("cutline_voiceover")).toBe("Creating the voiceover…");
    expect(toolActivity("cutline_auto_edit")).toBe("Auto editing the video…");
    expect(toolActivity("cutline_relink")).toBe("Relinking media…");
  });
});

// ---------------------------------------------------------------------------
// Stock, narration, Auto edit and relink as tools
// ---------------------------------------------------------------------------
const mediaToolNames = [
  "cutline_stock_import",
  "cutline_voiceover",
  "cutline_auto_edit",
  "cutline_relink",
];
function footageProject() {
  const p = newProject();
  const asset = AssetSchema.parse({
    id: "main-asset",
    name: "Main.mp4",
    kind: "video",
    path: "/media/main.mp4",
    duration: 60,
    width: 1080,
    height: 1920,
    hasAudio: true,
  });
  p.assets = [asset];
  p.clips = [{ ...makeClip(p, "video", "video", 0, asset), id: "main" }];
  return validateProject(p);
}
const stockOrigin = {
  provider: "Wikimedia Commons",
  page: "https://commons.wikimedia.org/wiki/File:Coffee.webm",
  creator: "A. Barista",
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
  title: "Pouring coffee",
};
function setup(overrides: Record<string, unknown> = {}) {
  const directory = temporary("cutline-agent-media-");
  const store = new Store(path.join(directory, "recovery.cutline"));
  store.commit(footageProject(), "Footage");
  const jobs = new Jobs(() => {});
  let counter = 0;
  const download = vi.fn(async (id: number, provider: string, kind: string) =>
    AssetSchema.parse({
      id: `stock-${++counter}`,
      name: kind === "image" ? "Beans.jpg" : "Coffee.webm",
      kind,
      path: path.join(directory, `stock-${counter}`),
      duration: kind === "image" ? 4 : 12,
      width: 1920,
      height: 1080,
      hasAudio: kind === "video",
      origin: stockOrigin,
    }),
  );
  const generate = vi.fn(async (input: any) => ({
    path: path.join(directory, "voice.wav"),
    duration: 6.5,
    text: input.text,
    voice: input.voice,
  }));
  const status = vi.fn(async () => ({ ready: true, downloadMB: 330 }));
  const importMedia = vi.fn(async (file: string) =>
    AssetSchema.parse({
      id: "voice-1",
      name: path.basename(file),
      kind: "audio",
      path: file,
      duration: 6.5,
      hasAudio: true,
    }),
  );
  const autoEdit = vi.fn(async (args: any) => {
    const p = structuredClone(store.project);
    p.clips = Array.from({ length: 300 }, (_, index) => ({
      ...makeClip(p, "caption", "captions", index * 10),
      id: `caption-${index}`,
      duration: 10,
      text: "word",
    }));
    store.commit(p, "Auto edit Reel");
    return {
      label: "Auto edit Reel",
      startFrame: 0,
      durationFrames: 900,
      targetFrames: 900,
      footageCount: 4,
      captionCount: 300,
      brollCount: 2,
      missingTranscriptAssetIds: [],
      warnings: [
        "Removed 3.1 seconds of long pauses with small speech handles.",
      ],
      music: true,
      sourceName: "Main.mp4",
      pace: args.options.pace,
      clipIds: p.clips.map((clip) => clip.id),
      queries: [
        { query: "pouring coffee", startSeconds: 3, clipId: "caption-1" },
      ],
    };
  });
  const relink = vi.fn(async () => ({ relinked: 2, cleared: false }));
  const call = createAgentMedia({
    store,
    media: { import: importMedia } as any,
    jobs,
    stock: { download },
    speech: { status, generate },
    autoEdit,
    relink,
    ...overrides,
  } as any);
  const guard = () => ({
    projectId: store.project.id,
    revision: store.project.revision,
  });
  return {
    directory,
    store,
    jobs,
    call,
    guard,
    download,
    generate,
    status,
    importMedia,
    autoEdit,
    relink,
  };
}

describe("agent media tools are listed, guarded and long-running", () => {
  it("lists the four tools with revision guards and honest hints", () => {
    const hints = Object.fromEntries(
      cutlineTools.map((tool) => [tool.name, tool]),
    );
    for (const name of mediaToolNames) {
      const tool = hints[name];
      expect(tool, name).toBeTruthy();
      expect((tool.inputSchema as any).required).toEqual(
        expect.arrayContaining(["projectId", "revision"]),
      );
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(size(tool)).toBeLessThan(2_000);
      expect(tool.description!.length).toBeLessThan(700);
      expect(longRunningTools.has(name)).toBe(true);
    }
    expect(hints.cutline_auto_edit.annotations?.destructiveHint).toBe(true);
    expect(hints.cutline_stock_import.annotations?.openWorldHint).toBe(true);
    expect(hints.cutline_auto_edit.annotations?.openWorldHint).toBe(true);
    expect(hints.cutline_voiceover.annotations?.openWorldHint).toBe(false);
    expect(hints.cutline_relink.annotations?.openWorldHint).toBe(false);
    // The older long tools stay long.
    for (const name of [
      "cutline_transcribe",
      "cutline_remove_pauses",
      "cutline_create_reel",
      "cutline_import_media",
    ])
      expect(longRunningTools.has(name)).toBe(true);
  });
});

describe("cutline_reference without at checks what would be shown", () => {
  const mark = '<svg viewBox="0 0 24 24"><path d="M2 2H22V22H2Z"/></svg>';
  function withReferences(logo: (query: unknown) => Promise<unknown>) {
    const screenshot = vi.fn(async () => ({
      file: "/captures/repo.png",
      title: "octo/repo",
    }));
    const harness = setup({
      references: { logo: vi.fn(logo), screenshot },
    });
    return { ...harness, screenshot };
  }

  it("reports a logo, a missing logo or a page and changes nothing", async () => {
    const vector = withReferences(async () => ({
      kind: "vector",
      svg: mark,
      title: "GitHub",
      color: "#181717",
      source: "Simple Icons: GitHub",
    }));
    const before = vector.store.project;
    expect(
      await vector.call("cutline_reference", {
        ...vector.guard(),
        kind: "logo",
        target: "GitHub",
      }),
    ).toEqual({
      revision: before.revision,
      found: true,
      kind: "vector",
      title: "GitHub",
      source: "Simple Icons: GitHub",
      warnings: [],
    });
    expect(vector.store.project).toBe(before);

    const bitmap = withReferences(async () => ({
      kind: "image",
      file: "/logos/acme.png",
      title: "Acme",
      source: "Wikidata",
      matchedBy: "name",
    }));
    const checked = (await bitmap.call("cutline_reference", {
      ...bitmap.guard(),
      kind: "logo",
      target: "Acme",
    })) as any;
    expect(checked).toMatchObject({
      found: true,
      kind: "image",
      title: "Acme",
    });
    expect(checked.warnings[0]).toMatch(/name only/);
    expect(bitmap.importMedia).not.toHaveBeenCalled();

    const missing = withReferences(async () => {
      throw Error('No logo found for "Zed". Try its website instead.');
    });
    expect(
      await missing.call("cutline_reference", {
        ...missing.guard(),
        kind: "logo",
        target: "Zed",
      }),
    ).toMatchObject({
      found: false,
      note: expect.stringMatching(/No logo found/),
    });

    const page = withReferences(async () => ({}));
    const shot = (await page.call("cutline_reference", {
      ...page.guard(),
      kind: "screenshot",
      target: "https://github.com/octo/repo",
    })) as any;
    expect(shot).toMatchObject({
      found: true,
      kind: "screenshot",
      title: "octo/repo",
      file: "/captures/repo.png",
    });
    expect(page.importMedia).not.toHaveBeenCalled();
    expect(page.store.past.length).toBe(1);
  });

  it("still places a vector logo when at is given", async () => {
    const { call, guard, store } = withReferences(async () => ({
      kind: "vector",
      svg: mark,
      title: "GitHub",
      color: "#181717",
      source: "Simple Icons: GitHub",
    }));
    const placed = (await call("cutline_reference", {
      ...guard(),
      kind: "logo",
      target: "GitHub",
      at: { seconds: 2 },
    })) as any;
    expect(placed.revision).toBe(store.project.revision);
    expect(store.project.clips.find((c) => c.id === placed.clipId)?.start).toBe(
      60,
    );
  });
});

describe("cutline_stock_import downloads a search result and places muted B-roll", () => {
  it("checks the revision before downloading anything", async () => {
    const { call, guard, download } = setup();
    await expect(
      call("cutline_stock_import", {
        ...guard(),
        revision: guard().revision - 1,
        id: 5,
      }),
    ).rejects.toThrow(/^Project changed/);
    expect(download).not.toHaveBeenCalled();
  });

  it("imports with credits and places muted B-roll above the footage as one undo step", async () => {
    const { call, guard, store, download } = setup();
    const before = store.project;
    const result = (await call("cutline_stock_import", {
      ...guard(),
      id: 5,
      at: { seconds: 2 },
    })) as any;
    expect(download).toHaveBeenCalledWith(5, "commons", "video");
    expect(store.past.at(-1)!.project).toBe(before);
    const clip = clipOf(store.project, result.clipId);
    expect(clip).toMatchObject({
      kind: "video",
      assetId: result.assetId,
      start: 60,
      duration: 150,
      volume: 0,
    });
    const tracks = store.project.tracks;
    const track = tracks.find((t) => t.id === clip.trackId)!;
    expect(track).toMatchObject({ kind: "video", name: "B-roll" });
    expect(tracks.indexOf(track)).toBeLessThan(
      tracks.findIndex((t) => t.id === "video"),
    );
    expect(
      store.project.assets.find((a) => a.id === result.assetId)!.origin,
    ).toEqual(stockOrigin);
    expect(result.asset.origin.creator).toBe("A. Barista");
    expect(result.asset).not.toHaveProperty("path");
    expect(result.revision).toBe(store.project.revision);
    expect(size(result)).toBeLessThan(3_000);
    store.undo();
    expect(store.project.assets).toEqual(before.assets);
    expect(store.project.tracks).toEqual(before.tracks);
    expect(store.project.clips).toEqual(before.clips);
  });

  it("gives photos a slow zoom, honors duration and finds a free track", async () => {
    const { call, guard, store } = setup();
    const first = (await call("cutline_stock_import", {
      ...guard(),
      id: 7,
      kind: "image",
      at: { frame: 30 },
    })) as any;
    expect(clipOf(store.project, first.clipId)).toMatchObject({
      kind: "image",
      duration: 120,
      cameraMotion: "zoom-in",
      volume: 0,
    });
    // Overlapping the first photo: a second B-roll track.
    const second = (await call("cutline_stock_import", {
      ...guard(),
      id: 8,
      at: { frame: 60 },
      duration: { seconds: 2.5 },
    })) as any;
    const placed = clipOf(store.project, second.clipId);
    expect(placed.duration).toBe(75);
    expect(placed.trackId).not.toBe(
      clipOf(store.project, first.clipId).trackId,
    );
    // A long request is bounded by the clip's length.
    const third = (await call("cutline_stock_import", {
      ...guard(),
      id: 9,
      at: { frame: 600 },
      duration: { seconds: 30 },
    })) as any;
    expect(clipOf(store.project, third.clipId).duration).toBe(360);
    expect(third.warnings.join(" ")).toMatch(/12\.0 seconds/);
  });

  it("says so when B-roll is placed on a hidden track by ID", async () => {
    const { call, guard, store } = setup();
    store.commit(
      {
        ...store.project,
        tracks: [
          {
            id: "hidden-broll",
            name: "B-roll",
            kind: "video",
            muted: false,
            hidden: true,
          },
          ...store.project.tracks,
        ],
      },
      "Hide B-roll",
    );
    const chosen = (await call("cutline_stock_import", {
      ...guard(),
      id: 5,
      at: { frame: 0 },
    })) as any;
    expect(clipOf(store.project, chosen.clipId).trackId).not.toBe(
      "hidden-broll",
    );
    expect(chosen.warnings).toEqual([]);
    const asked = (await call("cutline_stock_import", {
      ...guard(),
      id: 6,
      at: { frame: 0 },
      trackId: "hidden-broll",
    })) as any;
    expect(clipOf(store.project, asked.clipId).trackId).toBe("hidden-broll");
    expect(asked.warnings.join(" ")).toMatch(/hidden/);
  });

  it("only downloads without a placement, and refuses a non-video track before downloading", async () => {
    const { call, guard, store, download } = setup();
    const result = (await call("cutline_stock_import", {
      ...guard(),
      id: 5,
    })) as any;
    expect(result.clipId).toBeUndefined();
    expect(store.project.assets.map((a) => a.id)).toContain(result.assetId);
    expect(store.project.clips).toHaveLength(1);
    download.mockClear();
    await expect(
      call("cutline_stock_import", {
        ...guard(),
        id: 5,
        at: { frame: 0 },
        trackId: "audio",
      }),
    ).rejects.toThrow(/video track/);
    expect(download).not.toHaveBeenCalled();
    await expect(
      call("cutline_stock_import", { ...guard(), id: 5, trackId: "video" }),
    ).rejects.toThrow(/at/);
  });
});

describe("cutline_voiceover makes local narration and can place it", () => {
  it("refuses until the voice engine is set up", async () => {
    // The stand-in that is actually wired in: setup's own generate is replaced.
    const generate = vi.fn();
    const { call, guard } = setup({
      speech: {
        status: async () => ({ ready: false, downloadMB: 330 }),
        generate,
      },
    });
    await expect(
      call("cutline_voiceover", { ...guard(), text: "Hello there." }),
    ).rejects.toThrow(
      /voice engine.*Audio, choose Voice.*Download Kokoro/,
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("generates with the app's defaults, names the asset and places it as one undo step", async () => {
    const { call, guard, store, generate, importMedia } = setup();
    const before = store.project;
    const result = (await call("cutline_voiceover", {
      ...guard(),
      text: "Welcome to the shop. Here is how it works.",
      at: { seconds: 1 },
    })) as any;
    expect(generate).toHaveBeenCalledWith({
      text: "Welcome to the shop. Here is how it works.",
      voice: "af_heart",
      speed: 1.08,
      name: "Heart voiceover",
    });
    expect(importMedia).toHaveBeenCalledWith(
      expect.stringMatching(/voice\.wav$/),
    );
    const asset = store.project.assets.find((a) => a.id === result.assetId)!;
    expect(asset.name).toBe("Heart voiceover");
    const clip = clipOf(store.project, result.clipId);
    expect(clip).toMatchObject({
      kind: "audio",
      start: 30,
      duration: 195,
      volume: 1,
    });
    expect(
      store.project.tracks.find((t) => t.id === clip.trackId),
    ).toMatchObject({ kind: "audio", name: "Voiceover" });
    expect(result).toMatchObject({ durationSeconds: 6.5, voice: "af_heart" });
    expect(store.past.at(-1)!.project).toBe(before);
    expect(size(result)).toBeLessThan(2_000);
  });

  it("never lands narration on a muted track without saying so", async () => {
    const { call, guard, store, importMedia } = setup();
    let imported = 0;
    importMedia.mockImplementation(async (file: string) =>
      AssetSchema.parse({
        id: `voice-${++imported}`,
        name: path.basename(file),
        kind: "audio",
        path: file,
        duration: 6.5,
        hasAudio: true,
      }),
    );
    // The person muted their Voiceover track to hear the music alone.
    store.commit(
      {
        ...store.project,
        tracks: [
          ...store.project.tracks,
          {
            id: "muted-vo",
            name: "Voiceover",
            kind: "audio",
            muted: true,
            hidden: false,
          },
        ],
      },
      "Mute the voiceover",
    );
    const placed = (await call("cutline_voiceover", {
      ...guard(),
      text: "Welcome back.",
      at: { seconds: 0 },
    })) as any;
    const track = store.project.tracks.find(
      (t) => t.id === clipOf(store.project, placed.clipId).trackId,
    )!;
    expect(track.id).not.toBe("muted-vo");
    expect(track).toMatchObject({ kind: "audio", muted: false });
    expect(placed.warnings).toEqual([]);
    // Asked for by ID, it still lands there, with a warning.
    const asked = (await call("cutline_voiceover", {
      ...guard(),
      text: "Welcome back.",
      at: { seconds: 20 },
      trackId: "muted-vo",
    })) as any;
    expect(clipOf(store.project, asked.clipId).trackId).toBe("muted-vo");
    expect(asked.warnings.join(" ")).toMatch(/muted/);
  });

  it("answers a slow narration with a job ID, then lands it as one edit the job reports", async () => {
    const { call, guard, store, jobs, generate } = setup();
    generate.mockImplementationOnce(
      (input: any) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                path: "/tmp/slow.wav",
                duration: 6.5,
                text: input.text,
                voice: input.voice,
              }),
            120,
          ),
        ),
    );
    const tasks = new AgentTasks(jobs, 20, 5);
    const before = store.past.length;
    const pending = (await tasks.run(
      "cutline_voiceover",
      () =>
        call("cutline_voiceover", {
          ...guard(),
          text: "A slower script.",
          at: { frame: 0 },
        }) as Promise<unknown>,
    )) as any;
    expect(pending).toMatchObject({ state: "running" });
    expect(pending.message).toContain("cutline_jobs");
    const [job] = (await tasks.list({
      id: pending.id,
      waitSeconds: 5,
    })) as any[];
    expect(job.state).toBe("done");
    expect(job.result.clipId).toBeTruthy();
    expect(store.past.length).toBe(before + 1);
    expect(store.project.clips.some((c) => c.id === job.result.clipId)).toBe(
      true,
    );
  });

  it("takes a voice, speed and name, and stops if another project opens meanwhile", async () => {
    const { call, guard, store, generate } = setup();
    generate.mockImplementationOnce(async (input: any) => {
      store.fresh();
      return {
        path: "/tmp/v.wav",
        duration: 2,
        text: input.text,
        voice: input.voice,
      };
    });
    await expect(
      call("cutline_voiceover", {
        ...guard(),
        text: "Hi",
        voice: "bm_george",
        speed: 0.9,
        name: "Intro",
      }),
    ).rejects.toThrow(/different project/);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: "bm_george",
        speed: 0.9,
        name: "Intro",
      }),
    );
    expect(store.project.assets).toEqual([]);
  });

  it("cancelling a page capture closes it instead of only relabelling the job", async () => {
    const screenshot = vi.fn(
      (_url: string, options: { signal?: AbortSignal }) =>
        new Promise<{ file: string; title: string }>((_, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(Error("Cancelled")),
          ),
        ),
    );
    const { call, guard, jobs, store } = setup({
      references: { logo: vi.fn(), screenshot },
    });
    const before = store.project;
    const pending = call("cutline_reference", {
      ...guard(),
      kind: "screenshot",
      target: "https://example.com",
    });
    await vi.waitFor(() => expect(screenshot).toHaveBeenCalled());
    const job = [...jobs.jobs.values()].find((j) => j.kind === "reference")!;
    jobs.cancel(job.id);
    await expect(pending).rejects.toThrow("Cancelled");
    expect(job.state).toBe("cancelled");
    expect(store.project).toBe(before);
  });

  it("never lands stock in a Finder duplicate of the project opened during the download", async () => {
    const { call, guard, store, download, directory } = setup();
    const file = path.join(directory, "Reel.cutline");
    store.save(file);
    // A Finder duplicate keeps the project's ID.
    const copy = path.join(directory, "Reel copy.cutline");
    writeFileSync(copy, readFileSync(file, "utf8"));
    const original = download.getMockImplementation()!;
    download.mockImplementationOnce(async (...args) => {
      store.load(copy);
      return original(...args);
    });
    await expect(
      call("cutline_stock_import", { ...guard(), id: 7, at: { frame: 0 } }),
    ).rejects.toThrow(/different project/);
    expect(store.filePath).toBe(copy);
    expect(store.project.assets.some((a) => a.id.startsWith("stock-"))).toBe(
      false,
    );
  });
});

describe("cutline_auto_edit runs Auto edit with the app's options", () => {
  it("needs one source, an absolute path and the current revision", async () => {
    const { call, guard, autoEdit } = setup();
    await expect(call("cutline_auto_edit", { ...guard() })).rejects.toThrow(
      /assetId or path/,
    );
    await expect(
      call("cutline_auto_edit", { ...guard(), path: "relative.mp4" }),
    ).rejects.toThrow(/absolute/);
    await expect(
      call("cutline_auto_edit", {
        ...guard(),
        revision: guard().revision + 1,
        assetId: "main-asset",
      }),
    ).rejects.toThrow(/^Project changed/);
    expect(autoEdit).not.toHaveBeenCalled();
  });

  it("passes the options with the app's defaults and answers compactly", async () => {
    const { call, guard, store, autoEdit } = setup();
    const result = (await call("cutline_auto_edit", {
      ...guard(),
      assetId: "main-asset",
      options: { targetSeconds: 30, style: "clean", captionStyle: "karaoke" },
    })) as any;
    expect(autoEdit).toHaveBeenCalledWith({
      projectId: store.past.at(-1)!.project.id,
      revision: store.past.at(-1)!.project.revision,
      assetId: "main-asset",
      options: {
        targetSeconds: 30,
        style: "clean",
        pace: "natural",
        captionStyle: "karaoke",
        openingTitle: false,
        broll: true,
        music: true,
      },
    });
    expect(result.revision).toBe(store.project.revision);
    expect(result).toMatchObject({
      captionCount: 300,
      brollCount: 2,
      music: true,
      durationFrames: 900,
      clipCount: 300,
    });
    expect(result.clipIds).toBeUndefined();
    expect(result.broll).toEqual([
      { query: "pouring coffee", startSeconds: 3, clipId: "caption-1" },
    ]);
    expect(size(result)).toBeLessThan(6_000);
  });
  it.each(["creator-punch", "screen-demo"])(
    "passes %s media choices without silently enabling stock or music",
    async (format) => {
      const { call, guard, autoEdit } = setup();
      await call("cutline_auto_edit", {
        ...guard(),
        assetId: "main-asset",
        options: { format },
      });
      expect(autoEdit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            format,
            broll: false,
            music: false,
          }),
        }),
      );
      await call("cutline_auto_edit", {
        ...guard(),
        assetId: "main-asset",
        options: { format, broll: true, music: true },
      });
      expect(autoEdit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            format,
            broll: true,
            music: true,
          }),
        }),
      );
    },
  );
});

describe("cutline_relink points a missing asset at a file", () => {
  it("checks the revision, the asset and the path, then relinks in one step", async () => {
    const { call, guard, relink, directory } = setup();
    const file = path.join(directory, "moved.mp4");
    writeFileSync(file, "x");
    await expect(
      call("cutline_relink", { ...guard(), assetId: "nope", path: file }),
    ).rejects.toThrow(/Asset nope is missing/);
    await expect(
      call("cutline_relink", {
        ...guard(),
        assetId: "main-asset",
        path: "moved.mp4",
      }),
    ).rejects.toThrow(/absolute/);
    await expect(
      call("cutline_relink", {
        ...guard(),
        assetId: "main-asset",
        path: path.join(directory, "gone.mp4"),
      }),
    ).rejects.toThrow(/No file/);
    await expect(
      call("cutline_relink", {
        ...guard(),
        revision: 0,
        assetId: "main-asset",
        path: file,
      }),
    ).rejects.toThrow(/^Project changed/);
    expect(relink).not.toHaveBeenCalled();
    const result = (await call("cutline_relink", {
      ...guard(),
      assetId: "main-asset",
      path: file,
    })) as any;
    expect(relink).toHaveBeenCalledWith("main-asset", file);
    expect(result).toMatchObject({ relinked: 2, cleared: false });
    expect(typeof result.revision).toBe("number");
  });
});
