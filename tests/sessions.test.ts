import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import http from "node:http";
import {
  SessionManager,
  type SessionManagerOptions,
  processExists,
  readSessionConnection,
  resolveSessionContext,
  sessionDataDirectory,
  sessionIds,
  probeSessionConnection,
} from "../src/main/sessions";

const idA = "11111111-1111-4111-8111-111111111111";
const idB = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [];
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stop of cleanup.splice(0)) await stop();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function root() {
  const directory = mkdtempSync(path.join(tmpdir(), "cutline-sessions-"));
  directories.push(directory);
  return directory;
}
function manager(
  directory: string,
  id = "main",
  extra: Partial<SessionManagerOptions> = {},
) {
  return new SessionManager({
    context: resolveSessionContext(directory, { CUTLINE_SESSION_ID: id }, []),
    executable: "/Applications/Cutline.app/Contents/MacOS/Cutline",
    version: "1.2.3",
    ...extra,
  });
}
function connection(
  directory: string,
  id = "main",
  pid = process.pid,
  base = "http://127.0.0.1:3456/secret-token",
) {
  const folder = sessionDataDirectory(directory, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "connection.json"),
    JSON.stringify({ base, pid, token: "never-expose" }),
  );
}
function childProcess() {
  return Object.assign(new EventEmitter(), {
    unref: vi.fn(),
    exitCode: null,
    pid: 99999,
  }) as unknown as ChildProcess;
}

