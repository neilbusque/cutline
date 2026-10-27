import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssetSchema,
  makeClip,
  newProject,
  validateProject,
  type Clip,
  type Project,
} from "../src/shared/model";
import { applyCommands, speedRamp } from "../src/shared/commands";
import { applyAgentEdit, agentEditingGuide } from "../src/shared/agent-edit";
import {
  speedRampPlan,
  speedRampPresetSegments,
  speedRampPresets,
} from "../src/shared/speed-ramp";
import {
  soundAccentDescriptions,
  soundAccentKinds,
  soundAccentNames,
  soundAccentSeconds,
} from "../src/shared/sound-accents";
import {
  createSoundAccent,
  renderSoundAccent,
  soundAccentWav,
} from "../src/main/sfx";
import { agentMediaTools, createAgentMedia } from "../src/main/agent-media";
import { createMotionRecipe, motionRecipes } from "../src/shared/motion-recipes";
import { MotionGraphicAtFrame } from "../src/composition/MotionGraphic";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

function fixture() {
  const p = newProject();
  const asset = AssetSchema.parse({
    id: "clip",
    name: "B-roll",
    kind: "video",
    path: "/local/broll.mp4",
    duration: 20,
  });
  p.assets = [asset];
  p.clips = [
    {
      ...makeClip(p, "video", "video", 0, asset),
      id: "a",
      duration: 120,
      sourceIn: 2,
      words: [
        { text: "one", start: 0.5, end: 1 },
        { text: "two", start: 2, end: 2.5 },
        { text: "three", start: 3.5, end: 3.9 },
      ],
    },
    { ...makeClip(p, "video", "video", 120, asset), id: "b", duration: 60 },
    { ...makeClip(p, "text", "titles", 150), id: "title", duration: 30 },
  ];
  return p;
}

describe("speed ramps", () => {
  it("plans contiguous pieces in the source and the timeline", () => {
    const plan = speedRampPlan(
      { duration: 120, speed: 1, sourceIn: 2 },
      [
        { seconds: 1, speed: 0.5 },
        { seconds: 2, speed: 2 },
      ],
      30,
    );
    expect(plan.pieces).toEqual([
      { start: 0, duration: 60, sourceIn: 2, sourceSeconds: 1, speed: 0.5 },
      { start: 60, duration: 30, sourceIn: 3, sourceSeconds: 2, speed: 2 },
      { start: 90, duration: 30, sourceIn: 5, sourceSeconds: 1, speed: 1 },
    ]);
    expect(plan.frames).toBe(120);
    expect(plan.shift).toBe(0);
    expect(() =>
      speedRampPlan({ duration: 120, speed: 1, sourceIn: 0 }, [
        { seconds: 5, speed: 1 },
      ], 30),
    ).toThrow(/covers 5.00 s/);
    expect(() =>
      speedRampPlan({ duration: 120, speed: 1, sourceIn: 0 }, [
        { seconds: 1, speed: 9 },
      ], 30),
    ).toThrow(/0.1x to 8x/);
  });
  it("presets split the source by share and are all described", () => {
    for (const preset of speedRampPresets) {
      const segments = speedRampPresetSegments(preset.id, 10);
      expect(segments.reduce((sum, s) => sum + s.seconds, 0)).toBeCloseTo(10, 3);
      expect(preset.description).toMatch(/\.$/);
    }
    expect(speedRampPresetSegments("slow-fast-slow", 8)).toEqual([
      { seconds: 2, speed: 0.5 },
      { seconds: 4, speed: 2.5 },
      { seconds: 2, speed: 0.5 },
    ]);
  });
  it("cuts the clip, keeps words on their frames and moves the rest of the track", () => {
    const p = fixture();
    const n = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Ramp",
      commands: [
        {
          type: "clip.speedRamp",
          id: "a",
          segments: [
            { seconds: 1, speed: 0.5 },
            { seconds: 2, speed: 4 },
          ],
        },
      ],
    });
    expect(() => validateProject(n)).not.toThrow();
    const pieces = n.clips
      .filter((c) => c.trackId === "video" && c.id !== "b")
      .sort((a, b) => a.start - b.start);
    expect(pieces.map((c) => [c.start, c.duration, c.sourceIn, c.speed])).toEqual([
      [0, 60, 2, 0.5],
      [60, 15, 3, 4],
      [75, 30, 5, 1],
    ]);
    expect(pieces[0].id).toBe("a");
    expect(pieces[1].animationOffset).toBe(60);
    expect(pieces[2].animationOffset).toBe(75);
    // 120 frames became 105: the next clip and the title moved up 15 frames.
    expect(n.clips.find((c) => c.id === "b")?.start).toBe(105);
    expect(n.clips.find((c) => c.id === "title")?.start).toBe(150);
    // "one" (source 0.5 s) sits in the half-speed piece at 1 s; "two"
    // (2 s) in the 4x piece at 0.25 s; "three" (3.5 s) in the tail at 0.5 s.
    expect(pieces[0].words).toEqual([{ text: "one", start: 1, end: 2 }]);
    expect(pieces[1].words[0]).toMatchObject({ text: "two", start: 0.25 });
    expect(pieces[2].words[0]).toMatchObject({ text: "three", start: 0.5 });
    expect(n.clips.filter((c) => c.id === "a").length).toBe(1);
  });
  it("refuses clips it cannot keep honest and the rest stays untouched", () => {
    const p = fixture();
    const ramp = [{ seconds: 1, speed: 2 }];
    expect(() => speedRamp(p, { ...p.clips[2] }, ramp)).toThrow(/video and audio/);
    expect(() => speedRamp(p, { ...p.clips[0], reverse: true }, ramp)).toThrow(
      /before reversing/,
    );
    const captioned = fixture();
    captioned.clips.push({
      ...makeClip(captioned, "caption", "captions", 0),
      captionSourceId: "a",
      duration: 30,
    });
    expect(() => speedRamp(captioned, captioned.clips[0], ramp)).toThrow(
      /generated captions/,
    );
    const j = fixture();
    const joined = applyCommands(j, {
      projectId: j.id,
      revision: j.revision,
      label: "Transition",
      commands: [{ type: "clip.transition", id: "b", kind: "whip-left", frames: 9 }],
    });
    expect(() =>
      speedRamp(joined, joined.clips.find((c) => c.id === "a")!, ramp),
    ).toThrow(/transitions/);
  });
  it("is one assistant action", () => {
    const p = fixture();
    const n = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Velocity edit",
      actions: [
        {
          type: "clip.speedRamp",
          clipId: "a",
          segments: [{ seconds: 2, speed: 2 }],
        },
      ],
    }).project;
    expect(n.clips.filter((c) => c.trackId === "video").length).toBe(3);
    expect(JSON.stringify(agentEditingGuide())).toContain("clip.speedRamp");
  });
});

