import { z } from "zod";
import { uid, type Job } from "../shared/model";
import type { Jobs } from "./media";

export const JobsArgsSchema = z.strictObject({
  id: z.string().min(1).max(200).optional(),
  waitSeconds: z.number().min(0).max(50).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

type Task = Job & { result?: unknown };
export type PendingTask = {
  id: string;
  jobId: string;
  state: "running";
  message: string;
};
/**
 * How long the built-in Codex waits for a long tool. Codex has no tool limit,
 * so it waits for the result instead of polling cutline_jobs every 30 seconds.
 */
export const ASSISTANT_DEADLINE_MS = 540_000;
/**
 * The built-in Claude's wait. Claude Code's HTTP client gives up on a request
 * after 300 seconds whatever its tool timeout says, so a longer tool answers
 * with a task well before then and the work carries on.
 */
export const LOCAL_CLAUDE_DEADLINE_MS = 240_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long agent tools (transcription, pause removal, reels, music analysis,
 * imports with proxies) answer within the caller's deadline: 45 seconds for
 * clients with a 60-second request timeout (Claude Desktop), longer for
 * Cutline's own assistants. Work that takes longer keeps running and becomes
 * a task that cutline_jobs reports, so no client loses the result.
 *
 * Each call runs under a job of its own, and the jobs its tool starts are its
 * children. Cancelling the task, or the caller going away before the
 * deadline (Stop in the assistant), cancels those children and nothing else:
 * never the person's own imports, previews or exports. No job and no edit can
 * start under a cancelled call.
 */
export class AgentTasks {
  private tasks = new Map<string, Task>();
  /** The job each task's work runs under. */
  private jobIds = new Map<string, string>();
  constructor(
    private jobs: Pick<Jobs, "jobs" | "run" | "cancel" | "cancellers">,
    private deadlineMs = 45_000,
    private pollMs = 250,
  ) {}

  async run<T>(
    tool: string,
    start: (signal: AbortSignal) => Promise<T>,
    describe: (error: unknown) => string = (error) => (error as Error).message,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<T | PendingTask> {
    const stop = new AbortController();
    let jobId = "";
    const work = this.jobs.run("agent", `Running ${tool}`, (job) => {
      jobId = job.id;
      // Work that takes a signal, such as drawings, stops with the job.
      this.jobs.cancellers.set(job.id, () => stop.abort());
      return start(stop.signal);
    });
    work.catch(() => {});
    const cancel = () => this.jobs.cancel(jobId);
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(
        () => resolve("deadline"),
        options.deadlineMs ?? this.deadlineMs,
      );
    });
    try {
      const outcome = await Promise.race([
        work.then((value) => ({ value })),
        deadline,
      ]);
      if (outcome !== "deadline") return outcome.value;
    } finally {
      clearTimeout(timer);
      // From here on the work belongs to its task, not to the call.
      options.signal?.removeEventListener("abort", cancel);
    }
    const task: Task = {
      id: uid(),
      kind: tool,
      state: "running",
      progress: 0,
      message: `Running ${tool}`,
    };
    this.tasks.set(task.id, task);
    this.jobIds.set(task.id, jobId);
    work.then(
      (value) => {
        if (task.state === "running")
          Object.assign(task, {
            state: "done",
            progress: 1,
            message: "Complete",
            result: value,
          });
      },
      (error: unknown) => {
        if (task.state === "running")
          Object.assign(task, { state: "error", message: describe(error) });
      },
    );
    return {
      id: task.id,
      jobId: task.id,
      state: "running",
      message: `${tool} is still running and will finish on its own. Call cutline_jobs with {"id": "${task.id}", "waitSeconds": 30} until its state is done; the result is in that job. Do not start it again, and avoid other edits until it finishes.`,
    };
  }

  /**
   * cutline_cancel_job for a task ID: stops the work its tool started, never
   * an export or anything else. Returns null when the ID is not a task.
   */
  cancel(id: unknown) {
    const task = typeof id === "string" ? this.tasks.get(id) : undefined;
    if (!task) return null;
    if (task.state === "running") {
      Object.assign(task, { state: "cancelled", message: "Cancelled" });
      this.jobs.cancel(this.jobIds.get(task.id) ?? "");
    }
    const { result: _result, ...visible } = task;
    return visible;
  }

  private entries() {
    // A call's own job is reported as its task.
    const jobs = [...this.jobs.jobs.values()]
      .filter((job) => job.kind !== "agent")
      .map(({ output: _output, ...job }) => job as Task);
    return [...jobs, ...this.tasks.values()];
  }

  /** cutline_jobs: recent jobs (running ones always), or one job; waitSeconds waits for it to finish. */
  async list(raw: unknown = {}) {
    const args = JobsArgsSchema.parse(raw ?? {});
    const pick = () =>
      args.id
        ? this.entries().filter((entry) => entry.id === args.id)
        : this.entries();
    if (args.id && !pick().length)
      throw Error(
        `Job ${args.id} is missing. Call cutline_jobs without an id to list jobs.`,
      );
    const until = Date.now() + args.waitSeconds * 1000;
    while (
      Date.now() < until &&
      pick().some((entry) => entry.state === "running")
    )
      await sleep(this.pollMs);
    const entries = pick();
    const recent = new Set(entries.slice(-args.limit));
    return entries
      .filter((entry) => recent.has(entry) || entry.state === "running")
      .map((entry) => ({ ...entry }));
  }
}
