import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { applyCommands } from "../src/shared/commands";
import { evaluatedClip } from "../src/shared/animation";
import { captionStylePatch } from "../src/shared/caption-styles";
import {
  makeClip,
  newProject,
  validateProject,
  type Asset,
  type Clip,
  type Project,
} from "../src/shared/model";
import {
  createReelPlan,
  ReelOptionsSchema,
  type ReelOptions,
} from "../src/shared/reel";
import { AutoReelOptionsSchema } from "../src/shared/auto-reel-options";
import { analyzeAutoReel, finalizeAutoReelPlan } from "../src/shared/auto-reel";
import { creatorShortColors } from "../src/shared/creator-shorts";
import type { ReelProofBeat } from "../src/shared/reel-formats";

function fixture(): Project {
  const project = newProject();
  const source: Asset = {
    id: "speaker",
    name: "Original speaker",
    path: "/local/speaker.mov",
    kind: "video",
    duration: 45,
    hasAudio: true,
    words: Array.from({ length: 80 }, (_, index) => ({
      text: index % 8 === 7 ? `point${index}.` : `word${index}`,
      start: index * 0.5,
      end: index * 0.5 + 0.38,
    })),
  };
  project.assets = [
    source,
    {
      id: "screen",
      name: "Imported screen",
      path: "/local/screen.png",
      kind: "image",
      duration: 0,
      hasAudio: false,
    },
    {
      id: "demo",
      name: "Imported demo",
      path: "/local/demo.mov",
      kind: "video",
      duration: 10,
      hasAudio: true,
    },
    {
      id: "music",
      name: "Music",
      path: "/local/music.mp3",
      kind: "audio",
      duration: 30,
      hasAudio: true,
    },
  ];
  return project;
}
function proof(patch: Partial<ReelProofBeat> = {}): ReelProofBeat {
  return {
    sourceIndex: 0,
    sourceSeconds: 2,
    assetId: "screen",
    durationSeconds: 3,
    layout: "split",
    ...patch,
  };
}
function build(project: Project, options: Partial<ReelOptions> = {}) {
  const plan = createReelPlan(project, {
    sources: [{ assetId: "speaker" }],
    targetSeconds: 30,
    mode: "replace",
    format: "creator-punch",
    ...options,
  });
  const next = applyCommands(project, {
    projectId: project.id,
    revision: project.revision,
    label: plan.label,
    commands: plan.commands,
  });
  expect(validateProject(next)).toBeTruthy();
  return { next, plan };
}
function onTrack(project: Project, name: string) {
  const ids = project.tracks
    .filter((track) => track.name === name)
    .map((track) => track.id);
  return project.clips.filter((clip) => ids.includes(clip.trackId));
}
const overlaps = (a: Clip, b: Clip) =>
  a.start < b.start + b.duration && b.start < a.start + a.duration;

