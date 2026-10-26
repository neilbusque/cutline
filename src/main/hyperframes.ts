import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Asset, Job } from "../shared/model";
import {
  Model3DSettingsSchema,
  model3DSource,
  type Model3DMetadata,
  type Model3DSettings,
} from "../shared/model-3d";
import { prepareModel3D } from "./model-3d";
import type { Jobs, Media } from "./media";
import { sweepOrphanedBrowsers } from "./browser-sweep";

export const HYPERFRAMES_VERSION = "0.8.198";
export const HYPERFRAMES_SOURCE_LIMIT = 1_000_000;
const MAX_FILES = 2_000;
const MAX_BYTES = 256 * 1024 ** 2;
const skipDirectories = new Set([
  "node_modules",
  "renders",
  "coverage",
  "test-results",
]);
const skipFiles = new Set(["connection.json", "credentials.json"]);
const cancelled = () => Error("Cancelled");
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw cancelled();
};

export type HyperframesArgs = {
  model3d?: {
    path?: string;
    width: number;
    height: number;
    settings?: Partial<Model3DSettings>;
  };
  path?: string;
  html?: string;
  name?: string;
  fps?: number;
  transparent?: boolean;
};
export type HyperframesRequest = {
  directory: string;
  entryFile: string;
  output: string;
  fps: number;
  transparent: boolean;
  browserExecutable: string;
  ffmpeg: string;
  ffprobe: string;
};
type RenderWorker = (
  request: HyperframesRequest,
  signal: AbortSignal,
  progress: (progress: number, message: string) => void,
  job: Job,
) => Promise<void>;
export type HyperframesOptions = {
  directory: string;
  media: Pick<Media, "import">;
  jobs: Jobs;
  browserExecutable: string;
  ffmpeg: string;
  ffprobe: string;
  /** An injected renderer makes source/transaction tests download-free. */
  renderWorker?: RenderWorker;
};

/**
 * Check the declared contract before starting Chrome. Actual HTML/runtime
 * compilation is performed by HyperFrames, not by executing it in Electron.
 */
export function hyperframesDimensions(source: string) {
  if (
    !source.trim() ||
    Buffer.byteLength(source, "utf8") > HYPERFRAMES_SOURCE_LIMIT
  )
    throw Error("A scene needs HTML source smaller than 1 MB.");
  const root = source.match(
    /<[a-z][\w:-]*\b[^>]*\bdata-composition-id\s*=\s*(?:"[^"]+"|'[^']+')[^>]*>/i,
  )?.[0];
  if (!root) throw Error("The HTML needs a root with data-composition-id.");
  const value = (name: string) => {
    const match = root.match(
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^\"]+)"|'([^']+)'|([^\\s>]+))`, "i"),
    );
    return Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  };
  const width = value("data-width"),
    height = value("data-height"),
    duration = value("data-duration");
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 4096 * 2160
  )
    throw Error(
      "The scene root needs data-width and data-height between 16 and 4096 pixels, up to 4K.",
    );
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600)
    throw Error(
      "The scene root needs data-duration in seconds, greater than zero and at most 600.",
    );
  return { width, height, duration };
}

/** Copies only regular project files, never following aliases outside it. */
async function copyProject(root: string, target: string, signal?: AbortSignal) {
  const withinSource = path.relative(root, target);
  if (
    !withinSource.startsWith(`..${path.sep}`) &&
    withinSource !== ".." &&
    !path.isAbsolute(withinSource)
  )
    throw Error(
      "Keep the scene's HTML and assets in their own folder outside Cutline's scene cache.",
    );
  let files = 0,
    bytes = 0;
  const visit = async (directory: string, destination: string) => {
    check(signal);
    await mkdir(destination, { recursive: true });
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      check(signal);
      if (
        entry.name.startsWith(".") ||
        skipDirectories.has(entry.name) ||
        skipFiles.has(entry.name) ||
        /\.(?:pem|key)$/i.test(entry.name)
      )
        continue;
      const from = path.join(directory, entry.name),
        to = path.join(destination, entry.name);
      const info = await lstat(from);
      if (info.isSymbolicLink())
        throw Error(
          `Scene assets cannot be symbolic links: ${entry.name}. Copy the actual asset into the project first.`,
        );
      if (info.isDirectory()) await visit(from, to);
      else if (info.isFile()) {
        files++;
        bytes += info.size;
        if (files > MAX_FILES || bytes > MAX_BYTES)
          throw Error(
            "This scene folder is too large. Put the HTML and its assets in a dedicated folder smaller than 256 MB and 2,000 files.",
          );
        // APFS clones keep immutable versions cheap while still separating
        // their contents if either copy changes. Other filesystems copy.
        await copyFile(from, to, constants.COPYFILE_FICLONE);
      }
    }
  };
  await visit(root, target);
}

