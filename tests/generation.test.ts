import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GenerationLibrary, publicMediaUrl } from "../src/main/generation";
import { GenerationCredentials } from "../src/main/generation-credentials";
import {
  GenerationInputSchema,
  generationRequest,
  type GenerationInput,
} from "../src/shared/generation";
import type { Asset } from "../src/shared/model";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

let folder: string;
const libraries: GenerationLibrary[] = [];
const apiKey = "qa-only-provider-key";
const providerId = "a1111111-1111-4111-8111-111111111111";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const input = (overrides: Partial<GenerationInput> = {}): GenerationInput => ({
  clientId: randomUUID(),
  projectId: "qa-project",
  prompt: "Soft light over ocean waves",
  model: "seedance-2",
  duration: 5,
  aspectRatio: "16:9",
  resolution: "720p",
  audio: false,
  ...overrides,
});
const make = (
  fetcher: typeof fetch,
  getKey: () => Promise<string | undefined> = async () => apiKey,
) => {
  const media = {
    import: vi.fn(
      async (file: string, options: { id?: string } = {}): Promise<Asset> => ({
        id: options.id ?? randomUUID(),
        name: "fixture.mp4",
        path: file,
        kind: "video",
        duration: 1,
        hasAudio: false,
      }),
    ),
  };
  const library = new GenerationLibrary(folder, media, getKey, fetcher);
  libraries.push(library);
  return { library, media };
};
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "cutline-generation-test-"));
});
afterEach(async () => {
  for (const library of libraries.splice(0)) library.stop();
  await rm(folder, { recursive: true, force: true });
});

describe("Higgsfield credentials", () => {
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(value.split("").reverse().join("")),
    decryptString: (value: Buffer) =>
      value.toString().split("").reverse().join(""),
  };
  it("stores encrypted owner-only credentials and returns status without the key", async () => {
    const file = path.join(folder, "credentials.json");
    const credentials = new GenerationCredentials(file, encryption);
    expect(await credentials.status()).toEqual({
      configured: false,
      secureStorageAvailable: null,
    });
    expect(await credentials.setKey(apiKey)).toEqual({
      configured: true,
      secureStorageAvailable: true,
    });
    expect(await readFile(file, "utf8")).not.toContain(apiKey);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await credentials.getKey()).toBe(apiKey);
    await credentials.clearKey();
    expect(await credentials.status()).toEqual({
      configured: false,
      secureStorageAvailable: true,
    });
  });
  it("rejects header injection and never falls back to plaintext", async () => {
    const file = path.join(folder, "credentials.json");
    const credentials = new GenerationCredentials(file, encryption);
    for (const key of [
      "short",
      "key with spaces",
      "valid-key\r\nAuthorization: other",
    ])
      await expect(credentials.setKey(key)).rejects.toThrow(/valid Higgsfield/);
    const unavailable = new GenerationCredentials(file, {
      ...encryption,
      isEncryptionAvailable: () => false,
    });
    await expect(unavailable.setKey(apiKey)).rejects.toThrow(
      /Secure key storage is unavailable/,
    );
    expect(await readdir(folder)).toEqual([]);
  });
});

describe("generation media addresses", () => {
  it("accepts public HTTPS hosts and checks every resolved address", async () => {
    expect(
      await publicMediaUrl(
        "https://cdn.example.com/video.mp4?signature=opaque",
      ),
    ).toBe("https://cdn.example.com/video.mp4?signature=opaque");
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.2",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
    ]) {
      const resolve = vi.fn(async () => [
        { address: "93.184.216.34", family: 4 },
        { address, family: address.includes(":") ? 6 : 4 },
      ]);
      await expect(
        publicMediaUrl("https://cdn.example.com/video.mp4", resolve as never),
      ).rejects.toThrow(/non-public/);
    }
  });
  it("rejects local destinations, credentials, IP literals, and alternate protocols", async () => {
    for (const url of [
      "file:///etc/passwd",
      "http://cdn.example.com/video.mp4",
      "https://localhost/v",
      "https://foo.local/v",
      "https://foo.internal/v",
      "https://foo.test/v",
      "https://127.0.0.1/v",
      "https://[::1]/v",
      "https://user:pass@cdn.example.com/v",
      "https://cdn.example.com:444/v",
    ])
      await expect(publicMediaUrl(url)).rejects.toThrow();
    await expect(
      publicMediaUrl(
        "https://cdn.example.com/v",
        vi.fn(async () => []) as never,
      ),
    ).rejects.toThrow(/non-public/);
  });
});

