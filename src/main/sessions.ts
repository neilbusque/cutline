import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

export type SessionInfo = {
  id: string;
  name: string;
  projectId?: string;
  projectName?: string;
  running: boolean;
  /** Conservatively counts registered processes even while their bridge is busy. */
  active?: boolean;
  current: boolean;
  pid?: number;
  version?: string;
  createdAt: string;
  updatedAt: string;
};
export type SessionConnection = { base: string; pid: number };
export type SessionContext = {
  id: string;
  rootData: string;
  dataDir: string;
  connectionFile: string;
  metadataFile: string;
};
type SessionMetadata = Omit<
  SessionInfo,
  "running" | "active" | "current" | "pid"
> & {
  pid: number | null;
};

export function validateSessionId(id: string): string {
  if (
    id !== "main" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  )
    throw Error("Invalid Cutline session ID. Choose a session from the list.");
  return id;
}

/** Session IDs never become arbitrary paths, including through symlinks. */
export function sessionDataDirectory(rootData: string, id: string): string {
  validateSessionId(id);
  const root = path.resolve(rootData);
  if (id === "main") return root;
  const folder = path.join(root, "sessions");
  const data = path.join(folder, id);
  for (const item of [folder, data]) {
    try {
      if (lstatSync(item).isSymbolicLink())
        throw Error("Cutline session folders cannot be symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return data;
}

export function resolveSessionContext(
  defaultRootData: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): SessionContext {
  const flag = argv.findIndex((arg) => arg === "--cutline-session");
  const inline = argv.find((arg) => arg.startsWith("--cutline-session="));
  const argument =
    inline?.slice("--cutline-session=".length) ??
    (flag >= 0 ? argv[flag + 1] : undefined);
  if ((flag >= 0 || inline !== undefined) && !argument)
    throw Error("--cutline-session requires a session ID.");
  const id = validateSessionId(argument ?? env.CUTLINE_SESSION_ID ?? "main");
  const rootData = path.resolve(env.CUTLINE_SESSION_ROOT || defaultRootData);
  const dataDir = sessionDataDirectory(rootData, id);
  return {
    id,
    rootData,
    dataDir,
    connectionFile: path.join(dataDir, "connection.json"),
    metadataFile: path.join(dataDir, "session.json"),
  };
}

export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readMetadata(
  rootData: string,
  id: string,
): SessionMetadata | undefined {
  const value = readJson(
    path.join(sessionDataDirectory(rootData, id), "session.json"),
  );
  if (
    value?.id !== id ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  )
    return undefined;
  // Only known non-secret fields ever leave the metadata reader.
  return {
    id,
    name: value.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    pid: Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null,
    ...(typeof value.projectId === "string"
      ? { projectId: value.projectId }
      : {}),
    ...(typeof value.projectName === "string"
      ? { projectName: value.projectName }
      : {}),
    ...(typeof value.version === "string" ? { version: value.version } : {}),
  };
}

export function sessionIds(rootData: string): string[] {
  const ids = ["main"];
  const folder = path.join(path.resolve(rootData), "sessions");
  if (!existsSync(folder) || lstatSync(folder).isSymbolicLink()) return ids;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      validateSessionId(entry.name);
      if (entry.name !== "main") ids.push(entry.name);
    } catch {
      /* Unknown folders are not sessions. */
    }
  }
  return ids;
}

/** Internal only: the bearer URL must never be included in public summaries. */
export function readSessionConnection(
  rootData: string,
  id: string,
): SessionConnection | undefined {
  const directory = sessionDataDirectory(rootData, id);
  const value = readJson(path.join(directory, "connection.json"));
  if (
    typeof value?.base !== "string" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(value.base);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  )
    return undefined;
  const metadata = readMetadata(rootData, id);
  if (metadata && metadata.pid !== value.pid) return undefined;
  return { base: value.base.replace(/\/$/, ""), pid: value.pid };
}

/** Validate the bearer endpoint, not just the PID (which the OS can reuse). */
export function probeSessionConnection(
  connection: SessionConnection,
): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name: "tools.list", args: {} });
    let done = false;
    const finish = (alive: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(alive);
    };
    const request = http.request(
      `${connection.base}/rpc`,
      {
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
          if (data.length > 2000000) request.destroy();
        });
        response.on("error", () => finish(false));
        response.on("end", () => {
          try {
            finish(
              response.statusCode === 200 &&
                Array.isArray(JSON.parse(data)?.result),
            );
          } catch {
            finish(false);
          }
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish(false);
    }, 1500);
    request.on("error", () => finish(false));
    request.end(body);
  });
}

