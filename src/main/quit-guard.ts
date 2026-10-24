import type { Job } from "../shared/model";

/**
 * Work that quitting would throw away, as the question to ask first, or
 * undefined when nothing is at risk. Preview copies are made again on the
 * next launch, and an agent call's own job shows as the work it started.
 */
export function workAtRisk(jobs: Iterable<Job>, exporting: boolean) {
  const running = [...jobs].filter((job) => job.state === "running");
  const exportJob = running.find((job) => job.kind === "export");
  if (exporting || exportJob)
    return {
      question: `An export is ${Math.round((exportJob?.progress ?? 0) * 100)}% done. Quit anyway?`,
      keep: "Keep exporting",
    };
  const job = running.find(
    (job) => job.kind !== "preview" && job.kind !== "agent",
  );
  return job
    ? {
        question: `“${job.message}” is still running. Quit anyway?`,
        keep: "Keep working",
      }
    : undefined;
}
