import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cutlineTools } from "../src/main/agent-tools";
import { directorStyles, getDirectorGuide } from "../src/shared/director-guide";

describe("director guide style discovery", () => {
  it("advertises every style that the director dispatcher can accept", () => {
    const tool = cutlineTools.find(
      ({ name }) => name === "cutline_director_guide",
    )!;
    const style = tool.inputSchema.properties?.style as { enum: string[] };
    expect(style.enum).toEqual([...directorStyles]);
    expect(style.enum).toContain("promo");
    expect(tool.annotations?.readOnlyHint).toBe(true);

    const parser = z.enum(directorStyles);
    for (const value of style.enum) {
      const guide = getDirectorGuide(parser.parse(value));
      expect(guide.style).toBe(value);
      expect(guide.direction.example.length).toBeGreaterThan(0);
      expect(guide.direction.example.every(({ seconds }) => seconds > 0)).toBe(
        true,
      );
    }
    expect(parser.safeParse("unknown-promo-effect").success).toBe(false);
  });

  it("keeps cinematic as the default while giving promo its own direction", () => {
    expect(getDirectorGuide().style).toBe("cinematic");
    expect(getDirectorGuide("promo").direction).not.toEqual(
      getDirectorGuide().direction,
    );
  });
});
