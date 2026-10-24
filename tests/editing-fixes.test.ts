import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { applyAgentEdit } from "../src/shared/agent-edit";
import { animatedValue } from "../src/shared/animation";
import { applyCommands, removePauses } from "../src/shared/commands";
import {
  AssetSchema,
  ClipSchema,
  MotionSchema,
  makeClip,
  newProject,
  validateProject,
  type Clip,
  type Project,
  type Word,
} from "../src/shared/model";
import { musicBindings, musicResponse } from "../src/shared/music-reactive";
import { manualBeatGrid } from "../src/shared/music-sync";
import { trimClip } from "../src/shared/timeline";
import { activeTransition } from "../src/shared/transitions";
import { presetTiming } from "../src/shared/text-presets";

const tx = (p: Project, commands: unknown[]) =>
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Test edit",
    commands,
  });
const byId = (p: Project, id: string) => {
  const found = p.clips.find((c) => c.id === id);
  if (!found) throw Error(`Missing clip ${id}`);
  return found;
};
const media = (
  id: string,
  kind: "video" | "audio" | "image" = "video",
  duration = 20,
) =>
  AssetSchema.parse({
    id: `file-${id}`,
    name: id,
    kind,
    path: `/local/${id}`,
    duration,
    hasAudio: kind !== "image",
  });
const caption = (
  id: string,
  start: number,
  duration: number,
  words: Word[],
  extra: Partial<Clip> = {},
) =>
  ClipSchema.parse({
    id,
    kind: "caption",
    trackId: "captions",
    start,
    duration,
    text: words.map((w) => w.text).join(" "),
    words,
    ...extra,
  });
const scaleKeys = (pairs: [number, number][]) =>
  pairs.map(([frame, value]) => ({
    property: "scale" as const,
    frame,
    value,
    easing: "linear" as const,
  }));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const tempDir = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cutline-editing-"));
  directories.push(directory);
  return directory;
};

/** A 10s talking head with linked captions, a crossfaded neighbour, B-roll, titles and music. */
function talkingHead() {
  const p = newProject();
  p.tracks.splice(2, 0, {
    id: "broll",
    name: "B-roll",
    kind: "video",
    muted: false,
    hidden: false,
  });
  p.tracks.unshift({
    id: "subs",
    name: "Imported subtitles",
    kind: "text",
    muted: false,
    hidden: false,
  });
  p.assets = [
    media("talk"),
    media("next"),
    media("after"),
    media("cutaway", "video", 10),
    media("song", "audio", 30),
  ];
  p.clips = [
    {
      ...makeClip(p, "video", "video", 0, p.assets[0]),
      id: "v",
      duration: 300,
      fadeIn: 15,
      fadeOut: 20,
      keyframes: scaleKeys([
        [0, 1],
        [299, 1.3],
      ]),
    },
    {
      ...makeClip(p, "video", "video", 290, p.assets[1]),
      id: "w",
      duration: 100,
      transition: { kind: "crossfade", frames: 10, fromId: "v" },
    },
    {
      ...makeClip(p, "video", "video", 390, p.assets[2]),
      id: "x",
      duration: 60,
    },
    caption("early", 10, 20, [{ text: "early", start: 0, end: 0.6 }], {
      captionSourceId: "v",
    }),
    caption(
      "across",
      40,
      120,
      [
        { text: "before", start: 0, end: 0.5 },
        { text: "after", start: 3.6, end: 4 },
      ],
      { captionSourceId: "v", fadeIn: 4, fadeOut: 6 },
    ),
    caption(
      "late",
      200,
      30,
      [
        { text: "later", start: 0, end: 0.5 },
        { text: "words", start: 0.5, end: 1 },
      ],
      { captionSourceId: "v" },
    ),
    caption(
      "srt",
      55,
      120,
      [
        { text: "one", start: 0, end: 0.2 },
        { text: "two", start: 3.2, end: 4 },
      ],
      { trackId: "subs" },
    ),
    {
      ...makeClip(p, "video", "broll", 180, p.assets[3]),
      id: "cutaway",
      duration: 60,
    },
    { ...makeClip(p, "text", "titles", 50), id: "lead-title", duration: 40 },
    { ...makeClip(p, "text", "titles", 100), id: "pause-title", duration: 30 },
    {
      ...makeClip(p, "audio", "audio", 0, p.assets[4]),
      id: "music",
      duration: 450,
    },
  ];
  return validateProject(p);
}
// Silence from 2s to 5s becomes a cut of local frames [63, 147): 84 frames.
const pause = [{ start: 2, end: 5 }];

