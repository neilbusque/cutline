import type { Asset } from "../shared/model";
import type { StockItem, StockKind, StockProvider } from "../shared/stock";
import type { StockLibrary } from "./stock";
import {
  stockKeywords,
  stockWords,
  stockActionKey,
  visualMetadataClauses,
  type StockIntent,
} from "../shared/stock-relevance";
export { stockKeywords } from "../shared/stock-relevance";

export type AutoStockBeat = StockIntent & {
  query: string;
  keywords: string[];
  startSeconds: number;
  durationSeconds: number;
  reason: string;
};
export type AutoStockPlacement = {
  assetId: string;
  startSeconds: number;
  durationSeconds: number;
  query: string;
};
export type AutoStockProgress = {
  message: string;
  progress: number;
  beatIndex: number;
  beatCount: number;
};
export type AutoStockResult = {
  assets: Asset[];
  placements: AutoStockPlacement[];
  warnings: string[];
  searchCount: number;
  downloadCount: number;
};
type Options = {
  beats: AutoStockBeat[];
  stock: Pick<StockLibrary, "search" | "download"> &
    Partial<Pick<StockLibrary, "discard">>;
  provider: StockProvider;
  onProgress?: (progress: AutoStockProgress) => void;
  /** May throw cancellation or a stale-project error; neither is converted to a warning. */
  checkCancelled?: () => void;
  maxDownloads?: number;
  budgetMs?: number;
};

/** Automatic edits avoid licenses with extra share-alike/NC/ND conditions. Manual search retains all licenses. */
export function autoStockLicenseAllowed(
  item: Pick<StockItem, "provider" | "license">,
) {
  const license = item.license.trim().toLowerCase();
  if (item.provider === "pexels") return license === "pexels license";
  if (
    /\b(nc|nd|sa)\b|non.?commercial|no.?deriv|share.?alike|fair use|copyrighted|all rights/.test(
      license,
    )
  )
    return false;
  return /^(cc0(?:\b|\s)|public domain\b|pdm\b|cc\s+by(?:\s+\d(?:\.\d)?(?:\s|$)|$))/.test(
    license,
  );
}

/** A subject/action match must be supported by provider metadata, never a creator or requested reason. */
export function rankAutoStock(item: StockItem, beat: AutoStockBeat): number {
  if (
    !autoStockLicenseAllowed(item) ||
    item.size > 50 * 1024 * 1024 ||
    item.width < 480 ||
    item.height < 480
  )
    return 0;
  if (
    item.kind === "video" &&
    (!Number.isFinite(item.duration) ||
      item.duration < Math.min(1.5, beat.durationSeconds) ||
      item.duration > 240)
  )
    return 0;
  const query = stockKeywords(beat.query);
  if (!query.length) return 0;
  const actionKeys = [
    ...new Set(
      (
        beat.actions ??
        stockWords(beat.query).map(stockActionKey).filter(Boolean)
      ).flatMap(stockKeywords),
    ),
  ];
  const subjects = [
    ...new Set(
      (
        beat.subjects ?? query.filter((key) => !actionKeys.includes(key))
      ).flatMap(stockKeywords),
    ),
  ];
  if (!subjects.length) return 0;
  const required = [...subjects, ...actionKeys.map((key) => `@action:${key}`)];
  const title = new Set(stockKeywords(item.title));
  const clauses = visualMetadataClauses(item.title, item.description);
  let matching = clauses.filter((clause) =>
    required.every((key) => clause.has(key)),
  );
  if (!matching.length) return 0;
  // Topic-keyword coincidences in posters, charts, maps or screenshots are not
  // suitable camera cutaways unless the spoken topic explicitly requests them.
  const illustrative = [
    "logo",
    "diagram",
    "poster",
    "screenshot",
    "chart",
    "map",
    "cover",
    "advertisement",
    "icon",
    "illustration",
    "portrait",
    "album",
  ];
  if (illustrative.some((key) => title.has(key) && !query.includes(key)))
    return 0;
  matching = matching.filter(
    (clause) =>
      !illustrative.some((key) => clause.has(key) && !query.includes(key)),
  );
  if (!matching.length) return 0;
  const keywords = [...new Set(beat.keywords.flatMap(stockKeywords))].slice(
    0,
    10,
  );
  const metadata = matching.sort(
    (a, b) =>
      keywords.filter((key) => b.has(key)).length -
      keywords.filter((key) => a.has(key)).length,
  )[0];
  const queryCoverage =
    query.filter((key) => metadata.has(key)).length / query.length;
  const keywordCoverage = keywords.length
    ? keywords.filter((key) => metadata.has(key)).length / keywords.length
    : queryCoverage;
  const titleMatch = visualMetadataClauses(item.title).some((clause) =>
    required.every((key) => clause.has(key)),
  );
  // A description can name one step in a long routine without saying when it
  // happens. We have no verified action timestamps and must not assume its
  // opening seconds show that step. Prefer a precise short shot or photo.
  if (item.kind === "video" && actionKeys.length) {
    if (/\b(compilation|montage|highlights|miscellany)\b/i.test(item.title))
      return 0;
    if (
      !titleMatch &&
      (item.duration > 20 ||
        /\b(routine|journey|results|observations)\b/i.test(item.title))
    )
      return 0;
  }
  const relevance =
    0.64 +
    queryCoverage * 0.12 +
    keywordCoverage * 0.08 +
    (titleMatch ? 0.055 : 0) +
    (actionKeys.length ? 0.035 : 0);
  const portrait = item.height >= item.width ? 0.025 : 0;
  const resolution =
    Math.min(1, Math.min(item.width, item.height) / 1080) * 0.025;
  const durationFit =
    item.kind === "image" || item.duration >= beat.durationSeconds + 0.5
      ? 0.02
      : 0;
  return Math.min(1, relevance + portrait + resolution + durationFit);
}

