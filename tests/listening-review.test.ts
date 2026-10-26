import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AssetSchema, makeClip, newProject } from "../src/shared/model";
import type {
  ListeningEvidence,
  ListeningFix,
} from "../src/shared/listening-plan";
import type {
  ListeningModelIssue,
  ListeningModelReview,
} from "../src/main/listening-provider";
import {
  extractListeningChunk,
  hashFile,
  listeningChunks,
  runListeningReview,
} from "../src/main/listening-review";

type Options = Parameters<typeof runListeningReview>[0];
type Dependencies = NonNullable<Options["deps"]>;

describe("bounded review file operations", () => {
  it("cancels hashing before opening an input and while a stream is active", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      hashFile("/does-not-exist.mp4", cancelled.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cutline-listening-hash-"),
    );
    try {
      const file = path.join(directory, "fixture.mp4");
      await writeFile(file, "abc");
      expect(await hashFile(file)).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
      const controller = new AbortController();
      const result = hashFile(file, controller.signal);
      queueMicrotask(() => controller.abort());
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("seeks before opening the input so later chunks do not decode earlier audio again", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cutline-listening-seek-"),
    );
    try {
      const command = path.join(directory, "fake-ffmpeg.cjs");
      const recorded = path.join(directory, "args.json");
      await writeFile(
        command,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o700 },
      );
      const input = path.join(directory, "export.mp4");
      await extractListeningChunk(
        command,
        input,
        path.join(directory, "review.wav"),
        3570,
        60,
        new AbortController().signal,
      );
      const args: string[] = JSON.parse(await readFile(recorded, "utf8"));
      expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
      expect(args[args.indexOf("-ss") + 1]).toBe("3570");
      expect(args[args.indexOf("-i") + 1]).toBe(input);
      expect(args[args.indexOf("-t") + 1]).toBe("60");
      expect(args).not.toContain("-noaccurate_seek");
      expect(args[args.indexOf("-c:a") + 1]).toBe("pcm_s16le");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function measurements(
  seconds: number,
  patch: Partial<ListeningEvidence["mix"]> = {},
) {
  return {
    integratedLufs: -18,
    truePeakDbtp: -2,
    samplePeakDbfs: -2.2,
    clippedSampleCount: 0,
    analyzedSeconds: seconds,
    complete: true,
    activity: { stepSeconds: 0.02, rmsDbfs: [-20], peakDbfs: [-2.2] },
    ...patch,
  };
}

function evidence(seconds: number): ListeningEvidence {
  return {
    durationSeconds: seconds,
    mix: measurements(seconds),
    stems: { voice: measurements(seconds) },
    alignment: {
      status: "complete",
      language: "en",
      method: "test DTW",
      words: [],
    },
    limitations: [],
  };
}

const modelIssue = (
  patch: Partial<ListeningModelIssue> = {},
): ListeningModelIssue => ({
  category: "voice",
  kind: "voice_quiet",
  startSeconds: 1,
  endSeconds: 3,
  severity: "warning",
  confidence: 0.9,
  description: "The voice is quiet.",
  ...patch,
});

function harness(seconds = 24) {
  const project = newProject();
  project.id = "listening-fixture";
  project.revision = 7;
  const voice = AssetSchema.parse({
    id: "voice",
    name: "Recorded voice",
    kind: "audio",
    path: "/fixture/voice.wav",
    duration: seconds,
    hasAudio: true,
  });
  project.assets.push(voice);
  project.clips.push({
    ...makeClip(project, "audio", "audio", 0, voice),
    id: "voice-clip",
    audioRole: "voice",
    duration: Math.round(seconds * project.fps),
  });
  // Timeline duration has frame precision; use the same duration for test evidence.
  seconds = project.clips[0].duration / project.fps;
  const candidate = structuredClone(project);
  candidate.clips[0].volume = 0.8;
  const initial = {
    path: "/fixture/original.mp4",
    stems: { voice: voice.path },
  };
  const candidateRender = {
    path: "/fixture/candidate.mp4",
    stems: { voice: "/fixture/revised-voice.wav" },
  };
  const controller = new AbortController();
  const collect = vi.fn<NonNullable<Dependencies["collect"]>>(async () =>
    evidence(seconds),
  );
  const review = vi.fn<NonNullable<Dependencies["review"]>>(async (args) => ({
    provider: "qwen-omni-demo",
    model: "qwen3.5-omni-plus",
    chunkStartSeconds: args.startSeconds,
    chunkDurationSeconds: args.durationSeconds,
    issues: [],
  }));
  const plan = vi.fn<NonNullable<Dependencies["plan"]>>((snapshot) => ({
    project: structuredClone(snapshot),
    fixes: [],
    unresolved: [],
  }));
  const extract = vi.fn<NonNullable<Dependencies["extract"]>>(async () => {});
  const hash = vi.fn<NonNullable<Dependencies["hash"]>>(async (file) =>
    (file === initial.path ? "a" : "b").repeat(64),
  );
  const render = vi.fn<Options["render"]>(async () => candidateRender);
  const commit = vi.fn<Options["commit"]>((snapshot) => ({
    ...structuredClone(snapshot),
    revision: snapshot.revision + 1,
  }));
  const onProgress = vi.fn();
  const options: Options = {
    project,
    initial,
    ffmpeg: "/unused/ffmpeg",
    whisperPath: "/unused/whisper",
    whisperModelPath: "/unused/model",
    autoFix: true,
    signal: controller.signal,
    onProgress,
    render,
    commit,
    deps: { collect, review, plan, extract, hash },
  };
  const fix: ListeningFix = {
    category: "voice",
    kind: "voice_quiet",
    clipIds: ["voice-clip"],
    description: "Adjusted voice gain after corroborating the source stem.",
  };
  function offerFix() {
    plan.mockImplementationOnce(() => ({
      project: candidate,
      fixes: [fix],
      unresolved: [],
    }));
  }
  function response(issues: ListeningModelIssue[] = []): ListeningModelReview {
    return {
      provider: "qwen-omni-demo",
      model: "qwen3.5-omni-plus",
      chunkStartSeconds: 0,
      chunkDurationSeconds: seconds,
      issues,
    };
  }
  return {
    options,
    project,
    candidate,
    initial,
    candidateRender,
    controller,
    collect,
    review,
    plan,
    extract,
    hash,
    render,
    commit,
    onProgress,
    offerFix,
    response,
    fix,
    seconds,
  };
}

describe("complete soundtrack review coverage", () => {
  it("covers the last sample with overlapping chunks, including exact boundaries", () => {
    expect(listeningChunks(60)).toEqual([
      { startSeconds: 0, durationSeconds: 60 },
    ]);
    expect(listeningChunks(120.25)).toEqual([
      { startSeconds: 0, durationSeconds: 60 },
      { startSeconds: 59.5, durationSeconds: 60 },
      { startSeconds: 119, durationSeconds: 1.25 },
    ]);
    for (const total of [0.033, 59.5, 60.01, 119.5, 3600]) {
      const chunks = listeningChunks(total);
      expect(chunks[0].startSeconds).toBe(0);
      expect(
        chunks.at(-1)!.startSeconds + chunks.at(-1)!.durationSeconds,
      ).toBeCloseTo(total, 8);
      chunks.forEach((chunk, index) => {
        expect(chunk.durationSeconds).toBeGreaterThan(0);
        expect(chunk.durationSeconds).toBeLessThanOrEqual(60);
        if (index)
          expect(chunk.startSeconds).toBeLessThan(
            chunks[index - 1].startSeconds + chunks[index - 1].durationSeconds,
          );
      });
    }
    for (const invalid of [0, -1, Infinity, NaN])
      expect(() => listeningChunks(invalid)).toThrow();
  });

  it("actually reviews every chunk of a longer exported file before passing", async () => {
    const h = harness(120.5);
    const result = await runListeningReview(h.options);
    expect(
      h.review.mock.calls.map(([arg]) => [
        arg.startSeconds,
        arg.durationSeconds,
      ]),
    ).toEqual([
      [0, 60],
      [59.5, 60],
      [119, 1.5],
    ]);
    expect(
      h.extract.mock.calls.map((call) => [call[1], call[3], call[4]]),
    ).toEqual([
      [h.initial.path, 0, 60],
      [h.initial.path, 59.5, 60],
      [h.initial.path, 119, 1.5],
    ]);
    expect(result.report).toMatchObject({
      status: "passed",
      humanListening: false,
      fixes: [],
      passes: [{ complete: true, coveredSeconds: 120.5 }],
    });
    expect(result.render).toBe(h.initial);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    await expect(
      access(path.dirname(h.extract.mock.calls[0][2])),
    ).rejects.toThrow();
  });

  it("does not pass or apply fixes when the unreviewed tail hits a provider failure", async () => {
    const h = harness(120);
    h.review
      .mockResolvedValueOnce(h.response())
      .mockRejectedValueOnce(Error("Reviewer unavailable"));
    h.offerFix();
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("incomplete");
    expect(result.report.passes[0]).toMatchObject({
      coveredSeconds: 60,
      complete: false,
      error: "Reviewer unavailable",
    });
    expect(result.render).toBe(h.initial);
    expect(result.project).toBe(h.project);
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("does not mark the initial export passed when local measurements are incomplete", async () => {
    const h = harness();
    h.collect.mockResolvedValueOnce({
      ...evidence(24),
      mix: measurements(24, { complete: false, analyzedSeconds: 5 }),
    });
    h.offerFix();
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("incomplete");
    expect(result.render).toBe(h.initial);
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });
});

describe("evidence-gated listening correction transaction", () => {
  it("accepts supported fixes once, only after a complete second review of the new export", async () => {
    const h = harness();
    const before = JSON.stringify(h.project);
    h.offerFix();
    h.review
      .mockResolvedValueOnce(h.response([modelIssue()]))
      .mockResolvedValueOnce(h.response());
    const result = await runListeningReview(h.options);
    expect(h.render).toHaveBeenCalledExactlyOnceWith(h.candidate);
    expect(h.review).toHaveBeenCalledTimes(2);
    expect(h.commit).toHaveBeenCalledExactlyOnceWith(h.candidate);
    expect(h.review.mock.invocationCallOrder[1]).toBeLessThan(
      h.commit.mock.invocationCallOrder[0],
    );
    expect(result.render).toBe(h.candidateRender);
    expect(result.project.revision).toBe(8);
    expect(result.report).toMatchObject({
      status: "passed",
      sourceRevision: 7,
      finalRevision: 8,
      fixes: [h.fix],
    });
    expect(
      result.report.passes.map((pass) => [
        pass.complete,
        pass.coveredSeconds,
        pass.mediaSha256,
      ]),
    ).toEqual([
      [true, 24, "a".repeat(64)],
      [true, 24, "b".repeat(64)],
    ]);
    expect(JSON.stringify(h.project)).toBe(before);
  });

  it("keeps the original render and project when the second listening request fails", async () => {
    const h = harness();
    const before = JSON.stringify(h.project);
    h.offerFix();
    h.review
      .mockResolvedValueOnce(h.response([modelIssue()]))
      .mockRejectedValueOnce(Error("Second review failed"));
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("incomplete");
    expect(result.report.fixes).toEqual([]);
    expect(result.report.passes[1].complete).toBe(false);
    expect(result.render).toBe(h.initial);
    expect(result.project).toBe(h.project);
    expect(h.commit).not.toHaveBeenCalled();
    expect(JSON.stringify(h.project)).toBe(before);
  });

  it("rejects measured clipping introduced by a candidate", async () => {
    const h = harness();
    h.offerFix();
    h.collect.mockResolvedValueOnce(evidence(24)).mockResolvedValueOnce({
      ...evidence(24),
      mix: measurements(24, { truePeakDbtp: 0.2, clippedSampleCount: 40 }),
    });
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("needs-review");
    expect(result.render).toBe(h.initial);
    expect(result.report.fixes).toEqual([]);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("rejects a candidate that accidentally removes an audible soundtrack", async () => {
    const h = harness();
    h.offerFix();
    h.collect.mockResolvedValueOnce(evidence(24)).mockResolvedValueOnce({
      ...evidence(24),
      mix: measurements(24, {
        samplePeakDbfs: -200,
        truePeakDbtp: null,
        integratedLufs: null,
      }),
    });
    const result = await runListeningReview(h.options);
    expect(result.report.status).not.toBe("passed");
    expect(result.render).toBe(h.initial);
    expect(result.project).toBe(h.project);
    expect(result.report.fixes).toEqual([]);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("rejects a candidate when full local measurements could not be completed", async () => {
    const h = harness();
    h.offerFix();
    h.collect.mockResolvedValueOnce(evidence(24)).mockResolvedValueOnce({
      ...evidence(24),
      mix: measurements(24, {
        complete: false,
        analyzedSeconds: 5,
        truePeakDbtp: null,
      }),
      limitations: ["Local audio measurement incomplete"],
    });
    const result = await runListeningReview(h.options);
    expect(result.report.status).not.toBe("passed");
    expect(result.render).toBe(h.initial);
    expect(result.project).toBe(h.project);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("rejects a candidate whose true peak could not be verified", async () => {
    const h = harness();
    h.offerFix();
    h.collect.mockResolvedValueOnce(evidence(24)).mockResolvedValueOnce({
      ...evidence(24),
      mix: measurements(24, { truePeakDbtp: null }),
    });
    const result = await runListeningReview(h.options);
    expect(h.review).toHaveBeenCalledTimes(2);
    expect(result.report.passes[1].complete).toBe(true);
    expect(result.report.status).toBe("needs-review");
    expect(result.render).toBe(h.initial);
    expect(result.project).toBe(h.project);
    expect(result.report.fixes).toEqual([]);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("withholds caption corrections when the candidate speech alignment is unavailable", async () => {
    const h = harness();
    h.project.clips.push(
      {
        ...makeClip(h.project, "caption", "captions", 0),
        id: "caption-one",
        text: "A free tool",
        duration: 30,
      },
      {
        ...makeClip(h.project, "caption", "captions", 30),
        id: "caption-two",
        text: "that deletes",
        duration: 30,
      },
    );
    const before = JSON.stringify(h.project);
    const candidate = structuredClone(h.project);
    candidate.clips.find((clip) => clip.id === "caption-one")!.duration = 33;
    const second = candidate.clips.find((clip) => clip.id === "caption-two")!;
    second.start = 33;
    second.duration = 27;
    h.plan.mockImplementationOnce(() => ({
      project: candidate,
      fixes: [
        {
          category: "captions",
          kind: "caption_boundary",
          clipIds: ["caption-one", "caption-two"],
          description:
            "Retimed an adjacent caption boundary using local speech evidence.",
        },
      ],
      unresolved: [],
    }));
    h.collect.mockResolvedValueOnce(evidence(24)).mockResolvedValueOnce({
      ...evidence(24),
      alignment: {
        status: "unavailable",
        method: "DTW unavailable",
        words: [],
      },
      limitations: ["The revised speech alignment could not be verified."],
    });
    const result = await runListeningReview(h.options);
    expect(h.review).toHaveBeenCalledTimes(2);
    expect(result.report.passes[1].complete).toBe(true);
    expect(result.report.status).toBe("needs-review");
    expect(result.render).toBe(h.initial);
    expect(result.report.fixes).toEqual([]);
    expect(h.commit).not.toHaveBeenCalled();
    expect(JSON.stringify(h.project)).toBe(before);
  });

  it("retains a complete usable export review when an optional stem render failed", async () => {
    const h = harness();
    const failure =
      "Sound effects stem rendering failed; its isolated measurements are unavailable.";
    h.options.initial = {
      ...h.initial,
      stems: undefined,
      stemFailures: [failure],
    };
    h.collect.mockResolvedValueOnce({ ...evidence(24), stems: {} });
    const result = await runListeningReview(h.options);
    expect(h.review).toHaveBeenCalledTimes(1);
    expect(result.report.status).toBe("needs-review");
    expect(result.report.passes[0]).toMatchObject({
      complete: true,
      coveredSeconds: 24,
      evidence: { limitations: [failure] },
    });
    expect(result.report.unresolved).toContain(failure);
    expect(result.render).toBe(h.options.initial);
    expect(result.render.path).toBe(h.initial.path);
    expect(result.project).toBe(h.project);
    expect(result.report.fixes).toEqual([]);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("rejects a new error category even when the total error count stays the same", async () => {
    const h = harness();
    h.offerFix();
    h.review
      .mockResolvedValueOnce(h.response([modelIssue({ severity: "error" })]))
      .mockResolvedValueOnce(
        h.response([
          modelIssue({
            category: "music",
            kind: "music_masking",
            severity: "error",
            description: "A new music problem masks the voice.",
          }),
        ]),
      );
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("needs-review");
    expect(result.render).toBe(h.initial);
    expect(result.report.fixes).toEqual([]);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("does not accept the rendered candidate if the live revision guard rejects commit", async () => {
    const h = harness();
    h.offerFix();
    h.commit.mockImplementation(() => {
      throw Error("Project revision changed during listening");
    });
    const result = await runListeningReview(h.options);
    expect(h.review).toHaveBeenCalledTimes(2);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(result.report.status).toBe("needs-review");
    expect(result.report.finalRevision).toBe(7);
    expect(result.report.fixes).toEqual([]);
    expect(result.render).toBe(h.initial);
    expect(result.project).toBe(h.project);
  });

  it("cancels without committing, including cancellation after the second response", async () => {
    const h = harness();
    h.offerFix();
    h.review
      .mockResolvedValueOnce(h.response())
      .mockImplementationOnce(async () => {
        h.controller.abort(Error("Cancelled by test"));
        return h.response();
      });
    await expect(runListeningReview(h.options)).rejects.toThrow(/Cancelled/);
    expect(h.commit).not.toHaveBeenCalled();
    await expect(
      access(path.dirname(h.extract.mock.calls[0][2])),
    ).rejects.toThrow();
  });

  it("passes cancellation to the export hash and stops before model review", async () => {
    const h = harness();
    h.hash.mockImplementationOnce(async (_file, signal) => {
      expect(signal).toBe(h.controller.signal);
      h.controller.abort(Error("Cancelled during hashing"));
      signal!.throwIfAborted();
      return "unused";
    });
    await expect(runListeningReview(h.options)).rejects.toThrow(
      "Cancelled during hashing",
    );
    expect(h.review).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("retains unknown audible concerns as needs-review without inventing a fix", async () => {
    const h = harness();
    h.review.mockResolvedValueOnce(
      h.response([
        modelIssue({
          kind: "other",
          description: "An unexplained sound overlaps a word.",
        }),
      ]),
    );
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("needs-review");
    expect(result.report.unresolved).toContain(
      "An unexplained sound overlaps a word.",
    );
    expect(result.report.fixes).toEqual([]);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("lists an unresolved model observation only once when the planner already explained it", async () => {
    const h = harness();
    const description = "An unexplained sound overlaps a word.";
    h.review.mockResolvedValueOnce(
      h.response([modelIssue({ kind: "other", description })]),
    );
    h.plan.mockImplementationOnce((snapshot) => ({
      project: structuredClone(snapshot),
      fixes: [],
      unresolved: [
        `voice: ${description} Automatic correction was withheld because supporting evidence was insufficient.`,
      ],
    }));
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("needs-review");
    expect(
      result.report.unresolved.filter((finding) =>
        finding.includes(description),
      ),
    ).toHaveLength(1);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("reports supported suggestions but makes no changes when automatic fixes are disabled", async () => {
    const h = harness();
    h.offerFix();
    h.options.autoFix = false;
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("needs-review");
    expect(result.report.unresolved).toContain(h.fix.description);
    expect(result.render).toBe(h.initial);
    expect(result.report.fixes).toEqual([]);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("does not upload a completely measured silent original soundtrack", async () => {
    const h = harness();
    h.collect.mockResolvedValueOnce({
      ...evidence(24),
      mix: measurements(24, { samplePeakDbfs: -200, truePeakDbtp: null }),
    });
    const result = await runListeningReview(h.options);
    expect(result.report.status).toBe("no-audio");
    expect(result.report.humanListening).toBe(false);
    expect(h.review).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });
});
