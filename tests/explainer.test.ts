import {
  agentEditInputSchema,
  editingSchemaSection,
} from "../src/shared/agent-edit";
import { describe, expect, it } from "vitest";
import {
  AssetSchema,
  makeClip,
  newProject,
  validateProject,
} from "../src/shared/model";
import {
  createExplainerStory,
  ExplainerInputSchema,
  explainerStyles,
  type ExplainerStyleId,
} from "../src/shared/explainer";
import { StoryPlanSchema } from "../src/shared/story-schema";
import {
  buildStoryTimeline,
  createStoryFromScript,
  storyNarrationSignature,
} from "../src/shared/story";
import {
  createProductScene,
  sceneNeedsMedia,
  sceneVisualReady,
} from "../src/shared/product-scenes";
import { evaluatedMotionLayer } from "../src/shared/motion";
import { evaluatedClip } from "../src/shared/animation";

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
const script =
  "A useful explanation starts with a real question. Keep that question clear.\n\nShow the steps in order. Connect each action to its result.\n\nCompare the starting point with the result. Give the audience one next step.";
const input = {
  style: "kinetic" as ExplainerStyleId,
  topic: "Explain a useful idea",
  script,
};

describe("Explainer planning", () => {
  it.each(explainerStyles)(
    "keeps the complete authored script in $name",
    (style) => {
      const plan = createExplainerStory({
        ...input,
        style: style.id,
        audience: "New users",
        cta: "Try one example.",
      });
      expect(
        normalize(plan.scenes.map((scene) => scene.narration).join(" ")),
      ).toBe(normalize(script));
      expect(plan.explainer).toEqual({
        style: style.id,
        topic: input.topic,
        audience: "New users",
        cta: "Try one example.",
      });
      expect(plan.scenes.at(-1)?.design?.headline).toBe("Try one example.");
      expect(
        plan.scenes.map((scene) => scene.narration).join(" "),
      ).not.toContain("Try one example.");
      expect(plan.scenes.some(sceneNeedsMedia)).toBe(style.requiresMedia);
      expect(
        plan.scenes.every(
          (scene) => scene.design && !scene.voiceAssetId && !scene.assetId,
        ),
      ).toBe(true);
      expect(plan.scenes[0].design?.headline).not.toBe(
        plan.scenes[0].narration,
      );
      expect(plan).toEqual(
        StoryPlanSchema.parse(JSON.parse(JSON.stringify(plan))),
      );
    },
  );

  it("splits long prose at sentence boundaries without losing repeated or Unicode words", () => {
    const sentence =
      "Dr. Mora says: “Keep café notes and 3.5-second pauses clear.” Repeat this exact phrase. ";
    const prose = sentence.repeat(25);
    const plan = createExplainerStory({ ...input, script: prose });
    expect(plan.scenes.length).toBeGreaterThan(1);
    expect(
      normalize(plan.scenes.map((scene) => scene.narration).join(" ")),
    ).toBe(normalize(prose));
    expect(
      plan.scenes.every((scene) => /[.!?]”?$/u.test(scene.narration)),
    ).toBe(true);
    expect(plan.scenes.every((scene) => scene.narration.length <= 5000)).toBe(
      true,
    );
  });

  it("treats single newline key points as scene boundaries and preserves authored bullet markers", () => {
    for (const lines of [
      ["Gather the facts", "Show the action", "Compare the result"],
      ["• Gather the facts", "- Show the action", "3. Compare the result"],
    ]) {
      const authored = `  ${lines[0]} \r\n${lines[1]}\r\n\r\n ${lines[2]}  `;
      const plan = createExplainerStory({
        ...input,
        style: "diagram",
        script: authored,
      });
      expect(plan.scenes.map((scene) => scene.narration)).toEqual(lines);
      expect(
        normalize(plan.scenes.map((scene) => scene.narration).join(" ")),
      ).toBe(normalize(authored));
      const restored = createExplainerStory(
        {
          ...input,
          style: "editorial",
          script: plan.scenes.map((scene) => scene.narration).join("\n\n"),
        },
        plan,
      );
      expect(restored.scenes.map((scene) => scene.id)).toEqual(
        plan.scenes.map((scene) => scene.id),
      );
    }
  });

  it("rejects unsupported sizes and missing authored material explicitly", () => {
    expect(() =>
      ExplainerInputSchema.parse({ ...input, script: " \n " }),
    ).toThrow(/script or key points/);
    expect(() =>
      createExplainerStory({ ...input, script: "a".repeat(5001) }),
    ).toThrow(/sentence.*5,000/);
    expect(() =>
      createExplainerStory({ ...input, script: "x".repeat(60001) }),
    ).toThrow(/60,000/);
    expect(() =>
      createExplainerStory({
        ...input,
        script: Array(61).fill("A short point.").join("\n\n"),
      }),
    ).toThrow(/at most 60/);
    expect(
      createExplainerStory({
        ...input,
        script: Array(60).fill("A short point.").join("\n\n"),
      }).scenes,
    ).toHaveLength(60);
  });

  it("uses distinct scene structures and requires real media even for a one-beat product explainer", () => {
    const layouts = explainerStyles.map((style) =>
      createExplainerStory({ ...input, style: style.id })
        .scenes.map((scene) => scene.design?.layout)
        .join(","),
    );
    expect(new Set(layouts).size).toBe(4);
    const one = createExplainerStory({
      ...input,
      style: "screen",
      script: "Show the actual result.",
    });
    expect(one.scenes.some(sceneNeedsMedia)).toBe(true);
    expect(sceneVisualReady(one.scenes[0], newProject())).toBe(false);
  });

  it("retains voice, captions, music, brand, references, scene assets and assembly when restyling", () => {
    const prior = createExplainerStory(input);
    prior.voice = "af_sarah";
    prior.speed = 1.15;
    prior.captions = false;
    prior.captionStyle = "focus";
    prior.musicAssetId = "music";
    prior.referenceAssetIds = ["shared-reference"];
    prior.brand!.accent = "#D78556";
    prior.assembly = {
      clipIds: ["owned-clip"],
      trackIds: ["owned-track"],
      motionIds: ["owned-motion"],
      startFrame: 90,
    };
    prior.scenes[0].assetId = "real-screen";
    prior.scenes[0].voiceAssetId = "voice";
    prior.scenes[0].voiceSignature = storyNarrationSignature(
      prior.scenes[0],
      prior,
    );
    prior.scenes[0].referenceAssetIds = ["scene-reference"];
    const before = structuredClone(prior);
    const next = createExplainerStory({ ...input, style: "editorial" }, prior);
    for (const field of [
      "voice",
      "speed",
      "captions",
      "captionStyle",
      "musicAssetId",
      "referenceAssetIds",
      "brand",
      "assembly",
    ] as const)
      expect(next[field]).toEqual(prior[field]);
    for (const field of [
      "id",
      "assetId",
      "voiceAssetId",
      "voiceSignature",
      "referenceAssetIds",
    ] as const)
      expect(next.scenes[0][field]).toEqual(prior.scenes[0][field]);
    expect(next.scenes[0].design?.layout).toBe("editorial");
    next.assembly!.clipIds.push("another");
    expect(prior).toEqual(before);
  });

  it("keeps duplicate scene identities separate and clears stale media for rewritten narration", () => {
    const repeated = { ...input, script: "Repeat this.\n\nRepeat this." };
    const prior = createExplainerStory(repeated);
    prior.scenes[0].voiceAssetId = "old-voice";
    prior.scenes[0].assetId = "old-image";
    prior.scenes[0].referenceAssetIds = ["reference"];
    const restyled = createExplainerStory(
      { ...repeated, style: "diagram" },
      prior,
    );
    expect(restyled.scenes.map((scene) => scene.id)).toEqual(
      prior.scenes.map((scene) => scene.id),
    );
    const rewritten = createExplainerStory(
      { ...input, script: "An entirely different explanation." },
      prior,
    );
    expect(rewritten.scenes[0].voiceAssetId).toBeUndefined();
    expect(rewritten.scenes[0].assetId).toBeUndefined();
    expect(rewritten.scenes[0].referenceAssetIds).toEqual(["reference"]);
    expect(rewritten.scenes[0].id).not.toBe(prior.scenes[0].id);
  });

  it("keeps older story files valid without injecting explainer metadata", () => {
    const legacy = createStoryFromScript("A simple existing story.");
    expect(StoryPlanSchema.parse(legacy)).not.toHaveProperty("explainer");
    const project = newProject();
    project.story = createExplainerStory(input);
    expect(
      validateProject(JSON.parse(JSON.stringify(project))).story?.explainer,
    ).toEqual(project.story.explainer);
  });
});