describe("Cutline session profiles", () => {
  it("resolves main, environment and command-line profiles without nesting inherited child data", () => {
    const directory = root();
    expect(resolveSessionContext(directory, {}, []).dataDir).toBe(directory);
    const child = resolveSessionContext(
      "/wrong-inherited-child",
      {
        CUTLINE_SESSION_ROOT: directory,
        CUTLINE_SESSION_ID: idA,
        CUTLINE_DATA_DIR: "/must-not-control-child-path",
      },
      [],
    );
    expect(child.dataDir).toBe(path.join(directory, "sessions", idA));
    expect(child.connectionFile).toBe(
      path.join(child.dataDir, "connection.json"),
    );
    expect(
      resolveSessionContext(directory, { CUTLINE_SESSION_ID: idA }, [
        "--cutline-session",
        idB,
      ]).id,
    ).toBe(idB);
    expect(
      resolveSessionContext(directory, {}, [`--cutline-session=${idA}`]).id,
    ).toBe(idA);
  });

  it("rejects traversal, malformed IDs, missing arguments and symlink session escapes", () => {
    const directory = root();
    for (const id of [
      "../main",
      "",
      "sessions",
      "MAIN",
      "a/b",
      "/tmp",
      `${idA}/../${idB}`,
    ])
      expect(() => sessionDataDirectory(directory, id)).toThrow(
        "Invalid Cutline session ID",
      );
    expect(() =>
      resolveSessionContext(directory, {}, ["--cutline-session"]),
    ).toThrow("requires a session ID");
    const outside = root();
    mkdirSync(path.join(directory, "sessions"));
    symlinkSync(outside, path.join(directory, "sessions", idA));
    expect(() => sessionDataDirectory(directory, idA)).toThrow(
      "symbolic links",
    );
    expect(sessionIds(directory)).toEqual(["main"]);
  });

  it("keeps independently named project metadata and cleanly closed sessions available to reopen", async () => {
    const directory = root();
    const first = manager(directory, "main", { probe: async () => true });
    const second = manager(directory, idA, { probe: async () => true });
    first.register("First video");
    second.register("Second video");
    first.updateProject({ id: "project-a", name: "Reel A" });
    second.updateProject({ id: "project-b", name: "Reel B" });
    connection(directory);
    connection(directory, idA);
    const sessions = await first.list();
    expect(
      sessions.map((item) => [
        item.name,
        item.projectId,
        item.running,
        item.current,
      ]),
    ).toEqual([
      ["First video", "project-a", true, true],
      ["Second video", "project-b", true, false],
    ]);
    expect(JSON.stringify(sessions)).not.toContain("secret-token");
    expect(JSON.stringify(sessions)).not.toContain(directory);
    expect(
      statSync(path.join(directory, "sessions", idA, "session.json")).mode &
        0o777,
    ).toBe(0o600);
    second.close();
    const closed = (await first.list())[1];
    expect(closed).toMatchObject({
      id: idA,
      name: "Second video",
      projectId: "project-b",
      running: false,
    });
    expect(closed.pid).toBeUndefined();
    const restarted = manager(directory, idA, { probe: async () => true });
    expect(restarted.register()).toMatchObject({
      name: "Second video",
      projectName: "Reel B",
    });
    restarted.updateProject(null);
    expect(restarted.current().projectId).toBeUndefined();
    expect(first.current().projectId).toBe("project-a");
  });

  it("does not report a crashed or PID-reused session as running and ignores broken metadata", async () => {
    const directory = root();
    const first = manager(directory, "main", {
      isProcessRunning: () => false,
      probe: async () => true,
    });
    first.register();
    connection(directory);
    expect((await first.list())[0]).toMatchObject({
      running: false,
      active: false,
    });
    const reused = manager(directory, "main", {
      isProcessRunning: () => true,
      probe: async () => false,
    });
    expect((await reused.list())[0]).toMatchObject({
      running: false,
      active: true,
    });
    mkdirSync(path.join(directory, "sessions", idA), { recursive: true });
    writeFileSync(
      path.join(directory, "sessions", idA, "session.json"),
      "{partial write",
    );
    expect(await reused.list()).toHaveLength(1);
    expect(processExists(process.pid)).toBe(true);
    expect(processExists(-1)).toBe(false);
  });

  it("validates the local connection and rejects stale metadata ownership", () => {
    const directory = root();
    manager(directory).register();
    connection(directory);
    expect(readSessionConnection(directory, "main")?.pid).toBe(process.pid);
    for (const base of [
      "https://127.0.0.1:123/token",
      "http://example.com:123/token",
      "http://user:secret@127.0.0.1:123/token",
      "http://127.0.0.1:123/",
      "file:///tmp/secret",
    ]) {
      connection(directory, "main", process.pid, base);
      expect(readSessionConnection(directory, "main")).toBeUndefined();
    }
    connection(directory, "main", process.pid + 1);
    expect(readSessionConnection(directory, "main")).toBeUndefined();
  });

  it("starts isolated detached children with clean environment and keeps secrets out of session metadata", async () => {
    const directory = root();
    const child = childProcess();
    const startProcess = vi.fn((_exe, _args, options) => {
      const childManager = manager(directory, options.env.CUTLINE_SESSION_ID);
      childManager.register();
      connection(directory, options.env.CUTLINE_SESSION_ID);
      return child;
    });
    const first = manager(directory, "main", {
      sourceRoot: "/source/Cutline With Spaces",
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        CUTLINE_PROJECTS_DIR: "/another/project-library",
        CUTLINE_CONNECTION: "/another/connection.json",
        CUTLINE_DATA_DIR: "/another/data",
        CUTLINE_SESSION_ID: idA,
        CUTLINE_SESSION_NAME: "inherited name",
        PATH: "/bin",
      },
      startProcess,
      probe: async () => true,
    });
    first.register();
    const created = await first.create("Parallel edit");
    expect(created).toMatchObject({
      name: "Parallel edit",
      running: true,
      current: false,
    });
    const [exe, args, options] = startProcess.mock.calls[0];
    expect(exe).toBe("/Applications/Cutline.app/Contents/MacOS/Cutline");
    expect(args).toEqual(["/source/Cutline With Spaces"]);
    expect(options).toMatchObject({
      detached: true,
      stdio: "ignore",
      cwd: "/source/Cutline With Spaces",
    });
    expect(options.env).toEqual({
      PATH: "/bin",
      CUTLINE_SESSION_ROOT: directory,
      CUTLINE_SESSION_ID: created.id,
      CUTLINE_DATA_DIR: path.join(directory, "sessions", created.id),
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(JSON.stringify(created)).not.toContain("secret-token");
  });

  it("keeps a newly ready child live through immediate cold-start load without caching failures", async () => {
    const directory = root();
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const first = manager(directory, "main", {
      startProcess: (_exe, _args, options) => {
        const child = manager(directory, options.env.CUTLINE_SESSION_ID);
        child.register();
        connection(directory, options.env.CUTLINE_SESSION_ID);
        return childProcess();
      },
      probe,
    });
    first.register();
    const created = await first.create("Cold start");
    expect(created.running).toBe(true);
    expect(
      (await first.list()).find((item) => item.id === created.id),
    ).toMatchObject({ running: true, active: true });
    expect(probe).toHaveBeenCalledOnce();

    const afterCache = Date.now() + 3100;
    vi.spyOn(Date, "now").mockReturnValue(afterCache);
    expect(await first.connectionFor(created.id)).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
    probe.mockResolvedValueOnce(true);
    expect(await first.connectionFor(created.id)).toBeDefined();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("immediately invalidates readiness when the process dies even within the positive cache", async () => {
    const directory = root();
    let processRunning = true;
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const first = manager(directory, "main", {
      probe,
      isProcessRunning: () => processRunning,
    });
    first.register();
    connection(directory);
    expect(await first.connectionFor("main")).toBeDefined();
    processRunning = false;
    expect(await first.connectionFor("main")).toBeUndefined();
    expect((await first.list())[0]).toMatchObject({
      running: false,
      active: false,
    });
    expect(probe).toHaveBeenCalledOnce();
    // Reused PIDs must prove readiness again; dead-process evidence cleared it.
    processRunning = true;
    expect(await first.connectionFor("main")).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("immediately invalidates cached readiness when the connection or owner changes", async () => {
    const directory = root();
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const first = manager(directory, "main", { probe });
    first.register();
    connection(directory);
    expect(await first.connectionFor("main")).toBeDefined();
    connection(
      directory,
      "main",
      process.pid,
      "http://127.0.0.1:6789/replacement-token",
    );
    expect(await first.connectionFor("main")).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
    // Returning to the earlier file cannot resurrect its invalidated cache.
    connection(directory);
    expect(await first.connectionFor("main")).toBeUndefined();
    probe.mockResolvedValueOnce(true);
    expect(await first.connectionFor("main")).toBeDefined();
    first.close();
    expect(await first.connectionFor("main")).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("reopens the same saved profile, coalesces simultaneous requests and focuses a live session", async () => {
    const directory = root();
    const saved = manager(directory, idA);
    saved.register("Saved video");
    saved.updateProject({ id: "retained", name: "Recovered project" });
    saved.close();
    const focus = vi.fn();
    const startProcess = vi.fn(() => {
      const restored = manager(directory, idA);
      restored.register();
      connection(directory, idA);
      return childProcess();
    });
    const first = manager(directory, "main", {
      focus,
      startProcess,
      probe: async () => true,
    });
    first.register();
    const [one, two] = await Promise.all([first.open(idA), first.open(idA)]);
    expect(one).toEqual(two);
    expect(one).toMatchObject({
      id: idA,
      name: "Saved video",
      projectId: "retained",
      running: true,
    });
    expect(startProcess).toHaveBeenCalledOnce();
    await first.open(idA);
    expect(startProcess).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(focus.mock.calls[0][1]).toBe(
      path.join(directory, "sessions", idA, "connection.json"),
    );
  });

  it("retains sessions after a failed startup and reports a bounded readiness timeout", async () => {
    const directory = root();
    const first = manager(directory, "main", {
      startProcess: () => childProcess(),
      startWaitMs: 5,
      pollMs: 2,
      probe: async () => false,
    });
    first.register();
    await expect(first.create("Recover me")).rejects.toThrow("It is saved");
    expect(
      (await first.list()).find((item) => item.name === "Recover me"),
    ).toMatchObject({ running: false });
    await expect(first.open(idB)).rejects.toThrow("was not found");
  });

  it("a closing old process does not erase a newer owner's session metadata", () => {
    const directory = root();
    const first = manager(directory);
    first.register();
    const file = path.join(directory, "session.json");
    const newer = {
      ...JSON.parse(readFileSync(file, "utf8")),
      pid: process.pid + 123,
    };
    writeFileSync(file, JSON.stringify(newer));
    first.close();
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(newer.pid);
  });

  it("probes the actual local bridge and rejects an unrelated or stopped listener", async () => {
    const server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/correct/rpc"
            ? { result: [] }
            : { error: "forbidden" },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const port = (server.address() as { port: number }).port;
    expect(
      await probeSessionConnection({
        base: `http://127.0.0.1:${port}/correct`,
        pid: process.pid,
      }),
    ).toBe(true);
    expect(
      await probeSessionConnection({
        base: `http://127.0.0.1:${port}/wrong`,
        pid: process.pid,
      }),
    ).toBe(false);
  });
});
