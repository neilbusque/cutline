import { z } from "zod";

export const speechVoices = [
  {
    id: "af_heart",
    name: "Heart",
    accent: "American",
    description: "Warm and clear · default voice",
  },
  {
    id: "af_bella",
    name: "Bella",
    accent: "American",
    description: "Bright and expressive",
  },
  {
    id: "af_nicole",
    name: "Nicole",
    accent: "American",
    description: "Soft and intimate",
  },
  {
    id: "af_sarah",
    name: "Sarah",
    accent: "American",
    description: "Calm and conversational",
  },
  {
    id: "am_michael",
    name: "Michael",
    accent: "American",
    description: "Steady and direct",
  },
  {
    id: "am_fenrir",
    name: "Fenrir",
    accent: "American",
    description: "Confident and full",
  },
  {
    id: "bf_emma",
    name: "Emma",
    accent: "British",
    description: "Composed and clear",
  },
  {
    id: "bm_george",
    name: "George",
    accent: "British",
    description: "Measured and warm",
  },
] as const;
export type SpeechVoice = (typeof speechVoices)[number]["id"];
export const SpeechInputSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Write something to narrate.")
    .max(5000, "Keep each voiceover under 5,000 characters."),
  voice: z
    .enum(speechVoices.map((v) => v.id) as [SpeechVoice, ...SpeechVoice[]])
    .default("af_heart"),
  speed: z.number().finite().min(0.65).max(1.5).default(1.08),
  name: z.string().trim().max(100).optional(),
});
export type SpeechInput = z.infer<typeof SpeechInputSchema>;
export type TtsStatus = {
  ready: boolean;
  engine: "Kokoro 82M";
  downloadMB: number;
  voices: typeof speechVoices;
  defaultVoice: SpeechVoice;
  defaultSpeed: number;
};

// Bound each synthesis request; Kokoro has a 512-token context. The worker
// additionally checks untruncated tokens, so no part of a script is discarded.
export function speechChunks(text: string, maxLength = 220): string[] {
  const words = text.trim().split(/\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxLength)
      throw Error(
        "Split very long words or links before generating a voiceover.",
      );
    if (current && current.length + word.length + 1 > maxLength) {
      chunks.push(current);
      current = "";
    }
    current += (current ? " " : "") + word;
    if (/[.!?…][\"')\]]?$/.test(word) && current.length >= 45) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
