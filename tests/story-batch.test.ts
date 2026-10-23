import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StoryBatchProduction } from "../src/main/story-batch";
import { StoryControl } from "../src/main/story-control";
import { StoryProduction } from "../src/main/story-production";
import { Jobs } from "../src/main/media";
import { Store } from "../src/main/store";
import { StoryPlanSchema } from "../src/shared/story-schema";
import { makeClip } from "../src/shared/model";
import { speechVoices } from "../src/shared/tts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "cutline-story-batch-"));
  const audio = path.join(dir, "voice.wav");
  writeFileSync(audio, "local test fixture");
  const store = new Store(path.join(dir, "recovery.cutline"));
  cleanups.push(() => {
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });
  store.commit(
    {
      ...store.project,
      story: StoryPlanSchema.parse({
        scenes: ["First idea.", "Second idea."].map((narration, index) => ({
          id: `scene-${index}`,
          title: `Scene ${index + 1}`,
          narration,
          duration: 1,
          design: { layout: "title", headline: narration },
        })),
      }),
    },
    "Write outline",
  );
  let counter = 0;
  const speech = {
    status: vi.fn(async () => ({
      ready: true,
      engine: "Kokoro 82M" as const,
      downloadMB: 80,
      voices: speechVoices,
      defaultVoice: "af_heart" as const,
      defaultSpeed: 1.08,
    })),
    generate: vi.fn(async () => ({
      path: audio,
      duration: 2,
      text: "First idea.",
      voice: "af_heart",
    })),
  };
  const media = {
    import: vi.fn(async () => ({
      id: `audio-${counter++}`,
      kind: "audio" as const,
      name: "voice",
      path: audio,
      duration: 2,
      hasAudio: true,
    })),
    transcribe: vi.fn(async () => [
      { text: "First", start: 0.1, end: 0.6 },
      { text: "idea.", start: 0.7, end: 1.5 },
    ]),
  };
  const jobs = new Jobs(() => {});
  const production = new StoryProduction({ store, speech, media, jobs });
  const control = new StoryControl({
    store,
    generation: {} as never,
    configured: async () => false,
  });
  const batch = new StoryBatchProduction({ store, production, control, jobs });
  const edit = (change: (p: typeof store.project) => void) => {
    const next = structuredClone(store.project);
    change(next);
    store.commit(next, "Concurrent edit");
  };
  return {
    audio,
    store,
    speech,
    media,
    jobs,
    production,
    control,
    batch,
    edit,
    args: () => ({
      projectId: store.project.id,
      revision: store.project.revision,
    }),
  };
}

