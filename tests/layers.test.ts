import { it, expect } from "vitest";
import { newProject, makeClip, type Asset } from "../src/shared/model";
import { stackAssets, sequenceAssets, titleLayer } from "../src/shared/layers";
import { applyCommands } from "../src/shared/commands";
import { filterFor } from "../src/shared/effects";
function fixture() {
  const p = newProject();
  p.assets = ["video", "video", "audio", "audio"].map((kind, i) => ({
    id: `asset${i}`,
    name: `file${i}`,
    path: `/tmp/file${i}`,
    kind: kind as Asset["kind"],
    hasAudio: kind === "audio",
    duration: 4,
  }));
  return p;
}
it("stacks video and audio assets at one playhead on distinct compatible tracks", () => {
  const p = fixture();
  const commands = stackAssets(p, p.assets, 30);
  const n = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Stack",
    commands,
  });
  expect(n.clips).toHaveLength(4);
  expect(new Set(n.clips.map((c) => c.trackId)).size).toBe(4);
  expect(n.clips.every((c) => c.start === 30)).toBe(true);
  for (const c of n.clips)
    expect(n.tracks.find((t) => t.id === c.trackId)?.kind).toBe(c.kind);
  expect(new Set(n.tracks.map((t) => t.name)).size).toBe(n.tracks.length);
});
it("sequences video and audio independently on primary tracks", () => {
  const p = fixture();
  const n = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Sequence",
    commands: sequenceAssets(p, p.assets),
  });
  expect(n.clips.map((c) => c.start)).toEqual([0, 120, 0, 120]);
  expect(n.clips.map((c) => c.trackId)).toEqual([
    "video",
    "video",
    "audio",
    "audio",
  ]);
});
it("overlapping titles receive independent text layers", () => {
  let p = newProject();
  for (let i = 0; i < 3; i++) {
    const t = titleLayer(p, 0, "fade");
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "title",
      commands: t.commands,
    });
  }
  expect(new Set(p.clips.map((c) => c.trackId)).size).toBe(3);
  expect(p.clips.some((c) => c.trackId === "captions")).toBe(false);
});
it("non-overlapping titles reuse available layers", () => {
  let p = newProject();
  const t = titleLayer(p, 0, "fade");
  p = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "title",
    commands: t.commands,
  });
  expect(titleLayer(p, 120, "slide").clip.trackId).toBe(t.clip.trackId);
});
it("reordering a layer preserves its clips", () => {
  const p = fixture();
  p.clips = [makeClip(p, "video", "video", 0, p.assets[0])];
  const n = applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "order",
    commands: [{ type: "track.move", id: "video", direction: "up" }],
  });
  expect(n.tracks.map((t) => t.id)).toEqual([
    "titles",
    "video",
    "captions",
    "audio",
  ]);
  expect(n.clips).toEqual(p.clips);
});
it("neutral clips do not allocate a CSS filter effect", () =>
  expect(filterFor(makeClip(newProject(), "text", "titles"))).toBe("none"));
