import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import {
  AssetSchema,
  makeClip,
  newProject,
  validateProject,
  type Project,
} from "../src/shared/model";
import { evaluatedMotionLayer, motionValue } from "../src/shared/motion";
import {
  createMotionSequence,
  defaultMotionSequence,
} from "../src/shared/motion-sequence";

const apply = (p: Project, built: ReturnType<typeof createMotionSequence>) =>
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Build connected sequence",
    commands: built.commands,
  });

describe("Connected motion sequence builder", () => {
  it("adds all three acts in one validated revision without modifying existing work", () => {
    const p = newProject();
    p.clips.push(makeClip(p, "text", "titles", 0));
    const before = structuredClone(p);
    const built = createMotionSequence(p, 37, defaultMotionSequence);
    const result = apply(p, built);
    expect(p).toEqual(before);
    expect(result.revision).toBe(p.revision + 1);
    expect(result.clips[0]).toEqual(p.clips[0]);
    expect(built.clips.map((clip) => [clip.start, clip.duration])).toEqual([
      [37, 180],
      [217, 180],
      [397, 180],
    ]);
    expect(new Set(built.clips.map((clip) => clip.trackId)).size).toBe(1);
    expect(built.motions).toHaveLength(3);
    expect(built.durationFrames).toBe(540);
    expect(validateProject(result)).toEqual(result);
  });

  it("keeps the actual last and first motif poses matched at each pace, aspect ratio and frame rate", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      for (const [width, height] of [
        [1920, 1080],
        [1080, 1920],
      ]) {
        for (const seconds of [12, 18, 24] as const) {
          const built = createMotionSequence(
            { ...newProject(), width, height, fps },
            0,
            { ...defaultMotionSequence, seconds },
          );
          for (let index = 0; index < 2; index++) {
            for (const name of [
              "Orbit · shell",
              "Orbit · counterform",
              "Orbit · drawn contour",
              "Orbit · copper baton",
              "Orbit · traveling point",
            ]) {
              const outgoing = evaluatedMotionLayer(
                built.motions[index].layers.find(
                  (layer) => layer.name === name,
                )!,
                built.clips[index].duration - 1,
              );
              const incoming = evaluatedMotionLayer(
                built.motions[index + 1].layers.find(
                  (layer) => layer.name === name,
                )!,
                0,
              );
              for (const property of [
                "x",
                "y",
                "width",
                "height",
                "scale",
                "rotate",
                "opacity",
                "trim",
              ] as const)
                expect(
                  outgoing[property],
                  `${fps}fps ${seconds}s ${name} cut ${index}: ${property}`,
                ).toBeCloseTo(incoming[property], 6);
            }
          }
        }
      }
    }
  });

  it("uses authored copy and colors, removes decoration, and keeps layers editable", () => {
    const p = newProject();
    const built = createMotionSequence(p, 0, {
      ...defaultMotionSequence,
      brand: "Northstar",
      headline: "A CLEARER\nDIRECTION",
      detail: "Put your own product and your own words in motion.",
      closing: "START\nSOMETHING.",
      paper: "#F7F3EC",
      ink: "#102030",
      accent: "#44AA99",
    });
    expect(
      built.motions[0].layers.find(
        (layer) => layer.name === "Brand · signature",
      )?.text,
    ).toBe("Northstar");
    expect(
      built.motions[0].layers.find(
        (layer) => layer.name === "Headline · masked reveal",
      )?.text,
    ).toBe("A CLEARER\nDIRECTION");
    expect(
      built.motions[2].layers.find(
        (layer) => layer.name === "Headline · masked reveal",
      )?.text,
    ).toBe("START\nSOMETHING.");
    for (const motion of built.motions) {
      expect(
        motion.layers.some((layer) =>
          /underline|top rule/i.test(layer.name ?? ""),
        ),
      ).toBe(false);
      expect(
        motion.layers.find((layer) => layer.name === "Orbit · copper baton")
          ?.background,
      ).toBe("#44AA99");
      expect(
        motion.layers.every((layer) => layer.keyframes.length <= 100),
      ).toBe(true);
      expect(motion.layers.length).toBeLessThanOrEqual(24);
    }
    expect(
      built.motions[0].layers.find(
        (layer) => layer.name === "Paper · background",
      )?.background,
    ).toBe("#F7F3EC");
    expect(
      built.motions[1].layers.find(
        (layer) => layer.name === "Paper · background",
      )?.background,
    ).toBe("#102030");
  });

  it.each(["image", "video"] as const)(
    "places the real %s above the middle scene, clear of its headline",
    (kind) => {
      const p = { ...newProject(), width: 1920, height: 1080 };
      p.assets = [
        AssetSchema.parse({
          id: "screen",
          path: `/screen.${kind === "image" ? "png" : "mp4"}`,
          name: "My screen",
          kind,
          duration: kind === "image" ? 0 : 10,
          width: 1920,
          height: 1080,
        }),
      ];
      const built = createMotionSequence(p, 91, {
        ...defaultMotionSequence,
        assetId: "screen",
      });
      const result = apply(p, built);
      const media = built.clips.find((clip) => clip.assetId === "screen")!;
      expect(media.kind).toBe(kind);
      expect(media.volume).toBe(0);
      expect(media.fit).toBe("contain");
      expect(media.start).toBeGreaterThan(built.clips[1].start);
      expect(media.start + media.duration).toBeLessThan(
        built.clips[1].start + built.clips[1].duration,
      );
      expect(
        result.tracks.findIndex((track) => track.id === media.trackId),
      ).toBeLessThan(
        result.tracks.findIndex((track) => track.id === built.clips[1].trackId),
      );
      const headline = built.motions[1].layers.find(
        (layer) => layer.name === "Headline · masked reveal",
      )!;
      expect(headline.y + headline.height).toBeLessThan(media.y);
      const matte = built.motions[1].layers.find(
        (layer) => layer.name === "Screen · matte",
      )!;
      expect(motionValue(matte, "opacity", 0)).toBe(0);
      expect(motionValue(matte, "opacity", built.clips[1].duration - 1)).toBe(
        0,
      );
      for (const layer of built.motions[1].layers.filter((item) =>
        item.name?.startsWith("Orbit ·"),
      )) {
        expect(
          motionValue(
            layer,
            "opacity",
            Math.round(built.clips[1].duration / 2),
          ),
        ).toBe(0);
        expect(motionValue(layer, "opacity", 0)).toBe(layer.opacity);
        expect(motionValue(layer, "opacity", built.clips[1].duration - 1)).toBe(
          layer.opacity,
        );
      }
      expect(validateProject(result)).toEqual(result);
    },
  );

  it("plays short footage once at its original speed without trimming past the source", () => {
    const p = newProject();
    p.assets = [
      AssetSchema.parse({
        id: "short",
        path: "/short.mp4",
        name: "Short demo",
        kind: "video",
        duration: 1.75,
      }),
    ];
    const built = createMotionSequence(p, 0, {
      ...defaultMotionSequence,
      seconds: 24,
      assetId: "short",
    });
    const media = built.clips.find((clip) => clip.assetId)!;
    expect(media.duration).toBe(52);
    expect(media.speed).toBe(1);
    expect(media.freeze).toBe(false);
    expect(media.sourceIn).toBe(0);
    expect(media.duration / p.fps).toBeLessThanOrEqual(p.assets[0].duration);
    expect(validateProject(apply(p, built))).toBeDefined();
  });

  it.each([false, true])(
    "keeps canonical and generated subtitles above the complete sequence (reordered=%s)",
    (reordered) => {
      const p = newProject();
      const generatedCaptionTrack = {
        id: "story-subtitles",
        name: "Story captions",
        kind: "text" as const,
        muted: false,
        hidden: false,
      };
      p.tracks.splice(3, 0, generatedCaptionTrack);
      if (reordered) {
        const video = p.tracks.find((track) => track.id === "video")!;
        p.tracks = [
          video,
          ...p.tracks.filter((track) => track.id !== video.id),
        ];
      }
      const caption = {
        ...makeClip(p, "caption", generatedCaptionTrack.id),
        duration: 540,
        text: "Every word stays visible.",
      };
      p.clips.push(caption);
      p.assets.push(
        AssetSchema.parse({
          id: "screen",
          kind: "image",
          path: "/screen.png",
          name: "Screen",
          duration: 0,
        }),
      );
      for (const assetId of [undefined, "screen"]) {
        const built = createMotionSequence(p, 0, {
          ...defaultMotionSequence,
          assetId,
        });
        const result = apply(p, built);
        const oldIds = new Set(p.tracks.map((track) => track.id));
        expect(result.tracks.filter((track) => oldIds.has(track.id))).toEqual(
          p.tracks,
        );
        expect(result.clips.find((clip) => clip.id === caption.id)).toEqual(
          caption,
        );
        const sceneIndex = result.tracks.findIndex(
          (track) => track.id === built.clips[0].trackId,
        );
        const media = built.clips.find((clip) => clip.assetId);
        const topSequenceIndex = media
          ? result.tracks.findIndex((track) => track.id === media.trackId)
          : sceneIndex;
        for (const captionId of ["captions", generatedCaptionTrack.id])
          expect(
            result.tracks.findIndex((track) => track.id === captionId),
          ).toBeLessThan(topSequenceIndex);
        if (media) expect(topSequenceIndex).toBe(sceneIndex - 1);
        expect(result.revision).toBe(p.revision + 1);
      }
    },
  );

  it("rejects invalid copy, missing media and exhausted track capacity before changing a project", () => {
    const p = newProject();
    expect(() =>
      createMotionSequence(p, 0, { ...defaultMotionSequence, brand: "  " }),
    ).toThrow("Brand needs");
    expect(() =>
      createMotionSequence(p, 0, {
        ...defaultMotionSequence,
        assetId: "missing",
      }),
    ).toThrow("imported image or video");
    expect(() => createMotionSequence(p, -1, defaultMotionSequence)).toThrow(
      "whole-frame",
    );
    expect(() =>
      createMotionSequence(p, 0, {
        ...defaultMotionSequence,
        accent: "transparent",
      }),
    ).toThrow("six-digit");
    p.tracks = Array.from({ length: 64 }, (_, index) => ({
      id: `track-${index}`,
      name: `Track ${index}`,
      kind: "text",
      muted: false,
      hidden: false,
    }));
    expect(() => createMotionSequence(p, 0, defaultMotionSequence)).toThrow();
    expect(p.clips).toHaveLength(0);
    expect(p.motions).toHaveLength(0);
  });
});
