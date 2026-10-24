import { describe, expect, it } from "vitest";
import {
  makeClip,
  newProject,
  type Asset,
  type Project,
} from "../src/shared/model";
import { buildCaptionClips } from "../src/shared/caption-grouping";
import { buildStyleReel, STYLE_TRACKS } from "../src/shared/style-reel";

const svg = '<svg viewBox="0 0 24 24"><path d="M2 2H22V22H2Z"/></svg>';

function speakerProject(): Project {
  const p: Project = { ...newProject(), width: 1080, height: 1920 };
  const speaker: Asset = {
    id: "speaker",
    name: "Speaker",
    kind: "video",
    path: "/tmp/speaker.mov",
    duration: 12,
    width: 1080,
    height: 1920,
    hasAudio: true,
  };
  const shot: Asset = {
    id: "shot",
    name: "Repo",
    kind: "image",
    path: "/tmp/shot.png",
    duration: 0,
    width: 2880,
    height: 1800,
    hasAudio: false,
  };
  p.assets = [speaker, shot];
  const video = p.tracks.find((t) => t.kind === "video")!;
  p.clips.push({
    ...makeClip(p, "video", video.id, 0, speaker),
    duration: 360,
  });
  const words =
    "I just built a free tool that deletes every trace of AI slop it is open source and on GitHub right now"
      .split(" ")
      .map((text, i) => ({ text, start: 0.2 + i * 0.45, end: 0.6 + i * 0.45 }));
  p.clips.push(...buildCaptionClips(p, words));
  return p;
}

const plan = [
  {
    from: 0,
    to: 2,
    visual: { kind: "svg" as const, svg, title: "Claude", color: "#D97757" },
  },
  {
    from: 2,
    to: 4.5,
    layout: "full" as const,
    visual: { kind: "asset" as const, assetId: "shot" },
  },
  { from: 4.5, to: 5.5, layout: "face" as const },
  {
    from: 6,
    to: 8,
    visual: { kind: "text" as const, text: "It's open source" },
  },
];

