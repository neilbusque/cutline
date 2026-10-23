import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import { captionTextWidth } from "../src/shared/caption-layout";
import { creatorEducationColors } from "../src/shared/creator-education";
import { newProject, validateProject, type Asset } from "../src/shared/model";
import {
  analyzeAutoReel,
  finalizeAutoReelPlan,
  type AutoReelAnalysis,
  type AutoReelPlacement,
} from "../src/shared/auto-reel";

function fixture() {
  const text = [
    "Fresh coffee beans make your morning espresso taste much better.",
    "A paper notebook keeps the next clear task beside your desk.",
    "Move your phone away before you start writing in that notebook.",
    "A camera can record the small improvements in your daily work.",
    "Keep a water bottle near the desk during a focused session.",
    "Close the laptop and take a walk beside the river afterward.",
    "Pick up your notebook and write the next useful task clearly.",
    "Small changes around your desk make the next session feel easier.",
  ].join(" ");
  const words = text.split(/\s+/u).map((text, index) => ({
    text,
    start: 1 + index * 0.45,
    end: 1 + index * 0.45 + 0.36,
  }));
  const source: Asset = {
    id: "speaker",
    name: "Educator.mov",
    path: "/local/educator.mov",
    kind: "video",
    duration: words.at(-1)!.end + 1,
    hasAudio: true,
    words,
  };
  const project = newProject();
  project.assets = [
    source,
    {
      id: "stock-video",
      name: "Desk.mp4",
      path: "/local/desk.mp4",
      kind: "video",
      duration: 12,
      hasAudio: true,
    },
    {
      id: "stock-image",
      name: "Notebook.jpg",
      path: "/local/notebook.jpg",
      kind: "image",
      duration: 0,
      hasAudio: false,
    },
  ];
  return { project, source };
}

function assemble(
  project: ReturnType<typeof fixture>["project"],
  analysis: AutoReelAnalysis,
  requested: Parameters<typeof finalizeAutoReelPlan>[4] = {},
  placements: AutoReelPlacement[] = [],
) {
  const plan = finalizeAutoReelPlan(project, analysis, placements, undefined, {
    music: false,
    openingTitle: false,
    ...requested,
  });
  const next = applyCommands(project, {
    projectId: project.id,
    revision: project.revision,
    label: plan.label,
    commands: plan.commands,
  });
  expect(validateProject(next)).toBeTruthy();
  return { plan, next };
}

function creatorAnalysis(source: Asset) {
  return analyzeAutoReel(source, {
    format: "creator-education",
    targetSeconds: 60,
  });
}

function teachingClips(project: ReturnType<typeof fixture>["project"]) {
  const ids = new Set(
    project.motions
      .filter((motion) => motion.source === "reel:creator-education")
      .map((motion) => motion.id),
  );
  return project.clips.filter(
    (clip) => clip.motionId && ids.has(clip.motionId),
  );
}

