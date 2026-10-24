import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newProject,
  makeClip,
  validateProject,
  publicProject,
  type Project,
} from "../src/shared/model";
import { applyCommands, removePauses } from "../src/shared/commands";
import {
  audioWaveformPath,
  playsForward,
  reversedPartCovers,
  reversedPartHolds,
  reversedRequest,
  sourceSecondsAt,
  trimClip,
} from "../src/shared/timeline";
import { applyAgentEdit, agentEditingGuide } from "../src/shared/agent-edit";
import { searchTranscript } from "../src/shared/transcript";
import { duckClipVolume } from "../src/shared/audio-duck";
import { beatFrames } from "../src/shared/music-sync";
import { musicBindings, musicResponse } from "../src/shared/music-reactive";
import { clipMedia } from "../src/composition/Video";
import { Jobs, Media, reverseChunks } from "../src/main/media";
import { Store } from "../src/main/store";
import { relinkedAsset } from "../src/main/relink";
import { appOpenEnv } from "../src/main/mcp-launcher";
import { clipNote } from "../src/renderer/labels";

const tx = (p: Project, commands: unknown[]) =>
  applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Test edit",
    commands,
  });
const directories: string[] = [];
const folder = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cutline-reverse-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A 10 second shot, placed at 2 s, playing source seconds 3 to 5. */
function fixture() {
  const p = newProject();
  p.assets.push({
    id: "shot",
    name: "shot.mp4",
    path: "/tmp/shot.mp4",
    kind: "video",
    duration: 10,
    hasAudio: true,
    words: [
      { text: "hello", start: 3.2, end: 3.6 },
      { text: "there", start: 3.7, end: 4.1 },
    ],
  });
  p.clips = [
    {
      ...makeClip(p, "video", "video", 2 * p.fps, p.assets[0]),
      id: "clip",
      duration: 2 * p.fps,
      sourceIn: 3,
    },
  ];
  return p;
}
const reversed = (p: Project) =>
  tx(p, [{ type: "clip.update", id: "clip", patch: { reverse: true } }]);
const frozen = (p: Project) =>
  tx(p, [{ type: "clip.update", id: "clip", patch: { freeze: true } }]);
const only = (p: Project, id = "clip") => p.clips.find((c) => c.id === id)!;

