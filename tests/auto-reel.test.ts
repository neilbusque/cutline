import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import { animatedValue } from "../src/shared/animation";
import {
  newProject,
  validateProject,
  type Asset,
  type Clip,
  type Word,
} from "../src/shared/model";
import {
  analyzeAutoReel,
  finalizeAutoReelPlan,
  type AutoReelAnalysis,
} from "../src/shared/auto-reel";

function sentence(text: string, start: number, step = 0.6): Word[] {
  return text.split(/\s+/).map((text, index) => ({
    text,
    start: start + index * step,
    end: start + index * step + step * 0.7,
  }));
}
function source(words: Word[], duration = 40): Asset {
  return {
    id: "source",
    name: "Talking head.mov",
    kind: "video",
    path: "/local/source.mov",
    duration,
    hasAudio: true,
    words,
  };
}
function sample(): Asset {
  return source([
    ...sentence(
      "Fresh coffee beans make your morning espresso taste much better with careful preparation.",
      1,
    ),
    ...sentence(
      "Mountain hiking brings beautiful scenery and requires good boots plus a reliable water bottle.",
      22,
    ),
  ]);
}
function projectFor(asset: Asset) {
  const p = newProject();
  p.assets = [
    asset,
    {
      id: "coffee-stock",
      kind: "video",
      name: "Coffee.mp4",
      path: "/local/coffee.mp4",
      duration: 10,
      hasAudio: true,
    },
    {
      id: "mountain-stock",
      kind: "image",
      name: "Mountain.jpg",
      path: "/local/mountain.jpg",
      duration: 0,
      hasAudio: false,
    },
    {
      id: "music",
      kind: "audio",
      name: "Original music.wav",
      path: "/local/music.wav",
      duration: 90,
      hasAudio: true,
    },
  ];
  return p;
}
function applyPlan(
  p: ReturnType<typeof projectFor>,
  analysis: AutoReelAnalysis,
  withStock = true,
) {
  const placements = withStock
    ? analysis.beats.map((beat, index) => ({
        assetId: index % 2 ? "mountain-stock" : "coffee-stock",
        startSeconds: beat.startSeconds,
        durationSeconds: beat.durationSeconds,
        query: beat.query,
      }))
    : [];
  const plan = finalizeAutoReelPlan(p, analysis, placements, "music");
  const next = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: plan.label,
    commands: plan.commands,
  });
  return { plan, next };
}

