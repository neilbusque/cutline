import { describe, expect, it, vi } from "vitest";
import {
  assertSceneFits,
  createHyperframesControl,
  HyperframesArgsSchema,
  hyperframesTools,
} from "../src/main/agent-hyperframes";
import {
  makeClip,
  newProject,
  validateProject,
  type Asset,
  type Project,
} from "../src/shared/model";

function scene(patch: Partial<Asset> = {}): Asset {
  return {
    id: "scene",
    name: "Product reveal",
    kind: "video",
    path: "/managed/first/render.mp4",
    duration: 5,
    width: 1080,
    height: 1920,
    hasAudio: false,
    composition: {
      engine: "hyperframes",
      engineVersion: "0.8.198",
      entry: "/managed/first/index.html",
      source: "<html>original source</html>",
      sourceHash: "a".repeat(64),
      transparent: false,
    },
    ...patch,
  };
}

function fixture() {
  const asset = scene();
  const project = newProject();
  project.assets = [asset];
  project.clips = [makeClip(project, "video", "video", 0, asset)];
  const store = {
    project,
    openSession: "opening-one",
    commit: vi.fn((next: Project, _label: string) => {
      store.project = {
        ...validateProject(next),
        revision: store.project.revision + 1,
      };
    }),
  };
  const rendered = scene({
    id: "new-scene",
    path: "/managed/second/render.mp4",
    composition: {
      ...asset.composition!,
      entry: "/managed/second/index.html",
      source: "<html>updated source</html>",
      sourceHash: "b".repeat(64),
    },
  });
  const renderer = {
    render: vi.fn(async () => rendered),
    accept: vi.fn((_asset: Asset) => {}),
    discard: vi.fn(async (_asset: Asset) => {}),
  };
  const control = createHyperframesControl({ store, renderer });
  const args = { projectId: project.id, revision: 0, assetId: asset.id };
  return { asset, store, rendered, renderer, control, args };
}

describe("HyperFrames tool contract", () => {
  it("registers a bounded source-backed scene tool", () => {
    expect(hyperframesTools[0].name).toBe("cutline_hyperframes");
    expect(hyperframesTools[0].annotations).toMatchObject({
      destructiveHint: false,
    });
    for (const invalid of [
      { action: "import" },
      { action: "import", path: "/scene.html", html: "<html/>" },
      { action: "update", html: "<html/>" },
      { action: "update", assetId: "scene", at: { frame: 0 } },
      { action: "read", assetId: "scene", html: "<html/>" },
      { action: "read", assetId: "scene", limit: 50_001 },
      { action: "import", html: "<html/>", expectedSourceHash: "a".repeat(64) },
      { action: "update", assetId: "scene", expectedSourceHash: "invalid" },
    ]) {
      expect(() =>
        HyperframesArgsSchema.parse({
          projectId: "project",
          revision: 0,
          ...invalid,
        }),
      ).toThrow();
    }
  });

  it("pages explicit source reads without rendering or editing", async () => {
    const f = fixture();
    const first = await f.control({ ...f.args, action: "read", limit: 10 });
    expect(first).toMatchObject({
      assetId: "scene",
      source: "<html>orig",
      offset: 0,
      nextOffset: 10,
      total: f.asset.composition!.source.length,
    });
    const last = await f.control({ ...f.args, action: "read", offset: 10 });
    expect("source" in last && last.source).toBe(
      f.asset.composition!.source.slice(10),
    );
    expect(last).not.toHaveProperty("nextOffset");
    await expect(
      f.control({ ...f.args, action: "read", offset: 1000 }),
    ).rejects.toThrow(/offset/);
    expect(f.renderer.render).not.toHaveBeenCalled();
    expect(f.store.commit).not.toHaveBeenCalled();
  });

  it("rejects stale revisions and foreign asset IDs before rendering", async () => {
    const f = fixture();
    await expect(
      f.control({ ...f.args, revision: 20, action: "update" }),
    ).rejects.toThrow(/Project changed/);
    await expect(
      f.control({ ...f.args, assetId: "other-project-scene", action: "read" }),
    ).rejects.toThrow(/in this project/);
    expect(f.renderer.render).not.toHaveBeenCalled();
  });

  it("rejects an old editor source even when the project revision is current", async () => {
    const f = fixture();
    await expect(
      f.control({
        ...f.args,
        action: "update",
        html: "<html>old draft</html>",
        expectedSourceHash: "b".repeat(64),
      }),
    ).rejects.toThrow(/after this source was opened/);
    expect(f.renderer.render).not.toHaveBeenCalled();
    expect(f.store.commit).not.toHaveBeenCalled();
  });
});

