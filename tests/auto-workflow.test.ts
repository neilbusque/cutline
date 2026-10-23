import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Jobs } from "../src/main/media";
import { Store } from "../src/main/store";
import { makeClip, type Asset } from "../src/shared/model";
import {
  buildAutoReel,
  type AutoReelDependencies,
} from "../src/main/auto-reel";
import { acquireAutoStock } from "../src/main/auto-stock";
import { createMusicBed } from "../src/main/music";

vi.mock("../src/main/auto-stock", () => ({ acquireAutoStock: vi.fn() }));
vi.mock("../src/main/music", () => ({ createMusicBed: vi.fn() }));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("Nested work cancellation", () => {
  it("cancels only the requested pipeline and prevents late child work", async () => {
    const jobs = new Jobs(() => {}),
      started = deferred(),
      finish = deferred();
    const independent = jobs.create("tts", "Unrelated narration");
    const kill = vi.fn();
    let childId = "";
    const pending = jobs.run("auto-reel", "Auto edit", async () => {
      await jobs.run("stock", "Download", async (child) => {
        childId = child.id;
        jobs.cancellers.set(child.id, kill);
        started.resolve();
        await finish.promise;
      });
      await jobs.run("import", "Must not start", async () => {});
    });
    const rejection = expect(pending).rejects.toThrow("Cancelled");
    await started.promise;
    jobs.cancel(
      [...jobs.jobs.values()].find((j) => j.kind === "auto-reel")!.id,
    );
    expect(jobs.jobs.get(childId)?.state).toBe("cancelled");
    expect(kill).toHaveBeenCalledOnce();
    expect(independent.state).toBe("running");
    finish.resolve();
    await rejection;
    expect([...jobs.jobs.values()].some((j) => j.kind === "import")).toBe(
      false,
    );
  });
});