describe("reverse", () => {
  it("keeps the same footage and plays it from its last frame to its first", () => {
    const p = reversed(fixture());
    const c = only(p);
    expect(c.reverse).toBe(true);
    // Counted from the end of the source: 10 - (3 + 2) = 5.
    expect(c.sourceIn).toBeCloseTo(5);
    expect(sourceSecondsAt(p, c, 0)).toBeCloseTo(5);
    expect(sourceSecondsAt(p, c, p.fps)).toBeCloseTo(4);
    expect(sourceSecondsAt(p, c, c.duration)).toBeCloseTo(3);
    expect(() => validateProject(p)).not.toThrow();
  });
  it("turning reverse off again returns the original source in", () => {
    const p = reversed(fixture());
    const back = tx(p, [
      { type: "clip.update", id: "clip", patch: { reverse: false } },
    ]);
    expect(only(back).sourceIn).toBeCloseTo(3);
    expect(sourceSecondsAt(back, only(back), 0)).toBeCloseTo(3);
  });
  it("keeps a source in sent together with reverse as given", () => {
    const p = tx(fixture(), [
      {
        type: "clip.update",
        id: "clip",
        patch: { reverse: true, sourceIn: 1 },
      },
    ]);
    expect(only(p).sourceIn).toBe(1);
  });
  it("splits so the right half plays the earlier footage", () => {
    const p = reversed(fixture());
    const at = only(p).start + p.fps;
    const split = tx(p, [{ type: "clip.split", id: "clip", frame: at }]);
    const right = split.clips.find((c) => c.start === at)!;
    expect(right.reverse).toBe(true);
    expect(sourceSecondsAt(split, only(split), 0)).toBeCloseTo(5);
    expect(sourceSecondsAt(split, right, 0)).toBeCloseTo(4);
    expect(sourceSecondsAt(split, right, right.duration)).toBeCloseTo(3);
  });
  it("extends the tail down to the start of the source and no further", () => {
    const p = reversed(fixture());
    const long = trimClip(p, only(p), "right", 99999);
    expect(long.duration).toBe(5 * p.fps);
    expect(sourceSecondsAt(p, long, long.duration)).toBeCloseTo(0);
    expect(() => validateProject({ ...p, clips: [long] })).not.toThrow();
  });
  it("mirrors the waveform", () => {
    const p = fixture();
    const asset = { ...p.assets[0], waveform: [0, 0.5, 1] };
    const whole = { ...only(p), sourceIn: 0, duration: 10 * p.fps };
    expect(
      audioWaveformPath(asset, whole, p.fps).startsWith("M0,20.00V20.00"),
    ).toBe(true);
    const back = { ...whole, reverse: true };
    expect(
      audioWaveformPath(asset, back, p.fps).startsWith("M0,2.00V38.00"),
    ).toBe(true);
  });
  it("is part of the editing guide", () => {
    expect(JSON.stringify(agentEditingGuide())).toMatch(/reverse/);
    expect(JSON.stringify(agentEditingGuide())).toMatch(/freeze/);
  });
  it("converts through an assistant edit like a manual one", () => {
    const p = fixture();
    const result = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Reverse",
      actions: [
        { type: "clip.update", clipId: "clip", patch: { reverse: true } },
      ],
    });
    const c = result.project.clips.find((clip) => clip.id === "clip")!;
    expect(c.reverse).toBe(true);
    expect(c.sourceIn).toBeCloseTo(5);
  });
  it("never sends the reversed copy's path to assistants", () => {
    const p = fixture();
    p.assets[0].reversed = "/cache/shot-reversed.mp4";
    expect(JSON.stringify(publicProject(p))).not.toMatch(/shot-reversed/);
  });
});

describe("freeze", () => {
  it("holds the first frame for as long as the clip runs, past the source", () => {
    const p = frozen(fixture());
    const c = only(p);
    expect(c.freeze).toBe(true);
    const long = trimClip(p, c, "right", c.start + 60 * p.fps);
    expect(long.duration).toBe(60 * p.fps);
    expect(long.sourceIn).toBe(3);
    expect(sourceSecondsAt(p, long, 50 * p.fps)).toBe(3);
    expect(() => validateProject({ ...p, clips: [long] })).not.toThrow();
  });
  it("keeps the held frame when the head is trimmed or the clip is split", () => {
    const p = frozen(fixture());
    const c = only(p);
    const head = trimClip(p, c, "left", 0);
    expect(head.start).toBe(0);
    expect(head.sourceIn).toBe(3);
    const split = tx(p, [
      { type: "clip.split", id: "clip", frame: c.start + 10 },
    ]);
    expect(split.clips.map((clip) => clip.sourceIn)).toEqual([3, 3]);
  });
  it("draws no waveform, since a held frame is silent", () => {
    const p = frozen(fixture());
    const asset = { ...p.assets[0], waveform: [0.5, 0.5] };
    expect(audioWaveformPath(asset, only(p), p.fps)).toBe("");
  });
});

