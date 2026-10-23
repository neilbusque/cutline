import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { copyFile, open, readFile, stat, unlink } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import {
  GenerationInputSchema,
  generationRequest,
  type GenerationInput,
  type GenerationJob,
  type GenerationStatus,
} from "../shared/generation";
import type { Media } from "./media";

const API = "https://api.higgsfield.ai/";
const terminal = new Set<GenerationStatus>([
  "completed",
  "failed",
  "nsfw",
  "canceled",
]);
const providerStatus = z.enum([
  "queued",
  "in_progress",
  "completed",
  "failed",
  "nsfw",
  "canceled",
]);
const requestId = z.string().uuid();
const MAX_VIDEO = 512 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
type SavedJob = GenerationJob &
  Pick<GenerationInput, "referenceId" | "referenceIds"> & {
    account: string;
    endpoint?: string;
    body?: Record<string, unknown>;
    referencePath?: string;
    referencePaths?: string[];
    outputUrl?: string;
  };
class ProviderError extends Error {
  constructor(public status: number) {
    super(
      (
        {
          401: "Higgsfield rejected this API key. Reconnect your key.",
          403: "Higgsfield denied this request. Check API credits and account access.",
          404: "This model or request is unavailable to this API account.",
          422: "Higgsfield rejected these generation settings. Check the model parameters.",
          429: "Higgsfield is rate limiting requests. Wait a moment and refresh.",
          423: "Higgsfield is temporarily blocking requests. Check your account dashboard.",
        } as Record<number, string>
      )[status] ??
        `Higgsfield is unavailable (HTTP ${status}). Try refreshing shortly.`,
    );
  }
}
const fingerprint = (key: string) =>
  createHash("sha256").update(key).digest("hex");

/** Provider-issued media URLs only. Reject local/private destinations and redirects. */
export async function publicMediaUrl(value: string, resolve = lookup) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    isIP(u.hostname.replace(/[\[\]]/g, "")) ||
    !u.hostname.includes(".") ||
    /\.(local|localhost|internal|test)$/i.test(u.hostname)
  )
    throw Error("Higgsfield returned an unsupported media address.");
  const addresses = await resolve(u.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => {
      if (address.includes(":"))
        return (
          !/^2[0-9a-f]{3}:/i.test(address) && !/^3[0-9a-f]{3}:/i.test(address)
        );
      const [a, b] = address.split(".").map(Number);
      return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || b === 0)) ||
        (a === 100 && b >= 64 && b <= 127) ||
        a >= 224 ||
        (a === 198 && (b === 18 || b === 19))
      );
    })
  )
    throw Error("Higgsfield returned a non-public media address.");
  return u.toString();
}

