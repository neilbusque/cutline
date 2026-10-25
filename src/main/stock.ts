import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  StockItem,
  StockResults,
  StockProvider,
  StockKind,
  StockOrientation,
  StockSearchOptions,
  StockQuota,
} from "../shared/stock";
import type { Jobs, Media } from "./media";
import type { Asset } from "../shared/model";

const agent = {
  "User-Agent":
    "Cutline/0.3 (local video editor; user-initiated stock media search)",
};
const downloadLimit = 200 * 1024 * 1024;
const cacheLifetime = 24 * 60 * 60 * 1000;
const pageSize = 18;
const commonsHosts = ["upload.wikimedia.org", "thumb.wikimedia.org"];
const pexelsHosts = [
  "images.pexels.com",
  "videos.pexels.com",
  "static-videos.pexels.com",
];
export function stockUrl(
  value: string,
  kind: "media" | "page" = "media",
  provider?: StockProvider,
) {
  const u = new URL(value);
  let allowed = false;
  if (kind === "page")
    allowed =
      ((!provider || provider === "commons") &&
        u.hostname === "commons.wikimedia.org") ||
      ((!provider || provider === "pexels") &&
        ["www.pexels.com", "pexels.com"].includes(u.hostname)) ||
      ((!provider || provider === "openverse") &&
        [
          "openverse.org",
          "www.flickr.com",
          "flickr.com",
          "commons.wikimedia.org",
          "freesound.org",
          "www.freesound.org",
        ].includes(u.hostname));
  else
    allowed =
      ((!provider || provider === "commons") &&
        commonsHosts.includes(u.hostname)) ||
      ((!provider || provider === "pexels") &&
        (pexelsHosts.includes(u.hostname) ||
          (u.hostname === "player.vimeo.com" &&
            u.pathname.startsWith("/external/")) ||
          u.hostname.endsWith(".vimeocdn.com"))) ||
      ((!provider || provider === "openverse") &&
        ([
          "live.staticflickr.com",
          "farm1.staticflickr.com",
          "farm2.staticflickr.com",
          "farm3.staticflickr.com",
          "farm4.staticflickr.com",
          "farm5.staticflickr.com",
          "farm6.staticflickr.com",
          "farm7.staticflickr.com",
          "farm8.staticflickr.com",
          "farm9.staticflickr.com",
          "upload.wikimedia.org",
          "thumb.wikimedia.org",
          "cdn.freesound.org",
        ].includes(u.hostname) ||
          (u.hostname === "api.openverse.org" &&
            /^\/v1\/images\/[0-9a-f-]{36}\/thumb\/$/i.test(u.pathname))));
  if (u.protocol !== "https:" || !allowed || u.username || u.password || u.port)
    throw Error("Unexpected stock media address");
  return u.toString();
}
export const plain = (text: unknown) =>
  String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim()
    .slice(0, 1000);
const itemKey = (
  provider: StockProvider,
  kind: StockKind,
  id: number | string,
) => `${provider}:${kind}:${id}`;
const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
export function matchesOrientation(
  width: number,
  height: number,
  orientation: StockOrientation,
) {
  if (orientation === "all") return true;
  if (orientation === "square") return Math.abs(width / height - 1) < 0.08;
  return orientation === "portrait"
    ? height > width * 1.08
    : width > height * 1.08;
}
export function normalizeStockSearch(
  query: string,
  offset: number,
  options: StockSearchOptions,
) {
  if (typeof query !== "string" || !query.trim() || query.trim().length > 200)
    throw Error("Enter a stock search between 1 and 200 characters.");
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
    throw Error("Invalid search page.");
  const { provider = "commons", kind = "video", orientation = "all" } = options;
  if (
    !["commons", "pexels", "openverse"].includes(provider) ||
    !["image", "video", "audio"].includes(kind) ||
    !["all", "portrait", "landscape", "square"].includes(orientation)
  )
    throw Error("Invalid stock search filters.");
  if (provider === "openverse" && kind === "video")
    throw Error(
      "Openverse provides photos and audio. Choose one of those types.",
    );
  if (provider !== "openverse" && kind === "audio")
    throw Error("Choose Openverse to search audio.");
  return { query: query.trim(), offset, provider, kind, orientation };
}

