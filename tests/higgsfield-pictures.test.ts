import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { HiggsfieldPictures } from "../src/main/higgsfield-pictures";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const key = "qa-only-provider-key";
const requestId = "b2222222-2222-4222-8222-222222222222";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
/** What Recraft paints: a teal disc on the magenta backdrop Cutline asked for. */
const painted = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="#ff00ff"/><circle cx="100" cy="80" r="40" fill="#14786e"/></svg>',
    ),
  )
    .png()
    .toBuffer();

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "cutline-pictures-test-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function provider(statuses: string[], options: { image?: Buffer } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const address = String(url);
    calls.push({ url: address, init });
    if (address.includes("/estimate/")) return json({ usd: "0.04" });
    if (address.endsWith("/recraft/v4.1/text-to-image"))
      return json({ status: "queued", request_id: requestId });
    if (address.endsWith("/status")) {
      const status = statuses.shift() ?? "completed";
      return json({
        status,
        request_id: requestId,
        ...(status === "completed"
          ? { images: [{ url: "https://cdn.example.com/out.png" }] }
          : {}),
      });
    }
    if (address.endsWith("/cancel")) return new Response(null, { status: 202 });
    if (address === "https://cdn.example.com/out.png")
      return new Response(new Uint8Array(options.image ?? (await painted())), {
        headers: { "content-type": "image/png" },
      });
    return new Response("unexpected", { status: 500 });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}
const instant = async () => {};

describe("Higgsfield pictures", () => {
  it("submits once with an idempotency key, waits, downloads and cuts the picture out", async () => {
    const { fetcher, calls } = provider(["in_progress", "completed"]);
    const pictures = new HiggsfieldPictures(folder, async () => key, fetcher, instant);
    const made = await pictures.generate({
      prompt: "a teal disc",
      style: "flat",
      aspect: "wide",
    });
    const submit = calls.find((call) => call.url.endsWith("text-to-image") && !call.url.includes("/estimate/"))!;
    const headers = submit.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Key ${key}`);
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(submit.init.body))).toMatchObject({
      aspect_ratio: "16:9",
      output_format: "png",
      background_color: { rgb: [255, 0, 255] },
    });
    // The key never travels to the media host.
    const download = calls.find((call) => call.url.startsWith("https://cdn."))!;
    expect(JSON.stringify(download.init.headers ?? {})).not.toContain(key);
    expect(made).toMatchObject({ cutout: true, usd: "0.04" });
    // Cropped to the disc (80 px) plus a small margin, with a clear corner.
    expect(made.width).toBeLessThan(100);
    const { data, info } = await sharp(await readFile(made.file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0);
    const middle = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect(data[middle + 3]).toBe(255);
    // The paid request is on record with its result.
    const ledger = JSON.parse(await readFile(path.join(folder, "pictures.json"), "utf8"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ requestId, status: "completed", file: made.file });
    expect(JSON.stringify(ledger)).not.toContain(key);
  });

  it("explains a declined or failed picture without retrying the paid request", async () => {
    for (const [status, message] of [
      ["nsfw", /content policy/],
      ["failed", /could not make this picture/],
    ] as const) {
      const { fetcher, calls } = provider([status]);
      const pictures = new HiggsfieldPictures(folder, async () => key, fetcher, instant);
      await expect(
        pictures.generate({ prompt: "x", style: "flat", aspect: "square" }),
      ).rejects.toThrow(message);
      expect(
        calls.filter((call) => call.url.endsWith("text-to-image") && !call.url.includes("/estimate/")),
      ).toHaveLength(1);
    }
  });

  it("cancels a queued request when the person stops waiting", async () => {
    const { fetcher, calls } = provider(["queued", "queued"]);
    const controller = new AbortController();
    const pictures = new HiggsfieldPictures(folder, async () => key, fetcher, async () => {
      controller.abort();
      throw Error("Cancelled");
    });
    await expect(
      pictures.generate({ prompt: "x", style: "flat", aspect: "square" }, controller.signal),
    ).rejects.toThrow("Cancelled");
    expect(calls.some((call) => call.url.endsWith(`/requests/${requestId}/cancel`))).toBe(true);
  });

  it("needs a connected key and refuses a non-picture download", async () => {
    const none = new HiggsfieldPictures(folder, async () => undefined, provider([]).fetcher, instant);
    await expect(
      none.generate({ prompt: "x", style: "flat", aspect: "square" }),
    ).rejects.toThrow(/Connect Higgsfield/);
    const { fetcher } = provider(["completed"]);
    const html = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).startsWith("https://cdn.")
        ? new Response("<html>", { headers: { "content-type": "text/html" } })
        : fetcher(url, init),
    ) as unknown as typeof fetch;
    const pictures = new HiggsfieldPictures(folder, async () => key, html, instant);
    await expect(
      pictures.generate({ prompt: "x", style: "flat", aspect: "square" }),
    ).rejects.toThrow(/did not return a picture/);
  });

  it("keeps an opaque picture when there is no flat backdrop to remove", async () => {
    const noisy = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#000000", noise: { type: "gaussian", mean: 128, sigma: 60 } },
    })
      .png()
      .toBuffer();
    const { fetcher } = provider(["completed"], { image: noisy });
    const pictures = new HiggsfieldPictures(folder, async () => key, fetcher, instant);
    const made = await pictures.generate({ prompt: "x", style: "flat", aspect: "square" });
    expect(made).toMatchObject({ cutout: false, width: 64, height: 48 });
  });

  it("asks Higgsfield for a price once per shape", async () => {
    const { fetcher, calls } = provider([]);
    const pictures = new HiggsfieldPictures(folder, async () => key, fetcher, instant);
    const request = { prompt: "x", style: "flat" as const, aspect: "square" as const };
    expect(await pictures.estimate(request)).toBe("0.04");
    expect(await pictures.estimate({ ...request, prompt: "y" })).toBe("0.04");
    expect(calls.filter((call) => call.url.includes("/estimate/"))).toHaveLength(1);
  });
});
