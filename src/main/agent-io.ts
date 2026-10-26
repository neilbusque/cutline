import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { srtCaptionClips, toSrt } from "../shared/subtitles";
import { Store } from "./store";
import { Media, Jobs } from "./media";
import type { ProjectLibrary } from "./projects";
import { parseEditableSvg } from "../shared/vector-path";
import { createVectorScene } from "../shared/vector-scenes";
import { readableSchema } from "../shared/agent-edit";
import {
  changeSummary,
  inspectProject,
  publicAsset,
} from "../shared/agent-inspect";
import { MAX_PREVIEW_FRAMES } from "./agent-preview";

const revision = {
  projectId: z.string(),
  revision: z.number().int().nonnegative(),
};
const versioned = z.object(revision).strict();
const frame = z.number().int().nonnegative();
const schemas = {
  cutline_import_media: z
    .object({ ...revision, paths: z.array(z.string().min(1)).min(1).max(100) })
    .strict(),
  cutline_vector_import: z
    .object({
      ...revision,
      path: z.string().min(1),
      startFrame: z.number().int().min(0).max(864000).default(0),
      name: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  cutline_save_project: z
    .object({ ...revision, path: z.string().min(1).optional() })
    .strict(),
  cutline_open_project: z
    .object({
      ...revision,
      path: z.string().min(1).optional(),
      name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Name from cutline_list_projects; omit path."),
    })
    .strict()
    .refine((a) => !!a.path !== !!a.name, "Give path or name, not both"),
  cutline_list_projects: z.object({}).strict(),
  cutline_new_project: z
    .object({ ...revision, name: z.string().trim().min(1).max(200).optional() })
    .strict(),
  cutline_redo: versioned,
  cutline_cancel_job: z.object({ id: z.string() }).strict(),
  cutline_caption_srt: z
    .object({ ...revision, srt: z.string().min(1).max(500_000) })
    .strict(),
  cutline_get_srt: z
    .object({
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("First cue to return, from nextOffset."),
    })
    .strict(),
  cutline_preview: z
    .object({
      projectId: revision.projectId
        .optional()
        .describe("Must match the open project if given."),
      revision: revision.revision
        .optional()
        .describe("Must match the current revision if given."),
      frame: frame.optional().describe("Timeline frame to seek to and show."),
      seconds: z.number().nonnegative().optional(),
      clipId: z
        .string()
        .optional()
        .describe("Select clip; count samples its span."),
      playing: z.boolean().optional(),
      image: z
        .boolean()
        .default(false)
        .describe("Render with the export renderer, without editor overlays."),
      frames: z
        .array(frame)
        .min(1)
        .max(MAX_PREVIEW_FRAMES)
        .optional()
        .describe("Timeline frames to render."),
      count: z
        .number()
        .int()
        .min(1)
        .max(MAX_PREVIEW_FRAMES)
        .optional()
        .describe(
          "Sample clipId, fromFrame/toFrame, or the whole timeline evenly.",
        ),
      fromFrame: frame.optional(),
      toFrame: frame.optional().describe("Exclusive end of the range."),
      width: z
        .number()
        .int()
        .min(160)
        .max(1920)
        .optional()
        .describe("Frame width in pixels; defaults fit one image."),
      layout: z
        .enum(["sheet", "separate"])
        .optional()
        .describe("sheet (default) or separate images."),
    })
    .strict()
    .refine(
      (a) => a.frame === undefined || a.seconds === undefined,
      "Use frame or seconds, not both",
    ),
  cutline_connection_status: z.object({}).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  cutline_import_media:
    "Import absolute paths; returns IDs/failures, keeps valid imports. Place with clip.add. One Undo.",
  cutline_vector_import:
    "Import absolute SVG as editable layers at startFrame. Unsupported parts warn. One Undo.",
  cutline_save_project:
    "Save .cutline to optional absolute path or current/new file. No unrelated overwrites.",
  cutline_open_project:
    "Open absolute .cutline path or listed name at current revision. Existing work is saved.",
  cutline_list_projects:
    "List recent projects with paths and timing. Open with cutline_open_project.",
  cutline_new_project:
    "New project at current revision; keeps saved work. Named projects save immediately.",
  cutline_redo: "Redo at current revision; returns revision and changes.",
  cutline_cancel_job:
    "Cancel a running local export, transcription or other processing job by ID.",
  cutline_caption_srt:
    "Add timeline SRT; one Undo. Word captions: cutline_transcribe. Style: cutline_edit.",
  cutline_get_srt: "Read timeline captions as SRT; page with offset.",
  cutline_preview:
    "Preview: image returns render, frames/count a sheet. frame/seconds seek; clipId selects; playing toggles.",
  cutline_connection_status:
    "Read editor availability, transports, tool count and last agent call. Omits tokens/paths.",
};
const readOnly = new Set([
  "cutline_get_srt",
  "cutline_connection_status",
  "cutline_list_projects",
]);
const destructive = new Set([
  "cutline_open_project",
  "cutline_new_project",
  "cutline_redo",
]);
export const agentIoTools = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof schemas],
  inputSchema: readableSchema(schema, true),
  annotations: {
    readOnlyHint: readOnly.has(name),
    destructiveHint: destructive.has(name),
    idempotentHint: readOnly.has(name),
    openWorldHint: false,
  },
}));
export const PreviewArgsSchema = schemas.cutline_preview;