describe("remove pauses keeps everything attached to the speech", () => {
  const run = () => {
    const p = talkingHead();
    const next = tx(p, removePauses(p, "v", pause));
    const tail = next.clips.find(
      (c) => c.assetId === "file-talk" && c.id !== "v",
    )!;
    return { p, next, tail };
  };

  it("keeps fades on the outer ends, keyframe phase and the first segment's identity", () => {
    const { p, next, tail } = run();
    expect(byId(next, "v")).toMatchObject({
      start: 0,
      duration: 63,
      sourceIn: 0,
      fadeIn: 15,
      fadeOut: 0,
      animationOffset: 0,
    });
    expect(tail).toMatchObject({
      start: 63,
      duration: 153,
      fadeIn: 0,
      fadeOut: 20,
      animationOffset: 147,
    });
    expect(tail.transition).toBeUndefined();
    expect(tail.sourceIn).toBeCloseTo(147 / 30, 10);
    // The zoom continues from where the kept footage was, with no jump.
    expect(animatedValue(tail, "scale", 0)).toBeCloseTo(
      animatedValue(byId(p, "v"), "scale", 147),
      10,
    );
    expect(animatedValue(byId(next, "v"), "scale", 62)).toBeCloseTo(
      animatedValue(byId(p, "v"), "scale", 62),
      10,
    );
  });

  it("closes up the crossfaded neighbour and everything after it without gaps or overlaps", () => {
    const { next, tail } = run();
    const w = byId(next, "w");
    expect(w.start).toBe(206);
    expect(w.transition?.fromId).toBe(tail.id);
    expect(activeTransition(next, w)).toMatchObject({
      frames: 10,
      previous: { id: tail.id },
    });
    expect(byId(next, "x").start).toBe(306);
  });

  it("re-times linked captions, splitting the one that crosses the cut", () => {
    const { next, tail } = run();
    expect(byId(next, "early")).toMatchObject({
      start: 10,
      duration: 20,
      captionSourceId: "v",
    });
    expect(byId(next, "late")).toMatchObject({
      start: 116,
      duration: 30,
      captionSourceId: tail.id,
      text: "later words",
    });
    expect(byId(next, "across")).toMatchObject({
      start: 40,
      duration: 23,
      captionSourceId: "v",
      text: "before",
      fadeIn: 4,
      fadeOut: 0,
    });
    const after = next.clips.find(
      (c) => c.kind === "caption" && c.text === "after",
    )!;
    expect(after).toMatchObject({
      start: 63,
      duration: 13,
      captionSourceId: tail.id,
      fadeIn: 0,
      fadeOut: 6,
    });
    expect(after.words[0].start).toBeCloseTo(1 / 30, 10);
    expect(after.words[0].end).toBeCloseTo(13 / 30, 10);
    expect(
      next.clips.filter((c) => c.kind === "caption" && c.captionSourceId),
    ).toHaveLength(4);
  });

  it("moves B-roll, titles, imported subtitles and music with the speech", () => {
    const { next } = run();
    expect(byId(next, "cutaway")).toMatchObject({ start: 96, duration: 60 });
    expect(byId(next, "lead-title")).toMatchObject({ start: 50, duration: 13 });
    // A title that only sat inside the removed pause is kept, at the cut.
    expect(byId(next, "pause-title")).toMatchObject({
      start: 63,
      duration: 30,
    });
    const srt = byId(next, "srt");
    expect(srt).toMatchObject({ start: 55, duration: 36, text: "one two" });
    expect(srt.words[1].start).toBeCloseTo(0.4, 10);
    expect(srt.words[1].end).toBeCloseTo(1.2, 10);
    expect(byId(next, "music")).toMatchObject({ start: 0, duration: 366 });
  });

  it("never cuts into a crossfade at either end of the clip", () => {
    const p = newProject();
    p.assets = [media("a"), media("talk"), media("c")];
    p.clips = [
      {
        ...makeClip(p, "video", "video", 0, p.assets[0]),
        id: "a",
        duration: 100,
      },
      {
        ...makeClip(p, "video", "video", 90, p.assets[1]),
        id: "v",
        duration: 300,
        transition: { kind: "crossfade", frames: 10, fromId: "a" },
      },
      {
        ...makeClip(p, "video", "video", 375, p.assets[2]),
        id: "c",
        duration: 100,
        transition: { kind: "crossfade", frames: 15, fromId: "v" },
      },
    ];
    const silences = [
      { start: 0, end: 1.5 },
      { start: 8.5, end: 10 },
    ];
    const next = tx(p, removePauses(p, "v", silences));
    const v = byId(next, "v");
    expect(v.duration).toBe(11);
    expect(activeTransition(next, v)?.previous.id).toBe("a");
    const c = byId(next, "c");
    const last = next.clips.find((clip) => clip.id === c.transition?.fromId)!;
    expect(last.assetId).toBe("file-talk");
    expect(last.start + last.duration - c.start).toBe(15);
    expect(activeTransition(next, c)?.frames).toBe(15);
  });

  it("shifts captions linked to the clip that sit outside it instead of deleting them", () => {
    const p = talkingHead();
    p.clips.push(
      caption("stray", 470, 20, [{ text: "stray", start: 0, end: 0.5 }], {
        captionSourceId: "v",
      }),
    );
    const next = tx(p, removePauses(p, "v", pause));
    expect(byId(next, "stray")).toMatchObject({
      start: 386,
      captionSourceId: "v",
    });
  });

  it("leaves a clip that is silent from start to end untouched", () => {
    const p = newProject();
    p.assets = [media("talk")];
    p.clips = [
      {
        ...makeClip(p, "video", "video", 0, p.assets[0]),
        id: "v",
        duration: 300,
        sourceIn: 2,
      },
    ];
    expect(removePauses(p, "v", [{ start: 0, end: 30 }])).toEqual([]);
  });

  it("keeps a music pulse working when pauses are removed from the music clip", () => {
    const p = newProject();
    p.assets = [
      {
        ...media("song", "audio", 20),
        rhythm: manualBeatGrid({ bpm: 120, duration: 20 }),
      },
    ];
    const music = {
      ...makeClip(p, "audio", "audio", 0, p.assets[0]),
      id: "music",
      duration: 300,
    };
    const title = {
      ...makeClip(p, "text", "titles", 0),
      id: "title",
      duration: 300,
      musicReactive: {
        musicClipId: "music",
        mode: "beat" as const,
        style: "scale" as const,
        amount: 1,
        releaseFrames: 6,
      },
    };
    p.clips = [music, title];
    const next = tx(p, removePauses(p, "music", [{ start: 2, end: 5 }]));
    const bindings = musicBindings(next);
    const binding = bindings.get("music");
    expect(binding).toBeDefined();
    // Source 6.0s is a beat. It now plays at frame 180 - 84 = 96.
    expect(musicResponse(byId(next, "title"), 96, binding)).toBeGreaterThan(
      0.5,
    );
  });
});

