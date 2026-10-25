import { describe, expect, it } from "vitest";
import {
  MOTION_LIMIT,
  AssetSchema,
  makeClip,
  MotionLayerSchema,
  newProject,
  uid,
  validateProject,
  type Project,
} from "../src/shared/model";
import {
  buildStoryTimeline,
  createProductStory,
  createStoryFromScript,
  storyNarrationSignature,
} from "../src/shared/story";
import {
  ProductDesignSchema,
  StoryPlanSchema,
} from "../src/shared/story-schema";
import {
  createProductScene,
  productBrand,
  productLayouts,
  sceneNeedsMedia,
  sceneVisualReady,
} from "../src/shared/product-scenes";
import { captionTextWidth } from "../src/shared/caption-layout";
import { evaluatedMotionLayer, motionTextLines } from "../src/shared/motion";
import { evaluatedClip } from "../src/shared/animation";

function prepared(
  style: "launch" | "walkthrough" | "type-led" = "launch",
  width = 1920,
  height = 1080,
) {
  const project = { ...newProject(), width, height };
  project.story = createProductStory(style);
  const screenshot = AssetSchema.parse({
    id: "screen",
    name: "Product screen",
    path: "/screen.png",
    kind: "image",
    duration: 0,
    width: 1600,
    height: 1000,
  });
  project.assets.push(screenshot);
  project.story.scenes.forEach((scene) => {
    if (sceneNeedsMedia(scene)) scene.assetId = screenshot.id;
  });
  return project;
}

describe("Product film planning", () => {
  it.each(["launch", "walkthrough", "type-led"] as const)(
    "creates a silent 24-second %s film with editable copy",
    (style) => {
      const story = createProductStory(style, "Northstar");
      expect(story.scenes).toHaveLength(6);
      expect(story.scenes.reduce((n, scene) => n + scene.duration, 0)).toBe(24);
      expect(
        story.scenes.every(
          (scene) => scene.narration === "" && scene.design?.headline,
        ),
      ).toBe(true);
      expect(story.brand?.name).toBe("Northstar");
      expect(new Set(story.scenes.map((scene) => scene.id)).size).toBe(6);
      expect(StoryPlanSchema.parse(story)).toEqual(story);
      expect(story.scenes.some(sceneNeedsMedia)).toBe(style !== "type-led");
    },
  );

  it("requires media only for plain, screen and spotlight scenes", () => {
    const project = newProject();
    for (const layout of productLayouts) {
      const scene = createProductStory("launch").scenes[0];
      scene.design = ProductDesignSchema.parse({ layout: layout.id });
      expect(sceneNeedsMedia(scene)).toBe(layout.needsMedia);
      expect(sceneVisualReady(scene, project)).toBe(!layout.needsMedia);
    }
    const ordinary = createStoryFromScript("A ninja arrives.").scenes[0];
    expect(sceneNeedsMedia(ordinary)).toBe(true);
    expect(sceneVisualReady(ordinary, project)).toBe(false);
    project.assets.push(
      AssetSchema.parse({
        id: "empty",
        name: "Empty recording",
        path: "/empty.mp4",
        kind: "video",
        duration: 0,
      }),
    );
    ordinary.assetId = "empty";
    expect(sceneVisualReady(ordinary, project)).toBe(false);
  });

  it("keeps legacy stories unchanged and saves optional branded designs", () => {
    const ordinary = createStoryFromScript("A ninja arrives.");
    expect(ordinary).not.toHaveProperty("brand");
    expect(ordinary.scenes[0]).not.toHaveProperty("design");
    const project = prepared();
    project.story!.brand!.accent = "#ED7182";
    project.story!.scenes[0].design!.headline = "A line.\nAnother line.";
    expect(validateProject(JSON.parse(JSON.stringify(project)))).toEqual(
      project,
    );
    expect(() =>
      StoryPlanSchema.parse({
        ...project.story,
        brand: { ...productBrand, accent: "red" },
      }),
    ).toThrow(/six-digit/);
    expect(() =>
      ProductDesignSchema.parse({
        layout: "features",
        points: Array(4).fill("x"),
      }),
    ).toThrow();
  });
});