describe("Automatic one-video analysis", () => {
  it("offers tighter pacing while preserving every spoken word and source order", () => {
    const words = [
      { text: "Keep", start: 1, end: 1.5 },
      { text: "this.", start: 2.1, end: 2.5 },
    ];
    const asset = source(words, 3);
    const natural = analyzeAutoReel(asset, { pace: "natural" });
    const tight = analyzeAutoReel(asset, { pace: "tight" });
    expect(natural.sources).toHaveLength(1);
    expect(tight.sources).toHaveLength(2);
    expect(tight.durationSeconds).toBeLessThan(natural.durationSeconds);
    for (const word of words)
      expect(
        tight.sources.some(
          (s) => s.sourceIn! <= word.start && s.sourceOut! >= word.end,
        ),
      ).toBe(true);
    expect(() => analyzeAutoReel(asset, { pace: "unknown" as any })).toThrow(
      "pacing",
    );
  });

  it("removes long pauses while preserving ordered speech and small handles without mutating the video", () => {
    const asset = sample(),
      before = structuredClone(asset);
    const analysis = analyzeAutoReel(asset);
    expect(analysis.sources).toHaveLength(2);
    expect(analysis.sources[0].sourceIn).toBeCloseTo(0.88);
    expect(analysis.sources[1].sourceIn).toBeCloseTo(21.88);
    expect(analysis.sources[0].sourceOut).toBeLessThan(
      analysis.sources[1].sourceIn!,
    );
    expect(analysis.durationSeconds).toBeLessThan(20);
    expect(analysis.warnings.join(" ")).toContain("long pauses");
    expect(asset).toEqual(before);
    expect(
      analysis.hook
        .split(" ")
        .every((word) => asset.words!.some((item) => item.text === word)),
    ).toBe(true);
  });

  it("keeps breathing gaps shorter than the pause threshold inside the source shot", () => {
    const asset = source(
      [
        { text: "Say", start: 1, end: 1.5 },
        { text: "this.", start: 2.1, end: 2.5 },
      ],
      3,
    );
    const analysis = analyzeAutoReel(asset);
    expect(analysis.sources).toHaveLength(1);
    expect(analysis.sources[0].sourceIn).toBeCloseTo(0.88);
    expect(analysis.sources[0].sourceOut).toBeCloseTo(2.68);
  });

  it("chooses an ending after a completed sentence rather than cutting a word at sixty seconds", () => {
    const words = Array.from({ length: 20 }, (_, index) =>
      sentence(
        `This passage has specific information about coffee beans and preparation.`,
        index * 5,
        0.45,
      ),
    ).flat();
    const asset = source(words, 110),
      analysis = analyzeAutoReel(asset);
    const last = analysis.sources.at(-1)!;
    const kept = words.filter((word) => word.end <= last.sourceOut!);
    expect(kept.at(-1)!.text).toMatch(/[.!?]$/);
    expect(analysis.durationSeconds).toBeLessThanOrEqual(60);
    expect(last.sourceOut).toBeGreaterThanOrEqual(kept.at(-1)!.end);
    expect(analysis.durationSeconds).toBeGreaterThan(50);
  });

  it("allows a complete first sentence up to ninety seconds in Best fit mode", () => {
    const words = Array.from({ length: 80 }, (_, index) => ({
      text: index === 69 || index === 79 ? "end." : `word${index}`,
      start: index,
      end: index + 0.6,
    }));
    const analysis = analyzeAutoReel(source(words, 82));
    expect(analysis.targetSeconds).toBe(90);
    expect(analysis.durationSeconds).toBeGreaterThan(69);
    expect(analysis.durationSeconds).toBeLessThanOrEqual(71);
    expect(analysis.sources.at(-1)!.sourceOut).toBeGreaterThanOrEqual(
      words[69].end,
    );
  });

  it.each([15, 30, 60, 90] as const)(
    "honors an explicit %is target at a completed sentence or whole word boundary",
    (targetSeconds) => {
      const words = Array.from({ length: 120 }, (_, index) => ({
        text: index % 9 === 8 ? "complete." : "speech",
        start: index,
        end: index + 0.5,
      }));
      const asset = source(words, 120),
        analysis = analyzeAutoReel(asset, { targetSeconds });
      expect(analysis.targetSeconds).toBe(targetSeconds);
      expect(analysis.durationSeconds).toBeLessThanOrEqual(targetSeconds);
      expect(analysis.sources.at(-1)!.sourceOut).toBeLessThanOrEqual(
        asset.duration,
      );
      const last = words
        .filter((word) => word.end <= analysis.sources.at(-1)!.sourceOut!)
        .at(-1)!;
      expect(last.text).toBe("complete.");
    },
  );

  it("reports a whole-word fallback when no sentence boundary fits rather than claiming a complete passage", () => {
    const words = Array.from({ length: 50 }, (_, index) => ({
      text: "unpunctuated",
      start: index * 0.6,
      end: index * 0.6 + 0.5,
    }));
    const asset = source(words, 32),
      analysis = analyzeAutoReel(asset, { targetSeconds: 15 });
    expect(analysis.durationSeconds).toBeLessThanOrEqual(15);
    expect(analysis.warnings.join(" ")).toContain("review the final thought");
    const retained = words.filter(
      (word) =>
        word.start >= analysis.sources[0].sourceIn! &&
        word.start < analysis.sources.at(-1)!.sourceOut!,
    );
    expect(
      retained.every((word) => word.end <= analysis.sources.at(-1)!.sourceOut!),
    ).toBe(true);
  });

  it("handles silent or untranscribed videos without inventing hooks, captions or relevant stock topics", () => {
    for (const hasAudio of [true, false]) {
      const asset = { ...source([], 18), hasAudio };
      const analysis = analyzeAutoReel(asset);
      expect(analysis.durationSeconds).toBe(18);
      expect(analysis.beats).toEqual([]);
      expect(analysis.hook).toBe("");
      expect(analysis.speechRanges).toEqual([]);
      expect(analysis.warnings).toHaveLength(1);
      const { plan } = applyPlan(projectFor(asset), analysis);
      expect(plan.captionCount).toBe(0);
    }
    expect(() =>
      analyzeAutoReel({ ...source([], 0.001), hasAudio: false }),
    ).toThrow("shorter than one");
    expect(() => analyzeAutoReel({ ...source([], 3), kind: "image" })).toThrow(
      "one video",
    );
  });

  it("suggests only transcript-grounded stock searches timed to the condensed story", () => {
    const analysis = analyzeAutoReel(sample());
    expect(analysis.beats.length).toBeGreaterThanOrEqual(2);
    expect(analysis.beats[0].query).toBe("coffee beans");
    expect(analysis.beats[1].query).toBe("mountain");
    expect(analysis.beats[1].startSeconds).toBeLessThan(12);
    for (const beat of analysis.beats) {
      expect(beat.reason).toContain("Transcript mentions");
      expect(beat.startSeconds).toBeGreaterThanOrEqual(2.5);
      expect(beat.startSeconds + beat.durationSeconds).toBeLessThanOrEqual(
        analysis.durationSeconds - 1.5 + 1e-7,
      );
    }
  });

  it("allows a recurring spoken topic after a twelve-second gap while keeping cutaways spaced", () => {
    const words = Array.from({ length: 10 }, (_, index) =>
      sentence(
        "Coffee beans need careful preparation for your morning espresso at home.",
        index * 5.8,
        0.55,
      ),
    ).flat();
    const analysis = analyzeAutoReel(source(words, 60));
    expect(analysis.beats.length).toBeGreaterThan(2);
    for (let index = 1; index < analysis.beats.length; index++)
      expect(
        analysis.beats[index].startSeconds -
          analysis.beats[index - 1].startSeconds,
      ).toBeGreaterThanOrEqual(12);
    expect(
      analysis.beats.every((beat) =>
        ["coffee", "coffee beans", "espresso"].includes(beat.query),
      ),
    ).toBe(true);
  });

  it("anchors searches to the spoken subject, so drinking wine never asks for water", () => {
    const wine = analyzeAutoReel(
      source(
        sentence(
          "Drinking wine slowly lets you notice grapes and the different flavors in every glass.",
          1,
          0.7,
        ),
        18,
      ),
    );
    expect(wine.beats.length).toBeGreaterThan(0);
    expect(wine.beats.some((beat) => beat.query === "drinking wine")).toBe(
      true,
    );
    expect(wine.beats.every((beat) => !/water/.test(beat.query))).toBe(true);
    const water = analyzeAutoReel(
      source(
        sentence(
          "Drinking water regularly supports hydration and helps you feel refreshed during the afternoon.",
          1,
          0.7,
        ),
        18,
      ),
    );
    expect(water.beats[0].query).toBe("drinking water");
    const ocean = analyzeAutoReel(
      source(
        sentence(
          "The ocean has remarkable waves and the coastline changes beautifully through every season.",
          1,
          0.7,
        ),
        18,
      ),
    );
    expect(ocean.beats[0].query).toBe("ocean");
  });

  it("keeps concrete actions and adjacent objects in searches, with inherited coffee context for beans", () => {
    const analysis = analyzeAutoReel(
      source(
        [
          ...sentence(
            "A better morning starts with freshly roasted coffee.",
            0,
            0.3,
          ),
          ...sentence(
            "Grind the beans just before brewing for a balanced cup every morning.",
            2.8,
            0.35,
          ),
          ...sentence(
            "Drink your coffee slowly while sitting comfortably at the kitchen table.",
            9,
            0.4,
          ),
        ],
        16,
      ),
    );
    expect(analysis.beats[0]).toMatchObject({
      query: "grinding coffee beans",
      subjects: ["coffee"],
      actions: ["grind"],
    });
    expect(
      analysis.beats.some((beat) => beat.query === "drinking coffee"),
    ).toBe(true);
    expect(
      analysis.beats[0].startSeconds + analysis.beats[0].durationSeconds,
    ).toBeLessThan(9);
    expect(
      analysis.beats.every((beat) =>
        beat.searchQueries!.every((query) => query.split(/\s+/).length <= 4),
      ),
    ).toBe(true);
  });

  it.each([
    "Do not drink coffee before sleep because it can interrupt a peaceful night.",
    "Avoid coffee and espresso because these are not part of our evening routine.",
    "We never use a camera or a microphone during these private conversations.",
  ])("does not illustrate negated topics as recommendations: %s", (text) => {
    const analysis = analyzeAutoReel(source(sentence(text, 1, 0.4), 14));
    expect(analysis.beats).toEqual([]);
  });

  it("resumes positive topics after a contrast without resurrecting the rejected subject", () => {
    const analysis = analyzeAutoReel(
      source(
        sentence(
          "Skip drinking coffee but drink tea slowly during a quiet break in the afternoon.",
          1,
          0.45,
        ),
        16,
      ),
    );
    expect(analysis.beats[0]).toMatchObject({
      query: "drinking tea",
      subjects: ["tea"],
      actions: ["drink"],
    });
    expect(analysis.beats.every((beat) => !beat.query.includes("coffee"))).toBe(
      true,
    );
  });

  it("does not turn completed states or tool names in speech into process requests", () => {
    const roasted = analyzeAutoReel(
      source(
        sentence(
          "Freshly roasted coffee beans smell wonderful while resting in a bowl on the kitchen table.",
          1,
          0.45,
        ),
        18,
      ),
    );
    expect(roasted.beats[0].actions).toEqual([]);
    const grinder = analyzeAutoReel(
      source(
        sentence(
          "The coffee grinder is stored safely on the shelf in our bright kitchen every morning.",
          1,
          0.45,
        ),
        18,
      ),
    );
    expect(grinder.beats[0].actions).toEqual([]);
  });

  it("does not borrow a different subject's action or inherit coffee across distant topics", () => {
    const analysis = analyzeAutoReel(
      source(
        [
          ...sentence(
            "Coffee tastes delightful when it is prepared carefully every morning at home.",
            0,
            0.4,
          ),
          ...sentence(
            "Wash the car before grinding spices in the kitchen this afternoon.",
            9,
            0.5,
          ),
        ],
        20,
      ),
    );
    expect(
      analysis.beats.some((beat) => beat.query === "grinding spices"),
    ).toBe(true);
    expect(analysis.beats.every((beat) => beat.query !== "grinding car")).toBe(
      true,
    );
  });

  it("uses concrete literal nouns for unmapped topics, with no unrelated lifestyle fallback", () => {
    const asset = source(
      sentence(
        "The microscope lets us inspect a laboratory experiment with careful attention to every sample.",
        1,
        0.7,
      ),
      16,
    );
    const analysis = analyzeAutoReel(asset);
    expect(
      analysis.beats.some((beat) => beat.keywords.includes("microscope")),
    ).toBe(true);
    expect(
      analysis.beats.every((beat) => !/coffee|beach|meeting/.test(beat.query)),
    ).toBe(true);
  });

  it.each([
    "Success requires authenticity and resilience through this journey toward purpose and potential in life.",
    "We are running a business and need a concrete strategy to store our values clearly.",
    "You can book a call and have a better approach with more focus and clarity today.",
  ])(
    "skips abstract or ambiguous speech instead of choosing unsupported scenes: %s",
    (text) => {
      const analysis = analyzeAutoReel(source(sentence(text, 1, 0.6), 20));
      expect(analysis.beats).toEqual([]);
      expect(analysis.warnings.join(" ")).toContain(
        "No concrete transcript topic",
      );
    },
  );
});