describe("ripple delete respects crossfades", () => {
  function chain(withOutgoing = false) {
    const p = newProject();
    p.assets = [media("a"), media("b"), media("c"), media("d")];
    p.clips = [
      {
        ...makeClip(p, "video", "video", 0, p.assets[0]),
        id: "a",
        duration: 100,
      },
      {
        ...makeClip(p, "video", "video", 90, p.assets[1]),
        id: "b",
        duration: 100,
        transition: { kind: "crossfade", frames: 10, fromId: "a" },
      },
      {
        ...makeClip(p, "video", "video", withOutgoing ? 180 : 190, p.assets[2]),
        id: "c",
        duration: 100,
        ...(withOutgoing
          ? {
              transition: {
                kind: "crossfade" as const,
                frames: 10,
                fromId: "b",
              },
            }
          : {}),
      },
      { ...makeClip(p, "text", "titles", 250), id: "title", duration: 30 },
    ];
    return validateProject(p);
  }
  const ripple = (p: Project, id: string) =>
    tx(p, [{ type: "clip.delete", id, ripple: true }]);

  it("deleting the outgoing clip closes up to the incoming clip", () => {
    const next = ripple(chain(), "a");
    expect(byId(next, "b").start).toBe(0);
    expect(byId(next, "b").transition).toBeUndefined();
    expect(byId(next, "c").start).toBe(100);
    expect(byId(next, "title").start).toBe(160);
  });

  it("deleting the incoming clip butts the next clip against the outgoing one", () => {
    const next = ripple(chain(), "b");
    expect(byId(next, "a")).toMatchObject({ start: 0, duration: 100 });
    expect(byId(next, "c").start).toBe(100);
    expect(byId(next, "title").start).toBe(160);
  });

  it("a plain delete leaves positions alone and drops the dead crossfade", () => {
    const next = tx(chain(), [{ type: "clip.delete", id: "a", ripple: false }]);
    expect(byId(next, "b")).toMatchObject({ start: 90 });
    expect(byId(next, "b").transition).toBeUndefined();
    expect(byId(next, "c").start).toBe(190);
  });

  it("deleting a clip with crossfades on both sides leaves a clean cut", () => {
    const next = ripple(chain(true), "b");
    expect(byId(next, "c").start).toBe(100);
    expect(byId(next, "c").transition).toBeUndefined();
    expect(byId(next, "title").start).toBe(170);
  });
});