describe("Product film composition", () => {
  it("gives a landscape screen demo half the canvas height without letterboxing its frame", () => {
    const p = prepared();
    p.assets[0].width = 1920;
    p.assets[0].height = 1080;
    const scene = p.story!.scenes.find(
      (item) => item.design?.layout === "screen",
    )!;
    const { motion, clips } = createProductScene(p, {
      scene,
      start: 0,
      frames: 150,
      graphicsTrackId: "titles",
      mediaTrackId: "video",
      visual: p.assets[0],
    });
    const media = clips.find((clip) => clip.kind === "image")!;
    const frame = motion.layers.find(
      (layer) => layer.name === "Browser frame",
    )!;
    expect(media.height).toBeGreaterThanOrEqual(p.height * 0.49);
    expect(media.width / media.height).toBeCloseTo(16 / 9, 8);
    expect(media.y + media.height).toBeLessThan(p.height * 0.75);
    expect(frame.width - media.width).toBeLessThan(p.width * 0.01);
    expect(frame.x + frame.width / 2).toBeCloseTo(p.width / 2, 8);
    for (const layer of motion.layers.filter(
      (layer) => layer.type === "text" && layer.name !== "Browser label",
    ))
      expect(layer.y + layer.height).toBeLessThan(frame.y);
  });

  it.each([
    [1920, 1080],
    [1080, 1920],
    [1080, 1080],
  ])(
    "fits source-shaped screen frames on a %s by %s canvas",
    (width, height) => {
      const p = prepared("launch", width, height);
      const scene = p.story!.scenes.find(
        (item) => item.design?.layout === "screen",
      )!;
      for (const [sourceWidth, sourceHeight] of [
        [1920, 1080],
        [1080, 1920],
        [1200, 1200],
      ]) {
        p.assets[0].width = sourceWidth;
        p.assets[0].height = sourceHeight;
        const { clips } = createProductScene(p, {
          scene,
          start: 0,
          frames: 150,
          graphicsTrackId: "titles",
          mediaTrackId: "video",
          visual: p.assets[0],
        });
        const media = clips.find((clip) => clip.kind === "image")!;
        expect(media.width / media.height).toBeCloseTo(
          sourceWidth / sourceHeight,
          8,
        );
        expect(media.y + media.height).toBeLessThan(height * 0.75);
        expect(media.x).toBeGreaterThan(0);
        expect(media.x + media.width).toBeLessThan(width);
      }
    },
  );

  it.each([
    [1920, 1080],
    [1080, 1920],
    [1080, 1080],
  ])(
    "builds every layout at %s by %s with safe type and media bounds",
    (width, height) => {
      const p = prepared("launch", width, height);
      for (const layout of productLayouts) {
        const scene = {
          ...p.story!.scenes[0],
          assetId: "screen",
          design: ProductDesignSchema.parse({
            layout: layout.id,
            headline: "A deliberate headline\nwith a second clear thought",
            eyebrow: "THE PRODUCT FILM",
            body: "Give the audience a moment to read, then show the next detail.",
            points: [
              "A purposeful beginning",
              "A clear explanation",
              "A memorable next step",
            ],
          }),
        };
        const result = createProductScene(p, {
          scene,
          start: 0,
          frames: 150,
          graphicsTrackId: "titles",
          mediaTrackId: "video",
          visual: p.assets[0],
        });
        expect(result.motion.layers.length).toBeLessThanOrEqual(24);
        for (const layer of result.motion.layers) {
          expect(layer.x).toBeGreaterThanOrEqual(0);
          expect(layer.y).toBeGreaterThanOrEqual(0);
          expect(layer.x + layer.width).toBeLessThanOrEqual(width + 0.001);
          expect(layer.y + layer.height).toBeLessThanOrEqual(height + 0.001);
          if (layer.type === "text") {
            const weight =
              layer.fontWeight === 400
                ? "400"
                : layer.fontWeight === 600
                  ? "600"
                  : "800";
            expect(
              layer.text.split("\n").length * layer.fontSize * layer.lineHeight,
            ).toBeLessThanOrEqual(layer.height + 0.01);
            for (const line of layer.text.split("\n"))
              expect(
                captionTextWidth(line, layer.fontSize, "Helvetica", weight),
              ).toBeLessThanOrEqual(layer.width + 0.01);
            expect(layer.y + layer.height).toBeLessThanOrEqual(height * 0.75);
          }
          expect(
            layer.keyframes.every((key) => key.frame >= 0 && key.frame < 150),
          ).toBe(true);
        }
        for (const clip of result.clips.filter(
          (clip) => clip.kind === "image",
        )) {
          expect(clip.fit).toBe("contain");
          expect(clip.assetId).toBe("screen");
          expect(clip.y + clip.height).toBeLessThan(height * 0.75);
        }
        p.clips = result.clips;
        p.motions = [result.motion];
        expect(() => validateProject(p)).not.toThrow();
      }
    },
  );

  it.each([
    [1920, 1080],
    [1080, 1920],
    [1080, 1080],
  ])("fits maximum copy without truncation at %s by %s", (width, height) => {
    const p = prepared("launch", width, height);
    for (const layout of productLayouts) {
      const headline = "A long headline that still needs to remain readable. "
        .repeat(4)
        .slice(0, 180);
      const body = "A thoughtful supporting sentence about the actual product. "
        .repeat(10)
        .slice(0, 500);
      const point =
        "A detailed feature explanation that remains editable and does not disappear. "
          .repeat(2)
          .slice(0, 140);
      const scene = {
        ...p.story!.scenes[0],
        assetId: "screen",
        design: ProductDesignSchema.parse({
          layout: layout.id,
          headline,
          body,
          points: [point, point, point],
        }),
      };
      const { motion } = createProductScene(p, {
        scene,
        start: 0,
        frames: 180,
        graphicsTrackId: "titles",
        mediaTrackId: "video",
        visual: p.assets[0],
      });
      const compressed = (text: string) => text.replace(/\s+/gu, "");
      expect(
        compressed(
          motion.layers.find(
            (layer) => layer.name === "Headline" || layer.name === "Statement",
          )!.text,
        ),
      ).toBe(compressed(headline));
      expect(
        compressed(
          motion.layers.find((layer) => layer.name === "Supporting copy")!.text,
        ),
      ).toBe(compressed(body));
      for (const layer of motion.layers.filter(
        (layer) => layer.type === "text",
      )) {
        expect(
          layer.text.split("\n").length * layer.fontSize * layer.lineHeight,
        ).toBeLessThanOrEqual(layer.height + 0.01);
      }
    }
  });

  it("bounds short-scene keys and keeps minimal motion still", () => {
    const p = prepared("type-led");
    const scene = p.story!.scenes[0];
    scene.design!.motion = "minimal";
    const { motion } = createProductScene(p, {
      scene,
      start: 0,
      frames: 30,
      graphicsTrackId: "titles",
      mediaTrackId: "video",
    });
    expect(
      motion.layers.every((layer) =>
        layer.keyframes.every((key) => key.frame < 30),
      ),
    ).toBe(true);
    for (const layer of motion.layers)
      for (const frame of [0, 9, 15, 29])
        expect(evaluatedMotionLayer(layer, frame).y).toBe(layer.y);
  });

  it("reveals all long-copy lines before a short scene exits", () => {
    const p = prepared("type-led");
    const scene = p.story!.scenes[0];
    scene.design!.headline =
      "A longer headline whose final lines must appear before the scene ends. ".repeat(
        2,
      );
    scene.design!.body =
      "A supporting sentence that needs to be visible in full. ".repeat(6);
    const { motion } = createProductScene(p, {
      scene,
      start: 0,
      frames: 30,
      graphicsTrackId: "titles",
      mediaTrackId: "video",
    });
    for (const layer of motion.layers.filter(
      (layer) => layer.textAnimation === "line-reveal",
    ))
      expect(
        motionTextLines(layer, layer.text, 22).every(
          (line) => line.progress === 1,
        ),
      ).toBe(true);
  });
});