function stockIdentity(item: StockItem): string {
  return item.page.replace(/[?#].*$/, "").replace(/\/$/, "");
}
function titleIdentity(item: StockItem): string {
  const keys = stockKeywords(item.title).sort();
  return keys.length >= 2 ? keys.join(":") : "";
}
/** Broader provider retrieval is allowed; the original subject/action gate never changes. */
function searchQueries(beat: AutoStockBeat): string[] {
  const subjectKeys = (beat.subjects ?? []).flatMap(stockKeywords);
  return [
    ...new Set(
      [beat.query, ...(beat.searchQueries ?? [])].map((query) =>
        query.trim().slice(0, 150),
      ),
    ),
  ]
    .filter(
      (query) =>
        query && subjectKeys.every((key) => stockKeywords(query).includes(key)),
    )
    .slice(0, 2);
}

class StockBudgetError extends Error {}

/** Reads are bounded even when a provider is slow. Any read already in flight remains capped by StockLibrary's timeout. */
function checkedWait<T>(
  promise: Promise<T>,
  deadline: number,
  check: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle();
    };
    const inspect = () => {
      try {
        check();
        if (Date.now() >= deadline)
          throw new StockBudgetError("Stock search time budget reached.");
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      timer = setTimeout(inspect, 200);
    };
    let timer: ReturnType<typeof setTimeout>;
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    inspect();
  });
}