describe("generation request contract", () => {
  it("maps ordered reference images to Seedance reference-to-video with format controls", () => {
    const urls = [
      "https://cdn.example.com/hero.png",
      "https://cdn.example.com/forest.png",
    ];
    const request = generationRequest(
      input({
        referenceIds: [randomUUID(), randomUUID()],
        aspectRatio: "9:16",
        duration: 6,
      }),
      undefined,
      urls,
    );
    expect(request.endpoint).toBe("bytedance/seedance-2.0/reference-to-video");
    expect(request.body).toEqual({
      prompt: "Soft light over ocean waves",
      image_urls: urls,
      duration: 6,
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: false,
    });
  });
  it("uses the image endpoint and omits aspect_ratio when a starting image is supplied", () => {
    const request = generationRequest(
      input(),
      "https://cdn.example.com/reference.png",
    );
    expect(request.endpoint).toBe("bytedance/seedance-2.0/image-to-video");
    expect(request.body).toMatchObject({
      image_url: "https://cdn.example.com/reference.png",
      generate_audio: false,
    });
    expect(request.body).not.toHaveProperty("aspect_ratio");
    const kling = generationRequest(input({ model: "kling-3", audio: true }));
    expect(kling.body).toMatchObject({ sound: "on", aspect_ratio: "16:9" });
    expect(kling.body).not.toHaveProperty("resolution");
  });
  it("rejects unsupported values before accessing the provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { library } = make(fetcher);
    for (const invalid of [
      input({ prompt: "   " }),
      input({ model: "seedance-2", duration: 3 }),
      input({ model: "kling-3", aspectRatio: "21:9" }),
      input({ model: "kling-3", referenceId: randomUUID() }),
      input({ model: "kling-3", referenceIds: [randomUUID()] }),
      input({ referenceId: randomUUID(), referenceIds: [randomUUID()] }),
      input({ referenceIds: [] }),
      input({ referenceIds: Array.from({ length: 10 }, () => randomUUID()) }),
      input({ referenceIds: [providerId, providerId] }),
    ]) {
      expect(GenerationInputSchema.safeParse(invalid).success).toBe(false);
      await expect(library.submit(invalid)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("durable generation lifecycle", () => {
  it("reuses selection IDs for the same resolved file while revalidating its contents", async () => {
    const imageFile = path.join(folder, "reference.png");
    const otherFile = path.join(folder, "different.png");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await Promise.all([
      writeFile(imageFile, bytes),
      writeFile(otherFile, bytes),
    ]);
    const fetcher = vi.fn<typeof fetch>();
    const { library } = make(fetcher);
    const first = await library.pickReference(imageFile);
    expect(
      await library.pickReference(path.join(folder, ".", "reference.png")),
    ).toEqual(first);
    expect((await library.pickReference(otherFile)).id).not.toBe(first.id);
    await writeFile(imageFile, "no longer an image");
    await expect(library.pickReference(imageFile)).rejects.toThrow(
      /Unsupported reference/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("snapshots all ordered references before upload and recovers exactly the same paid request", async () => {
    const originals = [
      path.join(folder, "hero.png"),
      path.join(folder, "forest.png"),
    ];
    const bytes = originals.map((_, index) =>
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, index]),
    );
    await Promise.all(
      originals.map((file, index) => writeFile(file, bytes[index])),
    );
    let uploads = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      const ledger = JSON.parse(
        await readFile(path.join(folder, "jobs.json"), "utf8"),
      );
      // Even the first signed upload request sees a full durable set.
      expect(ledger[0].referencePaths).toHaveLength(2);
      for (let index = 0; index < 2; index++)
        expect(await readFile(ledger[0].referencePaths[index])).toEqual(
          bytes[index],
        );
      if (String(url).endsWith("files/generate-upload-url")) {
        uploads++;
        return json({
          upload_url: `https://storage.example.com/upload-${uploads}`,
          public_url: `https://cdn.example.com/reference-${uploads}.png`,
          upload_headers: { "Content-Type": "image/png" },
        });
      }
      if (options?.method === "PUT") {
        expect(new Headers(options.headers).has("Authorization")).toBe(false);
        return new Response(null, { status: 200 });
      }
      throw Error("Connection ended after provider acceptance");
    });
    const { library } = make(fetcher);
    const references = await Promise.all(
      originals.map((file) => library.pickReference(file)),
    );
    const request = input({
      referenceIds: references.map((reference) => reference.id),
    });
    await Promise.all([library.submit(request), library.submit(request)]);
    expect(library.list()[0]).toMatchObject({
      status: "unknown",
      referenceNames: ["hero.png", "forest.png"],
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
    const paid = fetcher.mock.calls[4];
    expect(String(paid[0])).toMatch(/reference-to-video$/);
    expect(JSON.parse(String(paid[1]?.body)).image_urls).toEqual([
      "https://cdn.example.com/reference-1.png",
      "https://cdn.example.com/reference-2.png",
    ]);
    await Promise.all(originals.map((file) => rm(file)));
    const retry = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ request_id: providerId, status: "queued" }));
    const recovered = make(retry).library;
    expect((await recovered.recover(request.clientId)).status).toBe("queued");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0][0]).toBe(paid[0]);
    expect(retry.mock.calls[0][1]?.body).toBe(paid[1]?.body);
    expect(
      new Headers(retry.mock.calls[0][1]?.headers).get("Idempotency-Key"),
    ).toBe(request.clientId);
    const publicJob = JSON.stringify(recovered.list());
    expect(publicJob).not.toContain(folder);
    expect(publicJob).not.toContain("https://");
    expect(publicJob).not.toContain("referenceIds");
    expect(publicJob).not.toContain("referencePaths");
  });

  it("rejects missing or changed selections before saving a ledger or contacting the provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { library } = make(fetcher);
    await expect(
      library.submit(input({ referenceIds: [randomUUID()] })),
    ).rejects.toThrow(/Choose your reference/);
    const imageFile = path.join(folder, "changed.png");
    await writeFile(imageFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const reference = await library.pickReference(imageFile);
    await writeFile(imageFile, "not an image");
    await expect(
      library.submit(input({ referenceIds: [reference.id] })),
    ).rejects.toThrow(/Unsupported reference/);
    expect(library.list()).toEqual([]);
    expect(await readdir(folder)).not.toContain("jobs.json");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never downgrades an interrupted reference upload to text when a recovery snapshot is missing", async () => {
    const imageFile = path.join(folder, "hero.png");
    await writeFile(imageFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const interrupted = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Error("Upload interrupted"));
    const { library } = make(interrupted);
    const reference = await library.pickReference(imageFile);
    const request = input({ referenceIds: [reference.id] });
    expect((await library.submit(request)).status).toBe("unknown");
    const ledger = JSON.parse(
      await readFile(path.join(folder, "jobs.json"), "utf8"),
    );
    await rm(ledger[0].referencePaths[0]);
    const retry = vi.fn<typeof fetch>();
    const recovered = make(retry).library;
    expect((await recovered.recover(request.clientId)).status).toBe("unknown");
    expect(retry).not.toHaveBeenCalled();
  });
  it("coalesces concurrent duplicate submits into one paid request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ request_id: providerId, status: "queued" }));
    const { library } = make(fetcher);
    const request = input();
    await Promise.all([
      library.submit(request),
      library.submit(request),
      library.submit(request),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(library.list()).toHaveLength(1);
    const options = fetcher.mock.calls[0][1]!;
    expect(new Headers(options.headers).get("Idempotency-Key")).toBe(
      request.clientId,
    );
    expect(new Headers(options.headers).get("Authorization")).toBe(
      `Key ${apiKey}`,
    );
    expect(options.redirect).toBe("error");
  });
  it("recovers an ambiguous submission after restart with the same body and idempotency key", async () => {
    const original = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error("Connection ended after provider acceptance"),
      );
    const request = input();
    const first = make(original).library;
    expect((await first.submit(request)).status).toBe("unknown");
    const retry = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ request_id: providerId, status: "queued" }));
    const recovered = make(retry).library;
    expect(retry).not.toHaveBeenCalled();
    expect((await recovered.recover(request.clientId)).status).toBe("queued");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0][0]).toBe(original.mock.calls[0][0]);
    expect(retry.mock.calls[0][1]?.body).toBe(original.mock.calls[0][1]?.body);
    expect(
      new Headers(retry.mock.calls[0][1]?.headers).get("Idempotency-Key"),
    ).toBe(request.clientId);
    await recovered.submit(request);
    await recovered.recover(request.clientId);
    expect(retry).toHaveBeenCalledTimes(1);
    const publicJob = JSON.stringify(recovered.list());
    for (const privateField of [
      apiKey,
      "account",
      "endpoint",
      "referencePath",
      '"body"',
    ])
      expect(publicJob).not.toContain(privateField);
  });
  it("does not manage an old request with a different account key", async () => {
    let key = apiKey;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ request_id: providerId, status: "queued" }));
    const { library } = make(fetcher, async () => key);
    const job = await library.submit(input());
    key = "a-different-account-key";
    await expect(library.refresh(job.id)).rejects.toThrow(
      /original Higgsfield API key/,
    );
    await expect(library.cancel(job.id)).rejects.toThrow(
      /original Higgsfield API key/,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("accepts a bodyless 202 cancellation and prevents canceling a running job", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: providerId, status: "queued" }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const { library } = make(fetcher);
    const job = await library.submit(input());
    expect((await library.cancel(job.id)).status).toBe("canceled");
    expect(fetcher.mock.calls[1][0]).toBe(
      `https://api.higgsfield.ai/requests/${providerId}/cancel`,
    );
    await expect(library.cancel(job.id)).rejects.toThrow(/Only queued/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(
      json({ request_id: providerId, status: "in_progress" }),
    );
    const running = await library.submit(input());
    await expect(library.cancel(running.id)).rejects.toThrow(/Only queued/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("serializes refresh and cancellation instead of returning a refresh result as cancellation", async () => {
    let release: (response: Response) => void = () => {};
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: providerId, status: "queued" }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const { library } = make(fetcher);
    const job = await library.submit(input());
    const refresh = library.refresh(job.id);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const cancel = library.cancel(job.id);
    release(json({ status: "queued" }));
    await refresh;
    expect((await cancel).status).toBe("canceled");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("keeps status failures recoverable without resubmitting and imports completed local files after disconnect", async () => {
    let key: string | undefined = apiKey;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: providerId, status: "queued" }))
      .mockResolvedValueOnce(
        json({ secretProviderDetail: "must not leak" }, 429),
      )
      .mockResolvedValueOnce(
        json({
          status: "completed",
          video: { url: "https://cdn.example.com/video.mp4?signature=private" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("fixture-video-bytes", {
          headers: { "Content-Type": "video/mp4" },
        }),
      );
    const { library, media } = make(fetcher, async () => key);
    const job = await library.submit(input());
    const retryable = await library.refresh(job.id);
    expect(retryable.status).toBe("queued");
    expect(retryable.error).toMatch(/rate limiting/);
    expect(JSON.stringify(retryable)).not.toContain("secretProviderDetail");
    expect((await library.refresh(job.id)).downloaded).toBe(true);
    expect(JSON.stringify(library.list())).not.toContain("signature=private");
    expect(
      new Headers(fetcher.mock.calls[3][1]?.headers).has("Authorization"),
    ).toBe(false);
    key = undefined;
    expect((await library.importAsset(job.id)).kind).toBe("video");
    expect(media.import).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("reports provider failures and content-policy declines without downloading or retrying a submit", async () => {
    for (const status of ["failed", "nsfw"] as const) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          json({ request_id: providerId, status: "queued" }),
        )
        .mockResolvedValueOnce(json({ status }));
      const { library } = make(fetcher);
      const job = await library.submit(input());
      const result = await library.refresh(job.id);
      expect(result.status).toBe(status);
      expect(result.error).toMatch(
        status === "failed" ? /could not generate/ : /content policy/,
      );
      await expect(library.importAsset(job.id)).rejects.toThrow(/not ready/);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it("blocks a redirected private media destination and retries only the download", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: providerId, status: "queued" }))
      .mockResolvedValueOnce(
        json({
          status: "completed",
          video: { url: "https://cdn.example.com/video.mp4" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/secret" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("fixture-video-bytes", {
          headers: { "Content-Type": "video/mp4" },
        }),
      );
    const { library } = make(fetcher);
    const job = await library.submit(input());
    const interrupted = await library.refresh(job.id);
    expect(interrupted.status).toBe("completed");
    expect(interrupted.downloaded).toBe(false);
    expect(interrupted.error).toMatch(/download was interrupted/);
    expect((await library.refresh(job.id)).downloaded).toBe(true);
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("127.0.0.1")),
    ).toBe(false);
    expect(
      fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
  });
  it("rejects HTML returned in place of a generated video without caching it", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: providerId, status: "queued" }))
      .mockResolvedValueOnce(
        json({
          status: "completed",
          video: { url: "https://cdn.example.com/video.mp4" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<html>Access expired</html>", {
          headers: { "Content-Type": "text/html" },
        }),
      );
    const { library, media } = make(fetcher);
    const job = await library.submit(input());
    const result = await library.refresh(job.id);
    expect(result.status).toBe("completed");
    expect(result.downloaded).toBe(false);
    expect(result.error).toMatch(/download was interrupted/);
    expect(await readdir(folder)).not.toContain(`${job.id}.mp4`);
    expect(await readdir(folder)).not.toContain(`${job.id}.mp4.part`);
    expect(media.import).not.toHaveBeenCalled();
  });
  it("uploads a selected starting image without forwarding provider credentials to storage", async () => {
    const imageFile = path.join(folder, "reference.png");
    await writeFile(
      imageFile,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          upload_url: "https://storage.example.com/upload",
          public_url: "https://cdn.example.com/reference.png",
          upload_headers: { "Content-Type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        json({ request_id: providerId, status: "queued" }),
      );
    const { library } = make(fetcher);
    const reference = await library.pickReference(imageFile);
    const job = await library.submit(input({ referenceId: reference.id }));
    expect(job.status).toBe("queued");
    expect(job.referenceName).toBe("reference.png");
    const upload = fetcher.mock.calls[1][1]!;
    expect(upload.method).toBe("PUT");
    expect(new Headers(upload.headers).has("Authorization")).toBe(false);
    const body = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(body.image_url).toBe("https://cdn.example.com/reference.png");
    expect(body).not.toHaveProperty("aspect_ratio");
    expect(JSON.stringify(library.list())).not.toContain(imageFile);
  });
  it("preserves corrupt history for recovery without preventing the editor from opening", async () => {
    const corrupt = "{interrupted ledger";
    await writeFile(path.join(folder, "jobs.json"), corrupt);
    const fetcher = vi.fn<typeof fetch>();
    const { library } = make(fetcher);
    expect(() => library.list()).toThrow(/history could not be read/);
    await expect(library.submit(input())).rejects.toThrow(
      /history could not be read/,
    );
    const historyFiles = await readdir(folder);
    expect(
      await Promise.all(
        historyFiles.map((name) => readFile(path.join(folder, name), "utf8")),
      ),
    ).toContain(corrupt);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
