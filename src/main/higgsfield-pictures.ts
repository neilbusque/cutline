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
import { higgsfieldCall, ProviderError, providerMedia } from "./generation";

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
  /** The same picture asked for again by the same account. */
  fingerprint?: string;
  /** "unknown": the submit got no answer, so it may have been charged. */
  status: "submitting" | "unknown" | z.infer<typeof status>;
  createdAt: number;
  requestId?: string;
  file?: string;
  error?: string;
};
/** How long an unfinished paid picture can still be picked up. */
const RESUMABLE_MS = 24 * 60 * 60 * 1000;
/** A failure worth asking again about: rate limits, outages, timeouts. */
const transient = (error: unknown) =>
  error instanceof ProviderError
    ? error.status === 429 || error.status >= 500
    : !/Cancelled/u.test((error as Error)?.message ?? "");

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
 * sent, with its idempotency key. Asking for the same picture again while an
 * earlier one is unfinished (a failed status check, the time limit, a quit)
 * picks that one up instead of paying twice; an unanswered submit is sent
 * again with the same key, which Higgsfield charges once.
 */
export class HiggsfieldPictures {
  private entries: Entry[] = [];
  private file: string;
  private estimates = new Map<string, Promise<string | undefined>>();
  /** Pictures being made, by fingerprint: the same one asked twice waits. */
  private running = new Map<string, Promise<PictureResult>>();
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
    if (signal?.aborted) throw Error("Cancelled");
    const { endpoint, body } = pictureRequest(request);
    const account = createHash("sha256").update(key).digest("hex");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([account, endpoint, body]))
      .digest("hex");
    const running = this.running.get(fingerprint);
    if (running) return running;
    const made = this.make(request, key, account, fingerprint, signal);
    this.running.set(fingerprint, made);
    try {
      return await made;
    } finally {
      this.running.delete(fingerprint);
    }
  }

  private async make(
    request: PictureRequest,
    key: string,
    account: string,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<PictureResult> {
    const { endpoint, body } = pictureRequest(request);
    // An unfinished picture asked for before is picked up, not paid again.
    const earlier = [...this.entries].reverse().find(
      (entry) =>
        entry.fingerprint === fingerprint &&
        !entry.file &&
        Date.now() - entry.createdAt < RESUMABLE_MS &&
        (entry.requestId
          ? entry.status === "queued" || entry.status === "in_progress"
          : entry.status === "submitting" || entry.status === "unknown"),
    );
    const entry: Entry = earlier ?? {
      id: randomUUID(),
      endpoint,
      body,
      account,
      fingerprint,
      status: "submitting",
      createdAt: Date.now(),
    };
    if (!earlier) this.entries.push(entry);
    this.persist();
    const usd = this.estimate(request);
    try {
      let result: any = { status: entry.status };
      if (!entry.requestId) {
        try {
          // The idempotency key is the entry's, so sending it again after an
          // unanswered try is charged once.
          result = await higgsfieldCall(this.fetcher, endpoint, key, body, entry.id);
        } catch (error) {
          entry.status =
            error instanceof ProviderError && error.status < 500 ? "failed" : "unknown";
          throw error;
        }
        entry.requestId = z.string().uuid().parse(result.request_id);
        entry.status = status.catch("queued").parse(result.status);
        this.persist();
      }
      const deadline = Date.now() + 5 * 60 * 1000;
      for (let delay = 1500; entry.status !== "completed"; ) {
        if (entry.status === "failed")
          throw Error("Higgsfield could not make this picture. Try again or reword it.");
        if (entry.status === "nsfw")
          throw Error("Higgsfield declined this picture under its content policy. Reword it.");
        if (entry.status === "canceled") throw Error("Cancelled");
        if (Date.now() > deadline) {
          if (entry.status === "queued") {
            await this.cancel(entry, key);
            throw Error("Higgsfield didn't start this picture in five minutes, so Cutline cancelled it. Try again later.");
          }
          throw Error("Higgsfield is still making this picture. Ask for it again in a minute to pick it up; it won't be charged twice.");
        }
        try {
          await this.wait(delay, signal);
        } catch (error) {
          if (entry.status === "queued") await this.cancel(entry, key);
          throw error;
        }
        delay = Math.min(6000, delay * 1.5);
        try {
          result = await higgsfieldCall(
            this.fetcher,
            `requests/${entry.requestId}/status`,
            key,
          );
        } catch (error) {
          // Busy or briefly unreachable: keep asking until the deadline.
          if (transient(error)) {
            delay = Math.min(15000, delay * 2);
            continue;
          }
          throw error;
        }
        const next = status.safeParse(result.status);
        if (next.success && next.data !== entry.status) {
          entry.status = next.data;
          this.persist();
        }
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

  private async cancel(entry: Entry, key: string) {
    await higgsfieldCall(
      this.fetcher,
      `requests/${entry.requestId}/cancel`,
      key,
      {},
    )
      .then(() => {
        entry.status = "canceled";
      })
      .catch(() => {});
    this.persist();
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
