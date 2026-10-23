import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { StoryControl } from "../src/main/story-control";
import { StoryPlanSchema } from "../src/shared/story-schema";
import type { GenerationJob } from "../src/shared/generation";
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cutline-story-control-"));
  store = new Store(path.join(dir, "recovery.json"));
  store.commit(
    {
      ...store.project,
      story: StoryPlanSchema.parse({
        scenes: [
          {
            id: "scene",
            title: "Shot",
            visualPrompt: "A bamboo forest",
            duration: 5,
          },
        ],
      }),
    },
    "Story",
  );
});
afterEach(() => {
  store.flush();
  rmSync(dir, { recursive: true, force: true });
});
const request = () => ({
  projectId: store.project.id,
  revision: store.project.revision,
  sceneId: "scene",
});
const setup = () => {
  const records: GenerationJob[] = [];
  const generation = {
    list: () => records,
    pickReference: vi.fn(async (file: string) => ({
      id: crypto.randomUUID(),
      name: path.basename(file),
    })),
    submit: vi.fn(async (v: any) => {
      const job = {
        ...v,
        id: v.clientId,
        status: "queued",
        downloaded: false,
        createdAt: 1,
      } as GenerationJob;
      records.push(job);
      return job;
    }),
    refresh: vi.fn(async (id: string) => records.find((j) => j.id === id)!),
    importAsset: vi.fn(async (id: string) => ({
      id,
      name: "Shot",
      kind: "video" as const,
      path: path.join(dir, "shot.mp4"),
      hasAudio: false,
      duration: 5,
    })),
  };
  return {
    control: new StoryControl({
      store,
      generation,
      configured: async () => true,
    }),
    generation,
    records,
  };
};
describe("Story control", () => {
  const addReferences = () => {
    const assets = ["hero", "forest", "lantern"].map((id) => {
      const file = path.join(dir, `${id}.png`);
      writeFileSync(file, "fixture");
      return {
        id,
        path: file,
        name: `${id}.png`,
        kind: "image" as const,
        hasAudio: false,
        duration: 0,
      };
    });
    store.commit(
      {
        ...store.project,
        assets,
        story: {
          ...store.project.story!,
          referenceAssetIds: ["hero", "forest"],
          scenes: [
            {
              ...store.project.story!.scenes[0],
              referenceAssetIds: ["hero", "lantern"],
            },
          ],
        },
      },
      "Choose references",
    );
    return assets;
  };

  it("merges shared and scene images in order and deduplicates before submitting", async () => {
    const assets = addReferences();
    const { control, generation } = setup();
    await control.generate(request());
    expect(generation.pickReference.mock.calls.map(([file]) => file)).toEqual(
      assets.map((asset) => asset.path),
    );
    const registered = await Promise.all(
      generation.pickReference.mock.results.map((result) => result.value),
    );
    expect(generation.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceIds: registered.map((reference) => reference.id),
      }),
    );
    expect(generation.submit.mock.calls[0][0]).not.toHaveProperty(
      "referenceId",
    );
    await control.generate(request());
    expect(generation.submit).toHaveBeenCalledTimes(1);
    expect(generation.pickReference).toHaveBeenCalledTimes(3);
  });

  it.each(["missing asset", "missing file", "video"])(
    "rejects a %s reference before linking or submitting a generation",
    async (kind) => {
      addReferences();
      const assets = store.project.assets.map((asset) =>
        asset.id !== "lantern"
          ? asset
          : {
              ...asset,
              ...(kind === "missing asset" ? { id: "other" } : {}),
              ...(kind === "missing file"
                ? { path: path.join(dir, "missing.png") }
                : {}),
              ...(kind === "video" ? { kind: "video" as const } : {}),
            },
      );
      store.commit({ ...store.project, assets }, "Change fixture");
      const before = store.project.revision;
      const { control, generation } = setup();
      await expect(control.generate(request())).rejects.toThrow(
        /reference image|available image/,
      );
      expect(generation.submit).not.toHaveBeenCalled();
      expect(generation.pickReference).not.toHaveBeenCalled();
      expect(store.project.story!.scenes[0].generationId).toBeUndefined();
      expect(store.project.revision).toBe(before);
    },
  );

  it.each(["revision", "session"])(
    "rejects changed project %s after async reference registration",
    async (changed) => {
      addReferences();
      const { control, generation } = setup();
      let release!: () => void;
      const registered = new Promise<void>((resolve) => {
        release = resolve;
      });
      generation.pickReference.mockImplementation(async (file) => {
        await registered;
        return { id: crypto.randomUUID(), name: path.basename(file) };
      });
      const pending = control.generate(request());
      await vi.waitFor(() =>
        expect(generation.pickReference).toHaveBeenCalledTimes(3),
      );
      await expect(control.generate(request())).rejects.toThrow(/already/);
      if (changed === "session") store.openSession = crypto.randomUUID();
      else
        store.commit(
          { ...store.project, name: "Changed project" },
          "Change while registering",
        );
      release();
      await expect(pending).rejects.toThrow(/Project changed/);
      expect(generation.submit).not.toHaveBeenCalled();
      expect(store.project.story!.scenes[0].generationId).toBeUndefined();
    },
  );

  it("keeps an invalid image registration from creating a generation link", async () => {
    addReferences();
    const { control, generation } = setup();
    generation.pickReference.mockRejectedValue(
      Error("Unsupported reference image"),
    );
    const before = store.project.revision;
    await expect(control.generate(request())).rejects.toThrow(
      /Unsupported reference/,
    );
    expect(generation.submit).not.toHaveBeenCalled();
    expect(store.project.revision).toBe(before);
    expect(store.project.story!.scenes[0].generationId).toBeUndefined();
  });

  it("rejects duplicate-path image assets before linking or submitting a generation", async () => {
    const assets = addReferences();
    store.commit(
      {
        ...store.project,
        assets: store.project.assets.map((asset) =>
          asset.id === "lantern" ? { ...asset, path: assets[0].path } : asset,
        ),
      },
      "Duplicate source file fixture",
    );
    const { control, generation } = setup();
    const ids = new Map<string, ReturnType<typeof crypto.randomUUID>>();
    generation.pickReference.mockImplementation(async (file) => {
      if (!ids.has(file)) ids.set(file, crypto.randomUUID());
      return { id: ids.get(file)!, name: path.basename(file) };
    });
    const before = store.project.revision;
    await expect(control.generate(request())).rejects.toThrow(
      /same image.*Remove the duplicate from shared or scene references/,
    );
    expect(generation.submit).not.toHaveBeenCalled();
    expect(store.project.revision).toBe(before);
    expect(store.project.story!.scenes[0].generationId).toBeUndefined();
  });
  it("rejects stale saves and doesn't accept caller forged assembly ownership", () => {
    const { control } = setup();
    const before = store.project.revision;
    control.save({
      ...request(),
      story: {
        ...store.project.story,
        assembly: { clipIds: ["unrelated"], trackIds: [], startFrame: 0 },
      },
    });
    expect(store.project.story!.assembly).toBeUndefined();
    expect(() =>
      control.save({
        projectId: store.project.id,
        revision: before,
        story: store.project.story,
      }),
    ).toThrow(/changed/);
  });
  it("persists generation linkage and reuses an unresolved request", async () => {
    const { control, generation } = setup();
    const first = await control.generate(request());
    expect(store.project.story!.scenes[0].generationId).toBe(
      first.generation.id,
    );
    const second = await control.generate(request());
    expect(second.generation.id).toBe(first.generation.id);
    expect(generation.submit).toHaveBeenCalledTimes(1);
  });
  it("blocks simultaneous generation during async credential reads", async () => {
    const { generation } = setup();
    let release!: (value: boolean) => void;
    const configured = () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      });
    const control = new StoryControl({ store, generation, configured });
    const pending = control.generate(request());
    await expect(control.generate(request())).rejects.toThrow(/already/);
    release(true);
    await pending;
    expect(generation.submit).toHaveBeenCalledTimes(1);
  });
  it("doesn't launch into a reopened project after credential checks", async () => {
    const { generation } = setup();
    let release!: (value: boolean) => void;
    const control = new StoryControl({
      store,
      generation,
      configured: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = control.generate(request());
    store.openSession = crypto.randomUUID();
    release(true);
    await expect(pending).rejects.toThrow(/changed/);
    expect(generation.submit).not.toHaveBeenCalled();
  });
  it("imports completed shots once and links them to their scene", async () => {
    const { control, records, generation } = setup();
    await control.generate(request());
    records[0].status = "completed";
    records[0].downloaded = true;
    await control.refresh(request());
    await control.refresh(request());
    expect(store.project.assets).toHaveLength(1);
    expect(store.project.story!.scenes[0].assetId).toBe(records[0].id);
    expect(generation.importAsset).toHaveBeenCalledTimes(1);
  });
  it("explicit media selection unlinks background shot attachment", async () => {
    const { control } = setup();
    await control.generate(request());
    const story = structuredClone(store.project.story!);
    story.scenes[0].assetId = "manual-choice";
    control.save({ ...request(), story });
    expect(store.project.story!.scenes[0].generationId).toBeUndefined();
  });
  it("commits a completed shot once when two refreshes finish importing together", async () => {
    const { control, records, generation } = setup();
    await control.generate(request());
    records[0].status = "completed";
    records[0].downloaded = true;
    const asset = await generation.importAsset(records[0].id);
    let release!: () => void;
    const importing = new Promise<void>((resolve) => {
      release = resolve;
    });
    generation.importAsset.mockImplementation(async () => {
      await importing;
      return asset;
    });
    const revision = store.project.revision;
    const first = control.refresh(request());
    const second = control.refresh(request());
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(store.project.assets).toHaveLength(1);
    expect(store.project.revision).toBe(revision + 1);
    expect(store.project.story!.scenes[0].assetId).toBe(asset.id);
  });
  it("preserves a manual media choice made while a finished shot is importing", async () => {
    const { control, records, generation } = setup();
    await control.generate(request());
    records[0].status = "completed";
    records[0].downloaded = true;
    const asset = await generation.importAsset(records[0].id);
    let release!: () => void;
    const importing = new Promise<void>((resolve) => {
      release = resolve;
    });
    generation.importAsset.mockImplementation(async () => {
      await importing;
      return asset;
    });
    const pending = control.refresh(request());
    await Promise.resolve();
    const story = structuredClone(store.project.story!);
    story.scenes[0].assetId = "manual-media";
    control.save({ ...request(), story });
    const revision = store.project.revision;
    release();
    await expect(pending).rejects.toThrow(/Scene changed/);
    expect(store.project.story!.scenes[0].assetId).toBe("manual-media");
    expect(store.project.revision).toBe(revision);
    expect(store.project.assets).toEqual([]);
  });
  it("refuses missing media before timeline mutation", () => {
    const { control } = setup();
    store.commit(
      {
        ...store.project,
        assets: [
          {
            id: "v",
            name: "Missing",
            kind: "video",
            hasAudio: false,
            duration: 5,
            path: path.join(dir, "missing.mp4"),
          },
        ],
        story: {
          ...store.project.story!,
          scenes: [{ ...store.project.story!.scenes[0], assetId: "v" }],
        },
      },
      "Link missing fixture",
    );
    const revision = store.project.revision;
    expect(() => control.assemble({ ...request(), mode: "append" })).toThrow(
      /Relink/,
    );
    expect(store.project.revision).toBe(revision);
  });
  it("assembles an existing scene in one undoable edit", () => {
    const { control } = setup();
    const mediaPath = path.join(dir, "shot.mp4");
    writeFileSync(mediaPath, "fixture");
    store.commit(
      {
        ...store.project,
        assets: [
          {
            id: "v",
            name: "Shot",
            kind: "video",
            hasAudio: false,
            duration: 5,
            path: mediaPath,
          },
        ],
        story: {
          ...store.project.story!,
          scenes: [{ ...store.project.story!.scenes[0], assetId: "v" }],
        },
      },
      "Link fixture",
    );
    const result = control.assemble({ ...request(), mode: "append" });
    expect(result.sceneCount).toBe(1);
    expect(store.project.clips).toHaveLength(1);
    store.undo();
    expect(store.project.clips).toHaveLength(0);
  });
  it("ignores missing old narration when the scene is explicitly silent", () => {
    const { control } = setup();
    const mediaPath = path.join(dir, "shot.mp4");
    writeFileSync(mediaPath, "fixture");
    store.commit(
      {
        ...store.project,
        assets: [
          {
            id: "visual",
            name: "Shot",
            kind: "video",
            hasAudio: false,
            duration: 5,
            path: mediaPath,
          },
          {
            id: "old-voice",
            name: "Old voice",
            kind: "audio",
            hasAudio: true,
            duration: 5,
            path: path.join(dir, "missing-voice.wav"),
          },
        ],
        story: {
          ...store.project.story!,
          scenes: [
            {
              ...store.project.story!.scenes[0],
              assetId: "visual",
              voiceAssetId: "old-voice",
              narration: "",
            },
          ],
        },
      },
      "Link silent scene",
    );
    const result = control.assemble({ ...request(), mode: "append" });
    expect(result.sceneCount).toBe(1);
    expect(store.project.clips).toHaveLength(1);
    expect(store.project.clips[0].kind).toBe("video");
  });
});