describe("deleting a clip removes the captions made from it", () => {
  function fixture() {
    const p = newProject();
    p.assets = [media("a"), media("b")];
    p.clips = [
      {
        ...makeClip(p, "video", "video", 0, p.assets[0]),
        id: "a",
        duration: 100,
      },
      {
        ...makeClip(p, "video", "video", 100, p.assets[1]),
        id: "b",
        duration: 100,
      },
      caption("a1", 10, 30, [{ text: "hi", start: 0, end: 0.5 }], {
        captionSourceId: "a",
      }),
      caption("a2", 50, 40, [{ text: "there", start: 0, end: 0.5 }], {
        captionSourceId: "a",
      }),
      caption("b1", 110, 30, [{ text: "next", start: 0, end: 0.5 }], {
        captionSourceId: "b",
      }),
    ];
    return validateProject(p);
  }

  it("removes linked captions on ripple delete so they never stack on the next clip", () => {
    const next = tx(fixture(), [
      { type: "clip.delete", id: "a", ripple: true },
    ]);
    expect(next.clips.map((c) => c.id).sort()).toEqual(["b", "b1"]);
    expect(byId(next, "b").start).toBe(0);
    expect(byId(next, "b1").start).toBe(10);
  });

  it("keeps them when asked, and treats a later delete of a removed caption as done", () => {
    const kept = tx(fixture(), [
      { type: "clip.delete", id: "a", ripple: false, deleteCaptions: false },
    ]);
    expect(kept.clips.some((c) => c.id === "a1")).toBe(true);
    const all = fixture();
    const cleared = tx(
      all,
      all.clips.map((c) => ({ type: "clip.delete", id: c.id, ripple: false })),
    );
    expect(cleared.clips).toEqual([]);
    expect(() =>
      tx(fixture(), [{ type: "clip.delete", id: "missing", ripple: false }]),
    ).toThrow("Clip no longer exists");
  });

  it("agents can still keep captions when deleting their source", () => {
    const p = fixture();
    const result = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Keep captions",
      actions: [{ type: "clip.delete", clipId: "a", deleteCaptions: false }],
    });
    expect(
      result.project.clips.filter((c) => c.captionSourceId === "a"),
    ).toHaveLength(2);
  });
});

describe("transitions move the captions of the clips they move", () => {
  function fixture() {
    const p = newProject();
    p.assets = [media("a"), media("b"), media("c")];
    p.clips = [
      {
        ...makeClip(p, "video", "video", 0, p.assets[0]),
        id: "a",
        duration: 100,
      },
      {
        ...makeClip(p, "video", "video", 100, p.assets[1]),
        id: "b",
        duration: 100,
      },
      {
        ...makeClip(p, "video", "video", 200, p.assets[2]),
        id: "c",
        duration: 100,
      },
      caption("b1", 120, 30, [{ text: "b", start: 0, end: 0.5 }], {
        captionSourceId: "b",
      }),
      caption("c1", 220, 30, [{ text: "c", start: 0, end: 0.5 }], {
        captionSourceId: "c",
      }),
      caption("free", 260, 20, [{ text: "free", start: 0, end: 0.5 }]),
    ];
    return validateProject(p);
  }
  it("adding and removing a crossfade keeps linked captions on their words", () => {
    const p = fixture();
    const added = tx(p, [
      { type: "clip.transition", id: "b", kind: "crossfade", frames: 15 },
    ]);
    expect(byId(added, "b").start).toBe(85);
    expect(byId(added, "b1").start).toBe(105);
    expect(byId(added, "c1").start).toBe(205);
    expect(byId(added, "free").start).toBe(260);
    const removed = tx(added, [
      { type: "clip.transition", id: "b", kind: "none" },
    ]);
    expect(byId(removed, "b").start).toBe(100);
    expect(byId(removed, "b1").start).toBe(120);
    expect(byId(removed, "c1").start).toBe(220);
  });
});

