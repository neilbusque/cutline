import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  utimesSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLeases } from "../src/main/session-leases";
import { Store } from "../src/main/store";

const hooks = vi.hoisted(() => ({
  beforeMkdir: undefined as ((directory: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (...args: any[]) => {
      hooks.beforeMkdir?.(String(args[0]));
      return (actual.mkdirSync as any)(...args);
    },
  };
});

const folders: string[] = [];
afterEach(() => {
  hooks.beforeMkdir = undefined;
  folders.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cutline-session-leases-"));
  folders.push(root);
  const a = new SessionLeases(path.join(root, "locks"), "A"),
    b = new SessionLeases(path.join(root, "locks"), "B");
  return { root, a, b };
}
describe("independent session file ownership", () => {
  it("blocks another store from opening or saving over a live project, releases on project change", () => {
    const { root, a, b } = setup(),
      file = path.join(root, "video.cutline");
    const first = new Store(path.join(root, "a", "recovery.cutline"), (p) =>
      a.claimFile(p),
    );
    const second = new Store(path.join(root, "b", "recovery.cutline"), (p) =>
      b.claimFile(p),
    );
    first.save(file);
    const original = readFileSync(file, "utf8");
    expect(() => second.load(file)).toThrow(/another Cutline session/);
    expect(() => second.save(file)).toThrow(/another Cutline session/);
    expect(() => second.persist(file)).toThrow(/another Cutline session/);
    expect(readFileSync(file, "utf8")).toBe(original);
    first.save(file); // Saving the owned project remains valid.
    first.fresh();
    second.load(file);
    second.close();
    first.close();
  });
  it("recognizes symbolic links to the same project", () => {
    const { root, a, b } = setup(),
      file = path.join(root, "video.cutline"),
      alias = path.join(root, "alias.cutline");
    writeFileSync(file, "{}");
    symlinkSync(file, alias);
    const release = a.claimFile(file);
    expect(() => b.claimFile(alias)).toThrow(/another Cutline session/);
    release();
    b.claimFile(alias)();
  });
  it("recovers a file from a dead process without releasing a newer owner's lease", () => {
    const { root, a, b } = setup();
    const release = a.tryAcquire("export:0")!;
    const file = path.join(
      root,
      "locks",
      readdirSync(path.join(root, "locks"))[0],
      "owner.json",
    );
    const old = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...old, pid: 2147483647 }));
    const next = b.tryAcquire("export:0");
    expect(next).not.toBeNull();
    release();
    expect(a.tryAcquire("export:0")).toBeNull();
    next!();
  });
  it("reclaims a lease whose PID now belongs to another program, never a live owner's", () => {
    const { root, a } = setup();
    const release = a.tryAcquire("export:0")!;
    const file = path.join(
      root,
      "locks",
      readdirSync(path.join(root, "locks"))[0],
      "owner.json",
    );
    const owner = JSON.parse(readFileSync(file, "utf8"));
    // This process owns it: ps agrees on when the owner started.
    expect(typeof owner.started).toBe("number");
    expect(
      new SessionLeases(path.join(root, "locks"), "B").tryAcquire("export:0"),
    ).toBeNull();
    // After a crash the PID went to a program that started an hour later.
    const reused = new SessionLeases(path.join(root, "locks"), "C", {
      processStart: () => owner.started + 3_600_000,
    });
    const next = reused.tryAcquire("export:0");
    expect(next).not.toBeNull();
    release(); // The old owner's release leaves the new lease alone.
    expect(a.tryAcquire("export:0")).toBeNull();
    next!();
  });
  it("reclaims leases from older versions left by a crash before a restart or a PID reuse", () => {
    const { root, a } = setup();
    a.tryAcquire("export:0");
    const file = path.join(
      root,
      "locks",
      readdirSync(path.join(root, "locks"))[0],
      "owner.json",
    );
    // Older versions recorded no start time.
    const { started: _started, ...older } = JSON.parse(
      readFileSync(file, "utf8"),
    );
    writeFileSync(file, JSON.stringify(older));
    const written = new Date(Date.now() - 600_000);
    utimesSync(file, written, written);
    const locks = path.join(root, "locks");
    // The owner's PID is alive and started before the lease: still its own.
    expect(
      new SessionLeases(locks, "B", {
        processStart: () => written.getTime() - 5_000,
      }).tryAcquire("export:0"),
    ).toBeNull();
    // Written before this Mac started up.
    const restarted = new SessionLeases(locks, "C", {
      bootTime: () => Date.now() - 60_000,
      processStart: () => written.getTime() - 5_000,
    }).tryAcquire("export:0");
    expect(restarted).not.toBeNull();
    restarted!();
    a.tryAcquire("export:0");
    const again = path.join(locks, readdirSync(locks)[0], "owner.json");
    writeFileSync(again, JSON.stringify({ ...older, token: "older" }));
    utimesSync(again, written, written);
    // The PID now belongs to a program that started after the lease was written.
    expect(
      new SessionLeases(locks, "D", {
        processStart: () => written.getTime() + 20_000,
      }).tryAcquire("export:0"),
    ).not.toBeNull();
  });
  it("keeps a conflicting recovery unsaved rather than overwriting the live file", () => {
    const { root, a, b } = setup(),
      file = path.join(root, "video.cutline");
    const first = new Store(path.join(root, "a", "recovery.cutline"), (p) =>
      a.claimFile(p),
    );
    first.save(file);
    const recovery = path.join(root, "b-recovery.cutline");
    writeFileSync(
      recovery,
      JSON.stringify({ project: first.project, filePath: file }),
    );
    const second = new Store(recovery, (p) => b.claimFile(p));
    expect(second.filePath).toBeNull();
    expect(second.project.id).toBe(first.project.id);
    expect(second.notices[0]).toContain("another session");
    second.close();
    first.close();
  });
  it("does not reap a replacement live owner after reading a stale lease", () => {
    const { root, a, b } = setup();
    a.tryAcquire("export:0");
    const folder = path.join(
      root,
      "locks",
      readdirSync(path.join(root, "locks"))[0],
    );
    const file = path.join(folder, "owner.json");
    const old = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...old, pid: 2147483647 }));
    let replaced = false;
    hooks.beforeMkdir = (directory) => {
      if (replaced || directory !== path.join(folder, "reaping")) return;
      replaced = true;
      // A different contender finished reclaiming just after this contender
      // read the dead owner. Its new lease must survive our stale decision.
      rmSync(folder, { recursive: true });
      mkdirSync(folder);
      writeFileSync(
        file,
        JSON.stringify({
          pid: process.pid,
          token: "replacement",
          sessionName: "C",
        }),
      );
    };
    expect(b.tryAcquire("export:0")).toBeNull();
    expect(replaced).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("replacement");
    expect(existsSync(path.join(folder, "reaping"))).toBe(false);
  });

  it("reclaims an abandoned atomic owner write after the startup grace period", () => {
    const { root, a, b } = setup();
    a.tryAcquire("export:0");
    const folder = path.join(
      root,
      "locks",
      readdirSync(path.join(root, "locks"))[0],
    );
    rmSync(path.join(folder, "owner.json"));
    writeFileSync(path.join(folder, "owner.json.tmp"), "{interrupted");
    const old = new Date(Date.now() - 20000);
    utimesSync(folder, old, old);
    const release = b.tryAcquire("export:0");
    expect(release).not.toBeNull();
    expect(
      JSON.parse(readFileSync(path.join(folder, "owner.json"), "utf8")).pid,
    ).toBe(process.pid);
    expect(existsSync(path.join(folder, "owner.json.tmp"))).toBe(false);
    release!();
  });

  it("acquires the project lease before reading and releases it after invalid JSON", () => {
    const { root, a, b } = setup();
    const file = path.join(root, "video.cutline");
    const seed = new Store(path.join(root, "seed", "recovery.cutline"));
    seed.project.name = "Old snapshot";
    seed.save(file);
    const reader = new Store(
      path.join(root, "reader", "recovery.cutline"),
      (target) => {
        // Simulate the last write made before the original owner released it.
        seed.project.name = "Latest snapshot";
        seed.save(target);
        return a.claimFile(target);
      },
    );
    reader.load(file);
    expect(reader.project.name).toBe("Latest snapshot");
    reader.close();
    seed.close();

    writeFileSync(file, "invalid JSON");
    const invalid = new Store(
      path.join(root, "invalid", "recovery.cutline"),
      (target) => a.claimFile(target),
    );
    expect(() => invalid.load(file)).toThrow();
    expect(() => b.claimFile(file)()).not.toThrow();
    invalid.close();
  });

  it("limits rendering to two exports and frees a slot for waiting work", async () => {
    const { a, b } = setup();
    const first = await a.exportSlot(() => false),
      second = await b.exportSlot(() => false);
    let acquired = false;
    const third = a
      .exportSlot(() => false)
      .then((release) => {
        acquired = true;
        return release;
      });
    await new Promise((r) => setTimeout(r, 30));
    expect(acquired).toBe(false);
    first();
    const release = await third;
    expect(acquired).toBe(true);
    release();
    second();
    await expect(a.exportSlot(() => true)).rejects.toThrow(/cancelled/);
  });
});