describe("Creator Shorts formats", () => {
  it.each(["creator-punch", "screen-demo"] as const)(
    "%s uses full-frame original speech, bold aligned captions and deliberate reframes",
    (format) => {
      const project = fixture(),
        before = structuredClone(project);
      const { next, plan } = build(project, { format });
      const footage = onTrack(next, "Reel · footage");
      expect(footage).toHaveLength(1);
      const speaker = footage[0];
      expect([speaker.x, speaker.y, speaker.width, speaker.height]).toEqual([
        0,
        0,
        next.width,
        next.height,
      ]);
      expect([
        speaker.volume,
        speaker.fadeIn,
        speaker.fadeOut,
        speaker.look,
      ]).toEqual([1, 0, 0, "none"]);
      expect(
        speaker.keyframes.some(
          (key) => key.property === "scale" && key.value === 1.1,
        ),
      ).toBe(true);
      expect(
        speaker.keyframes.some(
          (key) => key.property === "scale" && key.value === 1.12,
        ),
      ).toBe(true);
      expect(
        speaker.keyframes.every((key) => key.frame < speaker.duration),
      ).toBe(true);
      const captions = next.clips.filter((clip) => clip.kind === "caption");
      expect(captions.length).toBeGreaterThan(5);
      for (const caption of captions) {
        expect(caption.captionSourceId).toBe(speaker.id);
        expect(caption.words.length).toBeLessThanOrEqual(4);
        expect(caption.background).toBe("transparent");
        expect(caption.color).toBe("#ffffff");
        expect(caption.accent).toBe(creatorShortColors.accent);
        expect(caption.captionStrokeWidth).toBeGreaterThan(3);
        expect(caption.fontSize).toBeGreaterThanOrEqual(80);
        expect(caption.y).toBe(Math.round(next.height * 0.65));
        expect(caption.x + caption.width).toBeLessThan(next.width * 0.91);
      }
      const emphasis = next.motions.filter(
        (motion) => motion.source === `reel:${format}`,
      );
      expect(emphasis.length).toBeGreaterThan(0);
      expect(emphasis.length).toBeLessThanOrEqual(3);
      for (const motion of emphasis) {
        expect(motion.layers).toHaveLength(1);
        expect(motion.layers[0].type).toBe("text");
        expect(motion.layers[0].text.split(/\s+/u).length).toBeLessThanOrEqual(
          4,
        );
        expect(motion.layers[0].background).toBe("transparent");
      }
      expect(plan.proofCount).toBe(0);
      expect(project).toEqual(before);
    },
  );

  it("does not fabricate proof screens or unavailable transcripts", () => {
    const project = fixture();
    delete project.assets[0].words;
    const { next, plan } = build(project, { format: "screen-demo" });
    expect(plan.proofCount).toBe(0);
    expect(plan.captionCount).toBe(0);
    expect(plan.beatCount).toBe(0);
    expect(plan.missingTranscriptAssetIds).toEqual(["speaker"]);
    expect(next.clips.some((clip) => clip.assetId === "screen")).toBe(false);
  });

  it("honors an explicit caption style and disabled animation selection", () => {
    const { next } = build(fixture(), { captionStyle: "minimal", beats: [] });
    expect(onTrack(next, "Reel · footage")[0].keyframes).toEqual([]);
    expect(next.motions).toHaveLength(0);
    expect(
      next.clips
        .filter((clip) => clip.kind === "caption")
        .every((clip) => clip.captionStyle === "minimal" && !clip.highlight),
    ).toBe(true);
  });

  it.each(["creator-punch", "screen-demo"] as const)(
    "%s keeps an explicitly selected Editorial caption treatment independent",
    (format) => {
      const { next } = build(fixture(), {
        format,
        captionStyle: "box",
        beats: [],
      });
      const captions = next.clips.filter((clip) => clip.kind === "caption");
      const standardEditorial = captionStylePatch("box", next);
      expect(captions.length).toBeGreaterThan(0);
      for (const caption of captions) {
        expect(caption).toMatchObject(standardEditorial);
        expect(caption.background).toBe("#11151bea");
        expect(caption.color).toBe("#ffffff");
        expect(caption.captionSourceId).toBe(
          onTrack(next, "Reel · footage")[0].id,
        );
        expect(caption.words.length).toBeLessThanOrEqual(4);
      }
    },
  );

  it.each(["creator-punch", "screen-demo"] as const)(
    "%s keeps explicit emphasis clear of opening and closing titles",
    (format) => {
      const { next, plan } = build(fixture(), {
        format,
        hook: "Opening title",
        cta: "Closing title",
        beats: [
          {
            sourceIndex: 0,
            sourceSeconds: 0,
            text: "Opening collision",
            kind: "callout",
          },
          {
            sourceIndex: 0,
            sourceSeconds: 3,
            text: "Clear at boundary",
            kind: "callout",
          },
          {
            sourceIndex: 0,
            sourceSeconds: 26.5,
            text: "Closing collision",
            kind: "callout",
          },
        ],
      });
      const titles = onTrack(next, "Reel · titles");
      const emphasis = onTrack(next, "Reel · animations");
      expect(titles).toHaveLength(2);
      expect(emphasis).toHaveLength(1);
      expect(emphasis[0].text).toBe("Clear at boundary");
      expect(emphasis[0].start).toBe(3 * next.fps);
      expect(titles.some((title) => overlaps(emphasis[0], title))).toBe(false);
      expect(
        plan.warnings.filter((warning) =>
          warning.includes("opening or closing title is visible"),
        ),
      ).toHaveLength(2);
    },
  );

  it("retains indivisible imported phrase cues without invented word timings", () => {
    const project = fixture();
    const text = "This imported phrase has one real start and end timing.";
    project.assets[0].words = [{ text, start: 3, end: 6 }];
    const { next } = build(project, { beats: [] });
    const captions = next.clips.filter((clip) => clip.kind === "caption");
    expect(captions).toHaveLength(1);
    expect(captions[0].words).toEqual([{ text, start: 0, end: 3 }]);
  });

  it("adds split and cutaway evidence on an opaque canvas without doubling the voice", () => {
    const { next, plan } = build(fixture(), {
      format: "screen-demo",
      proofBeats: [
        proof(),
        proof({
          sourceSeconds: 8,
          assetId: "demo",
          sourceIn: 4,
          layout: "cutaway",
        }),
      ],
    });
    expect(plan.proofCount).toBe(2);
    const screens = onTrack(next, "Reel · proof screens");
    const inset = onTrack(next, "Reel · proof speaker");
    const backdrops = onTrack(next, "Reel · proof canvas");
    const main = onTrack(next, "Reel · footage")[0];
    expect(screens).toHaveLength(2);
    expect(inset).toHaveLength(1);
    expect(backdrops).toHaveLength(2);
    expect(screens[0].height).toBe(Math.round(next.height * 0.48));
    expect(inset[0].y).toBe(Math.round(next.height * 0.6));
    expect(inset[0].y + inset[0].height).toBe(next.height);
    expect(screens[1].height).toBe(Math.round(next.height * 0.76));
    expect(screens[1].sourceIn).toBe(4);
    expect(inset[0].volume).toBe(0);
    for (const screen of screens) {
      expect(screen.fit).toBe("contain");
      expect(screen.volume).toBe(0);
      expect(screen.look).toBe("none");
      expect(screen.keyframes).toEqual([]);
      expect(
        next.tracks.find((track) => track.id === screen.trackId)!.muted,
      ).toBe(true);
    }
    const audible = next.clips.filter(
      (clip) =>
        (clip.kind === "video" || clip.kind === "audio") &&
        clip.volume > 0 &&
        !next.tracks.find((track) => track.id === clip.trackId)!.muted,
    );
    expect(audible).toEqual([main]);
    expect([main.start, main.duration, main.volume]).toEqual([
      0,
      30 * next.fps,
      1,
    ]);
    const canvas = next.motions.find(
      (motion) => motion.source === "reel:proof-backdrop",
    )!;
    expect(canvas.layers[0].background).toBe("#101114");
    const layerIndex = (clip: Clip) =>
      next.tracks.findIndex((track) => track.id === clip.trackId);
    expect(layerIndex(screens[0])).toBeLessThan(layerIndex(backdrops[0]));
    expect(layerIndex(inset[0])).toBeLessThan(layerIndex(backdrops[0]));
    expect(layerIndex(backdrops[0])).toBeLessThan(layerIndex(main));
    for (const caption of next.clips.filter(
      (clip) => clip.kind === "caption",
    )) {
      expect(caption.captionSourceId).toBe(main.id);
      for (const [index, screen] of screens.entries()) {
        if (!overlaps(caption, screen)) continue;
        const shown = evaluatedClip(
          caption,
          Math.max(caption.start, screen.start) - caption.start,
        );
        expect(shown.y).toBe(
          Math.round(next.height * (index === 0 ? 0.48 : 0.77)),
        );
        if (index === 0) {
          expect(shown.y).toBeGreaterThanOrEqual(screen.height);
          expect(shown.y + shown.height).toBeLessThanOrEqual(inset[0].y + 1);
        } else {
          expect(shown.y + shown.height).toBeLessThanOrEqual(
            next.height * 0.901,
          );
        }
      }
    }
  });

  it.each([24, 25, 30, 60] as const)(
    "maps proof and caption source timing after trim, speed and append at %i fps",
    (fps) => {
      const project = fixture();
      project.fps = fps;
      project.width = 720;
      project.height = 1280;
      const existing = makeClip(project, "text", "titles", 0);
      existing.duration = fps * 2;
      existing.text = "Prior work";
      project.clips = [existing];
      const oldTracks = structuredClone(project.tracks);
      const { next, plan } = build(project, {
        mode: "append",
        sources: [
          { assetId: "speaker", sourceIn: 10, sourceOut: 30, speed: 2 },
        ],
        proofBeats: [
          proof({
            sourceSeconds: 14,
            assetId: "demo",
            sourceIn: 1,
            durationSeconds: 2,
          }),
        ],
      });
      expect([next.width, next.height]).toEqual([720, 1280]);
      expect(next.clips.find((clip) => clip.id === existing.id)).toEqual(
        existing,
      );
      expect(
        next.tracks.find((track) => track.id === existing.trackId),
      ).toEqual(oldTracks.find((track) => track.id === existing.trackId));
      expect(plan.startFrame).toBe(fps * 2);
      const main = onTrack(next, "Reel · footage")[0];
      const screen = onTrack(next, "Reel · proof screens")[0];
      const inset = onTrack(next, "Reel · proof speaker")[0];
      expect(screen.start).toBe(main.start + fps * 2);
      expect(screen.duration).toBe(fps * 2);
      expect([screen.sourceIn, screen.speed]).toEqual([1, 1]);
      expect([inset.sourceIn, inset.speed]).toEqual([14, 2]);
      for (const caption of next.clips.filter(
        (clip) => clip.kind === "caption",
      )) {
        expect(caption.captionSourceId).toBe(main.id);
        for (const word of caption.words) {
          const original = project.assets[0].words!.find(
            (item) => item.text === word.text,
          )!;
          const mapped =
            main.sourceIn +
            ((caption.start - main.start) / fps + word.start) * main.speed;
          expect(Math.abs(mapped - original.start)).toBeLessThanOrEqual(
            main.speed / fps + 1e-7,
          );
        }
      }
    },
  );

  it("suppresses text and titles over proof screens and keeps optional B-roll clear", () => {
    const { next, plan } = build(fixture(), {
      format: "explainer",
      hook: "A proof first",
      cta: "Save it",
      brollAssetIds: ["demo"],
      beats: [
        {
          sourceIndex: 0,
          sourceSeconds: 0,
          text: "Overlapping card",
          kind: "callout",
        },
      ],
      proofBeats: [
        proof({ sourceSeconds: 0, durationSeconds: 5 }),
        proof({ sourceSeconds: 27 }),
      ],
    });
    const screens = onTrack(next, "Reel · proof screens");
    expect(plan.beatCount).toBe(0);
    expect(onTrack(next, "Reel · titles")).toHaveLength(0);
    for (const clip of onTrack(next, "Reel · B-roll"))
      expect(screens.some((screen) => overlaps(clip, screen))).toBe(false);
    expect(plan.warnings.join(" ")).toContain("omitted");
  });

  it("moves one real phrase cue safely between touching proof layouts without retiming speech", () => {
    const project = fixture();
    const text = "One continuous imported cue across both proof layouts";
    project.assets[0].words = [{ text, start: 1, end: 9 }];
    const { next } = build(project, {
      beats: [],
      proofBeats: [proof(), proof({ sourceSeconds: 5, layout: "cutaway" })],
    });
    const captions = next.clips.filter((clip) => clip.kind === "caption");
    expect(captions).toHaveLength(1);
    const caption = captions[0];
    expect(caption.words).toEqual([{ text, start: 0, end: 8 }]);
    expect(caption.captionSourceId).toBe(onTrack(next, "Reel · footage")[0].id);
    const at = (seconds: number) =>
      evaluatedClip(caption, seconds * next.fps - caption.start);
    expect(at(1).y).toBe(Math.round(next.height * 0.65));
    expect(at(2).y).toBe(Math.round(next.height * 0.48));
    expect(at(4.5).y + caption.height).toBeLessThanOrEqual(
      Math.round(next.height * 0.6) + 1,
    );
    expect(at(5).y).toBe(Math.round(next.height * 0.77));
    expect(at(8).y).toBe(Math.round(next.height * 0.65));
  });

  it("rejects overlapping proof intervals but accepts touching boundaries", () => {
    expect(() =>
      build(fixture(), { proofBeats: [proof(), proof({ sourceSeconds: 4 })] }),
    ).toThrow("cannot overlap");
    expect(
      build(fixture(), { proofBeats: [proof(), proof({ sourceSeconds: 5 })] })
        .plan.proofCount,
    ).toBe(2);
  });

  it.each([
    [proof({ sourceIndex: 4 }), "missing or outside"],
    [proof({ sourceSeconds: 29 }), "source range"],
    [proof({ assetId: "missing" }), "imported video or image"],
    [proof({ assetId: "music" }), "imported video or image"],
    [proof({ sourceIn: 1 }), "imported media range"],
    [proof({ assetId: "demo", sourceIn: 8 }), "imported media range"],
  ] as const)("rejects an invalid proof atomically: %o", (beat, message) => {
    const project = fixture(),
      before = structuredClone(project);
    expect(() => build(project, { proofBeats: [beat] })).toThrow(message);
    expect(project).toEqual(before);
  });

  it("rejects anchors before trim and proof durations beyond speed-adjusted source allocation", () => {
    const source = {
      assetId: "speaker",
      sourceIn: 10,
      sourceOut: 20,
      speed: 2,
    };
    expect(() =>
      build(fixture(), {
        sources: [source],
        proofBeats: [proof({ sourceSeconds: 8 })],
      }),
    ).toThrow("source range");
    expect(() =>
      build(fixture(), {
        sources: [source],
        proofBeats: [proof({ sourceSeconds: 16 })],
      }),
    ).toThrow("source range");
    expect(
      build(fixture(), {
        sources: [source],
        proofBeats: [proof({ sourceSeconds: 14 })],
      }).plan.proofCount,
    ).toBe(1);
  });

  it("requires image source anchors to be zero", () => {
    expect(() =>
      build(fixture(), {
        sources: [{ assetId: "screen" }],
        proofBeats: [proof({ sourceSeconds: 1, assetId: "demo" })],
      }),
    ).toThrow("source range");
    expect(
      build(fixture(), {
        sources: [{ assetId: "screen" }],
        proofBeats: [proof({ sourceSeconds: 0, assetId: "demo" })],
      }).plan.proofCount,
    ).toBe(1);
  });

  it("validates the public schema and keeps proofs out of the Auto edit contract", () => {
    const base = {
      sources: [{ assetId: "speaker" }],
      targetSeconds: 30,
      format: "screen-demo",
    };
    expect(
      ReelOptionsSchema.safeParse({ ...base, proofBeats: [proof()] }).success,
    ).toBe(true);
    for (const invalid of [
      proof({ durationSeconds: 0.4 }),
      proof({ durationSeconds: 13 }),
      proof({ sourceSeconds: NaN }),
      proof({ sourceIn: -1 }),
    ])
      expect(
        ReelOptionsSchema.safeParse({ ...base, proofBeats: [invalid] }).success,
      ).toBe(false);
    expect(
      ReelOptionsSchema.safeParse({
        ...base,
        proofBeats: Array.from({ length: 25 }, () => proof()),
      }).success,
    ).toBe(false);
    expect(
      AutoReelOptionsSchema.safeParse({
        format: "screen-demo",
        proofBeats: [proof()],
      }).success,
    ).toBe(false);
  });

  it("applies and removes the full proof composition in one Undo transaction", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cutline-shorts-test-"));
    try {
      const store = new Store(path.join(directory, "recovery.json"));
      const project = fixture();
      project.clips = [makeClip(project, "text", "titles", 0)];
      store.commit(project, "Prior work");
      const before = structuredClone(store.project);
      const plan = createReelPlan(store.project, {
        sources: [{ assetId: "speaker" }],
        targetSeconds: 30,
        mode: "append",
        format: "screen-demo",
        proofBeats: [proof()],
      });
      store.transact({
        projectId: store.project.id,
        revision: store.project.revision,
        label: plan.label,
        commands: plan.commands,
      });
      const after = structuredClone(store.project);
      expect(onTrack(after, "Reel · proof screens")).toHaveLength(1);
      expect({ ...store.undo().project, revision: before.revision }).toEqual(
        before,
      );
      expect({ ...store.redo().project, revision: after.revision }).toEqual(
        after,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["creator-punch", "screen-demo"] as const)(
    "Auto edit preserves %s captions and punch keys without adding implicit proofs",
    (format) => {
      const project = fixture();
      const analysis = analyzeAutoReel(project.assets[0], {
        format,
        targetSeconds: 30,
      });
      expect(analysis.style).toBe("clean");
      const plan = finalizeAutoReelPlan(project, analysis, [], undefined, {
        broll: false,
        music: false,
        openingTitle: false,
      });
      const next = applyCommands(project, {
        projectId: project.id,
        revision: project.revision,
        label: plan.label,
        commands: plan.commands,
      });
      expect(plan.proofCount).toBe(0);
      expect(
        next.clips
          .filter((clip) => clip.kind === "caption")
          .every((clip) => clip.accent === creatorShortColors.accent),
      ).toBe(true);
      const keys = onTrack(next, "Reel · footage").flatMap(
        (clip) => clip.keyframes,
      );
      expect(keys.some((key) => key.value === 1.1)).toBe(true);
      expect(keys.some((key) => key.value === 1.025)).toBe(false);
      expect(
        onTrack(next, "Reel · footage").every((clip) => clip.volume === 1),
      ).toBe(true);
    },
  );

  it("Auto edit reframes pause-cut short sentences only at spaced real cuts", () => {
    const project = fixture();
    project.assets[0].words = Array.from({ length: 12 }, (_, sentence) =>
      ["A", "clear", "point."].map((text, index) => ({
        text,
        start: sentence * 2.6 + index * 0.35,
        end: sentence * 2.6 + index * 0.35 + 0.28,
      })),
    ).flat();
    const analysis = analyzeAutoReel(project.assets[0], {
      format: "creator-punch",
      targetSeconds: 30,
    });
    expect(analysis.sources.length).toBeGreaterThan(4);
    const assemble = (beats?: ReelOptions["beats"]) => {
      const plan = finalizeAutoReelPlan(project, analysis, [], undefined, {
        beats,
        openingTitle: false,
      });
      return applyCommands(project, {
        projectId: project.id,
        revision: project.revision,
        label: plan.label,
        commands: plan.commands,
      });
    };
    const next = assemble();
    const emphasis = onTrack(next, "Reel · animations").sort(
      (a, b) => a.start - b.start,
    );
    for (let index = 1; index < emphasis.length; index++)
      expect(
        emphasis[index].start - emphasis[index - 1].start,
      ).toBeGreaterThanOrEqual(project.fps * 8);
    const clips = onTrack(next, "Reel · footage");
    expect(clips.every((clip) => clip.duration < project.fps * 1.8)).toBe(true);
    const scales = clips.map((clip) => evaluatedClip(clip, 0).scale);
    expect(scales).toContain(1.1);
    expect(scales).toContain(1.12);
    let changedAt = clips[0].start;
    for (let index = 1; index < clips.length; index++) {
      if (scales[index] !== scales[index - 1]) {
        expect(clips[index].start - changedAt).toBeGreaterThanOrEqual(
          project.fps * 3,
        );
        changedAt = clips[index].start;
      }
      expect(
        clips[index].keyframes.every(
          (key) => key.frame === 0 && key.easing === "hold",
        ),
      ).toBe(true);
      expect(clips[index].volume).toBe(1);
    }
    expect(
      onTrack(assemble([]), "Reel · footage").every(
        (clip) => clip.keyframes.length === 0,
      ),
    ).toBe(true);
  });

  it("keeps legacy montage and creator education composition unchanged", () => {
    const montage = build(fixture(), { format: "montage" });
    expect(montage.next.motions).toHaveLength(0);
    expect(montage.plan.proofCount).toBe(0);
    const education = build(fixture(), { format: "creator-education" });
    expect(onTrack(education.next, "Reel · footage")[0].y).toBe(576);
    expect(
      education.next.motions.some((motion) =>
        motion.layers.some((layer) => layer.name === "Card"),
      ),
    ).toBe(true);
    expect(
      education.next.clips
        .filter((clip) => clip.kind === "caption")
        .every((clip) => clip.captionStyle === "box"),
    ).toBe(true);
  });
});
