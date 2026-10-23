import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Thumbnail } from "@remotion/player";
import { describe, expect, it } from "vitest";
import {
  ClipSchema,
  makeClip,
  newProject,
  validateProject,
  type Project,
} from "../src/shared/model";
import { applyAgentEdit } from "../src/shared/agent-edit";
import { applyCommands } from "../src/shared/commands";
import { animatedValue, evaluatedClip } from "../src/shared/animation";
import { filterFor } from "../src/shared/effects";
import { trimClip } from "../src/shared/timeline";
import { Film } from "../src/composition/Video";
import { RgbSplit } from "../src/composition/RgbSplit";

const fixture = () => {
  const p = newProject();
  p.clips = [
    {
      ...makeClip(p, "text", "titles", 0),
      id: "title",
      text: "MOVE BOLDLY",
      duration: 120,
    },
  ];
  return p;
};
const animate = (p: Project) =>
  applyAgentEdit(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Promo accent",
    actions: [
      {
        type: "clip.keyframe",
        clipId: "title",
        property: "rgbSplit",
        frame: 0,
        value: 12,
        easing: "hold",
      },
      {
        type: "clip.keyframe",
        clipId: "title",
        property: "rgbSplit",
        frame: 6,
        value: 0,
        easing: "hold",
      },
      {
        type: "clip.keyframe",
        clipId: "title",
        property: "invert",
        frame: 0,
        value: 0,
        easing: "hold",
      },
      {
        type: "clip.keyframe",
        clipId: "title",
        property: "invert",
        frame: 60,
        value: 1,
        easing: "hold",
      },
    ],
  }).project;
const markup = (project: Project, frame: number, preview: boolean) =>
  renderToStaticMarkup(
    React.createElement(Thumbnail, {
      component: Film as React.ComponentType<Record<string, unknown>>,
      inputProps: { project, mediaBase: "", preview },
      compositionWidth: project.width,
      compositionHeight: project.height,
      fps: project.fps,
      durationInFrames: 120,
      frameToDisplay: frame,
    }),
  );

describe("editable promo effects", () => {
  it("loads earlier projects neutrally and preserves new fields through save/reload and unrelated edits", () => {
    const p = fixture();
    const old = { ...p.clips[0] } as Partial<(typeof p.clips)[0]>;
    delete old.rgbSplit;
    delete old.invert;
    expect(ClipSchema.parse(old)).toMatchObject({ rgbSplit: 0, invert: 0 });
    p.clips[0].rgbSplit = 7;
    p.clips[0].invert = 0.25;
    const next = applyCommands(validateProject(JSON.parse(JSON.stringify(p))), {
      projectId: p.id,
      revision: p.revision,
      label: "Rename",
      commands: [
        { type: "clip.update", id: "title", patch: { text: "New title" } },
      ],
    });
    expect(next.clips[0]).toMatchObject({
      rgbSplit: 7,
      invert: 0.25,
      text: "New title",
    });
  });
  it("keeps crisp accent endpoints, clean holds and exact split/trim phase", () => {
    const p = animate(fixture()),
      c = p.clips[0];
    expect(
      [0, 5, 6, 59, 119].map((f) => animatedValue(c, "rgbSplit", f)),
    ).toEqual([12, 12, 0, 0, 0]);
    expect([59, 60, 119].map((f) => animatedValue(c, "invert", f))).toEqual([
      0, 1, 1,
    ]);
    const split = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Split",
      commands: [{ type: "clip.split", id: "title", frame: 3 }],
    });
    const right = split.clips.find((c) => c.start === 3)!;
    expect(animatedValue(right, "rgbSplit", 2)).toBe(12);
    expect(animatedValue(right, "rgbSplit", 3)).toBe(0);
    expect(animatedValue(right, "invert", 57)).toBe(1);
    expect(animatedValue(trimClip(p, c, "left", 55), "invert", 5)).toBe(1);
  });
  it("rejects invalid amounts without mutating the source transaction", () => {
    const p = fixture(),
      before = JSON.stringify(p);
    for (const [property, value] of [
      ["rgbSplit", 31],
      ["rgbSplit", -1],
      ["invert", 1.1],
      ["invert", NaN],
    ] as const) {
      expect(() =>
        applyAgentEdit(p, {
          projectId: p.id,
          revision: p.revision,
          label: "Invalid",
          actions: [
            {
              type: "clip.keyframe",
              clipId: "title",
              property,
              frame: 0,
              value,
            },
          ],
        }),
      ).toThrow();
    }
    expect(JSON.stringify(p)).toBe(before);
  });
  it("uses the same frame-driven filter for preview and export, and returns to neutral", () => {
    const p = animate(fixture());
    for (const preview of [false, true]) {
      const active = markup(p, 2, preview),
        held = markup(p, 30, preview),
        inverted = markup(p, 70, preview);
      expect(active).toContain('dx="12"');
      expect(active).toContain('dx="-12"');
      expect(held).not.toContain("feColorMatrix");
      expect(inverted).toContain("invert(1)");
      expect((active.match(/MOVE BOLDLY/g) ?? []).length).toBe(1);
    }
    expect(filterFor(evaluatedClip(p.clips[0], 30))).toBe("none");
  });
  it("filters a single source and isolates simultaneous previews", () => {
    const tree = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(RgbSplit, {
          amount: 4,
          children: React.createElement("video", { src: "one.mp4" }),
        }),
        React.createElement(RgbSplit, {
          amount: 9,
          children: React.createElement("img", { src: "two.png" }),
        }),
      ),
    );
    expect((tree.match(/<video/g) ?? []).length).toBe(1);
    const ids = [...tree.matchAll(/<filter id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(tree).toContain(`url(#${id})`);
  });
});