/** Returns local assets and edit placements; only the caller may commit them to a project. */
export async function acquireAutoStock(
  options: Options,
): Promise<AutoStockResult> {
  const { stock, provider, onProgress } = options;
  const interruptionErrors = new Set<unknown>();
  const discard = (asset: Asset) => void stock.discard?.(asset).catch(() => {});
  const check = () => {
    try {
      options.checkCancelled?.();
    } catch (error) {
      interruptionErrors.add(error);
      // Nothing downloaded so far will reach a project; delete it again.
      result.assets.splice(0).forEach(discard);
      throw error;
    }
  };
  const maxDownloads = Math.max(
    0,
    Math.min(6, Math.floor(options.maxDownloads ?? 4)),
  );
  const budgetMs = Math.max(1000, Math.min(120000, options.budgetMs ?? 90000));
  const deadline = Date.now() + budgetMs;
  const beats = options.beats
    .filter(
      (beat) =>
        typeof beat.query === "string" &&
        Array.isArray(beat.keywords) &&
        Number.isFinite(beat.startSeconds) &&
        beat.startSeconds >= 0 &&
        Number.isFinite(beat.durationSeconds) &&
        beat.durationSeconds >= 0.5,
    )
    .slice(0, 6);
  const result: AutoStockResult = {
    assets: [],
    placements: [],
    warnings: [],
    searchCount: 0,
    downloadCount: 0,
  };
  const used = new Set<string>(),
    usedPages = new Set<string>(),
    usedTitles = new Set<string>();
  check();
  if (!maxDownloads || !beats.length) return result;
  const notify = (message: string, index: number) => {
    check();
    onProgress?.({
      message,
      progress: Math.min(1, index / beats.length),
      beatIndex: index,
      beatCount: beats.length,
    });
  };
  for (
    let index = 0;
    index < beats.length && result.downloadCount < maxDownloads;
    index++
  ) {
    check();
    const beat = beats[index];
    if (!stockKeywords(beat.query).length) {
      result.warnings.push(
        `No concrete visual subject was found for “${beat.query}”; the original footage was kept.`,
      );
      continue;
    }
    let candidate: StockItem | undefined;
    let providerFailed = false;
    searchKinds: for (const kind of ["video", "image"] as StockKind[])
      for (const query of searchQueries(beat)) {
        check();
        if (Date.now() >= deadline || result.searchCount >= 18) {
          result.warnings.push(
            "Stock search reached its time limit. The remaining sections keep your original footage.",
          );
          notify("Keeping your remaining footage", index);
          return result;
        }
        notify(
          `Finding ${kind === "video" ? "B-roll" : "a photo"} for “${beat.query}”…`,
          index,
        );
        try {
          result.searchCount++;
          const found = await checkedWait(
            stock.search(query, 0, { provider, kind, orientation: "all" }),
            deadline,
            check,
          );
          check();
          candidate = (found.items ?? found.videos)
            .slice(0, 24)
            .filter(
              (item) =>
                item.provider === provider &&
                item.kind === kind &&
                !used.has(item.key) &&
                !usedPages.has(stockIdentity(item)) &&
                (!titleIdentity(item) || !usedTitles.has(titleIdentity(item))),
            )
            .map((item) => ({ item, score: rankAutoStock(item, beat) }))
            .filter((value) => value.score > 0)
            .sort(
              (a, b) => b.score - a.score || a.item.size - b.item.size,
            )[0]?.item;
        } catch (error) {
          if (interruptionErrors.has(error)) throw error;
          check();
          if (error instanceof StockBudgetError) {
            result.warnings.push(
              "Stock search reached its time limit. The remaining sections keep your original footage.",
            );
            return result;
          }
          result.warnings.push(
            `Could not search stock for “${beat.query}”: ${(error as Error).message}`,
          );
          providerFailed = true;
          break searchKinds;
        }
        if (candidate) break searchKinds;
      }
    if (!candidate) {
      if (!providerFailed)
        result.warnings.push(
          `No clearly relevant stock match for “${beat.query}”; the original footage was kept.`,
        );
      continue;
    }
    check();
    if (Date.now() >= deadline) {
      result.warnings.push(
        "Stock search reached its time limit. The remaining sections keep your original footage.",
      );
      return result;
    }
    notify(
      `Adding ${candidate.kind === "image" ? "photo" : "B-roll"}: ${candidate.title}`,
      index,
    );
    let unused: Asset | undefined;
    try {
      // Root cancellation closes the StockLibrary download/import child jobs.
      // Downloads retain their own byte/time guards; never abandon an active write at the search deadline.
      const asset = await stock.download(
        candidate.id,
        candidate.provider,
        candidate.kind,
      );
      unused = asset;
      check();
      if (!asset.origin)
        throw Error("Downloaded stock is missing source credits.");
      const durationSeconds = Math.min(
        beat.durationSeconds,
        asset.kind === "image" ? beat.durationSeconds : asset.duration,
      );
      if (durationSeconds < 0.5)
        throw Error("The downloaded clip is too short.");
      used.add(candidate.key);
      usedPages.add(stockIdentity(candidate));
      if (titleIdentity(candidate)) usedTitles.add(titleIdentity(candidate));
      result.assets.push(asset);
      unused = undefined;
      result.downloadCount++;
      result.placements.push({
        assetId: asset.id,
        startSeconds: beat.startSeconds,
        durationSeconds,
        query: beat.query,
      });
    } catch (error) {
      if (unused) discard(unused);
      if (interruptionErrors.has(error)) throw error;
      check();
      result.warnings.push(
        `Could not add “${candidate.title}”: ${(error as Error).message}`,
      );
    }
  }
  notify(
    result.downloadCount
      ? `${result.downloadCount} relevant stock cutaway${result.downloadCount === 1 ? "" : "s"} ready`
      : "Your original footage is ready",
    beats.length,
  );
  return result;
}
