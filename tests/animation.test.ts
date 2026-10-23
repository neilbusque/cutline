import { expect, it } from "vitest";
import { makeClip, newProject } from "../src/shared/model";
import { animatedValue, eased } from "../src/shared/animation";
import { applyCommands } from "../src/shared/commands";
import { trimClip } from "../src/shared/timeline";
function fixture() {
  const p = newProject();
  p.clips = [makeClip(p, "text", "titles", 0)];
  return p;
}
function keys(p = fixture()) {
  return applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Animate",
    commands: [
      {
        type: "clip.keyframe",
        id: p.clips[0].id,
        property: "x",
        frame: 0,
        value: 0,
        easing: "linear",
      },
      {
        type: "clip.keyframe",
        id: p.clips[0].id,
        property: "x",
        frame: 100,
        value: 100,
        easing: "linear",
      },
    ],
  });
}
it("evaluates exact endpoints and interpolates without mutating base state", () => {
  const c = keys().clips[0];
  expect([0, 25, 100, 110].map((f) => animatedValue(c, "x", f))).toEqual([
    0, 25, 100, 100,
  ]);
  expect(c.x).toBe(0);
});
it("easing curves and hold have deterministic bounds", () => {
  expect(eased(0.25, "ease-in")).toBe(0.0625);
  expect(eased(0.5, "ease-in-out")).toBe(0.5);
  expect(eased(0.8, "hold")).toBe(0);
});
it("split preserves evaluated values and animation phase on both halves", () => {
  const p = keys();
  const n = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Split",
    commands: [{ type: "clip.split", id: p.clips[0].id, frame: 50 }],
  });
  expect(animatedValue(n.clips[1], "x", 25)).toBe(75);
  expect(animatedValue(n.clips[0], "x", 25)).toBe(25);
});
it("left trim preserves phase and right trim does not retime curves", () => {
  const p = keys();
  expect(animatedValue(trimClip(p, p.clips[0], "left", 30), "x", 10)).toBe(40);
  expect(animatedValue(trimClip(p, p.clips[0], "right", 60), "x", 25)).toBe(25);
});
it("rejects invalid property values and duplicate curve frames atomically", () => {
  const p = fixture();
  expect(() =>
    applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "bad",
      commands: [
        {
          type: "clip.keyframe",
          id: p.clips[0].id,
          property: "opacity",
          frame: 0,
          value: 2,
        },
      ],
    }),
  ).toThrow();
  expect(p.clips[0].keyframes).toEqual([]);
});
it("updates one key without overwriting other curves; remove restores static property", () => {
  let p = keys();
  p = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "upsert",
    commands: [
      {
        type: "clip.keyframe",
        id: p.clips[0].id,
        property: "x",
        frame: 0,
        value: 20,
      },
    ],
  });
  expect(p.clips[0].keyframes).toHaveLength(2);
  expect(animatedValue(p.clips[0], "x", 0)).toBe(20);
});