describe("splitting inside a transition", () => {
  function fixture() {
    const p = newProject();
    p.assets = [media("a"), media("b")];
    p.clips = [
      {
        ...makeClip(p, "video", "video", 0, p.assets[0]),
        id: "a",
        duration: 100,
      },
      {
        ...makeClip(p, "video", "video", 90, p.assets[1]),
        id: "b",
        duration: 100,
        transition: { kind: "crossfade", frames: 10, fromId: "a" },
      },
    ];
    return validateProject(p);
  }
  const split = (p: Project, id: string, frame: number) =>
    tx(p, [{ type: "clip.split", id, frame }]);

  it("refuses a split that would break the crossfade, with a readable reason", () => {
    const p = fixture();
    for (const [id, frame] of [
      ["a", 95],
      ["a", 90],
      ["b", 95],
      ["b", 100],
    ] as const)
      expect(() => split(p, id, frame)).toThrow(/inside a transition/);
  });

  it("still splits either clip outside the crossfade", () => {
    const p = fixture();
    const left = split(p, "a", 50);
    expect(activeTransition(left, byId(left, "b"))?.frames).toBe(10);
    const right = split(p, "b", 101);
    expect(activeTransition(right, byId(right, "b"))?.previous.id).toBe("a");
  });
});

describe("unused motion designs are cleaned up at the limit", () => {
  const motion = (id: string) =>
    MotionSchema.parse({ id, name: id, layers: [{ type: "rectangle" }] });
  function full(referenced: number) {
    const p = newProject();
    p.motions = Array.from({ length: 100 }, (_, i) => motion(`m${i}`));
    p.clips = Array.from({ length: referenced }, (_, i) => ({
      ...makeClip(p, "text", "titles", i * 10),
      id: `clip${i}`,
      duration: 10,
      preset: "custom" as const,
      motionId: `m${99 - i}`,
    }));
    return validateProject(p);
  }

  it("drops the oldest unused design to make room", () => {
    const next = tx(full(10), [{ type: "motion.put", motion: motion("new") }]);
    expect(next.motions).toHaveLength(100);
    expect(next.motions.some((m) => m.id === "m0")).toBe(false);
    expect(next.motions.some((m) => m.id === "m1")).toBe(true);
    expect(next.motions.some((m) => m.id === "new")).toBe(true);
    for (const c of next.clips)
      expect(next.motions.some((m) => m.id === c.motionId)).toBe(true);
  });

  it("keeps a design added in the same edit and explains when every design is in use", () => {
    expect(() =>
      tx(full(100), [{ type: "motion.put", motion: motion("new") }]),
    ).toThrow(/100 motion designs/);
    const p = full(99);
    expect(() =>
      tx(p, [
        { type: "motion.put", motion: motion("one") },
        { type: "motion.put", motion: motion("two") },
      ]),
    ).toThrow(/100 motion designs/);
    const next = tx(p, [{ type: "motion.put", motion: motion("one") }]);
    expect(next.motions.some((m) => m.id === "one")).toBe(true);
    expect(next.motions.some((m) => m.id === "m0")).toBe(false);
  });
});