async function runtimeAssets(directory: string) {
  const require = createRequire(__filename);
  const target = path.join(directory, "cutline-runtime");
  await mkdir(target, { recursive: true });
  let gsap: string;
  try {
    gsap = require.resolve("gsap/dist/gsap.min.js");
  } catch {
    throw Error(
      "The local GSAP runtime is missing. Reinstall Cutline's dependencies or update the app.",
    );
  }
  await copyFile(gsap, path.join(target, "gsap.min.js"));
  // Three's module entry imports its sibling core. Both are kept together.
  try {
    const three = path.dirname(require.resolve("three"));
    // Newer Three releases ship readable ESM rather than *.min.js. Retain
    // the stable scene URL and its literal sibling import in either case.
    for (const part of ["module", "core"]) {
      const min = path.join(three, `three.${part}.min.js`);
      const full = path.join(three, `three.${part}.js`);
      let source: string;
      try {
        source = await readFile(min, "utf8");
      } catch {
        source = await readFile(full, "utf8");
      }
      await writeFile(path.join(target, `three.${part}.min.js`), source);
      await writeFile(path.join(target, `three.${part}.js`), source);
    }
    const addons = path.resolve(three, "../examples/jsm");
    for (const file of [
      "loaders/GLTFLoader.js",
      "utils/BufferGeometryUtils.js",
      "utils/SkeletonUtils.js",
    ]) {
      const to = path.join(target, "addons", file);
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(path.join(addons, file), to);
    }
  } catch {
    // GSAP-only projects do not require Three. A requested 3D project will
    // report its missing module during compilation instead of using a CDN.
  }
}

async function hashProject(directory: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  const visit = async (folder: string, prefix = "") => {
    for (const name of (await readdir(folder)).sort()) {
      check(signal);
      const file = path.join(folder, name),
        info = await lstat(file);
      if (info.isDirectory()) await visit(file, `${prefix}${name}/`);
      else if (info.isFile()) {
        hash.update(`${prefix}${name}\0${info.size}\0`);
        hash.update(await readFile(file));
      }
    }
  };
  await visit(directory);
  return hash.digest("hex");
}

/**
 * Source-backed scene assets use immutable source + rendered versions. Edits
 * make a new version, so the existing timeline keeps playing until success,
 * and Undo restores both its exact earlier source and its rendered pixels.
 */
export class Hyperframes {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private controllers = new Set<AbortController>();
  /** Only completed versions awaiting their caller's project transaction. */
  private pending = new Map<string, { root: string; entry: string }>();
  constructor(private options: HyperframesOptions) {}

  /** A committed version belongs to the project and its Undo history forever. */
  accept(asset: Asset) {
    const pending = this.pending.get(asset.path);
    if (pending?.entry === asset.composition?.entry)
      this.pending.delete(asset.path);
  }