describe("Product film assembly ownership", () => {
  it("assembles native graphics without visuals and rejects missing screen media atomically", () => {
    const p = prepared("type-led");
    p.assets = [];
    const result = buildStoryTimeline(p, { mode: "append" });
    expect(result.durationFrames).toBe(720);
    expect(result.project.motions).toHaveLength(6);
    expect(result.project.story!.assembly!.motionIds).toHaveLength(6);
    expect(result.project.clips.every((clip) => clip.preset === "custom")).toBe(
      true,
    );
    const missing = prepared();
    missing.assets = [];
    const before = structuredClone(missing);
    expect(() => buildStoryTimeline(missing, { mode: "append" })).toThrow(
      /choose a video or image/,
    );
    expect(missing).toEqual(before);
  });

  it("extends a graphic to its voiceover, adds captions, and keeps them above visuals", () => {
    const p = prepared("type-led");
    p.story!.scenes = p.story!.scenes.slice(0, 1);
    const scene = p.story!.scenes[0];
    scene.narration = "Keep the idea clear.";
    const voice = AssetSchema.parse({
      id: "voice",
      name: "Voice",
      path: "/voice.wav",
      kind: "audio",
      duration: 4.25,
      words: [
        { text: "Keep", start: 0.2, end: 0.6 },
        { text: "the", start: 0.65, end: 0.8 },
        { text: "idea", start: 0.85, end: 1.2 },
        { text: "clear.", start: 1.3, end: 1.7 },
      ],
    });
    p.assets.push(voice);
    scene.voiceAssetId = voice.id;
    scene.voiceSignature = storyNarrationSignature(scene, p.story!);
    const result = buildStoryTimeline(p, { mode: "append" });
    expect(result.durationFrames).toBe(128);
    expect(result.project.clips.find((clip) => clip.motionId)?.duration).toBe(
      128,
    );
    expect(result.captionCount).toBeGreaterThan(0);
    const caption = result.project.clips.find(
      (clip) => clip.kind === "caption",
    )!;
    const graphic = result.project.clips.find((clip) => clip.motionId)!;
    expect(
      result.project.tracks.findIndex((track) => track.id === caption.trackId),
    ).toBeLessThan(
      result.project.tracks.findIndex((track) => track.id === graphic.trackId),
    );
  });

  it("rebuilds repeatedly without leaking motions or deleting reused designs and unrelated clips", () => {
    let p = buildStoryTimeline(prepared(), { mode: "append" }).project;
    const savedMotion = p.motions[0];
    const custom = {
      ...makeClip(p, "text", "titles", 0),
      preset: "custom" as const,
      motionId: savedMotion.id,
      text: "My reused design",
    };
    p.clips.push(custom);
    for (let i = 0; i < 5; i++) {
      const prior = p.story!.assembly!;
      p = buildStoryTimeline(p, { mode: "rebuild" }).project;
      expect(p.motions).toHaveLength(7);
      expect(p.clips.find((clip) => clip.id === custom.id)).toEqual(custom);
      expect(p.motions.find((motion) => motion.id === savedMotion.id)).toEqual(
        savedMotion,
      );
      expect(p.story!.assembly!.motionIds).not.toContain(savedMotion.id);
      expect(p.clips.some((clip) => prior.clipIds.includes(clip.id))).toBe(
        false,
      );
      expect(p.story!.assembly!.startFrame).toBe(0);
    }
  });

  it("preserves appended sequences and checks the motion limit before committing", () => {
    const first = buildStoryTimeline(prepared(), { mode: "append" }).project;
    const second = buildStoryTimeline(first, { mode: "append" }).project;
    expect(second.motions).toHaveLength(12);
    expect(second.story!.assembly!.startFrame).toBe(720);
    const rebuilt = buildStoryTimeline(second, { mode: "rebuild" }).project;
    expect(rebuilt.motions).toHaveLength(12);
    expect(
      first.clips.every((clip) =>
        rebuilt.clips.some((item) => item.id === clip.id),
      ),
    ).toBe(true);
    const full = prepared();
    full.motions = Array.from({ length: MOTION_LIMIT - 5 }, () => ({
      id: uid(),
      name: "Existing",
      layers: [MotionLayerSchema.parse({ type: "text", text: "Existing" })],
    }));
    const before = structuredClone(full);
    expect(() => buildStoryTimeline(full, { mode: "append" })).toThrow(
      `at most ${MOTION_LIMIT}`,
    );
    expect(full).toEqual(before);
  });

  it("loops real recordings without exceeding source duration or restarting unrelated media", () => {
    const p = prepared();
    p.story!.scenes = p.story!.scenes.filter((scene) => sceneNeedsMedia(scene));
    p.assets[0] = { ...p.assets[0], kind: "video", duration: 1.25 };
    const result = buildStoryTimeline(p, { mode: "append" });
    expect(
      result.project.clips.filter((clip) => clip.kind === "video").length,
    ).toBeGreaterThan(2);
    expect(result.warnings.join(" ")).toMatch(/loops/);
    expect(() => validateProject(result.project)).not.toThrow();
    for (const scene of p.story!.scenes) {
      const graphics = result.project.clips.find(
        (clip) => clip.motionId && clip.text === scene.title,
      )!;
      const motion = result.project.motions.find(
        (item) => item.id === graphics.motionId,
      )!;
      const chrome = motion.layers.find(
        (layer) => layer.name === "Browser frame",
      )!;
      const media = result.project.clips.filter(
        (clip) =>
          clip.kind === "video" &&
          clip.start >= graphics.start &&
          clip.start < graphics.start + graphics.duration,
      );
      for (const clip of media) {
        for (const frame of [
          0,
          Math.floor(clip.duration / 2),
          clip.duration - 1,
        ]) {
          const phase = clip.start - graphics.start + frame;
          const outer = evaluatedMotionLayer(chrome, phase);
          const inner = evaluatedClip(clip, frame);
          expect(inner.y - clip.y).toBeCloseTo(outer.y - chrome.y, 8);
          expect(inner.opacity).toBeCloseTo(outer.opacity, 8);
        }
      }
    }
  });
});
