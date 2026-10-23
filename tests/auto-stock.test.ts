import { describe, it, expect, vi } from "vitest";
import {
  acquireAutoStock,
  autoStockLicenseAllowed,
  rankAutoStock,
  type AutoStockBeat,
} from "../src/main/auto-stock";
import type { StockItem, StockResults } from "../src/shared/stock";
import type { Asset } from "../src/shared/model";

const beat: AutoStockBeat = {
  query: "coffee",
  keywords: ["coffee", "cup"],
  startSeconds: 3,
  durationSeconds: 2.5,
  reason: "Spoken reference to coffee",
};
const item = (patch: Partial<StockItem> = {}): StockItem => ({
  id: 1,
  key: "commons:video:1",
  provider: "commons",
  kind: "video",
  title: "Preparing coffee in a cup",
  creator: "Alex",
  license: "CC0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  page: "https://commons.wikimedia.org/wiki/File:Coffee.webm",
  thumbnail: "https://upload.wikimedia.org/coffee.jpg",
  url: "https://upload.wikimedia.org/coffee.webm",
  preview: "https://upload.wikimedia.org/coffee.webm",
  duration: 8,
  width: 1920,
  height: 1080,
  size: 3_000_000,
  ...patch,
});
const results = (items: StockItem[]): StockResults => ({
  provider: items[0]?.provider ?? "commons",
  kind: items[0]?.kind ?? "video",
  items,
  videos: items,
});
const asset = (patch: Partial<Asset> = {}): Asset => ({
  id: "asset-1",
  name: "Coffee",
  path: "/local/coffee.webm",
  kind: "video",
  duration: 8,
  hasAudio: false,
  origin: {
    provider: "Wikimedia Commons",
    title: "Coffee",
    page: item().page,
    creator: "Alex",
    license: "CC0",
    licenseUrl: item().licenseUrl,
  },
  ...patch,
});

