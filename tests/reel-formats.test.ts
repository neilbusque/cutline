import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import {
  newProject,
  makeClip,
  validateProject,
  type Project,
  type Asset,
} from "../src/shared/model";
import {
  createReelPlan,
  ReelOptionsSchema,
  type ReelOptions,
} from "../src/shared/reel";
import { reelFormats } from "../src/shared/reel-formats";

function fixture() {
  const p = newProject();
  const voice: Asset = {
    id: "voice",
    name: "Speaker",
    path: "/local/speaker.mp4",
    kind: "video",
    duration: 60,
    hasAudio: true,
    words: Array.from({ length: 60 }, (_, index) => ({
      text: index % 4 === 3 ? `point${index}.` : `word${index}`,
      start: index,
      end: index + 0.7,
    })),
  };
  p.assets = [
    voice,
    {
      id: "screen",
      name: "Screen",
      path: "/local/screen.png",
      kind: "image",
      duration: 0,
      hasAudio: false,
    },
  ];
  return p;
}
function build(p: Project, patch: Partial<ReelOptions> = {}) {
  const plan = createReelPlan(p, {
    sources: [{ assetId: "voice" }],
    targetSeconds: 30,
    mode: "replace",
    ...patch,
  });
  const next = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: plan.label,
    commands: plan.commands,
  });
  expect(validateProject(next)).toBeTruthy();
  return { plan, next };
}

