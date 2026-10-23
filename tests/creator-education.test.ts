import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import {
  makeClip,
  newProject,
  validateProject,
  type Project,
  type Asset,
} from "../src/shared/model";
import { createReelPlan, type ReelOptions } from "../src/shared/reel";
import {
  creatorBrollWindow,
  creatorEducationColors,
  creatorTitlePlacement,
} from "../src/shared/creator-education";
import { captionTextWidth } from "../src/shared/caption-layout";

function fixture(): Project {
  const p = newProject();
  const voice: Asset = {
    id: "speaker",
    name: "Teaching.mov",
    path: "/local/teaching.mov",
    kind: "video",
    duration: 35,
    hasAudio: true,
    words: Array.from({ length: 64 }, (_, index) => ({
      text: index % 8 === 7 ? `idea${index}.` : `word${index}`,
      start: index * 0.5,
      end: index * 0.5 + 0.36,
    })),
  };
  p.assets = [
    voice,
    {
      id: "diagram",
      name: "Imported screen",
      path: "/local/screen.png",
      kind: "image",
      duration: 0,
      hasAudio: false,
    },
  ];
  return p;
}
function build(p: Project, options: Partial<ReelOptions> = {}) {
  const plan = createReelPlan(p, {
    sources: [{ assetId: "speaker" }],
    targetSeconds: 30,
    mode: "replace",
    format: "creator-education",
    ...options,
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
function cards(p: Project) {
  const motions = p.motions.filter(
    (motion) => motion.source === "reel:creator-education",
  );
  return motions.map((motion) => ({
    motion,
    clip: p.clips.find((clip) => clip.motionId === motion.id)!,
  }));
}

describe("Creator education Reel format", () => {
  it("keeps clean speaker footage below the teaching area and compact dark-ink caption pills", () => {
    const { next } = build(fixture());
    const speaker = next.clips.find((clip) => clip.assetId === "speaker")!;
    expect([speaker.volume, speaker.fadeIn, speaker.fadeOut]).toEqual([
      1, 0, 0,
    ]);
    expect([speaker.y, speaker.height, speaker.look, speaker.overlay]).toEqual([
      576,
      1344,
      "none",
      "none",
    ]);
    const captions = next.clips.filter((clip) => clip.kind === "caption");
    expect(captions.length).toBeGreaterThan(5);
    for (const caption of captions) {
      expect(caption.captionSourceId).toBe(speaker.id);
      expect(caption.words.length).toBeGreaterThanOrEqual(3);
      expect(caption.words.length).toBeLessThanOrEqual(4);
      expect(caption.captionStyle).toBe("box");
      expect(caption.background).toBe(creatorEducationColors.caption);
      expect(caption.color).toBe(creatorEducationColors.ink);
      expect(caption.accent).toBe(creatorEducationColors.teal);
      expect(caption.captionStrokeWidth).toBe(0);
      expect(caption.captionMaxLines).toBe(1);
      expect(caption.height).toBeLessThan(next.height * 0.06);
      expect(caption.y).toBeGreaterThan(next.height * 0.8);
      expect(caption.y + caption.height).toBeLessThan(next.height * 0.9);
      expect(caption.x + caption.width / 2).toBe(next.width / 2);
      expect(caption.width).toBeLessThanOrEqual(next.width * 0.78);
    }
    expect(
      speaker.keyframes.some(
        (key) => key.property === "scale" && key.value === 1.06,
      ),
    ).toBe(true);
  });

  it.each([
    ["bold", "vivid"],
    ["cinematic", "cinematic"],
  ] as const)("keeps an explicitly selected %s footage look", (style, look) => {
    const { next } = build(fixture(), { style, brollAssetIds: ["diagram"] });
    expect(next.clips.find((clip) => clip.assetId === "speaker")!.look).toBe(
      look,
    );
    expect(
      next.clips
        .filter((clip) => clip.assetId === "diagram")
        .every((clip) => clip.look === look),
    ).toBe(true);
  });

  it("alternates editable idea cards, numbered step diagrams and takeaways without fabricated copy", () => {
    const p = fixture(),
      before = structuredClone(p);
    const { next, plan } = build(p);
    expect(p).toEqual(before);
    const teaching = cards(next);
    expect(teaching.length).toBeGreaterThanOrEqual(3);
    expect(plan.beatCount).toBe(teaching.length);
    expect(
      teaching[0].motion.layers.some((layer) => layer.name === "Callout"),
    ).toBe(true);
    expect(
      teaching[1].motion.layers.some(
        (layer) => layer.name === "Step node" && layer.type === "ellipse",
      ),
    ).toBe(true);
    expect(
      teaching[1].motion.layers.some(
        (layer) => layer.name === "Step connector" && layer.type === "line",
      ),
    ).toBe(true);
    expect(
      teaching[1].motion.layers.find((layer) => layer.name === "Step number")!
        .text,
    ).toBe("01");
    expect(
      teaching[2].motion.layers.some((layer) => layer.name === "Takeaway"),
    ).toBe(true);
    for (const { motion, clip } of teaching) {
      expect(clip.preset).toBe("custom");
      expect(
        motion.layers.find((layer) => layer.name === "Card")!.background,
      ).toBe(creatorEducationColors.cream);
      expect(
        motion.layers.some((layer) =>
          /underline|accent line/i.test(layer.name ?? ""),
        ),
      ).toBe(false);
      const text = motion.layers.find((layer) =>
        ["Callout", "Step title", "Takeaway"].includes(layer.name ?? ""),
      )!.text;
      expect(
        text
          .split(" ")
          .every((word) =>
            p.assets[0].words!.some((item) => item.text === word),
          ),
      ).toBe(true);
      for (const layer of motion.layers) {
        expect(
          layer.y + layer.height + Math.round(next.height * 0.013),
        ).toBeLessThan(next.height * 0.279);
        expect(
          layer.keyframes.at(-2)!.frame -
            Math.max(
              Math.round(next.fps * 0.3),
              layer.textAnimation === "word-rise"
                ? Math.round(next.fps * 0.4) + (text.split(" ").length - 1) * 2
                : 0,
            ),
        ).toBeGreaterThanOrEqual(next.fps * 1.5);
      }
    }
  });

  it("keeps explicit beat text and kinds, and respects a different caption treatment", () => {
    const { next } = build(fixture(), {
      captionStyle: "outline",
      beats: [
        {
          sourceIndex: 0,
          sourceSeconds: 1,
          text: "Your exact point",
          kind: "takeaway",
        },
        {
          sourceIndex: 0,
          sourceSeconds: 6,
          text: "Your next step",
          kind: "step",
        },
      ],
    });
    expect(cards(next)).toHaveLength(2);
    expect(
      cards(next)[0].motion.layers.find((layer) => layer.name === "Takeaway")!
        .text,
    ).toBe("Your exact point");
    expect(
      cards(next)[1].motion.layers.find((layer) => layer.name === "Step title")!
        .text,
    ).toBe("Your next step");
    expect(
      next.clips
        .filter((clip) => clip.kind === "caption")
        .every(
          (caption) =>
            caption.captionStyle === "outline" &&
            caption.background === "transparent" &&
            caption.captionCase === "upper",
        ),
    ).toBe(true);
  });

  it.each([24, 25, 30, 60] as const)(
    "preserves source alignment through trim, speed and append at %i fps",
    (fps) => {
      const p = fixture();
      p.fps = fps;
      p.background = "#060606";
      const old = makeClip(p, "text", "titles", 0);
      old.duration = fps * 2;
      old.text = "Existing edit";
      p.clips = [old];
      const { plan, next } = build(p, {
        mode: "append",
        sources: [
          { assetId: "speaker", sourceIn: 10, sourceOut: 25, speed: 1.5 },
        ],
        beats: [
          {
            sourceIndex: 0,
            sourceSeconds: 13,
            text: "An aligned takeaway",
            kind: "takeaway",
          },
        ],
      });
      expect(next.background).toBe(p.background);
      expect(next.clips.find((clip) => clip.id === old.id)).toEqual(old);
      const speaker = next.clips.find((clip) => clip.assetId === "speaker")!;
      expect(cards(next)[0].clip.start).toBe(speaker.start + fps * 2);
      expect(plan.startFrame).toBe(old.duration);
      const backdrop = next.motions.find(
        (motion) => motion.source === "reel:creator-education-background",
      )!;
      const backingClip = next.clips.find(
        (clip) => clip.motionId === backdrop.id,
      )!;
      expect(backdrop.layers[0].background).toBe(creatorEducationColors.canvas);
      expect(backingClip.start).toBe(plan.startFrame);
      expect(backingClip.duration).toBe(plan.durationFrames);
      expect(
        next.tracks.findIndex((track) => track.id === backingClip.trackId),
      ).toBeGreaterThan(
        next.tracks.findIndex((track) => track.id === speaker.trackId),
      );
      for (const caption of next.clips.filter(
        (clip) => clip.kind === "caption",
      )) {
        for (const word of caption.words) {
          const original = p.assets[0].words!.find(
            (item) => item.text === word.text,
          )!;
          const mapped =
            speaker.sourceIn +
            ((caption.start - speaker.start) / fps + word.start) *
              speaker.speed;
          expect(Math.abs(mapped - original.start)).toBeLessThanOrEqual(
            speaker.speed / fps + 1e-7,
          );
          expect(word.end).toBeLessThanOrEqual(caption.duration / fps);
        }
      }
    },
  );

  it("keeps an imported phrase as one aligned cue with a readable two-line fallback", () => {
    const p = fixture();
    const text =
      "A longer imported subtitle phrase keeps its original timing without inventing timestamps for individual spoken words.";
    p.assets[0].words = [{ text, start: 1, end: 5 }];
    const { next } = build(p, { beats: [] });
    const caption = next.clips.find((clip) => clip.kind === "caption")!;
    expect(caption.words).toEqual([{ text, start: 0, end: 4 }]);
    expect(caption.captionMaxLines).toBe(2);
    expect(caption.height).toBeGreaterThan(100);
    expect(caption.y + caption.height).toBeLessThanOrEqual(
      next.height * 0.9 + 1,
    );
  });

  it("turns off cards and punch-ins explicitly and does not invent missing speech", () => {
    const disabled = build(fixture(), { beats: [] });
    expect(cards(disabled.next)).toHaveLength(0);
    expect(
      disabled.next.clips.find((clip) => clip.assetId === "speaker")!.keyframes,
    ).toEqual([]);
    const p = fixture();
    delete p.assets[0].words;
    const empty = build(p);
    expect(cards(empty.next)).toHaveLength(0);
    expect(empty.plan.captionCount).toBe(0);
    expect(empty.plan.missingTranscriptAssetIds).toEqual(["speaker"]);
  });

  it("keeps supporting B-roll clear of the speaker, captions and active teaching cards", () => {
    const { next } = build(fixture(), { brollAssetIds: ["diagram"] });
    const speaker = next.clips.find((clip) => clip.assetId === "speaker")!;
    const supporting = next.clips.filter((clip) => clip.assetId === "diagram");
    expect(supporting.length).toBeGreaterThan(0);
    for (const clip of supporting) {
      expect(clip.volume).toBe(0);
      expect(
        next.tracks.find((track) => track.id === clip.trackId)!.muted,
      ).toBe(true);
      expect(clip.y + clip.height).toBeLessThan(speaker.y);
      expect(clip.fit).toBe("contain");
      expect(clip.keyframes).toEqual([]);
      expect(
        cards(next).some(
          (card) =>
            clip.start < card.clip.start + card.clip.duration &&
            clip.start + clip.duration > card.clip.start,
        ),
      ).toBe(false);
    }
    expect(
      creatorBrollWindow(90, 90, [
        { start: 0, duration: 120 },
        { start: 150, duration: 90 },
      ]),
    ).toEqual({ start: 120, frames: 30 });
  });

  it("fits long opening and closing copy inside its actual title band", () => {
    const hook =
      "Learn one useful idea and put it into practice with a clear example and a simple next step today. Repeat it every week.".slice(
        0,
        120,
      );
    const { next } = build(fixture(), {
      hook,
      cta: hook,
      beats: [
        {
          sourceIndex: 0,
          sourceSeconds: 0,
          text: "A clear idea",
          kind: "callout",
        },
      ],
    });
    const title = next.clips.find(
      (clip) => clip.text === hook && !clip.motionId,
    )!;
    const titlePatch = creatorTitlePlacement(next, hook);
    expect(title.fontSize).toBe(titlePatch.fontSize);
    const width = title.width - 24;
    let lines = 1,
      line = "";
    for (const word of hook.split(/\s+/u)) {
      if (
        line &&
        captionTextWidth(
          `${line} ${word}`,
          title.fontSize,
          "Helvetica",
          "600",
          0,
        ) > width
      ) {
        lines++;
        line = "";
      }
      line += `${line ? " " : ""}${word}`;
    }
    expect(lines * title.fontSize * 1.18 + 24).toBeLessThanOrEqual(
      title.height,
    );
    const card = cards(next)[0].motion.layers.find(
      (layer) => layer.name === "Card",
    )!;
    expect(title.y + title.height).toBeLessThan(card.y);
  });
});
