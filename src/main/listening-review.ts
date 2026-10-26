import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { duration, type Project } from "../shared/model";
import { collectListeningEvidence } from "./listening-evidence";
import {
  planListeningFixes,
  type ListeningEvidence,
  type ListeningFix,
} from "../shared/listening-plan";
import {
  reviewAudioChunk,
  type ListeningModelReview,
} from "./listening-provider";

export type ListeningRender = {
  path: string;
  stems?: Partial<Record<"voice" | "music" | "sfx", string>>;
  repairedFrames?: number[];
  stemFailures?: string[];
};
export type ListeningPass = {
  mediaSha256: string;
  evidence: ListeningEvidence;
  chunks: ListeningModelReview[];
  coveredSeconds: number;
  complete: boolean;
  error?: string;
};
export type ListeningReport = {
  version: 1;
  projectId: string;
  sourceRevision: number;
  finalRevision: number;
  status: "passed" | "needs-review" | "incomplete" | "no-audio";
  summary: string;
  durationSeconds: number;
  provider: string;
  humanListening: false;
  fixes: ListeningFix[];
  unresolved: string[];
  passes: ListeningPass[];
};
type Options = {
  project: Project;
  initial: ListeningRender;
  ffmpeg: string;
  whisperPath: string;
  whisperModelPath: string;
  autoFix: boolean;
  signal: AbortSignal;
  onProgress: (message: string) => void;
  /** Runs against a detached candidate, with no live timeline mutation. */
  render: (project: Project) => Promise<ListeningRender>;
  /** Must check opening, project ID and original revision atomically. */
  commit: (project: Project) => Project;
  deps?: {
    collect?: typeof collectListeningEvidence;
    review?: typeof reviewAudioChunk;
    plan?: typeof planListeningFixes;
    extract?: typeof extractListeningChunk;
    hash?: typeof hashFile;
  };
};

export async function hashFile(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const stream = createReadStream(file, { signal });
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    signal?.throwIfAborted();
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

/** Decode the delivered AAC, keeping stereo. Each upload remains below 12 MB. */
export async function extractListeningChunk(
  ffmpeg: string,
  input: string,
  output: string,
  start: number,
  seconds: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-v",
        "error",
        "-threads",
        "2",
        // Input seeking avoids decoding every earlier chunk again on long films.
        // Transcoding keeps FFmpeg's default accurate seek, including AAC trim.
        "-ss",
        String(start),
        "-i",
        input,
        "-t",
        String(seconds),
        "-vn",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        "-y",
        output,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let error = "";
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    timer.unref();
    child.stderr.on("data", (data) => {
      error = (error + data).slice(-1500);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(Error("Listening review cancelled"));
      else if (code !== 0)
        reject(Error(error || "Could not prepare audio for listening"));
      else resolve();
    });
  });
}

export function listeningChunks(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw Error("Invalid audio duration");
  const chunks: { startSeconds: number; durationSeconds: number }[] = [];
  for (let start = 0; start < seconds; start += 59.5) {
    chunks.push({
      startSeconds: start,
      durationSeconds: Math.min(60, seconds - start),
    });
    if (start + 60 >= seconds) break;
  }
  return chunks;
}

