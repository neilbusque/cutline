import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentIO, agentIoTools } from "../src/main/agent-io";
import { Media, Jobs } from "../src/main/media";
import { Store } from "../src/main/store";
import { makeClip, newProject, publicProject } from "../src/shared/model";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "cutline-vector-import-"),
  );
  directories.push(directory);
  const store = new Store(path.join(directory, "recovery.cutline"));
  const p = newProject();
  p.clips = [{ ...makeClip(p, "text", "titles", 0), text: "Original title" }];
  store.commit(p, "Existing work");
  const jobs = new Jobs(() => {});
  const media = new Media(
    path.join(directory, "media"),
    { ffmpeg: "unused", ffprobe: "unused", whisper: "", model: "" },
    jobs,
  );
  const call = createAgentIO({
    store,
    media,
    jobs,
    directory,
    preview: async () => ({}),
    status: () => ({}),
  });
  const args = (file: string) => ({
    projectId: store.project.id,
    revision: store.project.revision,
    path: file,
    startFrame: 17,
  });
  return { directory, store, call, args };
}

const comparable = (p: unknown) =>
  JSON.parse(JSON.stringify({ ...(p as object), revision: 0 }));

describe("local editable SVG import", () => {
  it("imports maximum-length names on a new track without losing the source name", async () => {
    const { directory, store, call, args } = fixture();
    const name = "Brand".repeat(20);
    const file = path.join(directory, `${name}.svg`);
    writeFileSync(
      file,
      '<svg viewBox="0 0 100 100"><path d="M0 0 L50 50"/></svg>',
    );
    const before = comparable(publicProject(store.project));
    const history = store.past.length;
    const result = (await call("cutline_vector_import", args(file))) as any;
    const clip = store.project.clips.find((c) => c.id === result.clipId)!;
    expect(clip.trackId).not.toBe("titles");
    expect(clip.text).toBe(name);
    expect(
      store.project.motions.find((m) => m.id === result.motionId)?.name,
    ).toBe(name);
    expect(
      store.project.tracks.find((t) => t.id === clip.trackId)?.name.length,
    ).toBeLessThanOrEqual(100);
    expect(store.past.length).toBe(history + 1);
    store.undo();
    expect(comparable(publicProject(store.project))).toEqual(before);
    const explicit = (await call("cutline_vector_import", {
      ...args(file),
      name,
    })) as any;
    expect(
      store.project.motions.find((m) => m.id === explicit.motionId)?.name,
    ).toBe(name);
    expect(new Store(store.recovery).project.motions.at(-1)?.name).toBe(name);
  });

  it("imports transformed paint/path data in one undoable edit, preserves work/source and persists without the source file", async () => {
    const { directory, store, call, args } = fixture();
    const file = path.join(directory, "Original mark.svg");
    const svg =
      '<svg viewBox="0 0 100 100"><g transform="translate(5 8)" fill="#ba7453"><path id="Mark" d="M10 10 L70 10 L70 70 Z"/><path fill="none" stroke="#eee9df" stroke-width="3" d="M5 80 C25 20 60 20 80 80"/></g></svg>';
    writeFileSync(file, svg);
    const before = comparable(publicProject(store.project)),
      history = store.past.length;
    const result = (await call("cutline_vector_import", args(file))) as any;
    expect(result.vectorLayers).toBe(2);
    expect(store.past.length).toBe(history + 1);
    const imported = store.project.clips.find((c) => c.id === result.clipId)!;
    expect(imported.start).toBe(17);
    expect(imported.trackId).not.toBe("titles");
    expect(store.project.clips[0].text).toBe("Original title");
    expect(
      store.project.motions[0].layers.every((l) => l.type === "path"),
    ).toBe(true);
    expect(store.project.motions[0].layers[0].background).toBe("#ba7453");
    expect(store.project.motions[0].layers[0].vectorTransform).toEqual([
      1, 0, 0, 1, 5, 8,
    ]);
    expect(readFileSync(file, "utf8")).toBe(svg);
    const after = comparable(publicProject(store.project));
    store.undo();
    expect(comparable(publicProject(store.project))).toEqual(before);
    store.redo();
    expect(comparable(publicProject(store.project))).toEqual(after);
    rmSync(file);
    const reopened = new Store(store.recovery);
    expect(comparable(publicProject(reopened.project))).toEqual(after);
    expect(reopened.snapshot().missing).toEqual([]);
  });

  it("rejects stale guards and unsupported SVG without creating clips or undo entries", async () => {
    const { directory, store, call, args } = fixture();
    const file = path.join(directory, "Unsafe.svg");
    writeFileSync(
      file,
      '<svg viewBox="0 0 100 100"><script>unsafe()</script><path d="M0 0 L10 10"/></svg>',
    );
    const before = comparable(store.project),
      history = store.past.length;
    await expect(call("cutline_vector_import", args(file))).rejects.toThrow();
    await expect(
      call("cutline_vector_import", { ...args(file), revision: 0 }),
    ).rejects.toThrow(/changed/i);
    expect(comparable(store.project)).toEqual(before);
    expect(store.past.length).toBe(history);
  });

  it("rejects relative paths, wrong extensions and oversized files and exposes the import tool", async () => {
    const { directory, store, call, args } = fixture();
    const file = path.join(directory, "Large.svg");
    writeFileSync(file, " ".repeat(262145));
    const before = comparable(store.project),
      history = store.past.length;
    await expect(call("cutline_vector_import", args(file))).rejects.toThrow(
      /256 KiB/,
    );
    await expect(
      call("cutline_vector_import", args("relative.svg")),
    ).rejects.toThrow(/absolute path/);
    const wrong = path.join(directory, "Mark.txt");
    writeFileSync(wrong, '<svg viewBox="0 0 100 100"/>');
    await expect(call("cutline_vector_import", args(wrong))).rejects.toThrow(
      /\.svg/,
    );
    expect(comparable(store.project)).toEqual(before);
    expect(store.past.length).toBe(history);
    expect(
      agentIoTools.find((t) => t.name === "cutline_vector_import")?.annotations
        .readOnlyHint,
    ).toBe(false);
  });
});
