import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssetSchema,
  makeClip,
  newProject,
  publicProject,
  validateProject,
  type Asset,
} from "../src/shared/model";
import { publicAsset } from "../src/shared/agent-inspect";
import { Store } from "../src/main/store";
import { assetUrl } from "../src/composition/Video";
import { Media, Jobs } from "../src/main/media";
import { relinkMedia } from "../src/main/relink";
import {
  sceneStarters,
  hyperframesStarter,
} from "../src/shared/hyperframes-starters";

const folders: string[] = [];
afterEach(() =>
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true })),
);
const scene = (): Asset =>
  AssetSchema.parse({
    id: "scene",
    name: "Title",
    kind: "video",
    path: "/managed/scene.mp4",
    duration: 6,
    width: 1080,
    height: 1920,
    hasAudio: false,
    composition: {
      engine: "hyperframes",
      entry: "/managed/source/index.html",
      source: hyperframesStarter("title", {
        width: 1080,
        height: 1920,
        fps: 30,
      }),
      sourceHash: "a".repeat(64),
      engineVersion: "0.8.198",
      transparent: false,
    },
  });

describe("HTML scenes in saved projects", () => {
  it("reloads a changed scene's media while preserving its timeline asset ID", () => {
    const first = scene();
    const next = {
      ...first,
      composition: { ...first.composition!, sourceHash: "b".repeat(64) },
    };
    expect(first.id).toBe(next.id);
    expect(assetUrl("http://bridge", first, true)).not.toBe(
      assetUrl("http://bridge", next, true),
    );
    expect(assetUrl("http://bridge", first, false)).toBe(
      assetUrl("http://bridge", first, true),
    );
    expect(
      assetUrl("http://bridge", { ...first, composition: undefined }),
    ).toBe("http://bridge/media/scene/original");
  });
  it("keeps editable source and exact rendered versions through save, reopen and Undo", async () => {
    const folder = mkdtempSync(
      path.join(os.tmpdir(), "cutline-scene-project-"),
    );
    folders.push(folder);
    const file = path.join(folder, "project.cutline");
    const store = new Store(path.join(folder, "recovery.cutline"));
    const first = scene();
    const project = newProject();
    project.assets.push(first);
    project.clips.push(makeClip(project, "video", "video", 0, first));
    store.commit(validateProject(project), "Import scene");
    const second = {
      ...first,
      path: "/managed/new.mp4",
      composition: {
        ...first.composition!,
        source: first.composition!.source.replace(
          "Your next idea",
          "Changed title",
        ),
        sourceHash: "b".repeat(64),
      },
    };
    store.commit({ ...store.project, assets: [second] }, "Update scene");
    store.undo();
    expect(store.project.assets[0]).toEqual(first);
    store.redo();
    store.save(file);
    const reopened = new Store(path.join(folder, "second-recovery.cutline"));
    reopened.load(file);
    expect(reopened.project.assets[0]).toEqual(second);
    expect(reopened.project.clips[0].assetId).toBe(first.id);
    await store.close();
    await reopened.close();
  });

  it("keeps source and local entries out of ordinary agent reads", () => {
    const asset = scene();
    const project = newProject();
    project.assets = [asset];
    for (const output of [
      publicAsset(asset),
      publicProject(project).assets[0],
    ]) {
      const text = JSON.stringify(output);
      expect(text).not.toContain("/managed");
      expect(text).not.toContain("<!doctype");
      expect(output.composition).toEqual({
        engine: "hyperframes",
        sourceHash: "a".repeat(64),
        engineVersion: "0.8.198",
        transparent: false,
      });
    }
  });

  it("refuses reversing an alpha scene before creating an opaque reverse copy", () => {
    const asset = scene();
    asset.composition!.transparent = true;
    const project = newProject();
    project.assets = [asset];
    project.clips = [
      { ...makeClip(project, "video", "video", 0, asset), reverse: true },
    ];
    expect(() => validateProject(project)).toThrow(/transparent scenes/);
    project.clips[0].reverse = false;
    project.clips[0].freeze = true;
    expect(() => validateProject(project)).not.toThrow();
  });

  it("does not queue an opaque preview for a portrait alpha scene", () => {
    const media = new Media(
      "/unused",
      {
        ffmpeg: "/unused",
        ffprobe: "/unused",
        whisper: "/unused",
        model: "/unused",
      },
      new Jobs(() => {}),
    );
    const preview = vi.spyOn(media as any, "buildPreview");
    const asset = scene();
    asset.thumbnail = "/thumbnail.jpg";
    asset.composition!.transparent = true;
    media.ensurePreviews([asset]);
    expect(preview).not.toHaveBeenCalled();
  });

  it("keeps source ownership when a missing scene is offered replacement footage", async () => {
    const project = newProject();
    project.assets = [scene()];
    const store = { project, openSession: "session", commit: vi.fn() };
    const media = { import: vi.fn(), probe: vi.fn() };
    await expect(
      relinkMedia({ store: store as any, media }, "scene", "/other.mp4"),
    ).rejects.toThrow(/Edit source/);
    expect(media.import).not.toHaveBeenCalled();
    expect(store.commit).not.toHaveBeenCalled();
  });

  it.each(sceneStarters)(
    "provides a seekable offline $name starter at the project's dimensions",
    ({ id }) => {
      const source = hyperframesStarter(id, {
        width: 1080,
        height: 1920,
        fps: 24,
      });
      expect(source).toContain('data-width="1080"');
      expect(source).toContain('data-height="1920"');
      expect(source).toContain('data-fps="24"');
      expect(source).not.toMatch(
        /https?:|setInterval|Date\.now|Math\.random|requestAnimationFrame/,
      );
      expect(source).toContain(
        id === "three" ? "registerFrameSource" : "paused: true",
      );
      expect(source).toContain("./cutline-runtime/");
    },
  );
});