describe("Upload to complete Reel transaction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(acquireAutoStock).mockResolvedValue({
      assets: [],
      placements: [],
      warnings: ["No matching stock was available."],
      searchCount: 1,
      downloadCount: 0,
    });
  });
  function fixture() {
    const folder = mkdtempSync(path.join(tmpdir(), "cutline-auto-"));
    const file = path.join(folder, "coffee.mp4");
    writeFileSync(file, "fixture");
    const store = new Store(path.join(folder, "recovery.cutline")),
      jobs = new Jobs(() => {});
    const asset: Asset = {
      id: "source",
      name: "Coffee.mp4",
      path: file,
      kind: "video",
      duration: 12,
      hasAudio: true,
    };
    const words =
      "Make better coffee at home. Grind fresh coffee beans every morning. Enjoy your coffee."
        .split(" ")
        .map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const media = {
      probe: vi.fn().mockResolvedValue({
        kind: "video",
        duration: 12,
        hasAudio: true,
        hasPicture: true,
        needsProxy: false,
      }),
      import: vi.fn().mockResolvedValue(asset),
      transcribe: vi.fn().mockResolvedValue(words),
    };
    const original = makeClip(
      store.project,
      "text",
      store.project.tracks.find((t) => t.kind === "text")!.id,
      0,
    );
    original.text = "Keep my original edit";
    store.project.clips = [original];
    const music: Asset = {
      id: "music",
      kind: "audio",
      name: "Original music",
      path: file,
      duration: 12,
      hasAudio: true,
    };
    vi.mocked(createMusicBed).mockResolvedValue(music);
    const deps = {
      store,
      jobs,
      media,
      stock: {},
      musicFolder: folder,
      provider: () => "commons",
    } as unknown as AutoReelDependencies;
    const args = {
      projectId: store.project.id,
      revision: store.project.revision,
      path: file,
      options: {},
    };
    return {
      folder,
      store,
      jobs,
      asset,
      words,
      media,
      deps,
      args,
      cleanup: () => rmSync(folder, { recursive: true, force: true }),
    };
  }
  it("imports, transcribes and composes as one undoable edit, reporting unmatched stock", async () => {
    const f = fixture();
    try {
      const before = structuredClone(f.store.project);
      const result = await buildAutoReel(f.args, f.deps);
      expect(result.captionCount).toBeGreaterThan(0);
      expect(result.music).toBe(true);
      expect(result.warnings).toContain("No matching stock was available.");
      expect(f.store.past).toHaveLength(1);
      expect(f.store.project.assets).toHaveLength(2);
      expect(f.store.project.width).toBe(1080);
      expect(f.store.project.height).toBe(1920);
      const restored = f.store.undo().project;
      expect({ ...restored, revision: before.revision }).toEqual(before);
    } finally {
      f.cleanup();
    }
  });
  it.each(["creator-punch", "screen-demo"])(
    "keeps %s local and speech-led unless stock/music are requested",
    async (format) => {
      const f = fixture();
      try {
        const result = await buildAutoReel(
          { ...f.args, options: { format } },
          f.deps,
        );
        expect(result.captionCount).toBeGreaterThan(0);
        expect(result.music).toBe(false);
        expect(acquireAutoStock).not.toHaveBeenCalled();
        expect(createMusicBed).not.toHaveBeenCalled();
        expect(
          f.store.project.clips
            .filter((clip) => clip.assetId === f.asset.id)
            .every((clip) => clip.volume === 1),
        ).toBe(true);
        f.store.undo();
        await buildAutoReel(
          {
            ...f.args,
            revision: f.store.project.revision,
            options: { format, broll: true, music: true },
          },
          f.deps,
        );
        expect(acquireAutoStock).toHaveBeenCalledOnce();
        expect(createMusicBed).toHaveBeenCalledOnce();
      } finally {
        f.cleanup();
      }
    },
  );
  it("finishes on top of edits made while it was prepared, keeping them", async () => {
    const f = fixture(),
      wait = deferred(),
      started = deferred();
    f.media.transcribe.mockImplementation(async () => {
      started.resolve();
      await wait.promise;
      return f.words;
    });
    try {
      const pending = buildAutoReel(f.args, f.deps);
      await started.promise;
      f.store.commit({ ...f.store.project, name: "Newer edit" }, "Rename");
      wait.resolve();
      const result = await pending;
      expect(result.captionCount).toBeGreaterThan(0);
      // The rename made meanwhile is kept, and the Reel is one Undo on top.
      expect(f.store.project.name).toBe("Newer edit");
      expect(f.store.project.assets.map((a) => a.id)).toEqual([
        "source",
        "music",
      ]);
      f.store.undo();
      expect(f.store.project.name).toBe("Newer edit");
      expect(f.store.project.assets).toEqual([]);
      expect(f.store.project.clips[0].text).toBe("Keep my original edit");
    } finally {
      f.cleanup();
    }
  });
  it("stops if another project is opened while it is prepared", async () => {
    const f = fixture(),
      wait = deferred(),
      started = deferred();
    f.media.transcribe.mockImplementation(async () => {
      started.resolve();
      await wait.promise;
      return f.words;
    });
    try {
      const pending = buildAutoReel(f.args, f.deps);
      const rejected = expect(pending).rejects.toThrow("Another project");
      await started.promise;
      f.store.fresh();
      wait.resolve();
      await rejected;
      expect(f.store.project.clips).toEqual([]);
      expect(createMusicBed).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("checks the 30-minute limit before importing the video", async () => {
    const f = fixture();
    f.media.probe.mockResolvedValue({
      kind: "video",
      duration: 45 * 60,
      hasAudio: true,
      hasPicture: true,
      needsProxy: true,
    });
    try {
      await expect(buildAutoReel(f.args, f.deps)).rejects.toThrow(
        "under 30 minutes",
      );
      expect(f.media.import).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("deletes stock it downloaded when the edit does not finish", async () => {
    const f = fixture();
    const clip: Asset = {
      id: "stock-1",
      kind: "video",
      name: "Coffee B-roll",
      path: path.join(f.folder, "stock.mp4"),
      duration: 6,
      hasAudio: false,
      origin: {
        provider: "Wikimedia Commons",
        page: "https://commons.wikimedia.org/wiki/File:Coffee.webm",
        creator: "Alex",
        license: "CC0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        title: "Coffee",
      },
    };
    vi.mocked(acquireAutoStock).mockResolvedValue({
      assets: [clip],
      placements: [],
      warnings: [],
      searchCount: 1,
      downloadCount: 1,
    });
    vi.mocked(createMusicBed).mockRejectedValue(Error("Disk full"));
    const discard = vi.fn(async () => {});
    (f.deps as any).stock = { discard };
    try {
      await expect(buildAutoReel(f.args, f.deps)).rejects.toThrow("Disk full");
      expect(discard).toHaveBeenCalledWith(clip);
    } finally {
      f.cleanup();
    }
  });
  it("applies the chosen caption style, clean opening and returns review targets", async () => {
    const f = fixture();
    try {
      const result = await buildAutoReel(
        {
          ...f.args,
          options: {
            captionStyle: "focus",
            pace: "tight",
            openingTitle: false,
          },
        },
        f.deps,
      );
      const captions = f.store.project.clips.filter(
        (c) => c.kind === "caption",
      );
      expect(captions.length).toBeGreaterThan(0);
      expect(
        captions.every(
          (c) => c.captionStyle === "focus" && c.captionLayout === "balanced",
        ),
      ).toBe(true);
      expect(
        f.store.project.clips.filter((c) => c.kind === "text"),
      ).toHaveLength(0);
      expect(result.clipIds).toEqual(f.store.project.clips.map((c) => c.id));
      expect(result.pace).toBe("tight");
    } finally {
      f.cleanup();
    }
  });
  it("keeps the old project intact when preparation is cancelled", async () => {
    const f = fixture(),
      wait = deferred(),
      started = deferred();
    f.media.transcribe.mockImplementation(async () => {
      started.resolve();
      await wait.promise;
      return [];
    });
    try {
      const before = structuredClone(f.store.project);
      const pending = buildAutoReel(f.args, f.deps);
      const rejected = expect(pending).rejects.toThrow("cancelled");
      await started.promise;
      f.jobs.cancel(
        [...f.jobs.jobs.values()].find((j) => j.kind === "auto-reel")!.id,
      );
      wait.resolve();
      await rejected;
      expect(f.store.project).toEqual(before);
      expect(f.store.past).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });
  it("does not replace the timeline if music preparation fails", async () => {
    const f = fixture();
    try {
      const before = structuredClone(f.store.project);
      vi.mocked(createMusicBed).mockRejectedValue(Error("Disk full"));
      await expect(buildAutoReel(f.args, f.deps)).rejects.toThrow("Disk full");
      expect(f.store.project).toEqual(before);
    } finally {
      f.cleanup();
    }
  });
  it("accepts a silent clip without fabricating spoken captions or stock topics", async () => {
    const f = fixture();
    f.asset.hasAudio = false;
    try {
      const result = await buildAutoReel(f.args, f.deps);
      expect(result.captionCount).toBe(0);
      expect(result.music).toBe(true);
      expect(f.media.transcribe).not.toHaveBeenCalled();
      expect(acquireAutoStock).not.toHaveBeenCalled();
      expect(result.warnings.join(" ")).toContain("no clear spoken topics");
    } finally {
      f.cleanup();
    }
  });
});
