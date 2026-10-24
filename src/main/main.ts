import { browserRelativePath } from "../../scripts/browser-config.mjs";
import { ReelOptionsSchema } from "../shared/reel";
import { buildAutoReel, AutoReelOptionsSchema } from "./auto-reel";
import { Speech } from "./tts";
import { StockCredentials } from "./stock-credentials";
import { GenerationCredentials } from "./generation-credentials";
import {
  GenerationLibrary,
  higgsfieldCall,
  ProviderError,
} from "./generation";
import { StoryControl } from "./story-control";
import { StoryProduction } from "./story-production";
import { StoryBatchProduction } from "./story-batch";
import {
  createExplainerStory,
  ExplainerInputSchema,
} from "../shared/explainer";
import { effectsGuide } from "../shared/animation";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  Menu,
  nativeTheme,
  nativeImage,
  safeStorage,
  clipboard,
} from "electron";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveSessionContext, SessionManager } from "./sessions";
import { createSessionRouter, sessionTools } from "./session-routing";
import { SessionLeases } from "./session-leases";
import { postJson } from "./mcp-launcher";
import { CUTLINE_VERSION } from "../shared/version";
import { z } from "zod";
import { Store } from "./store";
import { ProjectLibrary } from "./projects";
import { Media, Jobs, type PreviewReady } from "./media";
import { startBridge } from "./bridge";
import {
  buildReel,
  generateCaptions,
  removeLongPauses,
  type EditJobDeps,
} from "./edit-jobs";
import { relinkMedia } from "./relink";
import { contentSecurityPolicy } from "./csp";
import { confirmReplace, type UnsavedChoice } from "./project-guard";
import { agentIoTools, createAgentIO } from "./agent-io";
import { musicTools, createMusicControl } from "./music-control";
import {
  writeAgentLauncher,
  testAgentConnection,
  installClaudeConnection,
  installCodexConnection,
  installClaudeCodeConnection,
} from "./agent-connection";
import {
  agentEditTools,
  applyAgentEdit,
  agentEditingSchema,
} from "../shared/agent-edit";
import { effectsGuideResult } from "../shared/agent-guide";
import { directorStyles, getDirectorGuide } from "../shared/director-guide";
import { analyzeVideoQuality } from "../shared/video-quality";
import {
  changeSummary,
  conflictMessage,
  inspectProject,
  performAgentEdit,
  readableError,
} from "../shared/agent-inspect";
import { readTranscript, searchTranscript } from "../shared/transcript";
import { cutlineTools, longRunningTools } from "./agent-tools";
import { agentMediaTools, createAgentMedia } from "./agent-media";
import {
  assistantAsker,
  fitSvg,
  References,
  renderSvg,
} from "./vector-studio";
import { capturePage } from "./page-capture";
import { withoutBackdrop } from "../shared/vector-generation";
import {
  generateGraphic,
  GraphicGenerateSchema,
  type GraphicGenerateInput,
  type GraphicResult,
} from "../shared/graphics";
import { HiggsfieldPictures } from "./higgsfield-pictures";
import { AgentTasks } from "./agent-tasks";
import {
  previewContent,
  previewFrames,
  renderPreview,
  renderStills,
  samplesFrames,
  timecode,
} from "./agent-preview";
import { StockLibrary, stockUrl } from "./stock";
import { Codex } from "./codex";
import { ClaudeAssistant, findClaude, type ClaudeModel } from "./claude";
import { TransactionSchema } from "../shared/commands";
import { captionClips, parseSrt, toSrt } from "../shared/subtitles";
import {
  publicProject,
  uid,
  validateProject,
  type Project,
  type Job,
  type Asset,
} from "../shared/model";
app.setName("Cutline");
let generation: GenerationLibrary;
let pictures: HiggsfieldPictures;
let generationCredentials: GenerationCredentials;
let stock: StockLibrary;
let stockCredentials: StockCredentials;
let reelBusy = false;
let speech: Speech;
let pendingProject = process.argv.find(
  (arg) => arg.endsWith(".cutline") && !arg.startsWith("-"),
);
app.on("open-file", (event, file) => {
  event.preventDefault();
  if (store) void openFromFinder(file);
  else pendingProject = file;
});
let win: BrowserWindow;
let codex: Codex;
let claude: ClaudeAssistant;
type AssistantProvider = "claude" | "codex";
let assistantSettings: {
  provider: AssistantProvider;
  claudeModel: ClaudeModel;
} = { provider: "claude", claudeModel: "opus" };
function loadAssistantSettings() {
  try {
    const saved = JSON.parse(
      readFileSync(path.join(data, "assistant-settings.json"), "utf8"),
    );
    assistantSettings = {
      provider: saved.provider === "codex" ? "codex" : "claude",
      claudeModel: saved.claudeModel === "sonnet" ? "sonnet" : "opus",
    };
  } catch {
    /* First run: Claude on Opus. */
  }
}
function saveAssistantSettings() {
  writeFileSync(
    path.join(data, "assistant-settings.json"),
    JSON.stringify(assistantSettings),
  );
}
/** Whether a graphic too detailed for a vector may become a Higgsfield picture. */
let graphicsSettings = { pictures: true };
const graphicsSettingsFile = () =>
  path.join(sessionContext.rootData, "graphics-settings.json");
function loadGraphicsSettings() {
  try {
    const saved = JSON.parse(readFileSync(graphicsSettingsFile(), "utf8"));
    graphicsSettings = { pictures: saved.pictures !== false };
  } catch {
    /* First run: pictures allowed once Higgsfield is connected. */
  }
}
let store: Store;
let media: Media;
let jobs: Jobs;
let base = "";
let bridge: Awaited<ReturnType<typeof startBridge>>;
let mcpLauncher = "";
let agentIO: ReturnType<typeof createAgentIO>;
let agentMedia: ReturnType<typeof createAgentMedia>;
let references: References;
let vectorGeneration: AbortController | undefined;
/**
 * A graphic through Cutline's one route: the signed-in Claude or ChatGPT draws
 * a vector and checks its render; a subject too detailed for that becomes a
 * Higgsfield picture when Higgsfield is connected and allowed in Settings.
 */
async function makeGraphic(
  input: GraphicGenerateInput,
  options: {
    signal?: AbortSignal;
    onStep?: (step: "drawing" | "reviewing" | "picture") => void;
  } = {},
): Promise<GraphicResult> {
  const connected = (await generationCredentials.status()).configured;
  const allowed =
    connected && (graphicsSettings.pictures || input.route === "picture");
  const made = await generateGraphic(input, {
    ask: assistantAsker(input.provider, {
      workDir: path.join(data, "assistant", "vectors"),
      signal: options.signal,
      claudeModel: assistantSettings.claudeModel,
      effort: "medium",
    }),
    render: renderSvg,
    picture: allowed
      ? (request) => pictures.generate(request, options.signal)
      : undefined,
    pictureUnavailable: connected
      ? "Detailed pictures are off. Turn on Detailed graphics as pictures in Settings to make it as a picture."
      : "This one is detailed. Connect Higgsfield in Settings to make it as a picture.",
    onStep: options.onStep,
  });
  // Every drawing places at the same visual size, centered on what is drawn.
  const fit = (svg: string) => fitSvg(svg).catch(() => svg);
  if (made.kind === "vector") return { ...made, svg: await fit(made.svg) };
  return made.drawing
    ? { ...made, drawing: { ...made.drawing, svg: await fit(made.drawing.svg) } }
    : made;
}
/**
 * Drawings made for Shorts, by description and look, so running a Short again
 * (or after an edit) reuses them instead of drawing or paying again.
 */
const drawings = new Map<string, { kind: "svg"; svg: string } | { kind: "image"; file: string }>();
let musicControl: ReturnType<typeof createMusicControl>;
let lastAgentCall: { tool: string; at: string } | undefined;
const previewRequests = new Map<
  string,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
let renderChild: ReturnType<typeof fork> | undefined;
/** True while an export makes reversed copies, before its render starts. */
let exportPreparing = false;
const root = path.join(__dirname, "../..");
// Running from source keeps its own recovery file and agent connection per
// checkout, so it never autosaves over, or takes the agents of, the
// installed app or another checkout.
const defaultData =
  process.env.CUTLINE_DATA_DIR ||
  (app.isPackaged
    ? app.getPath("userData")
    : path.join(
        app.getPath("appData"),
        "Cutline Dev",
        `${path.basename(path.resolve(root))}-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8)}`,
      ));
