import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  uid,
  type Asset,
  type Project,
  type Word,
  type Job,
} from "../shared/model";

export type ExecOptions = {
  /** Receives raw output as it arrives instead of collecting it as text. */
  stdout?: (chunk: Buffer) => void;
  /** Receives each complete line of standard error as it arrives. */
  stderrLine?: (line: string) => void;
};
export class Jobs {
  jobs = new Map<string, Job>();
  processes = new Map<string, ChildProcess>();
  cancellers = new Map<string, () => void>();
  private scope = new AsyncLocalStorage<string>();
  private parents = new Map<string, string>();
  constructor(private changed: (j: Job) => void) {}
  create(kind: string, message: string) {
    const parent = this.scope.getStore();
    if (parent && this.jobs.get(parent)?.state === "cancelled")
      throw Error("Cancelled");
    const j: Job = { id: uid(), kind, state: "running", progress: 0, message };
    if (parent) this.parents.set(j.id, parent);
    this.jobs.set(j.id, j);
    this.changed(j);
    return j;
  }
  update(j: Job, patch: Partial<Job>) {
    const shown = `${j.state}|${j.message}|${j.output}|${Math.round(j.progress * 100)}`;
    Object.assign(j, patch);
    // Progress arrives many times a second and the editor redraws for each
    // message, so only a whole-percent step or a real change is sent.
    if (`${j.state}|${j.message}|${j.output}|${Math.round(j.progress * 100)}` !== shown)
      this.changed(j);
  }
  cancel(id: string) {
    const j = this.jobs.get(id);
    if (!j || j.state !== "running") return;
    this.update(j, { state: "cancelled", message: "Cancelled" });
    for (const [child, parent] of this.parents)
      if (parent === id) this.cancel(child);
    const cancel = this.cancellers.get(id);
    if (cancel) cancel();
    else this.processes.get(id)?.kill("SIGTERM");
  }
  async run<T>(kind: string, message: string, fn: (j: Job) => Promise<T>) {
    const j = this.create(kind, message);
    try {
      const value = await this.scope.run(j.id, () => fn(j));
      if (j.state === "cancelled") throw Error("Cancelled");
      this.update(j, { state: "done", progress: 1, message: "Complete" });
      return value;
    } catch (e) {
      if (j.state !== "cancelled")
        this.update(j, { state: "error", message: (e as Error).message });
      throw e;
    } finally {
      this.processes.delete(j.id);
      this.cancellers.delete(j.id);
      this.parents.delete(j.id);
    }
  }
  /** Runs fn outside any running job, so work it starts is not tied to that job. */
  detached<T>(fn: () => T): T {
    return this.scope.exit(fn);
  }
  exec(
    bin: string,
    args: string[],
    j?: Job,
    options: ExecOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (j?.state === "cancelled") return reject(Error("Cancelled"));
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      if (j) this.processes.set(j.id, child);
      let stdout = "",
        stderr = "",
        partial = "",
        failure: Error | undefined;
      // A failing reader stops the process instead of crashing the app.
      const guard = (read: () => void) => {
        if (failure) return;
        try {
          read();
        } catch (error) {
          failure = error as Error;
          child.kill("SIGTERM");
        }
      };
      if (options.stdout) {
        const read = options.stdout;
        child.stdout.on("data", (d: Buffer) => guard(() => read(d)));
      } else {
        child.stdout.setEncoding("utf8");
        child.stdout.on(
          "data",
          (d: string) => (stdout = (stdout + d).slice(-30_000_000)),
        );
      }
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        stderr = (stderr + d).slice(-100_000);
        const m = d.match(/progress\s*=\s*(\d+)%/);
        if (m && j) this.update(j, { progress: Number(m[1]) / 100 });
        const line = options.stderrLine;
        if (line) {
          const lines = (partial + d).split(/\r\n|\n|\r/);
          partial = lines.pop() ?? "";
          guard(() => lines.forEach((text) => line(text)));
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (options.stderrLine && partial) {
          const line = options.stderrLine,
            text = partial;
          guard(() => line(text));
        }
        if (failure) reject(failure);
        else if (code === 0) resolve({ stdout, stderr });
        else
          reject(
            Error(
              j?.state === "cancelled"
                ? "Cancelled"
                : stderr.slice(-1800) || `${path.basename(bin)} exited ${code}`,
            ),
          );
      });
    });
  }
}

