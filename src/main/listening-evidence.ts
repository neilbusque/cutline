import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../shared/model";
import type {
  AudioMeasurements,
  AudioRole,
  ListeningEvidence,
  ListeningWord,
} from "../shared/listening-plan";

export type CollectListeningEvidenceOptions = {
  project: Project;
  mediaPath: string;
  ffmpeg: string;
  whisperPath: string;
  whisperModelPath: string;
  workDir: string;
  stems?: Partial<Record<AudioRole, string>>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};
const abortError = () => Error("Listening review cancelled");
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}
async function run(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  onData?: (chunk: Buffer) => void,
) {
  check(signal);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "",
      failure: Error | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      timer.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        onData?.(chunk);
      } catch (e) {
        failure = e instanceof Error ? e : Error(String(e));
        abort();
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-1_000_000);
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(abortError());
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(
          Error(
            `${path.basename(bin)} audio analysis failed: ${stderr.slice(-1200)}`,
          ),
        );
      else resolve(stderr);
    });
  });
}
const db = (value: number) => 20 * Math.log10(Math.max(1e-10, value));
/** Constant-memory PCM processing except for a bounded activity envelope. */
export async function measureListeningAudio(
  options: Pick<CollectListeningEvidenceOptions, "ffmpeg" | "signal"> & {
    path: string;
    durationSeconds: number;
  },
): Promise<AudioMeasurements> {
  const { durationSeconds } = options;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 21600
  )
    throw Error(
      "Local audio measurement supports complete timelines up to six hours.",
    );
  const rate = 48000,
    channels = 2;
  const stepSeconds = Math.max(
    0.02,
    Math.ceil(durationSeconds / 180000 / 0.02) * 0.02,
  );
  const bucketSamples = Math.round(stepSeconds * rate) * channels;
  const rmsDbfs: number[] = [],
    peakDbfs: number[] = [];
  let rest = Buffer.alloc(0),
    count = 0,
    bucketCount = 0,
    sum = 0,
    peak = 0,
    totalPeak = 0,
    clippedSampleCount = 0;
  const flush = () => {
    if (!bucketCount) return;
    rmsDbfs.push(db(Math.sqrt(sum / bucketCount)));
    peakDbfs.push(db(peak));
    bucketCount = 0;
    sum = 0;
    peak = 0;
  };
  await run(
    options.ffmpeg,
    [
      "-hide_banner",
      "-v",
      "error",
      "-nostdin",
      "-i",
      options.path,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(durationSeconds + 0.1),
      "-ac",
      String(channels),
      "-ar",
      String(rate),
      "-f",
      "f32le",
      "pipe:1",
    ],
    options.signal,
    (chunk) => {
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const whole = data.length - (data.length % 4);
      for (let offset = 0; offset < whole; offset += 4) {
        const sample = data.readFloatLE(offset);
        if (!Number.isFinite(sample))
          throw Error("Decoded audio contains non-finite samples.");
        const absolute = Math.abs(sample);
        totalPeak = Math.max(totalPeak, absolute);
        peak = Math.max(peak, absolute);
        sum += sample * sample;
        bucketCount++;
        count++;
        if (absolute >= 0.9999) clippedSampleCount++;
        if (bucketCount === bucketSamples) flush();
        if (count > (durationSeconds + 0.2) * rate * channels)
          throw Error(
            "Decoded audio exceeded the bounded measurement duration.",
          );
      }
      rest = Buffer.from(data.subarray(whole));
    },
  );
  flush();
  if (!count || rest.length)
    throw Error("Decoded audio is empty or malformed.");
  const loud = await run(
    options.ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-nostdin",
      "-i",
      options.path,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(durationSeconds + 0.1),
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
    options.signal,
  );
  const summary = loud.split("Summary:").at(-1) ?? "";
  const read = (regex: RegExp) => {
    const value = Number(regex.exec(summary)?.[1]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    integratedLufs: read(/I:\s+(-?[\d.]+)\s+LUFS/u),
    truePeakDbtp: read(/Peak:\s+(-?[\d.]+)\s+dBFS/u),
    samplePeakDbfs: db(totalPeak),
    clippedSampleCount,
    analyzedSeconds: count / (rate * channels),
    complete: count / (rate * channels) >= durationSeconds - 0.06,
    activity: { stepSeconds, rmsDbfs, peakDbfs },
  };
}

