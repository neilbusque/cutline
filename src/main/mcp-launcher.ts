import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { readSessionConnection, sessionIds } from "./sessions";

export const CUTLINE_CLOSED =
  "Cutline is not open. Open Cutline, then try again.";

/** Thrown when no running Cutline answers; the launcher may open it and retry. */
class CutlineClosed extends Error {
  constructor() {
    super(CUTLINE_CLOSED);
  }
}

type Connection = { base: string; pid?: number };

function readConnection(file: string): Connection | undefined {
  if (!existsSync(file)) return undefined;
  let data: any;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof data?.base !== "string" || !URL.canParse(data.base))
    return undefined;
  const local = new URL(data.base);
  if (local.protocol !== "http:" || local.hostname !== "127.0.0.1")
    throw Error("Cutline connection must point to this Mac.");
  return {
    base: data.base,
    pid: typeof data.pid === "number" ? data.pid : undefined,
  };
}

/** A connection whose process is gone is left over from a Cutline that quit or crashed. */
function running(pid?: number) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * POSTs JSON with node:http. Unlike fetch (undici gives up after 300 seconds
 * without response headers), it waits as long as the call needs, up to
 * timeoutMs of silence.
 */
export function postJson(url: string, body: unknown, timeoutMs: number) {
  return new Promise<any>((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(
              Object.assign(
                Error(
                  `Cutline answered unexpectedly (HTTP ${response.statusCode}).`,
                ),
                { code: "CUTLINE_UNEXPECTED" },
              ),
            );
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(
        Object.assign(
          Error(
            "Cutline did not answer in time. The work may still finish; check cutline_jobs.",
          ),
          { code: "CUTLINE_TIMEOUT" },
        ),
      ),
    );
    request.on("error", reject);
    request.end(data);
  });
}