describe("sound accents", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  it("every accent is named, described, short and rendered the same every time", () => {
    for (const kind of soundAccentKinds) {
      expect(soundAccentNames[kind]).toMatch(/^[A-Z]/);
      expect(soundAccentDescriptions[kind]).toMatch(/\.$/);
      expect(soundAccentSeconds[kind]).toBeLessThanOrEqual(1.2);
      const [left, right] = renderSoundAccent(kind);
      expect(left.length).toBe(Math.round(soundAccentSeconds[kind] * 48000));
      let peak = 0;
      for (let i = 0; i < left.length; i++)
        peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      expect(peak).toBeCloseTo(0.708, 2);
      // Ends on silence: no click at the tail.
      expect(Math.abs(left[left.length - 1])).toBeLessThan(0.02);
      expect(renderSoundAccent(kind)[0]).toEqual(left);
    }
    // Different sounds, not the same noise six times.
    const a = renderSoundAccent("whoosh")[0],
      b = renderSoundAccent("riser")[0];
    let same = 0;
    for (let i = 0; i < 4000; i++) if (Math.abs(a[i] - b[i]) < 1e-6) same++;
    expect(same).toBeLessThan(100);
  });
  it("writes a valid 48 kHz stereo WAV once and imports it as a named audio asset", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "cutline-accents-"));
    directories.push(folder);
    const wav = soundAccentWav("pop");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.length).toBe(44 + Math.round(0.14 * 48000) * 4);
    const imports: string[] = [];
    const media = {
      import: async (file: string) => {
        imports.push(file);
        return AssetSchema.parse({
          id: "sfx",
          name: path.basename(file),
          kind: "audio",
          path: file,
          duration: 0.139979,
          hasAudio: true,
        });
      },
    };
    const asset = await createSoundAccent({ kind: "pop", folder, media });
    expect(asset.name).toBe("Pop accent");
    expect(asset.duration).toBe(0.14);
    expect(existsSync(asset.path)).toBe(true);
    expect(readFileSync(asset.path).length).toBe(wav.length);
    expect(existsSync(asset.path + ".credits.txt")).toBe(true);
    const again = await createSoundAccent({ kind: "pop", folder, media });
    expect(again.path).toBe(asset.path);
    expect(imports.length).toBe(2);
  });
  it("the assistant tool places an accent two frames before the event at half volume", async () => {
    const p = fixture();
    let project: Project = p;
    const asset = AssetSchema.parse({
      id: "whoosh",
      name: "Whoosh accent",
      kind: "audio",
      path: "/local/whoosh.wav",
      duration: 0.4,
      hasAudio: true,
    });
    const deps = {
      store: {
        get project() {
          return project;
        },
        openSession: "s",
        commit: (next: Project) => {
          project = next;
        },
      },
      media: { import: async () => asset },
      jobs: { run: async <T,>(_k: string, _m: string, work: (job: any) => Promise<T>) => work({ state: "running" }) },
      stock: { download: async () => asset },
      speech: { status: async () => ({ ready: false }), generate: async () => ({ path: "", duration: 0 }) },
      soundAccent: async () => asset,
      autoEdit: async () => ({}) as never,
      relink: async () => ({}) as never,
    };
    const call = createAgentMedia(deps as never);
    const result = (await call("cutline_sound_accent", {
      projectId: p.id,
      revision: p.revision,
      kind: "whoosh",
      at: { seconds: 2 },
    })) as { clipId: string; startFrame: number; kind: string };
    expect(result.kind).toBe("whoosh");
    expect(result.startFrame).toBe(58);
    const clip = project.clips.find((c) => c.id === result.clipId)!;
    expect(clip).toMatchObject({ audioRole: "sfx", volume: 0.5, duration: 12 });
    expect(project.tracks.find((t) => t.id === clip.trackId)?.name).toBe(
      "Sound effects",
    );
    expect(agentMediaTools.map((t) => t.name)).toContain("cutline_sound_accent");
  });
});

