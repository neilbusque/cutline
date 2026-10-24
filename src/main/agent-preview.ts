import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { duration, type Project } from "../shared/model";

/** Most frames one preview call renders. */
export const MAX_PREVIEW_FRAMES = 12;
/** About what an assistant sees in one image (Claude scales larger images down). */
const SHEET_PIXELS = 1_100_000;

export type PreviewRequest = {
  frame?: number;
  seconds?: number;
  frames?: number[];
  count?: number;
  fromFrame?: number;
  toFrame?: number;
  clipId?: string;
  width?: number;
};

export function timecode(frame: number, fps: number) {
  const seconds = frame / fps,
    minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, "0")}`;
}

/** Requests that sample several frames never need the editor's playhead. */
export const samplesFrames = (args: PreviewRequest) =>
  !!args.frames?.length ||
  args.count !== undefined ||
  args.fromFrame !== undefined ||
  args.toFrame !== undefined;

/**
 * Timeline frames a preview shows: the listed frames, evenly spaced samples of
 * a range (a clip's span when clipId is given), or one frame: the requested
 * one, else the playhead, else the middle of the clip when the playhead is
 * outside it.
 */
export function previewFrames(
  project: Project,
  args: PreviewRequest,
  playhead?: number,
) {
  const last = duration(project) - 1;
  const clamp = (frame: number) =>
    Math.max(0, Math.min(last, Math.round(frame)));
  if (args.frames?.length)
    return [...new Set(args.frames.map(clamp))].slice(0, MAX_PREVIEW_FRAMES);
  const clip = args.clipId
    ? project.clips.find((item) => item.id === args.clipId)
    : undefined;
  if (args.clipId && !clip) throw Error(`Clip ${args.clipId} is missing.`);
  if (samplesFrames(args)) {
    const from = args.fromFrame ?? clip?.start ?? 0;
    const end = Math.min(
      last,
      (args.toFrame ?? (clip ? clip.start + clip.duration : last + 1)) - 1,
    );
    if (end < from)
      throw Error("Choose a frame range that ends after it starts.");
    const count = Math.min(args.count ?? 6, MAX_PREVIEW_FRAMES, end - from + 1);
    if (count === 1) return [clamp((from + end) / 2)];
    return [
      ...new Set(
        Array.from({ length: count }, (_, index) =>
          clamp(from + ((end - from) * index) / (count - 1)),
        ),
      ),
    ];
  }
  const requested =
    args.frame ??
    (args.seconds !== undefined
      ? Math.round(args.seconds * project.fps)
      : undefined);
  if (requested !== undefined) return [clamp(requested)];
  if (
    clip &&
    (playhead === undefined ||
      playhead < clip.start ||
      playhead >= clip.start + clip.duration)
  )
    return [clamp(clip.start + Math.floor(clip.duration / 2))];
  return [clamp(playhead ?? 0)];
}

/** Rendered size of each frame: 1280 on the long edge alone, smaller when several share a sheet. */
export function previewSize(project: Project, count: number, width?: number) {
  const ratio = project.width / project.height;
  const target =
    width ??
    (count === 1
      ? ratio >= 1
        ? 1280
        : 1280 * ratio
      : Math.sqrt((SHEET_PIXELS / count) * ratio));
  const scale = Math.min(1, Math.max(160, Math.round(target)) / project.width);
  return {
    scale,
    width: Math.round(project.width * scale),
    height: Math.round(project.height * scale),
  };
}

/**
 * Columns that keep a sheet close to square with the fewest empty tiles. A
 * sheet longer than 2:1 (seven wide frames in one column) is used only when
 * no other layout avoids it.
 */
export function sheetColumns(count: number, width: number, height: number) {
  const ideal = Math.sqrt((count * height) / width);
  const options = [Math.floor(ideal), Math.ceil(ideal), Math.round(ideal) + 1]
    .map((columns) => Math.max(1, Math.min(count, columns)))
    .map((columns) => {
      const rows = Math.ceil(count / columns);
      return {
        columns,
        stretched:
          Math.abs(Math.log((columns * width) / (rows * height))) >
          Math.log(2) + 1e-9,
        empty: rows * columns - count,
        distance: Math.abs(columns - ideal),
      };
    });
  options.sort(
    (a, b) =>
      Number(a.stretched) - Number(b.stretched) ||
      a.empty - b.empty ||
      a.distance - b.distance,
  );
  return options[0].columns;
}
/** Longest side of a contact sheet. Claude refuses larger images once a conversation holds many. */
export const SHEET_MAX_SIDE = 2000;
const GUTTER = 8;

/** Frame size and grid of a contact sheet, kept within SHEET_MAX_SIDE a side. */
export function sheetLayout(project: Project, count: number, width?: number) {
  let size = previewSize(project, count, width);
  const columns = sheetColumns(count, size.width, size.height),
    rows = Math.ceil(count / columns);
  // A requested width can make the sheet too large; one spare pixel per tile
  // covers rounding of the smaller frame.
  const fit = Math.min(
    (SHEET_MAX_SIDE - columns * (GUTTER + 1)) / (columns * size.width),
    (SHEET_MAX_SIDE - rows * (GUTTER + 1)) / (rows * size.height),
  );
  if (fit < 1) size = previewSize(project, count, Math.floor(size.width * fit));
  return {
    ...size,
    columns,
    rows,
    sheetWidth: columns * (size.width + GUTTER),
    sheetHeight: rows * (size.height + GUTTER),
  };
}

const fonts = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/SFNS.ttf",
];
/** Paths that need no escaping inside an ffmpeg filter graph. */
const plainPath = (file: string) => /^[A-Za-z0-9/._-]+$/.test(file);

function run(binary: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => (stderr = (stderr + data).slice(-2000)));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error(stderr.trim() || `ffmpeg exited ${code}`)),
    );
  });
}

/**
 * Tiles same-size JPEG frames into one contact sheet, left to right then top to
 * bottom, each labeled with its number and timecode when a system font exists.
 */
export async function contactSheet(options: {
  ffmpeg: string;
  files: string[];
  labels: string[];
  width: number;
  height: number;
  output: string;
  font?: string | null;
  columns?: number;
}) {
  const { files, width, height } = options;
  const columns = options.columns ?? sheetColumns(files.length, width, height);
  const rows = Math.ceil(files.length / columns);
  const directory = path.dirname(options.output);
  const font =
    options.font === null
      ? undefined
      : (options.font ?? fonts.find((file) => existsSync(file)));
  const labelled = !!font && plainPath(font) && plainPath(directory);
  const inputs: string[] = [];
  const filters: string[] = [];
  const gutter = GUTTER,
    background = "0x16161a";
  for (let index = 0; index < columns * rows; index++) {
    if (index < files.length) inputs.push("-i", files[index]);
    else
      inputs.push(
        "-f",
        "lavfi",
        "-i",
        `color=c=${background}:s=${width}x${height}:d=1`,
      );
    let chain = `[${index}:v]scale=${width}:${height},setsar=1`;
    if (labelled && index < files.length) {
      const file = path.join(directory, `label-${index}.txt`);
      await writeFile(file, options.labels[index] ?? String(index + 1));
      chain += `,drawtext=fontfile=${font}:textfile=${file}:x=10:y=10:fontsize=${Math.max(13, Math.round(height / 26))}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;
    }
    filters.push(
      `${chain},pad=${width + gutter}:${height + gutter}:${gutter / 2}:${gutter / 2}:color=${background}[t${index}]`,
    );
  }
  const rowLabels: string[] = [];
  for (let row = 0; row < rows; row++) {
    const tiles = Array.from(
      { length: columns },
      (_, column) => `[t${row * columns + column}]`,
    ).join("");
    if (columns === 1) filters.push(`${tiles}null[r${row}]`);
    else filters.push(`${tiles}hstack=inputs=${columns}[r${row}]`);
    rowLabels.push(`[r${row}]`);
  }
  if (rows === 1) filters.push(`${rowLabels[0]}null[sheet]`);
  else filters.push(`${rowLabels.join("")}vstack=inputs=${rows}[sheet]`);
  await run(options.ffmpeg, [
    "-y",
    "-v",
    "error",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[sheet]",
    "-frames:v",
    "1",
    "-q:v",
    "3",
    options.output,
  ]);
  return {
    columns,
    rows,
    width: columns * (width + gutter),
    height: rows * (height + gutter),
    labelled,
  };
}