describe("creator-style Shorts", () => {
  it("split explainer cuts the speaker between split, full, face and speaker framing", () => {
    const { project, warnings } = buildStyleReel(speakerProject(), {
      style: "split",
      beats: plan,
    });
    expect(warnings).toEqual([]);
    const speaker = project.clips
      .filter((c) => c.kind === "video" && c.assetId === "speaker")
      .sort((a, b) => a.start - b.start);
    // Cuts at every beat edge, and the voice never stops.
    expect(speaker.map((c) => c.start)).toEqual([0, 60, 135, 165, 180, 240]);
    expect(speaker.reduce((sum, c) => sum + c.duration, 0)).toBe(360);
    expect(speaker.map((c) => c.sourceIn)).toEqual([0, 2, 4.5, 5.5, 6, 8]);
    const [split, full, face, gap, split2, after] = speaker;
    expect(split).toMatchObject({ y: 960, height: 960, opacity: 1 });
    expect(full.opacity).toBe(0);
    expect(
      face.keyframes.some((k) => k.property === "scale" && k.value > 1.3),
    ).toBe(true);
    expect(gap).toMatchObject({ y: 0, height: 1920, opacity: 1 });
    expect(split2.y).toBe(960);
    expect(after.y).toBe(0);
    // Style layers sit just above the speaker, under captions.
    const names = project.tracks.map((t) => t.name);
    const speakerIndex = project.tracks.findIndex(
      (t) => t.id === split.trackId,
    );
    expect(names.slice(speakerIndex - 3, speakerIndex)).toEqual([
      STYLE_TRACKS.graphics,
      STYLE_TRACKS.media,
      STYLE_TRACKS.backdrop,
    ]);
    const captionsIndex = project.tracks.findIndex((t) =>
      project.clips.some((c) => c.kind === "caption" && c.trackId === t.id),
    );
    expect(captionsIndex).toBeLessThan(speakerIndex - 3);
    // Pill captions in short chunks, on the seam during splits.
    const captions = project.clips.filter((c) => c.kind === "caption");
    expect(
      captions.every((c) => c.captionStyle === "pill" && !c.highlight),
    ).toBe(true);
    expect(
      Math.max(...captions.map((c) => c.text.split(" ").length)),
    ).toBeLessThanOrEqual(3);
    const onSeam = captions.find((c) => c.start + c.duration / 2 < 60)!;
    expect(Math.abs(onSeam.y + onSeam.height / 2 - 960)).toBeLessThanOrEqual(1);
    // The repo screenshot fills a card in the full-screen graphic.
    const card = project.clips.find((c) => c.assetId === "shot")!;
    expect(card).toMatchObject({ start: 60, mask: "rounded", volume: 0 });
    expect(
      card.keyframes.some((k) => k.property === "scale" && k.value === 0.85),
    ).toBe(true);
    expect(
      project.motions.some((m) => m.source === "style-reel:split:ripple"),
    ).toBe(true);
  });

  it("card canvas uses the grid canvas and dark captions on it; locked split fills the top half", () => {
    const cards = buildStyleReel(speakerProject(), {
      style: "cards",
      beats: plan,
    }).project;
    expect(
      cards.motions.some((m) => m.layers.some((l) => l.name === "Grid")),
    ).toBe(true);
    const onCanvas = cards.clips.find(
      (c) =>
        c.kind === "caption" && c.start >= 60 && c.start + c.duration <= 135,
    )!;
    expect(onCanvas.color).toBe("#141418");
    const onSplitCanvas = cards.clips.find(
      (c) => c.kind === "caption" && c.start + c.duration / 2 < 60,
    )!;
    expect(onSplitCanvas.color).toBe("#141418");
    const locked = buildStyleReel(speakerProject(), {
      style: "locked-split",
      beats: [{ from: 1, to: 2, visual: { kind: "asset", assetId: "shot" } }],
    }).project;
    const media = locked.clips.find((c) => c.assetId === "shot")!;
    expect(media).toMatchObject({
      x: 0,
      y: 0,
      width: 1080,
      height: 960,
      mask: "none",
    });
    // Held until the end, because nothing replaces it.
    expect(media.start + media.duration).toBe(360);
    expect(
      locked.clips
        .filter((c) => c.assetId === "speaker")
        .every((c) => c.y === 960),
    ).toBe(true);
  });

  it("running again replaces its own layers and keeps everything else", () => {
    const once = buildStyleReel(speakerProject(), {
      style: "split",
      beats: plan,
    }).project;
    const twice = buildStyleReel(once, {
      style: "cards",
      beats: plan.slice(0, 2),
    }).project;
    expect(
      twice.tracks.filter((t) => t.name === STYLE_TRACKS.backdrop),
    ).toHaveLength(1);
    expect(
      twice.motions.some((m) => m.source?.startsWith("style-reel:split")),
    ).toBe(false);
    expect(
      twice.clips
        .filter((c) => c.assetId === "speaker")
        .reduce((s, c) => s + c.duration, 0),
    ).toBe(360);
    expect(JSON.stringify(twice)).not.toContain("Ring ripple");
  });
  it("never leaves a graphic floating on bare footage or an empty panel", () => {
    const split = buildStyleReel(speakerProject(), {
      style: "split",
      beats: [
        {
          from: 0,
          to: 2,
          layout: "speaker",
          visual: { kind: "text", text: "Free tool" },
        },
        { from: 2, to: 4, layout: "full" },
      ],
    }).project;
    const pieces = split.clips
      .filter((c) => c.assetId === "speaker")
      .sort((a, b) => a.start - b.start);
    expect(pieces[0].y).toBe(960);
    expect(pieces[1]).toMatchObject({ y: 0, opacity: 1 });
    const cards = buildStyleReel(speakerProject(), {
      style: "cards",
      beats: [
        {
          from: 0,
          to: 2,
          layout: "speaker",
          visual: { kind: "text", text: "Free tool" },
        },
      ],
    }).project;
    const line = cards.motions.find(
      (m) => m.source === "style-reel:cards:text",
    )!;
    expect(line.layers[0]).toMatchObject({
      name: "Card",
      background: "#ffffff",
    });
    expect(
      cards.clips.find((c) => c.assetId === "speaker" && c.start === 0)!.y,
    ).toBe(0);
  });
});