/** Whisper DTW is an acoustic anchor, not an exact word onset or offset. */
export function parseListeningAlignment(
  raw: unknown,
  durationSeconds: number,
): ListeningWord[] {
  const input = raw as {
    transcription?: Array<{
      tokens?: Array<{
        text?: unknown;
        offsets?: { from?: unknown; to?: unknown };
        t_dtw?: unknown;
        p?: unknown;
      }>;
    }>;
  };
  const words: ListeningWord[] = [];
  for (const segment of input?.transcription ?? []) {
    for (const token of segment.tokens ?? []) {
      const text = String(token.text ?? "");
      if (!text.trim() || /^\s*\[.*\]\s*$/u.test(text)) continue;
      const anchor = Number(token.t_dtw) / 100,
        start = Number(token.offsets?.from) / 1000,
        stop = Number(token.offsets?.to) / 1000,
        confidence = Number(token.p);
      if (
        !Number.isFinite(anchor) ||
        anchor < 0 ||
        anchor > durationSeconds ||
        !Number.isFinite(start) ||
        !Number.isFinite(stop) ||
        stop < start ||
        !Number.isFinite(confidence)
      )
        continue;
      const previous = words.at(-1);
      if (previous && !/^\s/u.test(text)) {
        previous.text += text;
        previous.endSeconds = Math.max(previous.endSeconds, stop);
        previous.lastAnchorSeconds = Math.max(
          previous.lastAnchorSeconds,
          anchor,
        );
        previous.confidence = Math.min(previous.confidence, confidence);
      } else
        words.push({
          text: text.trim(),
          startSeconds: Math.max(0, start),
          endSeconds: Math.min(durationSeconds, stop),
          anchorSeconds: anchor,
          lastAnchorSeconds: anchor,
          confidence,
        });
    }
  }
  return words.filter(
    (w) =>
      /[\p{L}\p{N}]/u.test(w.text) &&
      w.endSeconds > w.startSeconds &&
      w.lastAnchorSeconds >= w.anchorSeconds,
  );
}
export async function collectListeningEvidence(
  options: CollectListeningEvidenceOptions,
): Promise<ListeningEvidence> {
  const durationSeconds = Math.max(
    0,
    ...options.project.clips.map(
      (c) => (c.start + c.duration) / options.project.fps,
    ),
  );
  check(options.signal);
  options.onProgress?.("Measuring the complete exported soundtrack");
  const mix = await measureListeningAudio({
    ...options,
    path: options.mediaPath,
    durationSeconds,
  });
  const limitations: string[] = [];
  if (!mix.complete)
    limitations.push(
      "The decoded soundtrack is shorter than the timeline; local measurements are incomplete.",
    );
  if (mix.integratedLufs === null || mix.truePeakDbtp === null)
    limitations.push(
      "LUFS or true-peak measurement was unavailable; gain fixes requiring it are disabled.",
    );
  const stems: ListeningEvidence["stems"] = {};
  for (const role of ["voice", "music", "sfx"] as const) {
    const source = options.stems?.[role];
    if (!source) continue;
    check(options.signal);
    options.onProgress?.(`Measuring the ${role} stem`);
    try {
      stems[role] = await measureListeningAudio({
        ...options,
        path: source,
        durationSeconds,
      });
    } catch (error) {
      check(options.signal);
      limitations.push(
        `${role} stem measurement unavailable: ${(error as Error).message}`,
      );
    }
  }
  // Exact native stems retain the full timeline, including leading silence.
  // Only use a measured complete stem, so source-relative timestamps never leak in.
  const alignedVoice =
    options.stems?.voice && stems.voice?.complete
      ? { path: options.stems.voice, measurement: stems.voice }
      : undefined;
  const alignmentPath = alignedVoice?.path ?? options.mediaPath;
  const alignmentMeasurement = alignedVoice?.measurement ?? mix;
  let alignment: ListeningEvidence["alignment"] = {
    status: "unavailable",
    words: [],
    method: `Fresh local Whisper base DTW anchors and token offsets from the ${alignedVoice ? "complete native voice stem" : "exported full mix"}, in timeline seconds`,
  };
  const hasVisibleCaptions = options.project.clips.some(
    (clip) =>
      clip.kind === "caption" &&
      !options.project.tracks.find((track) => track.id === clip.trackId)
        ?.hidden,
  );
  if (!hasVisibleCaptions) {
    alignment = {
      status: "not-needed",
      words: [],
      method:
        "No visible captions; local speech alignment was not needed. The complete soundtrack still receives audio-model review.",
    };
  } else if (durationSeconds > 1800) {
    limitations.push(
      "Fresh local caption alignment is limited to 30 minutes; captions were not automatically retimed.",
    );
  } else if (
    alignmentMeasurement.samplePeakDbfs === null ||
    alignmentMeasurement.samplePeakDbfs < -65
  ) {
    limitations.push(
      "The selected speech-alignment source is silent or nearly silent; speech alignment was not attempted.",
    );
  } else {
    await mkdir(options.workDir, { recursive: true });
    const directory = await mkdtemp(
      path.join(options.workDir, "listening-evidence-"),
    );
    try {
      check(options.signal);
      options.onProgress?.(
        "Checking caption timing against fresh local speech alignment",
      );
      const wav = path.join(directory, "speech.wav"),
        output = path.join(directory, "alignment");
      await run(
        options.ffmpeg,
        [
          "-hide_banner",
          "-v",
          "error",
          "-nostdin",
          "-i",
          alignmentPath,
          "-map",
          "0:a:0",
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
        options.signal,
      );
      await run(
        options.whisperPath,
        [
          "-m",
          options.whisperModelPath,
          "-f",
          wav,
          "-l",
          "auto",
          "-dtw",
          "base",
          "-nfa",
          "-t",
          "2",
          "-ojf",
          "-of",
          output,
        ],
        options.signal,
      );
      const metadata = await stat(output + ".json");
      if (metadata.size > 64 * 1024 * 1024)
        throw Error("Speech alignment output exceeded the 64 MB review limit.");
      const raw = JSON.parse(await readFile(output + ".json", "utf8"));
      const words = parseListeningAlignment(raw, durationSeconds);
      if (!words.length)
        throw Error("No usable fresh speech alignment was returned.");
      if (
        words.some(
          (word, i) => i > 0 && word.anchorSeconds < words[i - 1].anchorSeconds,
        )
      )
        throw Error("Local speech anchors were not monotonic.");
      alignment = {
        ...alignment,
        status: "complete",
        words,
        language:
          typeof raw.result?.language === "string"
            ? raw.result.language
            : undefined,
      };
    } catch (error) {
      check(options.signal);
      limitations.push(
        `Fresh caption alignment unavailable: ${(error as Error).message}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  check(options.signal);
  return { durationSeconds, mix, stems, alignment, limitations };
}
