import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newProject,
  makeClip,
  validateProject,
  MotionSchema,
  type Project,
} from "../src/shared/model";
import {
  applyCommands,
  removePauses,
  type Command,
} from "../src/shared/commands";
import { Store } from "../src/main/store";
import { parseSrt, toSrt, captionClips } from "../src/shared/subtitles";
function fixture() {
  const p = newProject();
  p.assets.push({
    id: "media",
    name: "source.mp4",
    path: "/missing/source.mp4",
    duration: 20,
    kind: "video",
    hasAudio: true,
  });
  p.clips.push({
    ...makeClip(p, "video", "video", 0, p.assets[0]),
    id: "clip",
    duration: 300,
    sourceIn: 2,
    speed: 1.5,
  });
  return p;
}
function tx(p: Project, commands: Command[]) {
  return { projectId: p.id, revision: p.revision, label: "test", commands };
}
describe("atomic editing", () => {
  it("splits source timing correctly at non-unit speed", () => {
    const p = fixture();
    const n = applyCommands(
      p,
      tx(p, [{ type: "clip.split", id: "clip", frame: 120 }]),
    );
    expect(n.clips[0].duration).toBe(120);
    expect(n.clips[1].sourceIn).toBe(8);
    expect(n.clips[1].duration).toBe(180);
    expect(p.clips).toHaveLength(1);
  });
  it("rejects stale edits without mutation", () => {
    const p = fixture();
    expect(() =>
      applyCommands(p, {
        ...tx(p, [{ type: "clip.delete", id: "clip", ripple: false }]),
        revision: 4,
      }),
    ).toThrow("Project changed");
    expect(p.clips).toHaveLength(1);
  });
  it("rejects edits for a different project", () => {
    const p = fixture();
    expect(() =>
      applyCommands(p, {
        ...tx(p, [{ type: "clip.delete", id: "clip", ripple: false }]),
        projectId: "old",
      }),
    ).toThrow();
  });
  it("rolls back the whole transaction when a later command is invalid", () => {
    const p = fixture();
    expect(() =>
      applyCommands(
        p,
        tx(p, [
          { type: "clip.update", id: "clip", patch: { volume: 0.5 } },
          { type: "clip.update", id: "missing", patch: { volume: 0 } },
        ]),
      ),
    ).toThrow();
    expect(p.clips[0].volume).toBe(1);
  });
  it("prevents source overrun", () => {
    const p = fixture();
    expect(() =>
      applyCommands(
        p,
        tx(p, [{ type: "clip.update", id: "clip", patch: { duration: 1000 } }]),
      ),
    ).toThrow("Trim exceeds");
  });
  it("requires a valid split position", () => {
    const p = fixture();
    expect(() =>
      applyCommands(p, tx(p, [{ type: "clip.split", id: "clip", frame: 300 }])),
    ).toThrow();
  });
  it("shifts all later tracks on ripple delete", () => {
    const p = fixture();
    p.clips.push({ ...makeClip(p, "text", "titles", 330), id: "title" });
    const n = applyCommands(
      p,
      tx(p, [{ type: "clip.delete", id: "clip", ripple: true }]),
    );
    expect(n.clips[0].start).toBe(30);
  });
  it("splits caption word timing", () => {
    const p = newProject();
    p.clips = captionClips(p, [
      { text: "hello", start: 0, end: 0.6 },
      { text: "world", start: 0.6, end: 1.2 },
    ]);
    const n = applyCommands(
      p,
      tx(p, [{ type: "clip.split", id: p.clips[0].id, frame: 18 }]),
    );
    expect(n.clips[1].words[0].start).toBe(0);
    expect(n.clips[1].words[0].text).toBe("world");
  });
  it("rejects NaN, duplicate IDs, and malformed motions", () => {
    const p = fixture();
    p.clips[0].speed = NaN;
    expect(() => validateProject(p)).toThrow();
    const a = fixture();
    a.clips.push({ ...a.clips[0] });
    expect(() => validateProject(a)).toThrow("Duplicate");
  });
  it("does not execute arbitrary animation source", () => {
    const m = MotionSchema.parse({
      id: "m",
      name: "safe",
      source: "throw new Error()",
      layers: [
        {
          type: "text",
          keyframes: [
            { frame: 0, opacity: 0 },
            { frame: 10, opacity: 1 },
          ],
        },
      ],
    });
    expect(m.layers).toHaveLength(1);
  });
  it("rejects unbounded custom motion", () => {
    expect(() =>
      MotionSchema.parse({
        id: "m",
        name: "unsafe",
        layers: [{ type: "iframe", keyframes: [{ frame: 0 }] }],
      }),
    ).toThrow();
  });
  it("removes pauses while respecting speed and source in", () => {
    const p = fixture();
    const ops = removePauses(p, "clip", [{ start: 4, end: 6 }]);
    const n = applyCommands(p, tx(p, ops));
    expect(n.clips).toHaveLength(2);
    // Cuts land on whole frames of the original clip, inside the padded pause
    // (5.92s): frame 78 at 1.5x speed starts at 2 + 78 * 1.5 / 30 = 5.9s.
    expect(n.clips[1].sourceIn).toBeCloseTo(5.9);
    expect(n.clips[1].animationOffset).toBe(78);
    expect(n.clips[1].start).toBe(n.clips[0].duration);
  });
});
describe("save and recovery", () => {
  const make = () =>
    new Store(
      path.join(
        mkdtempSync(path.join(os.tmpdir(), "cutline-")),
        "recovery.cutline",
      ),
    );
  it("undo and redo retain monotonic revisions", () => {
    const s = make();
    s.commit(fixture(), "import");
    const rev = s.project.revision;
    s.undo();
    expect(s.project.revision).toBeGreaterThan(rev);
    s.redo();
    expect(s.project.clips).toHaveLength(1);
    expect(s.project.revision).toBeGreaterThan(rev + 1);
  });
  it("recovers the project and history after restart", () => {
    const s = make();
    s.commit(fixture(), "import");
    // Undo history is written in the background and on quit.
    s.flush();
    const recovered = new Store(s.recovery);
    expect(recovered.project.clips).toHaveLength(1);
    expect(recovered.snapshot().canUndo).toBe(true);
    expect(recovered.snapshot().missing).toEqual(["media"]);
  });
  it("preserves the active project when loading malformed files", () => {
    const s = make();
    s.commit(fixture(), "import");
    const file = s.recovery + ".bad";
    writeFileSync(file, '{"version":99}');
    expect(() => s.load(file)).toThrow();
    expect(s.project.clips).toHaveLength(1);
  });
  it("invalidates redo after a new edit", () => {
    const s = make();
    s.commit(fixture(), "import");
    s.undo();
    s.commit({ ...s.project, name: "new" }, "name");
    expect(s.snapshot().canRedo).toBe(false);
  });
});
describe("subtitles", () => {
  it("roundtrips SRT and preserves unicode", () => {
    const p = newProject();
    const words = parseSrt("1\n00:00:01,000 --> 00:00:02,500\nHola, 世界\n");
    p.clips = captionClips(p, words);
    expect(toSrt(p.clips, 30)).toContain("Hola, 世界");
    expect(toSrt(p.clips, 30)).toContain("00:00:01,000 --> 00:00:02,500");
  });
  it("rejects reversed timestamps", () => {
    expect(() => parseSrt("1\n00:00:02,000 --> 00:00:01,000\nNo")).toThrow();
  });
  it("groups words and offsets them onto the timeline", () => {
    const p = newProject();
    const c = captionClips(
      p,
      [
        { text: "A", start: 2, end: 2.4 },
        { text: "B", start: 2.4, end: 3 },
      ],
      5,
    );
    expect(c[0].start).toBe(210);
    expect(c[0].words[0].start).toBe(0);
    expect(c[0].text).toBe("A B");
  });
});

describe("partial update isolation", () => {
  it("changing text preserves all geometry, source timing, style, and words", () => {
    const p = fixture();
    Object.assign(p.clips[0], {
      x: 87,
      y: 93,
      width: 700,
      height: 850,
      color: "#123456",
      volume: 0.4,
      fadeIn: 8,
    });
    const old = structuredClone(p.clips[0]);
    const n = applyCommands(
      p,
      tx(p, [{ type: "clip.update", id: old.id, patch: { text: "New text" } }]),
    );
    expect(n.clips[0]).toEqual({ ...old, text: "New text" });
  });
  it("muting a track does not reset hidden state", () => {
    const p = fixture();
    p.tracks[0].hidden = true;
    const n = applyCommands(
      p,
      tx(p, [
        { type: "track.update", id: p.tracks[0].id, patch: { muted: true } },
      ]),
    );
    expect(n.tracks[0].hidden).toBe(true);
  });
  it("rejects unknown partial properties", () => {
    const p = fixture();
    expect(() =>
      applyCommands(
        p,
        tx(p, [
          { type: "clip.update", id: "clip", patch: { widht: 10 } as any },
        ]),
      ),
    ).toThrow();
  });
});
