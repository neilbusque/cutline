import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AgentTimeSchema, readableSchema } from "../shared/agent-edit";
import { publicAsset } from "../shared/agent-inspect";
import {
  AutoReelOptionsSchema,
  resolveAutoReelOptions,
} from "../shared/auto-reel-options";
import { applyCommands, type Command } from "../shared/commands";
import {
  duration,
  makeClip,
  uid,
  validateProject,
  type Asset,
  type Clip,
  type Job,
  type Project,
  type Track,
} from "../shared/model";
import { SpeechInputSchema, speechVoices } from "../shared/tts";
import type { StockKind, StockProvider } from "../shared/stock";

/**
 * Stock, narration, Auto edit and relink for agents: the same work as the
 * app's buttons, without dialogs. Each tool checks the revision first and
 * lands as one undoable edit on the project as it is when the slow part
 * (download, synthesis, transcription) is done, so edits made meanwhile are
 * kept. Long work answers with a job ID through AgentTasks.
 */
const id = z.string().min(1).max(200);
const guard = { projectId: id, revision: z.number().int().min(0) };
const file = z.string().min(1).max(4096);
type Time = z.infer<typeof AgentTimeSchema>;

export const StockImportArgsSchema = z
  .strictObject({
    ...guard,
    id: z.number().int().positive(),
    provider: z.enum(["commons", "pexels"]).default("commons"),
    kind: z.enum(["video", "image"]).default("video"),
    at: AgentTimeSchema.optional(),
    duration: AgentTimeSchema.optional(),
    trackId: id.optional(),
  })
  .refine(
    (a) =>
      a.at !== undefined ||
      (a.duration === undefined && a.trackId === undefined),
    {
      message:
        "duration and trackId place the media on the timeline: give at too.",
      path: ["at"],
    },
  );
export const VoiceoverArgsSchema = z
  .strictObject({
    ...guard,
    text: SpeechInputSchema.shape.text,
    voice: SpeechInputSchema.shape.voice,
    speed: SpeechInputSchema.shape.speed,
    name: z.string().trim().min(1).max(100).optional(),
    at: AgentTimeSchema.optional(),
    trackId: id.optional(),
  })
  .refine((a) => a.at !== undefined || a.trackId === undefined, {
    message: "trackId places the narration on the timeline: give at too.",
    path: ["at"],
  });
export const AutoEditArgsSchema = z
  .strictObject({
    ...guard,
    assetId: id.optional(),
    path: file.optional(),
    options: AutoReelOptionsSchema.optional(),
  })
  .refine((a) => (a.assetId === undefined) !== (a.path === undefined), {
    message: "Give the video as assetId or path, not both.",
  });
export const RelinkArgsSchema = z.strictObject({
  ...guard,
  assetId: id,
  path: file,
});

const schemas = {
  cutline_stock_import: StockImportArgsSchema,
  cutline_voiceover: VoiceoverArgsSchema,
  cutline_auto_edit: AutoEditArgsSchema,
  cutline_relink: RelinkArgsSchema,
};
const descriptions: Record<keyof typeof schemas, string> = {
  cutline_stock_import:
    "Import stock with credits. at places muted B-roll (video up to 5s, photo 4s zoom); duration/trackId override. Undoable; may return job.",
  cutline_voiceover:
    "Generate free local Kokoro speech (af_heart, 1.08x). Omit at to import only; at adds audio. Undoable; wait on jobs. Duck music with audio.duck.",
  cutline_auto_edit:
    "Auto-edit assetId or absolute video path: speech/pause cuts/captions, optional B-roll/music. Replaces timeline, sets 1080x1920. Undoable; wait with cutline_jobs.",
  cutline_relink:
    "Relink asset/other missing folder files to absolute local path. Keeps credits; transcript/beats require matching length. Undoable.",
};
const hints: Record<
  keyof typeof schemas,
  { destructive: boolean; network: boolean }
