import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Jobs, Media } from "../src/main/media";
import { createMusicControl, musicTools } from "../src/main/music-control";
import { Store } from "../src/main/store";
import {
  AssetSchema,
  makeClip,
  newProject,
  publicProject,
  type Asset,
} from "../src/shared/model";
import { manualBeatGrid } from "../src/shared/music-sync";
import { createMotionScene } from "../src/shared/motion-presets";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture({ rhythm = true, energy = true } = {}) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "cutline-music-control-"),
  );
  directories.push(directory);
  const store = new Store(path.join(directory, "recovery.json"));
  const jobs = new Jobs(() => {});
  const media = new Media(
    path.join(directory, "media"),
    { ffmpeg: "fake-ffmpeg", ffprobe: "fake-ffprobe", whisper: "", model: "" },
    jobs,
  );
  const p = newProject();
  const music = AssetSchema.parse({
    id: "music-asset",
    name: "Music",
    kind: "audio",
    path: path.join(directory, "music.wav"),
    duration: 12,
    hasAudio: true,
    ...(rhythm
      ? {
          rhythm: {
            ...manualBeatGrid({ bpm: 120, duration: 12 }),
            envelope: { step: 0.05, values: energy ? [0, 0.3, 1, 0.2] : [] },
          },
        }
      : {}),
  });
  const video = AssetSchema.parse({
    id: "video-asset",
    name: "Silent video",
    kind: "video",
    path: path.join(directory, "video.mp4"),
    duration: 20,
    hasAudio: false,
  });
  for (const asset of [music, video])
    writeFileSync(asset.path, "local fixture");
  p.assets = [music, video];
  p.clips = [
    { ...makeClip(p, "audio", "audio", 0, music), id: "music", duration: 360 },
    {
      ...makeClip(p, "video", "video", 0, video),
      id: "a",
      duration: 43,
      volume: 0,
    },
    {
      ...makeClip(p, "video", "video", 43, video),
      id: "b",
      duration: 40,
      volume: 0,
    },
    {
      ...makeClip(p, "video", "video", 83, video),
      id: "c",
      duration: 37,
      volume: 0,
    },
    { ...makeClip(p, "text", "titles", 0), id: "title", duration: 120 },
    {
      ...makeClip(p, "caption", "captions", 0),
      id: "caption",
      duration: 30,
      text: "Caption",
    },
  ];
  store.commit(p, "Fixture");
  const control = createMusicControl({ store, media, jobs, directory });
  const args = (patch: Record<string, unknown> = {}) => ({
    projectId: store.project.id,
    revision: store.project.revision,
    musicClipId: "music",
    ...patch,
  });
  const imported = (file: string): Asset =>
    AssetSchema.parse({
      id: "generated-asset",
      name: "Imported music",
      path: file,
      kind: "audio",
      duration: 1,
      hasAudio: true,
    });
  return { directory, store, jobs, media, control, args, imported };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pcm() {
  const samples = Buffer.alloc(11025 * 4);
  for (let i = 0; i < 11025; i++)
    samples.writeFloatLE(i < 1000 ? Math.sin(i * 0.06) * 0.4 : 0, i * 4);
  return samples;
}

