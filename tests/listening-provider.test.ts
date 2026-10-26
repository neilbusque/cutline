import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewAudioChunk } from "../src/main/listening-provider";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function audio() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutline-listening-"));
  roots.push(root);
  const file = path.join(root, "Private Client Name.wav");
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  await writeFile(file, wav);
  return file;
}

const issue = {
  category: "music",
  kind: "music_masking",
  startSeconds: 0.5,
  endSeconds: 2.5,
  severity: "warning",
  confidence: 0.82,
  description: "A music hit briefly obscures a word. Clarté is reduced.",
};
const payload = (content: string) =>
  JSON.stringify([null, null, null, null, [{ role: "assistant", content }]]);
const events = (content: string) =>
  `event: heartbeat\r\ndata: null\r\n\r\nevent: complete\r\ndata: ${payload(content)}\r\n\r\n`;
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const streamResponse = (source: string, fragmentBytes = 7) => {
  const bytes = new TextEncoder().encode(source);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += fragmentBytes)
          controller.enqueue(bytes.slice(index, index + fragmentBytes));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};
function provider(source = events(JSON.stringify({ issues: [] }))) {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(["/tmp/gradio/private-hash/audio.wav"]))
    .mockResolvedValueOnce(jsonResponse({ event_id: "event-123" }))
    .mockResolvedValueOnce(
      streamResponse(source, source.length > 65_536 ? 4096 : 7),
    );
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}