const sessionContext = resolveSessionContext(defaultData);
const data = sessionContext.dataDir;
mkdirSync(data, { recursive: true });
const sessions = new SessionManager({
  context: sessionContext,
  executable: process.execPath,
  sourceRoot: app.isPackaged ? undefined : root,
  version: CUTLINE_VERSION,
  focus: async (_session, connectionFile) => {
    const connection = JSON.parse(readFileSync(connectionFile, "utf8"));
    await postJson(
      connection.base + "/rpc",
      { name: "session.focus", args: {} },
      5000,
    );
  },
});
const leases = new SessionLeases(
  path.join(sessionContext.rootData, "leases"),
  sessionContext.id,
);
// Projects are files. The person's live in Movies › Cutline; test and source
// runs keep theirs beside their own data, so the two never mix.
const projectsFolder =
  (sessionContext.id === "main"
    ? process.env.CUTLINE_PROJECTS_DIR
    : undefined) ||
  (app.isPackaged &&
  sessionContext.id === "main" &&
  path.resolve(sessionContext.rootData) ===
    path.resolve(app.getPath("userData"))
    ? path.join(app.getPath("videos"), "Cutline")
    : path.join(data, "Projects"));
let library: ProjectLibrary;
let rememberedProject: string | null = null;
// One Cutline per data folder: two copies would autosave over the same
// recovery file and overwrite each other's agent connection.
if (path.resolve(data) !== path.resolve(app.getPath("userData")))
  app.setPath("userData", data);
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", (_event, argv, workingDirectory) => {
  const file = argv.find(
    (arg) => arg.endsWith(".cutline") && !arg.startsWith("-"),
  );
  if (file && store) void openFromFinder(path.resolve(workingDirectory, file));
  else if (file) pendingProject = path.resolve(workingDirectory, file);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
const vendor = app.isPackaged
  ? path.join(process.resourcesPath, "vendor")
  : path.join(root, "vendor");
const bin = {
  ffmpeg: path.join(root, "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg"),
  ffprobe: path.join(
    root,
    "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
  ),
  whisper: path.join(vendor, "whisper-cli"),
  model: path.join(vendor, "ggml-base.bin"),
};
const send = (channel: string, value: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
};
function assertRevision(args: any) {
  if (
    args.projectId !== store.project.id ||
    args.revision !== store.project.revision
  )
    throw Error("Project changed. Inspect the project and retry.");
}
/** Long edits keep the edits people make while they run; see edit-jobs.ts. */
function editJobs(): EditJobDeps {
  return {
    store,
    media,
    jobs,
    speechReady: () => existsSync(bin.whisper) && existsSync(bin.model),
  };
}
function transcribe(args: any) {
  return generateCaptions(editJobs(), args);
}
function pauses(args: any) {
  return removeLongPauses(editJobs(), args);
}
/**
 * Reversed clips play copies made on this Mac. Export and offscreen previews
 * make any that are missing first, on their own copy of the project.
 */