describe("music editing service and undo", () => {
  it("exposes revision-checked mutation schemas and a read-only inspect tool", () => {
    expect(musicTools.map((tool) => tool.name).sort()).toEqual([
      "cutline_music_analyze",
      "cutline_music_create",
      "cutline_music_grid",
      "cutline_music_inspect",
      "cutline_music_reactive",
      "cutline_music_sync",
    ]);
    for (const tool of musicTools) {
      const schema = tool.inputSchema as any;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      if (tool.name !== "cutline_music_inspect")
        expect(schema.required).toEqual(
          expect.arrayContaining(["projectId", "revision"]),
        );
      expect(tool.annotations.readOnlyHint).toBe(
        tool.name === "cutline_music_inspect",
      );
    }
  });

  it("rejects stale revisions and foreign projects before any async media work", async () => {
    const f = fixture();
    const imported = vi.spyOn(f.media, "import");
    const exec = vi.spyOn(f.jobs, "exec");
    const before = JSON.stringify(f.store.project);
    for (const command of ["analyze", "grid", "sync", "reactive", "create"]) {
      const fields =
        command === "create"
          ? {
              projectId: f.store.project.id,
              revision: f.store.project.revision - 1,
              seconds: 1,
            }
          : f.args({
              revision: f.store.project.revision - 1,
              ...(command === "grid" ? { bpm: 120 } : {}),
              ...(["sync", "reactive"].includes(command)
                ? { clipIds: ["a", "b"] }
                : {}),
            });
      await expect(
        f.control(`cutline_music_${command}`, fields),
      ).rejects.toThrow("Project changed");
    }
    await expect(
      f.control(
        "music.grid",
        f.args({ projectId: "another-project", bpm: 120 }),
      ),
    ).rejects.toThrow("Project changed");
    expect(imported).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(JSON.stringify(f.store.project)).toBe(before);
  });

  it("sets a manual source grid while preserving measured energy and supports undo/redo", async () => {
    const f = fixture();
    const envelope = structuredClone(
      f.store.project.assets[0].rhythm!.envelope,
    );
    const history = f.store.past.length;
    const result = (await f.control(
      "music.grid",
      f.args({ bpm: 150, offsetSeconds: 0.25 }),
    )) as any;
    expect(result.rhythm).toMatchObject({
      source: "manual",
      bpm: 150,
      confidence: 1,
      envelope,
    });
    expect(
      result.rhythm.beats.slice(0, 3).map((beat: any) => beat.time),
    ).toEqual([0.25, 0.65, 1.05]);
    expect(f.store.past).toHaveLength(history + 1);
    const persisted = JSON.parse(readFileSync(f.store.recovery, "utf8"));
    expect(persisted.project.assets[0].rhythm.bpm).toBe(150);
    f.store.undo();
    expect(f.store.project.assets[0].rhythm!.bpm).toBe(120);
    f.store.redo();
    expect(f.store.project.assets[0].rhythm!.bpm).toBe(150);
    expect(f.store.project.assets[0].rhythm!.envelope).toEqual(envelope);
  });

  it("composes and places asset, track and clip atomically in one undo step", async () => {
    const f = fixture();
    vi.spyOn(f.media, "import").mockImplementation(async (file) =>
      f.imported(file),
    );
    const before = structuredClone(f.store.project);
    const history = f.store.past.length;
    const result = (await f.control("cutline_music_create", {
      projectId: before.id,
      revision: before.revision,
      seconds: 1,
      style: "bold",
      startFrame: 60,
    })) as any;
    expect(f.store.past).toHaveLength(history + 1);
    expect(f.store.project.revision).toBe(before.revision + 1);
    const asset = f.store.project.assets.find(
      (item) => item.id === result.assetId,
    )!;
    const clip = f.store.project.clips.find(
      (item) => item.id === result.musicClipId,
    )!;
    expect(asset).toMatchObject({
      duration: 1,
      rhythm: { source: "generated", bpm: 116, confidence: 1, duration: 1 },
    });
    expect(asset.rhythm!.envelope.values).toHaveLength(20);
    expect(asset.rhythm!.envelope.values.some((value) => value > 0)).toBe(true);
    expect(clip).toMatchObject({
      kind: "audio",
      assetId: asset.id,
      start: 60,
      duration: 30,
      volume: 0.45,
    });
    expect(clip.trackId).not.toBe("audio");
    expect(f.store.project.tracks).toHaveLength(before.tracks.length + 1);
    expect(readFileSync(asset.path).subarray(0, 4).toString()).toBe("RIFF");
    f.store.undo();
    expect(f.store.project.assets).toEqual(before.assets);
    expect(f.store.project.clips).toEqual(before.clips);
    expect(f.store.project.tracks).toEqual(before.tracks);
    f.store.redo();
    expect(
      f.store.project.clips.some((item) => item.id === result.musicClipId),
    ).toBe(true);
  });

  it("places composed music on top of an edit made while it was generated", async () => {
    const f = fixture();
    const started = deferred<string>();
    const resume = deferred<Asset>();
    vi.spyOn(f.media, "import").mockImplementation((file) => {
      started.resolve(file);
      return resume.promise;
    });
    const before = structuredClone(f.store.project);
    const task = f.control("music.create", {
      projectId: before.id,
      revision: before.revision,
      seconds: 1,
      style: "clean",
    });
    const file = await started.promise;
    f.store.commit(
      { ...f.store.project, name: "Newer edit" },
      "Concurrent edit",
    );
    const history = f.store.past.length;
    resume.resolve(f.imported(file));
    const result = (await task) as any;
    expect(f.store.project.name).toBe("Newer edit");
    expect(f.store.project.assets.map((a) => a.id)).toContain(result.assetId);
    expect(f.store.project.clips.some((c) => c.id === result.musicClipId)).toBe(
      true,
    );
    expect(f.store.past).toHaveLength(history + 1);
    f.store.undo();
    expect(f.store.project.name).toBe("Newer edit");
    expect(f.store.project.assets).toEqual(before.assets);
  });

  it("does not add composed music to a different project opened meanwhile", async () => {
    const f = fixture();
    const started = deferred<string>();
    const resume = deferred<Asset>();
    vi.spyOn(f.media, "import").mockImplementation((file) => {
      started.resolve(file);
      return resume.promise;
    });
    const task = f.control("music.create", {
      projectId: f.store.project.id,
      revision: f.store.project.revision,
      seconds: 1,
      style: "clean",
    });
    const file = await started.promise;
    f.store.fresh();
    resume.resolve(f.imported(file));
    await expect(task).rejects.toThrow("Another project");
    expect(f.store.project.assets).toEqual([]);
  });

  it("stores detected measurements in one edit and cleans decoder temporary files", async () => {
    const f = fixture({ rhythm: false });
    vi.spyOn(f.jobs, "exec").mockImplementation(async (_bin, args) => {
      await writeFile(args.at(-1)!, pcm());
      return { stdout: "", stderr: "" };
    });
    const history = f.store.past.length;
    const result = (await f.control("music.analyze", f.args())) as any;
    expect(result.rhythm).toMatchObject({
      source: "detected",
      duration: 1,
      envelope: { step: 0.05 },
    });
    expect(result.rhythm.envelope.values).toHaveLength(20);
    expect(f.store.past).toHaveLength(history + 1);
    expect(f.store.project.assets[0].rhythm).toEqual(result.rhythm);
    f.store.undo();
    expect(f.store.project.assets[0].rhythm).toBeUndefined();
  });

  it("attaches measurements on top of an edit made during analysis", async () => {
    const f = fixture({ rhythm: false });
    const started = deferred<void>(),
      resume = deferred<void>();
    vi.spyOn(f.jobs, "exec").mockImplementation(async (_bin, args) => {
      await writeFile(args.at(-1)!, pcm());
      started.resolve();
      await resume.promise;
      return { stdout: "", stderr: "" };
    });
    const task = f.control("music.analyze", f.args());
    await started.promise;
    f.store.commit(
      { ...f.store.project, name: "Changed during decode" },
      "Concurrent edit",
    );
    const history = f.store.past.length;
    resume.resolve();
    const result = (await task) as any;
    expect(f.store.project.name).toBe("Changed during decode");
    expect(f.store.project.assets[0].rhythm).toEqual(result.rhythm);
    expect(f.store.past).toHaveLength(history + 1);
  });

  it("attaches no measurements when the music was removed during analysis", async () => {
    const f = fixture({ rhythm: false });
    const started = deferred<void>(),
      resume = deferred<void>();
    vi.spyOn(f.jobs, "exec").mockImplementation(async (_bin, args) => {
      await writeFile(args.at(-1)!, pcm());
      started.resolve();
      await resume.promise;
      return { stdout: "", stderr: "" };
    });
    const task = f.control("music.analyze", f.args());
    await started.promise;
    f.store.commit(
      {
        ...f.store.project,
        clips: f.store.project.clips.filter((c) => c.id !== "music"),
        assets: f.store.project.assets.filter((a) => a.id !== "music-asset"),
      },
      "Delete music",
    );
    const history = f.store.past.length;
    resume.resolve();
    await expect(task).rejects.toThrow("removed");
    expect(f.store.past).toHaveLength(history);
  });

  it("binds measured energy to selected visuals and removes it in one undoable edit", async () => {
    const f = fixture();
    const history = f.store.past.length;
    await f.control(
      "music.reactive",
      f.args({
        clipIds: ["a", "title"],
        mode: "energy",
        style: "scale",
        amount: 0.6,
        releaseFrames: 12,
      }),
    );
    expect(f.store.past).toHaveLength(history + 1);
    for (const id of ["a", "title"])
      expect(
        f.store.project.clips.find((clip) => clip.id === id)!.musicReactive,
      ).toEqual({
        musicClipId: "music",
        mode: "energy",
        style: "scale",
        amount: 0.6,
        releaseFrames: 12,
      });
    expect(
      f.store.project.clips.find((clip) => clip.id === "b")!.musicReactive,
    ).toBeUndefined();
    await f.control(
      "music.reactive",
      f.args({ clipIds: ["a", "title"], remove: true, mode: "energy" }),
    );
    expect(
      f.store.project.clips.find((clip) => clip.id === "a")!.musicReactive,
    ).toBeUndefined();
    f.store.undo();
    expect(
      f.store.project.clips.find((clip) => clip.id === "a")!.musicReactive!
        .amount,
    ).toBe(0.6);
    f.store.undo();
    expect(
      f.store.project.clips.find((clip) => clip.id === "a")!.musicReactive,
    ).toBeUndefined();
  });

  it("binds only graphical motion accents and preserves scope and custom decay on partial updates", async () => {
    const f = fixture();
    const scene = createMotionScene(f.store.project, 0, "kinetic-title");
    f.store.transact({
      projectId: f.store.project.id,
      revision: f.store.project.revision,
      label: "Add scene",
      commands: scene.commands,
    });
    const past = f.store.past.length;
    await f.control(
      "music.reactive",
      f.args({
        clipIds: [scene.clip.id],
        scope: "accents",
        style: "scale",
        amount: 0.16,
        releaseFrames: 17,
      }),
    );
    expect(
      f.store.project.clips.find((clip) => clip.id === scene.clip.id)
        ?.musicReactive,
    ).toMatchObject({ scope: "accents", releaseFrames: 17 });
    await f.control(
      "music.reactive",
      f.args({ clipIds: [scene.clip.id], style: "scale", amount: 0.22 }),
    );
    expect(
      f.store.project.clips.find((clip) => clip.id === scene.clip.id)
        ?.musicReactive,
    ).toMatchObject({ scope: "accents", releaseFrames: 17, amount: 0.22 });
    expect(f.store.past).toHaveLength(past + 2);
    f.store.undo();
    expect(
      f.store.project.clips.find((clip) => clip.id === scene.clip.id)
        ?.musicReactive?.amount,
    ).toBe(0.16);
    f.store.undo();
    expect(
      f.store.project.clips.find((clip) => clip.id === scene.clip.id)
        ?.musicReactive,
    ).toBeUndefined();
  });

  it("rejects an accent-only batch atomically when a target has no motion scene", async () => {
    const f = fixture();
    const scene = createMotionScene(f.store.project, 0, "kinetic-title");
    f.store.transact({
      projectId: f.store.project.id,
      revision: f.store.project.revision,
      label: "Add scene",
      commands: scene.commands,
    });
    const before = JSON.stringify(f.store.project),
      past = f.store.past.length;
    await expect(
      f.control(
        "music.reactive",
        f.args({ clipIds: [scene.clip.id, "a"], scope: "accents" }),
      ),
    ).rejects.toThrow(/Graphical accents require/);
    expect(JSON.stringify(f.store.project)).toBe(before);
    expect(f.store.past).toHaveLength(past);
  });

  it("allows removal after rhythm measurements were cleared", async () => {
    const f = fixture();
    await f.control("music.reactive", f.args({ clipIds: ["a"] }));
    f.store.commit(
      {
        ...f.store.project,
        assets: f.store.project.assets.map((asset) => ({
          ...asset,
          rhythm: undefined,
        })),
      },
      "Clear measurements",
    );
    await f.control(
      "music.reactive",
      f.args({ clipIds: ["a"], remove: true, mode: "energy" }),
    );
    expect(
      f.store.project.clips.find((clip) => clip.id === "a")!.musicReactive,
    ).toBeUndefined();
  });

  it("removes a binding after its music clip was deleted and keeps repeated removal a no-op", async () => {
    const f = fixture();
    await f.control("music.reactive", f.args({ clipIds: ["a", "title"] }));
    f.store.commit(
      {
        ...f.store.project,
        clips: f.store.project.clips.filter((clip) => clip.id !== "music"),
      },
      "Delete bound music",
    );
    const revision = f.store.project.revision;
    const history = f.store.past.length;
    await f.control(
      "music.reactive",
      f.args({ clipIds: ["a", "title"], remove: true, mode: "energy" }),
    );
    for (const id of ["a", "title"])
      expect(
        f.store.project.clips.find((clip) => clip.id === id)!.musicReactive,
      ).toBeUndefined();
    expect(f.store.project.revision).toBe(revision + 1);
    expect(f.store.past).toHaveLength(history + 1);
    const removed = JSON.stringify(f.store.project);
    await f.control(
      "music.reactive",
      f.args({ clipIds: ["a", "title"], remove: true }),
    );
    expect(JSON.stringify(f.store.project)).toBe(removed);
    expect(f.store.project.revision).toBe(revision + 1);
    expect(f.store.past).toHaveLength(history + 1);
    f.store.undo();
    expect(f.store.project.clips.some((clip) => clip.id === "music")).toBe(
      false,
    );
    expect(
      f.store.project.clips.find((clip) => clip.id === "a")!.musicReactive!
        .musicClipId,
    ).toBe("music");
  });

  it("rejects beat bindings without detected beats without changing revision or undo history", async () => {
    const f = fixture();
    f.store.commit(
      {
        ...f.store.project,
        assets: f.store.project.assets.map((asset) =>
          asset.id === "music-asset"
            ? {
                ...asset,
                rhythm: {
                  ...asset.rhythm!,
                  source: "detected" as const,
                  bpm: undefined,
                  confidence: 0,
                  beats: [],
                },
              }
            : asset,
        ),
      },
      "No steady onsets detected",
    );
    const before = JSON.stringify(f.store.project);
    const revision = f.store.project.revision;
    const history = f.store.past.length;
    for (const patch of [{}, { mode: "beat" }])
      await expect(
        f.control(
          "music.reactive",
          f.args({ clipIds: ["a", "title"], ...patch }),
        ),
      ).rejects.toThrow(/No beats were detected/);
    expect(JSON.stringify(f.store.project)).toBe(before);
    expect(f.store.project.revision).toBe(revision);
    expect(f.store.past).toHaveLength(history);
    await f.control(
      "music.reactive",
      f.args({ clipIds: ["a"], mode: "energy" }),
    );
    expect(
      f.store.project.clips.find((clip) => clip.id === "a")!.musicReactive!
        .mode,
    ).toBe("energy");
  });

  it("rejects unavailable energy, captions, missing IDs and duplicate targets atomically", async () => {
    const f = fixture({ energy: false });
    const before = JSON.stringify(f.store.project);
    const history = f.store.past.length;
    for (const patch of [
      { clipIds: ["a"], mode: "energy" },
      { clipIds: ["a", "caption"] },
      { clipIds: ["a", "missing"] },
      { clipIds: ["a", "music"] },
      { clipIds: ["a", "a"] },
      { clipIds: ["a"], musicClipId: "missing" },
    ])
      await expect(
        f.control("music.reactive", f.args(patch)),
      ).rejects.toThrow();
    expect(JSON.stringify(f.store.project)).toBe(before);
    expect(f.store.past).toHaveLength(history);
    const unmeasured = fixture({ rhythm: false });
    await expect(
      unmeasured.control("music.reactive", unmeasured.args({ clipIds: ["a"] })),
    ).rejects.toThrow(/Analyze the music/);
  });

  it("previews sync commands, commits the same plan once, and avoids history entries for no-op sync", async () => {
    const f = fixture();
    const before = structuredClone(f.store.project);
    const history = f.store.past.length;
    const dry = (await f.control(
      "music.sync",
      f.args({ clipIds: ["a", "b", "c"], dryRun: true }),
    )) as any;
    expect(dry.commands.length).toBeGreaterThan(0);
    expect(dry.summary.changedClips).toBe(3);
    expect(dry).toMatchObject({ dryRun: true, revision: before.revision });
    expect(f.store.project).toEqual(before);
    expect(f.store.past).toHaveLength(history);
    const result = (await f.control(
      "music.sync",
      f.args({ clipIds: ["a", "b", "c"] }),
    )) as any;
    expect(result.commands).toEqual(dry.commands);
    expect(f.store.past).toHaveLength(history + 1);
    expect(
      f.store.project.clips
        .filter((clip) => ["a", "b", "c"].includes(clip.id))
        .map((clip) => [clip.start, clip.duration]),
    ).toEqual([
      [0, 45],
      [45, 45],
      [90, 30],
    ]);
    const revision = f.store.project.revision;
    const noop = (await f.control(
      "music.sync",
      f.args({ clipIds: ["a", "b", "c"] }),
    )) as any;
    expect(noop.commands).toEqual([]);
    expect(f.store.project.revision).toBe(revision);
    expect(f.store.past).toHaveLength(history + 1);
    f.store.undo();
    expect(f.store.project.clips).toEqual(before.clips);
  });

  it("inspects mapped beat frames without exposing the large measured envelope or source path", async () => {
    const f = fixture();
    const before = JSON.stringify(f.store.project);
    const result = (await f.control("music.inspect", {
      musicClipId: "music",
    })) as any;
    expect(result.rhythm.bpm).toBe(120);
    expect(result.beatFrames.slice(0, 4)).toEqual([0, 15, 30, 45]);
    expect(result.rhythm.envelope).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(f.directory);
    expect(JSON.stringify(f.store.project)).toBe(before);
    await expect(
      f.control("music.inspect", { musicClipId: "missing" }),
    ).rejects.toThrow(/placed music/);
  });

  it("summarizes long rhythm metadata in public projects without changing stored samples or beats", async () => {
    const f = fixture();
    const rhythm = {
      ...manualBeatGrid({ bpm: 240, duration: 1200 }),
      envelope: {
        step: 0.05,
        values: Array.from({ length: 24000 }, (_, i) => (i % 10) / 10),
      },
    };
    f.store.commit(
      {
        ...f.store.project,
        assets: f.store.project.assets.map((asset) =>
          asset.id === "music-asset"
            ? { ...asset, duration: 1200, rhythm }
            : asset,
        ),
      },
      "Long music metadata",
    );
    const stored = f.store.project.assets[0].rhythm!;
    const summary = publicProject(f.store.project).assets[0].rhythm!;
    expect(summary).toMatchObject({
      version: 1,
      source: "manual",
      bpm: 240,
      confidence: 1,
      duration: 1200,
      beatCount: 4801,
      energyMeasured: true,
      envelopeStep: 0.05,
    });
    expect(summary).not.toHaveProperty("beats");
    expect(summary).not.toHaveProperty("envelope");
    expect(summary).not.toHaveProperty("envelope.values");
    expect(JSON.stringify(summary).length).toBeLessThan(250);
    expect(JSON.stringify(publicProject(f.store.project))).not.toContain(
      f.directory,
    );
    expect(stored.beats).toHaveLength(4801);
    expect(stored.envelope.values).toHaveLength(24000);
    expect(stored.envelope.values.slice(0, 4)).toEqual([0, 0.1, 0.2, 0.3]);
    const defaultPage = (await f.control("cutline_music_inspect", {
      musicClipId: "music",
    })) as any;
    expect(defaultPage.limit).toBe(500);
    expect(defaultPage.rhythm.beats).toHaveLength(500);
    expect(defaultPage.rhythm.beatCount).toBe(4801);
    expect(defaultPage.hasMore).toBe(true);
    const unmeasured = fixture({ energy: false });
    expect(
      publicProject(unmeasured.store.project).assets[0].rhythm!.energyMeasured,
    ).toBe(false);
  });

  it("pages source beats and timeline frames while preserving total counts and read-only revision", async () => {
    const f = fixture();
    const before = JSON.stringify(f.store.project),
      history = f.store.past.length;
    const page = (await f.control("cutline_music_inspect", {
      musicClipId: "music",
      offset: 2,
      limit: 3,
    })) as any;
    expect(page).toMatchObject({
      offset: 2,
      limit: 3,
      hasMore: true,
      timelineBeatCount: 24,
      rhythm: { beatCount: 25, energyMeasured: true, envelopeStep: 0.05 },
    });
    expect(page.rhythm.beats.map((beat: any) => beat.time)).toEqual([
      1, 1.5, 2,
    ]);
    expect(page.beatFrames).toEqual([30, 45, 60]);
    expect(page.rhythm).not.toHaveProperty("envelope");
    const last = (await f.control("cutline_music_inspect", {
      musicClipId: "music",
      offset: 23,
      limit: 3,
    })) as any;
    // The source grid includes its endpoint; timeline frames remain inside the clip's exclusive end.
    expect(last.rhythm.beats.map((beat: any) => beat.time)).toEqual([11.5, 12]);
    expect(last.beatFrames).toEqual([345]);
    expect(last.hasMore).toBe(false);
    await expect(
      f.control("cutline_music_inspect", { musicClipId: "music", limit: 1001 }),
    ).rejects.toThrow();
    expect(JSON.stringify(f.store.project)).toBe(before);
    expect(f.store.past).toHaveLength(history);
  });

  it("returns a compact agent grid summary while persisting the full grid and energy", async () => {
    const f = fixture();
    const envelope = structuredClone(
      f.store.project.assets[0].rhythm!.envelope,
    );
    const result = (await f.control(
      "cutline_music_grid",
      f.args({ bpm: 150, offsetSeconds: 0.25 }),
    )) as any;
    expect(result.rhythm).toMatchObject({
      version: 1,
      source: "manual",
      bpm: 150,
      beatCount: 30,
      energyMeasured: true,
      envelopeStep: 0.05,
    });
    expect(result.rhythm).not.toHaveProperty("beats");
    expect(result.rhythm).not.toHaveProperty("envelope");
    const stored = f.store.project.assets[0].rhythm!;
    expect(stored.beats).toHaveLength(30);
    expect(stored.beats.slice(0, 3).map((beat) => beat.time)).toEqual([
      0.25, 0.65, 1.05,
    ]);
    expect(stored.envelope).toEqual(envelope);
    const saved = JSON.parse(readFileSync(f.store.recovery, "utf8")).project
      .assets[0].rhythm;
    expect(saved.beats).toHaveLength(30);
    expect(saved.envelope).toEqual(envelope);
    expect(result.revision).toBe(f.store.project.revision);
  });
});