describe("music pulse after splitting the music", () => {
  it("keeps pulsing on the far side of the cut", () => {
    const p = newProject();
    p.assets = [
      {
        ...media("song", "audio", 20),
        rhythm: manualBeatGrid({ bpm: 120, duration: 20 }),
      },
    ];
    p.clips = [
      {
        ...makeClip(p, "audio", "audio", 0, p.assets[0]),
        id: "music",
        duration: 450,
      },
      {
        ...makeClip(p, "text", "titles", 0),
        id: "title",
        duration: 450,
        musicReactive: {
          musicClipId: "music",
          mode: "beat",
          style: "scale",
          amount: 0.5,
          releaseFrames: 6,
        },
      },
    ];
    const before = validateProject(p);
    const after = tx(before, [{ type: "clip.split", id: "music", frame: 200 }]);
    const frames = [300, 301, 315, 330, 333];
    const response = (q: Project) =>
      frames.map((f) =>
        musicResponse(byId(q, "title"), f, musicBindings(q).get("music")),
      );
    const expected = response(before);
    expect(expected.some((v) => v > 0.5)).toBe(true);
    response(after).forEach((value, i) =>
      expect(value).toBeCloseTo(expected[i], 10),
    );
  });
});

describe("colors render the same in preview and export", () => {
  it("rejects hex colors CSS cannot read in new edits", () => {
    const p = talkingHead();
    for (const bad of ["#fffff", "#fffffff", "#12"])
      expect(() =>
        tx(p, [{ type: "clip.update", id: "v", patch: { color: bad } }]),
      ).toThrow();
    expect(() =>
      tx(p, [{ type: "project.update", patch: { background: "#12345" } }]),
    ).toThrow();
    for (const good of ["#fff", "#ffff", "#ffffff", "#ffffff80", "transparent"])
      expect(
        byId(
          tx(p, [{ type: "clip.update", id: "v", patch: { color: good } }]),
          "v",
        ).color,
      ).toBe(good);
  });

  it("repairs such colors in saved projects instead of refusing to open them", () => {
    const p = JSON.parse(JSON.stringify(talkingHead()));
    p.background = "#10111";
    p.clips[0].color = "#fffff";
    p.clips[0].shadowColor = "#0000000";
    p.motions = [
      {
        id: "m",
        name: "m",
        layers: [
          { type: "rectangle", stroke: "#abcde", gradientColor: "#1234567" },
        ],
      },
    ];
    const loaded = validateProject(p);
    expect(loaded.background).toBe("#101111");
    expect(byId(loaded, "v").color).toBe("#ffffff");
    expect(byId(loaded, "v").shadowColor).toBe("#000000");
    expect(loaded.motions[0].layers[0].stroke).toBe("#abcdee");
    expect(loaded.motions[0].layers[0].gradientColor).toBe("#123456");
    expect(p.clips[0].color).toBe("#fffff");
  });
});

describe("dragging a left edge out keeps keyframes on the footage", () => {
  function fixture() {
    const p = newProject();
    p.assets = [media("talk", "video", 10)];
    const c = {
      ...makeClip(p, "video", "video", 100, p.assets[0]),
      id: "v",
      duration: 60,
      sourceIn: 2,
      keyframes: scaleKeys([
        [0, 1],
        [50, 2],
      ]),
    };
    p.clips = [c];
    return { p: validateProject(p), c };
  }

  it("keeps the curve on the same frames when extending past the original start", () => {
    const { p, c } = fixture();
    const at120 = animatedValue(c, "scale", 20);
    const extended = trimClip(p, c, "left", 70);
    expect(extended).toMatchObject({
      start: 70,
      duration: 90,
      animationOffset: 0,
    });
    expect(extended.sourceIn).toBeCloseTo(1, 10);
    expect(animatedValue(extended, "scale", 120 - 70)).toBeCloseTo(at120, 10);
    expect(extended.keyframes.map((k) => k.frame)).toEqual([30, 80]);
    const { id, ...patch } = extended;
    const next = tx(p, [{ type: "clip.update", id, patch }]);
    expect(byId(next, "v").keyframes.map((k) => k.frame)).toEqual([30, 80]);
  });

  it("uses an existing offset first, then moves the keys by the rest", () => {
    const { p, c } = fixture();
    const trimmed = { ...c, animationOffset: 10 };
    const extended = trimClip(p, trimmed, "left", 70);
    expect(extended.animationOffset).toBe(0);
    expect(extended.keyframes.map((k) => k.frame)).toEqual([20, 70]);
    expect(animatedValue(extended, "scale", 50)).toBeCloseTo(
      animatedValue(trimmed, "scale", 20),
      10,
    );
    // Trimming inward is unchanged.
    expect(trimClip(p, c, "left", 110)).toMatchObject({
      animationOffset: 10,
      keyframes: c.keyframes,
    });
  });

  it("leaves custom motion clips to replay their own animation from the new start", () => {
    const p = newProject();
    p.motions = [
      MotionSchema.parse({
        id: "m",
        name: "m",
        layers: [{ type: "rectangle" }],
      }),
    ];
    const title = {
      ...makeClip(p, "text", "titles", 100),
      preset: "custom" as const,
      motionId: "m",
      keyframes: scaleKeys([
        [0, 1],
        [20, 2],
      ]),
    };
    const extended = trimClip(p, title, "left", 70);
    expect(extended.animationOffset).toBe(0);
    expect(extended.keyframes).toEqual(title.keyframes);
  });
});

