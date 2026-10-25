import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  StockLibrary,
  normalizeStockSearch,
  stockUrl,
} from "../src/main/stock";
import {
  StockImportArgsSchema,
  createAgentMedia,
} from "../src/main/agent-media";
import { AssetSchema, newProject } from "../src/shared/model";

const audio = {
  id: "3849018d-0ac8-4f6b-b44d-5ec26a4b32af",
  title: "Mouse click sounds",
  url: "https://cdn.freesound.org/previews/347/347544_5662401-hq.mp3",
  foreign_landing_url: "https://freesound.org/people/Masgame/sounds/347544",
  creator: "Masgame",
  license: "cc0",
  license_version: "1.0",
  license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
  attribution: "Mouse click sounds by Masgame is marked CC0 1.0.",
  duration: 2310,
};
const image = {
  ...audio,
  id: "3030c37d-fb82-46d5-9b6b-c7338b35d50d",
  title: "City hall",
  duration: undefined,
  url: "https://live.staticflickr.com/1/city.jpg",
  foreign_landing_url: "https://www.flickr.com/photos/example/123",
  thumbnail:
    "https://api.openverse.org/v1/images/3030c37d-fb82-46d5-9b6b-c7338b35d50d/thumb/",
  width: 1080,
  height: 1920,
};
const json = (results: unknown[], page_count = 1) =>
  new Response(JSON.stringify({ results, page_count }), {
    headers: { "content-type": "application/json" },
  });
const jobs = {
  cancellers: new Map(),
  update: vi.fn(),
  run: async (_kind: string, _message: string, work: any) =>
    work({ id: "job", state: "running" }),
};
const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
async function setup(kind = "audio") {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "cutline-openverse-test-"),
  );
  folders.push(folder);
  const media = {
    import: vi.fn(async (file: string) =>
      AssetSchema.parse({
        id: "sound",
        name: "sound.mp3",
        path: file,
        kind,
        duration: 2.31,
        hasAudio: true,
      }),
    ),
  };
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  return {
    folder,
    fetch,
    service: new StockLibrary(folder, media as any, jobs as any),
  };
}

describe("Openverse search and imports", () => {
  it("searches anonymous commercial/modifiable audio, converts milliseconds, and retains attribution", async () => {
    const { service, fetch, folder } = await setup();
    fetch.mockResolvedValueOnce(json([audio], 2)).mockResolvedValueOnce(
      new Response("audio-content", {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    const found = await service.search("click", 0, {
      provider: "openverse",
      kind: "audio",
    });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/audio/");
    expect(url.searchParams.get("license_type")).toBe(
      "commercial,modification",
    );
    expect(url.searchParams.get("source")).toBe("freesound");
    expect(found.next).toBe(1);
    expect(found.items[0]).toMatchObject({
      id: audio.id,
      duration: 2.31,
      license: "CC0",
    });
    const imported = await service.download(audio.id, "openverse", "audio");
    expect(imported.kind).toBe("audio");
    expect(imported.origin).toMatchObject({
      provider: "Openverse",
      creator: "Masgame",
      page: audio.foreign_landing_url,
    });
    expect(await readFile(imported.path + ".credits.txt", "utf8")).toContain(
      audio.attribution,
    );
    expect((await readdir(folder)).some((file) => file.endsWith(".part"))).toBe(
      false,
    );
  });
  it("filters image orientation, unsafe hosts and incompatible license results", async () => {
    const { service, fetch } = await setup("image");
    fetch.mockResolvedValueOnce(
      json([
        image,
        { ...image, url: "https://127.0.0.1/private.jpg" },
        { ...image, license: "by-nc" },
        { ...image, width: 1920, height: 1080 },
      ]),
    );
    const found = await service.search("city", 0, {
      provider: "openverse",
      kind: "image",
      orientation: "portrait",
    });
    expect(found.items).toHaveLength(1);
    expect(found.items[0].url).toBe(image.url);
    expect(() =>
      normalizeStockSearch("city", 0, { provider: "openverse", kind: "video" }),
    ).toThrow("photos and audio");
    expect(() =>
      normalizeStockSearch("city", 0, { provider: "commons", kind: "audio" }),
    ).toThrow("Choose Openverse");
  });
  it("rejects redirect escapes before any private destination request", async () => {
    const { service, fetch, folder } = await setup();
    fetch.mockResolvedValueOnce(json([audio])).mockResolvedValueOnce(
      new Response("", {
        status: 302,
        headers: {
          location: "https://cdn.freesound.org.evil.test/private.mp3",
        },
      }),
    );
    await service.search("click", 0, { provider: "openverse", kind: "audio" });
    await expect(
      service.download(audio.id, "openverse", "audio"),
    ).rejects.toThrow("Unexpected stock");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readdir(folder)).toEqual([]);
    for (const value of [
      "https://127.0.0.1/x.mp3",
      "https://user:pass@cdn.freesound.org/x.mp3",
      "https://api.openverse.org/v1/auth_tokens/token/",
    ])
      expect(() => stockUrl(value, "media", "openverse")).toThrow();
  });
  it("places Openverse sound effects audibly on a separate audio track as one editable operation", async () => {
    const p = newProject();
    const store = {
      project: p,
      openSession: "test",
      commit: (next: typeof p) => {
        store.project = next;
      },
    };
    const asset = AssetSchema.parse({
      id: "click",
      name: "click.mp3",
      path: "/tmp/click.mp3",
      kind: "audio",
      duration: 2.31,
      hasAudio: true,
    });
    const call = createAgentMedia({
      store,
      stock: { download: async () => asset },
      jobs,
    } as any);
    expect(
      StockImportArgsSchema.parse({
        projectId: p.id,
        revision: p.revision,
        id: audio.id,
        provider: "openverse",
        kind: "audio",
      }).id,
    ).toBe(audio.id);
    const result: any = await call("cutline_stock_import", {
      projectId: p.id,
      revision: p.revision,
      id: audio.id,
      provider: "openverse",
      kind: "audio",
      at: { seconds: 1 },
    });
    const clip = store.project.clips.find((c) => c.id === result.clipId)!;
    expect(clip).toMatchObject({
      kind: "audio",
      start: 30,
      duration: 69,
      volume: 0.5,
      fadeIn: 2,
      fadeOut: 3,
    });
    expect(
      store.project.tracks.find((t) => t.id === clip.trackId),
    ).toMatchObject({ kind: "audio", name: "Sound effects", muted: false });
  });
});