describe("Automatic Reel final assembly", () => {
  it("respects explicit music and B-roll opt-outs without reporting them as unavailable", () => {
    const asset = sample(),
      p = projectFor(asset),
      analysis = analyzeAutoReel(asset),
      beat = analysis.beats[0];
    const plan = finalizeAutoReelPlan(
      p,
      analysis,
      [{ assetId: "coffee-stock", ...beat }],
      "music",
      { broll: false, music: false },
    );
    const clips = plan.commands.flatMap((command) =>
      command.type === "clip.add" ? [command.clip] : [],
    );
    expect(plan.brollCount).toBe(0);
    expect(
      clips.some(
        (clip) => clip.assetId === "coffee-stock" || clip.assetId === "music",
      ),
    ).toBe(false);
    expect(plan.warnings.join(" ")).not.toMatch(
      /No relevant stock|No music bed/,
    );
    const abstract = source(
      sentence(
        "Success means finding purpose and clarity with more resilience and authenticity every single day.",
        0,
      ),
      12,
    );
    const abstractPlan = finalizeAutoReelPlan(
      projectFor(abstract),
      analyzeAutoReel(abstract),
      [],
      undefined,
      { broll: false, music: false },
    );
    expect(abstractPlan.warnings.join(" ")).not.toContain(
      "No concrete transcript topic",
    );
  });

  it.each([24, 25, 30, 60] as const)(
    "keeps captions and exact stock beat placement aligned after pause removal at %ifps",
    (fps) => {
      const asset = sample(),
        p = projectFor(asset);
      p.fps = fps;
      const analysis = analyzeAutoReel(asset, { fps }),
        { plan, next } = applyPlan(p, analysis);
      expect(validateProject(next)).toBeTruthy();
      expect(plan.durationFrames / fps).toBeCloseTo(analysis.durationSeconds);
      const footage = next.clips.filter((clip) => clip.assetId === asset.id);
      const originalMountain = asset.words!.find(
        (word) => word.text === "Mountain",
      )!;
      const expected =
        footage[1].start / fps + originalMountain.start - footage[1].sourceIn;
      const caption = next.clips.find(
        (clip) =>
          clip.kind === "caption" &&
          clip.words.some((word) => word.text === "Mountain"),
      )!;
      const word = caption.words.find((word) => word.text === "Mountain")!;
      expect(caption.start / fps + word.start).toBeCloseTo(expected);
      const cutaways = next.clips.filter(
        (clip) =>
          clip.assetId === "coffee-stock" || clip.assetId === "mountain-stock",
      );
      expect(cutaways.map((clip) => clip.start)).toEqual(
        analysis.beats.map((beat) => Math.round(beat.startSeconds * fps)),
      );
      expect(plan.brollCount).toBe(cutaways.length);
      for (const clip of cutaways) {
        expect(clip.volume).toBe(0);
        expect(
          next.tracks.find((track) => track.id === clip.trackId)?.muted,
        ).toBe(true);
        expect(clip.start + clip.duration).toBeLessThanOrEqual(
          plan.durationFrames,
        );
      }
      for (const clip of footage)
        expect([clip.volume, clip.fadeIn, clip.fadeOut]).toEqual([1, 0, 0]);
    },
  );

  it("preserves source audio with subtle editable motion and ducks music while speech is active", () => {
    const asset = sample(),
      p = projectFor(asset),
      analysis = analyzeAutoReel(asset),
      { next } = applyPlan(p, analysis);
    const footage = next.clips.filter((clip) => clip.assetId === asset.id);
    for (const clip of footage) {
      expect(clip.volume).toBe(1);
      expect(clip.cameraMotion).toBe("none");
      expect(clip.keyframes.length).toBeGreaterThan(1);
      expect(
        clip.keyframes.every(
          (key) =>
            key.property === "scale" && key.value >= 1 && key.value <= 1.045,
        ),
      ).toBe(true);
    }
    const music = next.clips.find((clip) => clip.assetId === "music")!;
    const during = Math.ceil(
      (analysis.speechRanges[0].startSeconds + 0.2) * p.fps,
    );
    expect(animatedValue(music, "volume", during)).toBeCloseTo(0.075);
    expect(music.fadeOut).toBeGreaterThan(0);
    expect(music.keyframes.every((key) => key.frame < music.duration)).toBe(
      true,
    );
  });

  it("raises music only during genuine speech gaps with smooth bounded ramps", () => {
    const asset = source(
      [
        { text: "First", start: 1, end: 2 },
        { text: "next.", start: 2.75, end: 4 },
      ],
      5,
    );
    const p = projectFor(asset),
      analysis = analyzeAutoReel(asset),
      { next } = applyPlan(p, analysis, false);
    const music = next.clips.find((clip) => clip.assetId === "music")!;
    expect(analysis.speechRanges).toHaveLength(2);
    const middleGap =
      (analysis.speechRanges[0].endSeconds +
        analysis.speechRanges[1].startSeconds) /
      2;
    expect(
      animatedValue(music, "volume", Math.round(middleGap * p.fps)),
    ).toBeCloseTo(0.18);
    expect(
      animatedValue(
        music,
        "volume",
        Math.round((analysis.speechRanges[1].startSeconds + 0.2) * p.fps),
      ),
    ).toBeCloseTo(0.075);
  });

  it("keeps the main video when stock lookup has no relevant results", () => {
    const asset = sample(),
      p = projectFor(asset),
      analysis = analyzeAutoReel(asset),
      { plan, next } = applyPlan(p, analysis, false);
    expect(plan.brollCount).toBe(0);
    expect(plan.warnings.join(" ")).toContain("No relevant stock match");
    expect(
      next.clips
        .filter((clip) => clip.kind === "video")
        .every((clip) => clip.assetId === asset.id),
    ).toBe(true);
  });

  it("rejects invented schedules, repeated main footage, missing stock and overlapping placements", () => {
    const asset = sample(),
      p = projectFor(asset),
      analysis = analyzeAutoReel(asset),
      beat = analysis.beats[0];
    const plan = finalizeAutoReelPlan(
      p,
      analysis,
      [
        {
          assetId: "coffee-stock",
          query: "random unrelated beach",
          startSeconds: 6,
          durationSeconds: 3,
        },
        { assetId: asset.id, ...beat },
        { assetId: "missing", ...beat },
        { assetId: "coffee-stock", ...beat },
        { assetId: "coffee-stock", ...beat },
      ],
      "music",
    );
    expect(plan.brollCount).toBe(1);
    expect(plan.warnings.join(" ")).toMatch(
      /did not match|unavailable|overlapping/,
    );
  });

  it("never overruns short stock or music media, and rejects a changed analysis frame rate", () => {
    const asset = sample(),
      p = projectFor(asset),
      analysis = analyzeAutoReel(asset);
    p.assets.find((item) => item.id === "coffee-stock")!.duration = 0.7;
    p.assets.find((item) => item.id === "music")!.duration = 3.25;
    const { next } = applyPlan(p, analysis);
    for (const clip of next.clips) {
      const a = p.assets.find((item) => item.id === clip.assetId);
      if (a && a.kind !== "image")
        expect(
          clip.sourceIn + (clip.duration / p.fps) * clip.speed,
        ).toBeLessThanOrEqual(a.duration + 1e-7);
      for (const word of clip.words)
        expect(word.end).toBeLessThanOrEqual(clip.duration / p.fps + 1e-7);
    }
    expect(() => finalizeAutoReelPlan({ ...p, fps: 60 }, analysis)).toThrow(
      "frame rate changed",
    );
  });
});
