import { z } from "zod";
import { uid } from "./model";
import { productBrand } from "./product-scenes";
import {
  ExplainerMetadataSchema,
  ExplainerStyleSchema,
  ProductDesignSchema,
  STORY_SCENE_LIMIT,
  StoryPlanSchema,
  type ProductDesign,
  type StoryPlan,
} from "./story-schema";

export type ExplainerStyleId = z.infer<typeof ExplainerStyleSchema>;

/** Reference-informed directions, not claims of popularity or provider output. */
export const explainerStyles: ReadonlyArray<{
  id: ExplainerStyleId;
  name: string;
  description: string;
  requiresMedia: boolean;
  preview: { headline: string; detail: string };
}> = [
  {
    id: "kinetic",
    name: "Kinetic type",
    description:
      "Big phrases, deliberate scale changes, and a moving graphic motif.",
    requiresMedia: false,
    preview: { headline: "One clear idea.", detail: "Words lead the story" },
  },
  {
    id: "screen",
    name: "Product focus",
    description:
      "A clear opening, real product screens, and a useful next step.",
    requiresMedia: true,
    preview: {
      headline: "Show how it works.",
      detail: "Your screenshots or recordings",
    },
  },
  {
    id: "diagram",
    name: "Sketch flow",
    description:
      "Editable steps, drawn connectors, and side-by-side comparisons.",
    requiresMedia: false,
    preview: {
      headline: "Make the connection.",
      detail: "Explain a process visually",
    },
  },
  {
    id: "editorial",
    name: "Editorial collage",
    description:
      "Layered paper, considered labels, and expressive statement layouts.",
    requiresMedia: false,
    preview: {
      headline: "A different perspective.",
      detail: "Paper, type, and contrast",
    },
  },
];

export const ExplainerInputSchema = ExplainerMetadataSchema.extend({
  script: z
    .string()
    .trim()
    .min(1, "Add your script or key points first.")
    .max(60000, "Keep the total explainer script under 60,000 characters."),
});
export type ExplainerInput = z.infer<typeof ExplainerInputSchema>;

const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const sentences = (value: string) =>
  Array.from(
    new Intl.Segmenter("en", { granularity: "sentence" }).segment(value),
    (part) => part.segment.trim(),
  ).filter(Boolean);

/** Keep authored words intact; only layout copy is excerpted. */
function narrationBeats(script: string) {
  const beats: string[] = [];
  const paragraphs = script
    .replace(/\r\n?/gu, "\n")
    // An authored newline is a useful, explicit scene boundary for both
    // scripts and key-point lists. Retain bullet/number markers verbatim.
    .split(/\n/gu)
    .map(normalize)
    .filter(Boolean);
  for (const paragraph of paragraphs) {
    let beat = "";
    for (const sentence of sentences(paragraph)) {
      if (sentence.length > 5000)
        throw Error(
          "A sentence is longer than 5,000 characters. Add sentence breaks before creating the explainer.",
        );
      // Natural sentences stay whole. A longer sentence gets its own beat;
      // actual narration duration determines the final timeline length.
      if (
        beat &&
        (beat.length + sentence.length > 360 || beat.split(/\s+/u).length >= 55)
      ) {
        beats.push(beat);
        beat = "";
      }
      beat = beat ? `${beat} ${sentence}` : sentence;
    }
    if (beat) beats.push(beat);
  }
  if (beats.length > STORY_SCENE_LIMIT)
    throw Error(
      `This script needs ${beats.length} scenes. Use at most ${STORY_SCENE_LIMIT} scenes by shortening the script or joining short lines.`,
    );
  if (normalize(beats.join(" ")) !== normalize(script))
    throw Error(
      "The script could not be split without changing its text. Add clear paragraph breaks and try again.",
    );
  return beats;
}

/** A visual excerpt, never a replacement for the full narration. */
function excerpt(value: string, maxWords: number, maxCharacters: number) {
  const words = normalize(value).split(" ");
  let result = "";
  for (const word of words.slice(0, maxWords)) {
    const next = result ? `${result} ${word}` : word;
    if (next.length > maxCharacters) break;
    result = next;
  }
  // A single very long token is still retained in the narration.
  return result || "";
}