describe("features that read forward media skip reversed and held clips", () => {
  it("says which clips play their source forward", () => {
    const p = fixture();
    expect(playsForward(only(p))).toBe(true);
    expect(playsForward(only(reversed(p)))).toBe(false);
    expect(playsForward(only(frozen(p)))).toBe(false);
  });
  it("finds spoken words only in clips that play forward", () => {
    const forward = searchTranscript(fixture(), { query: "hello" });
    expect(JSON.stringify(forward)).toMatch(/"clipId":"clip"/);
    const back = searchTranscript(reversed(fixture()), { query: "hello" });
    expect(JSON.stringify(back)).not.toMatch(/"clipId":"clip"/);
  });
  it("ducks music under the whole of a reversed voice clip", () => {
    const p = reversed(fixture());
    p.assets.push({
      id: "song",
      name: "song.mp3",
      path: "/tmp/song.mp3",
      kind: "audio",
      duration: 30,
      hasAudio: true,
    });
    p.tracks.push({
      id: "music",
      name: "Music",
      kind: "audio",
      muted: false,
      hidden: false,
    });
    p.clips.push({
      ...makeClip(p, "audio", "music", 0, p.assets[1]),
      id: "music-clip",
    });
    const result = duckClipVolume(p, {
      musicClipId: "music-clip",
      speechClipIds: ["clip"],
    });
    expect(result.warnings.join(" ")).toMatch(/backwards or holds a frame/);
  });
  it("finds no beats and no pulses in reversed music", () => {
    const p = fixture();
    p.assets.push({
      id: "song",
      name: "song.mp3",
      path: "/tmp/song.mp3",
      kind: "audio",
      duration: 10,
      hasAudio: true,
      rhythm: {
        version: 1,
        confidence: 1,
        duration: 10,
        beats: [3.5, 4, 4.5].map((time) => ({ time, strength: 1 })),
        envelope: { step: 0.5, values: Array(21).fill(0.5) },
      },
    });
    p.tracks.push({
      id: "music",
      name: "Music",
      kind: "audio",
      muted: false,
      hidden: false,
    });
    p.clips.push({
      ...makeClip(p, "audio", "music", 0, p.assets[1]),
      id: "song-clip",
      duration: 2 * p.fps,
      sourceIn: 3,
    });
    const target = {
      ...makeClip(p, "text", "text", 0),
      musicReactive: {
        musicClipId: "song-clip",
        scope: "clip" as const,
        mode: "energy" as const,
        style: "both" as const,
        amount: 1,
        releaseFrames: 6,
      },
    };
    const pulse = (project: Project) =>
      musicResponse(
        target,
        5,
        musicBindings({ ...project, clips: [...project.clips, target] }).get(
          "song-clip",
        ),
      );
    expect(beatFrames(p, "song-clip").length).toBe(3);
    expect(pulse(p)).toBeGreaterThan(0);
    const back = tx(p, [
      { type: "clip.update", id: "song-clip", patch: { reverse: true } },
    ]);
    expect(beatFrames(back, "song-clip")).toEqual([]);
    expect(pulse(back)).toBe(0);
  });
  it("refuses to cut pauses from a reversed clip", () => {
    const p = reversed(fixture());
    expect(() => removePauses(p, "clip", [{ start: 3.1, end: 3.9 }])).toThrow(
      /backwards/,
    );
  });
});

describe("composition", () => {
  const p = fixture();
  const asset = p.assets[0];
  it("plays the original or preview copy forward", () => {
    expect(clipMedia(only(p), asset, "http://bridge", false, p.fps)).toEqual({
      src: "http://bridge/media/shot/original",
      pending: false,
      offset: 0,
    });
  });
  it("plays the reversed copy once it exists", () => {
    const c = only(reversed(p));
    expect(clipMedia(c, asset, "http://bridge", true, p.fps)).toEqual({
      src: "http://bridge/media/shot/reversed",
      pending: true,
      offset: 0,
    });
    expect(
      clipMedia(
        c,
        { ...asset, reversed: "/cache/r.mp4" },
        "http://bridge",
        false,
        p.fps,
      ),
    ).toEqual({
      src: "http://bridge/media/shot/reversed",
      pending: false,
      offset: 0,
    });
  });
});