/** What ffprobe says about a file, without decoding it. */
export type MediaProbe = {
  kind: Asset["kind"];
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  /** Has a picture to show: video frames or an image, not album art. */
  hasPicture: boolean;
  /** The editor plays a lighter copy of this video. */
  needsProxy: boolean;
};
/** A preview file finished in the background for an asset. */
export type PreviewReady = {
  assetId: string;
  path: string;
  proxy?: string;
  thumbnail?: string;
  reversed?: string;
};

/** Memory one reversing pass may hold: ffmpeg's reverse keeps every frame of a pass. */
const reverseBudget = 384 * 1024 * 1024;
/**
 * Frames per reversing pass. Footage is reversed in pieces that each fit the
 * memory budget, then the pieces are joined last one first.
 */
export function reverseChunks(
  frames: number,
  frameBytes: number,
  budget: number,
) {
  const size = Math.max(1, Math.floor(budget / Math.max(1, frameBytes)));
  const chunks: { start: number; count: number }[] = [];
  for (let start = 0; start < frames; start += size)
    chunks.push({ start, count: Math.min(size, frames - start) });
  return chunks;
}
/** Frames per second from ffprobe's "30000/1001" form. */
const rate = (value?: string) => {
  const [n, d] = String(value ?? "")
    .split("/")
    .map(Number);
  return n > 0 && (d || 1) > 0 ? n / (d || 1) : 0;
};

const waveformRate = 8000,
  waveformBuckets = 160,
  keptTranscripts = 20;
const proxyScale =
  "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
/** Preview and reversed copies kept on disk before the oldest are removed. */
const MEDIA_CACHE_CAP = 8 * 1024 ** 3;
const removeQuietly = (files: string[]) =>
  Promise.all(files.map((file) => unlink(file).catch(() => {})));
/** A finished, non-empty file. */
const made = (file: string) => {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
};
/** Matches ffmpeg's plain and exponent number formats, such as 12.5 or 1e-05. */
const timeIn = (line: string, key: string) => {
  const match = line.match(
    new RegExp(`${key}: (-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)`),
  );
  return match ? Number(match[1]) : undefined;
};

