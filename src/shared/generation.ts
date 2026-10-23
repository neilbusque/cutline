import { z } from "zod";

export const GenerationInputSchema = z
  .object({
    clientId: z.string().uuid(),
    projectId: z.string().min(1).max(100),
    prompt: z
      .string()
      .trim()
      .min(1, "Describe the video you want to generate.")
      .max(5000),
    model: z.enum(["seedance-2", "kling-3"]),
    duration: z.number().int().min(3).max(15),
    aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
    resolution: z.enum(["480p", "720p", "1080p", "4k"]),
    audio: z.boolean(),
    referenceId: z.string().uuid().optional(),
    referenceIds: z.array(z.string().uuid()).min(1).max(9).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.referenceId && v.referenceIds)
      ctx.addIssue({
        code: "custom",
        message: "Choose a starting frame or reference images, not both.",
      });
    if (
      v.referenceIds &&
      new Set(v.referenceIds).size !== v.referenceIds.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["referenceIds"],
        message: "Choose each reference image only once.",
      });
    if (v.model === "seedance-2" && v.duration < 4)
      ctx.addIssue({
        code: "custom",
        message: "Seedance clips must be 4–15 seconds.",
      });
    if (v.model === "kling-3" && v.prompt.length > 2500)
      ctx.addIssue({
        code: "custom",
        message: "Kling prompts must be 2500 characters or fewer.",
      });
    if (
      v.model === "kling-3" &&
      (!["16:9", "9:16", "1:1"].includes(v.aspectRatio) ||
        v.referenceId ||
        v.referenceIds)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Kling supports text with landscape, portrait or square format.",
      });
  });
export type GenerationInput = z.infer<typeof GenerationInputSchema>;
export type GenerationStatus =
  | "submitting"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "nsfw"
  | "canceled"
  | "unknown";
export type GenerationJob = Omit<
  GenerationInput,
  "clientId" | "referenceId" | "referenceIds"
> & {
  id: string;
  status: GenerationStatus;
  createdAt: number;
  requestId?: string;
  referenceName?: string;
  referenceNames?: string[];
  error?: string;
  downloaded: boolean;
};
export function generationRequest(
  input: GenerationInput,
  imageUrl?: string,
  referenceUrls?: string[],
) {
  if (input.model === "seedance-2" && referenceUrls?.length)
    return {
      endpoint: "bytedance/seedance-2.0/reference-to-video",
      body: {
        prompt: input.prompt,
        image_urls: referenceUrls,
        duration: input.duration,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
        generate_audio: input.audio,
      },
    };
  if (input.model === "seedance-2")
    return {
      endpoint: `bytedance/seedance-2.0/${imageUrl ? "image" : "text"}-to-video`,
      body: {
        prompt: input.prompt,
        duration: input.duration,
        resolution: input.resolution,
        generate_audio: input.audio,
        ...(imageUrl
          ? { image_url: imageUrl }
          : { aspect_ratio: input.aspectRatio }),
      },
    };
  return {
    endpoint: "kling-video/v3.0/std/text-to-video",
    body: {
      prompt: input.prompt,
      duration: input.duration,
      aspect_ratio: input.aspectRatio,
      sound: input.audio ? "on" : "off",
      multi_shots: false,
      cfg_scale: 0.5,
    },
  };
}