/** One correction pass, then full listening again. Failed candidates never reach the timeline. */
export async function runListeningReview(options: Options): Promise<{
  render: ListeningRender;
  project: Project;
  report: ListeningReport;
}> {
  const { project, signal, onProgress } = options;
  const seconds = duration(project) / project.fps;
  const report: ListeningReport = {
    version: 1,
    projectId: project.id,
    sourceRevision: project.revision,
    finalRevision: project.revision,
    status: "incomplete",
    summary: "Listening review is incomplete",
    durationSeconds: seconds,
    provider: "Qwen3.5 Omni hosted audio model",
    humanListening: false,
    fixes: [],
    unresolved: [],
    passes: [],
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "cutline-listening-"));
  const collect = options.deps?.collect ?? collectListeningEvidence;
  const review = options.deps?.review ?? reviewAudioChunk;
  const plan = options.deps?.plan ?? planListeningFixes;
  const extract = options.deps?.extract ?? extractListeningChunk;
  const hash = options.deps?.hash ?? hashFile;
  const check = () => signal.throwIfAborted();
  const pass = async (
    source: ListeningRender,
    snapshot: Project,
    index: number,
  ) => {
    check();
    onProgress(`Checking audio and captions${index ? " again" : ""}`);
    const evidence = await collect({
      project: snapshot,
      mediaPath: source.path,
      stems: source.stems,
      ffmpeg: options.ffmpeg,
      whisperPath: options.whisperPath,
      whisperModelPath: options.whisperModelPath,
      workDir: path.join(directory, `pass-${index}`),
      signal,
      onProgress,
    });
    evidence.limitations.push(...(source.stemFailures ?? []));
    const result: ListeningPass = {
      mediaSha256: await hash(source.path, signal),
      evidence,
      chunks: [],
      coveredSeconds: 0,
      complete: false,
    };
    report.passes.push(result);
    if (
      evidence.mix.complete &&
      evidence.mix.samplePeakDbfs !== null &&
      evidence.mix.samplePeakDbfs <= -90
    ) {
      result.complete = true;
      result.coveredSeconds = seconds;
      return result;
    }
    const segments = listeningChunks(seconds);
    for (let i = 0; i < segments.length; i++) {
      check();
      const segment = segments[i];
      onProgress(
        `Listening to ${index ? "revised " : ""}audio · ${i + 1} of ${segments.length}`,
      );
      const audio = path.join(directory, "review.wav");
      try {
        await extract(
          options.ffmpeg,
          source.path,
          audio,
          segment.startSeconds,
          segment.durationSeconds,
          signal,
        );
        check();
        const response = await review({ path: audio, ...segment, signal });
        check();
        result.chunks.push(response);
        result.coveredSeconds = segment.startSeconds + segment.durationSeconds;
      } catch (error) {
        check();
        result.error = (error as Error).message;
        return result;
      } finally {
        await rm(audio, { force: true });
      }
    }
    result.complete = result.coveredSeconds >= seconds - 0.001;
    return result;
  };
  let accepted = options.initial;
  let acceptedProject = project;
  try {
    const first = await pass(options.initial, project, 0);
    check();
    if (!first.complete) {
      report.unresolved.push(
        first.error || "The complete soundtrack was not reviewed",
      );
      return { render: accepted, project: acceptedProject, report };
    }
    if (!first.evidence.mix.complete) {
      report.unresolved.push(
        "Local audio measurements did not cover the full export. No automatic changes were applied.",
      );
      return { render: accepted, project: acceptedProject, report };
    }
    if (
      first.evidence.mix.samplePeakDbfs !== null &&
      first.evidence.mix.samplePeakDbfs <= -90
    ) {
      report.status = "no-audio";
      report.summary = "No audible soundtrack to review";
      return { render: accepted, project: acceptedProject, report };
    }
    const firstIssues = first.chunks.flatMap((chunk) => chunk.issues);
    const proposed = plan(project, first.evidence, firstIssues);
    let final = first;
    let findings = proposed;
    if (proposed.fixes.length && options.autoFix) {
      onProgress("Rendering supported audio and caption fixes");
      const candidate = await options.render(proposed.project);
      check();
      const second = await pass(candidate, proposed.project, 1);
      check();
      if (!second.complete) {
        report.unresolved.push(
          "The corrected export could not be fully reviewed. The original timeline and export were kept.",
          second.error || "Final listening incomplete",
        );
        return { render: accepted, project: acceptedProject, report };
      }
      const secondIssues = second.chunks.flatMap((chunk) => chunk.issues);
      const errorKinds = new Set(
        firstIssues
          .filter(
            (issue) => issue.severity === "error" && issue.confidence >= 0.8,
          )
          .map((issue) => `${issue.category}:${issue.kind}`),
      );
      const newErrors = secondIssues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.confidence >= 0.8 &&
          !errorKinds.has(`${issue.category}:${issue.kind}`),
      );
      const silentCandidate =
        second.evidence.mix.samplePeakDbfs === null ||
        second.evidence.mix.samplePeakDbfs <= -90;
      const missingVerification =
        second.evidence.mix.truePeakDbtp === null ||
        (proposed.fixes.some((fix) => fix.category === "captions") &&
          second.evidence.alignment.status !== "complete");
      if (
        !second.evidence.mix.complete ||
        missingVerification ||
        silentCandidate ||
        newErrors ||
        (second.evidence.mix.truePeakDbtp ?? -99) >
          Math.max(-0.5, first.evidence.mix.truePeakDbtp ?? -99)
      ) {
        report.status = "needs-review";
        report.summary =
          "Proposed fixes need review; the original export was kept";
        report.unresolved.push(
          "The final review found a possible regression. No automatic changes were accepted.",
        );
        return { render: accepted, project: acceptedProject, report };
      }
      try {
        check();
        acceptedProject = options.commit(proposed.project);
      } catch (error) {
        report.status = "needs-review";
        report.summary =
          "Project changed during review; the original export was kept";
        report.unresolved.push((error as Error).message);
        return { render: accepted, project: acceptedProject, report };
      }
      accepted = candidate;
      report.finalRevision = acceptedProject.revision;
      report.fixes = proposed.fixes;
      final = second;
      findings = plan(proposed.project, second.evidence, secondIssues);
    } else if (proposed.fixes.length) {
      report.unresolved.push(...proposed.fixes.map((fix) => fix.description));
    }
    report.unresolved.push(
      ...findings.unresolved,
      ...final.evidence.limitations,
    );
    if (options.autoFix && report.fixes.length && findings.fixes.length) {
      report.unresolved.push(
        ...findings.fixes.map((fix) => `Further review: ${fix.description}`),
      );
    }
    // A model observation is evidence for review, never executable instructions.
    const remaining = final.chunks
      .flatMap((chunk) => chunk.issues)
      .filter((issue) => issue.confidence >= 0.7)
      .map((issue) => issue.description)
      .filter(
        (description) =>
          !report.unresolved.some((finding) => finding.includes(description)),
      );
    report.unresolved = [...new Set([...report.unresolved, ...remaining])];
    report.status = report.unresolved.length ? "needs-review" : "passed";
    report.summary =
      report.status === "passed"
        ? `Full audio review complete${report.fixes.length ? `; ${report.fixes.length} supported ${report.fixes.length === 1 ? "fix" : "fixes"} applied` : ""}`
        : `Full audio review complete; ${report.unresolved.length} ${report.unresolved.length === 1 ? "finding needs" : "findings need"} review`;
    return { render: accepted, project: acceptedProject, report };
  } catch (error) {
    check();
    report.unresolved.push((error as Error).message);
    return { render: accepted, project: acceptedProject, report };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
