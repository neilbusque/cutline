import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Jobs } from "../src/main/media";
import { Store } from "../src/main/store";
import { StoryProduction } from "../src/main/story-production";
import { StoryPlanSchema, storyNarrationSignature } from "../src/shared/story";
import { speechVoices } from "../src/shared/tts";
import type { Asset } from "../src/shared/model";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "cutline-story-voice-"));
  const audioPath = path.join(directory, "narration.wav");
  writeFileSync(audioPath, "test media");
  const store = new Store(path.join(directory, "recovery.cutline"));
  cleanups.push(() => {
    store.flush();
    rmSync(directory, { recursive: true, force: true });
  });
  const plan = StoryPlanSchema.parse({
    scenes: [
      {
        id: "scene-one",
        title: "Opening",
        narration: "A ninja crosses the stream.",
      },
    ],
  });
  store.commit({ ...store.project, story: plan }, "Write story");
  const asset: Asset = {
    id: "spoken-audio",
    kind: "audio",
    name: "narration.wav",
    path: audioPath,
    hasAudio: true,
    duration: 3.125,
  };
  const words = [
    { text: "A", start: 0.18, end: 0.29 },
    { text: "ninja", start: 0.33, end: 0.82 },
    { text: "crosses", start: 1.15, end: 1.75 },
    { text: "the", start: 1.98, end: 2.12 },
    { text: "stream.", start: 2.41, end: 2.89 },
  ];
  const speech = {
    status: vi.fn().mockResolvedValue({
      ready: true,
      engine: "Kokoro 82M",
      downloadMB: 80,
      voices: speechVoices,
      defaultVoice: "af_heart",
      defaultSpeed: 1.08,
    }),
    generate: vi.fn().mockResolvedValue({
      path: audioPath,
      duration: asset.duration,
      text: plan.scenes[0].narration,
      voice: plan.voice,
    }),
  };
  const media = {
    import: vi.fn().mockImplementation(async () => structuredClone(asset)),
    transcribe: vi.fn().mockResolvedValue(words),
  };
  const jobs = new Jobs(() => {});
  const production = new StoryProduction({ store, speech, media, jobs });
  const args = () => ({
    projectId: store.project.id,
    revision: store.project.revision,
    sceneId: "scene-one",
  });
  const edit = (change: (next: typeof store.project) => void) => {
    const next = structuredClone(store.project);
    change(next);
    store.commit(next, "Concurrent edit");
  };
  return {
    store,
    speech,
    media,
    jobs,
    production,
    args,
    asset,
    words,
    directory,
    audioPath,
    edit,
  };
}

