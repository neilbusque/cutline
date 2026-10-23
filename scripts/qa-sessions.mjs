import { assertCfrExport } from "./video-qa-timing.mjs";
import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  stat,
  readdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

// Real independent Electron processes, isolated data, and two external MCP
// clients sharing one launcher. No model accounts or paid providers are used.
//   node scripts/qa-sessions.mjs
//   CUTLINE_PACKAGED=1 CUTLINE_APP=/path/Cutline.app node scripts/qa-sessions.mjs
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const appRoot =
  process.env.CUTLINE_APP ??
  path.join(root, "release/Cutline-darwin-arm64/Cutline.app");
const executable = packaged
  ? path.join(appRoot, "Contents/MacOS/Cutline")
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const outputParent = path.resolve(
  process.env.CUTLINE_SESSIONS_RESULTS ?? path.join(root, "../qa-sessions"),
);
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, "run-"));
const data = path.join(work, "user-data");
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: data,
  CUTLINE_SESSION_ROOT: data,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CUTLINE_SESSION_ID;
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const rendererErrors = [];
const clients = [];
const childPids = new Set();
let app;
let page;
let failure;
let previousClipboard;
const log = (message, detail) => {
  results.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log(message, detail === undefined ? "" : JSON.stringify(detail));
};
const until = async (check, message, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(150);
  }
  throw Error(message);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const diagnoseSession = async (sessionId) => {
  const folder = path.join(data, "sessions", sessionId);
  const metadata = JSON.parse(
    await readFile(path.join(folder, "session.json"), "utf8"),
  );
  const connection = JSON.parse(
    await readFile(path.join(folder, "connection.json"), "utf8"),
  );
  const started = Date.now();
  let response;
  try {
    const value = await fetch(`${connection.base}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tools.list", args: {} }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await value.json();
    response = {
      status: value.status,
      tools: Array.isArray(body.result) ? body.result.length : undefined,
      error: body.error,
    };
  } catch (error) {
    response = { error: error.message };
  }
  return {
    metadataPid: metadata.pid,
    connectionPid: connection.pid,
    processExists: alive(connection.pid),
    elapsedMs: Date.now() - started,
    response,
  };
};
const stopChild = async (pid) => {
  if (!alive(pid)) return;
  process.kill(pid, "SIGTERM");
  await until(() => !alive(pid), "Child session failed to quit", 10000);
};
const invoke = (name, args) =>
  page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
    name,
    args,
  });
const decode = (response) => {
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const call = async (client, name, args = {}, expectedError) => {
  const response = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 180000,
  });
  const value = decode(response);
  if (expectedError) {
    assert(response.isError, `${name} should reject the request`);
    assert.match(String(value), expectedError);
  } else assert(!response.isError, `${name}: ${JSON.stringify(value)}`);
  return value;
};
const inspect = (client, sessionId) =>
  call(client, "cutline_inspect", { sessionId, detail: "full" });
const revision = (project, sessionId) => ({
  sessionId,
  projectId: project.id,
  revision: project.revision,
});
const stdio = async (name, launcher) => {
  const client = new Client({ name, version: "1.0" });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: launcher,
      args: [],
      env: { ...env, CUTLINE_CONNECTION: path.join(data, "connection.json") },
      stderr: "pipe",
    }),
  );
  return client;
};
const jobs = (client, sessionId, id) =>
  call(client, "cutline_jobs", { sessionId, ...(id ? { id } : {}) });
const waitJob = async (client, sessionId, id) => {
  const started = Date.now();
  return until(
    async () => {
      const job = (
        await call(client, "cutline_jobs", { sessionId, id, waitSeconds: 2 })
      )[0];
      if (job.state === "error" || job.state === "cancelled")
        throw Error(job.message);
      return job.state === "done"
        ? { ...job, elapsedSeconds: (Date.now() - started) / 1000 }
        : false;
    },
    "Session export timed out",
    180000,
  );
};
const binary = (executable, args) => {
  const result = spawnSync(executable, args, { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
};
const checkVideo = async (file, expectedColor) => {
  const info = JSON.parse(
    binary(ffprobe, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assertCfrExport(ffprobe, file, { fps: 30, frames: 90 });
  assert(Math.abs(Number(info.format.duration) - 3) < 0.1);
  const rgb = binary(ffmpeg, [
    "-v",
    "error",
    "-ss",
    "1",
    "-i",
    file,
    "-vf",
    "crop=2:2:2:2,scale=1:1",
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  assert.equal(rgb.length, 3);
  expectedColor.forEach((channel, index) =>
    assert(
      Math.abs(rgb[index] - channel) < 12,
      `Unexpected video color ${[...rgb]}`,
    ),
  );
  const thumbnail = file.replace(/\.mp4$/, ".png");
  binary(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-ss",
    "1",
    "-i",
    file,
    "-frames:v",
    "1",
    thumbnail,
  ]);
  return {
    width: video.width,
    height: video.height,
    duration: Number(info.format.duration),
    cornerColor: [...rgb],
  };
};

try {
  const bundle = await build({
    stdin: {
      contents: 'export {newProject,makeClip} from "./src/shared/model.ts";',
      resolveDir: root,
      sourcefile: "qa-session-fixture.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { makeClip } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  app = await electron.launch({
    executablePath: executable,
    args: packaged ? [] : [root],
    env,
  });
  page = await app.firstWindow({ timeout: 90000 });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.waitForSelector(".titlebar", { timeout: 60000 });
  previousClipboard = await app.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  const settings = (await invoke("state")).settings;
  const clientA = await stdio(
    "cutline-session-chat-a-qa",
    settings.mcpLauncher,
  );
  const clientB = await stdio(
    "cutline-session-chat-b-qa",
    settings.mcpLauncher,
  );
  const listedTools = (await clientA.listTools()).tools;
  assert(listedTools.some((tool) => tool.name === "cutline_sessions"));
  for (const tool of listedTools.filter(
    (tool) => tool.name !== "cutline_sessions",
  ))
    assert(
      tool.inputSchema.properties.sessionId,
      `${tool.name} must accept a session ID`,
    );
  const initial = await invoke("sessions.list");
  assert.equal(initial.currentId, "main");
  assert.equal(initial.sessions.length, 1);
  const sessionA = initial.currentId;

  const trigger = page.getByRole("button", { name: /^Sessions:/ });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Sessions", exact: true });
  await panel
    .getByRole("button", { name: "Copy Codex prompt", exact: true })
    .click();
  await panel.getByRole("status").waitFor();
  const prompt = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert(prompt.includes('sessionId: "main"'));
  assert(prompt.includes("every Cutline tool call"));
  const close = panel.getByRole("button", {
    name: "Close sessions",
    exact: true,
  });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Copied session prompt",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Close sessions",
  );
  await page.keyboard.press("Escape");
  assert.equal(await panel.count(), 0);
  assert(await trigger.evaluate((button) => button === document.activeElement));
  await trigger.click();
  await panel.getByLabel("New session", { exact: true }).fill("QA Video B");
  await panel.getByRole("button", { name: "New session", exact: true }).click();
  await panel.waitFor({ state: "hidden", timeout: 35000 });
  let two = await invoke("sessions.list");
  assert.equal(two.sessions.length, 2);
  let child = two.sessions.find((session) => session.id !== sessionA);
  if (!child.running) {
    log(
      "Creation diagnostic: newly created session probe unavailable",
      await diagnoseSession(child.id),
    );
    child = await until(
      async () => {
        const found = (await invoke("sessions.list")).sessions.find(
          (session) => session.id === child.id,
        );
        return found.running ? found : false;
      },
      "New child session stayed unreachable",
      10000,
    );
  }
  assert(
    child.running && child.pid,
    "Created child session must be a separate live process",
  );
  childPids.add(child.pid);
  assert.notEqual(child.pid, app.process().pid);
  assert.equal(child.name, "QA Video B");
  const sessionB = child.id;
  const connectionFileB = path.join(
    data,
    "sessions",
    sessionB,
    "connection.json",
  );
  assert.equal((await stat(connectionFileB)).mode & 0o777, 0o600);
  await call(clientA, "cutline_inspect", {}, /Multiple Cutline sessions/);
  assert.equal((await invoke("connection.test")).ready, true);
  log(
    "Session UI creates an independent process; prompt copy, focus trap, Escape, and explicit routing work",
    { sessions: 2 },
  );

  await trigger.click();
  await panel
    .getByRole("button", { name: "Show QA Video B", exact: true })
    .waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }),
  );
  await page.screenshot({
    path: path.join(work, "sessions-minimum-window.png"),
  });
  const layout = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      right: bounds.right,
      bottom: bounds.bottom,
      width: innerWidth,
      height: innerHeight,
      overflow: element.scrollWidth > element.clientWidth,
    };
  });
  assert(
    layout.right <= layout.width &&
      layout.bottom <= layout.height &&
      !layout.overflow,
  );
  await panel
    .getByRole("button", { name: "Show QA Video B", exact: true })
    .click();
  const whileFocusing = (await invoke("sessions.list")).sessions.find(
    (session) => session.id === sessionB,
  );
  if (!whileFocusing.running) {
    log(
      "Focus diagnostic: session probe was unavailable while focus was pending",
      {
        expectedPid: child.pid,
        ...(await diagnoseSession(sessionB)),
      },
    );
  }
  await panel.waitFor({ state: "hidden", timeout: 35000 });
  assert.equal(
    (await invoke("sessions.list")).sessions.find(
      (session) => session.id === sessionB,
    ).pid,
    child.pid,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }),
  );

  const [initialA, initialB] = await Promise.all([
    inspect(clientA, sessionA),
    inspect(clientB, sessionB),
  ]);
  assert.notEqual(initialA.id, initialB.id);
  assert.equal(initialA.clips.length, 0);
  assert.equal(initialB.clips.length, 0);
  const seed = async (client, sessionId, project, name, color) => {
    const canvas = { ...project, width: 640, height: 360, fps: 30 };
    const clip = {
      ...makeClip(canvas, "text", "titles", 0),
      text: name,
      duration: 90,
      fontSize: 44,
      color: "#ffffff",
      preset: "none",
    };
    await call(client, "cutline_apply_edits", {
      ...revision(project, sessionId),
      label: `Make ${name}`,
      commands: [
        {
          type: "project.update",
          patch: { name, width: 640, height: 360, fps: 30, background: color },
        },
        { type: "clip.add", clip },
      ],
    });
    return inspect(client, sessionId);
  };
  let [projectA, projectB] = await Promise.all([
    seed(clientA, sessionA, initialA, "SESSION A · CORAL", "#b04050"),
    seed(clientB, sessionB, initialB, "SESSION B · BLUE", "#205090"),
  ]);
  assert.equal(projectA.clips.length, 1);
  assert.equal(projectB.clips.length, 1);
  assert.notEqual(projectA.clips[0].id, projectB.clips[0].id);
  await call(
    clientA,
    "cutline_apply_edits",
    {
      ...revision(projectA, sessionB),
      label: "Wrong chat",
      commands: [{ type: "project.update", patch: { name: "MUST NOT LAND" } }],
    },
    /project|revision/i,
  );
  assert.deepEqual(await inspect(clientA, sessionA), projectA);
  assert.deepEqual(await inspect(clientB, sessionB), projectB);
  const fileA = path.join(work, "Session A.cutline");
  const fileB = path.join(work, "Session B.cutline");
  await Promise.all([
    call(clientA, "cutline_save_project", {
      ...revision(projectA, sessionA),
      path: fileA,
    }),
    call(clientB, "cutline_save_project", {
      ...revision(projectB, sessionB),
      path: fileB,
    }),
  ]);
  await call(
    clientB,
    "cutline_open_project",
    { ...revision(projectB, sessionB), path: fileA },
    /another Cutline session|already in use/i,
  );
  assert.deepEqual(await inspect(clientB, sessionB), projectB);
  log(
    "Two MCP clients make and save different videos concurrently; wrong project IDs and shared-file opens cannot overwrite them",
  );

  const connectionB = JSON.parse(await readFile(connectionFileB, "utf8"));
  const httpB = new Client({ name: "cutline-child-http-qa", version: "1.0" });
  clients.push(httpB);
  await httpB.connect(
    new StreamableHTTPClientTransport(new URL(connectionB.mcpUrl)),
  );
  assert.equal((await inspect(httpB, sessionB)).id, projectB.id);
  const childPreview = await httpB.callTool(
    {
      name: "cutline_preview",
      arguments: {
        ...revision(projectB, sessionB),
        frame: 30,
        playing: false,
        image: true,
      },
    },
    undefined,
    { timeout: 180000 },
  );
  assert(!childPreview.isError, JSON.stringify(decode(childPreview)));
  const childImage = childPreview.content.find((item) => item.type === "image");
  assert(childImage, "Child session preview must return a real rendered image");
  await writeFile(
    path.join(work, "child-session-preview.jpg"),
    Buffer.from(childImage.data, "base64"),
  );
  log(
    "Child session's authenticated HTTP MCP and rendered preview work independently",
  );

  const outputA = path.join(work, "Session A.mp4");
  const outputB = path.join(work, "Session B.mp4");
  const started = Date.now();
  const [exportA, exportB] = await Promise.all([
    call(clientA, "cutline_export", {
      ...revision(projectA, sessionA),
      path: outputA,
    }),
    call(clientB, "cutline_export", {
      ...revision(projectB, sessionB),
      path: outputB,
    }),
  ]);
  const simultaneous = await Promise.all([
    jobs(clientA, sessionA, exportA.id),
    jobs(clientB, sessionB, exportB.id),
  ]);
  assert(
    simultaneous.every((list) => list[0].state === "running"),
    "Both independent exports should be active together",
  );
  await call(
    clientA,
    "cutline_jobs",
    { sessionId: sessionA, id: exportB.id },
    /missing/,
  );
  await call(
    clientB,
    "cutline_cancel_job",
    { sessionId: sessionB, id: exportA.id },
    /missing/,
  );
  await Promise.all([
    waitJob(clientA, sessionA, exportA.id),
    waitJob(clientB, sessionB, exportB.id),
  ]);
  const checked = await Promise.all([
    checkVideo(outputA, [176, 64, 80]),
    checkVideo(outputB, [32, 80, 144]),
  ]);
  assert.deepEqual(
    (await jobs(clientA, sessionA)).map((job) => job.id),
    [exportA.id],
  );
  assert.deepEqual(
    (await jobs(clientB, sessionB)).map((job) => job.id),
    [exportB.id],
  );
  log(
    "Two MP4 exports run simultaneously, remain separate, and decode to the correct 640×360, 30 fps, three-second videos",
    { elapsedSeconds: (Date.now() - started) / 1000, videos: checked },
  );

  // Completed job notification can precede render-worker exit by a moment.
  await sleep(700);
  const cancelledPath = path.join(work, "Cancelled A.mp4");
  const cancelledExport = await call(clientA, "cutline_export", {
    ...revision(projectA, sessionA),
    path: cancelledPath,
  });
  await call(
    clientB,
    "cutline_export",
    { ...revision(projectB, sessionB), path: cancelledPath },
    /another Cutline session|already in use/i,
  );
  const keptPath = path.join(work, "Unaffected B.mp4");
  const keptExport = await call(clientB, "cutline_export", {
    ...revision(projectB, sessionB),
    path: keptPath,
  });
  const cancelled = await call(clientA, "cutline_cancel_job", {
    sessionId: sessionA,
    id: cancelledExport.id,
  });
  assert.equal(cancelled.state, "cancelled");
  await waitJob(clientB, sessionB, keptExport.id);
  assert.equal(
    (await jobs(clientA, sessionA, cancelledExport.id))[0].state,
    "cancelled",
  );
  assert(
    !existsSync(cancelledPath),
    "Cancelled export must not publish an MP4",
  );
  await checkVideo(keptPath, [32, 80, 144]);
  log(
    "Same output path is protected; cancelling one session's export leaves the other export working",
  );

  if (process.env.CUTLINE_SESSIONS_QUEUE === "1") {
    await sleep(700);
    const created = await call(clientA, "cutline_sessions", {
      action: "create",
      name: "QA queued video",
    });
    const sessionC = created.session.id;
    const childC = await until(async () => {
      const value = (await invoke("sessions.list")).sessions.find(
        (session) => session.id === sessionC,
      );
      return value?.running ? value : false;
    }, "Third session did not become reachable");
    childPids.add(childC.pid);
    const clientC = await stdio(
      "cutline-session-chat-c-qa",
      settings.mcpLauncher,
    );
    const projectC = await seed(
      clientC,
      sessionC,
      await inspect(clientC, sessionC),
      "SESSION C · GREEN",
      "#308060",
    );
    // More frames keep the two active renders alive while the queue is inspected.
    const queueTargets = [
      { client: clientA, sessionId: sessionA, project: projectA },
      { client: clientB, sessionId: sessionB, project: projectB },
      { client: clientC, sessionId: sessionC, project: projectC },
    ];
    await Promise.all(
      queueTargets.map(async (target) => {
        await call(target.client, "cutline_apply_edits", {
          ...revision(target.project, target.sessionId),
          label: "Lengthen queue fixture",
          commands: [
            {
              type: "clip.update",
              id: target.project.clips[0].id,
              patch: { duration: 450 },
            },
          ],
        });
        target.project = await inspect(target.client, target.sessionId);
        target.path = path.join(work, `Queue ${target.sessionId}.mp4`);
      }),
    );
    await Promise.all(
      queueTargets.map(async (target) => {
        target.job = await call(target.client, "cutline_export", {
          ...revision(target.project, target.sessionId),
          path: target.path,
        });
      }),
    );
    const queueState = await until(
      async () => {
        const entries = await Promise.all(
          queueTargets.map(async (target) => ({
            target,
            job: (
              await jobs(target.client, target.sessionId, target.job.id)
            )[0],
          })),
        );
        const queued = entries.filter(
          ({ job }) =>
            job.state === "running" &&
            job.message === "Waiting for an export slot",
        );
        const rendering = entries.filter(
          ({ job }) =>
            job.state === "running" &&
            job.message !== "Waiting for an export slot",
        );
        return queued.length === 1 && rendering.length === 2
          ? { queued: queued[0], rendering }
          : false;
      },
      "Three exports did not produce two active renders and one queued job",
      10000,
    );
    const leaseOwners = await Promise.all(
      [0, 1].map(async (slot) => {
        const key = createHash("sha256").update(`export:${slot}`).digest("hex");
        return JSON.parse(
          await readFile(path.join(data, "leases", key, "owner.json"), "utf8"),
        );
      }),
    );
    assert(leaseOwners.every((owner) => alive(owner.pid)));
    assert.equal(new Set(leaseOwners.map((owner) => owner.pid)).size, 2);
    await trigger.click();
    await page.screenshot({
      path: path.join(work, "sessions-three-queued.png"),
    });
    await page.keyboard.press("Escape");
    const waiting = queueState.queued.target;
    assert.equal(
      (
        await call(waiting.client, "cutline_cancel_job", {
          sessionId: waiting.sessionId,
          id: waiting.job.id,
        })
      ).state,
      "cancelled",
    );
    await Promise.all(
      queueState.rendering.map(({ target }) =>
        waitJob(target.client, target.sessionId, target.job.id),
      ),
    );
    assert(!existsSync(waiting.path));
    assert.equal(
      (await jobs(waiting.client, waiting.sessionId, waiting.job.id))[0].state,
      "cancelled",
    );
    for (const { target } of queueState.rendering) {
      const info = JSON.parse(
        binary(ffprobe, [
          "-v",
          "error",
          "-show_format",
          "-of",
          "json",
          target.path,
        ]),
      );
      assert(Math.abs(Number(info.format.duration) - 15) < 0.1);
    }
    await Promise.all(
      queueTargets.map(async (target) =>
        call(
          target.client,
          "cutline_undo",
          revision(
            await inspect(target.client, target.sessionId),
            target.sessionId,
          ),
        ),
      ),
    );
    projectA = await inspect(clientA, sessionA);
    projectB = await inspect(clientB, sessionB);
    log(
      "Three real sessions enforce two render slots; cancelling the queued third job leaves both active 15-second exports intact",
      { activeSlots: 2, queuedSession: waiting.sessionId },
    );
    await stopChild(childC.pid);
  }

  await call(clientB, "cutline_apply_edits", {
    ...revision(projectB, sessionB),
    label: "Rename before reopening",
    commands: [
      {
        type: "project.update",
        patch: { name: "Session B survives reopening" },
      },
    ],
  });
  projectB = await inspect(clientB, sessionB);
  const historyFolder = path.join(data, "sessions", sessionB, "history");
  await until(async () => {
    for (const file of await readdir(historyFolder)) {
      try {
        const history = JSON.parse(
          await readFile(path.join(historyFolder, file), "utf8"),
        );
        if (
          history.projectId === projectB.id &&
          history.revision === projectB.revision
        )
          return true;
      } catch {
        /* A background write may still be finishing. */
      }
    }
    return false;
  }, "Child undo history did not persist");
  await httpB.close();
  await stopChild(child.pid);
  await call(
    clientA,
    "cutline_inspect",
    { sessionId: sessionB },
    /not running|no longer|not exist/,
  );
  const closed = (await invoke("sessions.list")).sessions.find(
    (session) => session.id === sessionB,
  );
  assert.equal(closed.running, false);
  await trigger.click();
  await panel
    .getByRole("button", { name: "Reopen QA Video B", exact: true })
    .click();
  await panel.waitFor({ state: "hidden", timeout: 35000 });
  const reopened = (await invoke("sessions.list")).sessions.find(
    (session) => session.id === sessionB,
  );
  assert(reopened.running && reopened.pid !== child.pid);
  childPids.add(reopened.pid);
  const restored = await inspect(clientB, sessionB);
  assert.equal(restored.id, projectB.id);
  assert.equal(restored.name, "Session B survives reopening");
  assert.deepEqual(restored.clips, projectB.clips);
  await call(clientB, "cutline_undo", revision(restored, sessionB));
  assert.equal((await inspect(clientB, sessionB)).name, "SESSION B · BLUE");
  assert.deepEqual(await inspect(clientA, sessionA), projectA);
  log(
    "A closed child reopens with the same session/project, saved edits, and working undo history",
  );

  await trigger.click();
  await page.screenshot({ path: path.join(work, "sessions-two-videos.png") });
  await page.keyboard.press("Escape");
  await app.evaluate(
    ({ clipboard }, value) => clipboard.writeText(value),
    previousClipboard,
  );
  previousClipboard = undefined;
  await app.close();
  app = undefined;
  assert.equal((await inspect(clientB, sessionB)).id, projectB.id);
  const afterClose = await call(clientB, "cutline_sessions", {
    action: "list",
  });
  assert.equal(
    afterClose.sessions.find((session) => session.id === sessionA).running,
    false,
  );
  assert.equal(
    afterClose.sessions.find((session) => session.id === sessionB).running,
    true,
  );
  log(
    "Closing the main window's process leaves another session and existing external MCP clients usable",
  );
  assert.deepEqual(rendererErrors, []);
  log("No renderer exceptions");
} catch (error) {
  failure = error;
  console.error(error.stack ?? String(error));
  if (page && app)
    await page
      .screenshot({ path: path.join(work, "failure.png") })
      .catch(() => {});
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (app) {
    if (previousClipboard !== undefined)
      await app
        .evaluate(
          ({ clipboard }, value) => clipboard.writeText(value),
          previousClipboard,
        )
        .catch(() => {});
    await app.close().catch(() => {});
  }
  // Also discover a child whose UI creation succeeded just before a failing
  // assertion. Only metadata inside this run's unique disposable root is read.
  for (const id of await readdir(path.join(data, "sessions")).catch(() => [])) {
    try {
      const metadata = JSON.parse(
        await readFile(path.join(data, "sessions", id, "session.json"), "utf8"),
      );
      if (Number.isSafeInteger(metadata.pid) && metadata.pid > 0)
        childPids.add(metadata.pid);
    } catch {
      /* No live child metadata. */
    }
  }
  for (const pid of childPids) await stopChild(pid).catch(() => {});
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(
      { passed: !failure, results, rendererErrors, failure: failure?.stack },
      null,
      2,
    ),
  );
  console.log(`Session QA evidence: ${work}`);
}
if (failure) process.exitCode = 1;
