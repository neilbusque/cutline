import { describe, expect, it } from "vitest";
import {
  makeClip,
  newProject,
  validateProject,
  type Asset,
  type Project,
} from "../src/shared/model";
import { buildCaptionClips } from "../src/shared/caption-grouping";
import { buildStyleReel, STYLE_TRACKS } from "../src/shared/style-reel";

function fixture(): Project {
  const p: Project = { ...newProject(), width: 1080, height: 1920 };
  const speaker: Asset = {
    id: "speaker",
    name: "Original speech",
    kind: "video",
    path: "/tmp/speaker.mov",
    duration: 8,
    width: 1080,
    height: 1920,
    hasAudio: true,
  };
  const proof: Asset = {
    id: "proof",
    name: "Proof",
    kind: "video",
    path: "/tmp/proof.mp4",
    duration: 5,
    width: 1920,
    height: 1080,
    hasAudio: false,
  };
  const still: Asset = {
    id: "still",
    name: "Still",
    kind: "image",
    path: "/tmp/still.png",
    duration: 0,
    width: 1920,
    height: 1080,
    hasAudio: false,
  };
  p.assets = [speaker, proof, still];
  p.clips = [
    {
      ...makeClip(
        p,
        "video",
        p.tracks.find((track) => track.kind === "video")!.id,
        0,
        speaker,
      ),
      duration: 240,
    },
  ];
  p.clips.push(
    ...buildCaptionClips(p, [
      { text: "Dark", start: 0.2, end: 0.6 },
      { text: "canvas", start: 0.7, end: 1.1 },
      { text: "Light", start: 2.2, end: 2.6 },
      { text: "canvas", start: 2.7, end: 3.1 },
      { text: "Speaker", start: 4.2, end: 4.7 },
    ]),
  );
  return p;
}
const activeAt = (p: Project, frame: number) =>
  p.clips.filter((c) => c.start <= frame && c.start + c.duration > frame);
function speakerAt(p: Project, frame: number) {
  return activeAt(p, frame).find((c) => c.assetId === "speaker")!;
}
function assertContinuousSpeech(p: Project) {
  for (let frame = 0; frame < 240; frame++) {
    const voices = activeAt(p, frame).filter(
      (c) => c.assetId === "speaker" && c.volume > 0,
    );
    expect(voices, `one voice at frame ${frame}`).toHaveLength(1);
    expect(
      voices[0].sourceIn +
        ((frame - voices[0].start) / p.fps) * voices[0].speed,
    ).toBeCloseTo(frame / p.fps, 8);
  }
  expect(() => validateProject(p)).not.toThrow();
}
function hasBackdrop(p: Project, frame: number) {
  const track = p.tracks.find((t) => t.name === STYLE_TRACKS.backdrop)!;
  return activeAt(p, frame).some((c) => c.trackId === track.id);
}