/**
 * Renders frames offscreen with Remotion in a worker process, from the same
 * composition and media as the MP4 export, so the images show no selection
 * outlines, guides or other editor overlays. One worker and its browser stay
 * open between previews, so each preview costs no process or Chrome start;
 * it closes after a quiet minute, and a stuck one is stopped and replaced.
 */
export class StillWorker {
  private child?: ChildProcess;
  private stderr = "";
  private next = 0;
  private idle?: NodeJS.Timeout;
  private requests = new Map<
    string,
    {
      child: ChildProcess;
      resolve: (files: string[]) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private options: {
      workerPath: string;
      /** How long a preview may take before its worker is replaced. */
      timeoutMs?: number;
      /** Quiet time after which the worker and its browser close. */
      idleMs?: number;
      start?: (workerPath: string) => ChildProcess;
      /** Runs after a worker exits, such as a sweep for Chrome it left. */
      exited?: () => void;
    },
  ) {}
  render(request: {
    serveUrl: string;
    browserExecutable: string;
    inputProps: Record<string, unknown>;
    frames: number[];
    scale: number;
    directory: string;
  }) {
    clearTimeout(this.idle);
    const child = this.worker();
    const id = String(++this.next);
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(
          id,
          Error("Rendering the preview took too long. Try fewer frames."),
        );
        // A stuck renderer is not trusted with the next preview.
        this.stop(child);
      }, this.options.timeoutMs ?? 90_000);
      this.requests.set(id, { child, resolve, reject, timer });
      child.send(
        {
          type: "render",
          id,
          serveUrl: request.serveUrl,
          browserExecutable: request.browserExecutable,
          inputProps: request.inputProps,
          frames: request.frames,
          scale: request.scale,
          outputDirectory: request.directory,
        },
        (error) => error && this.finish(id, error),
      );
    });
  }
  /** Closes the worker and its browser, as on quit. */
  close() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    // The worker closes Chrome and exits when its connection ends.
    if (child.connected) child.disconnect();
    else this.stop(child);
  }
  private worker() {
    const running = this.child;
    if (running && running.connected && running.exitCode === null)
      return running;
    const child =
      this.options.start?.(this.options.workerPath) ??
      fork(this.options.workerPath, [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        detached: true,
      });
    this.child = child;
    this.stderr = "";
    child.stderr?.on(
      "data",
      (data) => (this.stderr = (this.stderr + data).slice(-2000)),
    );
    child.on("message", (message: any) => {
      if (message?.type === "done") this.finish(message.id, message.files);
      if (message?.type === "error")
        this.finish(message.id, Error(message.message));
    });
    const gone = (error?: Error) => {
      if (this.child === child) this.child = undefined;
      for (const [id, request] of this.requests)
        if (request.child === child)
          this.finish(
            id,
            error ??
              Error(this.stderr.trim() || "The preview renderer stopped."),
          );
    };
    child.on("error", gone);
    child.on("exit", () => {
      gone();
      this.options.exited?.();
    });
    return child;
  }
  private finish(id: string, result: string[] | Error) {
    const request = this.requests.get(id);
    if (!request) return;
    this.requests.delete(id);
    clearTimeout(request.timer);
    if (result instanceof Error) request.reject(result);
    else request.resolve(result);
    if (this.requests.size) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.options.idleMs ?? 60_000);
    this.idle.unref?.();
  }
  private stop(child: ChildProcess) {
    if (this.child === child) this.child = undefined;
    if (child.exitCode !== null || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

export type RenderedPreview = {
  info: Record<string, unknown>;
  images: { label: string; data: string }[];
};

/** Renders the requested frames and returns them as one image, or a sheet, or separate images. */
export async function renderPreview(options: {
  project: Project;
  frames: number[];
  width?: number;
  layout?: "sheet" | "separate";
  ffmpeg: string;
  render: (
    frames: number[],
    scale: number,
    directory: string,
  ) => Promise<string[]>;
}) {
  const { project, frames } = options;
  const separate = options.layout === "separate" && frames.length > 1;
  const layout =
    !separate && frames.length > 1
      ? sheetLayout(project, frames.length, options.width)
      : undefined;
  const size =
    layout ?? previewSize(project, separate ? 1 : frames.length, options.width);
  const directory = await mkdtemp(path.join(os.tmpdir(), "cutline-preview-"));
  try {
    const files = await options.render(frames, size.scale, directory);
    const listed = frames.map((frame, index) => ({
      index: index + 1,
      frame,
      time: timecode(frame, project.fps),
    }));
    const label = (item: (typeof listed)[number]) =>
      `${item.index}  ${item.time}  frame ${item.frame}`;
    const info: Record<string, unknown> = {
      revision: project.revision,
      renderer: "export",
      frames: listed,
      frameWidth: size.width,
      frameHeight: size.height,
    };
    if (frames.length === 1 || separate) {
      info.layout = frames.length === 1 ? "single" : "separate";
      const images = await Promise.all(
        files.map(async (file, index) => ({
          label: label(listed[index]),
          data: (await readFile(file)).toString("base64"),
        })),
      );
      return { info, images } satisfies RenderedPreview;
    }
    const output = path.join(directory, "sheet.jpg");
    const sheet = await contactSheet({
      ffmpeg: options.ffmpeg,
      files,
      labels: listed.map(label),
      width: size.width,
      height: size.height,
      columns: layout?.columns,
      output,
    });
    Object.assign(info, {
      layout: "sheet",
      columns: sheet.columns,
      rows: sheet.rows,
      order:
        "Tiles run left to right, then top to bottom, numbered as in frames.",
    });
    return {
      info,
      images: [
        {
          label: "Contact sheet",
          data: (await readFile(output)).toString("base64"),
        },
      ],
    } satisfies RenderedPreview;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** MCP content: the preview facts as text, then the image(s), each labeled when separate. */
export function previewContent(
  info: Record<string, unknown>,
  images: { label: string; data: string }[],
) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(info) },
      ...images.flatMap((image) => [
        ...(images.length > 1
          ? [{ type: "text" as const, text: image.label }]
          : []),
        { type: "image" as const, data: image.data, mimeType: "image/jpeg" },
      ]),
    ],
    structuredContent: info,
  };
}
