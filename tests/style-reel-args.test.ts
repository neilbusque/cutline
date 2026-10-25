import { describe, expect, it } from "vitest";
import {
  STYLE_REEL_BEAT_LIMIT,
  StyleReelArgsSchema,
} from "../src/main/agent-media";

const beats = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    from: index * 1.6,
    to: (index + 1) * 1.6,
    layout: "split" as const,
    kind: "text" as const,
    show: "Beat",
  }));

const project = { projectId: "project-1", revision: 3, style: "split" as const };

describe("style reel arguments", () => {
  it("takes the beats of a three-minute Short", () => {
    const parsed = StyleReelArgsSchema.safeParse({
      ...project,
      beats: beats(110),
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses more beats than the limit", () => {
    const parsed = StyleReelArgsSchema.safeParse({
      ...project,
      beats: beats(STYLE_REEL_BEAT_LIMIT + 1),
    });
    expect(parsed.success).toBe(false);
  });
});
