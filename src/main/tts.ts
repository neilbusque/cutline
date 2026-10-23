import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fork } from "node:child_process";
import { Jobs } from "./media";
import {
  SpeechInputSchema,
  speechChunks,
  speechVoices,
  type TtsStatus,
} from "../shared/tts";
import type { Job } from "../shared/model";

import { speechModelFiles, speechModelRevision } from "../shared/tts-model";
const totalBytes = speechModelFiles.reduce((sum, file) => sum + file.size, 0);
// kokoro-js 1.2.1 bundles 510 style vectors of 256 float32 values per voice.
// These dependency files are separate from the optional model download.
const voiceFileBytes = 510 * 256 * Float32Array.BYTES_PER_ELEMENT;
async function validVoices(directory: string) {
  try {
    for (const voice of speechVoices) {
      const file = await stat(path.join(directory, `${voice.id}.bin`));
      if (!file.isFile() || file.size !== voiceFileBytes) return false;
    }
    return true;
  } catch {
    return false;
  }
}
const checkCancelled = (job: Job) => {
  if (job.state === "cancelled") throw Error("Cancelled");
};
async function validModel(directory: string, verify = false) {
  try {
    for (const file of speechModelFiles) {
      const name = path.join(directory, file.name);
      if ((await stat(name)).size !== file.size) return false;
      if (verify) {
        const hash = createHash("sha256");
        for await (const buffer of createReadStream(name)) hash.update(buffer);
        if (hash.digest("hex") !== file.sha) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Native inference lives in a separate process. Killing an active ONNX worker
 * thread can abort Electron; process isolation makes cancellation safe. */
export class Speech {
  private busy = false;
  private verified = new Set<string>();
  constructor(
    private options: {
      directory: string;
      modelDirectory: string;
      workerPath: string;
      voicesDirectory: string;
      jobs: Jobs;
    },
  ) {}
  private get downloadedModel() {
    return path.join(this.options.directory, "model");
  }
  private async assertVoices() {
    if (!(await validVoices(this.options.voicesDirectory)))
      throw Error(
        "Kokoro's bundled voice files are missing or damaged. Reinstall Cutline to restore them. Downloading the model cannot repair these files.",
      );
  }
  async status(): Promise<TtsStatus> {
    await this.assertVoices();
    return {
      ready:
        (await validModel(this.options.modelDirectory)) ||
        (await validModel(this.downloadedModel)),
      engine: "Kokoro 82M",
      downloadMB: Math.ceil(totalBytes / 1000000),
      voices: speechVoices,
      defaultVoice: "af_heart",
      defaultSpeed: 1.08,
    };
  }
  private async resolveModel(job: Job) {
    checkCancelled(job);
    await this.assertVoices();
    for (const directory of [
      this.options.modelDirectory,
      this.downloadedModel,
    ]) {
      checkCancelled(job);
      if (await validModel(directory, !this.verified.has(directory))) {
        this.verified.add(directory);
        return directory;
      }
    }
    const controller = new AbortController();
    this.options.jobs.cancellers.set(job.id, () => controller.abort());
    let completed = 0;
    try {
      for (const file of speechModelFiles) {
        checkCancelled(job);
        const target = path.join(this.downloadedModel, file.name);
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.part`;
        const handle = await open(temporary, "wx");
        try {
          this.options.jobs.update(job, {
            message: "Downloading Kokoro voice engine…",
            progress: completed / totalBytes,
          });
          const response = await fetch(
            `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${speechModelRevision}/${file.name}`,
            {
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(180000),
              ]),
            },
          );
          if (!response.ok || !response.body)
            throw Error(
              `Voice engine download failed (${response.status}). Check your connection and try again.`,
            );
          let received = 0;
          const hash = createHash("sha256");
          for await (const chunk of response.body) {
            checkCancelled(job);
            received += chunk.length;
            if (received > file.size)
              throw Error("Voice engine download has an unexpected size.");
            hash.update(chunk);
            await handle.writeFile(chunk);
            this.options.jobs.update(job, {
              progress: Math.min(0.99, (completed + received) / totalBytes),
              message: `Downloading Kokoro · ${Math.round((completed + received) / 1000000)} of ${Math.ceil(totalBytes / 1000000)} MB`,
            });
          }
          if (received !== file.size || hash.digest("hex") !== file.sha)
            throw Error(
              "Voice engine download was incomplete. Please try again.",
            );
          checkCancelled(job);
          await handle.close();
          await rename(temporary, target);
          completed += received;
        } finally {
          await handle.close().catch(() => {});
          await unlink(temporary).catch(() => {});
        }
      }
      this.verified.add(this.downloadedModel);
      return this.downloadedModel;
    } finally {
      this.options.jobs.cancellers.delete(job.id);
    }
  }
  async setup(): Promise<TtsStatus> {
    if (this.busy) throw Error("A voice operation is already running.");
    this.busy = true;
    try {
      await this.options.jobs.run("tts-setup", "Preparing Kokoro…", (job) =>
        this.resolveModel(job),
      );
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  async generate(
    value: unknown,
  ): Promise<{ path: string; duration: number; text: string; voice: string }> {
    const input = SpeechInputSchema.parse(value);
    speechChunks(input.text);
    if (this.busy)
      throw Error(
        "A voice operation is already running. Wait or cancel it first.",
      );
    this.busy = true;
    const filename = `${
      (input.name || "Voiceover")
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .trim()
        .slice(0, 60) || "Voiceover"
    } - ${randomUUID().slice(0, 8)}.wav`;
    const target = path.join(this.options.directory, filename),
      temporary = `${target}.part`;
    let committed = false;
    try {
      return await this.options.jobs.run(
        "tts",
        "Preparing voiceover…",
        async (job) => {
          const modelDirectory = await this.resolveModel(job);
          checkCancelled(job);
          await mkdir(this.options.directory, { recursive: true });
          const duration = await new Promise<number>((resolve, reject) => {
            const child = fork(this.options.workerPath, [], {
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              execArgv: [],
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            });
            this.options.jobs.processes.set(job.id, child);
            let settled = false,
              duration: number | undefined,
              failure: Error | undefined,
              stderr = "";
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              this.options.jobs.cancellers.delete(job.id);
              this.options.jobs.processes.delete(job.id);
              if (error) reject(error);
              else resolve(duration!);
            };
            const stop = (error: Error) => {
              failure = error;
              // SIGKILL avoids native-addon teardown during an in-flight call.
              // Wait for exit before removing partial files or allowing a retry.
              child.kill("SIGKILL");
            };
            this.options.jobs.cancellers.set(job.id, () =>
              stop(Error("Cancelled")),
            );
            child.stderr?.on("data", (data) => {
              stderr = (stderr + data).slice(-2000);
            });
            child.on("message", (data: any) => {
              if (job.state === "cancelled") return stop(Error("Cancelled"));
              if (data.error) return stop(Error(String(data.error)));
              if (data.done) {
                if (!Number.isFinite(data.duration) || data.duration <= 0)
                  return stop(Error("Voice generation returned empty audio."));
                duration = data.duration;
              } else if (typeof data.progress === "number") {
                this.options.jobs.update(job, {
                  progress: Math.max(0, Math.min(0.99, data.progress)),
                  message: String(data.message),
                });
              }
            });
            child.on("error", (error) => finish(error));
            child.on("exit", (code) => {
              if (job.state === "cancelled") return finish(Error("Cancelled"));
              finish(
                failure ??
                  (code === 0 && duration !== undefined
                    ? undefined
                    : Error(
                        stderr.trim() ||
                          `Voice engine stopped (${code}). Try again.`,
                      )),
              );
            });
            child.send(
              { modelDirectory, output: temporary, input },
              (error) => {
                if (error && !settled) stop(error);
              },
            );
          });
          checkCancelled(job);
          await rename(temporary, target);
          committed = true;
          return {
            path: target,
            duration,
            text: input.text,
            voice: input.voice,
          };
        },
      );
    } finally {
      this.busy = false;
      if (!committed) await unlink(temporary).catch(() => {});
    }
  }
}
