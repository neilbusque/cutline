import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

/**
 * Chrome for Testing processes that outlived the worker that started them.
 * Remotion starts Chrome in its own process group, so a render or preview
 * worker that crashes or is killed leaves it running, adopted by launchd
 * (PID 1), holding hundreds of MB. Only Cutline runs the Chrome in its own
 * vendor folder, and a working Chrome always has its worker as its parent.
 */
export function orphanedBrowsers(listing: string, folders: string[]) {
  const prefixes = folders.map((folder) => folder.replace(/\/+$/u, "") + "/");
  const pids: number[] = [];
  for (const line of listing.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (
      match?.[2] === "1" &&
      prefixes.some((prefix) => match[3].startsWith(prefix))
    )
      pids.push(Number(match[1]));
  }
  return pids;
}

/** Stops orphaned Chrome processes from this folder and returns their PIDs. */
export function sweepOrphanedBrowsers(
  folder: string,
  list: (callback: (error: Error | null, stdout: string) => void) => void = (
    callback,
  ) =>
    execFile(
      "/bin/ps",
      ["-axww", "-o", "pid=,ppid=,command="],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => callback(error, String(stdout)),
    ),
  kill: (pid: number) => void = (pid) => process.kill(pid, "SIGKILL"),
): Promise<number[]> {
  const folders = [folder];
  try {
    const real = realpathSync(folder);
    if (real !== folder) folders.push(real);
  } catch {
    // No browser installed here, so none can be left running.
    return Promise.resolve([]);
  }
  return new Promise((resolve) =>
    list((error, stdout) => {
      if (error) return resolve([]);
      const pids = orphanedBrowsers(stdout, folders);
      for (const pid of pids)
        try {
          kill(pid);
        } catch {
          /* Already gone. */
        }
      resolve(pids);
    }),
  );
}