export class GenerationLibrary {
  private jobs = new Map<string, SavedJob>();
  private references = new Map<string, { file: string; name: string }>();
  private pending = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private historyError?: string;
  private file: string;
  constructor(
    private folder: string,
    private media: Pick<Media, "import">,
    private getKey: () => Promise<string | undefined>,
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.file = path.join(folder, "jobs.json");
    if (existsSync(this.file)) {
      // Never silently discard the ledger: it contains paid request recovery keys.
      try {
        const saved = JSON.parse(readFileSync(this.file, "utf8"));
        if (!Array.isArray(saved))
          throw Error("The Higgsfield job history could not be read.");
        for (const job of saved) {
          GenerationInputSchema.parse({ ...job, clientId: job.id });
          z.string().uuid().parse(job.id);
          if (job.requestId) requestId.parse(job.requestId);
          if (job.status === "submitting") {
            job.status = "unknown";
            job.error =
              "Cutline closed before this request was confirmed. Recover this same request.";
          }
          this.jobs.set(job.id, job);
        }
        this.persist();
      } catch {
        this.jobs.clear();
        this.historyError =
          "Higgsfield history could not be read. The original jobs.json has been preserved. Restore it from a backup before generating again.";
      }
    }
  }
  start() {
    this.stopped = false;
    const tick = async () => {
      for (const job of this.jobs.values()) {
        if (this.stopped) return;
        if (
          job.requestId &&
          (!terminal.has(job.status) ||
            (job.status === "completed" && !existsSync(this.videoPath(job.id))))
        )
          await this.refresh(job.id).catch(() => {});
      }
      if (!this.stopped) {
        this.timer = setTimeout(tick, 10000);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(tick, 2000);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  list(): GenerationJob[] {
    if (this.historyError) throw Error(this.historyError);
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => this.public(j));
  }
  private public(job: SavedJob): GenerationJob {
    const {
      id,
      projectId,
      prompt,
      model,
      duration,
      aspectRatio,
      resolution,
      audio,
      status,
      createdAt,
      requestId,
      referenceName,
      referenceNames,
      error,
    } = job;
    return {
      id,
      projectId,
      prompt,
      model,
      duration,
      aspectRatio,
      resolution,
      audio,
      status,
      createdAt,
      requestId,
      referenceName,
      referenceNames,
      error,
      downloaded: existsSync(this.videoPath(id)),
    };
  }
  private videoPath(id: string) {
    return path.join(this.folder, `${id}.mp4`);
  }
  private persist() {
    if (this.historyError) throw Error(this.historyError);
    const temporary = this.file + ".tmp";
    writeFileSync(temporary, JSON.stringify([...this.jobs.values()], null, 2), {
      mode: 0o600,
    });
    renameSync(temporary, this.file);
  }
  private get(id: string) {
    const job = this.jobs.get(z.string().uuid().parse(id));
    if (!job) throw Error("Generation not found.");
    return job;
  }
  private async key(job?: SavedJob) {
    const key = await this.getKey();
    if (!key) throw Error("Connect your Higgsfield API key first.");
    if (job && fingerprint(key) !== job.account)
      throw Error(
        "Reconnect the original Higgsfield API key to manage this request.",
      );
    return key;
  }
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    // Serialize unlike actions: a Cancel must actually send cancellation even if
    // a background refresh is already running. Never reuse another action result.
    while (this.pending.has(id)) await this.pending.get(id)!.catch(() => {});
    const promise = work();
    this.pending.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.pending.get(id) === promise) this.pending.delete(id);
    }
  }
  private async api(
    route: string,
    key: string,
    body?: unknown,
    idempotency?: string,
  ) {
    const response = await this.fetcher(API + route, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
        ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new ProviderError(response.status);
    if (response.status === 202 && route.endsWith("/cancel")) return {};
    return await response.json();
  }
  async pickReference(selectedPath: string) {
    const file = path.resolve(selectedPath);
    const info = await stat(file);
    if (
      !info.isFile() ||
      ![".png", ".jpg", ".jpeg", ".webp"].includes(
        path.extname(file).toLowerCase(),
      ) ||
      info.size > MAX_IMAGE ||
      !info.size
    )
      throw Error("Choose a PNG, JPEG or WebP image under 20 MB.");
    await this.readReference(file);
    // Picker IDs identify the selected file, not each click of the chooser.
    // Revalidate first so a changed or deleted file never reuses stale validity.
    for (const [id, selected] of this.references)
      if (selected.file === file) return { id, name: selected.name };
    const id = randomUUID(),
      name = path.basename(file);
    this.references.set(id, { file, name });
    return { id, name };
  }
  async submit(value: unknown): Promise<GenerationJob> {
    if (this.historyError) throw Error(this.historyError);
    const input = GenerationInputSchema.parse(value);
    const existing = this.jobs.get(input.clientId);
    if (existing) return this.public(existing); // double clicks never launch another request
    const key = await this.key();
    // Recheck after the async key read, so concurrent duplicate submits remain one request.
    if (this.jobs.has(input.clientId))
      return this.public(this.jobs.get(input.clientId)!);
    let reference: { file: string; name: string } | undefined;
    if (input.referenceId) {
      reference = this.references.get(input.referenceId);
      if (!reference) throw Error("Choose your starting image again.");
    }
    const references = input.referenceIds?.map((id) => {
      const selected = this.references.get(id);
      if (!selected) throw Error("Choose your reference images again.");
      return selected;
    });
    // Validate every selected file before recording a request or uploading any
    // image. A missing later reference must never become a text-only request.
    for (const selected of reference ? [reference] : (references ?? []))
      await this.readReference(selected.file);
    if (this.jobs.has(input.clientId))
      return this.public(this.jobs.get(input.clientId)!);
    const job: SavedJob = {
      ...input,
      id: input.clientId,
      status: "submitting",
      createdAt: Date.now(),
      downloaded: false,
      account: fingerprint(key),
      referenceName: reference?.name,
      referenceNames: references?.map((selected) => selected.name),
    };
    if (reference)
      job.referencePath = path.join(
        this.folder,
        `${job.id}-reference${path.extname(reference.file).toLowerCase()}`,
      );
    if (references)
      job.referencePaths = references.map((selected, index) =>
        path.join(
          this.folder,
          `${job.id}-reference-${index + 1}${path.extname(selected.file).toLowerCase()}`,
        ),
      );
    this.jobs.set(job.id, job);
    this.persist();
    return this.exclusive(job.id, async () => {
      try {
        if (reference) await copyFile(reference.file, job.referencePath!);
        if (references)
          for (let index = 0; index < references.length; index++)
            await copyFile(references[index].file, job.referencePaths![index]);
        // Snapshot all references before the first upload. Recoveries use these
        // immutable copies even if the person's original images are changed.
        for (const file of job.referencePath
          ? [job.referencePath]
          : (job.referencePaths ?? []))
          await this.readReference(file);
      } catch (error) {
        job.status = "failed";
        job.error =
          "Reference images could not be saved. Choose the images again; no generation was submitted.";
        this.persist();
        return this.public(job);
      }
      try {
        return await this.send(job, key);
      } catch (error) {
        return this.failedSubmission(job, error);
      }
    });
  }
  private failedSubmission(job: SavedJob, error: unknown) {
    job.status =
      error instanceof ProviderError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 409, 429].includes(error.status)
        ? "failed"
        : "unknown";
    job.error =
      error instanceof ProviderError
        ? error.message
        : "The request could not be confirmed. Recover this same request; do not generate it again.";
    this.persist();
    return this.public(job);
  }
  private async send(job: SavedJob, key: string) {
    if (!job.body) {
      let imageUrl: string | undefined;
      let referenceUrls: string[] | undefined;
      if (
        job.referenceIds &&
        job.referencePaths?.length !== job.referenceIds.length
      )
        throw Error("Reference image snapshots are missing.");
      if (job.referenceId && !job.referencePath)
        throw Error("Starting image snapshot is missing.");
      // Revalidate every durable snapshot before attempting any recovery upload.
      for (const file of job.referencePath
        ? [job.referencePath]
        : (job.referencePaths ?? []))
        await this.readReference(file);
      if (job.referencePath)
        imageUrl = await this.upload(job.referencePath, key);
      if (job.referencePaths?.length) {
        referenceUrls = [];
        for (const file of job.referencePaths)
          referenceUrls.push(await this.upload(file, key));
      }
      const input = GenerationInputSchema.parse({ ...job, clientId: job.id });
      const request = generationRequest(input, imageUrl, referenceUrls);
      job.endpoint = request.endpoint;
      job.body = request.body;
      this.persist();
    }
    const result = await this.api(job.endpoint!, key, job.body, job.id);
    // Validate before saving; ignored provider URLs cannot redirect credentials.
    job.requestId = requestId.parse(result.request_id);
    job.status = providerStatus.safeParse(result.status).success
      ? result.status
      : "queued";
    if (job.status === "completed" && result.video?.url)
      job.outputUrl = String(result.video.url);
    job.error = undefined;
    this.persist();
    return this.public(job);
  }
  async recover(id: string) {
    return this.exclusive(id, async () => {
      const job = this.get(id);
      if (job.requestId) return this.public(job);
      if (job.status !== "unknown")
        throw Error("Only an unconfirmed request can be recovered.");
      const key = await this.key(job);
      job.status = "submitting";
      job.error = undefined;
      this.persist();
      try {
        return await this.send(job, key);
      } catch (error) {
        return this.failedSubmission(job, error);
      }
    });
  }
  async refresh(id: string): Promise<GenerationJob> {
    return this.exclusive(id, async () => {
      const job = this.get(id);
      if (
        !job.requestId ||
        (job.status === "completed" && existsSync(this.videoPath(id)))
      )
        return this.public(job);
      const key = await this.key(job);
      try {
        if (
          !terminal.has(job.status) ||
          (job.status === "completed" && !job.outputUrl)
        ) {
          const result = await this.api(
            `requests/${job.requestId}/status`,
            key,
          );
          job.status = providerStatus.parse(result.status);
          job.error = undefined;
          if (job.status === "completed") {
            if (typeof result.video?.url !== "string")
              throw Error("Missing video output");
            job.outputUrl = result.video.url;
          }
          if (job.status === "failed")
            job.error =
              "Higgsfield could not generate this video. Check the request in your dashboard.";
          if (job.status === "nsfw")
            job.error =
              "Higgsfield declined this request under its content policy. Revise your prompt.";
          this.persist();
        }
        if (job.status === "completed" && !existsSync(this.videoPath(id)))
          await this.download(job);
      } catch (error) {
        job.error =
          error instanceof ProviderError
            ? error.message
            : job.status === "completed"
              ? "Video is ready, but its download was interrupted. Refresh to retry the download."
              : "Could not check this request. Cutline will try again; your generation has not been resubmitted.";
        this.persist();
      }
      return this.public(job);
    });
  }
  async cancel(id: string) {
    return this.exclusive(id, async () => {
      const job = this.get(id);
      if (!job.requestId || job.status !== "queued")
        throw Error("Only queued Higgsfield requests can be canceled.");
      const key = await this.key(job);
      try {
        await this.api(`requests/${job.requestId}/cancel`, key, {});
      } catch (error) {
        if (error instanceof ProviderError && error.status === 400)
          throw Error(
            "This generation has started and can no longer be canceled. Refresh its status.",
          );
        throw Error(
          "Cancellation was not confirmed. Refresh the request before trying again.",
        );
      }
      job.status = "canceled";
      job.error = undefined;
      this.persist();
      return this.public(job);
    });
  }
  private async external(url: string, init: RequestInit = {}) {
    let current = await publicMediaUrl(url);
    for (let i = 0; i < 5; i++) {
      const response = await this.fetcher(current, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(180000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        // Signed upload headers never leave the exact signed destination.
        if (init.method === "PUT")
          throw Error("Reference upload was redirected.");
        current = await publicMediaUrl(
          new URL(response.headers.get("location") ?? "", current).toString(),
        );
        continue;
      }
      if (!response.ok) throw Error("Media transfer failed.");
      return response;
    }
    throw Error("Too many media redirects.");
  }
  private async readReference(file: string) {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_IMAGE)
      throw Error("Reference image too large");
    const bytes = await readFile(file);
    if (!bytes.length || bytes.length > MAX_IMAGE)
      throw Error("Reference image too large");
    // Validate actual image bytes, not only the file extension.
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp =
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
    const content_type = png
      ? "image/png"
      : jpeg
        ? "image/jpeg"
        : webp
          ? "image/webp"
          : undefined;
    if (!content_type) throw Error("Unsupported reference image");
    return { bytes, content_type };
  }
  private async upload(file: string, key: string) {
    const { bytes, content_type } = await this.readReference(file);
    const signed = await this.api("files/generate-upload-url", key, {
      content_type,
    });
    const headers = z
      .record(z.string(), z.string())
      .parse(signed.upload_headers ?? {});
    if (
      Object.keys(headers).some((h) => /^(authorization|cookie|host)$/i.test(h))
    )
      throw Error("Unexpected upload header");
    await publicMediaUrl(z.string().parse(signed.public_url));
    const response = await this.external(z.string().parse(signed.upload_url), {
      method: "PUT",
      headers,
      body: new Uint8Array(bytes),
    });
    await response.body?.cancel();
    return signed.public_url as string;
  }
  private async download(job: SavedJob) {
    if (!job.outputUrl) throw Error("Video output is missing.");
    const destination = this.videoPath(job.id),
      temporary = destination + ".part";
    const response = await this.external(job.outputUrl);
    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim();
    if (
      contentType &&
      !contentType.startsWith("video/") &&
      contentType !== "application/octet-stream" &&
      contentType !== "binary/octet-stream"
    ) {
      await response.body?.cancel();
      throw Error("The provider did not return a video file.");
    }
    if (
      Number(response.headers.get("content-length")) > MAX_VIDEO ||
      !response.body
    ) {
      await response.body?.cancel();
      throw Error("Generated video exceeds the download limit.");
    }
    const file = await open(temporary, "w", 0o600);
    let size = 0;
    try {
      for await (const chunk of response.body as any) {
        size += chunk.length;
        if (size > MAX_VIDEO)
          throw Error("Generated video exceeds the download limit.");
        await file.writeFile(chunk);
      }
      if (size === 0) throw Error("Empty generated video");
      await file.close();
      renameSync(temporary, destination);
      job.error = undefined;
      this.persist();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async importAsset(id: string) {
    const job = this.get(id);
    if (job.status !== "completed") throw Error("This video is not ready yet.");
    if (!existsSync(this.videoPath(id))) await this.refresh(id);
    if (!existsSync(this.videoPath(id)))
      throw Error("The video could not be downloaded. Refresh and try again.");
    const asset = await this.media.import(this.videoPath(id), { id: job.id });
    if (asset.kind !== "video")
      throw Error("Higgsfield did not return a playable video.");
    asset.name = `${job.model === "seedance-2" ? "Seedance" : "Kling"} · ${job.prompt.slice(0, 60)}`;
    return asset;
  }
}
