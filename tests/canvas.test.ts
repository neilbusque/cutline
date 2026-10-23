import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import { resizeCanvas } from "../src/shared/canvas";
import { animatedValue } from "../src/shared/animation";
import { motionValue } from "../src/shared/motion";
import { createMotionDemoProject } from "../src/shared/motion-presets";
import { manualBeatGrid } from "../src/shared/music-sync";
import {
  makeClip,
  MotionLayerSchema,
  newProject,
  validateProject,
  type Project,
} from "../src/shared/model";

function resized(p: Project, width: number, height: number) {
  const commands = resizeCanvas(p, width, height);
  return commands.length
    ? applyCommands(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Change canvas",
        commands,
      })
    : p;
}

describe("atomic canvas resize", () => {
  it("scales the entire 640×360 motion showcase into a 1920×1080 canvas without moving time", () => {
    const p = createMotionDemoProject(640, 360),
      before = structuredClone(p);
    const next = resized(p, 1920, 1080);
    expect(next).toMatchObject({ width: 1920, height: 1080, fps: p.fps });
    for (const [index, clip] of next.clips.entries()) {
      const original = p.clips[index];
      expect(clip).toMatchObject({
        start: original.start,
        duration: original.duration,
        sourceIn: original.sourceIn,
        animationOffset: original.animationOffset,
        motionId: original.motionId,
      });
      expect(clip.width).toBeCloseTo(original.width * 3);
      expect(clip.height).toBeCloseTo(original.height * 3);
    }
    for (const [index, motion] of next.motions.entries()) {
      for (const [layerIndex, layer] of motion.layers.entries()) {
        const original = p.motions[index].layers[layerIndex];
        expect(layer.x).toBeCloseTo(original.x * 3);
        expect(layer.y).toBeCloseTo(original.y * 3);
        expect(layer.width).toBeCloseTo(original.width * 3);
        expect(layer.height).toBeCloseTo(original.height * 3);
        expect(
          layer.keyframes.map(({ frame, easing }) => ({ frame, easing })),
        ).toEqual(
          original.keyframes.map(({ frame, easing }) => ({ frame, easing })),
        );
      }
    }
    expect(p).toEqual(before);
    expect(() =>
      validateProject(JSON.parse(JSON.stringify(next))),
    ).not.toThrow();
  });

  it("scales each shared motion definition once and guards the original project revision", () => {
    const p = createMotionDemoProject(640, 360);
    p.clips.push({ ...p.clips[0], id: "shared-scene-copy", start: p.fps * 8 });
    const commands = resizeCanvas(p, 1280, 720);
    const puts = commands.filter((command) => command.type === "motion.put");
    expect(puts).toHaveLength(p.motions.length);
    expect(
      puts.filter((command) => command.motion.id === p.clips[0].motionId),
    ).toHaveLength(1);
    const next = resized(p, 1280, 720);
    expect(next.motions[0].layers[0].width).toBeCloseTo(
      p.motions[0].layers[0].width * 2,
    );
    expect(() =>
      applyCommands(
        { ...p, revision: p.revision + 1 },
        { projectId: p.id, revision: p.revision, label: "Resize", commands },
      ),
    ).toThrow(/changed/);
  });

  it("scales cross-aspect geometry and pixel curves while preserving easing, loops and animation phase", () => {
    const p = createMotionDemoProject(1280, 720),
      clip = p.clips[0];
    clip.x = 40;
    clip.y = 60;
    clip.fontSize = 80;
    clip.animationOffset = 17;
    clip.keyframes = [
      { property: "x", frame: 0, value: 40, easing: "ease-in-out" },
      { property: "y", frame: 0, value: 60, easing: "ease-out" },
      { property: "scale", frame: 0, value: 0.8, easing: "linear" },
      { property: "x", frame: 90, value: 140, easing: "hold" },
      { property: "y", frame: 90, value: 160, easing: "linear" },
      { property: "scale", frame: 90, value: 1.2, easing: "linear" },
    ];
    const layer = MotionLayerSchema.parse({
      type: "rectangle",
      x: 30,
      y: 40,
      width: 100,
      height: 50,
      fontSize: 40,
      radius: 12,
      glow: 8,
      blur: 6,
      strokeWidth: 4,
      anchorX: 0.25,
      anchorY: 0.75,
      loop: "ping-pong",
      loopFrames: 60,
      staggerFrames: 3,
      keyframes: [
        {
          frame: 0,
          x: -20,
          y: 10,
          blur: 2,
          strokeWidth: 1,
          opacity: 0,
          easing: "spring",
        },
        {
          frame: 60,
          x: 30,
          y: -10,
          blur: 6,
          strokeWidth: 4,
          opacity: 1,
          easing: "hold",
        },
      ],
    });
    p.motions[0].layers = [layer];
    const next = resized(p, 1080, 1920),
      sx = 1080 / 1280,
      sy = 1920 / 720,
      factor = Math.min(sx, sy);
    const moved = next.clips[0],
      vector = next.motions[0].layers[0];
    expect(moved).toMatchObject({
      x: 40 * sx,
      y: 60 * sy,
      fontSize: 80 * factor,
      animationOffset: 17,
    });
    expect(vector).toMatchObject({
      width: 100 * sx,
      height: 50 * sy,
      radius: 12 * factor,
      glow: 8 * factor,
      blur: 6 * factor,
      strokeWidth: 4 * factor,
      anchorX: 0.25,
      anchorY: 0.75,
      loop: "ping-pong",
      loopFrames: 60,
      staggerFrames: 3,
    });
    for (const frame of [0, 10, 30, 50, 70, 110]) {
      expect(animatedValue(moved, "x", frame)).toBeCloseTo(
        animatedValue(clip, "x", frame) * sx,
      );
      expect(animatedValue(moved, "y", frame)).toBeCloseTo(
        animatedValue(clip, "y", frame) * sy,
      );
      expect(animatedValue(moved, "scale", frame)).toBe(
        animatedValue(clip, "scale", frame),
      );
      expect(
        motionValue(vector, "x", frame + moved.animationOffset),
      ).toBeCloseTo(motionValue(layer, "x", frame + clip.animationOffset) * sx);
      expect(
        motionValue(vector, "y", frame + moved.animationOffset),
      ).toBeCloseTo(motionValue(layer, "y", frame + clip.animationOffset) * sy);
      expect(motionValue(vector, "blur", frame)).toBeCloseTo(
        motionValue(layer, "blur", frame) * factor,
      );
      expect(motionValue(vector, "strokeWidth", frame)).toBeCloseTo(
        motionValue(layer, "strokeWidth", frame) * factor,
      );
      expect(motionValue(vector, "opacity", frame)).toBe(
        motionValue(layer, "opacity", frame),
      );
    }
  });

  it("preserves audio, music bindings, source offsets and owned caption timing", () => {
    const p = createMotionDemoProject(1280, 720);
    const musicAsset = {
      id: "song",
      name: "Music",
      path: "/music.wav",
      kind: "audio" as const,
      duration: 8,
      hasAudio: true,
      rhythm: manualBeatGrid({ bpm: 120, duration: 8 }),
    };
    const videoAsset = {
      id: "footage",
      name: "Footage",
      path: "/video.mp4",
      kind: "video" as const,
      duration: 20,
      hasAudio: true,
    };
    p.assets = [musicAsset, videoAsset];
    const music = {
      ...makeClip(p, "audio", "audio", 12, musicAsset),
      id: "music",
      duration: 90,
      sourceIn: 1,
      speed: 2,
      animationOffset: 17,
      keyframes: [
        {
          property: "volume" as const,
          frame: 0,
          value: 0.4,
          easing: "linear" as const,
        },
      ],
    };
    const video = {
      ...makeClip(p, "video", "video", 0, videoAsset),
      id: "video-clip",
      duration: 90,
      sourceIn: 3,
      speed: 0.5,
      animationOffset: 21,
      fadeIn: 5,
      fadeOut: 7,
      musicReactive: {
        musicClipId: music.id,
        mode: "beat" as const,
        style: "both" as const,
        amount: 0.35,
        releaseFrames: 6,
      },
    };
    const caption = {
      ...makeClip(p, "caption", "captions", 12),
      id: "caption",
      duration: 45,
      captionSourceId: video.id,
      words: [{ text: "Preserve", start: 0.1, end: 0.6 }],
      text: "Preserve",
      animationOffset: 3,
    };
    p.clips.push(music, video, caption);
    const next = resized(p, 1080, 1920);
    expect(next.clips.find((clip) => clip.id === music.id)).toEqual(music);
    expect(next.assets).toEqual(p.assets);
    expect(next.clips.find((clip) => clip.id === video.id)).toMatchObject({
      start: video.start,
      duration: video.duration,
      sourceIn: 3,
      speed: 0.5,
      animationOffset: 21,
      fadeIn: 5,
      fadeOut: 7,
      musicReactive: video.musicReactive,
    });
    expect(next.clips.find((clip) => clip.id === caption.id)).toMatchObject({
      start: caption.start,
      duration: caption.duration,
      animationOffset: 3,
      captionSourceId: video.id,
      words: caption.words,
      text: caption.text,
    });
  });

  it("clamps extreme editable geometry and styles to project-schema limits", () => {
    const p = createMotionDemoProject(320, 320),
      clip = p.clips[0];
    Object.assign(clip, {
      x: 7000,
      y: -7000,
      width: 7000,
      height: 7000,
      fontSize: 450,
      keyframes: [{ property: "x", frame: 0, value: 7000, easing: "linear" }],
    });
    p.motions[0].layers = [
      MotionLayerSchema.parse({
        type: "rectangle",
        x: 3500,
        y: -3500,
        width: 3500,
        height: 3500,
        fontSize: 450,
        radius: 1900,
        glow: 90,
        blur: 90,
        strokeWidth: 90,
        keyframes: [{ frame: 0, x: 3500, y: -3500, blur: 90, strokeWidth: 90 }],
      }),
    ];
    const next = resized(p, 3840, 3840);
    expect(next.clips[0]).toMatchObject({
      x: 8000,
      y: -8000,
      width: 8000,
      height: 8000,
      fontSize: 500,
    });
    expect(next.clips[0].keyframes[0].value).toBe(8000);
    expect(next.motions[0].layers[0]).toMatchObject({
      x: 4000,
      y: -4000,
      width: 4000,
      height: 4000,
      fontSize: 500,
      radius: 2000,
      glow: 100,
      blur: 100,
      strokeWidth: 100,
      keyframes: [{ frame: 0, x: 4000, y: -4000, blur: 100, strokeWidth: 100 }],
    });
    const small = resized(next, 320, 320);
    expect(() => validateProject(small)).not.toThrow();
  });

  it("returns no transaction for unchanged dimensions and clearly rejects unsupported dimensions or edit sizes", () => {
    const p = createMotionDemoProject(640, 360);
    expect(resizeCanvas(p, 640, 360)).toEqual([]);
    for (const [width, height] of [
      [319, 360],
      [3841, 360],
      [640.5, 360],
      [640, Infinity],
    ])
      expect(() => resizeCanvas(p, width, height)).toThrow(/whole pixels/);
    const crowded = { ...newProject(), width: 640, height: 360 };
    crowded.clips = Array.from({ length: 2000 }, (_, index) =>
      makeClip(crowded, "text", "titles", index),
    );
    expect(() => resizeCanvas(crowded, 1280, 720)).toThrow(/2,000-command/);
    expect(crowded.width).toBe(640);
  });
});
