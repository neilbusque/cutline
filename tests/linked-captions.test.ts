import { describe, expect, it } from "vitest";
import {
  makeClip,
  newProject,
  validateProject,
  type Project,
} from "../src/shared/model";
import {
  linkedCaptionCommands,
  retimedClipCommands,
} from "../src/shared/linked-captions";
import { applyAgentEdit } from "../src/shared/agent-edit";
import { applyCommands, type Command } from "../src/shared/commands";
import { buildCaptionClips } from "../src/shared/caption-grouping";
import { toSrt } from "../src/shared/subtitles";

const fake = (clips: object[]) => ({ clips }) as unknown as Project;

describe("linked captions follow manual moves and trims", () => {
  it("shifts linked captions by the move distance", () => {
    const p = fake([
      { id: "a", start: 40, duration: 20, captionSourceId: "v" },
      { id: "b", start: 80, duration: 20, captionSourceId: "v" },
      { id: "x", start: 40, duration: 20, captionSourceId: "other" },
    ]);
    expect(
      linkedCaptionCommands(
        p,
        { id: "v", start: 30, duration: 120 },
        { start: 60, duration: 120 },
        "move",
      ),
    ).toEqual([
      { type: "clip.update", id: "a", patch: { start: 70 } },
      { type: "clip.update", id: "b", patch: { start: 110 } },
    ]);
  });

  it("removes captions a trim leaves outside the clip", () => {
    const p = fake([
      { id: "a", start: 40, duration: 20, captionSourceId: "v" },
      { id: "b", start: 130, duration: 15, captionSourceId: "v" },
    ]);
    expect(
      linkedCaptionCommands(
        p,
        { id: "v", start: 30, duration: 120 },
        { start: 30, duration: 90 },
        "trim",
      ),
    ).toEqual([{ type: "clip.delete", id: "b", ripple: false }]);
  });

  it("cuts a caption that straddles the new edge to the clip", () => {
    const p = newProject();
    const text = p.tracks.find((t) => t.kind === "text")!;
    const caption = {
      ...makeClip(p, "caption", text.id, 100),
      id: "cap",
      duration: 40,
      captionSourceId: "v",
    };
    p.clips = [caption];
    const [command] = linkedCaptionCommands(
      p,
      { id: "v", start: 0, duration: 200 },
      { start: 0, duration: 120 },
      "trim",
    );
    expect(command.type).toBe("clip.update");
    if (command.type !== "clip.update") return;
    expect(command.patch.start).toBe(100);
    expect(command.patch.duration).toBe(20);
  });

  it("removes a caption whose words a trim leaves out, so no blank cue is exported", () => {
    // 30 fps: "Hey you" is spoken in frames 0 to 15 of a cue that ends at 19.
    const p = newProject();
    p.assets = [
      {
        id: "talk",
        name: "Talk",
        kind: "video",
        path: "/local/talk.mp4",
        duration: 20,
        hasAudio: true,
      },
    ];
    const video = {
      ...makeClip(p, "video", "video", 0, p.assets[0]),
      id: "v",
      duration: 300,
    };
    const spoken = {
      ...makeClip(p, "caption", "captions", 0),
      id: "early",
      duration: 19,
      captionSourceId: "v",
      text: "Hey you",
      words: [
        { text: "Hey", start: 0, end: 0.25 },
        { text: "you", start: 0.27, end: 0.5 },
      ],
    };
    const later = {
      ...makeClip(p, "caption", "captions", 19),
      id: "later",
      duration: 40,
      captionSourceId: "v",
      text: "over here",
      words: [
        { text: "over", start: 0.1, end: 0.6 },
        { text: "here", start: 0.7, end: 1.2 },
      ],
    };
    p.clips = [video, spoken, later];
    const commands = linkedCaptionCommands(
      p,
      video,
      { start: 16, duration: 284 },
      "trim",
    );
    expect(commands).toEqual([
      { type: "clip.delete", id: "early", ripple: false },
    ]);
    // The agent's clip.trim follows the same rule.
    const trimmed = applyAgentEdit(validateProject(p), {
      projectId: p.id,
      revision: p.revision,
      label: "Trim head",
      actions: [{ type: "clip.trim", clipId: "v", start: { frame: 16 } }],
    }).project;
    expect(trimmed.clips.map((c) => c.id)).toEqual(["v", "later"]);
    // An empty caption never becomes an empty subtitle cue.
    expect(toSrt([{ ...spoken, text: " ", words: [] }, later], p.fps)).toBe(
      "1\n00:00:00,633 --> 00:00:01,967\nover here\n",
    );
  });

  it("does nothing for clips without captions", () => {
    expect(
      linkedCaptionCommands(
        fake([]),
        { id: "v", start: 0, duration: 10 },
        { start: 5, duration: 10 },
        "move",
      ),
    ).toEqual([]);
  });
});