/** Search registration is main-owned; downloads can only select a returned result. */
export class StockLibrary {
  private items = new Map<string, StockItem>();
  private cache = new Map<string, { at: number; result: StockResults }>();
  private pending = new Map<string, Promise<StockResults>>();
  private quota: StockQuota | undefined;
  private rateLimitedUntil = 0;
  private lastKey: string | undefined;
  constructor(
    private folder: string,
    private media: Media,
    private jobs: Jobs,
    private getPexelsKey: () => Promise<string | undefined> = async () =>
      undefined,
  ) {}

  async search(
    query: string,
    offset = 0,
    options: StockSearchOptions = {},
  ): Promise<StockResults> {
    const filters = normalizeStockSearch(query, offset, options);
    const { provider, kind, orientation } = filters;
    let apiKey: string | undefined;
    if (provider === "pexels") {
      apiKey = await this.getPexelsKey();
      if (!apiKey)
        throw Error(
          "Connect your Pexels API key in Settings to search Pexels. Wikimedia Commons works without a key.",
        );
      if (apiKey !== this.lastKey) {
        for (const key of this.cache.keys())
          if (key.startsWith("pexels:")) this.cache.delete(key);
        this.lastKey = apiKey;
        this.quota = undefined;
        this.rateLimitedUntil = 0;
      }
    }
    const cacheKey = `${provider}:${kind}:${orientation}:${filters.query.toLowerCase()}:${offset}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < cacheLifetime) {
      for (const item of cached.result.items) this.remember(item);
      return structuredClone({
        ...cached.result,
        quota: provider === "pexels" ? this.quota : undefined,
        cached: true,
      });
    }
    const existing = this.pending.get(cacheKey);
    if (existing) return structuredClone(await existing);
    if (
      provider === "pexels" &&
      (this.rateLimitedUntil > Date.now() ||
        (this.quota?.remaining === 0 &&
          (!this.quota.resetAt || this.quota.resetAt > Date.now())))
    )
      throw Error(this.quotaMessage());
    const request = (
      provider === "commons"
        ? this.searchCommons(filters.query, offset, kind, orientation)
        : provider === "openverse"
          ? this.searchOpenverse(filters.query, offset, kind, orientation)
          : this.searchPexels(filters.query, offset, kind, orientation, apiKey!)
    )
      .then((result) => {
        for (const item of result.items) this.remember(item);
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, { at: Date.now(), result });
        while (this.cache.size > 150)
          this.cache.delete(this.cache.keys().next().value!);
        return result;
      })
      .catch((error) => {
        if (error?.name === "TimeoutError" || error?.name === "AbortError")
          throw Error("Stock search timed out. Try again.");
        if (error instanceof TypeError)
          throw Error(
            "Could not reach the stock provider. Check your connection and retry.",
          );
        throw error;
      })
      .finally(() => this.pending.delete(cacheKey));
    this.pending.set(cacheKey, request);
    return structuredClone(await request);
  }

  private remember(item: StockItem) {
    this.items.delete(item.key);
    this.items.set(item.key, item);
    while (this.items.size > 3000)
      this.items.delete(this.items.keys().next().value!);
  }

  private async searchCommons(
    query: string,
    offset: number,
    kind: StockKind,
    orientation: StockOrientation,
  ): Promise<StockResults> {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    const prop = kind === "video" ? "videoinfo" : "imageinfo";
    const params: Record<string, string> = {
      action: "query",
      format: "json",
      generator: "search",
      gsrsearch: `${query} filetype:${kind === "video" ? "video" : "bitmap"}`,
      gsrnamespace: "6",
      gsrlimit: String(pageSize),
      gsroffset: String(offset),
      prop,
    };
    if (kind === "video")
      Object.assign(params, {
        viprop: "url|size|mime|extmetadata|derivatives",
        viurlwidth: "480",
      });
    else
      Object.assign(params, {
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: "640",
      });
    url.search = new URLSearchParams(params).toString();
    const response = await fetch(url, {
      headers: agent,
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok)
      throw Error(
        response.status === 429
          ? "Wikimedia search is busy. Please wait a minute and try again."
          : `Wikimedia search unavailable (${response.status}). Try again shortly.`,
      );
    const data = (await response.json()) as any;
    if (data.error)
      throw Error(plain(data.error.info) || "Wikimedia search failed.");
    const items: StockItem[] = [];
    for (const page of Object.values(data.query?.pages ?? {}).sort(
      (a: any, b: any) => a.index - b.index,
    ) as any[]) {
      const info = page[prop]?.[0];
      if (
        !info?.url ||
        !positive(page.pageid) ||
        !positive(info.width) ||
        !positive(info.height) ||
        !matchesOrientation(info.width, info.height, orientation)
      )
        continue;
      if (kind === "video" && !positive(info.duration)) continue;
      if (
        kind === "image" &&
        !/^image\/(jpeg|png|webp|gif)$/.test(info.mime ?? "")
      )
        continue;
      const metadata = info.extmetadata ?? {};
      try {
        const original = stockUrl(info.url, "media", "commons");
        const derivatives = (info.derivatives ?? [])
          .filter(
            (value: any) =>
              /video\/(webm|mp4)/.test(value.type ?? "") &&
              positive(value.width) &&
              value.width <= 1280,
          )
          .sort((a: any, b: any) => b.width - a.width);
        const item: StockItem = {
          id: page.pageid,
          key: itemKey("commons", kind, page.pageid),
          provider: "commons",
          kind,
          title: plain(
            metadata.ObjectName?.value || page.title.replace(/^File:/, ""),
          ),
          description: plain(metadata.ImageDescription?.value || "").slice(
            0,
            2400,
          ),
          creator: plain(metadata.Artist?.value || "See source page"),
          license: plain(
            metadata.LicenseShortName?.value || "Review source license",
          ),
          licenseUrl: plain(metadata.LicenseUrl?.value || ""),
          page: stockUrl(info.descriptionurl, "page", "commons"),
          thumbnail: info.thumburl
            ? stockUrl(info.thumburl, "media", "commons")
            : "",
          url: original,
          preview:
            kind === "image"
              ? original
              : derivatives[0]
                ? stockUrl(derivatives[0].src, "media", "commons")
                : original,
          duration: kind === "video" ? info.duration : 4,
          width: info.width,
          height: info.height,
          size: positive(info.size) ? info.size : 0,
        };
        items.push(item);
      } catch {
        /* Discard malformed or unexpected provider URLs. */
      }
    }
    const next = data.continue?.gsroffset;
    return {
      items,
      videos: items,
      provider: "commons",
      kind,
      ...(Number.isInteger(next) && next > offset ? { next } : {}),
    };
  }

  private async searchPexels(
    query: string,
    offset: number,
    kind: StockKind,
    orientation: StockOrientation,
    key: string,
  ): Promise<StockResults> {
    const page = offset + 1;
    const url = new URL(
      kind === "image"
        ? "https://api.pexels.com/v1/search"
        : "https://api.pexels.com/v1/videos/search",
    );
    url.search = new URLSearchParams({
      query,
      page: String(page),
      per_page: String(pageSize),
      ...(orientation === "all" ? {} : { orientation }),
    }).toString();
    const response = await fetch(url, {
      headers: { ...agent, Authorization: key },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403)
      throw Error("Pexels rejected your API key. Check the key in Settings.");
    if (response.status === 429) {
      const retrySeconds = Number(response.headers.get("retry-after"));
      this.rateLimitedUntil =
        Date.now() +
        Math.max(
          60,
          Number.isFinite(retrySeconds) ? Math.min(3600, retrySeconds) : 60,
        ) *
          1000;
      throw Error(this.quotaMessage());
    }
    if (!response.ok)
      throw Error(
        `Pexels search unavailable (${response.status}). Try again shortly.`,
      );
    const quotaValue = (name: string) => {
      const raw = response.headers.get(name);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const reset = quotaValue("x-ratelimit-reset");
    this.quota = {
      limit: quotaValue("x-ratelimit-limit"),
      remaining: quotaValue("x-ratelimit-remaining"),
      resetAt: reset === undefined ? undefined : reset * 1000,
    };
    const data = (await response.json()) as any;
    const items: StockItem[] = [];
    const entries = kind === "image" ? data.photos : data.videos;
    if (!Array.isArray(entries))
      throw Error("Pexels returned an unexpected response. Try again.");
    for (const entry of entries) {
      if (
        !positive(entry.id) ||
        !positive(entry.width) ||
        !positive(entry.height) ||
        !matchesOrientation(entry.width, entry.height, orientation)
      )
        continue;
      try {
        let url: string,
          preview: string,
          width = entry.width,
          height = entry.height;
        if (kind === "image") {
          url = stockUrl(entry.src?.original, "media", "pexels");
          preview = stockUrl(
            entry.src?.large2x || entry.src?.large || entry.src?.original,
            "media",
            "pexels",
          );
        } else {
          if (!positive(entry.duration)) continue;
          const files = (entry.video_files ?? [])
            .filter(
              (file: any) =>
                file.file_type === "video/mp4" &&
                positive(file.width) &&
                positive(file.height) &&
                file.quality !== "hls",
            )
            .flatMap((file: any) => {
              try {
                return [
                  { ...file, link: stockUrl(file.link, "media", "pexels") },
                ];
              } catch {
                return [];
              }
            });
          // Prefer a full-HD-or-smaller original, avoiding accidental 4K downloads.
          files.sort(
            (a: any, b: any) => a.width * a.height - b.width * b.height,
          );
          const suitable = files.filter(
            (file: any) => Math.max(file.width, file.height) <= 1920,
          );
          const chosen = suitable.at(-1) || files[0];
          if (!chosen) continue;
          url = chosen.link;
          width = chosen.width;
          height = chosen.height;
          preview = (
            files.find(
              (file: any) => Math.max(file.width, file.height) >= 640,
            ) || chosen
          ).link;
        }
        const title = plain(
          entry.alt ||
            entry.url
              ?.split("/")
              .filter(Boolean)
              .at(-1)
              ?.replace(/-\d+$/, "")
              .replace(/-/g, " ") ||
            `Stock ${kind === "image" ? "photo" : "video"}`,
        );
        items.push({
          id: entry.id,
          key: itemKey("pexels", kind, entry.id),
          provider: "pexels",
          kind,
          title,
          description: plain(entry.alt || "").slice(0, 2400),
          creator:
            plain(kind === "image" ? entry.photographer : entry.user?.name) ||
            "Pexels contributor",
          license: "Pexels License",
          licenseUrl: "https://www.pexels.com/license/",
          page: stockUrl(entry.url, "page", "pexels"),
          thumbnail: stockUrl(
            kind === "image"
              ? entry.src?.medium || entry.src?.small || entry.src?.original
              : entry.image,
            "media",
            "pexels",
          ),
          url,
          preview,
          duration: kind === "video" ? entry.duration : 4,
          width,
          height,
          size: 0,
        });
      } catch {
        /* Untrusted API metadata never becomes a request address. */
      }
    }
    const hasNext =
      typeof data.next_page === "string" ||
      (positive(data.total_results) && page * pageSize < data.total_results);
    return {
      items,
      videos: items,
      provider: "pexels",
      kind,
      quota: this.quota,
      ...(hasNext ? { next: offset + 1 } : {}),
    };
  }

  /** Openverse indexes images and audio, not stock video. Only vetted source hosts are used. */
  private async searchOpenverse(
    query: string,
    offset: number,
    kind: StockKind,
    orientation: StockOrientation,
  ): Promise<StockResults> {
    const endpoint = kind === "audio" ? "audio" : "images";
    const url = new URL(`https://api.openverse.org/v1/${endpoint}/`);
    url.search = new URLSearchParams({
      q: query,
      page: String(offset + 1),
      page_size: String(pageSize),
      license_type: "commercial,modification",
      source: kind === "audio" ? "freesound" : "flickr,wikimedia",
      mature: "false",
    }).toString();
    const response = await fetch(url, {
      headers: agent,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!response.ok)
      throw Error(
        response.status === 429
          ? "Openverse request limit reached. Wait a minute and try again."
          : `Openverse search unavailable (${response.status}). Try again shortly.`,
      );
    const data = (await response.json()) as any;
    const items: StockItem[] = [];
    for (const entry of Array.isArray(data.results) ? data.results : []) {
      // Recheck the license even if the API's filters change or return a malformed result.
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          entry.id ?? "",
        ) ||
        !["cc0", "pdm", "by", "by-sa"].includes(entry.license) ||
        entry.mature === true
      )
        continue;
      if (
        kind === "image" &&
        (!positive(entry.width) ||
          !positive(entry.height) ||
          !matchesOrientation(entry.width, entry.height, orientation))
      )
        continue;
      if (kind === "audio" && !positive(entry.duration)) continue;
      try {
        const media = stockUrl(entry.url, "media", "openverse");
        const license = new URL(entry.license_url);
        if (
          license.protocol !== "https:" ||
          license.hostname !== "creativecommons.org" ||
          license.username ||
          license.password ||
          license.port
        )
          continue;
        const thumbnail =
          kind === "image"
            ? stockUrl(entry.thumbnail || media, "media", "openverse")
            : "";
        const title = plain(entry.title) || "Untitled Openverse media";
        items.push({
          id: entry.id,
          key: itemKey("openverse", kind, entry.id),
          provider: "openverse",
          kind,
          title,
          description: plain(entry.description || ""),
          creator: plain(entry.creator) || "See source page",
          attribution: plain(entry.attribution),
          license:
            entry.license === "cc0"
              ? "CC0"
              : entry.license === "pdm"
                ? "Public Domain Mark"
                : `CC ${entry.license.toUpperCase()} ${plain(entry.license_version)}`.trim(),
          licenseUrl: license.toString(),
          page: stockUrl(entry.foreign_landing_url, "page", "openverse"),
          thumbnail,
          url: media,
          preview: media,
          duration: kind === "audio" ? entry.duration / 1000 : 4,
          width: kind === "audio" ? 0 : entry.width,
          height: kind === "audio" ? 0 : entry.height,
          size: positive(entry.filesize) ? entry.filesize : 0,
        });
      } catch {
        /* Unsupported source hosts never become requests. */
      }
    }
    return {
      items,
      videos: items,
      provider: "openverse",
      kind,
      ...(Number.isInteger(data.page_count) && offset + 1 < data.page_count
        ? { next: offset + 1 }
        : {}),
    };
  }

  private quotaMessage() {
    const reset = this.quota?.resetAt;
    return `Pexels request limit reached.${reset && reset > Date.now() ? ` Your quota resets ${new Date(reset).toLocaleString()}.` : " Wait a little before trying again."} You can continue searching Wikimedia Commons.`;
  }

  private async mediaResponse(
    item: StockItem,
    signal: AbortSignal,
  ): Promise<Response> {
    let url = item.url;
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await fetch(stockUrl(url, "media", item.provider), {
        headers: agent,
        signal,
        redirect: "manual",
      });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 4)
        throw Error(
          "The stock download redirected too many times. Choose another result.",
        );
      url = stockUrl(new URL(location, url).toString(), "media", item.provider);
    }
    throw Error("Stock download failed.");
  }

  /** Deletes a download that never made it into a project, with its credits file. */
  async discard(asset: Pick<Asset, "path">) {
    const file = path.resolve(asset.path);
    if (path.dirname(file) !== path.resolve(this.folder)) return;
    await Promise.all([
      unlink(file).catch(() => {}),
      unlink(file + ".credits.txt").catch(() => {}),
    ]);
  }

  async download(
    id: number | string,
    provider: StockProvider = "commons",
    kind: StockKind = "video",
  ): Promise<Asset> {
    const item = this.items.get(itemKey(provider, kind, id));
    if (!item) throw Error("Search for this media again before downloading.");
    if (item.size > downloadLimit)
      throw Error(
        "This original is over 200 MB. Choose a smaller result or open its source page.",
      );
    await mkdir(this.folder, { recursive: true });
    const sourceExtension = path
      .extname(new URL(item.url).pathname)
      .toLowerCase();
    const extension = (kind === "image"
      ? [".jpg", ".jpeg", ".png", ".webp", ".gif"]
      : kind === "audio"
        ? [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"]
        : [".mp4", ".webm", ".ogv", ".ogg", ".mov"]
    ).includes(sourceExtension)
      ? sourceExtension
      : kind === "image"
        ? ".jpg"
        : kind === "audio"
          ? ".mp3"
          : ".mp4";
    const file = path.join(
        this.folder,
        `${provider}-${kind}-${id}-${randomUUID()}${extension}`,
      ),
      temporary = file + ".part";
    return this.jobs.run(
      "stock",
      `Downloading ${kind === "image" ? "stock photo" : kind === "audio" ? "stock audio" : "B-roll"}…`,
      async (job) => {
        // The time limit covers the network download only. Preparing a large
        // clip for editing afterwards can take minutes and is cancellable.
        const controller = new AbortController(),
          timeout = setTimeout(() => controller.abort(), 180000);
        this.jobs.cancellers.set(job.id, () => controller.abort());
        const stopped = () =>
          job.state === "cancelled"
            ? "Download cancelled"
            : "Stock download timed out. Try a smaller result.";
        try {
          const response = await this.mediaResponse(item, controller.signal);
          if (!response.ok || !response.body)
            throw Error(
              `Download failed (${response.status}). Try another result.`,
            );
          const contentType = (response.headers.get("content-type") || "")
            .split(";")[0]
            .toLowerCase();
          if (
            contentType &&
            contentType !== "application/octet-stream" &&
            !(
              kind === "image"
                ? /^image\/(jpeg|png|webp|gif)$/
                : kind === "audio"
                  ? /^(audio\/(mpeg|mp3|wav|x-wav|wave|ogg|flac|x-flac|mp4|aac)|application\/ogg)$/
                  : /^(video\/(mp4|webm|ogg|quicktime)|application\/ogg)$/
            ).test(contentType)
          )
            throw Error(
              "The provider returned an unsupported media file. Choose another result.",
            );
          const total =
            Number(response.headers.get("content-length")) || item.size;
          if (total > downloadLimit)
            throw Error("Media exceeds the 200 MB download limit.");
          const handle = await open(temporary, "wx");
          let received = 0;
          try {
            for await (const chunk of response.body as any) {
              received += chunk.length;
              if (received > downloadLimit)
                throw Error("Media exceeds the 200 MB download limit.");
              // writeFile handles partial filesystem writes before accepting the next chunk.
              await handle.writeFile(chunk);
              this.jobs.update(job, {
                progress:
                  total > 0 ? Math.min(0.9, (received / total) * 0.9) : 0.1,
                message: `Downloading ${Math.round(received / 1024 / 1024)} MB…`,
              });
            }
          } finally {
            await handle.close();
          }
          clearTimeout(timeout);
          if (controller.signal.aborted) throw Error(stopped());
          if (received === 0)
            throw Error(
              "The provider returned an empty media file. Choose another result.",
            );
          await rename(temporary, file);
          this.jobs.update(job, {
            message: "Preparing media for editing…",
            progress: 0.92,
          });
          const asset = await this.media.import(file);
          if (job.state === "cancelled") throw Error("Download cancelled");
          if (asset.kind !== kind)
            throw Error(
              "The downloaded file does not match the selected media type.",
            );
          asset.name = item.title + extension;
          asset.origin = {
            provider:
              provider === "pexels"
                ? "Pexels"
                : provider === "openverse"
                  ? "Openverse"
                  : "Wikimedia Commons",
            page: item.page,
            creator: item.creator,
            license: item.license,
            licenseUrl: item.licenseUrl,
            title: item.title,
          };
          await writeFile(
            file + ".credits.txt",
            `${item.title}\nCreator: ${item.creator}\nProvider: ${asset.origin.provider}\nSource: ${item.page}\nLicense: ${item.license}\n${item.licenseUrl}\n${item.attribution ? `Attribution: ${item.attribution}\n` : ""}`,
          );
          return asset;
        } catch (error) {
          controller.abort();
          await Promise.all([
            unlink(temporary).catch(() => {}),
            unlink(file).catch(() => {}),
            unlink(file + ".credits.txt").catch(() => {}),
          ]);
          if (
            job.state === "cancelled" ||
            (error as Error).name === "AbortError" ||
            (error as Error).name === "TimeoutError"
          )
            throw Error(stopped());
          throw error;
        } finally {
          clearTimeout(timeout);
          this.jobs.cancellers.delete(job.id);
        }
      },
    );
  }
}
