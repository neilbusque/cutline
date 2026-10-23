import { z } from "zod";
import { SpeechInputSchema } from "./tts";

export const STORY_SCENE_LIMIT = 60;
export const STORY_REFERENCE_LIMIT = 9;
export const ExplainerStyleSchema = z.enum([
  "kinetic",
  "screen",
  "diagram",
  "editorial",
]);
export const ExplainerMetadataSchema = z.object({
  style: ExplainerStyleSchema,
  topic: z.string().trim().min(1).max(120),
  audience: z.string().trim().max(200).optional(),
  cta: z.string().trim().max(160).optional(),
});
const id = z.string().min(1).max(200);
export const ProductDesignSchema = z.object({
  layout: z.enum([
    "title",
    "screen",
    "split",
    "features",
    "quote",
    "cta",
    "kinetic",
    "process",
    "comparison",
    "editorial",
    "editorial-quote",
  ]),
  headline: z.string().max(180).default(""),
  eyebrow: z.string().max(80).default(""),
  body: z.string().max(500).default(""),
  points: z.array(z.string().max(140)).max(3).default([]),
  motion: z.enum(["smooth", "snappy", "minimal"]).default("smooth"),
});
export const ProductBrandSchema = z.object({
  name: z.string().max(80),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color."),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color."),
  foreground: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color."),
});
export type ProductDesign = z.infer<typeof ProductDesignSchema>;
export type ProductBrand = z.infer<typeof ProductBrandSchema>;
const referenceAssetIds = z.array(id).max(STORY_REFERENCE_LIMIT).optional();
export function mergedStoryReferenceIds(
  plan: { referenceAssetIds?: string[] },
  scene: { referenceAssetIds?: string[] },
) {
  return [
    ...new Set([
      ...(plan.referenceAssetIds ?? []),
      ...(scene.referenceAssetIds ?? []),
    ]),
  ];
}
export const StorySceneSchema = z.object({
  id,
  title: z.string().max(120).default("Scene"),
  narration: z.string().max(5000).default(""),
  visualPrompt: z.string().max(4000).default(""),
  duration: z.number().finite().min(1).max(120).default(5),
  assetId: id.optional(),
  voiceAssetId: id.optional(),
  voiceSignature: z.string().max(12000).optional(),
  generationId: id.optional(),
  referenceAssetIds,
  design: ProductDesignSchema.optional(),
});
export const StoryPlanSchema = z
  .object({
    brief: z.string().max(12000).default(""),
    style: z.string().max(1000).default("Cinematic"),
    scenes: z.array(StorySceneSchema).max(STORY_SCENE_LIMIT).default([]),
    voice: SpeechInputSchema.shape.voice,
    speed: SpeechInputSchema.shape.speed,
    captions: z.boolean().default(true),
    captionStyle: z
      .enum([
        "standard",
        "karaoke",
        "pop",
        "box",
        "typewriter",
        "outline",
        "focus",
        "minimal",
      ])
      .default("standard"),
    musicAssetId: id.optional(),
    referenceAssetIds,
    brand: ProductBrandSchema.optional(),
    explainer: ExplainerMetadataSchema.optional(),
    assembly: z
      .object({
        clipIds: z.array(id).max(10000),
        trackIds: z.array(id).max(64),
        motionIds: z.array(id).max(100).optional(),
        startFrame: z.number().finite().int().min(0).max(864000),
      })
      .optional(),
  })
  .superRefine((plan, context) => {
    plan.scenes.forEach((scene, index) => {
      if (mergedStoryReferenceIds(plan, scene).length > STORY_REFERENCE_LIMIT)
        context.addIssue({
          code: "custom",
          path: ["scenes", index, "referenceAssetIds"],
          message: "Use at most 9 shared and scene reference images together.",
        });
    });
    if (
      new Set(plan.scenes.map((scene) => scene.id)).size !== plan.scenes.length
    )
      context.addIssue({
        code: "custom",
        path: ["scenes"],
        message: "Each story scene needs a unique ID.",
      });
    if (
      plan.scenes.reduce((total, scene) => total + scene.narration.length, 0) >
      60000
    )
      context.addIssue({
        code: "custom",
        path: ["scenes"],
        message: "Keep the total story script under 60,000 characters.",
      });
  });

export type StoryScene = z.infer<typeof StorySceneSchema>;
export type StoryPlan = z.infer<typeof StoryPlanSchema>;
