import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import { animatedValue } from "../src/shared/animation";
import { makeClip, newProject, type Clip } from "../src/shared/model";
import {
  relocateClipKey,
  retimeClipKeys,
  visibleClipKeys,
} from "../src/shared/clip-keyframe-edit";

function fixture(): Clip {
  const project = newProject();
  return {
    ...makeClip(project, "text", "titles", 40),
    duration: 60,
    animationOffset: 30,
    keyframes: [
      { property: "x", frame: 0, value: -100, easing: "ease-in" },
      {
        property: "x",
        frame: 30,
        value: 0,
        easing: "cubic-bezier",
        bezier: [0.16, 1, 0.3, 1],
      },
      { property: "opacity", frame: 30, value: 0.5, easing: "linear" },
      { property: "x", frame: 45, value: 40, easing: "linear" },
      { property: "x", frame: 60, value: 100, easing: "back" },
      { property: "opacity", frame: 89, value: 1, easing: "linear" },
      { property: "x", frame: 90, value: 120, easing: "ease-out" },
    ],
  };
}

describe("clip keyframe editing", () => {
  it("uses the visible trim window and retains original saved frame positions", () => {
    const c = fixture();
    expect(visibleClipKeys(c, "x").map((key) => key.frame)).toEqual([
      30, 45, 60,
    ]);
    expect(visibleClipKeys(c, "rotation")).toEqual([]);
  });

  it("moves only the selected property, preserving trim phase, sibling curves and custom handles", () => {
    const c = fixture();
    const before = structuredClone(c);
    const result = relocateClipKey(c, "x", 30, 10);
    expect(result.error).toBeUndefined();
    const moved = { ...c, keyframes: result.keyframes! };
    expect(moved.animationOffset).toBe(30);
    expect(
      moved.keyframes.find((key) => key.property === "x" && key.frame === 40),
    ).toEqual({
      property: "x",
      frame: 40,
      value: 0,
      easing: "cubic-bezier",
      bezier: [0.16, 1, 0.3, 1],
    });
    expect(moved.keyframes.filter((key) => key.property === "opacity")).toEqual(
      c.keyframes.filter((key) => key.property === "opacity"),
    );
    expect(
      [0, 12, 34, 59].map((frame) => animatedValue(moved, "opacity", frame)),
    ).toEqual(
      [0, 12, 34, 59].map((frame) => animatedValue(c, "opacity", frame)),
    );
    expect(c).toEqual(before);
    result.keyframes!.find((key) => key.bezier)!.bezier![1] = 0;
    expect(c.keyframes[1].bezier).toEqual([0.16, 1, 0.3, 1]);
  });

  it("duplicates at clip-relative playhead time without removing the source", () => {
    const c = fixture();
    const result = relocateClipKey(c, "x", 30, 59, true);
    expect(result.keyframes).toHaveLength(c.keyframes.length + 1);
    expect(
      result.keyframes!.filter(
        (key) => key.property === "x" && [30, 89].includes(key.frame),
      ),
    ).toHaveLength(2);
    expect(
      result.keyframes!.find((key) => key.property === "x" && key.frame === 89)
        ?.bezier,
    ).toEqual([0.16, 1, 0.3, 1]);
  });

  it("rejects destination collisions, hidden sources, invalid frames and capacity growth without changing the clip", () => {
    const c = fixture();
    const before = structuredClone(c);
    for (const frame of [-1, 0.5, 60, NaN, Infinity])
      expect(relocateClipKey(c, "x", 30, frame).error).toBeTruthy();
    expect(relocateClipKey(c, "x", 30, 15).error).toContain(
      "already has a key",
    );
    expect(relocateClipKey(c, "x", 30, 0, true).error).toContain(
      "already has a key",
    );
    expect(relocateClipKey(c, "x", 0, 5).error).toContain("inside this clip");
    expect(relocateClipKey(c, "x", 90, 5).error).toContain("inside this clip");
    expect(relocateClipKey(c, "x", 30, 0).keyframes).toBe(c.keyframes);
    const full = {
      ...c,
      keyframes: Array.from({ length: 2000 }, (_, index) => ({
        property: "x" as const,
        frame: index,
        value: 0,
        easing: "linear" as const,
      })),
    };
    full.duration = 3000;
    expect(relocateClipKey(full, "x", 30, 2000, true).error).toContain("2,000");
    expect(c).toEqual(before);
  });

  it("retimes visible keys in one transaction while preserving hidden handles and sibling animation", () => {
    const c = fixture();
    const before = structuredClone(c);
    const result = retimeClipKeys(c, "x", 5, 55);
    expect(result.error).toBeUndefined();
    expect(
      result
        .keyframes!.filter((key) => key.property === "x")
        .map((key) => key.frame),
    ).toEqual([0, 35, 60, 85, 90]);
    expect(result.keyframes!.find((key) => key.frame === 35)?.bezier).toEqual([
      0.16, 1, 0.3, 1,
    ]);
    expect(
      result.keyframes!.filter((key) => key.property === "opacity"),
    ).toEqual(c.keyframes.filter((key) => key.property === "opacity"));
    const project = newProject();
    project.clips = [c];
    const updated = applyCommands(project, {
      projectId: project.id,
      revision: project.revision,
      label: "Retime",
      commands: [
        {
          type: "clip.update",
          id: c.id,
          patch: { keyframes: result.keyframes },
        },
      ],
    });
    expect(updated.revision).toBe(project.revision + 1);
    expect(updated.clips[0].animationOffset).toBe(30);
    expect(animatedValue(updated.clips[0], "x", 5)).toBe(0);
    expect(animatedValue(updated.clips[0], "x", 30)).toBe(40);
    expect(animatedValue(updated.clips[0], "x", 55)).toBe(100);
    expect(c).toEqual(before);
  });

  it("rejects compressed retimes that would merge keys or use an invalid range", () => {
    const c = fixture();
    for (const [start, end] of [
      [0, 1],
      [5, 5],
      [15, 5],
      [-1, 20],
      [0, 60],
      [0.5, 20],
      [0, NaN],
    ]) {
      expect(retimeClipKeys(c, "x", start, end).error).toBeTruthy();
    }
    expect(retimeClipKeys(c, "rotation", 0, 59).error).toContain(
      "at least two",
    );
    const nearLimit = { ...c, animationOffset: 863980 };
    nearLimit.keyframes = [
      { property: "x", frame: 863980, value: 0, easing: "linear" },
      { property: "x", frame: 863990, value: 10, easing: "linear" },
    ];
    expect(retimeClipKeys(nearLimit, "x", 0, 40).error).toBeTruthy();
    expect(relocateClipKey(nearLimit, "x", 863980, 40).error).toBeTruthy();
  });
});