async function prepareReversed(project: Project, job?: Job) {
  const wanted = new Set(
    project.clips.filter((c) => c.reverse && c.assetId).map((c) => c.assetId),
  );
  for (const asset of project.assets) {
    if (!wanted.has(asset.id)) continue;
    if (asset.reversed && existsSync(asset.reversed)) continue;
    if (job)
      jobs.update(job, { message: `Reversing ${asset.name} for export` });
    asset.reversed = await media.reversedCopy(asset);
  }
  if (job) jobs.update(job, { message: "Rendering from original media" });
}
async function exportVideo(output?: string) {
  if (renderChild || exportPreparing)
    throw Error("An export is already running");
  if (!store.project.clips.length) throw Error("Add clips before exporting");
  const usedAssets = new Set(
    store.project.clips.map((c) => c.assetId).filter(Boolean),
  );
  if (store.snapshot().missing.some((id) => usedAssets.has(id)))
    throw Error("Relink missing media before exporting");
  if (!output) {
    const result = await dialog.showSaveDialog(win, {
      title: "Export video",
      defaultPath: path.join(
        store.filePath ? path.dirname(store.filePath) : app.getPath("videos"),
        store.project.name + ".mp4",
      ),
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (result.canceled || !result.filePath) return null;
    output = result.filePath;
  }
  output = path.resolve(output);
  if (!output.endsWith(".mp4")) output += ".mp4";
  if (store.project.assets.some((a) => path.resolve(a.path) === output))
    throw Error(
      "Choose a different filename; source media cannot be overwritten",
    );
  if (renderChild || exportPreparing)
    throw Error("An export is already running");
  const releaseOutput = leases.claimFile(output);
  const job = jobs.create("export", "Waiting for an export slot");
  const temporary = output + "." + job.id + ".partial.mp4";
  const chromium = path.join(vendor, browserRelativePath);
  if (!existsSync(chromium)) {
    jobs.update(job, {
      state: "error",
      message: "Export browser is missing. Rebuild the app bundle.",
    });
    releaseOutput();
    throw Error(job.message);
  }
  const frozen = structuredClone(store.project);
  exportPreparing = true;
  void (async () => {
    let releaseSlot: (() => void) | undefined;
    let exportBridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    let launched = false;
    const release = () => {
      releaseSlot?.();
      releaseOutput();
    };
    try {
      releaseSlot = await leases.exportSlot(() => job.state !== "running");
      if (job.state !== "running") return;
      await prepareReversed(frozen, job);
      if (job.state !== "running") return;
      exportBridge = await startBridge(
        { project: frozen } as Store,
        null,
        async () => null,
        [],
      );
      const inputProps = {
        project: frozen,
        mediaBase: exportBridge.base,
        preview: false,
      };
      const child = fork(path.join(__dirname, "render-worker.cjs"), [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      });
      renderChild = child;
      launched = true;
      exportPreparing = false;
      jobs.processes.set(job.id, child);
      jobs.cancellers.set(job.id, () => {
        if (child.connected) child.send({ type: "cancel" });
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.pid) {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {}
          }
        }, 5000);
        timer.unref();
      });
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      child.on("message", (m: any) => {
        if (job.state === "cancelled") return;
        if (m.type === "progress")
          jobs.update(job, {
            progress: m.progress,
            message: `Exporting · ${Math.round(m.progress * 100)}%`,
          });
        if (m.type === "done") {
          try {
            renameSync(temporary, output!);
            jobs.update(job, {
              state: "done",
              progress: 1,
              message: "Video exported",
              output,
            });
          } catch (e) {
            jobs.update(job, { state: "error", message: (e as Error).message });
          }
        }
        if (m.type === "error")
          jobs.update(job, { state: "error", message: m.message });
      });
      child.on("error", (e) =>
        jobs.update(job, { state: "error", message: e.message }),
      );
      child.on("close", () => {
        exportBridge?.close();
        release();
        renderChild = undefined;
        jobs.processes.delete(job.id);
        jobs.cancellers.delete(job.id);
        if (job.state === "running")
          jobs.update(job, {
            state: "error",
            message: stderr || "Export stopped unexpectedly",
          });
        for (const file of [
          temporary,
          temporary + ".audio.wav",
          temporary + ".video.mp4",
        ])
          if (existsSync(file)) unlinkSync(file);
      });
      child.send({
        serveUrl: path.join(root, "dist/composition"),
        inputProps,
        outputLocation: temporary,
        browserExecutable: chromium,
        ffmpeg: bin.ffmpeg,
      });
    } catch (error) {
      if (job.state === "running")
        jobs.update(job, { state: "error", message: (error as Error).message });
    } finally {
      if (!launched) {
        exportPreparing = false;
        exportBridge?.close();
        release();
      }
    }
  })();
  return job;
}
const tools = cutlineTools;
const externalTools = sessionTools(cutlineTools);
const sessionRouter = createSessionRouter({
  currentId: sessionContext.id,
  list: () => sessions.list(),
  connectionFor: (id) => sessions.connectionFor(id),
  localCall: toolCall,
  create: (name) => sessions.create(name),
  open: (id) => sessions.open(id),
});
async function externalCall(name: string, args: any) {
  if (name === "session.focus") {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return { focused: true };
  }
  return sessionRouter.call(name, args);
}
function copySessionPrompt() {
  const current = sessions.current();
  clipboard.writeText(
    `Work only in Cutline session "${current.name}" (sessionId: "${current.id}") for this chat. First call cutline_sessions with action list to verify it. Then pass sessionId: "${current.id}" on every Cutline tool call, including inspect, edit, preview, export, jobs and cancellation. Never switch to another session or modify another project. If this session is closed, reopen this exact session with cutline_sessions action open. Start by inspecting its current project.`,
  );
  return { copied: true };
}
let agentTasks: AgentTasks;
let storyControl: StoryControl;
let storyVoice: StoryProduction;
let storyBatch: StoryBatchProduction;
/** Tools whose work can outlast a client's request timeout; see AgentTasks. */
const longTools = longRunningTools;
async function toolCall(name: string, args: any) {
  if (!tools.some((tool) => tool.name === name))
    throw Error("Unknown editing tool");
  lastAgentCall = { tool: name, at: new Date().toISOString() };
  // Errors carry what the agent needs to recover: readable validation
  // messages and, for stale revisions, the revision to retry with.
  const describe = (error: unknown) =>
    conflictMessage(
      readableError(error, args ?? {}),
      args ?? {},
      store.project,
      store.past,
    );
  try {
    const earlier = new Set(jobs.jobs.keys());
    const work = runTool(name, args ?? {});
    return longTools.has(name)
      ? await agentTasks.run(name, work, describe, earlier)
      : await work;
  } catch (error) {
    throw Error(describe(error));
  }
}
async function runTool(name: string, args: any): Promise<unknown> {
  if (musicTools.some((tool) => tool.name === name)) {
    const result: any = await musicControl(name, args);
    // A sync plan holds a command per clip; keep the reply short.
    if (name === "cutline_music_sync" && result?.commands?.length > 50)
      return {
        ...result,
        commands: result.commands.slice(0, 50),
        commandCount: result.commands.length,
      };
    return result;
  }
  // A long tool that outlived its call answers with a task ID; cancelling
  // that ID stops the work the tool started.
  if (name === "cutline_cancel_job") {
    const task = agentTasks.cancel(args?.id);
    if (task) return task;
  }
  if (agentIoTools.some((tool) => tool.name === name))
    return agentIO(name, args);
  if (agentMediaTools.some((tool) => tool.name === name))
    return agentMedia(name, args);
  switch (name) {
    case "cutline_explainer": {
      assertRevision(args);
      const input = ExplainerInputSchema.parse(args.input);
      return storyControl.save({
        projectId: args.projectId,
        revision: args.revision,
        story: createExplainerStory(input, store.project.story),
      });
    }
    case "cutline_story_produce": {
      const { story: savedStory, ...result } = await storyBatch.produce(args);
      return {
        ...result,
        quality: analyzeVideoQuality(store.project, {
          assetAvailable: (asset) => existsSync(asset.path),
        }),
      };
    }
    case "cutline_story":
      return args.story ? storyControl.save(args) : storyControl.inspect();
    case "cutline_story_voice": {
      const result = await storyVoice.voice(args);
      return {
        ...result,
        asset: {
          id: result.asset.id,
          name: result.asset.name,
          duration: result.asset.duration,
          captionWords: result.asset.words?.length ?? 0,
        },
      };
    }
    case "cutline_story_assemble": {
      const result = storyControl.assemble(args);
      return {
        ...result,
        quality: analyzeVideoQuality(store.project, {
          assetAvailable: (asset) => existsSync(asset.path),
        }),
      };
    }
    case "cutline_director_guide":
      return getDirectorGuide(
        z.enum(directorStyles).parse(args.style ?? "cinematic"),
      );
    case "cutline_quality_check":
      return analyzeVideoQuality(store.project, {
        assetAvailable: (asset) => existsSync(asset.path),
      });
    case "cutline_editing_schema":
      return agentEditingSchema(args);
    case "cutline_edit":
      return performAgentEdit(store, args);
    case "cutline_create_reel":
      return createReel(args);
    case "cutline_stock_search":
      return stock.search(
        z.string().trim().min(1).max(150).parse(args.query),
        0,
        {
          provider: z
            .enum(["commons", "pexels"])
            .parse(args.provider ?? "commons"),
          kind: z.enum(["video", "image"]).parse(args.kind ?? "video"),
          orientation: z
            .enum(["all", "portrait", "landscape", "square"])
            .parse(args.orientation ?? "all"),
        },
      );
    case "cutline_effects_guide":
      return effectsGuideResult();
    case "cutline_inspect":
      return inspectProject(store.project, args);
    case "cutline_apply_edits": {
      const before = store.project;
      store.transact(args);
      return {
        revision: store.project.revision,
        label: args.label,
        summary: changeSummary(before, store.project),
      };
    }
    case "cutline_transcribe":
      return transcribe(args);
    case "cutline_remove_pauses":
      return pauses(args);
    case "cutline_search_transcript":
      return searchTranscript(store.project, args);
    case "cutline_transcript":
      return readTranscript(store.project, args);
    case "cutline_export": {
      const parsed = z
        .object({
          projectId: z.string(),
          revision: z.number().int(),
          path: z.string().optional(),
        })
        .strict()
        .parse(args);
      assertRevision(parsed);
      const output =
        parsed.path ??
        path.join(
          data,
          "exports",
          `${store.project.name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "Cutline"}-${Date.now()}.mp4`,
        );
      if (!path.isAbsolute(output))
        throw Error("Use an absolute MP4 output path.");
      const target = output.endsWith(".mp4") ? output : output + ".mp4";
      if (existsSync(target))
        throw Error("That file already exists. Choose a new export filename.");
      mkdirSync(path.dirname(target), { recursive: true });
      const job = await exportVideo(target);
      if (!job) return null;
      const { output: _output, ...visible } = job;
      return { ...visible, exportPath: target };
    }
    case "cutline_jobs":
      return agentTasks.list(args);
    case "cutline_undo": {
      assertRevision(args);
      const before = store.project,
        label = store.past.at(-1)?.label;
      store.undo();
      return label
        ? {
            undone: label,
            revision: store.project.revision,
            summary: changeSummary(before, store.project),
          }
        : {
            revision: store.project.revision,
            undone: null,
            message: "Nothing to undo.",
          };
    }
    default:
      throw Error("Unknown editing tool");
  }
}
function connectionStatus() {
  return {
    ready: !!base && existsSync(mcpLauncher),
    launcherReady: existsSync(mcpLauncher),
    message:
      "Local editing bridge ready. Connect your client to use Cutline's tools.",
    tools: externalTools.length,
    projectName: store.project.name,
    sessionId: sessionContext.id,
    sessionName: sessions.current().name,
    protocols: ["stdio", "streamable-http"],
    lastCall: lastAgentCall,
  };
}
/** Moves the editor's playhead, selection and play state as asked, and reports them. */
async function editorPreview(args: any) {
  if (!win || win.isDestroyed())
    throw Error("Cutline's editor window is not ready.");
  const requestId = uid();
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      previewRequests.delete(requestId);
      reject(
        Error(
          "Preview did not respond. Bring Cutline to the foreground and retry.",
        ),
      );
    }, 10000);
    previewRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    send("agent", { requestId, ...args });
  });
}
const previewBundle = path.join(root, "dist/composition");
const previewBrowser = path.join(vendor, browserRelativePath);
const stillWorker = path.join(__dirname, "still-worker.cjs");
let previewQueue: Promise<unknown> = Promise.resolve();
/** Renders frames like the export does, one preview at a time. */
function renderOffscreen(project: Project, frames: number[], args: any) {
  const run = async () => {
    const frozen = structuredClone(project);
    await prepareReversed(frozen);
    const media = await startBridge(
      { project: frozen } as Store,
      null,
      async () => null,
      [],
    );
    try {
      return await renderPreview({
        project: frozen,
        frames,
        width: args.width,
        layout: args.layout,
        ffmpeg: bin.ffmpeg,
        render: (list, scale, directory) =>
          renderStills({
            workerPath: stillWorker,
            serveUrl: previewBundle,
            browserExecutable: previewBrowser,
            inputProps: {
              project: frozen,
              mediaBase: media.base,
              preview: false,
            },
            frames: list,
            scale,
            directory,
          }),
      });
    } finally {
      media.close();
    }
  };
  const next = previewQueue.then(run, run);
  previewQueue = next.catch(() => {});
  return next;
}
async function preview(args: any) {
  if (args.projectId !== undefined || args.revision !== undefined)
    assertRevision({
      projectId: args.projectId ?? store.project.id,
      revision: args.revision ?? store.project.revision,
    });
  const project = store.project;
  // Sampled frames (frames, count or a range) render offscreen without
  // touching the editor; other requests also move its playhead and selection.
  const sampled = samplesFrames(args);
  const image = args.image || sampled;
  const named =
    args.frame !== undefined || args.seconds !== undefined || sampled;
  let editor: any;
  if (!sampled || args.playing !== undefined)
    try {
      editor = await editorPreview({
        projectId: project.id,
        revision: project.revision,
        frame: args.frame,
        seconds: args.seconds,
        clipId: sampled ? undefined : args.clipId,
        playing: args.playing,
        image,
      });
    } catch (error) {
      // An image of a named frame does not need the editor to answer.
      if (!image || !named || /^Project changed/.test((error as Error).message))
        throw error;
    }
  const editorState = () =>
    editor
      ? {
          frame: editor.frame,
          playing: editor.playing,
          selectedClipId: editor.selectedClipId,
        }
      : {};
  if (!image) return { revision: project.revision, ...editorState() };
  const frames = previewFrames(project, args, editor?.frame);
  // The editor is not on the rendered frame (a clip outside the playhead
  // previews its middle, or a project that just opened reset the playhead):
  // move it there, so the reply, the image and the editor agree.
  if (editor && !sampled && frames.length === 1 && editor.frame !== frames[0])
    editor = await editorPreview({
      projectId: project.id,
      revision: project.revision,
      frame: frames[0],
      clipId: args.clipId,
      image: true,
    });
  const state = editorState();
  const missing = new Set(store.snapshot().missing);
  const absent = project.clips.filter(
    (clip) =>
      clip.assetId &&
      missing.has(clip.assetId) &&
      frames.some(
        (frame) => frame >= clip.start && frame < clip.start + clip.duration,
      ),
  );
  if (absent.length)
    throw Error(
      `Relink the missing media first: ${[...new Set(absent.map((clip) => project.assets.find((asset) => asset.id === clip.assetId)?.name))].join(", ")}.`,
    );
  let failure = "";
  if (
    existsSync(path.join(previewBundle, "index.html")) &&
    existsSync(previewBrowser) &&
    existsSync(stillWorker)
  )
    try {
      const rendered = await renderOffscreen(project, frames, args);
      return previewContent({ ...rendered.info, ...state }, rendered.images);
    } catch (error) {
      failure = (error as Error).message;
    }
  // Without the export renderer, one frame can still come from the editor view.
  if (frames.length > 1 || !editor)
    throw Error(
      failure
        ? `The preview could not be rendered: ${failure}`
        : "Rendered previews need the export renderer. Build Cutline (npm run build), then try again.",
    );
  const shown =
    editor.frame === frames[0]
      ? editor
      : await editorPreview({
          projectId: project.id,
          revision: project.revision,
          frame: frames[0],
          image: true,
        });
  const rect = shown.rect;
  if (!rect || rect.width < 1 || rect.height < 1)
    throw Error("Preview is not visible.");
  const screenshot = await win.webContents.capturePage(rect);
  assertRevision({ projectId: project.id, revision: project.revision });
  const jpeg = screenshot
    .resize({ width: Math.min(1280, screenshot.getSize().width) })
    .toJPEG(80);
  return previewContent(
    {
      revision: project.revision,
      renderer: "editor",
      frames: [
        { index: 1, frame: frames[0], time: timecode(frames[0], project.fps) },
      ],
      layout: "single",
      ...state,
      note: `Captured from the editor view, which can show selection outlines and guides, because the export renderer was unavailable${failure ? `: ${failure}` : "."}`,
    },
    [{ label: "", data: jpeg.toString("base64") }],
  );
}
async function createReel(args: any) {
  assertRevision(args);
  if (reelBusy) throw Error("A Reel is already being built.");
  reelBusy = true;
  try {
    return await buildReel(editJobs(), args);
  } finally {
    reelBusy = false;
  }
}
/** cutline_auto_edit: the Auto edit button's work on a given video, without a dialog. */
async function autoEditForAgent(args: {
  projectId: string;
  revision: number;
  assetId?: string;
  path?: string;
  options: unknown;
}) {
  if (reelBusy) throw Error("A Reel is already being built.");
  reelBusy = true;
  try {
    const provider = (await stockCredentials.status()).pexelsConfigured
      ? "pexels"
      : "commons";
    return await buildAutoReel(args, {
      store,
      media,
      jobs,
      stock,
      musicFolder: path.join(data, "original-music"),
      provider: () => provider,
    });
  } finally {
    reelBusy = false;
  }
}
/** Dialogs attach to the editor window once it exists. */
function messageBox(options: Electron.MessageBoxOptions) {
  return win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options);
}
/** Saves to the project file, or asks where when there is none or it can't be written. */
async function saveProject(chooseFile = false) {
  let file = store.filePath;
  if (!file || chooseFile || store.saveError) {
    const options: Electron.SaveDialogOptions = {
      defaultPath: store.project.name + ".cutline",
      filters: [{ name: "Cutline project", extensions: ["cutline"] }],
    };
    const d =
      win && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
    if (d.canceled || !d.filePath) return null;
    file = d.filePath;
  }
  return store.save(file);
}
async function askToSave(name: string): Promise<UnsavedChoice> {
  // Automated runs never wait on a dialog; the store still keeps a backup.
  if (process.env.CUTLINE_QA) return "discard";
  const { response } = await messageBox({
    type: "warning",
    message: `Save “${name}” first?`,
    detail: `${store.filePath ? "Cutline couldn't save it to its file." : "It hasn't been saved to a file yet."} If you don't save it, a dated copy is kept in File > Open backup.`,
    buttons: ["Save…", "Don't save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  return response === 0 ? "save" : response === 1 ? "discard" : "cancel";
}
/** Asks about unsaved work first. Returns false when the person cancels. */
function readyToReplace() {
  return confirmReplace(store, askToSave, async () => !!(await saveProject()));
}
async function newProject() {
  if (!(await readyToReplace())) return null;
  return store.fresh();
}
async function openProject(file: string, backup = false) {
  if (!(await readyToReplace())) return null;
  // A backup opens as an unsaved copy, so edits never write into backups.
  return backup ? store.restore(file) : store.load(file);
}
async function chooseProject() {
  const d = await dialog.showOpenDialog(win, {
    filters: [{ name: "Cutline project", extensions: ["cutline"] }],
    properties: ["openFile"],
  });
  if (d.canceled || !d.filePaths[0]) return null;
  return openProject(d.filePaths[0]);
}
/** Keeps the open project's file at the top of Projects and File › Open Recent. */
function rememberProject() {
  const file = store.filePath;
  if (!file || file === rememberedProject) return;
  rememberedProject = file;
  library.remember(file);
  app.addRecentDocument(file);
}
/** Moves a project file to the Trash after asking. The open project is never trashed. */
async function trashProject(file: string) {
  const entry = library
    .list(store.filePath)
    .find((p) => path.resolve(p.path) === path.resolve(file));
  if (!entry) throw Error("That project is no longer in the list.");
  if (entry.open) throw Error("This project is open. Open another one first.");
  if (!process.env.CUTLINE_QA) {
    const { response } = await messageBox({
      type: "warning",
      message: `Move “${entry.name}” to the Trash?`,
      detail:
        "Its media files stay where they are. You can put the project back from the Trash.",
      buttons: ["Move to Trash", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return null;
  }
  const release = leases.claimFile(entry.path);
  try {
    await shell.trashItem(entry.path);
  } finally {
    release();
  }
  library.forget(entry.path);
  return library.list(store.filePath);
}
/** Lists the dated copies of unsaved projects that New and Open keep. */
async function openBackup() {
  mkdirSync(store.backupDirectory, { recursive: true });
  const d = await dialog.showOpenDialog(win, {
    title: "Open a backup",
    buttonLabel: "Open backup",
    defaultPath: store.backupDirectory,
    filters: [{ name: "Cutline project", extensions: ["cutline"] }],
    properties: ["openFile"],
  });
  if (d.canceled || !d.filePaths[0]) return null;
  return openProject(d.filePaths[0], true);
}
/** Opens a project double-clicked in Finder or passed at launch. */
async function openFromFinder(file: string) {
  try {
    await openProject(path.resolve(file));
    if (win && !win.isDestroyed()) win.show();
  } catch (error) {
    dialog.showErrorBox("Could not open project", (error as Error).message);
  }
}
/** Menu commands report problems in a dialog, since no editor call is waiting. */
async function fromMenu(command: () => Promise<unknown>) {
  try {
    await command();
  } catch (error) {
    dialog.showErrorBox("Cutline", (error as Error).message);
  }
}
let saveWarningOpen = false;
/** Says once when autosave starts failing, and offers a new place to save. */
async function warnSaveFailed(message: string) {
  if (saveWarningOpen || process.env.CUTLINE_QA || !win || win.isDestroyed())
    return;
  saveWarningOpen = true;
  try {
    const { response } = await messageBox({
      type: "warning",
      message: "Cutline couldn't save your project",
      detail: message,
      buttons: ["Save as…", "Not now"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await fromMenu(() => saveProject(true));
  } finally {
    saveWarningOpen = false;
  }
}
const referenceExtensions = ["png", "jpg", "jpeg", "webp"];
async function referencePreview(file: string) {
  const info = statSync(file);
  if (
    !info.isFile() ||
    !referenceExtensions.includes(path.extname(file).slice(1).toLowerCase()) ||
    info.size === 0 ||
    info.size > 20 * 1024 * 1024
  )
    throw Error("Choose a PNG, JPEG or WebP image under 20 MB.");
  const thumbnail = await nativeImage.createThumbnailFromPath(file, {
    width: 180,
    height: 180,
  });
  if (thumbnail.isEmpty())
    throw Error("This reference image could not be read.");
  return thumbnail.toDataURL();
}
async function pickGenerationReferences(multiple: boolean) {
  const result = await dialog.showOpenDialog(win, {
    title: multiple ? "Choose reference images" : "Choose a starting image",
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    filters: [{ name: "Images", extensions: referenceExtensions }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const files = [...new Set(result.filePaths)];
  if (files.length > (multiple ? 9 : 1))
    throw Error("Choose up to 9 reference images per shot.");
  const references = [];
  for (const file of files) {
    const previewUrl = await referencePreview(file);
    references.push({ ...(await generation.pickReference(file)), previewUrl });
  }
  return references;
}
function register() {
  const story = new StoryControl({
    store,
    generation,
    configured: async () => (await generationCredentials.status()).configured,
  });
  const storyProduction = new StoryProduction({ store, speech, media, jobs });
  const batch = new StoryBatchProduction({
    store,
    production: storyProduction,
    control: story,
    jobs,
  });
  storyControl = story;
  storyVoice = storyProduction;
  storyBatch = batch;
  const handlers: Record<string, (args: any) => any> = {
    "story.inspect": () => story.inspect(),
    "story.save": (args) => story.save(args),
    "story.importReferences": async (args) => {
      assertRevision(args);
      const openSession = store.openSession;
      const check = () => {
        assertRevision(args);
        if (store.openSession !== openSession)
          throw Error(
            "Project changed. Import references into the current story.",
          );
      };
      const chosen = await dialog.showOpenDialog(win, {
        title: "Import story reference images",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Images", extensions: referenceExtensions }],
      });
      if (chosen.canceled || !chosen.filePaths.length) return null;
      check();
      const files = [...new Set(chosen.filePaths)];
      if (files.length > 9)
        throw Error("Choose up to 9 reference images at a time.");
      const assets: Asset[] = [];
      const failures: { name: string; error: string }[] = [];
      for (const file of files) {
        check();
        try {
          await referencePreview(file);
          const existing = store.project.assets.find(
            (asset) =>
              asset.kind === "image" &&
              path.resolve(asset.path) === path.resolve(file),
          );
          const asset = existing ?? (await media.import(file));
          if (asset.kind !== "image")
            throw Error("Choose a still image for the reference.");
          assets.push(asset);
        } catch (error) {
          failures.push({
            name: path.basename(file),
            error: (error as Error).message,
          });
        }
        check();
      }
      const additions = assets.filter(
        (asset) =>
          !store.project.assets.some((existing) => existing.id === asset.id),
      );
      if (additions.length)
        store.commit(
          { ...store.project, assets: [...store.project.assets, ...additions] },
          "Import story reference images",
        );
      return { assets, revision: store.project.revision, failures };
    },
    "story.generate": (args) => story.generate(args),
    "story.refresh": (args) => story.refresh(args),
    "story.voice": (args) => storyProduction.voice(args),
    "story.produce": (args) => batch.produce(args),
    "story.assemble": (args) => story.assemble(args),
    ...Object.fromEntries(
      ["analyze", "grid", "sync", "reactive", "create", "inspect"].map(
        (action) => [
          `music.${action}`,
          (args: any) => musicControl(`music.${action}`, args),
        ],
      ),
    ),
    "reel.create": createReel,
    "reel.auto": async (args) => {
      assertRevision(args);
      if (reelBusy) throw Error("A Reel is already being built.");
      const options = AutoReelOptionsSchema.parse(args.options ?? {});
      reelBusy = true;
      try {
        let file = args.path;
        if (!file && !args.assetId) {
          const chosen = await dialog.showOpenDialog(win, {
            title: "Choose a video to auto edit",
            properties: ["openFile"],
            filters: [
              {
                name: "Video",
                extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi"],
              },
            ],
          });
          if (chosen.canceled) return null;
          file = chosen.filePaths[0];
        }
        const provider = (await stockCredentials.status()).pexelsConfigured
          ? "pexels"
          : "commons";
        return await buildAutoReel(
          {
            projectId: args.projectId,
            revision: args.revision,
            ...(file ? { path: file } : { assetId: args.assetId }),
            options,
          },
          {
            store,
            media,
            jobs,
            stock,
            musicFolder: path.join(data, "original-music"),
            provider: () => provider,
          },
        );
      } finally {
        reelBusy = false;
      }
    },
    "tts.status": () => speech.status(),
    "tts.setup": () => speech.setup(),
    "tts.generate": async (args) => {
      const opening = store.openSession;
      return jobs.run("voiceover", "Creating your narration", async (job) => {
        const check = () => {
          if (job.state === "cancelled") throw Error("Narration cancelled");
          if (store.openSession !== opening)
            throw Error(
              "The project changed while generating narration. Your edit was kept; the audio remains in Cutline's local speech folder.",
            );
        };
        const generated = await speech.generate(args);
        check();
        const asset = await media.import(generated.path);
        check();
        asset.name = String(args.name || "Kokoro narration").slice(0, 150);
        store.commit(
          { ...store.project, assets: [...store.project.assets, asset] },
          "Generate narration",
        );
        return asset;
      });
    },
    "audio.export": async (args) => {
      const assetId = z.string().parse(args.assetId);
      const asset = store.project.assets.find(
        (a) => a.id === assetId && a.kind === "audio",
      );
      if (!asset || !existsSync(asset.path))
        throw Error("That audio file is missing.");
      const selected = await dialog.showSaveDialog(win, {
        defaultPath: asset.name.replace(/\.[a-z0-9]+$/i, "") + ".wav",
        filters: [{ name: "WAV audio", extensions: ["wav"] }],
      });
      if (selected.canceled || !selected.filePath) return null;
      const destination = selected.filePath;
      if (
        store.project.assets.some(
          (a) => path.resolve(a.path) === path.resolve(destination),
        )
      )
        throw Error(
          "Choose another filename; source audio cannot be overwritten.",
        );
      return jobs.run("audio-export", "Saving WAV audio", async (job) => {
        const temporary = destination + "." + uid() + ".tmp.wav";
        try {
          await jobs.exec(
            bin.ffmpeg,
            [
              "-y",
              "-v",
              "error",
              "-i",
              asset.path,
              "-vn",
              "-c:a",
              "pcm_s16le",
              temporary,
            ],
            job,
          );
          if (job.state === "cancelled") throw Error("Export cancelled");
          renameSync(temporary, destination);
          return { path: destination };
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
      });
    },
    "generation.settings": () => generationCredentials.status(),
    "generation.configure": async (args) => {
      // A free price check catches a rejected key now, not on a paid request.
      // Offline or any other answer keeps the key; only a 401 refuses it.
      const key = typeof args?.key === "string" ? args.key.trim() : "";
      try {
        await higgsfieldCall(
          (...request) => fetch(...request),
          "estimate/recraft/v4.1/text-to-image",
          key,
          { prompt: "Key check", resolution: "1k", aspect_ratio: "1:1" },
        );
      } catch (error) {
        if (error instanceof ProviderError && error.status === 401)
          throw Error(
            "Higgsfield rejected this key. Copy the complete key from open.higgsfield.ai and paste it again.",
          );
      }
      return generationCredentials.setKey(key);
    },
    "generation.disconnect": () => generationCredentials.clearKey(),
    "generation.openKeys": () =>
      shell.openExternal("https://open.higgsfield.ai/api-keys"),
    "generation.openDashboard": (args) => {
      const job = args?.id
        ? generation
            .list()
            .find((job) => job.id === z.string().uuid().parse(args.id))
        : undefined;
      const modelPath =
        job?.model === "kling-3"
          ? "kling-video/v3.0/std/text-to-video"
          : `bytedance/seedance-2.0/${job?.referenceNames?.length ? "reference" : job?.referenceName ? "image" : "text"}-to-video`;
      return shell.openExternal(
        job
          ? `https://open.higgsfield.ai/models/${modelPath}/requests`
          : "https://open.higgsfield.ai",
      );
    },
    "generation.list": () => generation.list(),
    "generation.pickReference": async () =>
      (await pickGenerationReferences(false))?.[0] ?? null,
    "generation.pickReferences": () => pickGenerationReferences(true),
    "generation.submit": (args) => {
      if (args.projectId !== store.project.id)
        throw Error("Project changed. Generate from the current project.");
      return generation.submit(args);
    },
    "generation.refresh": (args) =>
      generation.refresh(z.string().uuid().parse(args.id)),
    "generation.recover": (args) =>
      generation.recover(z.string().uuid().parse(args.id)),
    "generation.cancel": (args) =>
      generation.cancel(z.string().uuid().parse(args.id)),
    "generation.import": async (args) => {
      const id = z.string().uuid().parse(args.id);
      const projectId = z.string().parse(args.projectId);
      if (projectId !== store.project.id)
        throw Error("Project changed. Import into the current project.");
      const existing = store.project.assets.find((a) => a.id === id);
      if (existing) return existing;
      const opening = store.openSession;
      const asset = await generation.importAsset(id);
      if (store.openSession !== opening)
        throw Error(
          "Project changed during import. Your generated file is saved; import it into the project you want.",
        );
      const already = store.project.assets.find((a) => a.id === id);
      if (already) return already;
      store.commit(
        { ...store.project, assets: [...store.project.assets, asset] },
        "Import generated video",
      );
      return asset;
    },
    "stock.settings": () => stockCredentials.status(),
    "stock.configure": (args) => stockCredentials.setPexels(args.key),
    "stock.disconnect": () => stockCredentials.clearPexels(),
    "stock.search": (args) =>
      stock.search(
        z.string().trim().min(1).max(150).parse(args.query),
        z
          .number()
          .int()
          .min(0)
          .max(1000)
          .parse(args.offset ?? 0),
        {
          provider: z
            .enum(["commons", "pexels"])
            .parse(args.provider ?? "commons"),
          kind: z.enum(["video", "image"]).parse(args.kind ?? "video"),
          orientation: z
            .enum(["all", "portrait", "landscape", "square"])
            .parse(args.orientation ?? "all"),
        },
      ),
    "stock.download": async (args) => {
      const opening = store.openSession;
      const asset = await stock.download(
        z.number().int().positive().parse(args.id),
        z.enum(["commons", "pexels"]).parse(args.provider ?? "commons"),
        z.enum(["video", "image"]).parse(args.kind ?? "video"),
      );
      if (store.openSession !== opening)
        throw Error(
          "Project changed while downloading. The file remains in your local stock folder.",
        );
      store.commit(
        { ...store.project, assets: [...store.project.assets, asset] },
        "Import stock B-roll",
      );
      return asset;
    },
    "stock.source": (args) =>
      shell.openExternal(stockUrl(z.string().parse(args.url), "page")),
    "stock.browse": (args) => {
      const provider = z.enum(["pexels", "pixabay"]).parse(args.provider),
        query = z
          .string()
          .max(150)
          .parse(args.query ?? "");
      return shell.openExternal(
        provider === "pexels"
          ? `https://www.pexels.com/search/videos/${encodeURIComponent(query)}/`
          : `https://pixabay.com/videos/search/${encodeURIComponent(query)}/`,
      );
    },
    "stock.credits": async () => {
      const assets = store.project.assets.filter((a) => a.origin);
      if (!assets.length) throw Error("No stock credits in this project yet.");
      const d = await dialog.showSaveDialog(win, {
        defaultPath: "Cutline-credits.txt",
        filters: [{ name: "Credits", extensions: ["txt"] }],
      });
      if (!d.canceled && d.filePath)
        writeFileSync(
          d.filePath,
          assets
            .map(
              (a) =>
                `${a.origin!.title} by ${a.origin!.creator}\n${a.origin!.page}\n${a.origin!.license} ${a.origin!.licenseUrl}\n`,
            )
            .join("\n"),
        );
    },
    state: () => ({
      snapshot: store.snapshot(),
      mediaBase: base,
      jobs: [...jobs.jobs.values()],
      settings: {
        transcriptionReady: existsSync(bin.whisper) && existsSync(bin.model),
        mcpScript: path.join(__dirname, "mcp.cjs"),
        connection: path.join(data, "connection.json"),
        mcpLauncher,
        mcpUrl: bridge.mcpUrl,
      },
    }),
    edit: (args) => store.transact(args),
    /**
     * The editor's own edits: the window gets the new project through the
     * "state" event already, so the reply carries only what the edit queue
     * needs instead of a second full copy of the project.
     */
    "edit.brief": (args) => {
      const { project } = store.transact(args);
      return { project: { id: project.id, revision: project.revision } };
    },
    "sessions.list": async () => ({
      currentId: sessionContext.id,
      sessions: await sessions.list(),
    }),
    "sessions.create": (args) => sessions.create(args?.name),
    "sessions.open": (args) => sessions.open(String(args?.sessionId ?? "")),
    "sessions.copyPrompt": copySessionPrompt,
    "connection.status": connectionStatus,
    "connection.test": async () => ({
      ...connectionStatus(),
      tools: await testAgentConnection(
        mcpLauncher,
        path.join(data, "connection.json"),
        sessionContext.id,
      ),
      message:
        "MCP connection verified: the bundled launcher can list Cutline's editing tools.",
    }),
    "connection.installClaude": () =>
      installClaudeConnection(
        process.env.CUTLINE_QA
          ? path.join(data, "test-claude-config.json")
          : path.join(
              app.getPath("appData"),
              "Claude",
              "claude_desktop_config.json",
            ),
        mcpLauncher,
        path.join(data, "connection.json"),
      ),
    "connection.installClaudeCode": () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.CLAUDECODE;
      // QA runs write to a disposable Claude Code config instead of yours.
      if (process.env.CUTLINE_QA)
        env.CLAUDE_CONFIG_DIR = path.join(data, "test-claude-code");
      return installClaudeCodeConnection(
        findClaude(),
        mcpLauncher,
        path.join(data, "connection.json"),
        env,
      );
    },
    "connection.installCodex": () =>
      installCodexConnection(
        process.env.CUTLINE_QA
          ? path.join(data, "test-codex-config.toml")
          : path.join(
              process.env.CODEX_HOME ||
                path.join(app.getPath("home"), ".codex"),
              "config.toml",
            ),
        mcpLauncher,
        path.join(data, "connection.json"),
      ),
    "agent.preview.ack": (args) => {
      const request = previewRequests.get(args.requestId);
      if (request) {
        previewRequests.delete(args.requestId);
        if (args.error) request.reject(Error(args.error));
        else request.resolve(args.state);
      }
    },
    "connection.docs": (args) => {
      const allowed = [
        "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
        "https://developers.openai.com/codex/mcp",
        "https://code.claude.com/docs/en/mcp",
        "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
        "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
      ];
      if (!allowed.includes(args.url))
        throw Error("Unknown connection documentation");
      return shell.openExternal(args.url);
    },
    undo: () => store.undo(),
    redo: () => store.redo(),
    new: () => newProject(),
    save: () => saveProject(),
    "save.as": () => saveProject(true),
    open: () => chooseProject(),
    "backup.open": () => openBackup(),
    "projects.list": () => ({
      folder: projectsFolder,
      projects: library.list(store.filePath),
    }),
    "projects.open": (args) => {
      const file = String(args?.path ?? "");
      if (!file.endsWith(".cutline")) throw Error("Choose a Cutline project.");
      return openProject(file);
    },
    "projects.reveal": (args) => shell.showItemInFolder(String(args?.path)),
    "projects.folder": async () => {
      mkdirSync(projectsFolder, { recursive: true });
      const problem = await shell.openPath(projectsFolder);
      if (problem) throw Error(problem);
    },
    "projects.trash": (args) => trashProject(String(args?.path)),
    /**
     * Motion > Vectors > Generate: a vector, or a Higgsfield picture that is
     * imported into the project's media right away so it is never paid twice.
     */
    "graphic.generate": async (args) => {
      const input = GraphicGenerateSchema.parse(args ?? {});
      vectorGeneration?.abort();
      const controller = (vectorGeneration = new AbortController());
      try {
        const made = await makeGraphic(input, {
          signal: controller.signal,
          onStep: (step) => send("graphic", { step }),
        });
        if (made.kind === "vector") return made;
        const imported = await media.import(made.file);
        imported.name = input.prompt.replace(/\s+/gu, " ").slice(0, 60);
        store.commit(
          validateProject({
            ...store.project,
            assets: [...store.project.assets, imported],
          }),
          "Add generated picture",
        );
        return { ...made, assetId: imported.id };
      } finally {
        if (vectorGeneration === controller) vectorGeneration = undefined;
      }
    },
    "graphic.cancel": () => {
      vectorGeneration?.abort();
      vectorGeneration = undefined;
    },
    "graphic.settings": async () => ({
      ...graphicsSettings,
      connected: (await generationCredentials.status()).configured,
    }),
    "graphic.settings.set": async (args) => {
      graphicsSettings = {
        pictures: z.boolean().parse(args?.pictures),
      };
      writeFileSync(graphicsSettingsFile(), JSON.stringify(graphicsSettings));
      return {
        ...graphicsSettings,
        connected: (await generationCredentials.status()).configured,
      };
    },
    "graphic.estimate": (args) =>
      pictures.estimate({
        prompt: "estimate",
        style: "flat",
        aspect: z
          .enum(["square", "wide", "tall"])
          .catch("square")
          .parse(args?.aspect),
      }),
    "reference.search": (args) =>
      references.searchLogos(
        z
          .string()
          .max(100)
          .parse(args?.query ?? ""),
      ),
    "reference.add": (args) => agentMedia("cutline_reference", args),
    "vector.import": async (args) => {
      assertRevision(args);
      let file = args.path;
      if (!file) {
        const selected = await dialog.showOpenDialog(win, {
          title: "Import an editable SVG logo",
          properties: ["openFile"],
          filters: [{ name: "SVG vector", extensions: ["svg"] }],
        });
        if (selected.canceled || !selected.filePaths[0]) return null;
        file = selected.filePaths[0];
      }
      return agentIO("cutline_vector_import", { ...args, path: file });
    },
    import: async (args) => {
      let files: string[] = args?.paths
        ? z.array(z.string()).max(100).parse(args.paths)
        : [];
      if (!files.length) {
        const d = await dialog.showOpenDialog(win, {
          properties: ["openFile", "multiSelections"],
          filters:
            args?.kind === "audio"
              ? [
                  {
                    name: "Audio",
                    extensions: [
                      "mp3",
                      "wav",
                      "m4a",
                      "aac",
                      "flac",
                      "ogg",
                      "aiff",
                    ],
                  },
                ]
              : [
                  {
                    name: "Media",
                    extensions: [
                      "mp4",
                      "mov",
                      "mkv",
                      "webm",
                      "mp3",
                      "wav",
                      "m4a",
                      "aac",
                      "png",
                      "jpg",
                      "jpeg",
                      "webp",
                      "gif",
                    ],
                  },
                ],
        });
        if (d.canceled) return;
        files = d.filePaths;
      }
      const opening = store.openSession;
      const failures: string[] = [];
      for (const file of files) {
        try {
          const asset = await media.import(file);
          if (store.openSession !== opening)
            throw Error("Project changed during import");
          store.commit(
            { ...store.project, assets: [...store.project.assets, asset] },
            "Import media",
          );
        } catch (error) {
          if (store.openSession !== opening) throw error;
          failures.push(`${path.basename(file)}: ${(error as Error).message}`);
        }
      }
      if (failures.length)
        throw Error(
          `${files.length - failures.length} of ${files.length} files imported.\n${failures.join("\n")}`,
        );
      return store.snapshot();
    },
    relink: async (args) => {
      const a = store.project.assets.find((a) => a.id === args.id);
      if (!a) throw Error("Asset missing");
      const d = await dialog.showOpenDialog(win, {
        title: `Relink ${a.name}`,
        properties: ["openFile"],
      });
      if (d.canceled) return;
      // Keeps the media's name, credits, transcript and beats, and finds
      // other missing files that moved to the same folder.
      const result = await relinkMedia({ store, media }, a.id, d.filePaths[0]);
      if (result.cleared)
        void dialog.showMessageBox(win, {
          type: "info",
          message: `${a.name} now points to a file of a different length`,
          detail:
            "Its transcript and beat markers were cleared because they no longer line up. Generate captions or analyze the music again if you need them.",
        });
      return store.snapshot();
    },
    transcribe: transcribe,
    pauses: pauses,
    "srt.import": async () => {
      const d = await dialog.showOpenDialog(win, {
        filters: [{ name: "Subtitles", extensions: ["srt"] }],
        properties: ["openFile"],
      });
      if (d.canceled) return;
      const words = parseSrt(readFileSync(d.filePaths[0], "utf8"));
      const clips = words.flatMap((w) => captionClips(store.project, [w]));
      return store.commit(
        { ...store.project, clips: [...store.project.clips, ...clips] },
        "Import subtitles",
      );
    },
    "srt.export": async () => {
      const d = await dialog.showSaveDialog(win, {
        defaultPath: store.project.name + ".srt",
      });
      if (!d.canceled && d.filePath)
        writeFileSync(
          d.filePath,
          toSrt(store.project.clips, store.project.fps),
        );
    },
    export: () => exportVideo(),
    "job.cancel": (args) => jobs.cancel(args.id),
    reveal: (args) => {
      const j = jobs.jobs.get(args.id);
      if (j?.output) shell.showItemInFolder(j.output);
    },
    "codex.status": () => codex.status(),
    "codex.reconnect": () => codex.reconnect(),
    "codex.connect": () => codex.connect(),
    "codex.login": async () => {
      const result = await codex.login();
      if (result.authUrl && new URL(result.authUrl).protocol === "https:")
        await shell.openExternal(result.authUrl);
      return { started: true };
    },
    "codex.send": (args) =>
      codex.send(
        z.string().min(1).max(20000).parse(args.text),
        store.project.id,
      ),
    "codex.stop": () => codex.stop(),
    "codex.newChat": () => codex.newChat(),
    "claude.newChat": () => claude.newChat(),
    "assistant.settings": () => ({
      ...assistantSettings,
      claudeInstalled: !!findClaude(),
    }),
    "assistant.settings.set": (args) => {
      const provider = z
        .enum(["claude", "codex"])
        .optional()
        .parse(args?.provider);
      const model = z
        .enum(["opus", "sonnet"])
        .optional()
        .parse(args?.claudeModel);
      if (model) claude.setModel(model);
      assistantSettings = {
        provider: provider ?? assistantSettings.provider,
        claudeModel: model ?? assistantSettings.claudeModel,
      };
      saveAssistantSettings();
      send("assistant", { type: "settings", ...assistantSettings });
      return { ...assistantSettings, claudeInstalled: !!findClaude() };
    },
    "claude.status": () => claude.status(),
    "claude.connect": () => claude.connect(),
    "claude.reconnect": () => claude.reconnect(),
    "claude.login": () => claude.login(),
    "claude.send": (args) =>
      claude.send(
        z.string().min(1).max(20000).parse(args.text),
        store.project.id,
      ),
    "claude.stop": () => claude.stop(),
    "test.import": async (args) => {
      if (!process.env.CUTLINE_QA) throw Error("Unavailable");
      const a = await media.import(args.path);
      store.commit(
        { ...store.project, assets: [...store.project.assets, a] },
        "Import test",
      );
      return a;
    },
    "test.export": (args) => {
      if (!process.env.CUTLINE_QA) throw Error("Unavailable");
      return exportVideo(args.path);
    },
    "test.load": (args) => {
      if (!process.env.CUTLINE_QA) throw Error("Unavailable");
      return store.load(args.path);
    },
  };
  ipcMain.handle("cutline", async (event, name, args) => {
    if (event.sender !== win.webContents) throw Error("Unknown window");
    const handler = handlers[name];
    if (!handler) throw Error("Unknown command");
    return handler(args);
  });
}
app.whenReady().then(async () => {
  if (!primary) return;
  sessions.register();
  store = new Store(path.join(data, "recovery.cutline"), (file) =>
    leases.claimFile(file),
  );
  library = new ProjectLibrary(
    projectsFolder,
    path.join(data, "recent-projects.json"),
  );
  store.on("save-status", (error: string | null) => {
    if (error) void warnSaveFailed(error);
  });
  if (pendingProject) await openFromFinder(pendingProject);
  // Startup opens happen before the change listener below is attached.
  sessions.updateProject(store.project);
  jobs = new Jobs((j) => send("job", j));
  media = new Media(path.join(data, "media-cache"), bin, jobs);
  // Older versions left raw audio dumps behind (about 115 MB per hour of media),
  // and preview copies of old imports pile up: keep the cache under its cap,
  // never touching what the open project uses.
  void media.cleanCache(
    Date.now(),
    store.project.assets.flatMap((asset) =>
      [asset.proxy, asset.reversed, asset.thumbnail].filter(
        (file): file is string => typeof file === "string",
      ),
    ),
  );
  musicControl = createMusicControl({ store, media, jobs, directory: data });
  speech = new Speech({
    directory: path.join(data, "speech"),
    modelDirectory: path.join(vendor, "kokoro"),
    workerPath: path.join(__dirname, "tts-worker.cjs"),
    voicesDirectory: path.join(
      app.getAppPath(),
      "node_modules",
      "kokoro-js",
      "voices",
    ),
    jobs,
  });
  stockCredentials = new StockCredentials(
    path.join(sessionContext.rootData, "stock-credentials.json"),
    safeStorage,
  );
  stock = new StockLibrary(path.join(data, "stock-media"), media, jobs, () =>
    stockCredentials.getPexels(),
  );
  generationCredentials = new GenerationCredentials(
    path.join(sessionContext.rootData, "higgsfield-credentials.json"),
    safeStorage,
  );
  generation = new GenerationLibrary(
    path.join(data, "generated-media"),
    media,
    () => generationCredentials.getKey(),
  );
  generation.start();
  app.on("before-quit", () => generation.stop());
  pictures = new HiggsfieldPictures(
    path.join(data, "generated-media", "pictures"),
    () => generationCredentials.getKey(),
  );
  loadGraphicsSettings();
  mcpLauncher = writeAgentLauncher(
    path.join(data, "agent"),
    process.execPath,
    path.join(__dirname, "mcp.cjs"),
    path.join(data, "connection.json"),
  );
  agentIO = createAgentIO({
    store,
    media,
    jobs,
    directory: data,
    library,
    preview,
    status: connectionStatus,
  });
  references = new References(path.join(data, "references"));
  agentMedia = createAgentMedia({
    store,
    media,
    jobs,
    stock,
    speech,
    autoEdit: autoEditForAgent,
    relink: (assetId, file) => relinkMedia({ store, media }, assetId, file),
    draw: async (description, style, signal) => {
      const input = GraphicGenerateSchema.parse({
        prompt: description,
        onto: `${style === "locked-split" ? "near-black" : style === "cards" ? "warm off-white" : "soft pastel"} video`,
        style: style === "cards" ? "glyph" : "flat",
        provider: assistantSettings.provider === "codex" ? "chatgpt" : "claude",
        aspect: "square",
      });
      const key = createHash("sha256")
        .update(JSON.stringify([input, assistantSettings.claudeModel]))
        .digest("hex");
      const kept = drawings.get(key);
      if (kept && (kept.kind === "svg" || existsSync(kept.file))) return kept;
      const made = await makeGraphic(input, { signal });
      const drawn =
        made.kind === "vector"
          ? { kind: "svg" as const, svg: await fitSvg(withoutBackdrop(made.svg)).catch(() => made.svg) }
          : { kind: "image" as const, file: made.file };
      drawings.set(key, drawn);
      return drawn;
    },
    graphic: (input) => makeGraphic(input),
    references: {
      logo: (query) => references.logo(query),
      inLibrary: (name) => references.inLibrary(name),
      screenshot: async (url, options) => {
        const file = references.screenshotPath(url);
        const shot = await capturePage(url, file, options);
        return { file, title: shot.title };
      },
    },
  });
  agentTasks = new AgentTasks(jobs);
  bridge = await startBridge(
    store,
    path.join(data, "connection.json"),
    externalCall,
    externalTools,
    { localCall: toolCall, localTools: tools },
  );
  base = bridge.base;
  codex = new Codex(path.join(data, "assistant"), tools, toolCall);
  codex.on("event", (e) => send("assistant", { ...e, provider: "codex" }));
  loadAssistantSettings();
  claude = new ClaudeAssistant(
    path.join(data, "assistant", "claude"),
    () => bridge.mcpUrl + "/local",
  );
  claude.model = assistantSettings.claudeModel;
  claude.on("event", (e) => send("assistant", e));
  store.on("change", (s) => {
    sessions.updateProject(s.project);
    if (win && !win.isDestroyed())
      win.setTitle(`${sessions.current().name} — ${s.project.name} — Cutline`);
    // A project with content always has a file; filing it sends its own change.
    if (library.fileIfNeeded(store)) return;
    rememberProject();
    send("state", s);
    media.ensurePreviews(s.project.assets);
    media.ensureReversed(s.project);
  });
  // Preview copies of heavy video are made in the background, so imports
  // never wait for them, and deleted ones are rebuilt.
  media.on("preview", (ready: PreviewReady) =>
    store.setPreview(ready.assetId, ready, ready.path),
  );
  media.ensurePreviews(store.project.assets);
  media.ensureReversed(store.project);
  // A project from before projects were files gets its file now.
  if (!library.fileIfNeeded(store)) rememberProject();
  register();
  // Copilot's dark glass: a native behind-window blur under a dense tint.
  // QA screenshots use an opaque backdrop so captures match what people see.
  nativeTheme.themeSource = "dark";
  const glass = process.platform === "darwin" && !process.env.CUTLINE_QA;
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    title: `${sessions.current().name} — ${store.project.name} — Cutline`,
    backgroundColor: glass ? "#00000000" : "#101013",
    ...(glass
      ? { vibrancy: "hud" as const, visualEffectState: "active" as const }
      : {}),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(process.env.CUTLINE_DEV_URL ?? "file:"))
      e.preventDefault();
  });
  session.defaultSession.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy],
      },
    });
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Cutline",
        submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
      },
      {
        label: "File",
        submenu: [
          {
            label: "New session",
            accelerator: "Alt+CmdOrCtrl+N",
            click: () => void fromMenu(() => sessions.create()),
          },
          {
            label: "Copy Codex session prompt",
            click: () => {
              copySessionPrompt();
            },
          },
          { type: "separator" },
          {
            label: "New project",
            accelerator: "CmdOrCtrl+N",
            click: () => void fromMenu(newProject),
          },
          {
            label: "Projects…",
            accelerator: "CmdOrCtrl+O",
            click: () => send("ui", { show: "projects" }),
          },
          {
            label: "Open file…",
            accelerator: "Shift+CmdOrCtrl+O",
            click: () => void fromMenu(chooseProject),
          },
          ...(process.platform === "darwin"
            ? [
                {
                  label: "Open Recent",
                  role: "recentDocuments" as const,
                  submenu: [
                    {
                      label: "Clear Menu",
                      role: "clearRecentDocuments" as const,
                    },
                  ],
                },
              ]
            : []),
          {
            label: "Open backup…",
            click: () => void fromMenu(openBackup),
          },
          { type: "separator" },
          {
            // The editor handles ⌘S itself; the menu only shows it.
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            registerAccelerator: false,
            click: () => void fromMenu(() => saveProject()),
          },
          {
            label: "Save as…",
            accelerator: "Shift+CmdOrCtrl+S",
            click: () => void fromMenu(() => saveProject(true)),
          },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "togglefullscreen" },
          ...(process.env.CUTLINE_DEV_URL
            ? [{ role: "toggleDevTools" as const }]
            : []),
        ],
      },
    ]),
  );
  if (process.env.CUTLINE_DEV_URL)
    await win.loadURL(process.env.CUTLINE_DEV_URL);
  else await win.loadFile(path.join(root, "dist/ui/index.html"));
  // Startup problems, such as an unreadable autosave that was set aside or a
  // project file that changed while this session was closed.
  if (store.notices.length && !process.env.CUTLINE_QA)
    void messageBox({
      type: "warning",
      message: "About your last autosave",
      detail: store.notices.join("\n\n"),
    });
  // Edits from last time that never reached the project file.
  if (store.saveError) void warnSaveFailed(store.saveError);
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  // Undo history is written in the background; finish it before quitting.
  store?.close();
  sessions.close();
  codex?.dispose();
  claude?.dispose();
  if (renderChild?.pid) {
    try {
      process.kill(-renderChild.pid, "SIGTERM");
    } catch {}
  }
  bridge?.close();
  for (const child of jobs?.processes.values() ?? []) child.kill();
});