describe("overlay recipes", () => {
  const portrait = () => {
    const p = newProject();
    p.width = 1080;
    p.height = 1920;
    return p;
  };
  const frameOf = (p: Project, created: ReturnType<typeof createMotionRecipe>, frame: number) => {
    const clip = { ...created.clip, duration: created.clip.duration } as Clip;
    return renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion: created.motion,
        c: clip,
        frame,
        fps: p.fps,
      }),
    );
  };
  it("the catalogue lists the new recipes with their layers", () => {
    const ids = motionRecipes.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["progress-bar", "notification", "subscribe"]));
    for (const recipe of motionRecipes) expect(recipe.description).toMatch(/\.$/);
  });
  it("a progress bar fills over the clip with a counter reaching 100%", () => {
    const p = portrait();
    const created = createMotionRecipe(p, 0, {
      recipe: "progress-bar",
      text: "Daily routine loading",
      durationFrames: 150,
    });
    expect(created.layers).toEqual(["Label", "Percent", "Track", "Fill"]);
    const fill = created.motion.layers[3];
    expect(
      createMotionRecipe(p, 0, {
        recipe: "progress-bar",
        text: "Daily routine",
        subtitle: "Loading",
      }).layers,
    ).toEqual(["Label", "Status", "Percent", "Track", "Fill"]);
    expect(fill.type).toBe("line");
    expect(fill.keyframes[0]).toMatchObject({ frame: 0, trim: 0 });
    const full = fill.keyframes.find((k) => k.trim === 1)!;
    expect(full.frame).toBeGreaterThan(100);
    expect(full.frame).toBeLessThan(150);
    expect(created.motion.layers[1].counter).toMatchObject({ from: 0, to: 100, suffix: "%" });
    expect(frameOf(p, created, 0)).toContain("0%");
    expect(frameOf(p, created, full.frame)).toContain("100%");
    expect(created.warnings).toEqual([]);
  });
  it("a notification drops in from above the frame and leaves the same way", () => {
    const p = portrait();
    const created = createMotionRecipe(p, 0, {
      recipe: "notification",
      text: "Messages",
      subtitle: "Your order has shipped",
    });
    expect(created.layers).toEqual(["Panel", "Icon", "Title", "Message"]);
    const panel = created.motion.layers[0];
    expect(panel.y).toBeGreaterThanOrEqual(p.height * 0.1 - 1);
    const opening = panel.keyframes.filter((k) => k.frame === 0);
    expect(opening.some((k) => (k.y ?? 0) < -panel.height)).toBe(true);
    expect(opening.some((k) => k.opacity === 0)).toBe(true);
    const last = Math.max(...panel.keyframes.map((k) => k.frame));
    const closing = panel.keyframes.filter((k) => k.frame === last);
    expect(closing.some((k) => (k.y ?? 0) < -panel.height)).toBe(true);
    // Layers leave a few frames apart; the last one ends on the last frame.
    expect(last).toBeGreaterThanOrEqual(created.clip.duration - 5);
    expect(frameOf(p, created, 40)).toContain("Your order has shipped");
  });
  it("a subscribe button presses after a second, turns dark and rings a bell", () => {
    const p = portrait();
    const created = createMotionRecipe(p, 0, { recipe: "subscribe", text: "" });
    expect(created.layers).toEqual(["Button", "Pressed", "Label", "Pressed label", "Bell"]);
    const [button, pressed, label, pressedLabel, bell] = created.motion.layers;
    expect(button.background).toBe("#ff0033");
    expect(pressed.background).toBe("#272727");
    expect(label.text).toBe("Subscribe");
    expect(pressedLabel.text).toBe("Subscribed");
    const dip = button.keyframes.find((k) => k.scale === 0.92)!;
    expect(dip.frame).toBeGreaterThan(30);
    expect(frameOf(p, created, 20)).toContain("Subscribe");
    expect(bell.type).toBe("path");
    expect(bell.keyframes.some((k) => (k.rotate ?? 0) < 0)).toBe(true);
    const custom = createMotionRecipe(p, 0, {
      recipe: "subscribe",
      text: "Follow",
      subtitle: "Following",
      colors: { accent: "#1d9bf0" },
    });
    expect(custom.motion.layers[0].background).toBe("#1d9bf0");
    expect(custom.motion.layers[2].text).toBe("Follow");
  });
});
