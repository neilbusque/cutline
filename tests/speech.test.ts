import { describe, expect, it } from "vitest";
import { SpeechInputSchema, speechChunks } from "../src/shared/tts";

describe("Voiceover input and segmentation", () => {
  it("preserves all narration even beyond Kokoro's context window", () => {
    const text = Array.from(
      { length: 140 },
      (_, index) => `Phrase ${index} keeps every word, number and ending.`,
    ).join("\n");
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true);
    expect(chunks.join(" ")).toBe(text.replace(/\s+/g, " "));
    expect(chunks.at(-1)).toContain("Phrase 139");
  });
  it("preserves quotation and abbreviations without dropping words", () => {
    const text =
      'Dr. Smith said, "Ready? Let us begin." A second paragraph follows.\nHere is the last line.';
    expect(speechChunks(text).join(" ")).toBe(text.replace(/\s+/g, " "));
  });
  it("rejects empty, oversized, unknown voice and invalid pace requests before creating files", () => {
    for (const invalid of [
      { text: " " },
      { text: "a".repeat(5001) },
      { text: "hello", voice: "system" },
      { text: "hello", speed: 0 },
      { text: "hello", speed: Infinity },
    ])
      expect(SpeechInputSchema.safeParse(invalid).success).toBe(false);
    expect(() => speechChunks("word".repeat(100))).toThrow("long words");
  });
  it("matches the original Almanac Heart voice and pace by default", () => {
    expect(SpeechInputSchema.parse({ text: "  A new story.  " })).toEqual({
      text: "A new story.",
      voice: "af_heart",
      speed: 1.08,
    });
  });
});
