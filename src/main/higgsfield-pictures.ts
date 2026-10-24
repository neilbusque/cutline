import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { liftFromBackdrop } from "../shared/cutout";
import {
  pictureRequest,
  type PictureRequest,
  type PictureResult,
} from "../shared/graphics";
import { higgsfieldCall, providerMedia } from "./generation";

const MAX_PICTURE = 25 * 1024 * 1024;
const status = z.enum([
  "queued",
  "in_progress",
  "completed",
  "failed",
  "nsfw",
  "canceled",
]);
type Entry = {
  id: string;
  endpoint: string;
  body: Record<string, unknown>;
  account: string;
  status: "submitting" | z.infer<typeof status>;
  createdAt: number;
  requestId?: string;
  file?: string;
  error?: string;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Error("Cancelled"));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(Error("Cancelled"));
    }
    signal?.addEventListener("abort", stop, { once: true });
  });

/**
 * Pictures from Higgsfield's Recraft model for graphics too detailed to draw
 * as vectors. Every paid request is written to pictures.json before it is
 * sent, with its idempotency key, so a retry never pays twice.
 */
export class HiggsfieldPictures {
  private entries: Entry[] = [];
  private file: string;
  private estimates = new Map<string, Promise<string | undefined>>();
  constructor(
    private folder: string,
    private getKey: () => Promise<string | undefined>,
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private wait = sleep,
  ) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.file = path.join(folder, "pictures.json");
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(saved)) this.entries = saved;
    } catch {
      /* No pictures yet. */
    }
  }
  private persist() {
    const temporary = this.file + ".tmp";
    writeFileSync(temporary, JSON.stringify(this.entries.slice(-200), null, 2), {
      mode: 0o600,
    });
    renameSync(temporary, this.file);
  }

  /** Higgsfield's price for this request in US dollars, when it answers. */
  estimate(request: PictureRequest) {
    const { endpoint, body } = pictureRequest(request);
    const id = `${endpoint} ${body.aspect_ratio}`;
    if (!this.estimates.has(id))
      this.estimates.set(
        id,
        this.getKey()
          .then((key) =>
            key
              ? higgsfieldCall(this.fetcher, `estimate/${endpoint}`, key, body)
              : undefined,
          )
          .then((answer) =>
            typeof answer?.usd === "string" || typeof answer?.usd === "number"
              ? String(answer.usd)
              : undefined,
          )
          .catch(() => {
            this.estimates.delete(id);
            return undefined;
          }),
      );
    return this.estimates.get(id)!;
  }

  async generate(
    request: PictureRequest,
    signal?: AbortSignal,
  ): Promise<PictureResult> {
    const key = await this.getKey();
    if (!key) throw Error("Connect Higgsfield in Settings to make pictures.");
    const { endpoint, body } = pictureRequest(request);
    const entry: Entry = {
      id: randomUUID(),
      endpoint,
      body,
      account: createHash("sha256").update(key).digest("hex"),
      status: "submitting",
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    this.persist();
    const usd = this.estimate(request);
    try {
      let result = await higgsfieldCall(this.fetcher, endpoint, key, body, entry.id);
      entry.requestId = z.string().uuid().parse(result.request_id);
      entry.status = status.catch("queued").parse(result.status);
      this.persist();
      const deadline = Date.now() + 5 * 60 * 1000;
      for (let delay = 1500; entry.status !== "completed"; ) {
        if (entry.status === "failed")
          throw Error("Higgsfield could not make this picture. Try again or reword it.");
        if (entry.status === "nsfw")
          throw Error("Higgsfield declined this picture under its content policy. Reword it.");
        if (entry.status === "canceled") throw Error("Cancelled");
        if (Date.now() > deadline)
          throw Error("Higgsfield is taking too long. Try again in a minute.");
        try {
          await this.wait(delay, signal);
        } catch (error) {
          if (entry.status === "queued")
            await higgsfieldCall(
              this.fetcher,
              `requests/${entry.requestId}/cancel`,
              key,
              {},
            ).catch(() => {});
          throw error;
        }
        delay = Math.min(6000, delay * 1.5);
        result = await higgsfieldCall(
          this.fetcher,
          `requests/${entry.requestId}/status`,
          key,
        );
        entry.status = status.parse(result.status);
      }
      const url = z.string().parse(result.images?.[0]?.url);
      const picture = await this.download(url);
      const sharp = (await import("sharp")).default;
      const { data, info } = await sharp(picture)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const cut = liftFromBackdrop(data, info.width, info.height);
      const file = path.join(this.folder, `${entry.id}.png`);
      await writeFile(
        file,
        await sharp(Buffer.from(cut.pixels.buffer, cut.pixels.byteOffset, cut.pixels.byteLength), {
          raw: { width: cut.width, height: cut.height, channels: 4 },
        })
          .png()
          .toBuffer(),
        { mode: 0o600 },
      );
      entry.file = file;
      entry.error = undefined;
      this.persist();
      return {
        file,
        width: cut.width,
        height: cut.height,
        cutout: cut.ok,
        usd: await usd,
      };
    } catch (error) {
      entry.error = (error as Error).message;
      if (entry.status === "submitting") entry.status = "failed";
      this.persist();
      throw error;
    }
  }

  private async download(url: string) {
    const response = await providerMedia(this.fetcher, url);
    const type = response.headers.get("content-type")?.split(";")[0].trim();
    if (
      type &&
      !type.startsWith("image/") &&
      type !== "application/octet-stream" &&
      type !== "binary/octet-stream"
    ) {
      await response.body?.cancel();
      throw Error("Higgsfield did not return a picture.");
    }
    if (Number(response.headers.get("content-length")) > MAX_PICTURE) {
      await response.body?.cancel();
      throw Error("The picture is larger than Cutline accepts.");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_PICTURE) throw Error("The picture is larger than Cutline accepts.");
      chunks.push(chunk);
    }
    if (!size) throw Error("Higgsfield returned an empty picture.");
    return Buffer.concat(chunks);
  }
}
