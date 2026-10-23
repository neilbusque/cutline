import { it, expect } from "vitest";
import { newProject, makeClip, validateProject } from "../src/shared/model";
import { applyCommands } from "../src/shared/commands";
import {
  activeTransition,
  boundedClipFades,
  clipFadeEnvelope,
  overlayFadeFrames,
  transitionProgress,
} from "../src/shared/transitions";
function fixture() {
  const p = newProject();
  p.assets = [
    {
      id: "image",
      name: "image",
      path: "/tmp/image.png",
      kind: "image",
      duration: 0,
      hasAudio: false,
    },
  ];
  p.clips = [0, 120, 240].map((start) => ({
    ...makeClip(p, "image", "video", start, p.assets[0]),
    duration: 120,
  }));
  return p;
}
function change(
  p: ReturnType<typeof fixture>,
  kind = "crossfade",
  frames = 15,
) {
  return applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Transition",
    commands: [{ type: "clip.transition", id: p.clips[1].id, kind, frames }],
  });
}
it("overlaps neighbors and ripples only the target track without changing source timing", () => {
  const p = fixture();
  const title = makeClip(p, "text", "titles", 120);
  p.clips.push(title);
  const n = change(p);
  expect(n.clips.map((c) => c.start)).toEqual([0, 105, 225, 120]);
  expect(n.clips[1].sourceIn).toBe(p.clips[1].sourceIn);
  expect(n.clips[1].duration).toBe(120);
  expect(p.clips[1].start).toBe(120);
  expect(activeTransition(n, n.clips[1])?.frames).toBe(15);
});
it("changing presets never accumulates shifts; removing restores hard cut", () => {
  const p = fixture();
  const n = change(change(change(p), "wipe"), "black", 30);
  expect(n.clips.map((c) => c.start)).toEqual([0, 90, 210]);
  expect(change(n, "none").clips.map((c) => c.start)).toEqual([0, 120, 240]);
});
it("clamps duration to half of the shorter shot to prevent triple overlaps", () => {
  const n = change(fixture(), "slide-left", 600);
  expect(n.clips[1].transition?.frames).toBe(60);
  const m = applyCommands(n, {
    projectId: n.id,
    revision: n.revision,
    label: "next",
    commands: [
      { type: "clip.transition", id: n.clips[2].id, kind: "wipe", frames: 600 },
    ],
  });
  expect(m.clips[2].start).toBe(m.clips[0].start + m.clips[0].duration);
});
it("rejects gaps, first clips, audio and stale transactions atomically", () => {
  const p = fixture();
  p.clips[1].start += 1;
  expect(() => change(p)).toThrow(/directly after/);
  p.clips[1].start = 120;
  p.clips[1].kind = "audio";
  expect(() => change(p)).toThrow();
  p.clips[1].kind = "image";
  expect(() =>
    applyCommands(p, {
      projectId: p.id,
      revision: 99,
      label: "stale",
      commands: [{ type: "clip.transition", id: p.clips[1].id, kind: "black" }],
    }),
  ).toThrow(/changed/);
  expect(p.clips[1].transition).toBeUndefined();
});
it("moved or deleted neighbors deactivate transitions instead of fading against missing media", () => {
  const n = change(fixture());
  n.clips[1].start = 150;
  expect(activeTransition(n, n.clips[1])).toBeUndefined();
  n.clips[1].start = 105;
  n.clips.shift();
  expect(activeTransition(n, n.clips[0])).toBeUndefined();
});
it("split keeps original entrance only and transfers the outgoing link to the right half", () => {
  const p = change(fixture());
  const id = p.clips[0].id;
  const n = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "split",
    commands: [{ type: "clip.split", id, frame: 30 }],
  });
  expect(activeTransition(n, n.clips[1])?.previous.id).toBe(n.clips[3].id);
  const m = applyCommands(n, {
    projectId: n.id,
    revision: n.revision,
    label: "split",
    commands: [{ type: "clip.split", id: n.clips[1].id, frame: 160 }],
  });
  expect(m.clips[4].transition).toBeUndefined();
});
it("legacy projects remain valid and transition endpoints are exact", () => {
  expect(validateProject(fixture()).clips.every((c) => !c.transition)).toBe(
    true,
  );
  expect([0, 7, 14, 100].map((f) => transitionProgress(f, 15))).toEqual([
    0, 0.5, 1, 1,
  ]);
});
it("eases transition edges while keeping complementary audio gain continuous", () => {
  const frames = 15;
  const values = Array.from({ length: frames }, (_, f) =>
    transitionProgress(f, frames),
  );
  expect(values[1]).toBeLessThan(0.02);
  expect(values[frames - 1] - values[frames - 2]).toBeLessThan(0.02);
  for (let f = 0; f < frames; f++) {
    expect(values[f] + transitionProgress(frames - 1 - f, frames)).toBeCloseTo(
      1,
      12,
    );
    if (f) expect(values[f]).toBeGreaterThan(values[f - 1]);
  }
});
it("cutaway dissolves start and end on the base image with a clear, fully visible hold", () => {
  const c = { duration: 60, fadeIn: 8, fadeOut: 8 };
  const levels = Array.from({ length: c.duration }, (_, f) =>
    clipFadeEnvelope(c, f),
  );
  expect(levels[0]).toBe(0);
  expect(levels.at(-1)).toBe(0);
  expect(levels[1]).toBeLessThan(0.05);
  expect(levels.slice(8, 52).every((v) => v === 1)).toBe(true);
  expect(levels.every((v) => v >= 0 && v <= 1)).toBe(true);
  expect(clipFadeEnvelope(c, -1)).toBe(0);
  expect(clipFadeEnvelope(c, c.duration)).toBe(0);
});
it("short clips with overlapping fade requests still reach full opacity on a source frame", () => {
  for (const duration of [1, 2, 3, 4, 9, 30]) {
    for (const [fadeIn, fadeOut] of [
      [50, 50],
      [2, 80],
      [80, 2],
      [0, 80],
      [80, 0],
    ]) {
      const c = { duration, fadeIn, fadeOut };
      const bounded = boundedClipFades(c);
      const levels = Array.from({ length: duration }, (_, f) =>
        clipFadeEnvelope(c, f),
      );
      expect(Math.max(...levels), JSON.stringify(c)).toBe(1);
      expect(bounded.fadeIn + bounded.fadeOut).toBeLessThanOrEqual(
        duration - 1,
      );
    }
  }
});
it("unfaded narration stays at unity beneath visual cutaways for every source frame", () => {
  const c = { duration: 385, fadeIn: 0, fadeOut: 0 };
  expect(
    Array.from({ length: c.duration }, (_, f) => clipFadeEnvelope(c, f)).every(
      (v) => v === 1,
    ),
  ).toBe(true);
  expect(clipFadeEnvelope(c, c.duration - 0.5)).toBe(1);
});
it("recommended overlay dissolves adapt to frame rate and leave most of a short shot clear", () => {
  expect(overlayFadeFrames(60, 30)).toBe(8);
  expect(overlayFadeFrames(120, 60)).toBe(16);
  expect(overlayFadeFrames(15, 30)).toBe(2);
  expect(overlayFadeFrames(1, 30)).toBe(0);
});
