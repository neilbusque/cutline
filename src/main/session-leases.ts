import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
/** When a running process started, from ps; undefined when it can't be read. */
export function processStart(pid: number) {
  try {
    const started = Date.parse(
      execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        timeout: 2000,
      }).trim(),
    );
    return Number.isFinite(started) ? started : undefined;
  } catch {
    return undefined;
  }
}
/** ps gives start times to the second; the owner records its own a little late. */
const startSlack = 3000;

/** Process-owned leases shared by independent editor processes. */
export class SessionLeases {
  /** When this process started, written into its leases. */
  private started = Date.now() - process.uptime() * 1000;
  /** Start times read from ps, briefly reused while a slot is polled. */
  private starts = new Map<number, { started?: number; until: number }>();
  constructor(
    readonly directory: string,
    readonly sessionName: string,
    private options: {
      processStart?: (pid: number) => number | undefined;
      bootTime?: () => number;
    } = {},
  ) {}
  /**
   * Whether a lease's owner has exited. After a crash or a restart its PID can
   * belong to another program, so a live PID also has to have started when
   * the owner did, and before the lease was written.
   */
  private ownerGone(
    owner: { pid: number; started?: unknown },
    ownerFile: string,
  ) {
    if (!alive(owner.pid)) return true;
    let written: number;
    try {
      written = statSync(ownerFile).mtimeMs;
    } catch {
      return false;
    }
    // Written before this Mac last started up: that process is long gone.
    const boot = this.options.bootTime?.() ?? Date.now() - os.uptime() * 1000;
    if (written < boot - 60_000) return true;
    let known = this.starts.get(owner.pid);
    if (!known || known.until < Date.now()) {
      known = {
        started: (this.options.processStart ?? processStart)(owner.pid),
        until: Date.now() + 30_000,
      };
      this.starts.set(owner.pid, known);
    }
    const started = known.started;
    if (started === undefined) return false;
    if (typeof owner.started === "number")
      return Math.abs(started - owner.started) > startSlack;
    // Leases from older versions record no start time.
    return started > written + startSlack;
  }
  tryAcquire(key: string): (() => void) | null {
    mkdirSync(this.directory, { recursive: true });
    const folder = path.join(
      this.directory,
      createHash("sha256").update(key).digest("hex"),
    );
    const ownerFile = path.join(folder, "owner.json");
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(folder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
          if (!Number.isInteger(owner.pid) || !this.ownerGone(owner, ownerFile))
            return null;
          // Only one contender can reclaim a dead owner's directory.
          mkdirSync(path.join(folder, "reaping"));
          const current = JSON.parse(readFileSync(ownerFile, "utf8"));
          if (
            current.token !== owner.token ||
            !this.ownerGone(current, ownerFile)
          ) {
            rmSync(path.join(folder, "reaping"), {
              recursive: true,
              force: true,
            });
            return null;
          }
          rmSync(folder, { recursive: true, force: true });
          continue;
        } catch {
          // A process may still be writing its owner record. Never steal it.
          if (existsSync(ownerFile)) return null;
          try {
            const before = statSync(folder);
            if (Date.now() - before.mtimeMs < 10000) return null;
            mkdirSync(path.join(folder, "reaping"));
            if (existsSync(ownerFile) || statSync(folder).ino !== before.ino) {
              rmSync(path.join(folder, "reaping"), {
                recursive: true,
                force: true,
              });
              return null;
            }
            rmSync(folder, { recursive: true, force: true });
            continue;
          } catch {
            return null;
          }
        }
      }
      try {
        writeFileSync(
          ownerFile + ".tmp",
          JSON.stringify({
            pid: process.pid,
            started: Math.round(this.started),
            token,
            sessionName: this.sessionName,
          }),
          { mode: 0o600 },
        );
        renameSync(ownerFile + ".tmp", ownerFile);
      } catch (error) {
        rmSync(folder, { recursive: true, force: true });
        throw error;
      }
      return () => {
        try {
          if (JSON.parse(readFileSync(ownerFile, "utf8")).token === token)
            rmSync(folder, { recursive: true, force: true });
        } catch {
          /* Already released. */
        }
      };
    }
    return null;
  }
  claimFile(file: string) {
    // Resolve symlinks, including a not-yet-created Save As filename.
    let canonical: string;
    if (existsSync(file)) canonical = realpathSync(file);
    else {
      let parent = path.dirname(path.resolve(file));
      const suffix = [path.basename(file)];
      while (!existsSync(parent)) {
        suffix.unshift(path.basename(parent));
        parent = path.dirname(parent);
      }
      canonical = path.join(realpathSync(parent), ...suffix);
    }
    if (process.platform === "darwin") canonical = canonical.toLowerCase();
    const release = this.tryAcquire(`file:${canonical}`);
    if (!release)
      throw Error(
        "This file is already in use by another Cutline session. Choose another file or close it in that session first.",
      );
    return release;
  }
  async exportSlot(cancelled: () => boolean) {
    while (!cancelled()) {
      for (let slot = 0; slot < 2; slot++) {
        const release = this.tryAcquire(`export:${slot}`);
        if (release) return release;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error("Export cancelled");
  }
}