describe("partial reversed copies", () => {
  it("asks for only the part reversed clips play, with room for trims", () => {
    const p = reversed(fixture());
    // Source seconds 3 to 5 played backwards are 5 to 7 seconds before the end.
    expect(reversedRequest(p, p.assets[0])).toEqual({ from: 3, to: 9 });
    expect(reversedRequest(fixture(), p.assets[0])).toBeUndefined();
    // A second reversed clip of the same media widens the one part.
    const two = tx(p, [
      {
        type: "clip.add",
        clip: {
          ...only(p),
          id: "early",
          start: 10 * p.fps,
          duration: p.fps,
          sourceIn: 0.5,
        },
      },
    ]);
    expect(reversedRequest(two, two.assets[0])).toEqual({ from: 0, to: 9 });
  });

  it("plays a part that holds the clip, from where the part starts", () => {
    const p = reversed(fixture());
    const c = only(p);
    const asset = {
      ...p.assets[0],
      reversedPart: "/cache/part.mp4",
      reversedSpan: { from: 3, to: 9 },
    };
    expect(clipMedia(c, asset, "http://bridge", false, p.fps)).toEqual({
      src: "http://bridge/media/shot/reversed-part",
      pending: false,
      offset: 3,
    });
    expect(reversedPartHolds(p, asset)).toBe(true);
    // A part that misses the clip falls back to a whole copy, or waits.
    const short = { ...asset, reversedSpan: { from: 5.5, to: 9 } };
    expect(reversedPartHolds(p, short)).toBe(false);
    expect(clipMedia(c, short, "http://bridge", false, p.fps)).toEqual({
      src: "http://bridge/media/shot/reversed",
      pending: true,
      offset: 0,
    });
    expect(
      clipMedia(
        c,
        { ...short, reversed: "/cache/whole.mp4" },
        "http://bridge",
        false,
        p.fps,
      ).pending,
    ).toBe(false);
    // A frame to spare at each edge, except where the part reaches the media's ends.
    const edge = { from: 5, to: 6.99 };
    expect(
      reversedPartCovers(
        { ...asset, reversedSpan: { from: 5, to: 7 } },
        edge,
        30,
      ),
    ).toBe(false);
    expect(
      reversedPartCovers(
        { ...asset, reversedSpan: { from: 0, to: 10 } },
        edge,
        30,
      ),
    ).toBe(true);
    expect(
      reversedPartCovers(
        { ...asset, reversedSpan: { from: 4, to: 10 } },
        { from: 8, to: 10 },
        30,
      ),
    ).toBe(true);
    expect(
      reversedPartCovers({ ...asset, reversedPart: undefined }, edge, 30),
    ).toBe(false);
  });

  it("the store keeps a part with its span, and drops both once the file is gone", () => {
    const directory = folder();
    const source = path.join(directory, "shot.mp4");
    const copy = path.join(directory, "shot-reversed-90-210.mp4");
    writeFileSync(source, "video");
    writeFileSync(copy, "part of the video backwards");
    const store = new Store(path.join(directory, "recovery.cutline"));
    const p = reversed(fixture());
    p.id = store.project.id;
    p.revision = store.project.revision;
    p.assets[0].path = source;
    store.commit(p, "Add shot");
    store.setPreview(
      "shot",
      { reversedPart: copy, reversedSpan: { from: 3, to: 7 } },
      source,
    );
    expect(store.project.assets[0]).toMatchObject({
      reversedPart: copy,
      reversedSpan: { from: 3, to: 7 },
    });
    expect(store.project.assets[0].reversed).toBeUndefined();
    unlinkSync(copy);
    store.setPreview("shot", {}, source);
    expect(store.project.assets[0].reversedPart).toBeUndefined();
    expect(store.project.assets[0].reversedSpan).toBeUndefined();
  });

  it("drops backwards copies made from the old file when media is relinked", () => {
    const old = {
      ...fixture().assets[0],
      reversed: "/cache/shot-reversed.mp4",
      reversedPart: "/cache/shot-reversed-30-90.mp4",
      reversedSpan: { from: 1, to: 3 },
    };
    const { asset } = relinkedAsset(
      old,
      { ...fixture().assets[0], path: "/Volumes/Drive/shot.mp4" },
      30,
    );
    expect(asset.path).toBe("/Volumes/Drive/shot.mp4");
    expect(asset).not.toHaveProperty("reversed");
    expect(asset).not.toHaveProperty("reversedPart");
    expect(asset).not.toHaveProperty("reversedSpan");
  });

  it("never sends partial copies to assistants", () => {
    const p = fixture();
    p.assets[0].reversedPart = "/cache/shot-reversed-1-2.mp4";
    p.assets[0].reversedSpan = { from: 1, to: 2 };
    expect(JSON.stringify(publicProject(p))).not.toMatch(/reversed/);
  });
});