> = {
  cutline_stock_import: { destructive: false, network: true },
  cutline_voiceover: { destructive: false, network: false },
  cutline_auto_edit: { destructive: true, network: true },
  cutline_relink: { destructive: false, network: false },
};

export const agentMediaTools: Tool[] = Object.entries(schemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof schemas],
    inputSchema: readableSchema(schema, true),
    annotations: {
      readOnlyHint: false,
      destructiveHint: hints[name as keyof typeof schemas].destructive,
      idempotentHint: false,
      openWorldHint: hints[name as keyof typeof schemas].network,
    },
  }),
);

export type AgentMediaDeps = {
  store: {
    project: Project;
    commit: (next: Project, label: string) => unknown;
  };
  media: { import: (file: string) => Promise<Asset> };
  jobs: {
    run: <T>(
      kind: string,
      message: string,
      work: (job: Job) => Promise<T>,
    ) => Promise<T>;
  };
  stock: {
    download: (
      id: number,
      provider: StockProvider,
      kind: StockKind,
    ) => Promise<Asset>;
  };
  speech: {
    status: () => Promise<{ ready: boolean; downloadMB?: number }>;
    generate: (input: unknown) => Promise<{ path: string; duration: number }>;
  };
  /** The Auto edit button's work for a given video, sharing its busy flag. */
  autoEdit: (args: {
    projectId: string;
    revision: number;
    assetId?: string;
    path?: string;
    options: z.infer<typeof AutoReelOptionsSchema>;
  }) => Promise<Record<string, unknown>>;
  relink: (
    assetId: string,
    file: string,
  ) => Promise<{ relinked: number; cleared: boolean }>;
};

const toFrame = (time: Time, fps: number) =>
  "frame" in time ? time.frame : Math.round(time.seconds * fps);

function checkTrack(project: Project, trackId: string, kind: Track["kind"]) {
  const track = project.tracks.find((item) => item.id === trackId);
  if (!track) throw Error(`Track ${trackId} is missing.`);
  if (track.kind !== kind)
    throw Error(
      `Track "${track.name}" holds ${track.kind} clips; ${kind === "video" ? "B-roll goes on a video track" : "narration goes on an audio track"}.`,
    );
  return track;
}

/**
 * Where new media goes: muted B-roll on a video track above the footage, or
 * narration on an audio track, on a free track of that role (a new one when
 * none is free), never over another clip.
 */
function placement(
  project: Project,
  asset: Asset,
  request: { at: Time; duration?: Time; trackId?: string },
  role: "broll" | "voice",
) {
  const fps = project.fps;
  const start = toFrame(request.at, fps);
  const available =
    asset.kind === "image"
      ? Infinity
      : Math.max(1, Math.floor(asset.duration * fps + 1e-7));
  const natural =
    role === "voice"
      ? available
      : asset.kind === "image"
        ? fps * 4
        : Math.min(available, fps * 5);
  const asked = request.duration
    ? Math.max(1, toFrame(request.duration, fps))
    : natural;
  const frames = Math.min(asked, available);
  const warnings: string[] = [];
  if (asked > available)
    warnings.push(
      `${asset.name} is ${(available / fps).toFixed(1)} seconds long, so it plays for that long.`,
    );
  const kind = role === "voice" ? "audio" : "video";
  const name = role === "voice" ? "Voiceover" : "B-roll";
  const free = (track: Track) =>
    !project.clips.some(
      (clip) =>
        clip.trackId === track.id &&
        clip.start < start + frames &&
        clip.start + clip.duration > start,
    );
  // A track that would not play the new clip: a muted track silences
  // narration in preview and export, and a hidden track hides B-roll.
  const silenced = (track: Track) =>
    role === "voice" ? track.muted : track.hidden;
  const commands: Command[] = [];
  let track: Track | undefined;
  if (request.trackId) {
    track = checkTrack(project, request.trackId, kind);
    if (!free(track))
      throw Error(
        `Track "${track.name}" already has a clip there. Choose another time or track, or leave trackId out.`,
      );
    if (silenced(track))
      warnings.push(
        role === "voice"
          ? `Track "${track.name}" is muted, so this narration stays silent until the track is unmuted.`
          : `Track "${track.name}" is hidden, so this B-roll stays out of view until the track is shown.`,
      );
  } else
    track = project.tracks.find(
      (item) =>
        item.kind === kind &&
        item.name === name &&
        !item.hidden &&
        !silenced(item) &&
        free(item),
    );
  if (!track) {
    if (project.tracks.length >= 64)
      throw Error("This project has 64 tracks, the most it can hold.");
    track = { id: uid(), name, kind, muted: false, hidden: false };
    commands.push({ type: "track.add", track });
  }
  const clip: Clip = {
    ...makeClip(
      project,
      asset.kind === "image" ? "image" : role === "voice" ? "audio" : "video",
      track.id,
      start,
      asset,
    ),
    duration: frames,
    ...(role === "broll"
      ? {
          volume: 0,
          cameraMotion:
            asset.kind === "image" ? ("zoom-in" as const) : ("none" as const),
        }
      : {}),
  };
  commands.push({ type: "clip.add", clip });
  return { clip, track, commands, warnings };
}

