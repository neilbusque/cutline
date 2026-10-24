import { describe, expect, it } from "vitest";
import { ClipSchema } from "../src/shared/model";
import {
  captionReplacementPlan,
  captionTextPatch,
  captionTimestamp,
} from "../src/shared/caption-edit";

const caption = () =>
  ClipSchema.parse({
    id: "phrase",
    kind: "caption",
    trackId: "captions",
    start: 150,
    duration: 90,
    text: "A quiet mourning.",
    words: [
      { text: "A", start: 0.1, end: 0.2 },
      { text: "quiet", start: 0.3, end: 0.7 },
      { text: "mourning.", start: 0.8, end: 1.2 },
    ],
  });

describe("Caption text corrections", () => {
  it("corrects words without changing aligned timestamps or caption bounds", () => {
    const original = caption();
    const result = captionTextPatch(original, "  A quiet morning. \n");
    expect(result.timing).toBe("preserved");
    expect(result.patch.words?.map(({ start, end }) => [start, end])).toEqual(
      original.words.map(({ start, end }) => [start, end]),
    );
    expect(result.patch.words?.at(-1)?.text).toBe("morning.");
    expect(result.patch).not.toHaveProperty("start");
    expect(result.patch).not.toHaveProperty("duration");
    expect(original.words.at(-1)?.text).toBe("mourning.");
  });
  it("clears alignment when a phrase gains or loses words instead of inventing times", () => {
    for (const text of ["A very quiet morning.", "Morning."]) {
      const result = captionTextPatch(caption(), text);
      expect(result.timing).toBe("cleared");
      expect(result.patch.words).toEqual([]);
      expect(result.patch.text).toBe(text);
      expect(result.patch).not.toHaveProperty("duration");
    }
  });
  it("handles unaligned imported captions and validates empty/oversized corrections", () => {
    expect(
      captionTextPatch(
        { ...caption(), text: "Mismatched metadata" },
        "Three fresh words",
      ).timing,
    ).toBe("cleared");
    expect(
      captionTextPatch({ text: "Hello", words: [] }, "Hello again").patch.words,
    ).toEqual([]);
    expect(() => captionTextPatch(caption(), " \n ")).toThrow(
      "at least one word",
    );
    expect(() => captionTextPatch(caption(), "a".repeat(10001))).toThrow(
      "10,000",
    );
  });
  it("reviews literal, case-insensitive replacements without regex or replacement-string interpolation", () => {
    const clips = [
      caption(),
      { ...caption(), id: "second", text: "A QUIET morning.", words: [] },
    ];
    const plan = captionReplacementPlan(clips, "quiet", "$& calm");
    expect(plan).toHaveLength(2);
    expect(plan[0].after).toBe("A $& calm mourning.");
    expect(plan[1].after).toBe("A $& calm morning.");
    expect(plan[0].timing).toBe("cleared");
    expect(captionReplacementPlan(clips, "[quiet]", "calm")).toEqual([]);
    expect(captionReplacementPlan(clips, "", "calm")).toEqual([]);
  });
  it("does not include unchanged captions and rejects a replacement that empties a phrase", () => {
    expect(captionReplacementPlan([caption()], "quiet", "quiet")).toEqual([]);
    expect(() =>
      captionReplacementPlan([caption()], "A quiet mourning.", ""),
    ).toThrow("at least one word");
  });
  it("replaces whole words only, never letters inside other words", () => {
    const phrase = (id: string, text: string) => ({
      ...caption(),
      id,
      text,
      words: [],
    });
    const plan = captionReplacementPlan(
      [
        phrase("said", "I said it again"),
        phrase("paint", "Paint the wall again"),
        phrase("ai", "Let AI write it, ai."),
        phrase("contraction", "Don't touch don or Don's"),
      ],
      "ai",
      "A.I.",
    );
    expect(plan.map(({ id, after }) => [id, after])).toEqual([
      ["ai", "Let A.I. write it, A.I.."],
    ]);
    expect(
      captionReplacementPlan(
        [phrase("contraction", "Don't touch don or Don's")],
        "don",
        "Dan",
      ).map((item) => item.after),
    ).toEqual(["Don't touch Dan or Don's"]);
    expect(
      captionReplacementPlan([phrase("name", "Visit café Ünder")], "café", "cafe")[0]
        .after,
    ).toBe("Visit cafe Ünder");
  });
  it("labels exact frame positions at supported frame rates", () => {
    expect(captionTimestamp(1831, 30)).toBe("1:01.03");
    expect(captionTimestamp(59, 60)).toBe("0:00.98");
    expect(captionTimestamp(150, 25)).toBe("0:06.00");
  });
});
