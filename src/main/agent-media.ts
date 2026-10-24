import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AgentTimeSchema,
  agentFrame,
  readableSchema,
} from "../shared/agent-edit";
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
import type { BrandLogo } from "./vector-studio";
import { parseEditableSvg } from "../shared/vector-path";
import { createVectorScene } from "../shared/vector-scenes";
import {
  buildStyleReel,
  type StyleBeat,
  type StyleReelStyle,
} from "../shared/style-reel";
import {
  GraphicGenerateSchema,
  placePicture,
  type GraphicGenerateInput,
  type GraphicResult,
} from "../shared/graphics";

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
export const ReferenceArgsSchema = z.strictObject({
  ...guard,
  kind: z.enum(["logo", "screenshot"]),
  /** Product name or website for a logo; page address for a screenshot. */
  target: z.string().trim().min(1).max(2000),
  phone: z.boolean().optional(),
  selector: z.string().max(300).optional(),
  color: z.enum(["brand", "white", "black"]).optional(),
  at: AgentTimeSchema.optional(),
});
export const StyleReelArgsSchema = z.strictObject({
  ...guard,
  style: z.enum(["split", "cards", "locked-split"]),
  beats: z
    .array(
      z.strictObject({
        from: z.number().min(0),
        to: z.number().min(0),
        layout: z.enum(["split", "full", "face", "speaker"]).optional(),
        kind: z.enum(["logo", "page", "asset", "text", "draw"]).optional(),
        show: z.string().trim().min(1).max(2000).optional(),
        selector: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(80),
});
export const GraphicArgsSchema = z.strictObject({
  ...guard,
  ...GraphicGenerateSchema.pick({
    prompt: true,
    style: true,
    aspect: true,
    palette: true,
    route: true,
  }).partial({ style: true, aspect: true, route: true }).shape,
  at: AgentTimeSchema.optional(),
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
  cutline_reference: ReferenceArgsSchema,
  cutline_style_reel: StyleReelArgsSchema,
  cutline_graphic: GraphicArgsSchema,
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
  cutline_reference:
    "Show what the script names: kind logo (target=product or domain) or screenshot (target=url, selector, phone view). at places it; omit at to check, changing nothing.",
  cutline_style_reel:
    "Lay out a creator-style Short on the speaker video from timed beats; show = logo name, page url, assetId, text, or a drawing to make.",
  cutline_graphic:
    "Make an original graphic from a sentence: an editable vector drawn and checked by Claude or ChatGPT, or a cut-out Higgsfield picture when too detailed (if allowed). at places it.",
};
const hints: Record<
  keyof typeof schemas,
  { destructive: boolean; network: boolean }
> = {
  cutline_stock_import: { destructive: false, network: true },
  cutline_voiceover: { destructive: false, network: false },
  cutline_auto_edit: { destructive: true, network: true },
  cutline_relink: { destructive: false, network: false },
  cutline_reference: { destructive: false, network: true },
  cutline_style_reel: { destructive: true, network: true },
  cutline_graphic: { destructive: false, network: true },
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
    update?: (job: Job, patch: Partial<Job>) => void;
    cancellers?: Map<string, () => void>;
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
  /**
   * An original illustration for an idea: a vector drawn by the signed-in
   * assistant, or a cut-out picture file when the idea is too detailed.
   */
  draw?: (
    description: string,
    style: StyleReelStyle,
    signal?: AbortSignal,
  ) => Promise<{ kind: "svg"; svg: string } | { kind: "image"; file: string }>;
  /** cutline_graphic's work: the same route as Motion > Vectors > Generate. */
  graphic?: (input: GraphicGenerateInput) => Promise<GraphicResult>;
  references?: {
    logo: (query: { name?: string; domain?: string }) => Promise<BrandLogo>;
    /** Whether the logo library has this exact product name. */
    inLibrary?: (name: string) => Promise<boolean>;
    screenshot: (
      url: string,
      options: { device: "desktop" | "phone"; selector?: string },
    ) => Promise<{ file: string; title: string }>;
  };
};

const toFrame = agentFrame;

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

/**
 * A reference shown as a card: centered, rounded, with a soft shadow, sized to
 * the image so nothing is cropped, and kept above the caption zone on tall frames.
 */
export function referenceCard(
  project: Project,
  asset: Asset,
  request: { at: Time; duration?: Time },
  kind: "logo" | "screenshot",
  size?: number,
) {
  const fps = project.fps;
  const placed = placement(
    project,
    asset,
    { at: request.at, duration: request.duration ?? { frame: fps * 3 } },
    "broll",
  );
  const W = project.width,
    H = project.height;
  const aspect = (asset.width ?? 16) / (asset.height ?? 10);
  const tall = H > W;
  const maxW = W * (size ?? (kind === "logo" ? 0.3 : 0.86));
  const maxH = H * (kind === "logo" ? 0.3 : tall ? 0.58 : 0.8);
  const width = Math.min(maxW, maxH * aspect),
    height = width / aspect;
  const centerY = tall ? H * 0.4 : H / 2;
  const clip = {
    ...placed.clip,
    x: (W - width) / 2,
    y: centerY - height / 2,
    width,
    height,
    fit: "cover" as const,
    cameraMotion: "none" as const,
    fadeIn: Math.round(fps * 0.2),
    fadeOut: Math.round(fps * 0.2),
    // Screenshots float as cards; a bitmap logo is an app icon, so it gets
    // the rounded corners an icon has.
    ...(kind === "screenshot"
      ? {
          mask: "rounded" as const,
          cornerRadius: Math.round(Math.min(W, H) * 0.025),
          shadowBlur: 60,
          shadowY: 24,
          shadowColor: "#00000066",
        }
      : {
          mask: "rounded" as const,
          cornerRadius: Math.round(width * 0.22),
        }),
  };
  return {
    ...placed,
    clip,
    commands: placed.commands.map((command) =>
      command.type === "clip.add" ? { ...command, clip } : command,
    ),
  };
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
    place?: (project: Project) => {
      clip: Clip;
      track: Track;
      commands: Command[];
      warnings?: string[];
    },
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

  /** A logo found by name alone may be another company with that name. */
  const nameOnly = (logo: BrandLogo) =>
    logo.matchedBy === "name"
      ? [
          `Matched by name only (${logo.source}). Give its website if that is the wrong company.`,
        ]
      : [];

  async function reference(raw: unknown) {
    const args = ReferenceArgsSchema.parse(raw ?? {});
    assertRevision(args);
    if (!deps.references) throw Error("References are not available here.");
    const projectId = store.project.id;
    const stillOpen = () => {
      if (store.project.id !== projectId)
        throw Error(
          "A different project was opened meanwhile. Inspect it and try again.",
        );
    };
    if (args.kind === "logo") {
      // "Node.js" and "Next.js" are library names, not web addresses.
      const site =
        /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/iu.test(args.target) &&
        !(await deps.references.inLibrary?.(args.target));
      const at = args.at;
      let logo: BrandLogo;
      try {
        logo = await deps.references.logo(
          site
            ? { domain: args.target.replace(/^https?:\/\//u, "").split("/")[0] }
            : { name: args.target },
        );
      } catch (error) {
        // A check answers that there is no logo instead of failing.
        if (at === undefined)
          return {
            revision: store.project.revision,
            found: false,
            note: (error as Error).message,
          };
        throw error;
      }
      stillOpen();
      // Without at this is a check: what would be shown, and nothing changes.
      if (at === undefined)
        return {
          revision: store.project.revision,
          found: true,
          kind: logo.kind,
          title: logo.title,
          source: logo.source,
          warnings: nameOnly(logo),
        };
      if (logo.kind === "vector") {
        const color =
          args.color === "white"
            ? "#ffffff"
            : args.color === "black"
              ? "#000000"
              : logo.color;
        // Library marks carry no fill of their own; a site's SVG keeps its colors.
        const svg =
          color && !/\bfill=/u.test(logo.svg)
            ? logo.svg.replace(/<svg\b/u, `<svg fill="${color}"`)
            : logo.svg;
        const parsed = parseEditableSvg(svg);
        const side = Math.min(store.project.width, store.project.height) * 0.3;
        const aspect = parsed.width / parsed.height;
        const created = createVectorScene(
          store.project,
          toFrame(at, store.project.fps),
          parsed,
          {
            name: `${logo.title} logo`,
            ...(aspect >= 1 ? { width: side } : { height: side }),
          },
        );
        // Tall frames: lift the mark above the captions, like a card.
        if (store.project.height > store.project.width)
          for (const layer of created.motion.layers)
            layer.y = store.project.height * 0.4 - layer.height / 2;
        created.clip.duration = store.project.fps * 3;
        const next = applyCommands(store.project, {
          projectId: store.project.id,
          revision: store.project.revision,
          label: `Add ${logo.title} logo`,
          commands: created.commands,
        });
        store.commit(next, `Add ${logo.title} logo`);
        return {
          revision: store.project.revision,
          kind: "vector",
          clipId: created.clip.id,
          motionId: created.motion.id,
          title: logo.title,
          source: logo.source,
          warnings: [...(parsed.warnings ?? []), ...nameOnly(logo)],
        };
      }
      const asset = await deps.media.import(logo.file);
      stillOpen();
      asset.name = `${logo.title} logo`;
      const landed = land(asset, `Add ${logo.title} logo`, (project) =>
        referenceCard(project, asset, { at }, "logo"),
      );
      return {
        ...landed,
        warnings: [...landed.warnings, ...nameOnly(logo)],
        kind: "image",
        title: logo.title,
        source: logo.source,
      };
    }
    const shot = await deps.jobs.run("reference", "Capturing the page", () =>
      deps.references!.screenshot(args.target, {
        device: args.phone ? "phone" : "desktop",
        selector: args.selector,
      }),
    );
    stillOpen();
    const at = args.at;
    // A check: the page loads and this is what it shows. Its file can still
    // be imported with cutline_import_media.
    if (at === undefined)
      return {
        revision: store.project.revision,
        found: true,
        kind: "screenshot",
        title: shot.title,
        file: shot.file,
      };
    const asset = await deps.media.import(shot.file);
    stillOpen();
    asset.name = shot.title.slice(0, 150);
    const landed = land(asset, "Add page screenshot", (project) =>
      referenceCard(project, asset, { at }, "screenshot"),
    );
    return {
      ...landed,
      kind: "screenshot",
      title: shot.title,
      file: shot.file,
    };
  }

  async function styleReel(raw: unknown) {
    const args = StyleReelArgsSchema.parse(raw ?? {});
    assertRevision(args);
    const projectId = store.project.id;
    const stillOpen = () => {
      if (store.project.id !== projectId)
        throw Error(
          "A different project was opened meanwhile. Inspect it and try again.",
        );
    };
    const warnings: string[] = [];
    const imported: Asset[] = [];
    const beats: StyleBeat[] = [];
    // Drawings take 15 to 30 seconds each, so three are made at a time
    // before the beats are laid out.
    const drawings = new Map<
      number,
      ReturnType<NonNullable<AgentMediaDeps["draw"]>>
    >();
    const queue = args.beats
      .map((beat, index) => ({ beat, index }))
      .filter(({ beat }) => beat.kind === "draw" && beat.show);
    if (queue.length && !deps.draw)
      throw Error("Drawing needs Claude or ChatGPT signed in on this Mac.");
    // One cancellable job for every drawing: cancelling it stops the
    // assistants and the Short is never laid out.
    const stop = new AbortController();
    let drawn = 0;
    const drawing = queue.length
      ? deps.jobs.run(
          "drawing",
          `Drawing ${queue.length === 1 ? "1 illustration" : `${queue.length} illustrations`}`,
          async (job) => {
            deps.jobs.cancellers?.set(job.id, () => stop.abort());
            const lanes: Promise<void>[] = [0, 1, 2].map(() => Promise.resolve());
            queue.forEach(({ beat, index }, i) => {
              const lane = i % 3;
              const made = lanes[lane].then(() =>
                deps.draw!(beat.show!, args.style, stop.signal),
              );
              drawings.set(index, made);
              lanes[lane] = made.then(
                () => {
                  drawn++;
                  deps.jobs.update?.(job, { progress: drawn / queue.length });
                },
                () => {},
              );
            });
            await Promise.all(lanes);
            if (stop.signal.aborted) throw Error("Cancelled");
          },
        )
      : Promise.resolve();
    await drawing;
    for (const [index, beat] of args.beats.entries()) {
      const base = { from: beat.from, to: beat.to, layout: beat.layout };
      const kind =
        beat.kind ??
        (!beat.show
          ? undefined
          : /^https?:\/\//u.test(beat.show)
            ? "page"
            : "logo");
      try {
        if (!kind || !beat.show) beats.push(base);
        else if (kind === "draw") {
          const drawn = await drawings.get(index)!;
          stillOpen();
          if (drawn.kind === "image") {
            const asset = await deps.media.import(drawn.file);
            asset.name = beat.show.slice(0, 60);
            imported.push(asset);
            beats.push({
              ...base,
              visual: { kind: "asset", assetId: asset.id, drawing: true },
            });
          } else
            beats.push({
              ...base,
              visual: {
                kind: "svg",
                svg: drawn.svg,
                title: beat.show.slice(0, 60),
                drawing: true,
              },
            });
        } else if (kind === "text")
          beats.push({ ...base, visual: { kind: "text", text: beat.show } });
        else if (kind === "asset")
          beats.push({
            ...base,
            visual: { kind: "asset", assetId: beat.show },
          });
        else {
          if (!deps.references)
            throw Error("References are not available here.");
          if (kind === "logo") {
            const site =
              /^[a-z0-9-]+(\.[a-z0-9-]+)+$/iu.test(beat.show) &&
              !(await deps.references.inLibrary?.(beat.show));
            const logo = await deps.references.logo(
              site ? { domain: beat.show } : { name: beat.show },
            );
            if (logo.matchedBy === "name")
              warnings.push(
                `${beat.show}: matched by name only (${logo.source}). Give its website if that is the wrong company.`,
              );
            stillOpen();
            if (logo.kind === "vector")
              beats.push({
                ...base,
                visual: {
                  kind: "svg",
                  svg: logo.svg,
                  color: logo.color,
                  title: logo.title,
                },
              });
            else {
              const asset = await deps.media.import(logo.file);
              asset.name = `${logo.title} logo`;
              imported.push(asset);
              beats.push({
                ...base,
                visual: { kind: "asset", assetId: asset.id, logo: true },
              });
            }
          } else {
            const shot = await deps.jobs.run(
              "reference",
              "Capturing the page",
              () =>
                deps.references!.screenshot(beat.show!, {
                  device: "desktop",
                  selector: beat.selector,
                }),
            );
            stillOpen();
            const asset = await deps.media.import(shot.file);
            asset.name = shot.title.slice(0, 150);
            imported.push(asset);
            beats.push({
              ...base,
              visual: { kind: "asset", assetId: asset.id },
            });
          }
        }
      } catch (error) {
        warnings.push(
          `Beat at ${beat.from}s (${beat.show}): ${(error as Error).message}`,
        );
        beats.push(base);
      }
    }
    stillOpen();
    assertRevision(args);
    const built = buildStyleReel(
      { ...store.project, assets: [...store.project.assets, ...imported] },
      {
        style: args.style,
        beats,
      },
    );
    store.commit(built.project, "Creator-style Short");
    return {
      revision: store.project.revision,
      ...built.summary,
      warnings: [...warnings, ...built.warnings],
    };
  }

  async function graphic(raw: unknown) {
    const args = GraphicArgsSchema.parse(raw ?? {});
    assertRevision(args);
    if (!deps.graphic) throw Error("Graphics are not available here.");
    const projectId = store.project.id;
    const { projectId: _, revision: __, at, ...request } = args;
    const made = await deps.graphic(GraphicGenerateSchema.parse(request));
    if (store.project.id !== projectId)
      throw Error(
        "A different project was opened meanwhile. Inspect it and try again.",
      );
    const name = args.prompt.replace(/\s+/gu, " ").slice(0, 60);
    if (made.kind === "vector") {
      if (at === undefined)
        return {
          kind: "vector",
          svg: made.svg,
          layers: made.layers,
          warnings: made.warnings,
          note: "Not placed: give at to add it, or pass this svg to cutline_edit motion.svg.",
        };
      const created = createVectorScene(
        store.project,
        toFrame(at, store.project.fps),
        parseEditableSvg(made.svg),
        { name },
      );
      store.commit(
        applyCommands(store.project, {
          projectId: store.project.id,
          revision: store.project.revision,
          label: `Add ${name}`,
          commands: created.commands,
        }),
        `Add ${name}`,
      );
      return {
        revision: store.project.revision,
        kind: "vector",
        clipId: created.clip.id,
        motionId: created.motion.id,
        layers: made.layers,
        reviewed: made.attempts > 1,
        warnings: made.warnings,
        ...(made.note ? { note: made.note } : {}),
      };
    }
    const asset = await deps.media.import(made.file);
    asset.name = name;
    const landed = land(
      asset,
      at ? `Add ${name}` : `Import ${name}`,
      at
        ? (project) => placePicture(project, toFrame(at, project.fps), asset)
        : undefined,
    );
    return {
      ...landed,
      kind: "picture",
      reason: made.reason,
      cutout: made.cutout,
      ...(made.usd ? { usd: made.usd } : {}),
    };
  }

  return async (name: string, raw: unknown): Promise<unknown> => {
    switch (name) {
      case "cutline_graphic":
        return graphic(raw);
      case "cutline_style_reel":
        return styleReel(raw);
      case "cutline_reference":
        return reference(raw);
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