export function createAgentMedia(deps: AgentMediaDeps) {
  const { store } = deps;
  const assertRevision = (args: { projectId: string; revision: number }) => {
    if (
      args.projectId !== store.project.id ||
      args.revision !== store.project.revision
    )
      throw Error("Project changed. Inspect the project and retry.");
  };
  /** Adds the asset, places it when asked, and commits once. */
  const land = (
    asset: Asset,
    label: string,
    place?: (project: Project) => ReturnType<typeof placement>,
  ) => {
    const base = validateProject({
      ...store.project,
      assets: [...store.project.assets, asset],
    });
    const placed = place?.(base);
    const next = placed
      ? applyCommands(base, {
          projectId: base.id,
          revision: base.revision,
          label,
          commands: placed.commands,
        })
      : base;
    store.commit(next, label);
    return {
      revision: store.project.revision,
      assetId: asset.id,
      ...(placed
        ? {
            clipId: placed.clip.id,
            trackId: placed.track.id,
            startFrame: placed.clip.start,
            durationFrames: placed.clip.duration,
          }
        : {}),
      warnings: placed?.warnings ?? [],
    };
  };

  async function stockImport(raw: unknown) {
    const args = StockImportArgsSchema.parse(raw ?? {});
    assertRevision(args);
    if (args.trackId) checkTrack(store.project, args.trackId, "video");
    const projectId = store.project.id;
    const asset = await deps.stock.download(args.id, args.provider, args.kind);
    if (store.project.id !== projectId)
      throw Error(
        "A different project was opened during the download. The file stays in Cutline's stock folder; inspect the project and import it again.",
      );
    const at = args.at;
    const landed = land(
      asset,
      at ? "Agent stock B-roll" : "Agent import stock",
      at
        ? (project) =>
            placement(
              project,
              asset,
              { at, duration: args.duration, trackId: args.trackId },
              "broll",
            )
        : undefined,
    );
    return { ...landed, asset: publicAsset(asset) };
  }

  async function voiceover(raw: unknown) {
    const args = VoiceoverArgsSchema.parse(raw ?? {});
    assertRevision(args);
    if (args.trackId) checkTrack(store.project, args.trackId, "audio");
    const status = await deps.speech.status();
    if (!status.ready)
      throw Error(
        `The Kokoro voice engine is not set up on this Mac. Ask the user to open Audio, choose Text to speech and press Download Kokoro${status.downloadMB ? ` (a one-time ${status.downloadMB} MB download)` : ""}, then try again.`,
      );
    const voice = speechVoices.find((item) => item.id === args.voice)!;
    const name = args.name ?? `${voice.name} voiceover`;
    const projectId = store.project.id;
    return deps.jobs.run(
      "voiceover",
      "Creating your narration",
      async (job) => {
        const check = () => {
          if (job.state === "cancelled") throw Error("Narration cancelled");
          if (store.project.id !== projectId)
            throw Error(
              "A different project was opened while the narration was being made. The audio stays in Cutline's speech folder; inspect the project and try again.",
            );
        };
        const generated = await deps.speech.generate({
          text: args.text,
          voice: args.voice,
          speed: args.speed,
          name,
        });
        check();
        const asset = await deps.media.import(generated.path);
        check();
        asset.name = name.slice(0, 150);
        const at = args.at;
        const landed = land(
          asset,
          at ? "Agent voiceover" : "Generate narration",
          at
            ? (project) =>
                placement(
                  project,
                  asset,
                  { at, trackId: args.trackId },
                  "voice",
                )
            : undefined,
        );
        return {
          ...landed,
          name: asset.name,
          voice: args.voice,
          speed: args.speed,
          durationSeconds: Math.round(asset.duration * 100) / 100,
        };
      },
    );
  }

  async function autoEdit(raw: unknown) {
    const args = AutoEditArgsSchema.parse(raw ?? {});
    if (args.path !== undefined && !path.isAbsolute(args.path))
      throw Error(
        "Use an absolute path to a local video, or an imported assetId.",
      );
    assertRevision(args);
    const options = resolveAutoReelOptions(
      AutoReelOptionsSchema.parse(args.options ?? {}),
    );
    const before = store.project;
    const result = await deps.autoEdit({
      projectId: args.projectId,
      revision: args.revision,
      ...(args.path !== undefined
        ? { path: args.path }
        : { assetId: args.assetId }),
      options,
    });
    const after = store.project;
    const number = (key: string) =>
      typeof result[key] === "number" ? { [key]: result[key] } : {};
    return {
      revision: after.revision,
      ...(typeof result.sourceName === "string"
        ? { sourceName: result.sourceName }
        : {}),
      ...number("startFrame"),
      ...number("durationFrames"),
      ...number("targetFrames"),
      ...number("footageCount"),
      ...number("captionCount"),
      ...number("brollCount"),
      music: !!result.music,
      pace: options.pace,
      clipCount: after.clips.length,
      durationBefore: duration(before),
      durationAfter: duration(after),
      broll: Array.isArray(result.queries) ? result.queries.slice(0, 20) : [],
      warnings: Array.isArray(result.warnings)
        ? result.warnings.slice(0, 20)
        : [],
    };
  }

  async function relink(raw: unknown) {
    const args = RelinkArgsSchema.parse(raw ?? {});
    assertRevision(args);
    if (!store.project.assets.some((asset) => asset.id === args.assetId))
      throw Error(
        `Asset ${args.assetId} is missing. cutline_inspect lists the project's assets.`,
      );
    if (!path.isAbsolute(args.path))
      throw Error("Use an absolute path to the moved file.");
    if (!existsSync(args.path) || !statSync(args.path).isFile())
      throw Error("No file exists at this path.");
    const result = await deps.relink(args.assetId, args.path);
    const missing = store.project.assets.filter(
      (asset) => !existsSync(asset.path),
    );
    return {
      revision: store.project.revision,
      assetId: args.assetId,
      relinked: result.relinked,
      cleared: result.cleared,
      stillMissing: missing.slice(0, 20).map((asset) => asset.id),
      ...(result.cleared
        ? {
            note: "The new file has a different length, so its transcript and beats were cleared. Transcribe or analyze it again if you need them.",
          }
        : {}),
    };
  }

  return async (name: string, raw: unknown): Promise<unknown> => {
    switch (name) {
      case "cutline_stock_import":
        return stockImport(raw);
      case "cutline_voiceover":
        return voiceover(raw);
      case "cutline_auto_edit":
        return autoEdit(raw);
      case "cutline_relink":
        return relink(raw);
      default:
        throw Error("Unknown editing tool");
    }
  };
}
