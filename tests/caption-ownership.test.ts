import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import { captionStylePatch } from "../src/shared/caption-styles";
import { replaceGeneratedCaptions } from "../src/shared/caption-generation";
import {
  makeClip,
  newProject,
  validateProject,
  type Clip,
  type Project,
} from "../src/shared/model";
import { reelWordsForClip } from "../src/shared/reel";

function fixture(kind: "video" | "audio" = "video") {
  const p = newProject();
  const asset = {
    id: "voice",
    name: "Voice",
    kind,
    path: "/local/voice.mp4",
    duration: 20,
    hasAudio: true,
    words: [
      { text: "Before", start: 4, end: 5 },
      { text: "Crossing", start: 5, end: 7 },
      { text: "after", start: 7, end: 8 },
      { text: "finish.", start: 8, end: 10 },
    ],
  };
  p.assets = [asset];
  const source = {
    ...makeClip(p, kind, p.tracks.find((t) => t.kind === kind)!.id, 60, asset),
    sourceIn: 4,
    speed: 2,
    duration: 90,
  };
  const caption = {
    ...makeClip(p, "caption", "captions", 60),
    ...captionStylePatch("pop", p),
    duration: 90,
    captionSourceId: source.id,
    text: "Before Crossing after finish.",
    words: [
      { text: "Before", start: 0, end: 0.5 },
      { text: "Crossing", start: 0.5, end: 1.5 },
      { text: "after", start: 1.5, end: 2 },
      { text: "finish.", start: 2, end: 3 },
    ],
    x: 73,
    y: 1111,
    width: 830,
    height: 251,
    accent: "#ff0088",
    animationOffset: 12,
  };
  p.clips = [source, caption];
  return { p, asset, source, caption };
}
function split(p: Project, id: string, frame: number) {
  return applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Split",
    commands: [{ type: "clip.split", id, frame }],
  });
}
const owned = (p: Project, id: string) =>
  p.clips.filter(
    (clip) => clip.kind === "caption" && clip.captionSourceId === id,
  );