export function createAgentIO(options: {
  store: Store;
  media: Media;
  jobs: Jobs;
  directory: string;
  /** The Projects folder and recent files; without it, projects save under directory. */
  library?: ProjectLibrary;
  preview: (args: any) => Promise<unknown>;
  status: () => unknown;
}) {
  const { store, media, jobs } = options;
  const assertRevision = (args: any) => {
    if (
      args.projectId !== store.project.id ||
      args.revision !== store.project.revision
    )
      throw Error("Project changed. Inspect the project and retry.");
  };
  const protect = (file: string) => {
    if (store.project.assets.some((asset) => path.resolve(asset.path) === file))
      throw Error("Source media cannot be overwritten.");
  };
  /** What an edit changed, against the project before it. */
  const changed = (before: typeof store.project) => ({
    revision: store.project.revision,
    summary: changeSummary(before, store.project),
  });
  return async (name: string, raw: unknown) => {
    const schema = schemas[name as keyof typeof schemas];
    if (!schema) throw Error("Unknown editing tool");
    const args = schema.parse(raw ?? {}) as any;
    if (name !== "cutline_preview" && "revision" in args) assertRevision(args);
    switch (name) {
      case "cutline_vector_import": {
        const file = args.path;
        if (
          !path.isAbsolute(file) ||
          path.extname(file).toLowerCase() !== ".svg" ||
          !existsSync(file) ||
          !statSync(file).isFile()
        )
          throw Error("Choose an existing local .svg file by absolute path.");
        if (statSync(file).size > 1048576)
          throw Error("This SVG is too large. Simplify it to 1 MiB or less.");
        const parsed = parseEditableSvg(readFileSync(file, "utf8"));
        const created = createVectorScene(
          store.project,
          args.startFrame,
          parsed,
          {
            name:
              args.name ??
              path.basename(file, path.extname(file)).slice(0, 100),
          },
        );
        assertRevision(args);
        store.transact({
          ...args,
          label: `Import ${created.motion.name}`,
          commands: created.commands,
        });
        return {
          revision: store.project.revision,
          clipId: created.clip.id,
          motionId: created.motion.id,
          vectorLayers: created.motion.layers.length,
          warnings: parsed.warnings ?? [],
        };
      }
      case "cutline_import_media": {
        const opening = store.openSession;
        const failures: { path: string; error: string }[] = [];
        const files: string[] = [];
        for (const file of args.paths as string[]) {
          if (!path.isAbsolute(file))
            failures.push({ path: file, error: "Use an absolute path." });
          else if (!existsSync(file) || !statSync(file).isFile())
            failures.push({
              path: file,
              error: "No file exists at this path.",
            });
          else files.push(file);
        }
        const assets = [];
        for (const file of files) {
          try {
            assets.push(await media.import(file));
          } catch (error) {
            failures.push({ path: file, error: (error as Error).message });
          }
          if (store.openSession !== opening)
            throw Error(
              "A different project was opened during the import. Inspect it and import again.",
            );
        }
        if (!assets.length)
          throw Error(
            `Nothing was imported. ${failures.map((failure) => `${failure.path}: ${failure.error}`).join(" ")}`,
          );
        // Imports only add assets, so they land on top of any edit made meanwhile.
        store.commit(
          { ...store.project, assets: [...store.project.assets, ...assets] },
          "Agent import media",
        );
        return {
          revision: store.project.revision,
          importedAssetIds: assets.map((a) => a.id),
          assets: assets.map(publicAsset),
          failures,
        };
      }
      case "cutline_save_project": {
        const slug =
          store.project.name
            .replace(/[^a-zA-Z0-9 _-]/g, "")
            .trim()
            .slice(0, 80) || "Project";
        const file =
          args.path ??
          store.filePath ??
          (options.library
            ? options.library.newPath(store.project.name)
            : path.join(
                options.directory,
                "projects",
                `${slug}-${Date.now()}.cutline`,
              ));
        if (
          !path.isAbsolute(file) ||
          path.extname(file).toLowerCase() !== ".cutline"
        )
          throw Error("Use an absolute .cutline path.");
        protect(file);
        if (existsSync(file) && file !== store.filePath)
          throw Error(
            "That file already exists. Choose a new project filename.",
          );
        // The open project's own file is left alone once it was moved,
        // deleted or changed elsewhere; only the person decides to replace it.
        const problem = file === store.filePath ? store.fileProblem() : null;
        if (problem)
          throw Error(
            `Couldn't save to ${file} because ${problem}. Pass a new path to save it somewhere else.`,
          );
        store.save(file);
        options.library?.remember(file);
        return {
          path: file,
          revision: store.project.revision,
          name: store.project.name,
        };
      }
      case "cutline_list_projects": {
        if (!options.library) throw Error("Projects are not available here.");
        return {
          folder: options.library.folder,
          projects: options.library.list(store.filePath),
        };
      }
      case "cutline_open_project": {
        const file = args.name
          ? (() => {
              if (!options.library) throw Error("Open a project by path.");
              return options.library.find(args.name).path;
            })()
          : args.path;
        if (
          !path.isAbsolute(file) ||
          path.extname(file).toLowerCase() !== ".cutline"
        )
          throw Error("Use an absolute .cutline path.");
        store.persist(store.recovery + ".previous");
        store.load(file);
        options.library?.remember(file);
        return { ...inspectProject(store.project), path: file };
      }
      case "cutline_new_project": {
        store.fresh();
        if (args.name) {
          store.transact({
            projectId: store.project.id,
            revision: store.project.revision,
            label: "Name project",
            commands: [{ type: "project.update", patch: { name: args.name } }],
          });
          // A named project is one the assistant means to keep: give it its file now.
          if (options.library) {
            const file = options.library.newPath(args.name);
            store.save(file);
            options.library.remember(file);
          }
        }
        return { ...inspectProject(store.project), path: store.filePath };
      }
      case "cutline_redo": {
        const before = store.project,
          label = store.future.at(-1)?.label;
        store.redo();
        return label
          ? { redone: label, ...changed(before) }
          : {
              revision: store.project.revision,
              redone: null,
              message: "Nothing to redo.",
            };
      }
      case "cutline_cancel_job": {
        if (!jobs.jobs.has(args.id)) throw Error("Job is missing");
        jobs.cancel(args.id);
        const { output, ...job } = jobs.jobs.get(args.id)!;
        return job;
      }
      case "cutline_caption_srt": {
        const clips = srtCaptionClips(store.project, args.srt);
        if (!clips.length) throw Error("No valid SRT captions found.");
        store.commit(
          { ...store.project, clips: [...store.project.clips, ...clips] },
          "Agent import captions",
        );
        return {
          revision: store.project.revision,
          captionCount: clips.length,
          captionIds: clips.slice(0, 100).map((clip) => clip.id),
        };
      }
      case "cutline_get_srt": {
        const srt = toSrt(store.project.clips, store.project.fps);
        const cues = srt ? srt.trimEnd().split("\n\n") : [];
        const page: string[] = [];
        let used = 0;
        for (const cue of cues.slice(args.offset)) {
          if (page.length && used + cue.length > 40_000) break;
          page.push(cue);
          used += cue.length + 2;
        }
        const next = args.offset + page.length;
        return {
          srt: page.length ? page.join("\n\n") + "\n" : "",
          cueCount: cues.length,
          ...(next < cues.length ? { nextOffset: next } : {}),
        };
      }
      case "cutline_preview":
        return options.preview(args);
      case "cutline_connection_status":
        return options.status();
    }
  };
}