export type LauncherOptions = {
  /** connection.json written by the running app. */
  connection: string;
  /** Shared profile root; inferred from the connection path when omitted. */
  sessionRoot?: string;
  /** Session owning the configured connection; main by default. */
  currentId?: string;
  /** Tool list served while Cutline is closed. */
  tools: () => unknown[] | Promise<unknown[]>;
  /** Starts Cutline; returns false when it cannot. */
  open?: () => Promise<boolean>;
  /** How long to wait for a started Cutline to answer. */
  openWaitMs?: number;
  timeoutMs?: number;
  pollMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The stdio launcher's link to the running app's local bridge. */
export function createLauncher(options: LauncherOptions) {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const directory = path.dirname(options.connection);
  const childProfile = path.basename(path.dirname(directory)) === "sessions";
  const rootData =
    options.sessionRoot ??
    (childProfile ? path.dirname(path.dirname(directory)) : directory);
  const currentId =
    options.currentId ?? (childProfile ? path.basename(directory) : "main");
  function connections(name: string, args: unknown) {
    const input =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    // Opening a closed session requires a live manager, rather than its dead
    // bridge. The manager validates the target and keeps the same profile.
    const management = name === "cutline_sessions";
    const explicit = input.sessionId;
    if (explicit !== undefined && !management) {
      if (typeof explicit !== "string" || !explicit)
        throw Error("sessionId must be a nonempty ID from cutline_sessions.");
      const target =
        explicit === currentId
          ? readConnection(options.connection)
          : readSessionConnection(rootData, explicit);
      if (!target || !running(target.pid))
        throw Error(
          `Cutline session ${explicit} is not running or does not exist. Use cutline_sessions to list or open it. The call was not sent to another session.`,
        );
      return { explicit, entries: [target], otherSessions: false };
    }
    const configured = readConnection(options.connection);
    const entries = configured && running(configured.pid) ? [configured] : [];
    let otherSessions = false;
    const discovery = management || name === "tools.list";
    for (const id of sessionIds(rootData)) {
      const connection = readSessionConnection(rootData, id);
      if (
        connection &&
        running(connection.pid) &&
        !entries.some((entry) => entry.base === connection.base)
      ) {
        if (id !== currentId) otherSessions = true;
        if (discovery) entries.push(connection);
      }
    }
    return {
      explicit: undefined,
      entries,
      otherSessions: !discovery && otherSessions,
    };
  }
  async function attempt(name: string, args: unknown, timeout = timeoutMs) {
    const { explicit, entries, otherSessions } = connections(name, args);
    for (const connection of entries) {
      try {
        return await postJson(
          connection.base + "/rpc",
          { name, args },
          timeout,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A refused connection never received the call. Only untargeted
        // discovery may try another manager; an explicit target never moves.
        if (code === "ECONNREFUSED") {
          if (explicit !== undefined)
            throw Error(
              `Cutline session ${explicit} is no longer available. The call was not sent to another session.`,
            );
          continue;
        }
        if (code === "CUTLINE_UNEXPECTED")
          throw Error(
            "Cutline returned an unreadable response. Inspect this session and its jobs before retrying; the call was not sent to another session.",
          );
        if (code === "ECONNRESET" || code === "EPIPE")
          throw Error(
            "Cutline closed before it answered. Open Cutline, inspect the project and try again.",
          );
        throw error;
      }
    }
    if (otherSessions)
      throw Error(
        `The configured Cutline session ${currentId} is closed. Use cutline_sessions to open it, or explicitly choose another sessionId for this chat. The call was not sent to another session.`,
      );
    throw new CutlineClosed();
  }
  async function reachable() {
    try {
      await attempt("tools.list", {}, 2000);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Calls a tool in the running app, opening Cutline first when it is closed.
   * A status check reports that Cutline is closed instead of opening it.
   */
  async function rpc(name: string, args: unknown = {}) {
    let data: any;
    try {
      data = await attempt(name, args);
    } catch (error) {
      if (
        error instanceof CutlineClosed &&
        name === "cutline_connection_status"
      )
        return {
          ready: false,
          message:
            "Cutline is closed. Any other Cutline tool opens it in the background.",
        };
      if (
        !(error instanceof CutlineClosed) ||
        !options.open ||
        name === "cutline_jobs"
      )
        throw error;
      if (!(await options.open())) throw error;
      const until = Date.now() + (options.openWaitMs ?? 20_000);
      while (!(await reachable())) {
        if (Date.now() > until)
          throw Error(
            "Cutline is starting but did not answer yet. Try again in a moment.",
          );
        await sleep(options.pollMs ?? 300);
      }
      data = await attempt(name, args);
    }
    if (data?.error) throw Error(data.error);
    return data?.result;
  }
  /** The running app's tools, or the bundled list while Cutline is closed. */
  async function listTools() {
    try {
      const data = await attempt("tools.list", {}, 5000);
      if (Array.isArray(data?.result)) return data.result;
    } catch {
      /* Closed or busy: the bundled list is the same set of tools. */
    }
    return await options.tools();
  }
  return { rpc, listTools };
}

/**
 * The environment `open` passes to Cutline. The launcher runs Electron in node
 * mode, and so do editors such as VS Code that start assistants; macOS hands
 * the caller's variables to the app, which then starts as plain node and
 * quits at once.
 */
export function appOpenEnv(env: NodeJS.ProcessEnv) {
  const { ELECTRON_RUN_AS_NODE: _node, ...rest } = env;
  return rest;
}

/**
 * Opens the installed Cutline app in the background. Only a packaged
 * Cutline.app opens itself; development builds run inside Electron.app.
 */
export function openCutlineApp(executable = process.execPath) {
  const bundle = executable.match(
    /^(.*\/Cutline\.app)\/Contents\/MacOS\//,
  )?.[1];
  if (!bundle || process.platform !== "darwin" || !existsSync(bundle))
    return Promise.resolve(false);
  return new Promise<boolean>((resolve) =>
    execFile(
      "open",
      ["-g", path.resolve(bundle)],
      { env: appOpenEnv(process.env) },
      (error) => resolve(!error),
    ),
  );
}
