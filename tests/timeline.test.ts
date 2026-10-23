import { describe, it, expect } from "vitest";
import { newProject, makeClip, validateProject } from "../src/shared/model";
import { trimClip, compatibleTrack } from "../src/shared/timeline";
function fixture() {
  const p = newProject();
  p.assets.push({
    id: "source",
    name: "source.mp4",
    path: "/tmp/source.mp4",
    kind: "video",
    duration: 10,
    hasAudio: true,
  });
  const c = {
    ...makeClip(p, "video", "video", 90, p.assets[0]),
    duration: 90,
    sourceIn: 2,
    speed: 2,
  };
  p.clips = [c];
  return { p, c };
}
describe("timeline source boundaries", () => {
  it("clamps the right edge to original media at non-unit speed", () => {
    const { p, c } = fixture();
    const n = trimClip(p, c, "right", 99999);
    expect(n.duration).toBe(120);
    expect(n.sourceIn).toBe(2);
    expect(() => validateProject({ ...p, clips: [n] })).not.toThrow();
  });
  it("clamps the left edge at source zero and preserves its end frame", () => {
    const { p, c } = fixture();
    const n = trimClip(p, c, "left", 0);
    expect(n.start).toBe(60);
    expect(n.sourceIn).toBe(0);
    expect(n.start + n.duration).toBe(180);
  });
  it("cannot trim through the opposite edge", () => {
    const { p, c } = fixture();
    expect(trimClip(p, c, "left", 900).duration).toBe(1);
    expect(trimClip(p, c, "right", 0).duration).toBe(1);
  });
  it("trims caption words and displayed text on both edges", () => {
    const p = newProject();
    const c = {
      ...makeClip(p, "caption", "captions", 30),
      duration: 90,
      text: "one two three",
      words: [
        { text: "one", start: 0, end: 0.8 },
        { text: "two", start: 1, end: 1.8 },
        { text: "three", start: 2, end: 2.8 },
      ],
    };
    const left = trimClip(p, c, "left", 60);
    expect(left.text).toBe("two three");
    expect(left.words[0].start).toBe(0);
    const right = trimClip(p, c, "right", 75);
    expect(right.text).toBe("one two");
    expect(right.words[1].end).toBe(1.5);
  });
  it("does not source-bound still images", () => {
    const { p, c } = fixture();
    p.assets[0].kind = "image";
    p.assets[0].duration = 0;
    expect(trimClip(p, { ...c, kind: "image" }, "right", 900).duration).toBe(
      810,
    );
  });
  it("only accepts media on compatible tracks", () => {
    const p = newProject();
    expect(compatibleTrack({ kind: "audio" }, p.tracks[2])).toBe(false);
    expect(compatibleTrack({ kind: "caption" }, p.tracks[0])).toBe(true);
    expect(compatibleTrack({ kind: "image" }, p.tracks[2])).toBe(true);
  });
});

import { audioWaveformPath } from "../src/shared/timeline";
it("waveforms show the trimmed source interval instead of the entire asset", () => {
  const { p, c } = fixture();
  const asset = { ...p.assets[0], waveform: [0, 0, 1, 1, 0], duration: 10 };
  const all = audioWaveformPath(
    asset,
    { ...c, sourceIn: 0, duration: 300, speed: 1 },
    30,
  );
  const trimmed = audioWaveformPath(
    asset,
    { ...c, sourceIn: 5, duration: 30, speed: 1 },
    30,
  );
  expect(all.startsWith("M0,20.00V20.00")).toBe(true);
  expect(trimmed.startsWith("M0,2.00V38.00")).toBe(true);
});
