import { z } from "zod";
import type { Clip } from "./model";

export const reelFormatIds = [
  "montage",
  "talking-head",
  "explainer",
  "listicle",
  "product-demo",
  "creator-education",
  "creator-punch",
  "screen-demo",
] as const;
export const ReelFormatSchema = z.enum(reelFormatIds);
export type ReelFormat = z.infer<typeof ReelFormatSchema>;

export const ReelBeatSchema = z
  .object({
    sourceIndex: z.number().int().min(0),
    sourceSeconds: z.number().finite().min(0),
    text: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((text) => text.replace(/\s+/gu, " ")),
    kind: z.enum(["callout", "step", "takeaway"]),
  })
  .strict();
export type ReelBeat = z.infer<typeof ReelBeatSchema>;

/** The anchor is absolute speaker source time; duration is output timeline time. */
export const ReelProofBeatSchema = z
  .object({
    sourceIndex: z.number().int().min(0),
    sourceSeconds: z.number().finite().min(0),
    assetId: z.string().min(1),
    sourceIn: z.number().finite().min(0).optional(),
    durationSeconds: z.number().finite().min(0.5).max(12),
    layout: z.enum(["split", "cutaway"]),
  })
  .strict();
export type ReelProofBeat = z.infer<typeof ReelProofBeatSchema>;

export const reelFormats: ReadonlyArray<{
  id: ReelFormat;
  label: string;
  description: string;
  captionStyle: Clip["captionStyle"];
}> = [
  {
    id: "montage",
    label: "Montage",
    description: "Ordered footage, B-roll, titles and captions.",
    captionStyle: "standard",
  },
  {
    id: "talking-head",
    label: "Talking head",
    description:
      "Keep the speaker in view with gentle punch-ins and timed callouts.",
    captionStyle: "karaoke",
  },
  {
    id: "explainer",
    label: "Explainer",
    description: "Turn spoken ideas into animated takeaway cards.",
    captionStyle: "standard",
  },
  {
    id: "listicle",
    label: "Listicle",
    description: "Number spoken points with editable animated step cards.",
    captionStyle: "pop",
  },
  {
    id: "product-demo",
    label: "Product demo",
    description: "Show imported screens in full with animated feature labels.",
    captionStyle: "minimal",
  },
  {
    id: "creator-education",
    label: "Ali Abdaal-inspired",
    description:
      "Cream idea cards, short readable captions and gentle speaker punch-ins.",
    captionStyle: "box",
  },
  {
    id: "creator-punch",
    label: "Creator punch",
    description:
      "Full-frame speaker, short bold captions and quick deliberate punch-ins.",
    captionStyle: "outline",
  },
  {
    id: "screen-demo",
    label: "Screen demo",
    description:
      "Original speech with your imported screens in a split view or full cutaway.",
    captionStyle: "outline",
  },
];
