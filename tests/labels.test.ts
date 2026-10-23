import { describe, expect, it } from "vitest";
import { clipLabel } from "../src/renderer/labels";

const motion = (
  layers: { type: string; name?: string; text?: string }[],
  name = "Kinetic title",
) => ({
  id: "m1",
  name,
  layers,
});

describe("timeline clip labels", () => {
  it.each(["Headline", "Statement"])(
    "uses a product scene's %s instead of its repeated brand",
    (name) => {
      const c = {
        kind: "text",
        text: "",
        preset: "custom",
        motionId: "m1",
      } as const;
      expect(
        clipLabel(c, [
          motion([
            { type: "text", name: "Brand", text: "CUTLINE" },
            { type: "text", name, text: "  Turn ideas into video.  " },
          ]),
        ]),
      ).toBe("Turn ideas into video.");
    },
  );

  it("keeps the first-text fallback when a named headline has no visible text", () => {
    const c = {
      kind: "text",
      text: "",
      preset: "custom",
      motionId: "m1",
    } as const;
    expect(
      clipLabel(c, [
        motion([
          { type: "text", name: "Brand", text: "CUTLINE" },
          { type: "text", name: "Headline", text: "   " },
        ]),
      ]),
    ).toBe("CUTLINE");
  });

  it("names a custom motion clip by the text it shows", () => {
    const c = {
      kind: "text",
      text: "Your story starts here",
      preset: "custom",
      motionId: "m1",
    } as const;
    expect(
      clipLabel(c, [
        motion([{ type: "line" }, { type: "text", text: "Cutline 0.14" }]),
      ]),
    ).toBe("Cutline 0.14");
  });

  it("uses the clip text for a text layer with none of its own", () => {
    const c = {
      kind: "text",
      text: "Launch day",
      preset: "custom",
      motionId: "m1",
    } as const;
    expect(clipLabel(c, [motion([{ type: "text", text: "" }])])).toBe(
      "Launch day",
    );
  });

  it("falls back to the motion name when nothing is written", () => {
    const c = {
      kind: "text",
      text: "",
      preset: "custom",
      motionId: "m1",
    } as const;
    expect(clipLabel(c, [motion([{ type: "star" }], "Logo sting")])).toBe(
      "Logo sting",
    );
  });

  it("keeps clip text, media name and kind for other clips", () => {
    expect(clipLabel({ kind: "text", text: "FOLLOW THE BEAT" }, [])).toBe(
      "FOLLOW THE BEAT",
    );
    expect(clipLabel({ kind: "video", text: "" }, [], "Interview.mp4")).toBe(
      "Interview.mp4",
    );
    expect(clipLabel({ kind: "audio", text: "" }, [])).toBe("Audio");
  });
});
