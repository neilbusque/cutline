import { describe, expect, it, vi } from "vitest";
import {
  createModel3DControl,
  Model3DArgsSchema,
  model3dTools,
} from "../src/main/agent-model-3d";
import { Model3DSettingsSchema } from "../src/shared/model-3d";
import {
  newProject,
  makeClip,
  validateProject,
  type Asset,
  type Project,
} from "../src/shared/model";
function fixture() {
  const project = newProject();
  const asset: Asset = {
    id: "model",
    name: "Lens",
    kind: "video",
    path: "/managed/old/scene.mp4",
    width: 1080,
    height: 1920,
    duration: 6,
    hasAudio: false,
    composition: {
      engine: "hyperframes",
      engineVersion: "0.8.198",
      entry: "/managed/old/source/index.html",
      source: "<html>generated</html>",
      sourceHash: "a".repeat(64),
      transparent: false,
      model3d: {
        file: "model/lens.glb",
        format: "glb",
        settings: Model3DSettingsSchema.parse({
          cameraAzimuth: 70,
          durationSeconds: 6,
        }),
        animations: ["Focus"],
      },
    },
  };
  project.assets = [asset];
  project.clips = [makeClip(project, "video", "video", 0, asset)];
  const store = {
    project,
    openSession: "first",
    commit: vi.fn((next: Project, _label: string) => {
      store.project = {
        ...validateProject(next),
        revision: store.project.revision + 1,
      };
    }),
  };
  const rendered: Asset = {
    ...asset,
    id: "new-model",
    path: "/managed/new/scene.mp4",
    composition: {
      ...asset.composition!,
      sourceHash: "b".repeat(64),
      entry: "/managed/new/source/index.html",
    },
  };
  const renderer = {
    render: vi.fn(async () => rendered),
    accept: vi.fn(),
    discard: vi.fn(async (_asset: Asset) => {}),
  };
  return {
    store,
    renderer,
    rendered,
    asset,
    control: createModel3DControl({ store, renderer }),
    args: {
      projectId: project.id,
      revision: project.revision,
      assetId: asset.id,
    },
  };
}
describe("3D model assistant contract", () => {
  it("validates model requests and preserves omitted settings during a partial update", () => {
    expect(model3dTools[0].name).toBe("cutline_model3d");
    const parsed = Model3DArgsSchema.parse({
      projectId: "p",
      revision: 0,
      action: "update",
      assetId: "model",
      settings: { exposure: 2 },
    });
    expect(parsed.settings).toEqual({ exposure: 2 });
    for (const input of [
      { action: "import" },
      { action: "import", path: "/lens.glb", assetId: "old" },
      { action: "read", assetId: "model", settings: {} },
      { action: "update", assetId: "model", path: "/lens.glb" },
      { action: "update", assetId: "model", at: { frame: 0 } },
      { action: "update", assetId: "model", settings: { cameraDistance: 100 } },
    ])
      expect(() =>
        Model3DArgsSchema.parse({ projectId: "p", revision: 0, ...input }),
      ).toThrow();
  });
  it("reads model controls without exposing local paths or rendering", async () => {
    const f = fixture();
    const read = await f.control({ ...f.args, action: "read" });
    expect(read).toMatchObject({
      name: "Lens",
      model3d: { settings: { cameraAzimuth: 70 }, animations: ["Focus"] },
    });
    expect(JSON.stringify(read)).not.toContain("/managed");
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
  it("updates in place and keeps all clips with one undoable commit", async () => {
    const f = fixture(),
      clips = structuredClone(f.store.project.clips);
    const result = await f.control({
      ...f.args,
      action: "update",
      expectedSourceHash: "a".repeat(64),
      settings: { motion: "orbit" },
    });
    expect(f.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        model3d: expect.objectContaining({
          width: f.store.project.width,
          height: f.store.project.height,
          settings: { motion: "orbit" },
        }),
      }),
      f.asset,
    );
    expect(result).toMatchObject({
      assetId: "model",
      revision: 1,
      sourceHash: "b".repeat(64),
    });
    expect(f.store.project.clips).toEqual(clips);
    expect(f.store.commit).toHaveBeenCalledTimes(1);
    expect(f.renderer.accept).toHaveBeenCalledWith(f.rendered);
  });
  it("imports onto a free track without replacing existing footage", async () => {
    const f = fixture();
    const result = await f.control({
      projectId: f.args.projectId,
      revision: 0,
      action: "import",
      path: "/generated/lens.glb",
      at: { seconds: 1 },
      transparent: true,
    });
    expect(f.store.project.assets).toHaveLength(2);
    expect(f.store.project.clips).toHaveLength(2);
    expect(f.store.project.clips[1]).toMatchObject({
      start: 30,
      assetId: "new-model",
    });
    expect(result).toHaveProperty("clipId");
  });
  it("rejects stale identity and source hashes before rendering", async () => {
    const f = fixture();
    await expect(
      f.control({ ...f.args, action: "update", revision: 9 }),
    ).rejects.toThrow(/Project changed/);
    await expect(
      f.control({
        ...f.args,
        action: "update",
        expectedSourceHash: "b".repeat(64),
      }),
    ).rejects.toThrow(/changed after/);
    delete f.asset.composition!.model3d;
    await expect(f.control({ ...f.args, action: "update" })).rejects.toThrow(
      /Edit source/,
    );
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
  it("discards a render if the canvas changes or it no longer fits the existing clip", async () => {
    const f = fixture();
    f.renderer.render.mockImplementationOnce(async () => {
      f.store.project.width = 640;
      return f.rendered;
    });
    await expect(f.control({ ...f.args, action: "update" })).rejects.toThrow(
      /canvas changed/,
    );
    expect(f.renderer.discard).toHaveBeenCalledWith(f.rendered);
    expect(f.store.commit).not.toHaveBeenCalled();
    f.rendered.duration = 1;
    await expect(f.control({ ...f.args, action: "update" })).rejects.toThrow(
      /too short/,
    );
    expect(f.store.commit).not.toHaveBeenCalled();
  });
});