let writes = 0;
function writeMetadata(rootData: string, metadata: SessionMetadata) {
  const directory = sessionDataDirectory(rootData, metadata.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "session.json");
  const temporary = `${file}.${process.pid}-${++writes}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(metadata, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sessionName(name: string | undefined, fallback: string) {
  if (name === undefined) return fallback;
  if (typeof name !== "string") throw Error("Session name must be text.");
  const clean = name
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 80);
  if (!clean) throw Error("Give this session a name.");
  return clean;
}

type StartOptions = {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  detached: true;
  stdio: "ignore";
};
export type SessionManagerOptions = {
  context: SessionContext;
  executable: string;
  sourceRoot?: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  focus?: (
    session: SessionInfo,
    connectionFile: string,
  ) => void | Promise<void>;
  startWaitMs?: number;
  pollMs?: number;
  /** Injectable boundaries make crash, timeout and process isolation testable. */
  startProcess?: (
    executable: string,
    args: string[],
    options: StartOptions,
  ) => ChildProcess;
  isProcessRunning?: (pid: number) => boolean;
  probe?: (connection: SessionConnection) => Promise<boolean>;
};

export class SessionManager {
  readonly context: SessionContext;
  private options: SessionManagerOptions;
  private metadata?: SessionMetadata;
  private pending = new Map<string, Promise<SessionInfo>>();
  private readyConnections = new Map<
    string,
    { pid: number; base: string; until: number }
  >();

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.context = options.context;
  }

  /** Call only after acquiring the profile's Electron single-instance lock. */
  register(name?: string): SessionInfo {
    const previous = readMetadata(this.context.rootData, this.context.id);
    const at = new Date().toISOString();
    this.metadata = {
      ...previous,
      id: this.context.id,
      name: sessionName(
        name,
        previous?.name ??
          (this.context.id === "main" ? "Main session" : "Video session"),
      ),
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
      pid: process.pid,
      version: this.options.version,
    };
    writeMetadata(this.context.rootData, this.metadata);
    return this.current();
  }

  current(): SessionInfo {
    const metadata =
      this.metadata ?? readMetadata(this.context.rootData, this.context.id);
    if (!metadata) throw Error("This Cutline session has not registered yet.");
    return this.summary(metadata, metadata.pid === process.pid);
  }

  updateProject(project: { id: string; name: string } | null) {
    if (!this.metadata) return;
    // Timeline drags and preview updates can emit many changes per second.
    // Session discovery only needs the project identity and display name.
    if (
      this.metadata.projectId === project?.id &&
      this.metadata.projectName === project?.name
    )
      return;
    const { projectId: _id, projectName: _name, ...previous } = this.metadata;
    this.metadata = {
      ...previous,
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeMetadata(this.context.rootData, this.metadata);
  }

  private summary(metadata: SessionMetadata, running: boolean): SessionInfo {
    const { pid, ...publicMetadata } = metadata;
    return {
      ...publicMetadata,
      running,
      active: Boolean(
        pid && (this.options.isProcessRunning ?? processExists)(pid),
      ),
      current: metadata.id === this.context.id,
      ...(running && pid ? { pid } : {}),
    };
  }

  private async liveConnection(
    id: string,
  ): Promise<SessionConnection | undefined> {
    const connection = readSessionConnection(this.context.rootData, id);
    if (
      !connection ||
      !(this.options.isProcessRunning ?? processExists)(connection.pid)
    ) {
      this.readyConnections.delete(id);
      return undefined;
    }
    // A new window can briefly saturate its event loop after its bridge first
    // answers. Reuse that positive evidence for a short interval, while still
    // checking the on-disk identity and process before every use.
    const recent = this.readyConnections.get(id);
    if (
      recent?.pid === connection.pid &&
      recent.base === connection.base &&
      recent.until > Date.now()
    )
      return connection;
    this.readyConnections.delete(id);
    try {
      const alive = this.options.probe
        ? await this.options.probe(connection)
        : await probeSessionConnection(connection);
      if (!alive) return undefined;
      this.readyConnections.set(id, {
        ...connection,
        until: Date.now() + 3000,
      });
      return connection;
    } catch {
      return undefined;
    }
  }

  async connectionFor(id: string): Promise<SessionConnection | undefined> {
    validateSessionId(id);
    return this.liveConnection(id);
  }

  async list(): Promise<SessionInfo[]> {
    const entries = await Promise.all(
      sessionIds(this.context.rootData).map(async (id) => {
        const metadata = readMetadata(this.context.rootData, id);
        if (!metadata) return undefined;
        return this.summary(metadata, Boolean(await this.liveConnection(id)));
      }),
    );
    return entries
      .filter((entry): entry is SessionInfo => Boolean(entry))
      .sort((a, b) =>
        a.id === "main"
          ? -1
          : b.id === "main"
            ? 1
            : a.createdAt.localeCompare(b.createdAt),
      );
  }

  async create(name?: string): Promise<SessionInfo> {
    const id = randomUUID();
    const at = new Date().toISOString();
    const count = sessionIds(this.context.rootData).length;
    const metadata: SessionMetadata = {
      id,
      name: sessionName(name, `Video ${count + 1}`),
      createdAt: at,
      updatedAt: at,
      version: this.options.version,
      pid: null,
    };
    writeMetadata(this.context.rootData, metadata);
    return this.open(id);
  }

  open(id: string): Promise<SessionInfo> {
    validateSessionId(id);
    const existing = this.pending.get(id);
    if (existing) return existing;
    const operation = this.startOrFocus(id).finally(() =>
      this.pending.delete(id),
    );
    this.pending.set(id, operation);
    return operation;
  }

  private async startOrFocus(id: string): Promise<SessionInfo> {
    const metadata = readMetadata(this.context.rootData, id);
    if (!metadata)
      throw Error(
        "That Cutline session was not found. Refresh the session list.",
      );
    const directory = sessionDataDirectory(this.context.rootData, id);
    const connectionFile = path.join(directory, "connection.json");
    if (await this.liveConnection(id)) {
      const info = this.summary(metadata, true);
      await this.options.focus?.(info, connectionFile);
      return info;
    }
    const env = { ...(this.options.env ?? process.env) };
    for (const key of [
      "ELECTRON_RUN_AS_NODE",
      "CUTLINE_PROJECTS_DIR",
      "CUTLINE_CONNECTION",
      "CUTLINE_SESSION_NAME",
    ])
      delete env[key];
    Object.assign(env, {
      CUTLINE_SESSION_ROOT: this.context.rootData,
      CUTLINE_SESSION_ID: id,
      CUTLINE_DATA_DIR: directory,
    });
    // No inherited project argument: each process restores only its own recovery file.
    const args = this.options.sourceRoot ? [this.options.sourceRoot] : [];
    const child = (this.options.startProcess ?? spawn)(
      this.options.executable,
      args,
      {
        env,
        ...(this.options.sourceRoot ? { cwd: this.options.sourceRoot } : {}),
        detached: true,
        stdio: "ignore",
      },
    );
    let startupError: Error | undefined;
    child.once("error", (error) => {
      startupError = error;
    });
    child.unref();
    const until = Date.now() + (this.options.startWaitMs ?? 20000);
    while (Date.now() <= until) {
      if (startupError)
        throw Error(
          `Cutline could not start this session: ${startupError.message}`,
        );
      const connection = await this.liveConnection(id);
      if (connection) {
        const current = readMetadata(this.context.rootData, id) ?? metadata;
        return this.summary(current, true);
      }
      if (
        child.exitCode !== null &&
        child.exitCode !== undefined &&
        child.exitCode !== 0
      )
        throw Error(
          `Cutline closed before this session was ready (exit ${child.exitCode}). The saved session is available to reopen.`,
        );
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.pollMs ?? 150),
      );
    }
    throw Error(
      "Cutline is starting but this session did not answer yet. It is saved; reopen it from the session list in a moment.",
    );
  }

  /** Saved sessions survive shutdown. A retiring process cannot mark a newer one closed. */
  close() {
    const metadata = readMetadata(this.context.rootData, this.context.id);
    if (metadata?.pid !== process.pid) return;
    this.metadata = {
      ...metadata,
      pid: null,
      updatedAt: new Date().toISOString(),
    };
    writeMetadata(this.context.rootData, this.metadata);
  }
}
