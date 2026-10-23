import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { StoryControl } from "../src/main/story-control";
import { StoryPlanSchema } from "../src/shared/story-schema";

let folder: string;
let store: Store;
beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "cutline-product-control-"));
  store = new Store(path.join(folder, "recovery.json"));
  store.commit(
    {
      ...store.project,
      story: StoryPlanSchema.parse({
        scenes: [
          {
            id: "title",
            visualPrompt: "An old footage prompt",
            design: { layout: "title", headline: "Make your next idea move." },
          },
        ],
      }),
    },
    "Product story",
  );
});
afterEach(() => {
  store.flush();
  rmSync(folder, { recursive: true, force: true });
});
const args = () => ({
  projectId: store.project.id,
  revision: store.project.revision,
  sceneId: "title",
});
function controls() {
  const generation = {
    list: vi.fn(() => []),
    submit: vi.fn(),
    refresh: vi.fn(),
    importAsset: vi.fn(),
    pickReference: vi.fn(),
  };
  const configured = vi.fn(async () => true);
  return {
    control: new StoryControl({ store, generation, configured }),
    generation,
    configured,
  };
}

describe("Product film control", () => {
  it("creates native graphic scenes without credentials or a provider request", async () => {
    const { control, generation, configured } = controls();
    const revision = store.project.revision;
    await expect(control.generate(args())).rejects.toThrow(/editable graphics/);
    expect(configured).not.toHaveBeenCalled();
    expect(generation.submit).not.toHaveBeenCalled();
    expect(store.project.revision).toBe(revision);
    const result = control.assemble({ ...args(), mode: "append" });
    expect(result.sceneCount).toBe(1);
    expect(
      store.project.clips.some((clip) =>
        clip.text.replace(/\s+/g, " ").includes("Make your next idea move."),
      ) ||
        store.project.motions.some((motion) =>
          motion.layers.some((layer) =>
            layer.text.replace(/\s+/g, " ").includes("Make your next idea move."),
          ),
        ),
    ).toBe(true);
  });

  it("does not require stale unused footage after choosing a graphics layout", () => {
    store.commit(
      {
        ...store.project,
        assets: [
          {
            id: "unused",
            kind: "image",
            name: "Moved screenshot",
            path: path.join(folder, "missing.png"),
            duration: 0,
            hasAudio: false,
          },
        ],
        story: {
          ...store.project.story!,
          scenes: store.project.story!.scenes.map((scene) => ({
            ...scene,
            assetId: "unused",
          })),
        },
      },
      "Choose graphic layout",
    );
    const { control } = controls();
    expect(() => control.assemble({ ...args(), mode: "append" })).not.toThrow();
  });

  it("still rejects missing footage needed for a screen layout without partial assembly", () => {
    store.commit(
      {
        ...store.project,
        assets: [
          {
            id: "missing",
            kind: "image",
            name: "Moved screenshot",
            path: path.join(folder, "missing.png"),
            duration: 0,
            hasAudio: false,
          },
        ],
        story: {
          ...store.project.story!,
          scenes: store.project.story!.scenes.map((scene) => ({
            ...scene,
            assetId: "missing",
            design: { ...scene.design!, layout: "screen" as const },
          })),
        },
      },
      "Choose screen layout",
    );
    const { control } = controls();
    const before = JSON.stringify(store.project);
    expect(() => control.assemble({ ...args(), mode: "append" })).toThrow(
      /Relink missing/,
    );
    expect(JSON.stringify(store.project)).toBe(before);
  });
});