describe("reversed copies", () => {
  it("cuts the reverse into chunks that fit the memory budget and cover every frame", () => {
    expect(reverseChunks(100, 10, 250)).toEqual([
      { start: 0, count: 25 },
      { start: 25, count: 25 },
      { start: 50, count: 25 },
      { start: 75, count: 25 },
    ]);
    const tiny = reverseChunks(7, 1e9, 1);
    expect(tiny.length).toBe(7);
    expect(tiny.reduce((sum, chunk) => sum + chunk.count, 0)).toBe(7);
    expect(reverseChunks(0, 10, 100)).toEqual([]);
  });
  it("the store adopts a reversed copy and drops it when the file is gone", () => {
    const directory = folder();
    const source = path.join(directory, "shot.mp4");
    const copy = path.join(directory, "shot-reversed.mp4");
    writeFileSync(source, "video");
    writeFileSync(copy, "reversed video");
    const store = new Store(path.join(directory, "recovery.cutline"));
    const p = fixture();
    p.id = store.project.id;
    p.revision = store.project.revision;
    p.assets[0].path = source;
    store.commit(p, "Add shot");
    store.setPreview("shot", { reversed: copy }, source);
    expect(store.project.assets[0].reversed).toBe(copy);
    unlinkSync(copy);
    store.setPreview("shot", {}, source);
    expect(store.project.assets[0].reversed).toBeUndefined();
  });
});

describe("frame rate", () => {
  it("can be chosen while the timeline is empty", () => {
    const p = newProject();
    p.clips = [];
    expect(tx(p, [{ type: "project.update", patch: { fps: 24 } }]).fps).toBe(
      24,
    );
    const viaAgent = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Frame rate",
      actions: [{ type: "project.update", patch: { fps: 25 } }],
    });
    expect(viaAgent.project.fps).toBe(25);
  });
  it("is fixed once clips are placed, since their timing is in frames", () => {
    const p = fixture();
    expect(() =>
      tx(p, [
        { type: "project.update", patch: { fps: 24 === p.fps ? 30 : 24 } },
      ]),
    ).toThrow(/before adding clips/);
    expect(
      tx(p, [{ type: "project.update", patch: { fps: p.fps, name: "Same" } }])
        .name,
    ).toBe("Same");
  });
});

describe("timeline", () => {
  it("notes reversed and held clips after their name", () => {
    expect(clipNote({ reverse: false, freeze: false })).toBe("");
    expect(clipNote({ reverse: true, freeze: false })).toBe("Reversed");
    expect(clipNote({ reverse: false, freeze: true })).toBe("Freeze frame");
    expect(clipNote({ reverse: true, freeze: true })).toBe(
      "Reversed · Freeze frame",
    );
  });
});

describe("opening Cutline from an assistant", () => {
  it("does not pass Electron's node mode on to the app", () => {
    expect(
      appOpenEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin", HOME: "/h" }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/h" });
  });
});

