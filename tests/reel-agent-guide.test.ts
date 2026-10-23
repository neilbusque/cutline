import { describe, expect, it } from "vitest";
import { cutlineTools } from "../src/main/agent-tools";
import { effectsGuideResult } from "../src/shared/agent-guide";
import { cutlineWorkflow } from "../src/shared/assistant-instructions";
import { getDirectorGuide } from "../src/shared/director-guide";
import { ReelOptionsSchema } from "../src/shared/reel";
import { reelFormats } from "../src/shared/reel-formats";
import { AutoReelOptionsSchema } from "../src/shared/auto-reel-options";

describe("Reel format discovery for assistants", () => {
  it("routes creator Shorts to supported formats and explains proof timing", () => {
    const guide = effectsGuideResult().reel;
    expect(guide.requestFormats["Nathan Bentley"]).toBe("creator-punch");
    expect(guide.requestFormats["Nate Herk"]).toBe("screen-demo");
    for (const format of ["creator-punch", "screen-demo"]) {
      expect(AutoReelOptionsSchema.safeParse({ format }).success).toBe(true);
      expect(
        ReelOptionsSchema.safeParse({
          sources: [{ assetId: "speaker" }],
          targetSeconds: 30,
          format,
          proofBeats: [
            {
              sourceIndex: 0,
              sourceSeconds: 4,
              assetId: "screen",
              durationSeconds: 3,
              layout: "split",
            },
          ],
        }).success,
      ).toBe(true);
    }
    expect(guide.proofBeats).toContain("absolute speaker source time");
    expect(guide.proofBeats).toContain("output seconds");
    expect(guide.proofBeats).toContain("Auto edit");
    expect(
      AutoReelOptionsSchema.safeParse({ format: "screen-demo", proofBeats: [] })
        .success,
    ).toBe(false);
    expect(cutlineWorkflow).toContain("not semantic best moments");
  });
  it("exposes every advertised format through the real tool schema", () => {
    const tool = cutlineTools.find(
      ({ name }) => name === "cutline_create_reel",
    )!;
    const options = tool.inputSchema.properties?.options as {
      properties: Record<string, { enum?: string[] }>;
    };
    const guide = effectsGuideResult().reel;
    expect(options.properties.format.enum).toEqual(
      reelFormats.map(({ id }) => id),
    );
    expect(guide.formats.map(({ id }) => id)).toEqual(
      options.properties.format.enum,
    );
    for (const format of guide.formats) {
      expect(
        ReelOptionsSchema.safeParse({
          sources: [{ assetId: "actual-source" }],
          targetSeconds: 30,
          format: format.id,
          captionStyle: format.captionStyle,
          beats: [],
        }).success,
      ).toBe(true);
    }
    expect(getDirectorGuide("social").reelFormats).toEqual(guide.formats);
    expect(tool.description).toContain("cutline_effects_guide");
  });

  it("teaches explicit source timing and keeps paid generation separate", () => {
    const guide = effectsGuideResult().reel;
    expect(guide.beats).toContain("absolute source-media time");
    expect(guide.beats).toContain("[] disables");
    expect(cutlineWorkflow).toContain(
      "sourceSeconds is the absolute source-media timestamp",
    );
    expect(cutlineWorkflow).toContain(
      "A format choice does not authorize paid generation",
    );
    expect(cutlineWorkflow).toContain("format is independent of style");
    expect(cutlineWorkflow).not.toContain("\u2014");
  });

  it("maps educational creator requests to a format supported by both builders", () => {
    const guide = effectsGuideResult().reel;
    const format = guide.requestFormats["Ali Abdaal"];
    expect(format).toBe("creator-education");
    expect(guide.requestFormats["educational storyteller"]).toBe(format);
    expect(guide.formats.find(({ id }) => id === format)?.label).toBe(
      "Ali Abdaal-inspired",
    );
    expect(
      ReelOptionsSchema.safeParse({
        sources: [{ assetId: "speaker-source" }],
        targetSeconds: 30,
        format,
        beats: [],
      }).success,
    ).toBe(true);
    expect(AutoReelOptionsSchema.safeParse({ format }).success).toBe(true);
    const tool = cutlineTools.find(({ name }) => name === "cutline_auto_edit")!;
    const options = tool.inputSchema.properties?.options as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(options.properties.format.enum).toContain(format);
  });
});
