import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, open, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { Jobs } from "../src/main/media";
import { Speech } from "../src/main/tts";
import { speechModelFiles } from "../src/shared/tts-model";
import { speechVoices } from "../src/shared/tts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: vi.fn(() => {
    throw Error("Inference must not start in readiness tests.");
  }),
}));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cutline-speech-ready-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("Readiness tests must not download.");
    }),
  );
  vi.mocked(fork).mockClear();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

async function sizedFile(file: string, bytes: number) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "w");
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}
async function model(root: string) {
  // Sparse fixtures exercise sizes without storing or loading an ONNX model.
  for (const file of speechModelFiles)
    await sizedFile(path.join(root, file.name), file.size);
}
async function fixture() {
  const modelDirectory = path.join(directory, "bundled-model");
  const voicesDirectory = path.join(directory, "runtime-voices");
  const speechDirectory = path.join(directory, "speech");
  await model(modelDirectory);
  for (const voice of speechVoices)
    await sizedFile(path.join(voicesDirectory, `${voice.id}.bin`), 522240);
  const jobs = new Jobs(() => {});
  const speech = new Speech({
    directory: speechDirectory,
    modelDirectory,
    voicesDirectory,
    workerPath: path.join(directory, "tts-worker.cjs"),
    jobs,
  });
  return { speech, jobs, modelDirectory, voicesDirectory, speechDirectory };
}

describe("Kokoro local readiness", () => {
  it("requires a complete model and all eight packaged voice files", async () => {
    const { speech } = await fixture();
    expect(await speech.status()).toMatchObject({
      ready: true,
      engine: "Kokoro 82M",
      defaultVoice: "af_heart",
      defaultSpeed: 1.08,
      voices: speechVoices,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it.each(speechVoices.map((voice) => voice.id))(
    "explains the repair when packaged %s is missing",
    async (voice) => {
      const { speech, voicesDirectory } = await fixture();
      await rm(path.join(voicesDirectory, `${voice}.bin`));
      await expect(speech.status()).rejects.toThrow(
        /bundled voice files.*Reinstall Cutline/,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(fork).not.toHaveBeenCalled();
    },
  );

  it("rejects truncated voice files and directories in place of voice files", async () => {
    const { speech, voicesDirectory } = await fixture();
    const file = path.join(voicesDirectory, "af_heart.bin");
    await sizedFile(file, 522239);
    await expect(speech.status()).rejects.toThrow(/bundled voice files/);
    await rm(file);
    await mkdir(file);
    await expect(speech.status()).rejects.toThrow(/bundled voice files/);
  });

  it("checks the model too and retains the downloaded-model fallback", async () => {
    const { speech, modelDirectory, speechDirectory } = await fixture();
    await rm(path.join(modelDirectory, "onnx/model_quantized.onnx"));
    expect((await speech.status()).ready).toBe(false);
    await model(path.join(speechDirectory, "model"));
    expect((await speech.status()).ready).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains that model setup cannot repair missing dependency voices", async () => {
    const { speech, jobs, voicesDirectory, modelDirectory } = await fixture();
    await rm(path.join(voicesDirectory, "bf_emma.bin"));
    await rm(modelDirectory, { recursive: true });
    await expect(speech.setup()).rejects.toThrow(
      /bundled voice files.*Reinstall Cutline.*model cannot repair/,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    expect([...jobs.jobs.values()].at(-1)?.state).toBe("error");
    // A failed setup releases its operation guard and permits another attempt.
    await expect(speech.setup()).rejects.toThrow(/bundled voice files/);
  });

  it("blocks generation before downloading, spawning or creating partial output", async () => {
    const { speech, voicesDirectory, speechDirectory } = await fixture();
    await rm(path.join(voicesDirectory, "af_heart.bin"));
    await expect(
      speech.generate({ text: "Keep this narration on this Mac." }),
    ).rejects.toThrow(/bundled voice files/);
    expect(fetch).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    expect(await readdir(speechDirectory).catch(() => [])).toEqual([]);
    await expect(
      speech.generate({ text: "A second attempt." }),
    ).rejects.toThrow(/bundled voice files/);
  });
});
