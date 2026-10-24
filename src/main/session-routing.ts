import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { postJson } from "./mcp-launcher";
import type { SessionConnection, SessionInfo } from "./sessions";

const sessionIdSchema = {
  type: "string",
};

/** External clients name a session on each call; there is no shared selection. */
export function sessionTools(tools: Tool[]): Tool[] {
  const management: Tool = {
    name: "cutline_sessions",
    description:
      "List/create/open independent sessions. Omit sessionId for list/create; open requires it. Keep the chosen sessionId on every later call in this chat, including job checks. Required when multiple sessions are open; never select another session to bypass an unavailable target.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "open"] },
        name: { type: "string", minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
  return [
    management,
    ...tools.filter((tool) => tool.name !== management.name),
  ].map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        sessionId: sessionIdSchema,
      },
    },
  }));
}

type MaybePromise<T> = T | Promise<T>;
export type SessionRouterOptions = {
  currentId: string;
  list: () => MaybePromise<SessionInfo[]>;
  connectionFor: (id: string) => MaybePromise<SessionConnection | undefined>;
  localCall: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  create: (name?: string) => MaybePromise<SessionInfo>;
  open: (id: string) => MaybePromise<SessionInfo>;
  timeoutMs?: number;
};

/** Never publish bridge addresses, bearer tokens, profile paths or credentials. */
function publicSession(session: SessionInfo) {
  return {
    id: session.id,
    name: session.name,
    projectId: session.projectId,
    projectName: session.projectName,
    running: session.running,
    active: session.active,
    current: session.current,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function argumentsFor(raw: unknown) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw Error("Cutline tool arguments must be an object.");
  return raw as Record<string, unknown>;
}

export function createSessionRouter(options: SessionRouterOptions) {
  async function call(
    name: string,
    raw: unknown = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { sessionId, ...args } = argumentsFor(raw);
    if (
      sessionId !== undefined &&
      (typeof sessionId !== "string" || !sessionId)
    )
      throw Error("sessionId must be a nonempty ID from cutline_sessions.");

    if (name === "cutline_sessions") {
      if (Object.keys(args).some((key) => key !== "action" && key !== "name"))
        throw Error(
          "cutline_sessions accepts only action, name and sessionId.",
        );
      const action = args.action ?? "list";
      if (action === "list") {
        if (args.name !== undefined || sessionId !== undefined)
          throw Error(
            "Use cutline_sessions action list without name or sessionId.",
          );
        return { sessions: (await options.list()).map(publicSession) };
      }
      if (action === "create") {
        if (sessionId !== undefined)
          throw Error(
            "A new session receives its own ID; omit sessionId when creating it.",
          );
        if (
          args.name !== undefined &&
          (typeof args.name !== "string" ||
            !args.name.trim() ||
            args.name.length > 80)
        )
          throw Error("Session name must contain between 1 and 80 characters.");
        return {
          session: publicSession(
            await options.create(args.name as string | undefined),
          ),
        };
      }
      if (action === "open") {
        if (typeof sessionId !== "string")
          throw Error("Use sessionId from cutline_sessions to open a session.");
        if (args.name !== undefined)
          throw Error("Session names are set when a session is created.");
        return { session: publicSession(await options.open(sessionId)) };
      }
      throw Error("Session action must be list, create or open.");
    }

    const sessions = await options.list();
    const live = sessions.filter((session) => session.running);
    if (
      sessionId === undefined &&
      sessions.filter((session) => session.active || session.running).length > 1
    )
      throw Error(
        "Multiple Cutline sessions are open. Call cutline_sessions, choose the session for this chat, and include its sessionId on every tool call, including cutline_jobs.",
      );
    const target =
      sessionId === undefined
        ? live.find((session) => session.id === options.currentId)
        : live.find((session) => session.id === sessionId);
    if (!target)
      throw Error(
        sessionId === undefined
          ? `The configured Cutline session ${options.currentId} is unavailable. Call cutline_sessions to open it or explicitly choose another sessionId. The call was not sent to another session.`
          : `Cutline session ${sessionId} is not running or does not exist. Call cutline_sessions to list or open it. The call was not sent to another session.`,
      );
    if (target.id === options.currentId)
      return options.localCall(name, args, signal);

    const connection = await options.connectionFor(target.id);
    if (!connection)
      throw Error(
        `Cutline session ${target.id} is no longer running. The call was not sent to another session.`,
      );
    const address = new URL(connection.base);
    if (
      address.protocol !== "http:" ||
      address.hostname !== "127.0.0.1" ||
      address.username ||
      address.password
    )
      throw Error("Cutline session connections must point to this Mac.");
    let data: any;
    try {
      data = await postJson(
        `${connection.base}/rpc`,
        { name, args: { ...args, sessionId: target.id } },
        options.timeoutMs ?? 600_000,
      );
    } catch {
      throw Error(
        `Cutline session ${target.id} did not answer. Inspect that session and its jobs before retrying; the call was not sent to another session.`,
      );
    }
    if (data?.error) throw Error(String(data.error));
    return data?.result;
  }
  return { call };
}
