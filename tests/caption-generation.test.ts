import { describe, expect, it } from "vitest";
import { makeClip, newProject, validateProject } from "../src/shared/model";
import { replaceGeneratedCaptions } from "../src/shared/caption-generation";

function fixture() {
  const p = newProject();
  p.assets.push({
    id: "media",
    name: "Speech",
    kind: "video",
    path: "/local/speech.mp4",
    duration: 10,
    hasAudio: true,
  });
  const source = makeClip(
    p,
    "video",
    p.tracks.find((t) => t.kind === "video")!.id,
    45,
  );
  source.assetId = "media";
  source.duration = 90;
  p.clips.push(source);
  const manual = makeClip(p, "caption", "captions", 45);
  manual.text = "Handwritten";
  p.clips.push(manual);
  const words = [
    { text: "Keep", start: 0.1, end: 0.5 },
    { text: "speaking.", start: 0.6, end: 1.2 },
  ];
  return { p, source, manual, words };
}
describe("Caption regeneration", () => {
  it("replaces the same generated set, retaining unrelated captions and the selected style", () => {
    const { p, source, manual, words } = fixture();
    const first = replaceGeneratedCaptions(p, source.id, words).project;
    const generated = first.clips.find((c) => c.captionSourceId === source.id)!;
    generated.accent = "#ff0044";
    generated.fontSize = 82;
    const second = replaceGeneratedCaptions(first, source.id, words);
    expect(
      second.project.clips.filter((c) => c.captionSourceId === source.id),
    ).toHaveLength(second.count);
    expect(second.project.clips.find((c) => c.id === manual.id)).toEqual(
      manual,
    );
    expect(
      second.project.clips.find((c) => c.captionSourceId === source.id),
    ).toMatchObject({ accent: "#ff0044", fontSize: 82 });
    expect(p.clips).toHaveLength(2);
    expect(() => validateProject(second.project)).not.toThrow();
  });
  it("preserves the project if no speech exists and clips word times to the selected media range", () => {
    const { p, source, words } = fixture();
    const before = structuredClone(p);
    expect(() => replaceGeneratedCaptions(p, source.id, [])).toThrow(
      "existing captions were kept",
    );
    expect(p).toEqual(before);
    const next = replaceGeneratedCaptions(p, source.id, [
      ...words,
      { text: "Ending", start: 2.8, end: 3.5 },
    ]).project;
    for (const c of next.clips.filter((c) => c.captionSourceId === source.id)) {
      expect(c.start).toBeGreaterThanOrEqual(source.start);
      expect(c.start + c.duration).toBeLessThanOrEqual(
        source.start + source.duration,
      );
      expect(
        c.words.every(
          (w) => w.start >= 0 && w.end <= c.duration / p.fps + 1e-6,
        ),
      ).toBe(true);
    }
  });
});
