import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetSchema, type Asset } from "../src/shared/model";
import { Jobs } from "../src/main/media";
import {
  Hyperframes,
  hyperframesDimensions,
  type HyperframesOptions,
  type HyperframesRequest,
} from "../src/main/hyperframes";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const html = (title = "A scene") =>
  `<!doctype html><html><head><script src="./cutline-runtime/gsap.min.js"></script></head><body><div id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="2"><h1>${title}</h1></div><script>window.__timelines={main:gsap.timeline({paused:true}).from('h1',{opacity:0,duration:1})};</script></body></html>`;

async function setup(renderWorker?: HyperframesOptions["renderWorker"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutline-hyperframes-"));
  roots.push(root);
  const input = path.join(root, "input"),
    directory = path.join(root, "scenes");
  await mkdir(input);
  const jobs = new Jobs(() => {});
  let id = 0;
  const imported: string[] = [];
  const media = {
    import: async (file: string): Promise<Asset> => {
      imported.push(file);
      return AssetSchema.parse({
        id: `asset-${++id}`,
        name: "scene.mp4",
        kind: "video",
        path: file,
        duration: 2,
        width: 640,
        height: 360,
        hasAudio: false,
        thumbnail: `${file}.jpg`,
      });
    },
  };
  const requests: HyperframesRequest[] = [];
  const renderer = new Hyperframes({
    directory,
    media,
    jobs,
    browserExecutable: "/unused/chrome",
    ffmpeg: "/unused/ffmpeg",
    ffprobe: "/unused/ffprobe",
    renderWorker:
      renderWorker ??
      (async (request) => {
        requests.push(request);
        await writeFile(request.output, "rendered video");
      }),
  });
  return { renderer, root, input, directory, jobs, imported, requests };
}

describe("source-backed HyperFrames scenes", () => {
  it("checks the declared size and finite duration before rendering", () => {
    expect(hyperframesDimensions(html())).toEqual({
      width: 640,
      height: 360,
      duration: 2,
    });
    expect(() => hyperframesDimensions("<h1>No composition</h1>")).toThrow(
      "data-composition-id",
    );
    expect(() =>
      hyperframesDimensions(
        html().replace('data-duration="2"', 'data-duration="Infinity"'),
      ),
    ).toThrow("data-duration");
    expect(() =>
      hyperframesDimensions(
        html().replace('data-width="640"', 'data-width="99999"'),
      ),
    ).toThrow("4K");
    expect(() => hyperframesDimensions(html() + " ".repeat(1_000_000))).toThrow(
      "1 MB",
    );
  });

  it("imports an immutable local copy with assets and the bundled offline runtime", async () => {
    const { renderer, input, requests } = await setup();
    await mkdir(path.join(input, "assets"));
    await writeFile(path.join(input, "index.html"), html());
    await writeFile(path.join(input, "assets", "drawing.svg"), "<svg/>");
    await mkdir(path.join(input, "dist"));
    await writeFile(
      path.join(input, "dist", "scene.js"),
      "window.sceneLoaded = true;",
    );
    await mkdir(path.join(input, "node_modules"));
    await writeFile(path.join(input, "node_modules", "skip.js"), "unused");
    await writeFile(path.join(input, ".env"), "PRIVATE=value");
    await writeFile(path.join(input, "credentials.json"), "private");
    const asset = await renderer.render({ path: input });
    const composition = asset.composition!;
    expect(composition.source).toBe(html());
    expect(composition.entry).not.toBe(path.join(input, "index.html"));
    expect(
      await readFile(
        path.join(path.dirname(composition.entry), "assets", "drawing.svg"),
        "utf8",
      ),
    ).toBe("<svg/>");
    expect(
      await readFile(
        path.join(path.dirname(composition.entry), "dist", "scene.js"),
        "utf8",
      ),
    ).toBe("window.sceneLoaded = true;");
    expect(
      await readFile(
        path.join(
          path.dirname(composition.entry),
          "cutline-runtime",
          "gsap.min.js",
        ),
        "utf8",
      ),
    ).toContain("gsap");
    const copied = await readdir(path.dirname(composition.entry));
    expect(copied).not.toContain("node_modules");
    expect(copied).not.toContain(".env");
    expect(copied).not.toContain("credentials.json");
    expect(await readFile(path.join(input, "index.html"), "utf8")).toBe(html());
    expect(composition.sourceHash).toMatch(/^[a-f\d]{64}$/);
    expect(requests[0].fps).toBe(30);
    expect(asset.path.endsWith(".mp4")).toBe(true);
  });

  it("edits a new version without changing the previous source, media or identity", async () => {
    const { renderer } = await setup();
    const before = await renderer.render({
      html: html("Before"),
      name: "Product intro",
    });
    const withTransientData: Asset = {
      ...before,
      words: [{ text: "old", start: 0, end: 1 }],
      reversed: "/old/reversed.mp4",
      proxy: "/old/proxy.mp4",
    };
    const after = await renderer.render(
      { html: html("After") },
      withTransientData,
    );
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Product intro");
    expect(after.path).not.toBe(before.path);
    expect(after.composition!.entry).not.toBe(before.composition!.entry);
    expect(after.composition!.sourceHash).not.toBe(
      before.composition!.sourceHash,
    );
    expect(await readFile(before.composition!.entry, "utf8")).toBe(
      html("Before"),
    );
    expect(await readFile(after.composition!.entry, "utf8")).toBe(
      html("After"),
    );
    expect(after.words).toBeUndefined();
    expect(after.reversed).toBeUndefined();
    expect(after.proxy).toBeUndefined();
    expect(after.thumbnail).not.toBe(before.thumbnail);
  });

  it("keeps copied dependencies across a source edit and hashes changed asset bytes", async () => {
    const { renderer, input } = await setup();
    await writeFile(path.join(input, "index.html"), html());
    await writeFile(path.join(input, "asset.txt"), "first");
    const before = await renderer.render({
      path: path.join(input, "index.html"),
    });
    await writeFile(path.join(input, "asset.txt"), "other");
    const reimported = await renderer.render({
      path: path.join(input, "index.html"),
    });
    expect(reimported.composition!.sourceHash).not.toBe(
      before.composition!.sourceHash,
    );
    const edited = await renderer.render({ html: html("Edit") }, before);
    expect(
      await readFile(
        path.join(path.dirname(edited.composition!.entry), "asset.txt"),
        "utf8",
      ),
    ).toBe("first");
    expect(await readFile(path.join(input, "asset.txt"), "utf8")).toBe("other");
  });

  it("chooses alpha-capable WebM for transparent scenes and retains that choice", async () => {
    const { renderer, requests } = await setup();
    const before = await renderer.render({
      html: html(),
      transparent: true,
      fps: 24,
    });
    const after = await renderer.render({ html: html("new") }, before);
    expect(after.path.endsWith(".webm")).toBe(true);
    expect(after.composition!.transparent).toBe(true);
    expect(requests.map((r) => [r.fps, r.transparent])).toEqual([
      [24, true],
      [24, true],
    ]);
  });

  it("does not follow symbolic links to files outside the scene folder", async () => {
    const { renderer, root, input, directory, imported } = await setup();
    await writeFile(path.join(input, "index.html"), html());
    await writeFile(path.join(root, "private.txt"), "private");
    await symlink(
      path.join(root, "private.txt"),
      path.join(input, "linked.txt"),
    );
    await expect(renderer.render({ path: input })).rejects.toThrow(
      "symbolic links",
    );
    expect(await readdir(directory)).toEqual([]);
    expect(imported).toEqual([]);
  });

  it("rejects oversized scene folders before rendering or importing", async () => {
    const { renderer, input, directory, requests } = await setup();
    await writeFile(path.join(input, "index.html"), html());
    const big = path.join(input, "large.dat");
    await writeFile(big, "");
    await truncate(big, 257 * 1024 ** 2);
    await expect(renderer.render({ path: input })).rejects.toThrow("256 MB");
    expect(requests).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("cleans a failed version and leaves the previous one usable", async () => {
    let shouldFail = false;
    const { renderer, directory, imported } = await setup(async (request) => {
      await writeFile(request.output, "partial");
      if (shouldFail) throw Error("A source script failed");
    });
    const before = await renderer.render({ html: html() });
    shouldFail = true;
    await expect(
      renderer.render({ html: html("broken") }, before),
    ).rejects.toThrow("source script failed");
    expect(await readdir(directory)).toHaveLength(1);
    expect(await readFile(before.path, "utf8")).toBe("partial");
    expect(imported).toEqual([before.path]);
  });

  it("discards an unapplied render when a later project transaction rejects it", async () => {
    const { renderer, directory } = await setup();
    const asset = await renderer.render({ html: html() });
    await renderer.discard(asset);
    expect(await readdir(directory)).toEqual([]);
    await renderer.discard(asset);
    expect(await readdir(directory)).toEqual([]);
  });

  it("never discards a committed source or Undo version when a later render is rejected", async () => {
    const { renderer, directory } = await setup();
    const before = await renderer.render({ html: html("Committed") });
    renderer.accept(before);
    const after = await renderer.render({ html: html("Rejected") }, before);
    await renderer.discard(after);
    await renderer.discard(before);
    expect(await readdir(directory)).toHaveLength(1);
    expect(await readFile(before.path, "utf8")).toBe("rendered video");
    expect(await readFile(before.composition!.entry, "utf8")).toBe(
      html("Committed"),
    );
  });

  it("cannot discard a loaded version, arbitrary path or mismatched source", async () => {
    const { renderer, root, directory } = await setup();
    const asset = await renderer.render({ html: html() });
    const unrelated = path.join(root, "keep.txt");
    await writeFile(unrelated, "keep");
    await renderer.discard({ ...asset, path: unrelated });
    await renderer.discard({
      ...asset,
      composition: { ...asset.composition!, entry: unrelated },
    });
    expect(await readFile(unrelated, "utf8")).toBe("keep");
    expect(await readdir(directory)).toHaveLength(1);
    const other = (await setup()).renderer;
    await other.discard(asset);
    expect(await readFile(asset.path, "utf8")).toBe("rendered video");
    renderer.accept(asset);
    await renderer.discard(asset);
    expect(await readFile(asset.composition!.entry, "utf8")).toBe(html());
  });

  it("serializes scenes and cancels both the active and queued work on close", async () => {
    let active = 0,
      peak = 0,
      started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { renderer, directory, imported } = await setup(
      async (_request, signal) => {
        active++;
        peak = Math.max(peak, active);
        started();
        await new Promise<void>((_resolve, reject) => {
          const cancel = () => {
            active--;
            reject(Error("Cancelled"));
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
      },
    );
    const first = renderer.render({ html: html("First") });
    const second = renderer.render({ html: html("Second") });
    const outcomes = Promise.allSettled([first, second]);
    await ready;
    renderer.close();
    expect((await outcomes).map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(peak).toBe(1);
    expect(imported).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
    await expect(renderer.render({ html: html() })).rejects.toThrow("closed");
  });

  it("uses the Jobs cancellation scope and removes a cancelled snapshot", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { renderer, jobs, directory } = await setup(
      async (_request, signal) => {
        started();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(Error("Cancelled")), {
            once: true,
          }),
        );
      },
    );
    const pending = renderer.render({ html: html() });
    const outcome = pending.catch((error: Error) => error.message);
    await ready;
    const job = [...jobs.jobs.values()].find(
      (job) => job.kind === "hyperframes",
    )!;
    jobs.cancel(job.id);
    expect(await outcome).toBe("Cancelled");
    expect(job.state).toBe("cancelled");
    expect(await readdir(directory)).toEqual([]);
  });
});