describe("clips only go on tracks of their kind", () => {
  it("rejects raw edits that put a clip on the wrong kind of track", () => {
    const p = talkingHead();
    expect(() =>
      tx(p, [
        {
          type: "clip.add",
          clip: { ...byId(p, "cutaway"), id: "stray", trackId: "audio" },
        },
      ]),
    ).toThrow(/cannot go there/);
    expect(() =>
      tx(p, [{ type: "clip.update", id: "v", patch: { trackId: "audio" } }]),
    ).toThrow(/cannot go there/);
    expect(() =>
      tx(p, [{ type: "track.update", id: "video", patch: { kind: "audio" } }]),
    ).toThrow(/cannot go there/);
    expect(() =>
      applyAgentEdit(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Raw",
        actions: [
          {
            type: "command",
            command: {
              type: "clip.update",
              id: "music",
              patch: { trackId: "video" },
            },
          },
        ],
      }),
    ).toThrow(/cannot go there/);
  });

  it("still allows edits to projects that already hold a mismatch, and changing an empty track", () => {
    const p = talkingHead();
    p.clips.find((c) => c.id === "cutaway")!.trackId = "audio";
    const next = tx(p, [
      { type: "clip.update", id: "v", patch: { volume: 0.5 } },
    ]);
    expect(byId(next, "v").volume).toBe(0.5);
    const empty = newProject();
    expect(
      tx(empty, [
        { type: "track.update", id: "titles", patch: { kind: "video" } },
      ]).tracks[0].kind,
    ).toBe("video");
  });
});

