import { describe, expect, it } from "vitest";
import {
  alignOnStage,
  resizeOnStage,
  snapOnStage,
  stageBounds,
} from "../src/shared/stage-layout";
import { makeClip, newProject, type Clip } from "../src/shared/model";
import {
  previewTransform,
  transformCommands,
} from "../src/renderer/edit-gestures";
import { applyCommands } from "../src/shared/commands";

const canvas = { width: 1920, height: 1080 };
const box = { x: 100, y: 200, width: 400, height: 200, rotation: 90, scale: 2 };
function corner(b: typeof box) {
  const a = (b.rotation * Math.PI) / 180;
  return {
    x:
      b.x +
      b.width / 2 +
      (b.scale * (-b.width * Math.cos(a) + b.height * Math.sin(a))) / 2,
    y:
      b.y +
      b.height / 2 +
      (b.scale * (-b.width * Math.sin(a) - b.height * Math.cos(a))) / 2,
  };
}
describe("precision canvas editing", () => {
  it("aligns the drawn edge, accounting for scale and rotation", () => {
    const bounds = stageBounds(box);
    expect(bounds.left).toBeCloseTo(100);
    expect(bounds.right).toBeCloseTo(500);
    expect(bounds.top).toBeCloseTo(-100);
    expect(bounds.bottom).toBeCloseTo(700);
    for (const [alignment, side, expected] of [
      ["left", "left", 0],
      ["right", "right", 1920],
      ["top", "top", 0],
      ["bottom", "bottom", 1080],
      ["center", "center", 960],
      ["middle", "middle", 540],
    ] as const) {
      expect(
        stageBounds({ ...box, ...alignOnStage(box, canvas, alignment) })[side],
      ).toBeCloseTo(expected);
    }
  });
  it("keeps the opposite transformed corner stationary during rotated/scaled resizing", () => {
    for (const rotation of [0, 30, 90, 175, -40])
      for (const scale of [0.4, 1, 2]) {
        const before = { ...box, rotation, scale };
        const after = { ...before, ...resizeOnStage(before, 120, -50, false) };
        expect(corner(after).x).toBeCloseTo(corner(before).x);
        expect(corner(after).y).toBeCloseTo(corner(before).y);
      }
  });
  it("locks aspect ratio without exceeding dimension limits", () => {
    const after = resizeOnStage(box, 40000, 20000, true);
    expect(after.width / after.height).toBeCloseTo(2);
    expect(after.width).toBeLessThanOrEqual(8000);
    expect(after.height).toBeGreaterThanOrEqual(1);
  });
  it("snaps the nearest drawn anchor and respects axis locking", () => {
    const near = {
      x: 861,
      y: 442,
      width: 200,
      height: 200,
      scale: 1,
      rotation: 0,
    };
    expect(snapOnStage(near, canvas, [], 6)).toEqual({
      x: 860,
      y: 440,
      guideX: 960,
      guideY: 540,
    });
    expect(snapOnStage(near, canvas, [], 6, "x")).toEqual({
      x: 860,
      y: 442,
      guideX: 960,
      guideY: undefined,
    });
    expect(
      snapOnStage({ ...near, x: 800, y: 400 }, canvas, [], 6),
    ).toMatchObject({ x: 800, y: 400, guideX: undefined, guideY: undefined });
  });
  it("snaps to neighboring clip edges and clamps off-stage movement", () => {
    const moved = {
      x: 301,
      y: 443,
      width: 100,
      height: 100,
      scale: 1,
      rotation: 0,
    };
    const other = { ...moved, x: 500, y: 700 };
    expect(snapOnStage({ ...moved, x: 399 }, canvas, [other], 3).x).toBe(400);
    expect(snapOnStage({ ...moved, x: 9000 }, canvas, [], 1).x).toBe(8000);
  });
  it("preserves a custom easing curve on a trimmed animated clip in preview and saved edits", () => {
    const p = newProject();
    const clip: Clip = {
      ...makeClip(p, "text", "titles", 0),
      animationOffset: 10,
      keyframes: [
        {
          property: "x",
          frame: 15,
          value: 12,
          easing: "cubic-bezier",
          bezier: [0.22, 1, 0.36, 1],
        },
        { property: "x", frame: 45, value: 100, easing: "linear" },
      ],
    };
    p.clips = [clip];
    const commands = transformCommands(clip, { x: 30 }, 5);
    const saved = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Move",
      commands,
    });
    expect(saved.clips[0].keyframes[0].bezier).toEqual([0.22, 1, 0.36, 1]);
    expect(previewTransform(clip, { x: 30 }, 5).keyframes).toEqual(
      saved.clips[0].keyframes,
    );
  });
});
