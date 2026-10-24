import { describe, expect, it } from "vitest";
import {
  makeClip,
  newProject,
  validateProject,
  type Asset,
  type Project,
} from "../src/shared/model";
import { buildCaptionClips } from "../src/shared/caption-grouping";
import { applyCommands } from "../src/shared/commands";
import { activeTransition } from "../src/shared/transitions";
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

  it("builds a drawing in part by part and places a cut-out picture unframed", () => {
    const drawing =
      '<svg viewBox="0 0 100 100"><circle id="head" cx="50" cy="40" r="20" fill="#3aa8c0"/><rect id="body" x="35" y="60" width="30" height="30" fill="#2e8ba0"/><circle id="eye" cx="45" cy="38" r="4" fill="#111111"/></svg>';
    const p = speakerProject();
    p.assets.push({
      id: "cutout",
      name: "Monster",
      kind: "image",
      path: "/tmp/monster.png",
      duration: 0,
      width: 800,
      height: 900,
      hasAudio: false,
    });
    const { project } = buildStyleReel(p, {
      style: "split",
      beats: [
        { from: 0, to: 2, visual: { kind: "svg", svg: drawing, title: "Robot", drawing: true } },
        { from: 2, to: 4, visual: { kind: "asset", assetId: "cutout", drawing: true } },
      ],
    });
    const robot = project.motions.find((m) => m.name === "Robot")!;
    const starts = robot.layers
      .filter((layer) => layer.name !== "Card")
      .map((layer) => layer.keyframes[0].frame);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts.at(-1)!).toBeGreaterThan(starts[0]);
    expect(starts.at(-1)! - starts[0]).toBeLessThanOrEqual(project.fps * 0.5);
    const picture = project.clips.find((clip) => clip.assetId === "cutout")!;
    expect(picture.mask).toBe("none");
    expect(picture.shadowBlur ?? 0).toBe(0);
    expect(picture.width / picture.height).toBeCloseTo(800 / 900, 1);
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

describe("creator-style Shorts cut the speaker the way a split does", () => {
  function captioned() {
    const p = speakerProject();
    const speaker = p.clips.find((c) => c.assetId === "speaker")!;
    Object.assign(speaker, {
      fadeIn: 12,
      fadeOut: 12,
      keyframes: [
        {
          property: "opacity" as const,
          frame: 0,
          value: 1,
          easing: "linear" as const,
        },
        {
          property: "opacity" as const,
          frame: 359,
          value: 0.8,
          easing: "linear" as const,
        },
      ],
    });
    // Generated captions, owned by the speaker clip.
    const words = p.clips
      .filter((c) => c.kind === "caption")
      .flatMap((c) =>
        c.words.map((w) => ({
          ...w,
          start: w.start + c.start / p.fps,
          end: w.end + c.start / p.fps,
        })),
      );
    p.clips = [
      speaker,
      ...buildCaptionClips(p, words, { sourceId: speaker.id }),
    ];
    return p;
  }
  const pieces = (project: Project) =>
    project.clips
      .filter((c) => c.assetId === "speaker")
      .sort((a, b) => a.start - b.start);

  it("fades only the outer ends and gives each caption to the piece it plays over", () => {
    const { project } = buildStyleReel(captioned(), {
      style: "split",
      beats: plan,
    });
    const cut = pieces(project);
    expect(cut.length).toBe(6);
    expect(cut.map((c) => [c.fadeIn, c.fadeOut])).toEqual([
      [12, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 12],
    ]);
    // Keys keep their phase across the cuts, as after a split.
    expect(cut.map((c) => c.animationOffset)).toEqual(cut.map((c) => c.start));
    const captions = project.clips.filter((c) => c.kind === "caption");
    expect(
      new Set(captions.map((c) => c.captionSourceId)).size,
    ).toBeGreaterThan(1);
    for (const caption of captions) {
      const owner = cut.find((c) => c.id === caption.captionSourceId)!;
      expect(owner).toBeDefined();
      expect(caption.start).toBeGreaterThanOrEqual(owner.start);
      expect(caption.start + caption.duration).toBeLessThanOrEqual(
        owner.start + owner.duration,
      );
    }
    // Deleting the hook piece takes only its own captions with it.
    const next = applyCommands(project, {
      projectId: project.id,
      revision: project.revision,
      label: "Delete hook",
      commands: [{ type: "clip.delete", id: cut[0].id, ripple: false }],
    });
    const left = next.clips.filter((c) => c.kind === "caption").length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(captions.length);
  });

  it("moves through reversed footage instead of repeating it, and keeps a crossfade out of the speaker", () => {
    const p = speakerProject();
    p.clips = p.clips.filter((c) => c.kind !== "caption");
    const speaker = p.clips.find((c) => c.assetId === "speaker")!;
    speaker.reverse = true;
    speaker.duration = 300;
    p.clips.push({
      ...makeClip(p, "video", speaker.trackId, 290, p.assets[0]),
      id: "next",
      duration: 70,
      transition: { kind: "crossfade", frames: 10, fromId: speaker.id },
    });
    const { project, warnings } = buildStyleReel(validateProject(p), {
      style: "split",
      beats: [
        { from: 0, to: 2 },
        { from: 2, to: 4, layout: "face" },
        // Starts inside the 10-frame crossfade at 290 to 300.
        { from: 9.7, to: 11, layout: "face" },
      ],
    });
    // The first speaker clip's pieces; "next" starts at 290.
    const cut = pieces(project).filter((c) => c.start < 290);
    // Reversed footage moves on at each cut, as a split does.
    expect(cut.map((c) => c.sourceIn)).toEqual([0, 2, 4]);
    const next = project.clips.find((c) => c.id === "next")!;
    expect(next.transition?.fromId).toBe(cut.at(-1)!.id);
    expect(activeTransition(project, next)?.previous.id).toBe(cut.at(-1)!.id);
    expect(warnings.filter((w) => w.includes("inside a crossfade"))).toEqual([
      "The speaker is not cut at 9.7s, which is inside a crossfade.",
    ]);
  });
});

describe("creator-style Shorts keep every spoken word once", () => {
  function speakerProject(contiguous: boolean): Project {
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
    p.assets = [speaker];
    const video = p.tracks.find((t) => t.kind === "video")!;
    const clip = { ...makeClip(p, "video", video.id, 0, speaker), duration: 360 };
    p.clips.push(clip);
    // Whisper-like words, back to back or with small gaps.
    const texts =
      "I just built a free tool that deletes every trace of AI slop it is open source and on GitHub right now".split(
        " ",
      );
    const words = texts.map((text, i) => ({
      text,
      start: 0.2 + i * 0.45,
      end: contiguous ? 0.65 + i * 0.45 : 0.6 + i * 0.45,
    }));
    p.clips.push(...buildCaptionClips(p, words, { sourceId: clip.id }));
    return validateProject(p);
  }
  // Beats start on word starts, as an assistant reading the transcript plans them.
  const beats = [
    { from: 0.2 + 4 * 0.45, to: 0.2 + 9 * 0.45, layout: "face" as const },
    { from: 0.2 + 9 * 0.45, to: 0.2 + 14 * 0.45 },
    { from: 0.2 + 14 * 0.45, to: 0.2 + 18 * 0.45, layout: "face" as const },
  ];
  const spoken = (p: Project) =>
    p.clips
      .filter((c) => c.kind === "caption")
      .sort((a, b) => a.start - b.start)
      .flatMap((c) => c.words.map((w) => w.text));

  for (const contiguous of [true, false])
    it(`never repeats a word across a cut (${contiguous ? "back to back" : "small gaps"})`, () => {
      const p = speakerProject(contiguous);
      const { project } = buildStyleReel(p, { style: "split", beats });
      expect(spoken(project)).toEqual(spoken(p));
      // No caption shorter than a few frames flashes up at a cut.
      for (const c of project.clips.filter((c) => c.kind === "caption"))
        expect(c.duration).toBeGreaterThanOrEqual(3);
    });

  it("leaves captions whole with captions: keep, owned by the piece under them", () => {
    const p = speakerProject(true);
    const before = p.clips
      .filter((c) => c.kind === "caption")
      .map((c) => [c.start, c.duration, c.text]);
    const { project } = buildStyleReel(p, { style: "split", beats, captions: "keep" });
    const captions = project.clips.filter((c) => c.kind === "caption");
    expect(captions.map((c) => [c.start, c.duration, c.text])).toEqual(before);
    const pieces = project.clips.filter((c) => c.assetId === "speaker");
    for (const caption of captions) {
      const owner = pieces.find((piece) => piece.id === caption.captionSourceId)!;
      const middle = caption.start + caption.duration / 2;
      expect(middle).toBeGreaterThanOrEqual(owner.start);
      expect(middle).toBeLessThan(owner.start + owner.duration);
    }
  });
});