const ffmpeg = path.resolve(
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.resolve(
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const hasTools =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  existsSync(ffmpeg) &&
  existsSync(ffprobe);
const W = 32,
  H = 24;
const grey = (file: string) => {
  const raw = execFileSync(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `scale=${W}:${H},format=gray`,
    "-f",
    "rawvideo",
    "-",
  ]);
  const frames: Buffer[] = [];
  for (let at = 0; at + W * H <= raw.length; at += W * H)
    frames.push(raw.subarray(at, at + W * H));
  return frames;
};
const difference = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};
const meanVolume = (file: string, from: number, seconds: number) => {
  const result = spawnSync(
    ffmpeg,
    [
      "-v",
      "info",
      "-ss",
      String(from),
      "-t",
      String(seconds),
      "-i",
      file,
      "-vn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const match = String(result.stderr).match(/mean_volume: (-?[\d.]+|-inf) dB/);
  return !match || match[1] === "-inf" ? -120 : Number(match[1]);
};

describe.runIf(hasTools)("reversing real media with the bundled ffmpeg", () => {
  it("plays the last frame first and the sound backwards, across chunk boundaries", async () => {
    const directory = folder();
    const file = path.join(directory, "count.mp4");
    // Two seconds of a moving test pattern; the tone sounds only in the first half second.
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x120:rate=24:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-filter_complex",
      "[1:a]volume='if(lt(t,0.5),1,0)':eval=frame[a]",
      "-map",
      "0:v",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      file,
    ]);
    const jobs = new Jobs(() => {});
    const media = new Media(
      path.join(directory, "cache"),
      { ffmpeg, ffprobe, whisper: "", model: "" },
      jobs,
    );
    const asset = await media.import(file);
    // About ten frames per chunk, so the copy is stitched from five pieces.
    const out = await media.reversedCopy(asset, { budget: 160 * 120 * 4 * 10 });
    expect(existsSync(out)).toBe(true);
    const source = grey(file),
      back = grey(out);
    expect(back.length).toBe(source.length);
    for (let i = 0; i < back.length; i++)
      expect(difference(back[i], source[source.length - 1 - i])).toBeLessThan(
        6,
      );
    // The tone now sounds at the end.
    expect(meanVolume(out, 1.55, 0.4)).toBeGreaterThan(
      meanVolume(out, 0.05, 0.4) + 20,
    );
    // Asking again reuses the finished copy.
    expect(await media.reversedCopy(asset)).toBe(out);
  }, 60_000);

  it("reverses only the part reversed clips play, frame for frame like the whole copy", async () => {
    const directory = folder();
    const file = path.join(directory, "count.mp4");
    // Two seconds of a moving test pattern; the tone sounds only in the first half second.
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x120:rate=24:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-filter_complex",
      "[1:a]volume='if(lt(t,0.5),1,0)':eval=frame[a]",
      "-map",
      "0:v",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      file,
    ]);
    const jobs = new Jobs(() => {});
    const media = new Media(
      path.join(directory, "cache"),
      { ffmpeg, ffprobe, whisper: "", model: "" },
      jobs,
    );
    const asset = await media.import(file);
    const whole = grey(await media.reversedCopy(asset));
    // Half a second to 1.2 seconds before the end: backwards frames 12 to 28.
    const middle = await media.reversedPart(asset, { from: 0.5, to: 1.2 });
    expect(middle.reversedSpan).toEqual({ from: 12 / 24, to: 29 / 24 });
    const frames = grey(middle.reversedPart);
    expect(frames.length).toBe(17);
    for (let i = 0; i < frames.length; i++)
      expect(difference(frames[i], whole[12 + i])).toBeLessThan(6);
    // A part that reaches the start of the media holds its sound backwards too.
    const last = await media.reversedPart(asset, { from: 1.2, to: 2 });
    expect(last.reversedSpan.from).toBe(28 / 24);
    expect(last.reversedSpan.to).toBeGreaterThanOrEqual(asset.duration);
    expect(grey(last.reversedPart).length).toBe(20);
    expect(meanVolume(last.reversedPart, 0.45, 0.3)).toBeGreaterThan(
      meanVolume(last.reversedPart, 0, 0.25) + 20,
    );
    // Asking again reuses the part.
    expect(
      (await media.reversedPart(asset, { from: 0.5, to: 1.2 })).reversedPart,
    ).toBe(middle.reversedPart);
    // The editor's background work makes a part, never a whole copy.
    const p = newProject();
    p.assets = [asset];
    p.clips = [
      {
        ...makeClip(p, "video", "video", 0, asset),
        id: "back",
        duration: 6,
        sourceIn: 0.3,
        reverse: true,
      },
    ];
    const ready: any[] = [];
    media.on("preview", (event) => ready.push(event));
    media.ensureReversed(validateProject(p));
    await media.previewsIdle();
    expect(ready).toHaveLength(1);
    expect(ready[0].reversedPart).toMatch(/-reversed-\d+-\d+\.mp4$/);
    expect(ready[0].reversed).toBeUndefined();
  }, 60_000);
});