  /**
   * A render can finish after its caller's revision changed. Only that newly
   * rendered, unapplied version may be removed. Loaded, accepted and earlier
   * Undo versions were never pending here and cannot enter this path.
   */
  async discard(asset: Asset): Promise<void> {
    const pending = this.pending.get(asset.path);
    if (!pending || pending.entry !== asset.composition?.entry) return;
    const root = path.resolve(pending.root);
    if (
      path.dirname(root) !== path.resolve(this.options.directory) ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
        path.basename(root),
      ) ||
      path.dirname(path.resolve(asset.path)) !== root ||
      path.dirname(path.resolve(pending.entry)) !== path.join(root, "source")
    )
      return;
    await rm(root, { recursive: true, force: true });
    this.pending.delete(asset.path);
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }

  render(args: HyperframesArgs, previous?: Asset): Promise<Asset> {
    if (this.closed)
      return Promise.reject(Error("The scene renderer is closed."));
    let produced: Asset | undefined;
    return this.options.jobs
      .run(
        "hyperframes",
        previous ? "Updating scene" : "Rendering scene",
        async (job) => {
          const controller = new AbortController();
          this.controllers.add(controller);
          const unwatch = this.options.jobs.whenCancelled(() =>
            controller.abort(),
          );
          const work = this.queue
            .catch(() => {})
            .then(() => this.renderOne(args, previous, job, controller.signal));
          this.queue = work.catch(() => {});
          try {
            produced = await work;
            this.options.jobs.assertActive();
            return produced;
          } finally {
            unwatch();
            this.controllers.delete(controller);
          }
        },
      )
      .catch(async (error) => {
        if (produced) await this.discard(produced).catch(() => {});
        throw error;
      });
  }

  private async renderOne(
    args: HyperframesArgs,
    previous: Asset | undefined,
    job: Job,
    signal: AbortSignal,
  ): Promise<Asset> {
    check(signal);
    this.options.jobs.assertActive();
    if (
      previous?.composition?.model3d &&
      !args.model3d &&
      !args.path &&
      args.html === undefined
    ) {
      const canvas = hyperframesDimensions(previous.composition.source);
      args = {
        ...args,
        model3d: { width: canvas.width, height: canvas.height },
      };
    }
    if (args.path && args.html !== undefined)
      throw Error("Choose a scene file or HTML source, not both.");
    if (args.model3d && (args.path || args.html !== undefined))
      throw Error("Choose a 3D model or HTML scene source, not both.");
    const fps = args.fps ?? previous?.fps ?? 30;
    if (![24, 25, 30, 60].includes(fps))
      throw Error("Choose 24, 25, 30 or 60 frames per second.");
    let source = "",
      sourceRoot: string | undefined,
      entryFile = "index.html";
    let model3d: Model3DMetadata | undefined;
    if (args.model3d) {
      if (!args.model3d.path && !previous?.composition?.model3d)
        throw Error("Choose a local GLB or glTF model to import.");
    } else if (args.path) {
      if (!path.isAbsolute(args.path))
        throw Error("Choose an absolute local HTML file or project folder.");
      let file = args.path;
      const selected = await lstat(file);
      if (selected.isSymbolicLink())
        throw Error(
          "Choose the actual scene file, rather than a symbolic link.",
        );
      if (selected.isDirectory()) file = path.join(file, "index.html");
      if (!/\.html?$/i.test(file) || !(await lstat(file)).isFile())
        throw Error("Choose an HTML scene or a folder containing index.html.");
      if ((await lstat(file)).size > HYPERFRAMES_SOURCE_LIMIT)
        throw Error("A scene needs HTML source smaller than 1 MB.");
      source = await readFile(file, "utf8");
      sourceRoot = path.dirname(file);
      entryFile = path.basename(file);
    } else {
      source = args.html ?? previous?.composition?.source ?? "";
      if (previous?.composition) {
        sourceRoot = path.dirname(previous.composition.entry);
        entryFile = path.basename(previous.composition.entry);
      }
    }
    if (!args.model3d) hyperframesDimensions(source);
    const transparent =
      args.transparent ?? previous?.composition?.transparent ?? false;
    const versionRoot = path.join(this.options.directory, randomUUID());
    const directory = path.join(versionRoot, "source"),
      output = path.join(versionRoot, `scene.${transparent ? "webm" : "mp4"}`);
    await mkdir(directory, { recursive: true });
    try {
      if (args.model3d) {
        const retained = previous?.composition?.model3d;
        const file =
          args.model3d.path ??
          path.join(path.dirname(previous!.composition!.entry), retained!.file);
        const prepared = await prepareModel3D(file, directory, signal);
        const settings = Model3DSettingsSchema.parse({
          ...retained?.settings,
          ...args.model3d.settings,
        });
        if (
          settings.animationIndex >= prepared.animations.length &&
          prepared.animations.length > 0
        )
          throw Error(
            "Choose an available embedded animation, or choose None.",
          );
        model3d = { ...prepared, settings };
        source = model3DSource(
          model3d,
          { width: args.model3d.width, height: args.model3d.height, fps },
          transparent,
        );
        hyperframesDimensions(source);
      } else if (sourceRoot) {
        // A missing managed source folder can still recover self-contained
        // source from the project; an explicit imported folder must exist.
        try {
          await copyProject(sourceRoot, directory, signal);
        } catch (error) {
          if (args.path || (error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
        }
      }
      check(signal);
      await writeFile(path.join(directory, entryFile), source, { flag: "w" });
      await runtimeAssets(directory);
      const sourceHash = await hashProject(directory, signal);
      const request: HyperframesRequest = {
        directory,
        entryFile,
        output,
        fps,
        transparent,
        browserExecutable: this.options.browserExecutable,
        ffmpeg: this.options.ffmpeg,
        ffprobe: this.options.ffprobe,
      };
      const render = this.options.renderWorker ?? this.renderWorker.bind(this);
      await render(
        request,
        signal,
        (progress, message) => {
          check(signal);
          this.options.jobs.update(job, {
            progress: Math.min(0.95, Math.max(0, progress) * 0.95),
            message,
          });
        },
        job,
      );
      check(signal);
      this.options.jobs.assertActive();
      // Give each version a distinct thumbnail path. Reusing the old asset id
      // during import would overwrite an earlier version's Undo thumbnail.
      const asset = await this.options.media.import(output);
      check(signal);
      this.options.jobs.assertActive();
      if (asset.kind !== "video")
        throw Error("The scene did not produce a video.");
      const rendered: Asset = {
        ...asset,
        id: previous?.id ?? asset.id,
        name:
          args.name?.trim().slice(0, 100) ||
          previous?.name ||
          (args.model3d?.path
            ? path.basename(args.model3d.path, path.extname(args.model3d.path))
            : args.path
              ? path.basename(args.path, path.extname(args.path))
              : "HTML scene"),
        fps,
        composition: {
          engine: "hyperframes",
          entry: path.join(directory, entryFile),
          source,
          sourceHash,
          engineVersion: HYPERFRAMES_VERSION,
          transparent,
          ...(model3d
            ? { model3d }
            : args.html === undefined && previous?.composition?.model3d
              ? { model3d: previous.composition.model3d }
              : {}),
        },
      };
      this.pending.set(rendered.path, {
        root: versionRoot,
        entry: rendered.composition!.entry,
      });
      return rendered;
    } catch (error) {
      await rm(versionRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private renderWorker(
    request: HyperframesRequest,
    signal: AbortSignal,
    progress: (value: number, message: string) => void,
    job: Job,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      check(signal);
      const child = fork(path.join(__dirname, "hyperframes-worker.cjs"), [], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PUPPETEER_SKIP_DOWNLOAD: "true",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        detached: true,
      });
      this.options.jobs.processes.set(job.id, child);
      let stderr = "",
        error: Error | undefined,
        done = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (child.connected) child.send({ type: "cancel" }, () => {});
        if (!killTimer) {
          killTimer = setTimeout(() => stopProcessTree(child), 10_000);
          killTimer.unref();
        }
      };
      const timeout = setTimeout(() => {
        error = Error(
          "The scene render timed out. Shorten the scene or simplify its effects, then try again.",
        );
        stop();
      }, 20 * 60_000);
      timeout.unref();
      signal.addEventListener("abort", stop, { once: true });
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4_000);
      });
      child.on("message", (message: any) => {
        if (message?.type === "progress" && !signal.aborted)
          progress(
            Number(message.progress) || 0,
            String(message.message || "Rendering scene").slice(0, 180),
          );
        if (message?.type === "done") done = true;
        if (message?.type === "error")
          error = Error(String(message.message).slice(0, 2_000));
      });
      child.once("error", (failure) => {
        error = failure;
        // A spawn failure emits no exit event.
        if (!child.pid) {
          clearTimeout(timeout);
          signal.removeEventListener("abort", stop);
          this.options.jobs.processes.delete(job.id);
          reject(failure);
        }
      });
      // Wait for process exit, not merely its last message: the next queued
      // scene must not overlap Chrome left closing from the previous one.
      child.once("exit", async (code) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", stop);
        this.options.jobs.processes.delete(job.id);
        if (signal.aborted || error || !done || code !== 0) {
          // Chrome owns a separate process group. A crashed worker can leave
          // it adopted by launchd; sweep only those orphans in our reviewed
          // browser distribution, never another session's working browser.
          const appEnd = request.browserExecutable.lastIndexOf(
            ".app/Contents/MacOS/",
          );
          if (appEnd >= 0)
            await sweepOrphanedBrowsers(
              request.browserExecutable.slice(0, appEnd + 4),
            ).catch(() => []);
        }
        if (signal.aborted) reject(cancelled());
        else if (error) reject(error);
        else if (!done || code !== 0)
          reject(
            Error(
              stderr.trim() || "The scene renderer stopped before finishing.",
            ),
          );
        else resolve();
      });
      child.send({ type: "render", ...request }, (failure) => {
        if (!failure) return;
        error = failure;
        stop();
      });
      if (signal.aborted) stop();
    });
  }
}

function stopProcessTree(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