describe("projects saved by a newer Cutline", () => {
  const newer = () => {
    const p = JSON.parse(JSON.stringify(talkingHead()));
    p.futureSetting = { mode: "next" };
    p.assets[0].futureAsset = 1;
    p.tracks[0].futureTrack = true;
    p.clips[0].futureClip = { grade: "film" };
    p.clips[0].crop.feather = 3;
    p.clips[1].transition.curve = "bezier";
    p.clips[4].futureCaption = 1;
    p.motions = [
      {
        id: "m",
        name: "m",
        futureMotion: "x",
        layers: [
          {
            type: "rectangle",
            futureLayer: 2,
            keyframes: [{ frame: 0, opacity: 0, futureKey: "spring" }],
          },
        ],
      },
    ];
    return p;
  };

  it("keeps fields it does not know through loading and editing", () => {
    const loaded = validateProject(newer()) as any;
    expect(loaded.futureSetting).toEqual({ mode: "next" });
    expect(loaded.assets[0].futureAsset).toBe(1);
    expect(loaded.tracks[0].futureTrack).toBe(true);
    expect(loaded.clips[0].futureClip).toEqual({ grade: "film" });
    expect(loaded.clips[0].crop.feather).toBe(3);
    expect(loaded.clips[1].transition.curve).toBe("bezier");
    expect(loaded.motions[0].futureMotion).toBe("x");
    expect(loaded.motions[0].layers[0].futureLayer).toBe(2);
    expect(loaded.motions[0].layers[0].keyframes[0].futureKey).toBe("spring");
    const edited = tx(loaded, [
      { type: "clip.update", id: "v", patch: { volume: 0.5 } },
      { type: "clip.split", id: "v", frame: 150 },
    ]) as any;
    expect(edited.futureSetting).toEqual({ mode: "next" });
    expect(edited.clips.filter((c: any) => c.futureClip).length).toBe(2);
    // The caption crossing the split keeps the field on both halves.
    expect(edited.clips.filter((c: any) => c.futureCaption).length).toBe(2);
  });

  it("accepts whole-clip trims and motion edits without losing the newer fields", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "recovery.cutline"));
    const file = path.join(dir, "newer.cutline");
    writeFileSync(file, JSON.stringify({ project: newer() }));
    store.load(file);
    const commit = (label: string, commands: unknown[]) =>
      store.transact({
        projectId: store.project.id,
        revision: store.project.revision,
        label,
        commands,
      });
    // Trim start to playhead sends the whole trimmed clip as its patch.
    const { id, ...patch } = trimClip(
      store.project,
      byId(store.project, "v"),
      "left",
      30,
    );
    commit("Trim start to playhead", [{ type: "clip.update", id, patch }]);
    const trimmed = byId(store.project, "v") as any;
    expect(trimmed.start).toBe(30);
    expect(trimmed.futureClip).toEqual({ grade: "film" });
    const agent = applyAgentEdit(store.project, {
      projectId: store.project.id,
      revision: store.project.revision,
      label: "Agent trim",
      actions: [{ type: "clip.trim", clipId: "v", end: { frame: 200 } }],
    });
    expect((byId(agent.project, "v") as any).futureClip).toEqual({
      grade: "film",
    });
    commit("Edit motion", [
      {
        type: "motion.put",
        motion: { id: "m", name: "Renamed", layers: [{ type: "ellipse" }] },
      },
    ]);
    expect(store.project.motions[0].name).toBe("Renamed");
    expect((store.project.motions[0] as any).futureMotion).toBe("x");
  });

  it("does not let a stray __proto__ key change object prototypes", () => {
    const raw = JSON.parse(
      JSON.stringify(talkingHead()).replace(
        '"id":"v",',
        '"id":"v","__proto__":{"polluted":true},',
      ),
    );
    const loaded = validateProject(raw) as any;
    expect(loaded.clips[0].polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });

  it("round-trips the newer fields through open and autosave", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "recovery.cutline"));
    const file = path.join(dir, "newer.cutline");
    writeFileSync(file, JSON.stringify({ project: newer() }));
    store.load(file);
    store.transact({
      projectId: store.project.id,
      revision: store.project.revision,
      label: "Edit",
      commands: [{ type: "clip.update", id: "v", patch: { opacity: 0.5 } }],
    });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.project.futureSetting).toEqual({ mode: "next" });
    expect(saved.project.clips[0].futureClip).toEqual({ grade: "film" });
  });

  it("refuses to open a newer project format with a clear message and leaves the file alone", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "recovery.cutline"));
    const file = path.join(dir, "v2.cutline");
    const contents = JSON.stringify({ project: { ...newer(), version: 2 } });
    writeFileSync(file, contents);
    expect(() => store.load(file)).toThrow(/newer version of Cutline/);
    expect(readFileSync(file, "utf8")).toBe(contents);
    expect(store.filePath).toBeNull();
  });
});

describe("timing that reads the same at any frame rate", () => {
  it("gives a new title or caption a 0.6 second entrance at 24, 25, 30 and 60 fps", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { ...newProject(), fps };
      for (const kind of ["text", "caption"] as const) {
        const clip = makeClip(p, kind, "titles", 0);
        expect(clip.animationFrames / fps).toBeCloseTo(0.6, 1);
        expect(presetTiming(clip, 0).window).toBe(clip.animationFrames);
      }
      // Media clips keep the schema default.
      expect(makeClip(p, "image", "video", 0).animationFrames).toBe(18);
    }
    expect(makeClip({ ...newProject(), fps: 60 }, "text", "titles").animationFrames).toBe(36);
  });

  it("refuses agent times past the timeline's end in plain words instead of a schema error", () => {
    const p = { ...newProject(), fps: 60 as const };
    const add = (seconds: number) =>
      applyAgentEdit(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Late title",
        actions: [{ type: "clip.add", kind: "text", at: { seconds } }],
      });
    expect(() => add(5 * 60 * 60)).toThrow(
      "Times must be under 4 hours at 60 fps.",
    );
    expect(add(3 * 60 * 60).project.clips[0].start).toBe(3 * 60 * 60 * 60);
  });
});
