import { createHash, randomUUID } from "node:crypto";
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
import path from "node:path";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Process-owned leases shared by independent editor processes. */
export class SessionLeases {
  constructor(
    readonly directory: string,
    readonly sessionName: string,
  ) {}
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
          if (!Number.isInteger(owner.pid) || alive(owner.pid)) return null;
          // Only one contender can reclaim a dead owner's directory.
          mkdirSync(path.join(folder, "reaping"));
          const current = JSON.parse(readFileSync(ownerFile, "utf8"));
          if (current.token !== owner.token || alive(current.pid)) {
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