function designFor(
  input: ExplainerInput,
  narration: string,
  index: number,
  count: number,
): ProductDesign {
  const parts = sentences(narration);
  const opening = index === 0;
  const closing = index === count - 1;
  const headline =
    closing && input.cta
      ? input.cta
      : opening
        ? input.topic
        : excerpt(parts[0], 9, 96) || input.topic;
  const body = excerpt(
    parts[opening || (closing && input.cta) ? 0 : 1] ?? "",
    22,
    160,
  );
  const pointSource = narration.split(/(?:[.!?;]\s+|\n+)/u).filter(Boolean);
  const points = pointSource
    .map((part) => excerpt(part, 9, 90))
    .filter(Boolean)
    .slice(0, 3);
  let layout: ProductDesign["layout"];
  switch (input.style) {
    case "kinetic":
      layout = "kinetic";
      break;
    case "screen":
      layout =
        count < 3
          ? index % 2
            ? "split"
            : "screen"
          : opening
            ? "kinetic"
            : closing
              ? "cta"
              : index % 2
                ? "screen"
                : "split";
      break;
    case "diagram":
      layout =
        closing && count > 1 && points.length >= 2 ? "comparison" : "process";
      break;
    case "editorial":
      layout =
        closing || (index > 0 && index % 2 === 0)
          ? "editorial-quote"
          : "editorial";
      break;
  }
  return ProductDesignSchema.parse({
    layout,
    headline,
    body,
    eyebrow:
      closing && count > 1
        ? "The takeaway"
        : opening
          ? "The idea"
          : `Part ${index + 1}`,
    points,
    motion: input.style === "kinetic" ? "snappy" : "smooth",
  });
}

/** Local planning only. No generated claims, audio, media, or credit spending. */
export function createExplainerStory(
  raw: ExplainerInput,
  previous?: StoryPlan,
): StoryPlan {
  const input = ExplainerInputSchema.parse(raw);
  const beats = narrationBeats(input.script);
  const prior = previous ? StoryPlanSchema.parse(previous) : undefined;
  const used = new Set<string>();
  const scenes = beats.map((narration, index) => {
    // Stable scene identity preserves narration/media when switching styles.
    // Match the complete normalized text so changed words cannot silently
    // reuse old speech. Existing voice signatures still guard speech settings.
    const candidate = prior?.scenes[index];
    const matched =
      candidate &&
      normalize(candidate.narration) === narration &&
      !used.has(candidate.id)
        ? candidate
        : prior?.scenes.find(
            (scene) =>
              !used.has(scene.id) && normalize(scene.narration) === narration,
          );
    if (matched) used.add(matched.id);
    const title =
      index === 0
        ? "Opening"
        : index === beats.length - 1
          ? "Takeaway"
          : `Explanation ${index + 1}`;
    const design = designFor(input, narration, index, beats.length);
    return {
      ...(matched ? structuredClone(matched) : {}),
      id: matched?.id ?? uid(),
      title,
      narration,
      design,
      duration:
        matched?.duration ??
        Math.min(
          120,
          Math.max(3, Math.ceil(narration.split(/\s+/u).length / 2.5)),
        ),
      visualPrompt:
        design.layout === "screen" || design.layout === "split"
          ? "Choose your own imported screenshot or recording that demonstrates this passage. Keep the real interface visible."
          : "",
      // Keep reference choices for an edited scene, but do not claim its old
      // image, generation, or narration still describes the new words.
      ...(!matched && candidate?.referenceAssetIds
        ? { referenceAssetIds: [...candidate.referenceAssetIds] }
        : {}),
    };
  });
  const direction = explainerStyles.find((style) => style.id === input.style)!;
  return StoryPlanSchema.parse({
    ...(prior ? structuredClone(prior) : {}),
    brief: `${input.topic}${input.audience ? `\nAudience: ${input.audience}` : ""}`,
    style: `${direction.name}. ${direction.description}`,
    brand: prior?.brand ?? { ...productBrand, name: input.topic.slice(0, 80) },
    explainer: {
      style: input.style,
      topic: input.topic,
      audience: input.audience,
      cta: input.cta,
    },
    scenes,
  });
}
