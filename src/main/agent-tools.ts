import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  agentEditTools,
  readableSchema,
  tidySchema,
} from "../shared/agent-edit";
import { InspectArgsSchema } from "../shared/agent-inspect";
import {
  TranscriptReadSchema,
  TranscriptSearchSchema,
} from "../shared/transcript";
import { CommandSchema } from "../shared/commands";
import { ReelOptionsSchema } from "../shared/reel";
import { agentIoTools } from "./agent-io";
import { agentMediaTools } from "./agent-media";
import { musicTools } from "./music-control";
import { JobsArgsSchema } from "./agent-tasks";
import { directorStyles } from "../shared/director-guide";
import { ExplainerInputSchema } from "../shared/explainer";
import { StoryProduceSchema } from "./story-batch";
import { hyperframesTools } from "./agent-hyperframes";
import { model3dTools } from "./agent-model-3d";

/**
 * Tools whose work can outlast a client's request timeout. They answer within
 * 45 seconds, with a job ID when the work is still running; see AgentTasks.
 */
export const longRunningTools = new Set([
  "cutline_transcribe",
  "cutline_remove_pauses",
  "cutline_create_reel",
  "cutline_music_analyze",
  "cutline_music_create",
  "cutline_import_media",
  "cutline_stock_import",
  "cutline_voiceover",
  "cutline_auto_edit",
  "cutline_relink",
  "cutline_story_voice",
  "cutline_story_produce",
  "cutline_reference",
  "cutline_style_reel",
  "cutline_graphic",
  "cutline_hyperframes",
  "cutline_model3d",
]);

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const edit = (destructive: boolean) => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: false,
  openWorldHint: false,
});
const guarded = {
  projectId: { type: "string" },
  revision: { type: "integer", minimum: 0 },
};
const describe = <T extends Record<string, any>>(
  schema: T,
  descriptions: Record<string, string>,
) => {
  for (const [name, description] of Object.entries(descriptions))
    schema.properties[name] = { ...schema.properties[name], description };
  return schema;
};

/**
 * Every Cutline MCP tool. The app serves this list, and the stdio launcher
 * bundles it so clients still see the tools while Cutline is closed.
 */
