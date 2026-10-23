import { z } from "zod";
import { uid, type Job } from "../shared/model";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long agent tools (transcription, pause removal, reels, music analysis,
 * imports with proxies) answer within the deadline. Work that takes longer
 * keeps running and becomes a task that cutline_jobs reports, so clients with
 * a 60-second request timeout (Claude Desktop) never lose the result.
 */
export class AgentTasks {
  private tasks = new Map<string, Task>();
  /** Job IDs that already existed when each task's tool started. */
  private earlier = new Map<string, Set<string>>();
  constructor(
    private jobs: { jobs: Map<string, Job>; cancel?: (id: string) => void },
    private deadlineMs = 45_000,
    private pollMs = 250,
  ) {}

  async run<T>(
    tool: string,
    work: Promise<T>,
    describe: (error: unknown) => string = (error) => (error as Error).message,
    earlier = new Set(this.jobs.jobs.keys()),
  ): Promise<T | PendingTask> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), this.deadlineMs);
    });
    const outcome = await Promise.race([
      work.then((value) => ({ value })),
      deadline,
    ]).finally(() => clearTimeout(timer));
    if (outcome !== "deadline") return outcome.value;
    const task: Task = {
      id: uid(),
      kind: tool,
      state: "running",
      progress: 0,
      message: `Running ${tool}`,
    };
    this.tasks.set(task.id, task);
    this.earlier.set(task.id, earlier);
    work
      .then(
        (value) =>
          Object.assign(task, {
            state: "done",
            progress: 1,
            message: "Complete",
            result: value,
          }),
        (error: unknown) => {
          if (task.state !== "cancelled")
            Object.assign(task, { state: "error", message: describe(error) });
        },
      )
      .finally(() => this.earlier.delete(task.id));
    return {
      id: task.id,
      jobId: task.id,
      state: "running",
      message: `${tool} is still running and will finish on its own. Call cutline_jobs with {"id": "${task.id}", "waitSeconds": 30} until its state is done; the result is in that job. Do not start it again, and avoid other edits until it finishes.`,
    };
  }

  /**
   * cutline_cancel_job for a task ID: stops the processing jobs its tool
   * started (never an export). Returns null when the ID is not a task.
   */
  cancel(id: unknown) {
    const task = typeof id === "string" ? this.tasks.get(id) : undefined;
    if (!task) return null;
    if (task.state === "running") {
      const earlier = this.earlier.get(task.id) ?? new Set();
      for (const job of [...this.jobs.jobs.values()])
        if (
          job.state === "running" &&
          job.kind !== "export" &&
          !earlier.has(job.id)
        )
          this.jobs.cancel?.(job.id);
      Object.assign(task, { state: "cancelled", message: "Cancelled" });
    }
    const { result: _result, ...visible } = task;
    return visible;
  }

  private entries() {
    const jobs = [...this.jobs.jobs.values()].map(
      ({ output: _output, ...job }) => job as Task,
    );
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