describe("captions stay on the speech when a clip's speed or source in changes", () => {
  // 30 fps, a 20 s talk: word i is spoken from 0.5 i + 0.05 s to 0.5 i + 0.4 s.
  const spoken = Array.from({ length: 40 }, (_, i) => ({
    text: `w${i}`,
    start: i * 0.5 + 0.05,
    end: i * 0.5 + 0.4,
  }));
  function talk() {
    const p = newProject();
    p.assets = [
      {
        id: "talk",
        name: "Talk",
        kind: "video",
        path: "/local/talk.mp4",
        duration: 30,
        hasAudio: true,
        words: spoken,
      },
    ];
    const video = {
      ...makeClip(p, "video", "video", 30, p.assets[0]),
      id: "v",
      duration: 600,
      keyframes: [
        // A punch-in on the word spoken at 10 s of source.
        {
          property: "scale" as const,
          frame: 300,
          value: 1.2,
          easing: "hold" as const,
        },
      ],
    };
    p.clips = [
      video,
      ...buildCaptionClips(p, spoken, {
        startFrame: 30,
        sourceId: "v",
        trackId: "captions",
      }),
    ];
    return validateProject(p);
  }
  /** Where each caption shows its words, against where the voice says them. */
  function drift(p: Project) {
    const v = p.clips.find((c) => c.id === "v")!;
    const heard = (source: number) =>
      v.start / p.fps + (source - v.sourceIn) / v.speed;
    return p.clips
      .filter((c) => c.captionSourceId === "v")
      .flatMap((c) =>
        c.words.map((word) => {
          const said = spoken.find((w) => w.text === word.text)!;
          return Math.abs(c.start / p.fps + word.start - heard(said.start));
        }),
      );
  }
  const apply = (p: Project, commands: Command[]) =>
    applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Adjust clip",
      commands,
    });

  it("keeps every caption on its word at 2x, inside the faster clip", () => {
    const p = talk();
    expect(Math.max(...drift(p))).toBeLessThan(1 / 30);
    const v = p.clips.find((c) => c.id === "v")!;
    const fast = apply(
      p,
      retimedClipCommands(p, v, { speed: 2, duration: 300 }),
    );
    expect(Math.max(...drift(fast))).toBeLessThan(1.5 / 30);
    const captions = fast.clips.filter((c) => c.captionSourceId === "v");
    expect(captions.flatMap((c) => c.words.map((w) => w.text))).toEqual(
      spoken.map((w) => w.text),
    );
    for (const c of captions)
      expect(c.start + c.duration).toBeLessThanOrEqual(330);
    // The punch-in stays on its word: source 10 s now plays 5 s into the clip.
    expect(fast.clips.find((c) => c.id === "v")!.keyframes[0].frame).toBe(150);
  });

  it("moves captions with a new source in and drops the words no longer in the clip", () => {
    const p = talk();
    const v = p.clips.find((c) => c.id === "v")!;
    const slipped = apply(p, retimedClipCommands(p, v, { sourceIn: 2 }));
    expect(Math.max(...drift(slipped))).toBeLessThan(1.5 / 30);
    const texts = slipped.clips
      .filter((c) => c.captionSourceId === "v")
      .flatMap((c) => c.words.map((w) => w.text));
    // Source 2 s to 22 s: the first four words are gone, the rest remain.
    expect(texts[0]).toBe("w4");
    expect(texts.at(-1)).toBe("w39");
  });

  it("does the same for an agent's clip.update, and leaves moves and trims alone", () => {
    const p = talk();
    const fast = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Speed up",
      actions: [
        {
          type: "clip.update",
          clipId: "v",
          patch: { speed: 1.25, duration: 480 },
        },
      ],
    }).project;
    expect(Math.max(...drift(fast))).toBeLessThan(1.5 / 30);
    const v = p.clips.find((c) => c.id === "v")!;
    // A head trim changes start and source in together: nothing to retime.
    expect(
      retimedClipCommands(p, v, { start: 60, sourceIn: 1, duration: 570 }),
    ).toEqual([
      {
        type: "clip.update",
        id: "v",
        patch: { start: 60, sourceIn: 1, duration: 570 },
      },
    ]);
  });
});