describe("proof coverage and authored caption contrast", () => {
  it.each(["missing", "exhausted"])(
    "keeps the full speaker visible for a %s full-screen proof",
    (kind) => {
      const { project, warnings } = buildStyleReel(fixture(), {
        style: "split",
        beats: [
          {
            from: 0,
            to: 4,
            layout: "full",
            sourceIn: kind === "exhausted" ? 5 : 0,
            visual: {
              kind: "asset",
              assetId: kind === "missing" ? "missing" : "proof",
            },
          },
        ],
      });
      expect(project.clips.some((c) => c.assetId === "proof")).toBe(false);
      expect(speakerAt(project, 30)).toMatchObject({
        opacity: 1,
        x: 0,
        y: 0,
        width: 1080,
        height: 1920,
      });
      expect(hasBackdrop(project, 30)).toBe(false);
      expect(warnings.some((w) => w.includes("speaker stays visible"))).toBe(
        true,
      );
      assertContinuousSpeech(project);
    },
  );

  it("returns to the speaker at the exact end of a short full-screen passage", () => {
    const { project, warnings } = buildStyleReel(fixture(), {
      style: "split",
      beats: [
        {
          from: 0,
          to: 4,
          layout: "full",
          sourceIn: 3,
          entrance: "cut",
          visual: { kind: "asset", assetId: "proof" },
        },
      ],
    });
    expect(project.clips.find((c) => c.assetId === "proof")).toMatchObject({
      start: 0,
      duration: 60,
      sourceIn: 3,
      volume: 0,
    });
    expect(speakerAt(project, 59).opacity).toBe(0);
    expect(speakerAt(project, 60)).toMatchObject({
      opacity: 1,
      y: 0,
      height: 1920,
    });
    expect(hasBackdrop(project, 59)).toBe(true);
    expect(hasBackdrop(project, 60)).toBe(false);
    expect(warnings.some((w) => w.includes("ends before the beat"))).toBe(true);
    assertContinuousSpeech(project);
  });

  it("keeps a one-frame proof inside native bounds and covers its remaining beat", () => {
    const { project } = buildStyleReel(fixture(), {
      style: "split",
      beats: [
        {
          from: 0,
          to: 2,
          layout: "full",
          sourceIn: 5 - 1 / 30,
          entrance: "rise",
          visual: { kind: "asset", assetId: "proof" },
        },
      ],
    });
    const proof = project.clips.find((c) => c.assetId === "proof")!;
    expect(proof.duration).toBe(1);
    expect(proof.keyframes).toEqual([]);
    expect(speakerAt(project, 1).opacity).toBe(1);
    expect(hasBackdrop(project, 1)).toBe(false);
    assertContinuousSpeech(project);
  });

  it("keeps locked-split holds for valid stills and restores the speaker after exhausted video", () => {
    const { project } = buildStyleReel(fixture(), {
      style: "locked-split",
      beats: [
        {
          from: 0,
          to: 0.5,
          sourceIn: 4,
          visual: { kind: "asset", assetId: "proof" },
        },
        { from: 6, to: 7, visual: { kind: "asset", assetId: "still" } },
      ],
    });
    expect(project.clips.find((c) => c.assetId === "proof")).toMatchObject({
      duration: 30,
      sourceIn: 4,
    });
    expect(speakerAt(project, 15)).toMatchObject({
      opacity: 1,
      y: 960,
      height: 960,
    });
    expect(speakerAt(project, 30)).toMatchObject({
      opacity: 1,
      y: 0,
      height: 1920,
    });
    expect(hasBackdrop(project, 30)).toBe(false);
    expect(project.clips.find((c) => c.assetId === "still")).toMatchObject({
      start: 180,
      duration: 60,
    });
    expect(speakerAt(project, 239)).toMatchObject({ y: 960, height: 960 });
    assertContinuousSpeech(project);
  });

  it.each(["full", "split"] as const)(
    "keeps card captions readable on dark and light %s backdrops",
    (layout) => {
      const { project } = buildStyleReel(fixture(), {
        style: "cards",
        beats: [
          {
            from: 0,
            to: 2,
            layout,
            background: "#102030",
            visual: { kind: "asset", assetId: "still" },
          },
          {
            from: 2,
            to: 4,
            layout,
            background: "#F0E8DD",
            visual: { kind: "asset", assetId: "still" },
          },
        ],
      });
      const captions = project.clips.filter((c) => c.kind === "caption");
      expect(
        captions
          .filter((c) => c.start < 60)
          .every((c) => c.color === "#ffffff"),
      ).toBe(true);
      expect(
        captions
          .filter((c) => c.start >= 60 && c.start < 120)
          .every((c) => c.color === "#141418"),
      ).toBe(true);
      expect(
        captions
          .filter((c) => c.start >= 120)
          .every((c) => c.color === "#ffffff"),
      ).toBe(true);
      expect(captions.some((c) => c.start < 60)).toBe(true);
      expect(captions.some((c) => c.start >= 60 && c.start < 120)).toBe(true);
    },
  );
});