describe("local story production", () => {
  it("creates sequential narration, real captions and editable graphics, then reuses audio on rebuild", async () => {
    const f = fixture();
    const entered = deferred(),
      finish = deferred();
    f.speech.generate.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return {
        path: f.audio,
        duration: 2,
        text: "First idea.",
        voice: "af_heart",
      };
    });
    const pending = f.batch.produce(f.args());
    await entered.promise;
    expect(f.speech.generate).toHaveBeenCalledTimes(1);
    await expect(f.batch.produce(f.args())).rejects.toThrow(
      "already being produced",
    );
    f.edit((p) => {
      p.name = "Keep my name edit";
    });
    finish.resolve();
    const first = await pending;
    expect(first.voicesCreated).toBe(2);
    expect(first.voicesReused).toBe(0);
    expect(first.captionCount).toBeGreaterThan(0);
    expect(first.durationFrames).toBe(f.store.project.fps * 4);
    expect(f.store.project.name).toBe("Keep my name edit");
    expect(f.store.project.motions).toHaveLength(2);
    const clipCount = f.store.project.clips.length;
    const second = await f.batch.produce(f.args());
    expect(second.voicesCreated).toBe(0);
    expect(second.voicesReused).toBe(2);
    expect(f.speech.generate).toHaveBeenCalledTimes(2);
    expect(f.store.project.clips).toHaveLength(clipCount);
    expect(f.store.project.motions).toHaveLength(2);
    expect(second.story.assembly?.clipIds).toEqual(
      f.store.project.story!.assembly!.clipIds,
    );
  });

  it("rejects stale input and missing screen media before synthesis", async () => {
    const f = fixture();
    await expect(
      f.batch.produce({ ...f.args(), revision: f.args().revision - 1 }),
    ).rejects.toThrow("Project changed");
    f.edit((p) => {
      p.story!.scenes[1].design!.layout = "screen";
    });
    await expect(f.batch.produce(f.args())).rejects.toThrow(
      "real screenshot or video",
    );
    expect(f.speech.status).not.toHaveBeenCalled();
    expect(f.store.project.clips).toHaveLength(0);
  });

  it("stops when the plan changes and keeps completed narration without assembling", async () => {
    const f = fixture();
    const entered = deferred(),
      finish = deferred();
    f.media.transcribe.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return [
        { text: "First", start: 0.1, end: 0.6 },
        { text: "idea.", start: 0.7, end: 1.5 },
      ];
    });
    const pending = f.batch.produce(f.args());
    await entered.promise;
    f.edit((p) => {
      p.story!.scenes[1].design!.headline = "Keep this new idea";
    });
    finish.resolve();
    await expect(pending).rejects.toThrow("storyline changed");
    expect(f.speech.generate).toHaveBeenCalledTimes(1);
    expect(f.store.project.story!.scenes[0].voiceAssetId).toBeTruthy();
    expect(f.store.project.story!.scenes[1].design!.headline).toBe(
      "Keep this new idea",
    );
    expect(f.store.project.clips).toHaveLength(0);
  });

  it("cancels before the next voice and can resume without regenerating finished audio", async () => {
    const f = fixture();
    const nativeUpdate = f.jobs.update.bind(f.jobs);
    vi.spyOn(f.jobs, "update").mockImplementation((job, patch) => {
      nativeUpdate(job, patch);
      if (
        job.kind === "story-produce" &&
        patch.message?.startsWith("Narration 2")
      )
        f.jobs.cancel(job.id);
    });
    await expect(f.batch.produce(f.args())).rejects.toThrow("cancelled");
    expect(f.speech.generate).toHaveBeenCalledTimes(1);
    expect(f.store.project.clips).toHaveLength(0);
    vi.mocked(f.jobs.update).mockRestore();
    const result = await f.batch.produce(f.args());
    expect(result.voicesCreated).toBe(1);
    expect(result.voicesReused).toBe(1);
  });

  it("propagates parent cancellation into in-flight child jobs and never assembles", async () => {
    const f = fixture();
    const entered = deferred(),
      finish = deferred();
    f.speech.generate.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return {
        path: "unused.wav",
        duration: 2,
        text: "First idea.",
        voice: "af_heart",
      };
    });
    const pending = f.batch.produce(f.args());
    await entered.promise;
    const parent = [...f.jobs.jobs.values()].find(
      (job) => job.kind === "story-produce",
    )!;
    f.jobs.cancel(parent.id);
    expect(
      [...f.jobs.jobs.values()].find((job) => job.kind === "story-voice")!
        .state,
    ).toBe("cancelled");
    finish.resolve();
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(f.media.import).not.toHaveBeenCalled();
    expect(f.store.project.clips).toHaveLength(0);
  });

  it("retains voice for a failed caption retry and refuses an incomplete captioned timeline", async () => {
    const f = fixture();
    f.media.transcribe.mockRejectedValueOnce(Error("alignment unavailable"));
    await expect(f.batch.produce(f.args())).rejects.toThrow(
      "captions could not be aligned",
    );
    expect(f.store.project.clips).toHaveLength(0);
    expect(f.store.project.story!.scenes[0].voiceAssetId).toBeTruthy();
    const result = await f.batch.produce(f.args());
    expect(result.voicesReused).toBe(1);
    expect(f.speech.generate).toHaveBeenCalledTimes(2);
  });

  it("retries unusable saved timing without regenerating narration", async () => {
    const f = fixture();
    await f.batch.produce(f.args());
    const firstVoice = f.store.project.story!.scenes[0].voiceAssetId;
    f.edit((p) => {
      p.assets.find((asset) => asset.id === firstVoice)!.words = [
        { text: "Invalid", start: 4, end: 5 },
      ];
    });
    f.media.transcribe.mockRejectedValueOnce(Error("retry unavailable"));
    await expect(f.batch.produce(f.args())).rejects.toThrow(
      "captions could not be aligned",
    );
    expect(
      f.store.project.assets.find((asset) => asset.id === firstVoice)!.words,
    ).toBeUndefined();
    const result = await f.batch.produce(f.args());
    expect(result.voicesReused).toBe(2);
    expect(f.speech.generate).toHaveBeenCalledTimes(2);
  });

  it("does not replace manual edits to an existing owned story sequence", async () => {
    const f = fixture();
    await f.batch.produce(f.args());
    f.edit((p) => {
      p.story!.scenes[0].narration = "Changed narration.";
    });
    const entered = deferred(),
      finish = deferred();
    f.speech.generate.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return {
        path: f.store.project.assets[0].path,
        duration: 2,
        text: "Changed narration.",
        voice: "af_heart",
      };
    });
    const pending = f.batch.produce(f.args());
    await entered.promise;
    const clipId = f.store.project.story!.assembly!.clipIds[0];
    f.edit((p) => {
      p.clips.find((clip) => clip.id === clipId)!.opacity = 0.65;
    });
    finish.resolve();
    await expect(pending).rejects.toThrow("previous story sequence changed");
    expect(
      f.store.project.clips.find((clip) => clip.id === clipId)!.opacity,
    ).toBe(0.65);
  });

  it.each(["switch", "reopen"])(
    "stops safely after a project %s",
    async (action) => {
      const f = fixture();
      const entered = deferred(),
        finish = deferred();
      f.speech.generate.mockImplementationOnce(async () => {
        entered.resolve();
        await finish.promise;
        return {
          path: f.audio,
          duration: 2,
          text: "First idea.",
          voice: "af_heart",
        };
      });
      const pending = f.batch.produce(f.args());
      await entered.promise;
      if (action === "switch") f.store.fresh();
      else f.store.openSession = "reopened-same-project";
      const opened = structuredClone(f.store.project);
      finish.resolve();
      await expect(pending).rejects.toThrow(/project|session|opened/i);
      expect(f.store.project).toEqual(opened);
      expect(f.store.project.clips).toHaveLength(0);
    },
  );

  it("honors cancellation at the assembly boundary", async () => {
    const f = fixture();
    const nativeUpdate = f.jobs.update.bind(f.jobs);
    vi.spyOn(f.jobs, "update").mockImplementation((job, patch) => {
      nativeUpdate(job, patch);
      if (
        job.kind === "story-produce" &&
        patch.message === "Building editable scenes"
      )
        f.jobs.cancel(job.id);
    });
    await expect(f.batch.produce(f.args())).rejects.toThrow("cancelled");
    expect(
      f.store.project.story!.scenes.every((scene) => scene.voiceAssetId),
    ).toBe(true);
    expect(f.store.project.clips).toHaveLength(0);
  });

  it("preserves unrelated timeline work while building a silent explainer without a model", async () => {
    const f = fixture();
    const track = {
      id: "outside",
      name: "My titles",
      kind: "text" as const,
      muted: false,
      hidden: false,
    };
    const outside = makeClip(f.store.project, "text", track.id, 0);
    f.edit((p) => {
      p.tracks.push(track);
      p.clips.push(outside);
      p.story!.scenes.forEach((scene) => {
        scene.narration = "";
      });
    });
    const result = await f.batch.produce(f.args());
    expect(f.speech.status).not.toHaveBeenCalled();
    expect(result.startFrame).toBe(outside.start + outside.duration);
    expect(
      f.store.project.clips.find((clip) => clip.id === outside.id),
    ).toEqual(outside);
  });
});