export class Media extends EventEmitter {
  private transcripts = new Map<string, Word[]>();
  /** Preview work by asset id and source path, for this session. */
  private proxyNeeded = new Map<string, boolean>();
  private previewWork = new Set<string>();
  /** Tried once per session, so a file that can't be read is not retried on every edit. */
  private previewTried = new Set<string>();
  private previewQueue: Promise<void> = Promise.resolve();
  /** Reversed copies being made, so two requests share one job. */
  private reversing = new Map<string, Promise<string>>();
  constructor(
    readonly cache: string,
    readonly bin: {
      ffmpeg: string;
      ffprobe: string;
      whisper: string;
      model: string;
    },
    readonly jobs: Jobs,
  ) {
    super();
  }
  /**
   * Deletes leftovers that earlier versions wrote and never removed: raw
   * waveform dumps, audio copies made for transcription, and broken or
   * unfinished preview copies. Only files from before `since` are touched,
   * and thumbnails and finished previews stay, because projects use them.
   */
  async cleanCache(
    since = Date.now(),
    keep: string[] = [],
    cap = MEDIA_CACHE_CAP,
  ) {
    let names: string[];
    try {
      names = await readdir(this.cache);
    } catch {
      return 0;
    }
    let removed = 0;
    // Preview and reversed copies of everything ever imported add up to
    // gigabytes. Past the cap the oldest ones the open project does not use
    // are deleted; a project that needs one again rebuilds it.
    const copies: { file: string; size: number; time: number }[] = [];
    const kept = new Set(keep.map((file) => path.resolve(file)));
    for (const name of names) {
      if (!/-(proxy|reversed)\.(mp4|m4a)$/i.test(name)) continue;
      const file = path.join(this.cache, name);
      try {
        const info = await stat(file);
        if (info.isFile() && !kept.has(path.resolve(file)))
          copies.push({ file, size: info.size, time: Math.max(info.atimeMs, info.mtimeMs) });
      } catch {
        /* Already gone. */
      }
    }
    let total = copies.reduce((sum, copy) => sum + copy.size, 0);
    for (const copy of copies.sort((a, b) => a.time - b.time)) {
      if (total <= cap) break;
      try {
        await unlink(copy.file);
        total -= copy.size;
        removed++;
      } catch {
        /* In use or gone: leave it. */
      }
    }
    for (const name of names) {
      const temporary =
        /\.(f32|wav|part|part\.jpg)$/i.test(name) ||
        /\.wav\.transcript\.json$/i.test(name);
      const preview = /-proxy\.mp4$/i.test(name);
      if (!temporary && !preview) continue;
      const file = path.join(this.cache, name);
      try {
        const info = await stat(file);
        if (!info.isFile() || info.mtimeMs >= since) continue;
        if (preview && info.size > 0) continue;
        await unlink(file);
        removed++;
      } catch {
        /* Already gone. */
      }
    }
    return removed;
  }
  /** Reads a file's streams and duration. Fast: nothing is decoded. */
  async probe(file: string, j?: Job): Promise<MediaProbe> {
    const { stdout } = await this.jobs.exec(
      this.bin.ffprobe,
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
      j,
    );
    const info = JSON.parse(stdout);
    const streams: any[] = Array.isArray(info.streams) ? info.streams : [];
    // Album art inside a music file is a still picture, not video.
    const v = streams.find(
      (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
    );
    const hasAudio = streams.some((s) => s.codec_type === "audio");
    const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file);
    if (!v && !hasAudio)
      throw Error("This file has no supported video, image, or audio stream");
    const kind = isImage ? "image" : v ? "video" : "audio";
    const width = v?.width,
      height = v?.height;
    return {
      kind,
      duration: isImage ? 4 : Number(info.format?.duration || v?.duration || 0),
      width,
      height,
      hasAudio,
      hasPicture: !!v,
      needsProxy:
        kind === "video" &&
        (height > 1080 ||
          width > 1920 ||
          !["h264", "vp8", "vp9"].includes(v.codec_name) ||
          /\.(mkv|avi)$/i.test(file)),
    };
  }
  /**
   * Reads a file into a new asset: details, a thumbnail and a waveform. A
   * lighter preview copy, when the video needs one, is made afterwards in the
   * background by ensurePreviews, so the asset is usable right away.
   */
  async import(file: string, options: { id?: string } = {}): Promise<Asset> {
    return this.jobs.run(
      "import",
      `Importing ${path.basename(file)}`,
      async (j) => {
        await mkdir(this.cache, { recursive: true });
        const probe = await this.probe(file, j);
        const id = options.id ?? uid();
        const a: Asset = {
          id,
          name: path.basename(file),
          path: file,
          kind: probe.kind,
          duration: probe.duration,
          width: probe.width,
          height: probe.height,
          hasAudio: probe.hasAudio,
        };
        if (
          a.kind !== "image" &&
          (!Number.isFinite(a.duration) || a.duration <= 0)
        )
          throw Error("Unable to read media duration");
        const created: string[] = [];
        try {
          if (probe.hasPicture) {
            const thumbnail = path.join(this.cache, id + ".jpg");
            created.push(thumbnail);
            await this.thumbnail(file, thumbnail, j);
            a.thumbnail = thumbnail;
          }
          if (a.hasAudio) a.waveform = await this.waveform(file, a.duration, j);
        } catch (error) {
          // A failed or cancelled import leaves nothing behind in the cache.
          await removeQuietly(created);
          throw error;
        }
        this.proxyNeeded.set(`${id}\n${file}`, probe.needsProxy);
        return a;
      },
    );
  }
  private async thumbnail(file: string, output: string, j?: Job) {
    await this.jobs.exec(
      this.bin.ffmpeg,
      [
        "-y",
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:V:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=240:-2",
        output,
      ],
      j,
    );
  }
  /** Peak levels for the timeline, read straight from ffmpeg without a temporary file. */
  private async waveform(file: string, duration: number, j: Job) {
    const expected = Math.max(1, Math.round(duration * waveformRate));
    const step = Math.max(1, Math.floor(expected / waveformBuckets));
    const peaks = new Array<number>(waveformBuckets).fill(0);
    let count = 0,
      rest = Buffer.alloc(0);
    await this.jobs.exec(
      this.bin.ffmpeg,
      [
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        String(waveformRate),
        "-f",
        "f32le",
        "pipe:1",
      ],
      j,
      {
        stdout: (chunk) => {
          const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
          const whole = data.length - (data.length % 4);
          // Copy into an aligned buffer; stream chunks can start at any byte.
          const values = new Float32Array(
            data.buffer.slice(data.byteOffset, data.byteOffset + whole),
          );
          for (const value of values) {
            const bucket = Math.min(
              waveformBuckets - 1,
              Math.floor(count / step),
            );
            const level = Math.abs(value);
            if (level > peaks[bucket]) peaks[bucket] = level;
            count++;
          }
          rest = Buffer.from(data.subarray(whole));
        },
      },
    );
    return peaks.slice(0, Math.min(waveformBuckets, count));
  }
  /** Identifies a file's current contents, so a changed file is transcribed again. */
  private fileKey(file: string) {
    try {
      const info = statSync(file);
      return `${file}\n${info.size}\n${info.mtimeMs}`;
    } catch {
      return undefined;
    }
  }
  async transcribe(a: Asset): Promise<Word[]> {
    if (!a.hasAudio) throw Error("This media has no audio");
    if (!existsSync(this.bin.whisper) || !existsSync(this.bin.model))
      throw Error(
        "Local speech model is missing. Open Settings to install it.",
      );
    // A retry after an interrupted edit reuses the finished transcript.
    const key = this.fileKey(a.path);
    const known = key && this.transcripts.get(key);
    if (known) return structuredClone(known);
    return this.jobs.run(
      "transcribe",
      `Transcribing ${a.name} locally`,
      async (j) => {
        await mkdir(this.cache, { recursive: true });
        const wav = path.join(this.cache, uid() + ".wav");
        const out = wav + ".transcript";
        try {
          await this.jobs.exec(
            this.bin.ffmpeg,
            [
              "-y",
              "-v",
              "error",
              "-i",
              a.path,
              "-vn",
              "-sn",
              "-dn",
              "-ar",
              "16000",
              "-ac",
              "1",
              "-c:a",
              "pcm_s16le",
              wav,
            ],
            j,
          );
          await this.jobs.exec(
            this.bin.whisper,
            [
              "-m",
              this.bin.model,
              "-f",
              wav,
              "-l",
              "auto",
              "-ojf",
              "-of",
              out,
              "-ml",
              "1",
              "-sow",
              "-pp",
            ],
            j,
          );
          const json = JSON.parse(await readFile(out + ".json", "utf8"));
          const words: Word[] = (json.transcription ?? []).flatMap((s: any) => {
            const text = String(s.text).trim();
            if (!text || text.startsWith("[")) return [];
            return [
              {
                text,
                start: s.offsets.from / 1000,
                end: s.offsets.to / 1000,
              },
            ];
          });
          if (key) {
            this.transcripts.delete(key);
            this.transcripts.set(key, structuredClone(words));
            for (const old of this.transcripts.keys()) {
              if (this.transcripts.size <= keptTranscripts) break;
              this.transcripts.delete(old);
            }
          }
          return words;
        } finally {
          // The audio copy is about 115 MB per hour; never keep it.
          await removeQuietly([wav, out + ".json"]);
        }
      },
    );
  }
  async silences(a: Asset) {
    if (!a.hasAudio)
      throw Error("This clip has no sound, so there are no pauses to remove.");
    return this.jobs.run("analyze", "Finding pauses locally", async (j) => {
      const result: { start: number; end: number }[] = [];
      let start: number | undefined;
      // Read every line as it arrives: a long recording reports thousands of
      // pauses, more than any saved tail of the output would hold.
      await this.jobs.exec(
        this.bin.ffmpeg,
        [
          "-hide_banner",
          "-nostats",
          "-i",
          a.path,
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-af",
          "silencedetect=noise=-35dB:d=0.55",
          "-f",
          "null",
          "-",
        ],
        j,
        {
          stderrLine: (line) => {
            const begins = timeIn(line, "silence_start"),
              ends = timeIn(line, "silence_end");
            if (begins !== undefined) start = Math.max(0, begins);
            if (ends !== undefined && start !== undefined) {
              result.push({ start, end: ends });
              start = undefined;
            }
          },
        },
      );
      return result;
    });
  }
  /**
   * Makes missing preview files for the open project's assets, one at a time
   * in the background: lighter copies of heavy videos, and proxies or
   * thumbnails whose files were deleted. Emits "preview" with each result.
   */
  ensurePreviews(assets: Asset[]) {
    for (const asset of assets) {
      if (asset.kind === "audio") continue;
      const key = `${asset.id}\n${asset.path}`;
      const wantsProxy =
        asset.kind === "video" &&
        !asset.proxy &&
        this.proxyNeeded.get(key) !== false;
      if (!wantsProxy && asset.thumbnail) continue;
      if (this.previewWork.has(key) || this.previewTried.has(key)) continue;
      if (!existsSync(asset.path)) continue;
      this.previewWork.add(key);
      const work = { ...asset };
      // Background work belongs to no edit, so cancelling an edit never stops it.
      this.jobs.detached(() => {
        this.previewQueue = this.previewQueue
          .then(() => this.buildPreview(work))
          .catch(() => {
            /* The editor keeps playing the original. */
          })
          .finally(() => {
            this.previewWork.delete(key);
            this.previewTried.add(key);
          });
      });
    }
  }
  /**
   * Makes the reversed copies that reversed clips play, one at a time in the
   * background, and emits "preview" with each. A failed copy is not retried
   * this session; export tries again and reports why.
   */
  ensureReversed(project: Project) {
    const wanted = new Set(
      project.clips.filter((c) => c.reverse && c.assetId).map((c) => c.assetId),
    );
    for (const asset of project.assets) {
      if (!wanted.has(asset.id) || asset.kind === "image") continue;
      if (asset.reversed && existsSync(asset.reversed)) continue;
      const key = `${asset.id}\n${asset.path}\nreversed`;
      if (this.previewWork.has(key) || this.previewTried.has(key)) continue;
      if (!existsSync(asset.path)) continue;
      this.previewWork.add(key);
      const work = { ...asset };
      this.jobs.detached(() => {
        this.previewQueue = this.previewQueue
          .then(async () => {
            const reversed = await this.reversedCopy(work);
            this.emit("preview", {
              assetId: work.id,
              path: work.path,
              reversed,
            } satisfies PreviewReady);
          })
          .catch(() => {
            this.previewTried.add(key);
          })
          .finally(() => this.previewWork.delete(key));
      });
    }
  }
  /**
   * A copy of the media that plays backwards, picture and sound. The picture
   * is reversed in pieces that fit the memory budget and joined last piece
   * first; the sound is reversed in one pass, trimmed to the picture so both
   * stay in step. Copies are named after the source file, so they are reused.
   */
  reversedCopy(asset: Asset, options: { budget?: number } = {}) {
    const file = this.previewFile(
      asset.path,
      asset.kind === "audio" ? "-reversed.m4a" : "-reversed.mp4",
    );
    if (made(file)) return Promise.resolve(file);
    const running = this.reversing.get(file);
    if (running) return running;
    const work = this.jobs
      .run("preview", `Reversing ${asset.name}`, (j) =>
        this.reverse(asset, file, options.budget ?? reverseBudget, j),
      )
      .finally(() => this.reversing.delete(file));
    this.reversing.set(file, work);
    return work;
  }
  private async reverse(asset: Asset, file: string, budget: number, j: Job) {
    await mkdir(this.cache, { recursive: true });
    const stem = `${file}.${uid()}`;
    const parts: string[] = [];
    const part = (name: string) => {
      const created = `${stem}.${name}.part`;
      parts.push(created);
      return created;
    };
    const ffmpeg = (args: string[]) =>
      this.jobs.exec(
        this.bin.ffmpeg,
        ["-y", "-v", "error", "-nostdin", ...args],
        j,
      );
    try {
      const { stdout } = await this.jobs.exec(
        this.bin.ffprobe,
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          asset.path,
        ],
        j,
      );
      const info = JSON.parse(stdout);
      const streams: any[] = Array.isArray(info.streams) ? info.streams : [];
      const v =
        asset.kind === "video"
          ? streams.find(
              (s) =>
                s.codec_type === "video" && s.disposition?.attached_pic !== 1,
            )
          : undefined;
      const hasAudio = streams.some((s) => s.codec_type === "audio");
      let video: string | undefined, length: number;
      if (v) {
        const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30;
        const seconds = Number(
          v.duration || info.format?.duration || asset.duration,
        );
        const frames = Math.max(
          1,
          Number(v.nb_frames) || Math.round(seconds * fps),
        );
        length = frames / fps;
        // Decoded frames, at up to four bytes a pixel; 1080p when unknown.
        const frameBytes = (v.width || 1920) * (v.height || 1080) * 4;
        const chunks = reverseChunks(frames, frameBytes, budget);
        const pieces: string[] = [];
        for (const [index, chunk] of chunks.entries()) {
          const piece = part(`v${index}`);
          // Read only this piece: from a quarter frame early, so rounding
          // never skips its first frame, to just past its last. trim ends the
          // stream there, so reverse holds this piece and nothing more.
          await ffmpeg([
            "-ss",
            String(Math.max(0, (chunk.start - 0.25) / fps)),
            "-t",
            String((chunk.count + 0.5) / fps),
            "-i",
            asset.path,
            "-map",
            `0:${v.index}`,
            "-vf",
            `trim=end_frame=${chunk.count},setpts=PTS-STARTPTS,reverse`,
            "-frames:v",
            String(chunk.count),
            "-r",
            String(fps),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "14",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "mp4",
            piece,
          ]);
          pieces.unshift(piece);
          this.jobs.update(j, {
            progress: Math.min(0.9, ((index + 1) / chunks.length) * 0.9),
          });
        }
        const list = part("list");
        await writeFile(
          list,
          pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
        );
        video = part("video");
        await ffmpeg([
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-c",
          "copy",
          "-f",
          "mp4",
          video,
        ]);
      } else length = asset.duration;
      let sound: string | undefined;
      if (hasAudio) {
        sound = part("audio");
        // Padded or trimmed to the picture, so the reversed sound starts in step.
        await ffmpeg([
          "-i",
          asset.path,
          "-map",
          "0:a:0",
          "-vn",
          "-af",
          `apad=whole_dur=${length},atrim=0:${length},areverse`,
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-f",
          "mp4",
          sound,
        ]);
      }
      if (!video && !sound) throw Error("Nothing to reverse");
      const joined = part("joined");
      await ffmpeg([
        ...(video ? ["-i", video] : []),
        ...(sound ? ["-i", sound] : []),
        ...(video ? ["-map", "0:v:0"] : []),
        ...(sound ? ["-map", `${video ? 1 : 0}:a:0`] : []),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        joined,
      ]);
      await rename(joined, file);
      return file;
    } catch (error) {
      if (j.state === "cancelled") throw error;
      throw Error(
        `Couldn't reverse ${asset.name}: ${(error as Error).message.split("\n")[0]}`,
      );
    } finally {
      await removeQuietly(parts);
    }
  }
  /** Resolves once every queued preview is finished. */
  async previewsIdle() {
    let current: Promise<void>;
    do {
      current = this.previewQueue;
      await current;
    } while (current !== this.previewQueue);
  }
  /**
   * Preview files are named after the source file's identity, so a later
   * session, or another project using the same file, reuses them.
   */
  private previewFile(source: string, suffix: string) {
    const identity = this.fileKey(source) ?? source;
    const name = createHash("sha256").update(identity).digest("hex");
    return path.join(this.cache, `${name.slice(0, 20)}${suffix}`);
  }
  private async buildPreview(asset: Asset) {
    if (!existsSync(asset.path)) return;
    const key = `${asset.id}\n${asset.path}`;
    const ready: PreviewReady = { assetId: asset.id, path: asset.path };
    await mkdir(this.cache, { recursive: true });
    if (!asset.thumbnail) {
      const thumbnail = this.previewFile(asset.path, ".jpg");
      try {
        if (!made(thumbnail)) {
          const temporary = `${thumbnail}.${uid()}.part.jpg`;
          try {
            await this.thumbnail(asset.path, temporary);
            await rename(temporary, thumbnail);
          } finally {
            await removeQuietly([temporary]);
          }
        }
        ready.thumbnail = thumbnail;
      } catch {
        /* The media bin shows its placeholder instead. */
      }
    }
    try {
      if (asset.kind === "video" && !asset.proxy) {
        let needed = this.proxyNeeded.get(key);
        if (needed === undefined) {
          needed = (await this.probe(asset.path)).needsProxy;
          this.proxyNeeded.set(key, needed);
        }
        if (needed) ready.proxy = await this.proxy(asset);
      }
    } finally {
      if (ready.proxy || ready.thumbnail) this.emit("preview", ready);
    }
  }
  /** A light H.264 copy that plays smoothly in the editor. Export always uses the original. */
  private async proxy(asset: Asset) {
    const file = this.previewFile(asset.path, "-proxy.mp4");
    if (made(file)) return file;
    return this.jobs.run(
      "preview",
      `Preparing a smooth preview of ${asset.name}`,
      async (j) => {
        const temporary = `${file}.${uid()}.part`;
        const encode = (hardware: boolean) =>
          this.jobs.exec(
            this.bin.ffmpeg,
            [
              "-y",
              "-v",
              "error",
              "-nostats",
              "-progress",
              "pipe:2",
              // Without -xerror, a codec the media engine cannot decode
              // (MPEG-4 Part 2) still exits 0 with no video at all.
              ...(hardware ? ["-xerror", "-hwaccel", "videotoolbox"] : []),
              "-i",
              asset.path,
              "-map",
              "0:V:0",
              "-map",
              "0:a:0?",
              "-vf",
              proxyScale,
              // The Mac's media engine uses about a quarter of the CPU the
              // software encoder needs, which matters with other work running.
              ...(hardware
                ? ["-c:v", "h264_videotoolbox", "-b:v", "4M", "-allow_sw", "1"]
                : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "26"]),
              "-c:a",
              "aac",
              "-movflags",
              "+faststart",
              "-f",
              "mp4",
              temporary,
            ],
            j,
            {
              stderrLine: (line) => {
                const done = line.match(/^out_time_(?:us|ms)=(\d+)/);
                if (done && asset.duration > 0)
                  this.jobs.update(j, {
                    progress: Math.min(
                      0.99,
                      Number(done[1]) / 1e6 / asset.duration,
                    ),
                  });
              },
            },
          );
        try {
          try {
            await encode(true);
          } catch (error) {
            if (j.state === "cancelled") throw error;
            await encode(false);
          }
          await rename(temporary, file);
          return file;
        } catch (error) {
          await removeQuietly([temporary]);
          if (j.state === "cancelled") throw error;
          throw Error(
            `Couldn't make a preview copy of ${asset.name}. It plays from the original instead.`,
          );
        }
      },
    );
  }
}
