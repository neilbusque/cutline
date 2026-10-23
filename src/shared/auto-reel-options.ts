import { z } from "zod";
import { ClipSchema } from "./model";
import { ReelBeatSchema, ReelFormatSchema } from "./reel-formats";

/** Auto edit's options, shared by the app's Auto edit panel and the cutline_auto_edit tool. */
export const AutoReelOptionsSchema = z
  .object({
    format: ReelFormatSchema.optional(),
    beats: z.array(ReelBeatSchema).max(24).optional(),
    targetSeconds: z
      .union([z.literal(15), z.literal(30), z.literal(60), z.literal(90)])
      .optional(),
    style: z.enum(["clean", "bold", "cinematic"]).optional(),
    pace: z.enum(["natural", "tight"]).default("natural"),
    captionStyle: ClipSchema.shape.captionStyle.removeDefault().optional(),
    openingTitle: z.boolean().default(false),
    broll: z.boolean().optional(),
    music: z.boolean().optional(),
  })
  .strict();
export type AutoReelOptions = z.infer<typeof AutoReelOptionsSchema>;

/** Resolve after parsing so a format can choose defaults without hiding an explicit choice. */
export function resolveAutoReelOptions(options: AutoReelOptions) {
  const creatorShort =
    options.format === "creator-punch" || options.format === "screen-demo";
  return {
    ...options,
    broll: options.broll ?? !creatorShort,
    music: options.music ?? !creatorShort,
  };
}