describe("Creator education through Auto edit", () => {
  it("keeps the existing default montage treatment and slow camera drift", () => {
    const { project, source } = fixture();
    const analysis = analyzeAutoReel(source, { targetSeconds: 60 });
    const { next } = assemble(project, analysis);
    expect(analysis.format).toBe("montage");
    expect(analysis.style).toBe("bold");
    expect(next.motions).toHaveLength(0);
    expect(
      next.clips
        .filter((clip) => clip.kind === "caption")
        .every((clip) => clip.captionStyle === "pop"),
    ).toBe(true);
    const footage = next.clips.filter((clip) => clip.assetId === source.id);
    expect(footage.length).toBeGreaterThan(0);
    expect(
      footage.every((clip) => clip.y === 0 && clip.height === next.height),
    ).toBe(true);
    const zooms = footage.flatMap((clip) =>
      clip.keyframes
        .filter((key) => key.property === "scale")
        .map((key) => key.value),
    );
    expect(Math.max(...zooms)).toBeGreaterThan(1);
    expect(Math.max(...zooms)).toBeLessThanOrEqual(1.025);
  });

  it("retains the selected format and applies its native editorial composition", () => {
    const { project, source } = fixture();
    const before = structuredClone(project);
    const analysis = creatorAnalysis(source);
    const { next, plan } = assemble(project, analysis);
    expect(analysis.format).toBe("creator-education");
    expect(analysis.style).toBe("clean");
    expect(project).toEqual(before);
    expect(plan.beatCount).toBeGreaterThan(0);
    expect(teachingClips(next)).toHaveLength(plan.beatCount);
    expect(
      next.motions.some((motion) =>
        motion.layers.some(
          (layer) =>
            layer.name === "Card" &&
            layer.background === creatorEducationColors.cream,
        ),
      ),
    ).toBe(true);
    const speaker = next.clips.find((clip) => clip.assetId === source.id)!;
    expect(speaker.y).toBeGreaterThan(0);
    expect(speaker.y + speaker.height).toBe(next.height);
    expect(speaker.look).toBe("none");
  });

  it("keeps captions linked to the trimmed source and preserves every spoken word", () => {
    const { project, source } = fixture();
    const analysis = creatorAnalysis(source);
    const { next } = assemble(project, analysis);
    const footage = next.clips.filter((clip) => clip.assetId === source.id);
    const captions = next.clips.filter((clip) => clip.kind === "caption");
    expect(captions.length).toBeGreaterThan(0);
    expect(
      captions.flatMap((clip) => clip.words.map((word) => word.text)),
    ).toEqual(source.words!.map((word) => word.text));
    for (const caption of captions) {
      const origin = footage.find(
        (clip) => clip.id === caption.captionSourceId,
      )!;
      expect(origin).toBeDefined();
      expect(caption.captionStyle).toBe("box");
      expect(caption.background).toBe(creatorEducationColors.caption);
      expect(caption.start).toBeGreaterThanOrEqual(origin.start);
      expect(caption.start + caption.duration).toBeLessThanOrEqual(
        origin.start + origin.duration,
      );
      expect(caption.y + caption.height).toBeLessThan(next.height * 0.9);
    }
    const first = captions[0];
    expect(first.start / next.fps + first.words[0].start).toBeCloseTo(
      source.words![0].start - analysis.sources[0].sourceIn!,
      6,
    );
  });

  it("preserves intentional punch-ins instead of overwriting them with generic drift", () => {
    const { project, source } = fixture();
    const { next } = assemble(project, creatorAnalysis(source));
    const footage = next.clips.filter((clip) => clip.assetId === source.id);
    expect(footage.every((clip) => clip.volume === 1)).toBe(true);
    const keys = footage.flatMap((clip) =>
      clip.keyframes.filter((key) => key.property === "scale"),
    );
    expect(keys.some((key) => key.value >= 1.05)).toBe(true);
    expect(keys.some((key) => key.value === 1 && key.frame > 0)).toBe(true);
  });

  it("honors an explicit caption treatment while retaining creator graphics", () => {
    const { project, source } = fixture();
    const { next } = assemble(project, creatorAnalysis(source), {
      captionStyle: "typewriter",
    });
    const captions = next.clips.filter((clip) => clip.kind === "caption");
    expect(captions.length).toBeGreaterThan(0);
    expect(captions.every((clip) => clip.captionStyle === "typewriter")).toBe(
      true,
    );
    expect(
      captions.every(
        (clip) => clip.background !== creatorEducationColors.caption,
      ),
    ).toBe(true);
    expect(teachingClips(next).length).toBeGreaterThan(0);
  });

  it("keeps matched B-roll muted above the speaker and outside teaching-card intervals", () => {
    const { project, source } = fixture();
    const analysis = creatorAnalysis(source);
    expect(analysis.beats.length).toBeGreaterThan(1);
    const placements = analysis.beats.map((beat, index) => ({
      assetId: index % 2 ? "stock-image" : "stock-video",
      query: beat.query,
      startSeconds: beat.startSeconds,
      durationSeconds: beat.durationSeconds,
    }));
    const { next } = assemble(
      project,
      analysis,
      {
        beats: [
          {
            sourceIndex: 0,
            sourceSeconds: analysis.sources[0].sourceIn! + 0.2,
            text: "Choose one clear task",
            kind: "callout",
          },
        ],
      },
      placements,
    );
    const cards = teachingClips(next);
    expect(cards).toHaveLength(1);
    const broll = next.clips.filter((clip) =>
      clip.assetId?.startsWith("stock-"),
    );
    expect(broll.length).toBeGreaterThan(0);
    for (const clip of broll) {
      expect(clip.volume).toBe(0);
      expect(clip.y + clip.height).toBeLessThan(next.height * 0.3);
      expect(clip.fit).toBe("contain");
      expect(
        cards.every(
          (card) =>
            clip.start + clip.duration <= card.start ||
            card.start + card.duration <= clip.start,
        ),
      ).toBe(true);
      expect(
        placements.some(
          (placement) =>
            placement.assetId === clip.assetId &&
            clip.start >= Math.round(placement.startSeconds * next.fps) &&
            clip.start + clip.duration <=
              Math.round(placement.startSeconds * next.fps) +
                Math.floor(placement.durationSeconds * next.fps),
        ),
      ).toBe(true);
    }
  });

  it("fits an optional long opening title within the reserved header", () => {
    const { project, source } = fixture();
    const analysis = creatorAnalysis(source);
    analysis.hook =
      "Choose a notebook and write one clear task before you open any browser tabs or start another meeting.";
    const { next } = assemble(project, analysis, { openingTitle: true });
    const title = next.clips.find(
      (clip) =>
        clip.kind === "text" && !clip.motionId && clip.text === analysis.hook,
    )!;
    expect(title).toBeDefined();
    const contentWidth = title.width - 24;
    let line = "",
      lines = 1;
    for (const word of title.text.split(/\s+/u)) {
      const candidate = line ? `${line} ${word}` : word;
      if (
        line &&
        captionTextWidth(
          candidate,
          title.fontSize,
          title.fontFamily,
          title.fontWeight,
        ) > contentWidth
      ) {
        lines++;
        line = word;
      } else line = candidate;
    }
    expect(lines * title.fontSize * 1.18 + 24).toBeLessThanOrEqual(
      title.height + 1,
    );
    expect(title.y + title.height).toBeLessThan(next.height * 0.11);
  });
});
