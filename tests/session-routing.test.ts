import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionRouter, sessionTools } from "../src/main/session-routing";
import { createLauncher } from "../src/main/mcp-launcher";
import { createMcpServer } from "../src/main/mcp-server";
import { startBridge } from "../src/main/bridge";
import { cutlineTools } from "../src/main/agent-tools";
import { Store } from "../src/main/store";
import { AgentTasks } from "../src/main/agent-tasks";
import type { SessionConnection, SessionInfo } from "../src/main/sessions";
import type { Job } from "../src/shared/model";
import { version } from "../package.json";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function fixture() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "cutline-session-routing-"),
  );
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ids = ["main", randomUUID(), randomUUID()];
  const sessions: SessionInfo[] = ids.map((id, index) => ({
    id,
    name: `Video ${index + 1}`,
    projectId: `project-${id}`,
    projectName: `Film ${index + 1}`,
    running: true,
    current: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const connections = new Map<string, SessionConnection>();
  const states = ids.map((id) => ({
    id,
    revision: 0,
    title: `Project ${id}`,
    jobs: new Map<string, Job>([
      [
        `job-${id}`,
        {
          id: `job-${id}`,
          kind: "export",
          state: "running",
          progress: 0,
          message: "Rendering",
        },
      ],
    ]),
    calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  }));
  const tasks = states.map((state) => new AgentTasks(state));
  const create = vi.fn(async (name?: string) => ({
    ...sessions[1],
    name: name ?? "New session",
  }));
  const open = vi.fn(async (id: string) => {
    const session = sessions.find((entry) => entry.id === id);
    if (!session) throw Error("Unknown session");
    return session;
  });
  const routers = ids.map((id, index) =>
    createSessionRouter({
      currentId: id,
      list: () =>
        sessions.map((session) => ({ ...session, current: session.id === id })),
      connectionFor: (target) => connections.get(target),
      create,
      open,
      localCall: async (name, args) => {
        const state = states[index];
        state.calls.push({ name, args });
        // The editing schemas are strict; routing metadata must be stripped.
        if ("sessionId" in args)
          throw Error("Unexpected sessionId in local arguments");
        if (name === "cutline_jobs") return tasks[index].list(args);
        if (name === "cutline_cancel_job") {
          const job = state.jobs.get(String(args.id));
          if (!job) throw Error("Job is missing");
          job.state = "cancelled";
          return { ...job };
        }
        if (name === "cutline_edit") {
          if (
            args.projectId !== `project-${id}` ||
            args.revision !== state.revision
          )
            throw Error("Project or revision conflict");
          state.title = String(args.title);
          state.revision++;
        }
        return {
          projectId: `project-${id}`,
          revision: state.revision,
          title: state.title,
        };
      },
      timeoutMs: 500,
    }),
  );
  const bridges = [];
  for (const [index, id] of ids.entries()) {
    const data =
      id === "main" ? directory : path.join(directory, "sessions", id);
    mkdirSync(data, { recursive: true });
    const bridge = await startBridge(
      new Store(path.join(data, "recovery.cutline")),
      path.join(data, "connection.json"),
      routers[index].call,
      sessionTools(cutlineTools),
    );
    connections.set(id, { base: bridge.base, pid: process.pid });
    bridges.push(bridge);
    cleanup.push(bridge.close);
  }
  return {
    directory,
    ids,
    sessions,
    connections,
    states,
    routers,
    bridges,
    create,
    open,
  };
}

async function clientFor(
  call: (name: string, args: unknown) => Promise<unknown>,
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(async () => sessionTools(cutlineTools), call).connect(
    serverSide,
  );
  const client = new Client({ name: "independent-chat", version: "1.0" });
  await client.connect(clientSide);
  cleanup.push(() => client.close());
  return client;
}

describe("explicit session routing", () => {
  it("keeps the built-in Claude MCP endpoint local while external calls require a session", async () => {
    const { directory, ids, routers } = await fixture();
    for (const id of ids) {
      const data =
        id === "main" ? directory : path.join(directory, "sessions", id);
      const connection = JSON.parse(
        readFileSync(path.join(data, "connection.json"), "utf8"),
      );
      expect(connection.version).toBe(version);
    }
    const localCall = vi.fn(async () => ({ projectId: "built-in-window" }));
    const bridge = await startBridge(
      new Store(path.join(directory, "built-in.cutline")),
      null,
      routers[0].call,
      sessionTools(cutlineTools),
      { localCall, localTools: cutlineTools },
    );
    cleanup.push(bridge.close);
    const local = new Client({ name: "built-in-claude", version: "1.0" });
    await local.connect(
      new StreamableHTTPClientTransport(new URL(`${bridge.mcpUrl}/local`)),
    );
    cleanup.push(() => local.close());
    const external = new Client({ name: "external-chat", version: "1.0" });
    await external.connect(
      new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)),
    );
    cleanup.push(() => external.close());
    for (const client of [local, external]) {
      expect(client.getServerVersion()).toEqual({ name: "cutline", version });
    }
    const localResult = await local.callTool({
      name: "cutline_inspect",
      arguments: {},
    });
    expect(localResult.isError).not.toBe(true);
    expect(localCall).toHaveBeenCalledWith("cutline_inspect", {});
    expect(
      (await local.listTools()).tools.every(
        (tool) => !tool.inputSchema.properties?.sessionId,
      ),
    ).toBe(true);
    const externalResult = await external.callTool({
      name: "cutline_inspect",
      arguments: {},
    });
    expect(externalResult.isError).toBe(true);
    expect(localCall).toHaveBeenCalledTimes(1);
  });

  it("two independent MCP clients can interleave edits without sharing selection or project state", async () => {
    const { ids, states, routers } = await fixture();
    const a = await clientFor(routers[0].call);
    const b = await clientFor(routers[0].call);
    const responses = await Promise.all([
      a.callTool({
        name: "cutline_edit",
        arguments: {
          sessionId: ids[0],
          projectId: `project-${ids[0]}`,
          revision: 0,
          title: "Film A",
        },
      }),
      b.callTool({
        name: "cutline_edit",
        arguments: {
          sessionId: ids[1],
          projectId: `project-${ids[1]}`,
          revision: 0,
          title: "Film B",
        },
      }),
    ]);
    expect(responses.every((response) => !response.isError)).toBe(true);
    await b.callTool({
      name: "cutline_inspect",
      arguments: { sessionId: ids[1] },
    });
    await a.callTool({
      name: "cutline_edit",
      arguments: {
        sessionId: ids[0],
        projectId: `project-${ids[0]}`,
        revision: 1,
        title: "Film A revised",
      },
    });
    expect(states.map(({ title, revision }) => ({ title, revision }))).toEqual([
      { title: "Film A revised", revision: 2 },
      { title: "Film B", revision: 1 },
      { title: `Project ${ids[2]}`, revision: 0 },
    ]);
    expect(
      states
        .flatMap((state) => state.calls)
        .every(({ args }) => !("sessionId" in args)),
    ).toBe(true);
  });

  it("refuses untargeted reads, jobs and edits when multiple sessions are live, but supports a singleton", async () => {
    const { routers, states, sessions } = await fixture();
    for (const name of [
      "cutline_inspect",
      "cutline_jobs",
      "cutline_edit",
      "cutline_connection_status",
    ])
      await expect(routers[0].call(name)).rejects.toThrow(
        /Multiple Cutline sessions/,
      );
    expect(states.every((state) => state.calls.length === 0)).toBe(true);
    sessions[1].running = sessions[2].running = false;
    expect(await routers[0].call("cutline_inspect")).toMatchObject({
      projectId: "project-main",
    });
  });

  it("closed and unknown targets never fall back to another project", async () => {
    const { routers, ids, sessions, states, bridges } = await fixture();
    sessions[1].running = false;
    await expect(
      routers[0].call("cutline_edit", { sessionId: ids[1] }),
    ).rejects.toThrow(/not running/);
    await expect(
      routers[0].call("cutline_edit", { sessionId: "unknown" }),
    ).rejects.toThrow(/does not exist/);
    bridges[2].close();
    await expect(
      routers[0].call("cutline_edit", { sessionId: ids[2] }),
    ).rejects.toThrow(/did not answer/);
    expect(states.every((state) => state.calls.length === 0)).toBe(true);
  });

  it("a busy live process still requires explicit targeting even when its bridge probe timed out", async () => {
    const { routers, ids, sessions } = await fixture();
    sessions[1].running = sessions[2].running = false;
    sessions[1].active = true;
    await expect(routers[0].call("cutline_inspect")).rejects.toThrow(
      /Multiple Cutline sessions/,
    );
    expect(
      await routers[0].call("cutline_inspect", { sessionId: ids[0] }),
    ).toMatchObject({ projectId: "project-main" });
  });

  it("jobs and cancellation remain scoped even with a valid job ID from a different session", async () => {
    const { routers, ids, states } = await fixture();
    await expect(
      routers[0].call("cutline_jobs", {
        sessionId: ids[1],
        id: `job-${ids[0]}`,
      }),
    ).rejects.toThrow(/missing/);
    await expect(
      routers[0].call("cutline_cancel_job", {
        sessionId: ids[1],
        id: `job-${ids[0]}`,
      }),
    ).rejects.toThrow(/missing/);
    expect(
      await routers[0].call("cutline_jobs", { sessionId: ids[1] }),
    ).toEqual([
      expect.objectContaining({ id: `job-${ids[1]}`, state: "running" }),
    ]);
    await routers[0].call("cutline_cancel_job", {
      sessionId: ids[1],
      id: `job-${ids[1]}`,
    });
    expect(states[0].jobs.get(`job-${ids[0]}`)?.state).toBe("running");
    expect(states[1].jobs.get(`job-${ids[1]}`)?.state).toBe("cancelled");
  });

  it("lists, creates and opens sessions without leaking connection details or choosing a global target", async () => {
    const { routers, ids, sessions, create, open } = await fixture();
    Object.assign(sessions[0], {
      base: "secret bearer address",
      token: "secret token",
      dataDir: "/private/profile",
    });
    const result = await routers[0].call("cutline_sessions");
    expect(result).toMatchObject({
      sessions: [{ id: ids[0] }, { id: ids[1] }, { id: ids[2] }],
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private/);
    await routers[0].call("cutline_sessions", {
      action: "create",
      name: "Launch film",
    });
    expect(create).toHaveBeenCalledWith("Launch film");
    await routers[0].call("cutline_sessions", {
      action: "open",
      sessionId: ids[1],
    });
    expect(open).toHaveBeenCalledWith(ids[1]);
    await expect(routers[0].call("cutline_inspect")).rejects.toThrow(
      /Multiple/,
    );
  });

  it("decorates every external tool without changing the built-in tools", () => {
    const original = structuredClone(cutlineTools);
    const tools = sessionTools(cutlineTools);
    expect(tools[0].name).toBe("cutline_sessions");
    expect(tools.every((tool) => tool.inputSchema.properties?.sessionId)).toBe(
      true,
    );
    expect(
      cutlineTools.every((tool) => !tool.inputSchema.properties?.sessionId),
    ).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual([
      "cutline_sessions",
      ...cutlineTools.map((tool) => tool.name),
    ]);
    expect(sessionTools(tools)).toEqual(tools);
    expect(cutlineTools).toEqual(original);
    // Measure the public tools/list response, including the session wrapper.
    // The raw built-in definitions alone miss the external client's overhead.
    expect(JSON.stringify({ tools }).length).toBeLessThan(50_000);
    for (const [index, tool] of cutlineTools.entries()) {
      const { sessionId, ...properties } =
        tools[index + 1].inputSchema.properties!;
      expect(sessionId).toEqual({ type: "string" });
      expect({ ...tools[index + 1].inputSchema, properties }).toEqual(
        tool.inputSchema,
      );
    }
  });
});

describe("launcher session discovery", () => {
  it("reaches explicitly targeted sibling sessions after the original app closes", async () => {
    const { directory, bridges, ids, sessions } = await fixture();
    const open = vi.fn(async () => true);
    const launcher = createLauncher({
      connection: path.join(directory, "connection.json"),
      tools: () => sessionTools(cutlineTools),
      open,
    });
    bridges[0].close();
    sessions[0].running = false;
    expect(
      await launcher.rpc("cutline_inspect", { sessionId: ids[1] }),
    ).toMatchObject({ projectId: `project-${ids[1]}` });
    expect(await launcher.listTools()).toEqual(sessionTools(cutlineTools));
    await expect(launcher.rpc("cutline_inspect")).rejects.toThrow(
      /configured Cutline session main is closed/,
    );
    expect(open).not.toHaveBeenCalled();
    await expect(
      launcher.rpc("cutline_inspect", { sessionId: "main" }),
    ).rejects.toThrow(/not running/);
    expect(open).not.toHaveBeenCalled();
  });

  it("never redirects an untargeted chat to the sole surviving session after its configured session closes", async () => {
    const { directory, bridges, ids, sessions, states, routers } =
      await fixture();
    const open = vi.fn(async () => true);
    const launcher = createLauncher({
      connection: path.join(directory, "connection.json"),
      tools: () => sessionTools(cutlineTools),
      open,
    });
    bridges[0].close();
    bridges[2].close();
    sessions[0].running = sessions[2].running = false;
    await expect(launcher.rpc("cutline_inspect")).rejects.toThrow(
      /configured Cutline session main is closed/,
    );
    await expect(routers[0].call("cutline_inspect")).rejects.toThrow(
      /configured Cutline session main is unavailable/,
    );
    expect(states[1].calls).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
    expect(await launcher.rpc("cutline_sessions")).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: ids[1], running: true }),
      ]),
    });
    expect(
      await launcher.rpc("cutline_inspect", { sessionId: ids[1] }),
    ).toMatchObject({ projectId: `project-${ids[1]}` });
  });

  it("an explicit stale target never autostarts or falls back, while management open reaches a live manager", async () => {
    const {
      directory,
      bridges,
      ids,
      sessions,
      open: managerOpen,
      states,
    } = await fixture();
    const open = vi.fn(async () => true);
    const launcher = createLauncher({
      connection: path.join(directory, "connection.json"),
      tools: () => sessionTools(cutlineTools),
      open,
    });
    bridges[1].close();
    sessions[1].running = false;
    await expect(
      launcher.rpc("cutline_edit", { sessionId: ids[1] }),
    ).rejects.toThrow(/not running/);
    expect(open).not.toHaveBeenCalled();
    expect(states.every((state) => state.calls.length === 0)).toBe(true);
    await launcher.rpc("cutline_sessions", {
      action: "open",
      sessionId: ids[1],
    });
    expect(managerOpen).toHaveBeenCalledWith(ids[1]);
  });

  it("discovers the shared root from a child connection and refuses nonlocal or invalid session targets", async () => {
    const { directory, ids } = await fixture();
    const launcher = createLauncher({
      connection: path.join(directory, "sessions", ids[1], "connection.json"),
      tools: () => sessionTools(cutlineTools),
    });
    expect(
      await launcher.rpc("cutline_inspect", { sessionId: ids[2] }),
    ).toMatchObject({ projectId: `project-${ids[2]}` });
    await expect(
      launcher.rpc("cutline_inspect", { sessionId: "../escape" }),
    ).rejects.toThrow(/Invalid Cutline session/);
    writeFileSync(
      path.join(directory, "sessions", ids[2], "connection.json"),
      JSON.stringify({ base: "https://example.com/token", pid: process.pid }),
    );
    await expect(
      launcher.rpc("cutline_inspect", { sessionId: ids[2] }),
    ).rejects.toThrow();
  });
});