const toolDefinitions: Tool[] = [
  {
    name: "cutline_explainer",
    description:
      "Save authored script as an editable explainer plan; keeps timeline. Screen needs real media. No paid generation. Read section explainer.",
    inputSchema: readableSchema(
      z.object({
        projectId: z.string(),
        revision: z.number().int().min(0),
        input: ExplainerInputSchema,
      }),
      true,
    ),
    annotations: edit(true),
  },
  {
    name: "cutline_story_produce",
    description:
      "Build local narration, aligned captions and editable scenes. Rebuild replaces only prior story. Cancel keeps voices. Wait on jobs; no paid generation.",
    inputSchema: readableSchema(StoryProduceSchema, true),
    annotations: edit(false),
  },
  {
    name: "cutline_director_guide",
    description:
      "Read cinematic, product, social or promo direction. No edits.",
    inputSchema: {
      type: "object",
      properties: {
        style: { type: "string", enum: [...directorStyles] },
      },
      additionalProperties: false,
    },
    annotations: read,
  },
  {
    name: "cutline_quality_check",
    description:
      "Read timeline/media/caption issues and up to 12 frames. Cannot certify taste/loudness. No edits.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: read,
  },
  {
    name: "cutline_story",
    description:
      "Read/save story with projectId/revision. Read schema section story; preserve IDs/media. No paid generation.",
    inputSchema: readableSchema(
      z.object({
        projectId: z.string().optional(),
        revision: z.number().int().optional(),
        story: z.record(z.string(), z.unknown()).optional(),
      }),
      true,
    ),
    annotations: edit(false),
  },
  {
    name: "cutline_story_voice",
    description:
      "Generate local scene narration/captions. Wait on returned jobs. No paid generation.",
    inputSchema: readableSchema(
      z.object({
        projectId: z.string(),
        revision: z.number().int(),
        sceneId: z.string(),
      }),
      true,
    ),
    annotations: edit(false),
  },
  {
    name: "cutline_story_assemble",
    description:
      "Assemble story/voice/captions/music. Requires layout assets/current voice. append keeps clips; rebuild replaces last story. Returns timing/warnings.",
    inputSchema: readableSchema(
      z.object({
        projectId: z.string(),
        revision: z.number().int(),
        mode: z.enum(["append", "rebuild"]),
      }),
      true,
    ),
    annotations: edit(false),
  },
  ...agentEditTools,
  ...(agentIoTools as Tool[]),
  ...agentMediaTools,
  ...hyperframesTools,
  ...model3dTools,
  ...musicTools.map((tool) => ({
    ...tool,
    inputSchema: tidySchema(tool.inputSchema, true),
  })),
  {
    name: "cutline_create_reel",
    description:
      "Build Reel; read cutline_effects_guide first. Omit beats for transcript cards; [] disables. Inspect first: append keeps work, replace requires requested rebuild. One Undo; may return job.",
    inputSchema: readableSchema(
      z.object({
        projectId: z.string(),
        revision: z.number().int(),
        options: ReelOptionsSchema.extend({
          mode: z.enum(["replace", "append"]),
        }),
      }),
      true,
    ),
    annotations: edit(true),
  },
  {
    name: "cutline_stock_search",
    description:
      "Search photos/B-roll/audio with credits. Openverse photos/audio and Commons need no key; Pexels key in Settings. Query goes to provider.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: ["video", "image", "audio"] },
        provider: { type: "string", enum: ["commons", "pexels", "openverse"] },
        orientation: {
          type: "string",
          enum: ["all", "portrait", "landscape", "square"],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { ...read, openWorldHint: true },
  },
  {
    name: "cutline_effects_guide",
    description:
      "Read motion/compositing actions, recipes, limits and Reel formats before designing.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: read,
  },
  {
    name: "cutline_inspect",
    description:
      "Read revision/canvas/tracks/assets/clips. summary: timing/nondefaults/captions; full: all fields. No paths/transcripts.",
    inputSchema: describe(readableSchema(InspectArgsSchema, true), {
      detail: "summary (default) or full (every field).",
      clipIds: "These clips and their motions.",
      kinds: "Clip kinds.",
      fromFrame: "Overlap this frame or later.",
      toFrame: "Start before this frame.",
      offset: "Skip matches using page.nextOffset.",
    }),
    annotations: read,
  },
  {
    name: "cutline_apply_edits",
    description:
      "Raw undoable commands; prefer cutline_edit. Fields: schema command:<type>.",
    inputSchema: {
      type: "object",
      properties: {
        ...guarded,
        label: { type: "string", minLength: 1, maxLength: 200 },
        commands: {
          type: "array",
          minItems: 1,
          maxItems: 2000,
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: CommandSchema.options.map((option) =>
                  String(option.shape.type.value),
                ),
              },
            },
            required: ["type"],
          },
        },
      },
      required: ["projectId", "revision", "label", "commands"],
    },
    annotations: edit(true),
  },
  {
    name: "cutline_transcribe",
    description:
      "Local speech captions. Cut requested pauses first. Wait with cutline_jobs.",
    inputSchema: {
      type: "object",
      properties: { ...guarded, clipId: { type: "string" } },
      required: ["projectId", "revision", "clipId"],
    },
    annotations: edit(false),
  },
  {
    name: "cutline_remove_pauses",
    description:
      "Cut local silence/long pauses and shift later clips earlier. Wait on returned jobs.",
    inputSchema: {
      type: "object",
      properties: { ...guarded, clipId: { type: "string" } },
      required: ["projectId", "revision", "clipId"],
    },
    annotations: edit(true),
  },
  {
    name: "cutline_search_transcript",
    description:
      "Find speech with timeline frames (end exclusive) and source seconds. Trimmed hits are partial; removed clipId is null.",
    inputSchema: describe(readableSchema(TranscriptSearchSchema, true), {
      query: "Words to find; case and punctuation are ignored.",
      clipId: "Only hits inside this clip.",
    }),
    annotations: read,
  },
  {
    name: "cutline_transcript",
    description:
      "Read speech: clipId gives timeline frames; assetId gives source seconds. Page with offset.",
    inputSchema: readableSchema(TranscriptReadSchema, true),
    annotations: read,
  },
  {
    name: "cutline_export",
    description:
      "Export MP4 to optional absolute path; defaults unique. No overwrites. Current projectId/revision; wait with cutline_jobs.",
    inputSchema: readableSchema(
      z
        .object({
          projectId: z.string(),
          revision: z.number().int(),
          path: z.string().optional(),
        })
        .strict(),
      true,
    ),
    annotations: edit(false),
  },
  {
    name: "cutline_jobs",
    description:
      "Read long-job progress/errors/results. Use id with waitSeconds 30 to await completion.",
    inputSchema: describe(readableSchema(JobsArgsSchema, true), {
      id: "Job ID from a running result.",
      waitSeconds: "Wait seconds, maximum 50.",
      limit: "Recent-job limit.",
    }),
    annotations: read,
  },
  {
    name: "cutline_undo",
    description:
      "Undo last edit at current revision. Returns revision/changes.",
    inputSchema: {
      type: "object",
      properties: guarded,
      required: ["projectId", "revision"],
    },
    annotations: edit(true),
  },
];

// Apply the same compact listing contract to hand-written and generated schemas.
// Execution still validates each tool's complete schema, available in the guide.
export const cutlineTools: Tool[] = toolDefinitions.map((tool) => ({
  ...tool,
  inputSchema: tidySchema(tool.inputSchema, true),
}));