describe("Story narration production", () => {
  it("uses measured word timing and merges narration into the latest project", async () => {
    const f = fixture();
    const ready = deferred<void>(),
      finish = deferred<typeof f.words>();
    f.media.transcribe.mockImplementation(async () => {
      ready.resolve();
      return finish.promise;
    });
    const pending = f.production.voice(f.args());
    await ready.promise;
    f.edit((next) => {
      next.name = "Keep this project name";
      next.story!.scenes[0].title = "Renamed opening";
      next.story!.scenes[0].visualPrompt = "Keep this new visual prompt";
    });
    finish.resolve(f.words);
    const result = await pending;
    expect(result.warnings).toEqual([]);
    expect(result.reused).toBe(false);
    expect(f.speech.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "A ninja crosses the stream.",
        voice: "af_heart",
        speed: 1.08,
      }),
    );
    expect(f.store.project.name).toBe("Keep this project name");
    expect(f.store.project.story!.scenes[0]).toMatchObject({
      title: "Renamed opening",
      visualPrompt: "Keep this new visual prompt",
      voiceAssetId: f.asset.id,
    });
    expect(f.store.project.assets[0].words).toEqual(f.words);
    expect(f.store.project.story!.scenes[0].voiceSignature).toBe(
      storyNarrationSignature(
        f.store.project.story!.scenes[0],
        f.store.project.story!,
      ),
    );
    expect(result.revision).toBe(f.store.project.revision);
  });

  it("rejects stale requests before any synthesis or transcription", async () => {
    const f = fixture();
    const old = f.args();
    f.edit((next) => {
      next.name = "Changed";
    });
    await expect(f.production.voice(old)).rejects.toThrow("Project changed");
    expect(f.speech.status).not.toHaveBeenCalled();
    expect(f.media.transcribe).not.toHaveBeenCalled();
  });

  it("requires installed voice models without starting synthesis or downloads", async () => {
    const f = fixture();
    f.speech.status.mockResolvedValue({ ready: false });
    await expect(f.production.voice(f.args())).rejects.toThrow(
      "Download the Kokoro",
    );
    expect(f.speech.generate).not.toHaveBeenCalled();
    expect(f.media.import).not.toHaveBeenCalled();
    expect(f.store.project.assets).toEqual([]);
  });

  it.each(["script", "voice", "speed", "removed", "replacement"])(
    "keeps usable audio without overwriting a %s change during synthesis",
    async (change) => {
      const f = fixture();
      const ready = deferred<void>(),
        finish = deferred<Awaited<ReturnType<typeof f.speech.generate>>>();
      f.speech.generate.mockImplementation(async () => {
        ready.resolve();
        return finish.promise;
      });
      const pending = f.production.voice(f.args());
      await ready.promise;
      f.edit((next) => {
        if (change === "script")
          next.story!.scenes[0].narration = "A completely different script.";
        else if (change === "voice") next.story!.voice = "bf_emma";
        else if (change === "speed") next.story!.speed = 1.3;
        else if (change === "removed") next.story!.scenes = [];
        else {
          next.story!.scenes[0].voiceAssetId = "manually-selected-voice";
          next.story!.scenes[0].voiceSignature = "keep-new-link";
        }
      });
      finish.resolve({ path: f.audioPath, duration: f.asset.duration });
      const result = await pending;
      expect(f.store.project.assets).toHaveLength(1);
      expect(result.warnings.join(" ")).toContain("voiceover was not replaced");
      expect(f.store.project.story!.scenes[0]?.voiceAssetId).toBe(
        change === "replacement" ? "manually-selected-voice" : undefined,
      );
      if (change === "replacement")
        expect(f.store.project.story!.scenes[0].voiceSignature).toBe(
          "keep-new-link",
        );
    },
  );

  it("does not attach audio after switching away and reopening the same project", async () => {
    const f = fixture();
    const file = path.join(f.directory, "saved.cutline");
    f.store.save(file);
    const ready = deferred<void>(),
      finish = deferred<Awaited<ReturnType<typeof f.speech.generate>>>();
    f.speech.generate.mockImplementation(async () => {
      ready.resolve();
      return finish.promise;
    });
    const pending = f.production.voice(f.args());
    const rejection = expect(pending).rejects.toThrow(
      "Another project was opened",
    );
    await ready.promise;
    const originalId = f.store.project.id;
    f.store.fresh();
    f.store.load(file);
    expect(f.store.project.id).toBe(originalId);
    finish.resolve({ path: f.audioPath, duration: f.asset.duration });
    await rejection;
    expect(f.media.import).not.toHaveBeenCalled();
    expect(f.store.project.assets).toEqual([]);
    expect(existsSync(f.audioPath)).toBe(true);
  });

  it("does not treat a project switch during transcription as a recoverable caption failure", async () => {
    const f = fixture();
    const ready = deferred<void>(),
      finish = deferred<typeof f.words>();
    f.media.transcribe.mockImplementation(async () => {
      ready.resolve();
      return finish.promise;
    });
    const pending = f.production.voice(f.args());
    const rejection = expect(pending).rejects.toThrow(
      "Another project was opened",
    );
    await ready.promise;
    f.store.fresh();
    finish.resolve(f.words);
    await rejection;
    expect(f.store.project.assets).toEqual([]);
    expect(f.store.project.story).toBeUndefined();
  });

  it("retains playable narration when captions fail and retries without regenerating speech", async () => {
    const f = fixture();
    f.media.transcribe.mockRejectedValueOnce(
      Error("Local speech model is missing."),
    );
    const first = await f.production.voice(f.args());
    expect(first.warnings.join(" ")).toContain(
      "Voiceover is ready, but captions are not",
    );
    expect(f.store.project.story!.scenes[0].voiceAssetId).toBe(f.asset.id);
    expect(f.store.project.assets[0].words).toBeUndefined();
    f.speech.status.mockResolvedValue({ ready: false });
    const second = await f.production.voice(f.args());
    expect(second.reused).toBe(true);
    expect(second.warnings).toEqual([]);
    expect(f.speech.generate).toHaveBeenCalledTimes(1);
    expect(f.media.import).toHaveBeenCalledTimes(1);
    expect(f.store.project.assets).toHaveLength(1);
    expect(f.store.project.assets[0].words).toEqual(f.words);
    const revision = f.store.project.revision;
    const third = await f.production.voice(f.args());
    expect(third.reused).toBe(true);
    expect(f.media.transcribe).toHaveBeenCalledTimes(2);
    expect(f.store.project.revision).toBe(revision);
  });

  it("blocks duplicate operations and releases the guard after cancellation", async () => {
    const f = fixture();
    const ready = deferred<void>(),
      finish = deferred<typeof f.words>();
    f.media.transcribe.mockImplementationOnce(async () => {
      ready.resolve();
      return finish.promise;
    });
    const pending = f.production.voice(f.args());
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await ready.promise;
    await expect(f.production.voice(f.args())).rejects.toThrow(
      "already running",
    );
    f.jobs.cancel(
      [...f.jobs.jobs.values()].find((job) => job.kind === "story-voice")!.id,
    );
    finish.resolve(f.words);
    await rejection;
    expect(f.store.project.assets).toEqual([]);
    expect(existsSync(f.audioPath)).toBe(true);
    await expect(f.production.voice(f.args())).resolves.toMatchObject({
      warnings: [],
    });
  });

  it("does not reintroduce narration removed while retrying its transcript", async () => {
    const f = fixture();
    f.media.transcribe.mockRejectedValueOnce(Error("Temporarily unavailable"));
    await f.production.voice(f.args());
    const ready = deferred<void>(),
      finish = deferred<typeof f.words>();
    f.media.transcribe.mockImplementationOnce(async () => {
      ready.resolve();
      return finish.promise;
    });
    const pending = f.production.voice(f.args());
    const rejection = expect(pending).rejects.toThrow("removed or relinked");
    await ready.promise;
    f.edit((next) => {
      next.assets = [];
      delete next.story!.scenes[0].voiceAssetId;
    });
    finish.resolve(f.words);
    await rejection;
    expect(f.store.project.assets).toEqual([]);
  });

  it("warns instead of inventing timing when recognition returns no words", async () => {
    const f = fixture();
    f.media.transcribe.mockResolvedValue([]);
    const result = await f.production.voice(f.args());
    expect(result.warnings.join(" ")).toContain("No spoken words");
    expect(result.asset.words).toBeUndefined();
    expect(f.store.project.assets).toHaveLength(1);
  });

  it("corrects a close recognition error to the authored words without changing measured timings", async () => {
    const f = fixture();
    const recognized = f.words.map((word, index) => ({
      ...word,
      text: index === 0 ? "An" : word.text,
    }));
    f.media.transcribe.mockResolvedValue(recognized);
    const result = await f.production.voice(f.args());
    expect(result.asset.words).toEqual(f.words);
    expect(
      result.asset.words!.map(({ start, end }) => ({ start, end })),
    ).toEqual(recognized.map(({ start, end }) => ({ start, end })));
    expect(result.warnings).toEqual([]);
    expect(recognized[0].text).toBe("An");
  });

  it("restores authored case and punctuation while retaining speech timing", async () => {
    const f = fixture();
    f.media.transcribe.mockResolvedValue(
      f.words.map((word) => ({
        ...word,
        text: word.text.toLowerCase().replace(/\./g, ""),
      })),
    );
    const result = await f.production.voice(f.args());
    expect(result.asset.words).toEqual(f.words);
    expect(result.warnings).toEqual([]);
  });

  it.each(["insertion", "unrelated", "too-many-differences"])(
    "keeps recognition and warns for %s instead of fabricating an alignment",
    async (kind) => {
      const f = fixture();
      const recognized = structuredClone(f.words);
      if (kind === "insertion")
        recognized.splice(2, 0, { text: "quietly", start: 0.86, end: 1.02 });
      else if (kind === "unrelated") recognized[1].text = "dragon";
      else {
        recognized[0].text = "An";
        recognized[1].text = "ninjas";
      }
      f.media.transcribe.mockResolvedValue(recognized);
      const result = await f.production.voice(f.args());
      expect(result.asset.words).toEqual(recognized);
      expect(result.warnings).toContain(
        "Review auto captions against your script.",
      );
    },
  );
});
