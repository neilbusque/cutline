import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CaptionText } from "../src/composition/CaptionText";
import { newProject, validateProject, type Word } from "../src/shared/model";
import { applyCommands } from "../src/shared/commands";
import {
  buildCaptionClips,
  captionPaceOf,
  groupCaptionWords,
  regroupCaptionCommands,
} from "../src/shared/caption-grouping";
import { captionStylePatch, captionStyles } from "../src/shared/caption-styles";
import { applyAgentEdit } from "../src/shared/agent-edit";

const sentence = (text: string, from = 0, each = 0.32): Word[] =>
  text.split(" ").map((word, i) => ({
    text: word,
    start: from + i * each,
    end: from + i * each + each - 0.02,
  }));
const speech = [
  ...sentence("I just built a free tool that deletes every trace of AI slop."),
  ...sentence("It is open source and on GitHub right now.", 4.6),
];

describe("creator caption looks", () => {
  it("short pace keeps every word, in order, one to three words per caption", () => {
    const groups = groupCaptionWords(speech, 30, "short");
    expect(groups.flat().map((w) => w.text)).toEqual(speech.map((w) => w.text));
    expect(Math.max(...groups.map((g) => g.length))).toBeLessThanOrEqual(3);
    const average = speech.length / groups.length;
    expect(average).toBeGreaterThanOrEqual(1.6);
    expect(average).toBeLessThanOrEqual(3);
    expect(groupCaptionWords(speech, 30).every((g) => g.length <= 7)).toBe(
      true,
    );
  });

  it("regroups captions into short chunks and back without losing timing or look", () => {
    let p = newProject();
    const captions = buildCaptionClips(p, speech, { style: "pill" }).map(
      (c) => ({
        ...c,
        accent: "#123456",
        y: 900,
      }),
    );
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Captions",
      commands: captions.map((clip) => ({ type: "clip.add", clip })),
    });
    expect(captionPaceOf(p.clips)).toBe("phrases");
    const short = regroupCaptionCommands(p, p.clips, "short");
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Short",
      commands: short.commands,
    });
    const after = p.clips.filter((c) => c.kind === "caption");
    expect(captionPaceOf(after)).toBe("short");
    expect(after.length).toBe(short.count);
    expect(
      after.every(
        (c) =>
          c.captionStyle === "pill" && c.accent === "#123456" && c.y === 900,
      ),
    ).toBe(true);
    expect(after.every((c) => c.captionMaxLines === 1)).toBe(true);
    // Absolute word times survive the regroup to within a frame.
    const absolute = after
      .sort((a, b) => a.start - b.start)
      .flatMap((c) =>
        c.words.map((w) => [w.text, c.start / 30 + w.start] as const),
      );
    absolute.forEach(([text, time], i) => {
      expect(text).toBe(speech[i].text);
      expect(Math.abs(time - speech[i].start)).toBeLessThan(1 / 30 + 1e-6);
    });
    expect(validateProject(JSON.parse(JSON.stringify(p))).clips).toHaveLength(
      after.length,
    );
  });

  it("assistants can switch caption pace with caption.style", () => {
    let p = newProject();
    const captions = buildCaptionClips(p, speech);
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Captions",
      commands: captions.map((clip) => ({ type: "clip.add", clip })),
    });
    const result = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Jack captions",
      actions: [
        {
          type: "caption.style",
          clipIds: captions.map((c) => c.id),
          style: "pill",
          pace: "short",
        },
      ],
    } as any);
    const after = result.project.clips.filter((c) => c.kind === "caption");
    expect(captionPaceOf(after)).toBe("short");
    expect(after.every((c) => c.captionStyle === "pill" && !c.highlight)).toBe(
      true,
    );
  });

  it("Pill, Clean and Heavy are no-highlight looks, and highlight off never colors the spoken word", () => {
    const p = { ...newProject(), width: 1080, height: 1920 };
    for (const id of ["pill", "clean", "heavy"] as const) {
      expect(captionStyles.some((s) => s.id === id)).toBe(true);
      expect(captionStylePatch(id, p).highlight).toBe(false);
    }
    const [clip] = buildCaptionClips(p, sentence("Make every word matter"), {
      style: "karaoke",
    });
    const frame = Math.round(0.4 * 30);
    const on = renderToStaticMarkup(
      React.createElement(CaptionText, { clip, frame, fps: 30 }),
    );
    const off = renderToStaticMarkup(
      React.createElement(CaptionText, {
        clip: { ...clip, highlight: false },
        frame,
        fps: 30,
      }),
    );
    expect(on).toContain('data-active="true"');
    expect(off).not.toContain('data-active="true"');
    expect(off).not.toContain(clip.accent);
    const pill = renderToStaticMarkup(
      React.createElement(CaptionText, {
        clip: { ...clip, ...captionStylePatch("pill", p) },
        frame,
        fps: 30,
      }),
    );
    expect(pill).toContain("#3c3c3ccc");
  });
});