describe("automatic stock selection", () => {
  it("ranks actual visual title relevance and rejects unrelated creators, unsafe licenses and oversized media", () => {
    expect(rankAutoStock(item(), beat)).toBeGreaterThan(0.7);
    expect(
      rankAutoStock(
        item({ title: "Mountain scenery", creator: "Coffee photographer" }),
        beat,
      ),
    ).toBe(0);
    expect(rankAutoStock(item({ license: "CC BY-SA 4.0" }), beat)).toBe(0);
    expect(rankAutoStock(item({ size: 51 * 1024 * 1024 }), beat)).toBe(0);
    expect(rankAutoStock(item({ width: 320, height: 180 }), beat)).toBe(0);
    expect(autoStockLicenseAllowed(item({ license: "CC BY 4.0" }))).toBe(true);
    expect(autoStockLicenseAllowed(item({ license: "CC BY-NC 4.0" }))).toBe(
      false,
    );
    expect(
      autoStockLicenseAllowed(item({ license: "Review source license" })),
    ).toBe(false);
  });

  it("matches close visual vocabulary without inserting generic unrelated footage", () => {
    expect(
      rankAutoStock(item({ title: "Waves on a rocky shoreline" }), {
        ...beat,
        query: "ocean",
        keywords: ["ocean"],
      }),
    ).toBeGreaterThan(0.7);
    expect(
      rankAutoStock(item({ title: "Life moments in the mountains" }), {
        ...beat,
        query: "better moments",
        keywords: ["moments"],
      }),
    ).toBe(0);
    expect(
      rankAutoStock(item({ title: "New York street" }), {
        ...beat,
        query: "coffee shops in New York",
        keywords: ["coffee"],
      }),
    ).toBe(0);
  });

  it("does not turn a weak subject match into an accepted match because it is portrait or high resolution", () => {
    const water = {
      ...beat,
      query: "drinking water",
      keywords: ["drinking", "water"],
    };
    for (const [width, height] of [
      [1080, 1920],
      [2160, 3840],
      [1920, 1080],
    ]) {
      expect(
        rankAutoStock(
          item({ title: "People drinking wine", width, height }),
          water,
        ),
      ).toBe(0);
      expect(
        rankAutoStock(
          item({ title: "People drinking water", width, height }),
          water,
        ),
      ).toBeGreaterThan(0.7);
    }
    expect(
      rankAutoStock(
        item({ title: "People drinking wine", width: 1080, height: 1920 }),
        { ...water, query: "water" },
      ),
    ).toBe(0);
    expect(
      rankAutoStock(item({ title: "Ocean in Sommaroy" }), {
        ...beat,
        query: "ocean",
        keywords: ["ocean", "beach"],
      }),
    ).toBeGreaterThan(0.7);
  });

  it("requires the spoken action as well as its subject, and reads real descriptive metadata", () => {
    const grinding = {
      ...beat,
      query: "grinding coffee beans",
      keywords: ["coffee", "beans", "grinding"],
      subjects: ["coffee", "bean"],
      actions: ["grind"],
    };
    expect(
      rankAutoStock(item({ title: "Drinking coffee in a cafe" }), grinding),
    ).toBe(0);
    expect(
      rankAutoStock(item({ title: "Coffee beans on a table" }), grinding),
    ).toBe(0);
    expect(
      rankAutoStock(
        item({ title: "Grinding spices beside coffee beans" }),
        grinding,
      ),
    ).toBe(0);
    expect(
      rankAutoStock(item({ title: "Grinding spices beside coffee beans" }), {
        ...grinding,
        query: "drinking coffee",
        subjects: ["coffee"],
        actions: ["drink"],
      }),
    ).toBe(0);
    expect(
      rankAutoStock(
        item({
          title: "DSC 402",
          description: "A hand grinder grinding freshly roasted coffee beans.",
        }),
        grinding,
      ),
    ).toBeGreaterThan(0.8);
    expect(
      rankAutoStock(item({ title: "Grinding coffee beans" }), grinding),
    ).toBeGreaterThan(
      rankAutoStock(
        item({
          title: "DSC 402",
          description: "A hand grinder grinding freshly roasted coffee beans.",
        }),
        grinding,
      ),
    );
  });

  it("accepts exact coffee grinding when beans are an optional descriptive detail", () => {
    const grinding = {
      ...beat,
      query: "grinding coffee beans",
      keywords: ["coffee", "bean", "grind"],
      subjects: ["coffee"],
      actions: ["grind"],
    };
    expect(
      rankAutoStock(item({ title: "Grinding coffee" }), grinding),
    ).toBeGreaterThan(0.8);
    expect(
      rankAutoStock(item({ title: "Roasted coffee beans" }), grinding),
    ).toBe(0);
  });

  it("does not assume a requested action starts at the beginning of a long or mixed routine", () => {
    const grinding = {
      ...beat,
      query: "grinding coffee beans",
      keywords: ["coffee", "bean", "grind"],
      subjects: ["coffee"],
      actions: ["grind"],
    };
    const routine = item({
      title:
        "Morning Espresso Routine - Progress, Results, Observations and Miscellany",
      description: "Grinding coffee beans and preparing espresso.",
      duration: 55.858,
    });
    expect(rankAutoStock(routine, grinding)).toBe(0);
    expect(
      rankAutoStock(
        { ...routine, title: "Morning coffee", duration: 21 },
        grinding,
      ),
    ).toBe(0);
    expect(
      rankAutoStock(
        { ...routine, title: "Morning routine", duration: 12 },
        grinding,
      ),
    ).toBe(0);
    expect(
      rankAutoStock(
        { ...routine, title: "Coffee grinding compilation", duration: 12 },
        grinding,
      ),
    ).toBe(0);
    expect(
      rankAutoStock(
        { ...routine, title: "Grinding coffee beans", duration: 8 },
        grinding,
      ),
    ).toBeGreaterThan(0.8);
    expect(
      rankAutoStock(
        { ...routine, title: "Hands at work", duration: 8 },
        grinding,
      ),
    ).toBeGreaterThan(0.8);
    expect(
      rankAutoStock(
        {
          ...routine,
          title: "Grinding coffee beans",
          kind: "image",
          duration: 4,
        },
        grinding,
      ),
    ).toBeGreaterThan(0.8);
  });

  it("requires a process rather than a static tool or a completed state", () => {
    const grinding = {
      ...beat,
      query: "grinding coffee",
      subjects: ["coffee"],
      actions: ["grind"],
    };
    const roasting = {
      ...beat,
      query: "roasting coffee beans",
      subjects: ["coffee", "bean"],
      actions: ["roast"],
    };
    expect(
      rankAutoStock(
        item({ title: "A coffee grinder sits on the shelf" }),
        grinding,
      ),
    ).toBe(0);
    expect(
      rankAutoStock(
        item({ title: "Roasted coffee beans in a bowl" }),
        roasting,
      ),
    ).toBe(0);
    expect(
      rankAutoStock(
        item({ title: "A barista grinding coffee", kind: "image" }),
        grinding,
      ),
    ).toBeGreaterThan(0.8);
    expect(
      rankAutoStock(
        item({ title: "A person roasting coffee beans", kind: "image" }),
        roasting,
      ),
    ).toBeGreaterThan(0.8);
    expect(
      rankAutoStock(
        item({
          title: "Sample 17",
          description: "Diagram showing grinding coffee beans",
        }),
        grinding,
      ),
    ).toBe(0);
  });

  it("keeps the rejected side of comparison language out of stock evidence", () => {
    for (const title of [
      "Drinking tea instead of coffee",
      "Tea rather than coffee",
      "Tea without coffee",
    ])
      expect(rankAutoStock(item({ title }), beat)).toBe(0);
    expect(
      rankAutoStock(item({ title: "Drinking coffee instead of tea" }), beat),
    ).toBeGreaterThan(0.8);
    expect(
      rankAutoStock(
        item({ title: "Drink photo", description: "Tea rather than coffee" }),
        beat,
      ),
    ).toBe(0);
  });

  it("rejects negated metadata, explanatory graphics and notebook/laptop confusion", () => {
    for (const title of [
      "Not coffee but a glass of wine",
      "Coffee company logo",
      "Coffee growing map",
      "Coffee brewing diagram",
      "Coffee shop screenshot",
      "Coffee album cover",
      "Coffee inventor portrait",
    ])
      expect(rankAutoStock(item({ title }), beat)).toBe(0);
    expect(
      rankAutoStock(
        item({
          title: "Sample 15",
          description: "Not coffee. A glass of wine on the table.",
        }),
        beat,
      ),
    ).toBe(0);
    expect(
      rankAutoStock(item({ title: "Writing in a paper notebook" }), {
        ...beat,
        query: "laptop",
        keywords: ["laptop"],
      }),
    ).toBe(0);
    expect(
      rankAutoStock(
        item({
          title: "Coffee plantation",
          description: "A person grinding pepper in a kitchen.",
        }),
        {
          ...beat,
          query: "grinding coffee",
          subjects: ["coffee"],
          actions: ["grind"],
        },
      ),
    ).toBe(0);
  });

  it("tries a second topic query but retains the action gate and original placement identity", async () => {
    const grinding = {
      ...beat,
      query: "grinding coffee beans",
      keywords: ["coffee", "beans", "grinding"],
      subjects: ["coffee", "bean"],
      actions: ["grind"],
      searchQueries: ["grinding coffee beans", "coffee beans"],
    };
    const found = item({ title: "Hand grinding coffee beans" });
    const stock = {
      search: vi
        .fn()
        .mockResolvedValueOnce(results([item({ title: "Drinking coffee" })]))
        .mockResolvedValueOnce(results([found])),
      download: vi.fn().mockResolvedValue(asset()),
    };
    const output = await acquireAutoStock({
      beats: [grinding],
      stock,
      provider: "commons",
    });
    expect(stock.search.mock.calls.map((call) => call[0])).toEqual([
      "grinding coffee beans",
      "coffee beans",
    ]);
    expect(output.downloadCount).toBe(1);
    expect(output.placements[0].query).toBe("grinding coffee beans");
    const wrong = {
      search: vi
        .fn()
        .mockResolvedValue(
          results([item({ title: "Drinking coffee beside coffee beans" })]),
        ),
      download: vi.fn(),
    };
    const empty = await acquireAutoStock({
      beats: [grinding],
      stock: wrong,
      provider: "commons",
    });
    expect(empty.searchCount).toBe(4);
    expect(wrong.download).not.toHaveBeenCalled();
  });

  it("avoids repeated shots under different ids and caps all fallback calls", async () => {
    let index = 0;
    const stock = {
      search: vi.fn().mockImplementation(async () =>
        results([
          item({
            id: ++index,
            key: `commons:video:${index}`,
            page: `https://commons.wikimedia.org/wiki/File:Coffee-${index}.webm`,
          }),
        ]),
      ),
      download: vi
        .fn()
        .mockImplementation(async () => asset({ id: `asset-${index}` })),
    };
    const output = await acquireAutoStock({
      beats: [beat, { ...beat, startSeconds: 18 }],
      stock,
      provider: "commons",
    });
    expect(output.downloadCount).toBe(1);
    const wrong = {
      search: vi
        .fn()
        .mockResolvedValue(results([item({ title: "An unrelated mountain" })])),
      download: vi.fn(),
    };
    const contextual = {
      ...beat,
      query: "grinding coffee",
      subjects: ["coffee"],
      actions: ["grind"],
      searchQueries: ["grinding coffee", "coffee"],
    };
    const capped = await acquireAutoStock({
      beats: Array.from({ length: 6 }, (_, index) => ({
        ...contextual,
        startSeconds: index * 7,
      })),
      stock: wrong,
      provider: "commons",
    });
    expect(capped.searchCount).toBe(18);
    expect(wrong.download).not.toHaveBeenCalled();
  });

  it("returns downloaded assets and beat-aligned placements with credits preserved", async () => {
    const stock = {
      search: vi.fn().mockResolvedValue(results([item()])),
      download: vi.fn().mockResolvedValue(asset()),
    };
    const output = await acquireAutoStock({
      beats: [beat],
      stock,
      provider: "commons",
    });
    expect(output.assets[0].origin?.license).toBe("CC0");
    expect(output.placements).toEqual([
      {
        assetId: "asset-1",
        startSeconds: 3,
        durationSeconds: 2.5,
        query: "coffee",
      },
    ]);
    expect(output.warnings).toEqual([]);
    expect(stock.download).toHaveBeenCalledWith(1, "commons", "video");
  });

  it("uses a relevant photo when no video matches, but does not download unrelated fallback imagery", async () => {
    const stock = {
      search: vi
        .fn()
        .mockResolvedValueOnce(results([item({ title: "Ocean at dawn" })]))
        .mockResolvedValueOnce(
          results([
            item({
              id: 2,
              key: "commons:image:2",
              kind: "image",
              title: "Cup of coffee",
              license: "Public domain",
            }),
          ]),
        ),
      download: vi
        .fn()
        .mockResolvedValue(asset({ kind: "image", duration: 4 })),
    };
    const output = await acquireAutoStock({
      beats: [beat],
      stock,
      provider: "commons",
    });
    expect(output.searchCount).toBe(2);
    expect(stock.download).toHaveBeenCalledWith(2, "commons", "image");
    expect(output.assets).toHaveLength(1);
    const unrelated = {
      search: vi
        .fn()
        .mockResolvedValue(results([item({ title: "A mountain" })])),
      download: vi.fn(),
    };
    const empty = await acquireAutoStock({
      beats: [beat],
      stock: unrelated,
      provider: "commons",
    });
    expect(empty.assets).toEqual([]);
    expect(empty.warnings[0]).toContain("No clearly relevant");
    expect(unrelated.download).not.toHaveBeenCalled();
  });

  it("deduplicates downloads and enforces a bounded acquisition count", async () => {
    const stock = {
      search: vi.fn().mockImplementation(async () => results([item()])),
      download: vi.fn().mockResolvedValue(asset()),
    };
    const output = await acquireAutoStock({
      beats: [
        beat,
        { ...beat, startSeconds: 8 },
        { ...beat, startSeconds: 13 },
      ],
      stock,
      provider: "commons",
    });
    expect(output.assets).toHaveLength(1);
    expect(stock.download).toHaveBeenCalledTimes(1);
    expect(output.searchCount).toBeLessThanOrEqual(6);
    const capped = {
      search: vi.fn().mockResolvedValue(results([item()])),
      download: vi.fn().mockResolvedValue(asset()),
    };
    expect(
      (
        await acquireAutoStock({
          beats: [beat, beat],
          stock: capped,
          provider: "commons",
          maxDownloads: 1,
        })
      ).downloadCount,
    ).toBe(1);
    expect(capped.search).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation and stale-project checks instead of reporting them as optional stock warnings", async () => {
    const stale = new Error("Project changed. Inspect the project and retry.");
    let cancelled = false;
    const stock = {
      search: vi.fn().mockImplementation(async () => {
        cancelled = true;
        return results([item()]);
      }),
      download: vi.fn(),
    };
    let thrownOnce = false;
    await expect(
      acquireAutoStock({
        beats: [beat],
        stock,
        provider: "commons",
        checkCancelled: () => {
          if (cancelled && !thrownOnce) {
            thrownOnce = true;
            throw stale;
          }
        },
      }),
    ).rejects.toBe(stale);
    expect(stock.download).not.toHaveBeenCalled();
  });

  it("keeps optional provider/download failures as warnings and does not return uncredited media", async () => {
    const stock = {
      search: vi.fn().mockResolvedValue(results([item()])),
      download: vi.fn().mockResolvedValue(asset({ origin: undefined })),
    };
    const output = await acquireAutoStock({
      beats: [beat],
      stock,
      provider: "commons",
    });
    expect(output.assets).toEqual([]);
    expect(output.warnings[0]).toContain("missing source credits");
    const unavailable = {
      search: vi.fn().mockRejectedValue(new Error("request limit reached")),
      download: vi.fn(),
    };
    expect(
      (
        await acquireAutoStock({
          beats: [beat],
          stock: unavailable,
          provider: "pexels",
        })
      ).warnings[0],
    ).toContain("request limit");
    expect(unavailable.search).toHaveBeenCalledTimes(1);
  });

  it("deletes downloads it cannot use, and every download when cancelled", async () => {
    const uncredited = asset({ id: "uncredited", origin: undefined });
    const rejected = {
      search: vi.fn().mockResolvedValue(results([item()])),
      download: vi.fn().mockResolvedValue(uncredited),
      discard: vi.fn(async () => {}),
    };
    await acquireAutoStock({
      beats: [beat],
      stock: rejected,
      provider: "commons",
    });
    expect(rejected.discard).toHaveBeenCalledWith(uncredited);
    const kept = asset({ id: "kept" });
    const stopped = Error("Automatic edit cancelled");
    let cancelled = false;
    const cancelling = {
      search: vi.fn().mockResolvedValue(results([item()])),
      download: vi.fn(async () => {
        cancelled = true;
        return kept;
      }),
      discard: vi.fn(async () => {}),
    };
    await expect(
      acquireAutoStock({
        beats: [beat, { ...beat, startSeconds: 4, query: "coffee cup" }],
        stock: cancelling,
        provider: "commons",
        checkCancelled: () => {
          if (cancelled) throw stopped;
        },
      }),
    ).rejects.toBe(stopped);
    expect(cancelling.discard).toHaveBeenCalledWith(kept);
  });
});