describe("Generated caption ownership when splitting source media", () => {
  it.each(["video", "audio"] as const)(
    "splits crossing captions with the %s source and preserves visible word intervals",
    (kind) => {
      const { p, source, caption } = fixture(kind),
        before = structuredClone(p);
      const next = split(p, source.id, 90);
      const right = next.clips.find(
        (clip) => clip.kind === kind && clip.id !== source.id,
      )!;
      const leftCue = owned(next, source.id)[0],
        rightCue = owned(next, right.id)[0];
      expect(right).toMatchObject({
        start: 90,
        duration: 60,
        sourceIn: 6,
        speed: 2,
      });
      expect(leftCue).toMatchObject({
        start: 60,
        duration: 30,
        text: "Before Crossing",
        words: [
          { text: "Before", start: 0, end: 0.5 },
          { text: "Crossing", start: 0.5, end: 1 },
        ],
        animationOffset: 12,
      });
      expect(rightCue).toMatchObject({
        start: 90,
        duration: 60,
        text: "Crossing after finish.",
        words: [
          { text: "Crossing", start: 0, end: 0.5 },
          { text: "after", start: 0.5, end: 1 },
          { text: "finish.", start: 1, end: 2 },
        ],
        animationOffset: 42,
      });
      for (const cue of [leftCue, rightCue])
        for (const property of [
          "captionStyle",
          "captionLayout",
          "captionCase",
          "fontSize",
          "fontFamily",
          "fontWeight",
          "color",
          "accent",
          "background",
          "x",
          "y",
          "width",
          "height",
        ] as const)
          expect(cue[property]).toEqual(caption[property]);
      expect(p).toEqual(before);
      expect(() => validateProject(next)).not.toThrow();
    },
  );

  it("regenerates either half without deleting or doubling the other half", () => {
    const { p, asset, source } = fixture();
    const divided = split(p, source.id, 90),
      right = divided.clips.find(
        (clip) => clip.kind === "video" && clip.id !== source.id,
      )!;
    const rightBefore = structuredClone(owned(divided, right.id));
    const left = divided.clips.find((clip) => clip.id === source.id)!;
    const refreshedLeft = replaceGeneratedCaptions(
      divided,
      left.id,
      reelWordsForClip(asset, left, p.fps),
    ).project;
    expect(owned(refreshedLeft, right.id)).toEqual(rightBefore);
    const leftBefore = structuredClone(owned(refreshedLeft, left.id));
    const refreshedRight = replaceGeneratedCaptions(
      refreshedLeft,
      right.id,
      reelWordsForClip(asset, right, p.fps),
    ).project;
    expect(owned(refreshedRight, left.id)).toEqual(leftBefore);
    expect(owned(refreshedRight, right.id)).toHaveLength(1);
    for (const clip of refreshedRight.clips.filter(
      (clip) => clip.kind === "caption",
    )) {
      const owner = refreshedRight.clips.find(
        (source) => source.id === clip.captionSourceId,
      )!;
      expect(clip.start).toBeGreaterThanOrEqual(owner.start);
      expect(clip.start + clip.duration).toBeLessThanOrEqual(
        owner.start + owner.duration,
      );
    }
  });

  it("only changes ownership for linked cues after the cut; leaves manual and other-source captions intact", () => {
    const { p, source, caption } = fixture();
    const left = {
      ...caption,
      id: "left",
      start: 60,
      duration: 15,
      text: "Before",
      words: [{ text: "Before", start: 0, end: 0.5 }],
    };
    const right = {
      ...caption,
      id: "right",
      start: 90,
      duration: 60,
      text: "Later",
      words: [{ text: "Later", start: 0, end: 2 }],
    };
    const manual = { ...caption, id: "manual", captionSourceId: undefined };
    const other = { ...caption, id: "other", captionSourceId: "other-source" };
    p.clips = [source, left, right, manual, other];
    const next = split(p, source.id, 90),
      rightSource = next.clips.find(
        (clip) => clip.kind === "video" && clip.id !== source.id,
      )!;
    expect(next.clips.find((clip) => clip.id === "left")).toEqual(left);
    expect(next.clips.find((clip) => clip.id === "right")).toEqual({
      ...right,
      captionSourceId: rightSource.id,
    });
    expect(next.clips.find((clip) => clip.id === "manual")).toEqual(manual);
    expect(next.clips.find((clip) => clip.id === "other")).toEqual(other);
  });

  it.each(["leading", "trailing"] as const)(
    "removes an empty %s handle instead of keeping a blank caption after splitting",
    (side) => {
      const { p, source, caption } = fixture();
      caption.text = "Word";
      caption.words =
        side === "leading"
          ? [{ text: "Word", start: 1.5, end: 2 }]
          : [{ text: "Word", start: 0.1, end: 0.5 }];
      const next = split(p, source.id, 90),
        cues = next.clips.filter((clip) => clip.kind === "caption");
      expect(cues).toHaveLength(1);
      expect(cues[0].text).toBe("Word");
      expect(cues[0].words).toHaveLength(1);
      expect(cues[0].captionSourceId === source.id).toBe(side === "trailing");
    },
  );

  it("keeps corrected unaligned text without fabricating word timing", () => {
    const { p, source, caption } = fixture();
    caption.words = [];
    caption.text = "Corrected complete phrase";
    const next = split(p, source.id, 90),
      cues = next.clips
        .filter((clip) => clip.kind === "caption")
        .sort((a, b) => a.start - b.start);
    expect(cues).toHaveLength(2);
    expect(
      cues.every(
        (clip) =>
          clip.text === "Corrected complete phrase" && clip.words.length === 0,
      ),
    ).toBe(true);
    expect(cues[0].start + cues[0].duration).toBe(cues[1].start);
  });

  it("supports another split in the right half without disturbing earlier ownership", () => {
    const { p, source } = fixture();
    const first = split(p, source.id, 90),
      right = first.clips.find(
        (clip) => clip.kind === "video" && clip.id !== source.id,
      )!;
    const before = structuredClone(owned(first, source.id));
    const next = split(first, right.id, 120);
    expect(owned(next, source.id)).toEqual(before);
    const last = next.clips.find(
      (clip) => clip.kind === "video" && clip.start === 120,
    )!;
    expect(owned(next, last.id)[0].text).toBe("finish.");
    expect(owned(next, last.id)[0].words).toEqual([
      { text: "finish.", start: 0, end: 1 },
    ]);
  });
});