describe("atomic scene edits", () => {
  it("imports and places a scene in one undoable commit without disturbing footage", async () => {
    const f = fixture();
    const before = structuredClone(f.store.project);
    const result = await f.control({
      projectId: before.id,
      revision: 0,
      action: "import",
      html: "<html/>",
      at: { seconds: 1 },
    });
    expect(f.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<html/>", fps: 30 }),
      undefined,
    );
    expect(f.store.commit).toHaveBeenCalledTimes(1);
    expect(f.renderer.accept).toHaveBeenCalledWith(f.rendered);
    expect(f.renderer.discard).not.toHaveBeenCalled();
    expect(f.store.project.clips[0]).toEqual(before.clips[0]);
    expect(f.store.project.assets[0]).toEqual(before.assets[0]);
    expect(f.store.project.clips[1]).toMatchObject({
      assetId: "new-scene",
      start: 30,
      duration: 150,
    });
    expect(f.store.project.clips[1].trackId).not.toBe("video");
    expect(result).toMatchObject({
      assetId: "new-scene",
      revision: 1,
      clipId: f.store.project.clips[1].id,
    });
  });

  it("imports into Media without adding clips when at is omitted", async () => {
    const f = fixture();
    await f.control({
      projectId: f.store.project.id,
      revision: 0,
      action: "import",
      path: "/scene/index.html",
    });
    expect(f.store.project.assets).toHaveLength(2);
    expect(f.store.project.clips).toHaveLength(1);
  });

  it("refreshes every use through the existing asset ID and preserves edits made while rendering", async () => {
    const f = fixture();
    const second = {
      ...f.store.project.clips[0],
      id: "second-use",
      start: 150,
    };
    f.store.project.clips.push(second);
    f.renderer.render.mockImplementationOnce(async () => {
      f.store.project = {
        ...f.store.project,
        name: "Renamed during render",
        revision: 1,
      };
      return f.rendered;
    });
    await f.control({
      ...f.args,
      action: "update",
      html: "<html>changed</html>",
    });
    expect(f.store.commit).toHaveBeenCalledTimes(1);
    expect(f.store.project.name).toBe("Renamed during render");
    expect(f.store.project.revision).toBe(2);
    expect(f.store.project.assets).toHaveLength(1);
    expect(f.store.project.assets[0]).toMatchObject({
      id: "scene",
      path: "/managed/second/render.mp4",
    });
    expect(f.store.project.clips.map((clip) => clip.assetId)).toEqual([
      "scene",
      "scene",
    ]);
    expect(f.asset.composition!.source).toBe("<html>original source</html>");
  });

  it("keeps the project unchanged after failed rendering", async () => {
    const f = fixture();
    const before = structuredClone(f.store.project);
    f.renderer.render.mockRejectedValueOnce(Error("Render failed"));
    await expect(f.control({ ...f.args, action: "update" })).rejects.toThrow(
      "Render failed",
    );
    expect(f.store.project).toEqual(before);
    expect(f.store.commit).not.toHaveBeenCalled();
    expect(f.renderer.discard).not.toHaveBeenCalled();
  });

  it("discards an unapplied result on commit failure without masking its original error", async () => {
    const f = fixture();
    f.store.commit.mockImplementationOnce(() => {
      throw Error("The project could not accept this scene");
    });
    f.renderer.discard.mockRejectedValueOnce(Error("Cleanup also failed"));
    await expect(f.control({ ...f.args, action: "update" })).rejects.toThrow(
      "could not accept",
    );
    expect(f.renderer.discard).toHaveBeenCalledWith(f.rendered);
    expect(f.renderer.accept).not.toHaveBeenCalled();
    expect(f.store.project.assets[0]).toEqual(f.asset);
  });

  it("warns about existing caption words without deleting manual or generated captions", async () => {
    const f = fixture();
    const use = f.store.project.clips[0];
    const generated = {
      ...makeClip(f.store.project, "caption", "captions", 0),
      captionSourceId: use.id,
      text: "Old spoken words",
    };
    const manual = {
      ...makeClip(f.store.project, "caption", "captions", 0),
      text: "A manual caption",
    };
    f.store.project.clips.push(generated, manual);
    const result = await f.control({
      ...f.args,
      action: "update",
      expectedSourceHash: "a".repeat(64),
    });
    expect(result).toMatchObject({
      warnings: [
        "Scene updated. Regenerate its captions if the speech changed.",
      ],
    });
    expect(f.store.project.clips).toContainEqual(generated);
    expect(f.store.project.clips).toContainEqual(manual);
    const withTranscript = fixture();
    withTranscript.asset.words = [{ text: "Speech", start: 0, end: 1 }];
    expect(
      await withTranscript.control({
        ...withTranscript.args,
        action: "update",
      }),
    ).toMatchObject({ warnings: expect.any(Array) });
    const plain = fixture();
    expect(
      await plain.control({ ...plain.args, action: "update" }),
    ).not.toHaveProperty("warnings");
  });

  it("does not land on a different project opening or overwrite a newer scene", async () => {
    for (const change of ["opening", "scene", "deleted", "fps"]) {
      const f = fixture();
      f.renderer.render.mockImplementationOnce(async () => {
        if (change === "opening") f.store.openSession = "opening-two";
        if (change === "scene")
          f.store.project.assets[0] = scene({
            path: "/managed/newer/render.mp4",
          });
        if (change === "deleted") f.store.project.assets = [];
        if (change === "fps") f.store.project.fps = 24;
        return f.rendered;
      });
      await expect(
        f.control({ ...f.args, action: "update" }),
      ).rejects.toThrow();
      expect(f.store.commit).not.toHaveBeenCalled();
      expect(f.renderer.discard).toHaveBeenCalledWith(f.rendered);
      expect(f.renderer.accept).not.toHaveBeenCalled();
    }
  });

  it("rejects source shortening that would invalidate a trimmed, sped up use", async () => {
    const f = fixture();
    f.store.project.clips[0].sourceIn = 1;
    f.store.project.clips[0].speed = 2;
    f.store.project.clips[0].duration = 60;
    f.rendered.duration = 4;
    await expect(f.control({ ...f.args, action: "update" })).rejects.toThrow(
      /too short/,
    );
    expect(f.store.commit).not.toHaveBeenCalled();
  });

  it("allows a long freeze when its held source frame exists, and guards reversed passages", () => {
    const f = fixture();
    const clip = f.store.project.clips[0];
    clip.freeze = true;
    clip.sourceIn = 1;
    clip.duration = 1000;
    expect(() =>
      assertSceneFits(f.store.project, f.asset, scene({ duration: 2 })),
    ).not.toThrow();
    clip.sourceIn = 3;
    expect(() =>
      assertSceneFits(f.store.project, f.asset, scene({ duration: 2 })),
    ).toThrow(/too short/);
    clip.sourceIn = 1;
    clip.reverse = true;
    expect(() =>
      assertSceneFits(f.store.project, f.asset, scene({ duration: 6 })),
    ).toThrow(/reversed/);
  });
});