describe("Reel formats", () => {
  it("retains the existing montage behavior by default", () => {
    const { next, plan } = build(fixture());
    expect(plan.beatCount).toBe(0);
    expect(next.motions).toHaveLength(0);
    expect(next.clips.find((clip) => clip.kind === "video")!.keyframes).toEqual(
      [],
    );
  });

  it.each(reelFormats.filter((format) => format.id !== "montage"))(
    "builds editable $id graphics from actual aligned words",
    (format) => {
      const original = fixture(),
        before = structuredClone(original);
      const { next, plan } = build(original, { format: format.id });
      expect(original).toEqual(before);
      expect(plan.beatCount).toBeGreaterThan(0);
      const teachingMotions =
        format.id === "creator-education"
          ? next.motions.filter(
              (motion) => motion.source === "reel:creator-education",
            )
          : next.motions;
      expect(teachingMotions).toHaveLength(plan.beatCount);
      const captions = next.clips.filter((clip) => clip.kind === "caption");
      expect(
        captions.every((clip) => clip.captionStyle === format.captionStyle),
      ).toBe(true);
      for (const motion of teachingMotions) {
        if (format.id === "creator-punch" || format.id === "screen-demo") {
          expect(motion.layers).toHaveLength(1);
          expect(motion.layers[0].name).toBe("Spoken emphasis");
          expect(motion.layers[0].background).toBe("transparent");
        } else {
          expect(
            motion.layers.find((layer) => layer.name === "Card")!.background,
          ).toBe(format.id === "creator-education" ? "#f7f3e8" : "#101318ed");
        }
        expect(
          motion.layers.some(
            (layer) => layer.type === "text" && layer.text.includes("word"),
          ),
        ).toBe(true);
        expect(
          motion.layers.every((layer) => layer.keyframes.length >= 4),
        ).toBe(true);
        const clip = next.clips.find((item) => item.motionId === motion.id)!;
        expect(clip.preset).toBe("custom");
        expect(clip.start + clip.duration).toBeLessThanOrEqual(
          plan.durationFrames,
        );
        for (const layer of motion.layers) {
          expect(layer.x).toBeGreaterThanOrEqual(next.width * 0.1);
          expect(layer.x + layer.width).toBeLessThanOrEqual(next.width * 0.9);
          expect(layer.y + layer.height).toBeLessThan(
            Math.min(...captions.map((caption) => caption.y)),
          );
        }
      }
    },
  );

  it("keeps the speaker and audio through punch-ins and picture-in-picture B-roll", () => {
    const { next } = build(fixture(), {
      format: "talking-head",
      brollAssetIds: ["screen"],
    });
    const speaker = next.clips.find((clip) => clip.assetId === "voice")!;
    expect(speaker.volume).toBe(1);
    expect(speaker.duration).toBe(900);
    expect(
      speaker.keyframes.some(
        (key) => key.property === "scale" && key.value === 1.06,
      ),
    ).toBe(true);
    const broll = next.clips.filter((clip) => clip.assetId === "screen");
    expect(broll.length).toBeGreaterThan(0);
    for (const clip of broll) {
      expect(clip.width).toBeLessThan(next.width / 2);
      expect(clip.height).toBeLessThan(next.height / 3);
      expect(clip.volume).toBe(0);
    }
  });

  it("uses comma-separated Whisper phrases for callouts and punch-ins", () => {
    const p = fixture();
    p.assets[0].words = p.assets[0].words!.map((word) => ({
      ...word,
      text: word.text.replace(".", ","),
    }));
    const { next, plan } = build(p, { format: "talking-head" });
    expect(plan.beatCount).toBeGreaterThan(1);
    expect(
      next.clips.find((clip) => clip.kind === "video")!.keyframes.length,
    ).toBeGreaterThan(1);
    const text = next.motions[0].layers.find(
      (layer) => layer.type === "text",
    )!.text;
    expect(text).toBe("word0 word1 word2 point3,");
  });

  it("shows imported product media without cropping its screen", () => {
    const { next } = build(fixture(), {
      format: "product-demo",
      sources: [{ assetId: "screen" }],
      beats: [],
    });
    expect(next.clips.find((clip) => clip.assetId === "screen")!.fit).toBe(
      "contain",
    );
  });

  it("maps manual source times across trim, speed, source order and append offset", () => {
    const p = fixture();
    const existing = makeClip(p, "video", "video", 300, p.assets[0]);
    p.clips = [existing];
    const { next, plan } = build(p, {
      mode: "append",
      format: "explainer",
      captionStyle: "outline",
      sources: [
        { assetId: "screen" },
        { assetId: "voice", sourceIn: 10, sourceOut: 30, speed: 2 },
      ],
      beats: [
        {
          sourceIndex: 1,
          sourceSeconds: 14,
          text: "Keep this point",
          kind: "takeaway",
        },
      ],
    });
    expect(next.clips.find((clip) => clip.id === existing.id)).toEqual(
      existing,
    );
    const voice = next.clips.find(
      (clip) => clip.assetId === "voice" && clip.id !== existing.id,
    )!;
    const motion = next.clips.find((clip) => clip.motionId)!;
    expect(motion.start).toBe(voice.start + 2 * p.fps);
    expect(plan.beatCount).toBe(1);
    expect(
      next.clips
        .filter((clip) => clip.kind === "caption")
        .every((clip) => clip.captionStyle === "outline"),
    ).toBe(true);
    expect(plan.startFrame).toBe(existing.start + existing.duration);
  });

  it("does not invent transcript alignment when speech is missing", () => {
    const p = fixture();
    delete p.assets[0].words;
    const { next, plan } = build(p, { format: "listicle" });
    expect(plan.beatCount).toBe(0);
    expect(next.motions).toHaveLength(0);
    expect(plan.warnings.join(" ")).toContain("Transcribe");
    const manual = build(p, {
      format: "listicle",
      beats: [
        {
          sourceIndex: 0,
          sourceSeconds: 3,
          text: "An explicit point",
          kind: "step",
        },
      ],
    });
    expect(manual.plan.beatCount).toBe(1);
  });

  it("requests alignment for animations even when captions are off", () => {
    const p = fixture();
    delete p.assets[0].words;
    expect(
      build(p, { format: "explainer", captions: false }).plan
        .missingTranscriptAssetIds,
    ).toEqual(["voice"]);
    expect(
      build(p, { format: "talking-head", captions: false }).plan
        .missingTranscriptAssetIds,
    ).toEqual(["voice"]);
    expect(
      build(p, { format: "talking-head", captions: false, beats: [] }).plan
        .missingTranscriptAssetIds,
    ).toEqual([]);
    expect(
      build(p, { format: "montage", captions: false }).plan
        .missingTranscriptAssetIds,
    ).toEqual([]);
    expect(
      build(p, { format: "explainer", captions: false, beats: [] }).plan
        .missingTranscriptAssetIds,
    ).toEqual([]);
  });

  it.each([24, 25, 30, 60] as const)(
    "holds settled text at least 1.5 seconds at %i fps",
    (fps) => {
      const p = fixture();
      p.fps = fps;
      const text = Array.from({ length: 30 }, () => "a").join(" ");
      const { next } = build(p, {
        format: "explainer",
        beats: [{ sourceIndex: 0, sourceSeconds: 2, text, kind: "takeaway" }],
      });
      const motion = next.motions[0],
        clip = next.clips.find((item) => item.motionId === motion.id)!;
      const textLayer = motion.layers.find((layer) => layer.type === "text")!;
      const settledAt = Math.max(
        Math.round(fps * 0.3),
        Math.round(fps * 0.4) + 29 * textLayer.staggerFrames,
      );
      const exitAt = textLayer.keyframes.at(-2)!.frame;
      expect(exitAt - settledAt).toBeGreaterThanOrEqual(Math.ceil(fps * 1.5));
      expect(clip.duration).toBeGreaterThan(Math.round(fps * 3));
      expect(() =>
        build(p, {
          beats: [
            {
              sourceIndex: 0,
              sourceSeconds: 28,
              text: "Late point",
              kind: "callout",
            },
          ],
        }),
      ).toThrow("1.5 seconds");
    },
  );

  it("keeps opening animations, closing titles and inset footage from overlapping", () => {
    const { next } = build(fixture(), {
      format: "talking-head",
      hook: "Start here",
      cta: "Save it",
      brollAssetIds: ["screen"],
      beats: [
        {
          sourceIndex: 0,
          sourceSeconds: 2,
          text: "Keep this",
          kind: "callout",
        },
      ],
    });
    const card = next.clips.find((clip) => clip.motionId)!;
    const closing = next.clips.find((clip) => clip.text === "Save it")!;
    for (const inset of next.clips.filter(
      (clip) => clip.assetId === "screen",
    )) {
      expect(
        inset.start >= card.start + card.duration ||
          inset.start + inset.duration <= card.start,
      ).toBe(true);
      expect(inset.start + inset.duration).toBeLessThanOrEqual(closing.start);
    }
    const p = fixture();
    p.assets[0].duration = 4;
    const short = build(p, {
      format: "talking-head",
      hook: "Open",
      cta: "Close",
      beats: [
        { sourceIndex: 0, sourceSeconds: 0, text: "Point", kind: "callout" },
      ],
    });
    const motion = short.next.motions[0];
    const hook = short.next.clips.find((clip) => clip.text === "Open")!,
      cta = short.next.clips.find((clip) => clip.text === "Close")!;
    expect(motion.layers[0].y).toBeGreaterThan(hook.y + hook.height);
    expect(motion.layers[0].y + motion.layers[0].height).toBeLessThan(cta.y);
  });

  it("can explicitly disable automatic animations", () => {
    const { plan } = build(fixture(), { format: "explainer", beats: [] });
    expect(plan.beatCount).toBe(0);
    expect(plan.warnings.join(" ")).not.toContain("No timed animations");
    const disabled = build(fixture(), {
      format: "talking-head",
      captions: false,
      beats: [],
    });
    expect(
      disabled.next.clips.find((clip) => clip.kind === "video")!.keyframes,
    ).toEqual([]);
    expect(disabled.plan.missingTranscriptAssetIds).toEqual([]);
  });

  it("reserves title and caption bands while animations are visible", () => {
    const { next } = build(fixture(), {
      format: "listicle",
      hook: "Open here",
      cta: "Save it",
      beats: [
        { sourceIndex: 0, sourceSeconds: 0, text: "First point", kind: "step" },
      ],
    });
    const title = next.clips.find((clip) => clip.text === "Open here")!;
    const motion = next.motions[0];
    expect(motion.layers[0].y).toBeGreaterThan(title.y + title.height);
  });

  it("validates exact timing, source references, spacing and bounded text atomically", () => {
    const p = fixture(),
      original = structuredClone(p);
    expect(() =>
      build(p, {
        beats: [
          {
            sourceIndex: 9,
            sourceSeconds: 1,
            text: "Bad source",
            kind: "callout",
          },
        ],
      }),
    ).toThrow("missing or outside");
    expect(() =>
      build(p, {
        sources: [{ assetId: "voice", sourceIn: 10 }],
        beats: [
          {
            sourceIndex: 0,
            sourceSeconds: 2,
            text: "Before trim",
            kind: "callout",
          },
        ],
      }),
    ).toThrow("source range");
    expect(() =>
      build(p, {
        beats: [
          {
            sourceIndex: 0,
            sourceSeconds: 29.9,
            text: "Too late",
            kind: "callout",
          },
        ],
      }),
    ).toThrow("1.5 seconds");
    expect(() =>
      build(p, {
        beats: [
          { sourceIndex: 0, sourceSeconds: 2, text: "One", kind: "step" },
          { sourceIndex: 0, sourceSeconds: 2.1, text: "Two", kind: "step" },
        ],
      }),
    ).toThrow("1.5 seconds");
    const base = { sources: [{ assetId: "voice" }], targetSeconds: 30 };
    expect(
      ReelOptionsSchema.safeParse({ ...base, format: "unsupported" }).success,
    ).toBe(false);
    expect(
      ReelOptionsSchema.safeParse({
        ...base,
        beats: [
          {
            sourceIndex: 0,
            sourceSeconds: NaN,
            text: "Point",
            kind: "callout",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ReelOptionsSchema.safeParse({
        ...base,
        beats: [
          {
            sourceIndex: 0,
            sourceSeconds: 2,
            text: "x".repeat(81),
            kind: "callout",
          },
        ],
      }).success,
    ).toBe(false);
    expect(p).toEqual(original);
  });
});