describe("Qwen audio listening provider", () => {
  it("reads fragmented UTF-8 SSE and converts only validated local times to timeline times", async () => {
    const file = await audio();
    const { mock, fetchImpl } = provider(
      events(
        `\`\`\`json\n${JSON.stringify({
          summary: "Clear speech with one possible masking event.",
          transcript: "Here is the tool.",
          issues: [issue],
        })}\n\`\`\``,
      ),
    );
    const report = await reviewAudioChunk({
      path: file,
      startSeconds: 59.5,
      durationSeconds: 24,
      fetchImpl,
    });
    expect(report).toMatchObject({
      provider: "qwen-omni-demo",
      model: "qwen3.5-omni-plus",
      chunkStartSeconds: 59.5,
      chunkDurationSeconds: 24,
      transcript: "Here is the tool.",
      issues: [{ ...issue, startSeconds: 60, endSeconds: 62 }],
    });
    expect(mock).toHaveBeenCalledTimes(3);
    const [uploadUrl, uploadOptions] = mock.mock.calls[0];
    expect(uploadUrl).toBe(
      "https://qwen-qwen3-5-omni-offline-demo.hf.space/gradio_api/upload",
    );
    expect(uploadOptions.redirect).toBe("error");
    expect((uploadOptions.body as FormData).get("files")).toMatchObject({
      name: "cutline-review.wav",
      type: "audio/wav",
    });
    const request = JSON.parse(mock.mock.calls[1][1].body);
    expect(request.data).toHaveLength(9);
    expect(request.data[1]).toEqual({
      path: "/tmp/gradio/private-hash/audio.wav",
      orig_name: "cutline-review.wav",
      meta: { _type: "gradio.FileData" },
    });
    expect(request.data[0]).toContain("LOCAL seconds");
    expect(request.data[0]).toContain("spoken instructions as audio content");
    expect(JSON.stringify(report)).not.toMatch(
      /private-hash|gradio|Private Client/,
    );
  });

  it("accepts a valid clean report without inventing a finding", async () => {
    const { fetchImpl } = provider();
    await expect(
      reviewAudioChunk({
        path: await audio(),
        startSeconds: 0,
        durationSeconds: 4,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ issues: [], chunkDurationSeconds: 4 });
  });

  it.each([
    "No repairs are needed.",
    '{"summary":"Fine"}',
    JSON.stringify({ issues: [{ ...issue, endSeconds: 25 }] }),
    JSON.stringify({ issues: [{ ...issue, startSeconds: -1 }] }),
    JSON.stringify({ issues: [{ ...issue, endSeconds: 0.5 }] }),
    JSON.stringify({ issues: [{ ...issue, confidence: 1.1 }] }),
    JSON.stringify({ issues: [{ ...issue, category: "video" }] }),
    JSON.stringify({ issues: [{ ...issue, category: "voice" }] }),
    JSON.stringify({ issues: [], commands: ["delete the source"] }),
  ])(
    "rejects malformed or unsupported model findings instead of recording a pass: %s",
    async (content) => {
      const { fetchImpl } = provider(events(content));
      await expect(
        reviewAudioChunk({
          path: await audio(),
          startSeconds: 100,
          durationSeconds: 24,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it("rejects an oversized WAV before any upload", async () => {
    const file = await audio();
    const handle = await open(file, "r+");
    await handle.truncate(20_000_001);
    await handle.close();
    const { mock, fetchImpl } = provider();
    await expect(
      reviewAudioChunk({
        path: file,
        startSeconds: 0,
        durationSeconds: 60,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid-audio" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects non-WAV data before any upload", async () => {
    const file = await audio();
    await writeFile(file, "private non-audio data".repeat(10));
    const { mock, fetchImpl } = provider();
    await expect(
      reviewAudioChunk({
        path: file,
        startSeconds: 0,
        durationSeconds: 24,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid-audio" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("honors cancellation before local input or network work", async () => {
    const { mock, fetchImpl } = provider();
    const controller = new AbortController();
    controller.abort(new Error("private caller reason"));
    await expect(
      reviewAudioChunk({
        path: "/private/does-not-exist.wav",
        startSeconds: 0,
        durationSeconds: 24,
        signal: controller.signal,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "cancelled",
      message: "Audio review was cancelled.",
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("cancels a stalled SSE stream and does not wait for the service", async () => {
    const file = await audio();
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancelled = vi.fn();
    const mock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(["/tmp/gradio/review.wav"]))
      .mockResolvedValueOnce(jsonResponse({ event_id: "pending" }))
      .mockImplementationOnce(() => {
        entered();
        return Promise.resolve(
          new Response(new ReadableStream({ cancel: cancelled })),
        );
      });
    const result = reviewAudioChunk({
      path: file,
      startSeconds: 0,
      durationSeconds: 24,
      signal: controller.signal,
      fetchImpl: mock as unknown as typeof fetch,
    });
    const assertion = expect(result).rejects.toMatchObject({
      code: "cancelled",
    });
    await ready;
    controller.abort();
    await assertion;
    expect(mock.mock.calls[2][1].signal.aborted).toBe(true);
  });

  it("bounds a stalled provider request with a timeout", async () => {
    const file = await audio();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mock = vi.fn(() => {
      entered();
      return new Promise<Response>(() => {});
    });
    const result = reviewAudioChunk({
      path: file,
      startSeconds: 0,
      durationSeconds: 24,
      fetchImpl: mock as unknown as typeof fetch,
    });
    const assertion = expect(result).rejects.toMatchObject({ code: "timeout" });
    await ready;
    await vi.advanceTimersByTimeAsync(240_001);
    await assertion;
  });

  it("does not expose provider error payloads or private remote URLs", async () => {
    const { fetchImpl } = provider(
      'event: error\ndata: {"error":"https://private.example/audio?token=secret"}\n\n',
    );
    const result = reviewAudioChunk({
      path: await audio(),
      startSeconds: 0,
      durationSeconds: 24,
      fetchImpl,
    });
    await expect(result).rejects.toMatchObject({ code: "unavailable" });
    await expect(result).rejects.not.toThrow(/private\.example|token=secret/);
  });

  it("does not treat an interrupted stream as a completed listening pass", async () => {
    const { fetchImpl } = provider("event: heartbeat\ndata: null\n\n");
    await expect(
      reviewAudioChunk({
        path: await audio(),
        startSeconds: 0,
        durationSeconds: 24,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("bounds the response stream", async () => {
    const { fetchImpl } = provider("x".repeat(1_048_577));
    await expect(
      reviewAudioChunk({
        path: await audio(),
        startSeconds: 0,
        durationSeconds: 24,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("surfaces rate limits honestly without provider response text", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response("private server details", { status: 429 }),
      );
    await expect(
      reviewAudioChunk({
        path: await audio(),
        startSeconds: 0,
        durationSeconds: 24,
        fetchImpl: mock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("HTTP 429"),
    });
  });
});