describe("Explainer composition and ownership", () => {
  it.each(explainerStyles)(
    "keeps very short $name inserts fully visible rather than fading for their entire duration",
    (style) => {
      const project = newProject();
      const screenshot = AssetSchema.parse({
        id: "screen",
        name: "Real screenshot",
        path: "/screen.png",
        kind: "image",
        duration: 0,
        width: 1600,
        height: 1000,
      });
      project.assets.push(screenshot);
      const plan = createExplainerStory({ ...input, style: style.id });
      for (const scene of plan.scenes) {
        if (sceneNeedsMedia(scene)) scene.assetId = screenshot.id;
        for (const frames of [2, 10, 15]) {
          const { motion, clips } = createProductScene(project, {
            scene,
            frames,
            start: 0,
            graphicsTrackId: "titles",
            mediaTrackId: "video",
            visual: screenshot,
          });
          for (const frame of [0, Math.floor(frames / 2), frames - 1]) {
            for (const layer of motion.layers) {
              expect(evaluatedMotionLayer(layer, frame).opacity).toBe(1);
              if (layer.type === "text")
                expect(layer.textAnimation).toBe("none");
            }
            for (const clip of clips.filter((clip) => clip.kind === "image"))
              expect(evaluatedClip(clip, frame).opacity).toBe(1);
          }
        }
      }
    },
  );

  it("draws real editable connectors between authored steps instead of substituting a card list", () => {
    const project = newProject();
    const plan = createExplainerStory({
      ...input,
      style: "diagram",
      script: "Gather the facts. Show the action. Compare the result.",
    });
    const { motion } = createProductScene(project, {
      scene: plan.scenes[0],
      frames: 180,
      start: 0,
      graphicsTrackId: "titles",
      mediaTrackId: "video",
    });
    const connectors = motion.layers.filter((layer) =>
      layer.name?.endsWith("connector"),
    );
    expect(connectors).toHaveLength(2);
    expect(
      connectors.every(
        (layer) =>
          layer.type === "path" &&
          layer.vectorPath &&
          layer.keyframes.some((key) => key.trim === 0) &&
          layer.keyframes.some((key) => key.trim === 1),
      ),
    ).toBe(true);
    expect(motion.layers.find((layer) => layer.name === "Step 2")?.text).toBe(
      "Show the action",
    );
  });

  it.each(explainerStyles.filter((style) => !style.requiresMedia))(
    "builds editable $name visuals with duration-bounded motion",
    (style) => {
      for (const [width, height] of [
        [1920, 1080],
        [1080, 1920],
        [1080, 1080],
      ]) {
        const project = { ...newProject(), width, height };
        const plan = createExplainerStory({ ...input, style: style.id });
        for (const scene of plan.scenes) {
          for (const frames of [1, 2, 30, 150]) {
            const result = createProductScene(project, {
              scene,
              frames,
              start: 0,
              graphicsTrackId: "titles",
              mediaTrackId: "video",
            });
            expect(result.motion.layers.length).toBeLessThanOrEqual(24);
            expect(result.motion.layers.every((layer) => !!layer.name)).toBe(
              true,
            );
            expect(
              result.motion.layers.every((layer) =>
                layer.keyframes.every(
                  (key) => key.frame >= 0 && key.frame < frames,
                ),
              ),
            ).toBe(true);
            expect(
              result.motion.layers.some((layer) =>
                /underline|rule/iu.test(layer.name ?? ""),
              ),
            ).toBe(false);
            expect(result.clips).toHaveLength(1);
          }
        }
      }
    },
  );

  it("extends to actual speech, preserves unrelated clips, and rebuilds after style changes without duplicates", () => {
    let project = newProject();
    project.story = createExplainerStory({
      ...input,
      script: "Describe one real action.",
    });
    const scene = project.story.scenes[0];
    const voice = AssetSchema.parse({
      id: "voice",
      name: "Voice",
      path: "/voice.wav",
      kind: "audio",
      duration: 7.2,
      words: [{ text: "Describe", start: 0.1, end: 0.5 }],
    });
    project.assets.push(voice);
    scene.voiceAssetId = voice.id;
    scene.voiceSignature = storyNarrationSignature(scene, project.story);
    const unrelated = makeClip(project, "text", "titles", 0);
    project.clips.push(unrelated);
    project = buildStoryTimeline(project, { mode: "append" }).project;
    const previousAssembly = structuredClone(project.story!.assembly!);
    const native = project.clips.find((clip) => clip.motionId)!;
    expect(native.duration).toBe(216);
    project.story = createExplainerStory(
      { ...input, style: "diagram", script: "Describe one real action." },
      project.story,
    );
    project = buildStoryTimeline(project, { mode: "rebuild" }).project;
    expect(project.motions).toHaveLength(1);
    expect(project.clips.find((clip) => clip.id === unrelated.id)).toEqual(
      unrelated,
    );
    expect(
      project.clips.some((clip) => previousAssembly.clipIds.includes(clip.id)),
    ).toBe(false);
    expect(project.story!.assembly!.startFrame).toBe(
      previousAssembly.startFrame,
    );
    expect(() => validateProject(project)).not.toThrow();
  });
});

describe("Compact explainer tool discovery", () => {
  it("keeps caption styling discoverable through its full on-demand schema", () => {
    const action = agentEditInputSchema().properties.actions.items.oneOf.find(
      (item: any) => item.properties.type.const === "caption.update",
    );
    expect(action?.properties.patch.description).toContain("captionPatch");
    const full = editingSchemaSection("captionPatch") as any;
    expect(full.properties.fontSize).toBeTruthy();
    expect(full.properties.color).toBeTruthy();
    const exact = editingSchemaSection("action:caption.update") as any;
    expect(exact.properties.patch.properties).toEqual(full.properties);
  });
});
