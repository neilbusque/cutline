import { cutlineWorkflow } from "./assistant-instructions";
import { regroupCaptionCommands } from "./caption-grouping";
import { z } from "zod";
import { StoryPlanSchema, StorySceneSchema } from "./story-schema";
import { ExplainerInputSchema } from "./explainer";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AssetSchema,
  ClipSchema,
  KeyframeSchema,
  MAX_FRAME,
  MotionLayerSchema,
  MotionSchema,
  ProjectSchema,
  PropertyKeyframeSchema,
  TrackSchema,
  duration,
  makeClip,
  uid,
  validateProject,
  type Clip,
  type Motion,
  type MotionLayer,
  type Project,
  type Track,
} from "./model";
import {
  CommandSchema,
  TransactionSchema,
  applyCommands,
  rippleShifts,
  type Command,
} from "./commands";
import { animatedProperties, propertyBounds } from "./animation";
import {
  motionEasings,
  motionProperties,
  motionPropertyBounds,
} from "./motion";
import { upsertMotionKey, moveMotionKey } from "./motion-edit";
import {
  createMotionScene,
  createShapeLayer,
  motionScenes,
  motionSceneIds,
  shapeTypes,
} from "./motion-presets";
import { compatibleTrack, trimClip } from "./timeline";
import { linkedCaptionCommands } from "./linked-captions";
import { resizeCanvas } from "./canvas";
import { newTrack } from "./layers";
import { captionTextPatch } from "./caption-edit";
import { captionStylePatch, captionStyles } from "./caption-styles";
import { srtCaptionClips } from "./subtitles";
import {
  MAX_VECTOR_LAYERS,
  MAX_VECTOR_PATH_LENGTH,
  parseEditableSvg,
  pointsToVectorPath,
  type VectorPathDefinition,
} from "./vector-path";
import { createVectorScene } from "./vector-scenes";
import { createLogoRevealCommands } from "./logo-presets";
import { enumOptions } from "./agent-guide";
import { duckClipVolume } from "./audio-duck";
import {
  createMotionRecipe,
  motionRecipeCatalog,
  motionRecipeIds,
  motionRecipePositions,
  motionRecipeStyles,
  motionRecipes,
} from "./motion-recipes";

const frame = z.number().int().min(0).max(MAX_FRAME);
export const AgentTimeSchema = z.union([
  z.strictObject({ frame }),
  z.strictObject({
    seconds: z
      .number()
      .finite()
      .min(0)
      .max(8 * 60 * 60),
  }),
]);
const id = z.string().min(1).max(200);
const ref = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .optional();
function partialShape(shape: Record<string, z.ZodType>, omit: string[] = []) {
  return z.strictObject(
    Object.fromEntries(
      Object.entries(shape)
        .filter(([name]) => !omit.includes(name))
        .map(([name, schema]) => [
          name,
          (schema instanceof z.ZodDefault
            ? (schema.removeDefault() as z.ZodType)
            : schema
          ).optional(),
        ]),
    ),
  );
}
export const AgentClipPatchSchema = partialShape(ClipSchema.shape, [
  "id",
]) as z.ZodType<Partial<Omit<Clip, "id">>>;
// Imported gradients come only from SVG (motion.svg), which keeps the tool list small.
export const AgentMotionLayerPatchSchema = partialShape(
  MotionLayerSchema.shape,
  ["vectorGradient"],
) as z.ZodType<Partial<MotionLayer>>;
const { vectorGradient: _gradient, ...layerDefinitionShape } =
  MotionLayerSchema.shape;
const AgentLayerDefinitionSchema = z.object(layerDefinitionShape);
const trackPatch = partialShape(TrackSchema.shape, ["id"]) as z.ZodType<
  Partial<Omit<Track, "id">>
>;
const captionFields = [
  "fontSize",
  "fontFamily",
  "fontWeight",
  "color",
  "background",
  "accent",
  "align",
  "highlight",
  "captionStyle",
  "captionLayout",
  "captionCase",
  "captionMaxLines",
  "captionStrokeWidth",
  "captionTracking",
  "x",
  "y",
  "width",
  "height",
  "opacity",
  "preset",
  "animationFrames",
  "exitAnimation",
];
const captionPatch = partialShape(
  Object.fromEntries(
    Object.entries(ClipSchema.shape).filter(([name]) =>
      captionFields.includes(name),
    ),
  ),
) as z.ZodType<Partial<Clip>>;
const projectPatch = partialShape({
  name: ProjectSchema.shape.name,
  width: ProjectSchema.shape.width,
  height: ProjectSchema.shape.height,
  background: ProjectSchema.shape.background,
  // Only while the timeline is empty: clip timing is counted in frames.
  fps: ProjectSchema.shape.fps,
}) as z.ZodType<
  Partial<Pick<Project, "name" | "width" | "height" | "background" | "fps">>
>;
const layerIndex = z.number().int().min(0).max(MAX_VECTOR_LAYERS - 1);
const penCoordinate = z.number().finite().min(-1e7).max(1e7);
const penHandle = z.strictObject({ x: penCoordinate, y: penCoordinate });
const penPoint = z.strictObject({
  x: penCoordinate,
  y: penCoordinate,
  in: penHandle.optional(),
  out: penHandle.optional(),
});
const vectorPlacement = {
  width: z.number().finite().min(1).max(4000).optional(),
  height: z.number().finite().min(1).max(4000).optional(),
  name: z.string().min(1).max(100).optional(),
};
const recipeColor = MotionLayerSchema.shape.color.removeDefault().optional();
const canvasCoordinate = z.number().finite().min(0).max(8000);

export const AgentActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("motion.svg"),
    svg: z.string().min(1).max(1048576),
    at: AgentTimeSchema,
    ...vectorPlacement,
    ref,
  }),
  z
    .strictObject({
      type: z.literal("motion.vector"),
      path: z.string().min(1).max(MAX_VECTOR_PATH_LENGTH).optional(),
      points: z.array(penPoint).min(2).max(2000).optional(),
      closed: z.boolean().default(false),
      viewBox: MotionLayerSchema.shape.vectorViewBox.unwrap(),
      transform: MotionLayerSchema.shape.vectorTransform,
      fill: MotionLayerSchema.shape.background.removeDefault().optional(),
      stroke: MotionLayerSchema.shape.stroke.removeDefault().optional(),
      strokeWidth: z.number().finite().min(0).max(100).optional(),
      fillRule: z.enum(["nonzero", "evenodd"]).default("nonzero"),
      at: AgentTimeSchema,
      ...vectorPlacement,
      ref,
    })
    .refine(
      (a) => (a.path !== undefined) !== (a.points !== undefined),
      "Specify exactly one vector path or pen point list.",
    ),
  z.strictObject({
    type: z.literal("motion.logoReveal"),
    clipId: id,
    style: z.enum(["draw", "orbit", "signal"]),
    durationFrames: z.number().int().min(2).max(18000).optional(),
  }),
  z.strictObject({
    type: z.literal("clip.add"),
    kind: ClipSchema.shape.kind,
    at: AgentTimeSchema.optional(),
    duration: AgentTimeSchema.optional(),
    assetId: id.optional(),
    trackId: id.optional(),
    patch: AgentClipPatchSchema.optional(),
    ref,
  }),
  z.strictObject({
    type: z.literal("clip.update"),
    clipId: id,
    patch: AgentClipPatchSchema,
  }),
  z.strictObject({
    type: z.literal("clip.split"),
    clipId: id,
    at: AgentTimeSchema,
    rightRef: ref,
  }),
  z
    .strictObject({
      type: z.literal("clip.trim"),
      clipId: id,
      start: AgentTimeSchema.optional(),
      end: AgentTimeSchema.optional(),
    })
    .refine(
      (a) => a.start !== undefined || a.end !== undefined,
      "Specify a trim start or end.",
    ),
  z.strictObject({
    type: z.literal("clip.move"),
    clipId: id,
    at: AgentTimeSchema,
    trackId: id.optional(),
    followCaptions: z.boolean().default(true),
  }),
  z.strictObject({
    type: z.literal("clip.duplicate"),
    clipId: id,
    at: AgentTimeSchema,
    trackId: id.optional(),
    followCaptions: z.boolean().default(true),
    ref,
  }),
  z.strictObject({
    type: z.literal("clip.delete"),
    clipId: id,
    ripple: z.boolean().default(false),
    deleteCaptions: z.boolean().default(true),
  }),
  z
    .strictObject({
      type: z.literal("clip.keyframe"),
      clipId: id,
      property: z.enum(animatedProperties),
      frame,
      value: z.number().finite().optional(),
      easing: PropertyKeyframeSchema.shape.easing.removeDefault().optional(),
      bezier: PropertyKeyframeSchema.shape.bezier,
      remove: z.boolean().default(false),
    })
    .refine(
      (a) => a.remove || a.value !== undefined,
      "A keyframe value is required unless removing.",
    ),
  z.strictObject({
    type: z.literal("clip.transition"),
    clipId: id,
    kind: z.enum([
      "none",
      "crossfade",
      "black",
      "slide-left",
      "slide-right",
      "wipe",
    ]),
    frames: z.number().int().min(2).max(600).default(15),
  }),
  z.strictObject({
    type: z.literal("motion.scene"),
    scene: z.enum(motionSceneIds),
    at: AgentTimeSchema,
    durationFrames: z.number().int().min(2).max(18000).optional(),
    ref,
  }),
  z.strictObject({
    type: z.literal("motion.shape"),
    shape: z.enum(shapeTypes),
    at: AgentTimeSchema,
    ref,
  }),
  z
    .strictObject({
      type: z.literal("motion.recipe"),
      recipe: z.enum(motionRecipeIds),
      at: AgentTimeSchema,
      text: z.string().trim().min(1).max(160),
      subtitle: z.string().trim().min(1).max(200).optional(),
      durationFrames: z.number().int().min(12).max(18000).optional(),
      position: z.enum(motionRecipePositions).optional(),
      point: z
        .strictObject({ x: canvasCoordinate, y: canvasCoordinate })
        .optional()
        .describe("Callout only: the spot to mark, in canvas pixels."),
      style: z.enum(motionRecipeStyles).default("clean"),
      colors: z
        .strictObject({
          text: recipeColor,
          accent: recipeColor,
          panel: recipeColor,
          background: recipeColor,
        })
        .optional(),
      ref,
    })
    .refine((a) => a.point === undefined || a.recipe === "callout", {
      message:
        "point applies only to the callout recipe; place other recipes with position.",
      path: ["point"],
    }),
  z.strictObject({
    type: z.literal("audio.duck"),
    musicClipId: id,
    speechClipIds: z.array(id).min(1).max(200),
    by: z.enum(["words", "clips"]).default("words"),
    depthDb: z
      .number()
      .finite()
      .min(-60)
      .max(-1)
      .default(-14)
      .describe("Default -14."),
    attackFrames: z.number().int().min(1).max(120).optional(),
    releaseFrames: z.number().int().min(1).max(240).optional(),
    level: z.number().finite().min(0).max(2).optional(),
  }),
  z.strictObject({
    type: z.literal("motion.put"),
    motion: MotionSchema,
    clipId: id.optional(),
    ref,
  }),
  z.strictObject({
    type: z.literal("motion.layer.add"),
    motionId: id,
    definition: AgentLayerDefinitionSchema,
    index: z.number().int().min(0).max(MAX_VECTOR_LAYERS).optional(),
  }),
  z.strictObject({
    type: z.literal("motion.layer.update"),
    motionId: id,
    layer: layerIndex,
    patch: AgentMotionLayerPatchSchema,
  }),
  z.strictObject({
    type: z.literal("motion.layer.delete"),
    motionId: id,
    layer: layerIndex,
  }),
  z.strictObject({
    type: z.literal("motion.layer.move"),
    motionId: id,
    layer: layerIndex,
    to: layerIndex,
  }),
  z
    .strictObject({
      type: z.literal("motion.keyframe"),
      motionId: id,
      layer: layerIndex,
      property: z.enum(motionProperties),
      frame,
      value: z.number().finite().optional(),
      easing: z.enum(motionEasings).optional(),
      bezier: KeyframeSchema.shape.bezier,
      remove: z.boolean().default(false),
    })
    .refine(
      (a) => a.remove || a.value !== undefined,
      "A keyframe value is required unless removing.",
    ),
  z.strictObject({
    type: z.literal("motion.keyframe.move"),
    motionId: id,
    layer: layerIndex,
    property: z.enum(motionProperties),
    fromFrame: frame,
    toFrame: frame,
  }),
  z
    .strictObject({
      type: z.literal("caption.update"),
      clipId: id,
      text: z.string().min(1).max(10000).optional(),
      patch: captionPatch.optional(),
    })
    .refine(
      (a) => a.text !== undefined || a.patch !== undefined,
      "Specify caption text or style.",
    ),
  z
    .strictObject({
      type: z.literal("caption.style"),
      clipIds: z.array(id).min(1).max(10000),
      style: ClipSchema.shape.captionStyle.removeDefault().optional(),
      patch: captionPatch.optional(),
      pace: z.enum(["phrases", "short"]).optional(),
    })
    .refine(
      (a) =>
        a.style !== undefined || a.patch !== undefined || a.pace !== undefined,
      "Specify a caption style, patch or pace.",
    ),
  z.strictObject({
    type: z.literal("caption.import"),
    srt: z.string().min(1).max(1_000_000),
    at: AgentTimeSchema.optional(),
    trackId: id.optional(),
  }),
  z.strictObject({
    type: z.literal("track.add"),
    kind: TrackSchema.shape.kind,
    name: z.string().min(1).max(100).optional(),
    ref,
  }),
  z.strictObject({
    type: z.literal("track.update"),
    trackId: id,
    patch: trackPatch,
  }),
  z
    .strictObject({
      type: z.literal("track.move"),
      trackId: id,
      direction: z.enum(["up", "down"]).optional(),
      index: z.number().int().min(0).max(63).optional(),
    })
    .refine(
      (a) => (a.direction !== undefined) !== (a.index !== undefined),
      "Specify either direction or index.",
    ),
  z.strictObject({
    type: z.literal("track.delete"),
    trackId: id,
    deleteClips: z.boolean().default(false),
  }),
  z.strictObject({ type: z.literal("project.update"), patch: projectPatch }),
  z.strictObject({ type: z.literal("command"), command: CommandSchema }),
]);
export const AgentEditSchema = z.strictObject({
  projectId: id,
  revision: z.number().int().min(0),
  label: z.string().min(1).max(200),
  actions: z.array(AgentActionSchema).min(1).max(500),
  dryRun: z.boolean().default(false),
});
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentEdit = z.infer<typeof AgentEditSchema>;
type Time = z.infer<typeof AgentTimeSchema>;
/** A {frame} or {seconds} time in frames, refused in plain words past the timeline's end. */
export function agentFrame(time: Time, fps: number) {
  const value = "frame" in time ? time.frame : Math.round(time.seconds * fps);
  if (value > MAX_FRAME)
    throw Error(
      `Times must be under ${Number((MAX_FRAME / fps / 3600).toFixed(1))} hours at ${fps} fps.`,
    );
  return value;
}
const toFrame = agentFrame;

/** A finished edit that fails its project check, before naming the action that broke it. */
class UncheckedEditError extends Error {}

/**
 * Prepare the entire edit without mutating the live project. Commit its result
 * once for atomic undo. Actions apply to one private copy and the result is
 * checked once (a check per action cost about 40 ms each); only when that
 * check fails are the actions applied again, checked one at a time, so the
 * error names the action that caused it.
 */
export function applyAgentEdit(project: Project, raw: unknown) {
  try {
    return prepareAgentEdit(project, raw, false);
  } catch (error) {
    if (error instanceof UncheckedEditError)
      return prepareAgentEdit(project, raw, true);
    throw error;
  }
}

function prepareAgentEdit(project: Project, raw: unknown, checkEach: boolean) {
  const input = AgentEditSchema.parse(raw);
  if (input.projectId !== project.id)
    throw Error(
      "Project changed: a different project is open now. Inspect it and retry.",
    );
  if (input.revision !== project.revision)
    throw Error(
      `Project changed: this edit used revision ${input.revision} but the project is at revision ${project.revision}. Inspect the project and retry with revision ${project.revision}.`,
    );
  let working = structuredClone(project);
  const aliases = new Map<string, string>();
  const warnings: string[] = [];
  const resolve = (value: string) => {
    if (!value.startsWith("$")) return value;
    const resolved = aliases.get(value.slice(1));
    if (!resolved)
      throw Error(
        `Unknown edit reference ${value}. Create it earlier in this transaction.`,
      );
    return resolved;
  };
  const remember = (name: string | undefined, value: string) => {
    if (!name) return;
    if (aliases.has(name)) throw Error(`Duplicate edit reference $${name}.`);
    aliases.set(name, value);
  };
  const clip = (value: string) => {
    const result = working.clips.find((c) => c.id === resolve(value));
    if (!result) throw Error(`Clip ${value} is missing.`);
    return result;
  };
  const track = (value: string) => {
    const result = working.tracks.find((t) => t.id === resolve(value));
    if (!result) throw Error(`Track ${value} is missing.`);
    return result;
  };
  const motion = (value: string) => {
    const result = working.motions.find((m) => m.id === resolve(value));
    if (!result) throw Error(`Motion ${value} is missing.`);
    return structuredClone(result);
  };
  const checkedLayer = (m: Motion, index: number) => {
    const l = m.layers[index];
    if (!l)
      throw Error(`Motion layer ${index} is missing (indices start at 0).`);
    return l;
  };
  const checkDestination = (c: Pick<Clip, "kind">, trackId: string) => {
    const destination = track(trackId);
    if (!compatibleTrack(c, destination))
      throw Error("The clip kind does not match its destination track.");
    return destination.id;
  };
  const resolvePatch = (patch: Partial<Omit<Clip, "id">>) => {
    const result = { ...patch };
    for (const property of [
      "trackId",
      "assetId",
      "motionId",
      "captionSourceId",
    ] as const)
      if (result[property]) result[property] = resolve(result[property]!);
    if (result.transition)
      result.transition = {
        ...result.transition,
        fromId: resolve(result.transition.fromId),
      };
    return result;
  };
  const run = (commands: Command[]) => {
    if (commands.length)
      working = applyCommands(
        working,
        {
          projectId: working.id,
          revision: working.revision,
          label: input.label,
          commands,
        },
        checkEach ? undefined : { clone: false, validate: false },
      );
  };
  for (const [index, action] of input.actions.entries()) {
    try {
      switch (action.type) {
        case "motion.logoReveal": {
          const clipId = resolve(action.clipId);
          run(
            createLogoRevealCommands(working, clipId, action.style, {
              durationFrames: action.durationFrames,
            }),
          );
          // A reveal clones the definition. Creation references keep following
          // their clip so a later fine-tuning action edits its current motion.
          const currentMotionId = clip(clipId).motionId!;
          for (const [name, value] of aliases)
            if (value === clipId && aliases.has(`${name}.motion`))
              aliases.set(`${name}.motion`, currentMotionId);
          break;
        }
        case "motion.svg":
        case "motion.vector": {
          const source =
            action.type === "motion.svg"
              ? parseEditableSvg(action.svg)
              : {
                  viewBox: action.viewBox,
                  width: action.viewBox[2],
                  height: action.viewBox[3],
                  layers: [
                    {
                      type: "path",
                      name: "Vector path",
                      vectorPath:
                        action.path ??
                        pointsToVectorPath(action.points!, {
                          closed: action.closed,
                        }),
                      vectorViewBox: action.viewBox,
                      vectorTransform: action.transform,
                      vectorFillRule: action.fillRule,
                      vectorLineCap: "round",
                      vectorLineJoin: "round",
                      vectorAspectRatio: "meet",
                      background: action.fill ?? "transparent",
                      stroke: action.stroke ?? "#ffffff",
                      strokeWidth: action.strokeWidth ?? 3,
                      fillOpacity: 1,
                      opacity: 1,
                    } as VectorPathDefinition,
                  ],
                };
          if (source.warnings?.length)
            warnings.push(
              ...source.warnings.map((w) => `actions[${index}]: ${w}`),
            );
          const created = createVectorScene(
            working,
            toFrame(action.at, working.fps),
            source,
            { name: action.name, width: action.width, height: action.height },
          );
          run(created.commands);
          remember(action.ref, created.clip.id);
          remember(
            action.ref ? `${action.ref}.motion` : undefined,
            created.motion.id,
          );
          break;
        }
        case "clip.add": {
          const asset = action.assetId
            ? working.assets.find((a) => a.id === resolve(action.assetId!))
            : undefined;
          if (["video", "audio", "image"].includes(action.kind) && !asset)
            throw Error("Choose an imported asset for a media clip.");
          if (asset && action.kind === "image" && asset.kind !== "image")
            throw Error("Image clips require an image asset.");
          if (asset && action.kind === "video" && asset.kind !== "video")
            throw Error("Video clips require a video asset.");
          if (asset && action.kind === "audio" && asset.kind === "image")
            throw Error("Audio clips require audio or video media.");
          const kind =
            action.kind === "audio"
              ? "audio"
              : action.kind === "text" || action.kind === "caption"
                ? "text"
                : "video";
          const destination = action.trackId
            ? track(action.trackId)
            : (working.tracks.find((t) => t.kind === kind && !t.hidden) ??
              newTrack(working, kind));
          if (!compatibleTrack({ kind: action.kind }, destination))
            throw Error("The clip kind does not match its destination track.");
          const created = ClipSchema.parse({
            ...makeClip(
              working,
              action.kind,
              destination.id,
              action.at ? toFrame(action.at, working.fps) : 0,
              asset,
            ),
            ...resolvePatch(action.patch ?? {}),
            ...(action.duration
              ? { duration: toFrame(action.duration, working.fps) }
              : {}),
          });
          if (created.kind !== action.kind)
            throw Error("Set the clip kind in clip.add rather than its patch.");
          if (created.trackId === destination.id) {
            if (!compatibleTrack(created, destination))
              throw Error(
                "The clip kind does not match its destination track.",
              );
          } else checkDestination(created, created.trackId);
          const commands: Command[] = [];
          if (!working.tracks.some((t) => t.id === destination.id))
            commands.push({ type: "track.add", track: destination });
          commands.push({ type: "clip.add", clip: created });
          // The new track is validated together with the new clip.
          run(commands);
          remember(action.ref, created.id);
          break;
        }
        case "clip.update": {
          const c = clip(action.clipId),
            patch = resolvePatch(action.patch);
          checkDestination(
            { kind: patch.kind ?? c.kind },
            patch.trackId ?? c.trackId,
          );
          run([{ type: "clip.update", id: c.id, patch }]);
          break;
        }
        case "clip.split": {
          const c = clip(action.clipId),
            at = toFrame(action.at, working.fps);
          const before = new Set(working.clips.map((c) => c.id));
          run([{ type: "clip.split", id: c.id, frame: at }]);
          const right = working.clips.find(
            (part) =>
              !before.has(part.id) &&
              part.kind === c.kind &&
              part.trackId === c.trackId &&
              part.start === at,
          );
          if (!right)
            throw Error("The split did not produce a right-hand clip.");
          remember(action.rightRef, right.id);
          break;
        }
        case "clip.trim": {
          const c = clip(action.clipId);
          const start = action.start
            ? toFrame(action.start, working.fps)
            : c.start;
          const end = action.end
            ? toFrame(action.end, working.fps)
            : c.start + c.duration;
          if (end <= start)
            throw Error("A trim must retain at least one frame.");
          let trimmed = action.end ? trimClip(working, c, "right", end) : c;
          if (action.start) trimmed = trimClip(working, trimmed, "left", start);
          if (
            trimmed.start !== start ||
            trimmed.start + trimmed.duration !== end
          )
            warnings.push(
              `Trim for ${c.id} was bounded to available source frames: ${trimmed.start}–${trimmed.start + trimmed.duration}.`,
            );
          const { id: ignored, ...patch } = trimmed;
          run([
            { type: "clip.update", id: c.id, patch },
            ...linkedCaptionCommands(working, c, trimmed, "trim"),
          ]);
          break;
        }
        case "clip.move": {
          const c = clip(action.clipId),
            start = toFrame(action.at, working.fps),
            delta = start - c.start;
          const trackId = action.trackId
            ? checkDestination(c, action.trackId)
            : c.trackId;
          const commands: Command[] = [
            { type: "clip.update", id: c.id, patch: { start, trackId } },
          ];
          if (action.followCaptions)
            for (const caption of working.clips.filter(
              (part) => part.captionSourceId === c.id,
            ))
              commands.push({
                type: "clip.update",
                id: caption.id,
                patch: { start: caption.start + delta },
              });
          run(commands);
          break;
        }
        case "clip.duplicate": {
          const c = clip(action.clipId),
            start = toFrame(action.at, working.fps);
          const duplicated = {
            ...structuredClone(c),
            id: uid(),
            start,
            trackId: action.trackId
              ? checkDestination(c, action.trackId)
              : c.trackId,
            transition: undefined,
          };
          const commands: Command[] = [{ type: "clip.add", clip: duplicated }];
          if (action.followCaptions)
            for (const caption of working.clips.filter(
              (part) => part.captionSourceId === c.id,
            ))
              commands.push({
                type: "clip.add",
                clip: {
                  ...structuredClone(caption),
                  id: uid(),
                  captionSourceId: duplicated.id,
                  start: caption.start + start - c.start,
                },
              });
          run(commands);
          remember(action.ref, duplicated.id);
          break;
        }
        case "clip.delete": {
          const c = clip(action.clipId);
          const captions = action.deleteCaptions
            ? working.clips.filter((part) => part.captionSourceId === c.id)
            : [];
          if (action.ripple) {
            const { shift, short } = rippleShifts(
              working,
              c,
              new Set(captions.map((caption) => caption.id)),
            );
            const seconds = (frames: number) =>
              `${Number((frames / working.fps).toFixed(2))} s`;
            for (const { track, moved } of short)
              warnings.push(
                moved
                  ? `Track "${track.name}" moved back ${seconds(moved)}, not ${seconds(shift)}: any further would overlap the clip before it.`
                  : `Track "${track.name}" did not move: moving it back would overlap the clip before it.`,
              );
          }
          run([
            ...captions.map((caption) => ({
              type: "clip.delete" as const,
              id: caption.id,
              ripple: false,
            })),
            {
              type: "clip.delete",
              id: c.id,
              ripple: action.ripple,
              deleteCaptions: action.deleteCaptions,
            },
          ]);
          break;
        }
        case "clip.keyframe": {
          const c = clip(action.clipId);
          const old = c.keyframes.find(
            (k) =>
              k.property === action.property &&
              k.frame === action.frame + c.animationOffset,
          );
          run([
            {
              type: "clip.keyframe",
              id: c.id,
              property: action.property,
              frame: action.frame,
              value: action.value ?? c[action.property],
              easing: action.easing ?? old?.easing ?? "ease-in-out",
              bezier: action.bezier ?? old?.bezier,
              remove: action.remove,
            },
          ]);
          break;
        }
        case "clip.transition":
          run([
            {
              type: "clip.transition",
              id: clip(action.clipId).id,
              kind: action.kind,
              frames: action.frames,
            },
          ]);
          break;
        case "motion.scene":
        case "motion.shape": {
          const at = toFrame(action.at, working.fps);
          const created =
            action.type === "motion.scene"
              ? createMotionScene(working, at, action.scene, {
                  durationFrames: action.durationFrames,
                })
              : createShapeLayer(working, at, action.shape);
          run(created.commands);
          remember(action.ref, created.clip.id);
          remember(
            action.ref ? `${action.ref}.motion` : undefined,
            created.motion.id,
          );
          break;
        }
        case "motion.recipe": {
          const created = createMotionRecipe(
            working,
            toFrame(action.at, working.fps),
            action,
          );
          run(created.commands);
          warnings.push(...created.warnings);
          remember(action.ref, created.clip.id);
          remember(
            action.ref ? `${action.ref}.motion` : undefined,
            created.motion.id,
          );
          break;
        }
        case "audio.duck": {
          const music = clip(action.musicClipId);
          const ducked = duckClipVolume(working, {
            ...action,
            musicClipId: music.id,
            speechClipIds: action.speechClipIds.map((value) => clip(value).id),
          });
          warnings.push(...ducked.warnings);
          run([
            {
              type: "clip.update",
              id: music.id,
              patch: { keyframes: ducked.keyframes },
            },
          ]);
          break;
        }
        case "motion.put": {
          const definition = {
            ...action.motion,
            id: resolve(action.motion.id),
          };
          const commands: Command[] = [
            { type: "motion.put", motion: definition },
          ];
          if (action.clipId) {
            const c = clip(action.clipId);
            if (c.kind !== "text" && c.kind !== "caption")
              throw Error(
                "Attach motion definitions to a text or caption clip.",
              );
            commands.push({
              type: "clip.update",
              id: c.id,
              patch: { preset: "custom", motionId: definition.id },
            });
          }
          run(commands);
          remember(action.ref, definition.id);
          break;
        }
        case "motion.layer.add":
        case "motion.layer.update":
        case "motion.layer.delete":
        case "motion.layer.move":
        case "motion.keyframe":
        case "motion.keyframe.move": {
          const m = motion(action.motionId);
          if (action.type === "motion.layer.add") {
            const index = action.index ?? m.layers.length;
            if (index > m.layers.length)
              throw Error(
                "Insert the layer at an existing index or append it.",
              );
            m.layers.splice(
              index,
              0,
              MotionLayerSchema.parse(action.definition),
            );
          } else {
            const l = checkedLayer(m, action.layer);
            if (action.type === "motion.layer.update")
              m.layers[action.layer] = MotionLayerSchema.parse({
                ...l,
                ...action.patch,
              });
            if (action.type === "motion.layer.delete")
              m.layers.splice(action.layer, 1);
            if (action.type === "motion.layer.move") {
              checkedLayer(m, action.to);
              m.layers.splice(
                action.to,
                0,
                m.layers.splice(action.layer, 1)[0],
              );
            }
            if (action.type === "motion.keyframe") {
              if (action.remove)
                l.keyframes = l.keyframes
                  .map((k) => {
                    if (k.frame !== action.frame) return k;
                    const next = { ...k };
                    delete next[action.property];
                    return next;
                  })
                  .filter((k) =>
                    motionProperties.some((p) => k[p] !== undefined),
                  );
              else {
                const previous = [...l.keyframes]
                  .reverse()
                  .find(
                    (k) =>
                      k.frame === action.frame &&
                      k[action.property] !== undefined,
                  );
                const easing =
                  action.easing ?? previous?.easing ?? "ease-in-out";
                const bezier = action.bezier ?? previous?.bezier;
                KeyframeSchema.parse({
                  frame: action.frame,
                  [action.property]: action.value,
                  easing,
                  bezier,
                });
                const keys = upsertMotionKey(
                  l,
                  action.property,
                  action.frame,
                  action.value!,
                  easing,
                  bezier,
                );
                if (!keys)
                  throw Error("This layer has reached its 100-key limit.");
                l.keyframes = keys;
              }
            }
            if (action.type === "motion.keyframe.move") {
              const keys = moveMotionKey(
                l,
                action.property,
                action.fromFrame,
                action.toFrame,
              );
              if (!keys)
                throw Error(
                  "Cannot move this motion key: choose an existing source key, an unoccupied destination for this property, and stay within the 100-key limit.",
                );
              l.keyframes = keys;
            }
          }
          run([{ type: "motion.put", motion: m }]);
          break;
        }
        case "caption.update": {
          const c = clip(action.clipId);
          if (c.kind !== "caption")
            throw Error("Caption edits require a caption clip.");
          const corrected =
            action.text !== undefined
              ? captionTextPatch(c, action.text)
              : undefined;
          if (corrected?.timing === "cleared")
            warnings.push(
              `Caption ${c.id} word timing was cleared because its word count changed.`,
            );
          run([
            {
              type: "clip.update",
              id: c.id,
              patch: { ...action.patch, ...corrected?.patch },
            },
          ]);
          break;
        }
        case "caption.style": {
          const patch = {
            ...(action.style ? captionStylePatch(action.style, working) : {}),
            ...action.patch,
          };
          const ids = action.clipIds.map((value) => {
            const c = clip(value);
            if (c.kind !== "caption")
              throw Error("Caption styling requires caption clips.");
            return c.id;
          });
          if (Object.keys(patch).length)
            run(ids.map((id) => ({ type: "clip.update" as const, id, patch })));
          // short = one to three words per caption, re-split from word timing.
          if (action.pace)
            run(
              regroupCaptionCommands(
                working,
                working.clips.filter((c) => ids.includes(c.id)),
                action.pace,
              ).commands,
            );
          break;
        }
        case "caption.import": {
          const captions = srtCaptionClips(
            working,
            action.srt,
            action.at ? toFrame(action.at, working.fps) : 0,
          );
          if (!captions.length)
            throw Error("No valid subtitle cues were found.");
          if (action.trackId)
            for (const c of captions)
              c.trackId = checkDestination(c, action.trackId);
          run(captions.map((c) => ({ type: "clip.add" as const, clip: c })));
          break;
        }
        case "track.add": {
          const created = {
            ...newTrack(working, action.kind),
            ...(action.name ? { name: action.name } : {}),
          };
          run([{ type: "track.add", track: created }]);
          remember(action.ref, created.id);
          break;
        }
        case "track.update": {
          const t = track(action.trackId),
            kind = action.patch.kind ?? t.kind;
          if (
            working.clips.some(
              (c) => c.trackId === t.id && !compatibleTrack(c, { ...t, kind }),
            )
          )
            throw Error("Changing track kind would strand incompatible clips.");
          run([{ type: "track.update", id: t.id, patch: action.patch }]);
          break;
        }
        case "track.move": {
          const t = track(action.trackId);
          if (action.direction)
            run([
              { type: "track.move", id: t.id, direction: action.direction },
            ]);
          else {
            if (action.index! >= working.tracks.length)
              throw Error("The destination track index is outside the stack.");
            const tracks = [...working.tracks];
            tracks.splice(
              action.index!,
              0,
              tracks.splice(
                tracks.findIndex((other) => other.id === t.id),
                1,
              )[0],
            );
            working = validateProject({ ...working, tracks });
          }
          break;
        }
        case "track.delete": {
          const t = track(action.trackId),
            clips = working.clips.filter((c) => c.trackId === t.id);
          if (clips.length && !action.deleteClips)
            throw Error(
              "This track contains clips. Set deleteClips only when removing them too.",
            );
          const removedIds = new Set(clips.map((c) => c.id));
          working = validateProject({
            ...working,
            tracks: working.tracks.filter((other) => other.id !== t.id),
            clips: working.clips.filter(
              (c) =>
                c.trackId !== t.id && !removedIds.has(c.captionSourceId ?? ""),
            ),
          });
          break;
        }
        case "project.update": {
          const { width, height, ...rest } = action.patch;
          // A new canvas size reflows every clip and layer onto it, as the
          // aspect ratio menu does, instead of leaving them off the frame.
          if (
            (width ?? working.width) !== working.width ||
            (height ?? working.height) !== working.height
          )
            run(
              resizeCanvas(
                working,
                width ?? working.width,
                height ?? working.height,
              ),
            );
          if (Object.keys(rest).length)
            run([{ type: "project.update", patch: rest }]);
          break;
        }
        case "command": {
          const command = structuredClone(action.command);
          if ("id" in command) command.id = resolve(command.id);
          if (command.type === "clip.update")
            command.patch = resolvePatch(command.patch);
          if (command.type === "clip.add")
            command.clip = { ...command.clip, ...resolvePatch(command.clip) };
          if (command.type === "motion.put")
            command.motion.id = resolve(command.motion.id);
          run([command]);
          break;
        }
      }
    } catch (error) {
      throw Error(
        `Action ${index + 1} (${action.type}): ${(error as Error).message}`,
      );
    }
  }
  // A dry run proposes a project at the live revision: committing the same
  // actions uses that revision, never one that does not exist yet.
  try {
    working = validateProject({
      ...working,
      revision: input.dryRun ? project.revision : project.revision + 1,
    });
  } catch (error) {
    if (!checkEach) throw new UncheckedEditError((error as Error).message);
    throw error;
  }
  const changes = <T extends { id: string }>(before: T[], after: T[]) => {
    const old = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
    return [
      ...new Set([
        ...after
          .filter((item) => old.get(item.id) !== JSON.stringify(item))
          .map((item) => item.id),
        ...before
          .filter((item) => !after.some((next) => next.id === item.id))
          .map((item) => item.id),
      ]),
    ];
  };
  const objects = [
    ...working.clips.map((item) => ({ id: item.id, kind: "clip" as const })),
    ...working.motions.map((item) => ({
      id: item.id,
      kind: "motion" as const,
    })),
    ...working.tracks.map((item) => ({ id: item.id, kind: "track" as const })),
  ];
  const oldIds = new Set(
    [...project.clips, ...project.motions, ...project.tracks].map(
      (item) => item.id,
    ),
  );
  // Named layers of new motions (recipes, logos, imported vectors) are listed
  // by index, so the next edit can target them without inspecting.
  let named = 0;
  const layerNames = (id: string) => {
    const created = working.motions.find((item) => item.id === id);
    if (!created?.layers.some((layer) => layer.name) || named >= 10)
      return undefined;
    named++;
    return created.layers.map((layer) =>
      (layer.name ?? layer.type).slice(0, 40),
    );
  };
  return {
    project: working,
    label: input.label,
    dryRun: input.dryRun,
    created: objects
      .filter((item) => !oldIds.has(item.id))
      .map((item) => {
        const layers = item.kind === "motion" ? layerNames(item.id) : undefined;
        return {
          ...item,
          ref: [...aliases].find(([, value]) => value === item.id)?.[0],
          ...(layers ? { layers } : {}),
        };
      }),
    references: Object.fromEntries(aliases),
    summary: {
      actionCount: input.actions.length,
      changedClipIds: changes(project.clips, working.clips),
      changedMotionIds: changes(project.motions, working.motions),
      changedTrackIds: changes(project.tracks, working.tracks),
      durationBefore: duration(project),
      durationAfter: duration(working),
      warnings,
    },
  };
}

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const isTimeUnion = (node: any) =>
  Array.isArray(node?.anyOf) &&
  node.anyOf.length === 2 &&
  node.anyOf[0]?.properties?.frame !== undefined &&
  node.anyOf[1]?.properties?.seconds !== undefined;
/** A fixed-length tuple of one item type, such as a six-number transform. */
const isUniformTuple = (node: any) =>
  node?.type === "array" &&
  Array.isArray(node.prefixItems) &&
  node.prefixItems.length > 1 &&
  node.items === false &&
  node.minItems === node.prefixItems.length &&
  node.maxItems === node.prefixItems.length &&
  node.prefixItems.every(
    (item: unknown) =>
      JSON.stringify(item) === JSON.stringify(node.prefixItems[0]),
  );
/** A union of literal values, such as captionMaxLines 1 | 2: an enum says the same. */
const isConstantUnion = (node: any) =>
  Array.isArray(node?.anyOf) &&
  Object.keys(node).length === 1 &&
  node.anyOf.length > 1 &&
  node.anyOf.every(
    (option: any) =>
      option &&
      Object.keys(option).length === 2 &&
      option.const !== undefined &&
      option.type === node.anyOf[0].type,
  );

/** The color validator's pattern, read from the model so it tracks changes. */
let colorPattern: string | undefined;
const isColorPattern = (value: unknown) =>
  value ===
  (colorPattern ??= (
    z.toJSONSchema(ProjectSchema.shape.background) as { pattern?: string }
  ).pattern);
/** Bounds too loose to guide anyone: 8-hour frame caps, ID lengths, non-empty strings. */
const looseBound = (key: string, value: unknown) =>
  typeof value === "number" &&
  (((key === "maximum" || key === "maxLength" || key === "maxItems") &&
    value >= 100_000) ||
    (key === "maxLength" && value >= 200) ||
    (key === "minLength" && value <= 1));
/**
 * JSON Schema without generator noise (draft URI, safe-integer bounds).
 * compact also drops defaults, strictness markers and loose bounds and
 * shortens the {frame} | {seconds} union and color patterns, for tool
 * definitions that every turn carries.
 */
export function tidySchema(node: unknown, compact: boolean): any {
  if (Array.isArray(node)) return node.map((item) => tidySchema(item, compact));
  if (!node || typeof node !== "object") return node;
  if (compact && isTimeUnion(node))
    return { type: "object", description: "{frame} or {seconds}" };
  if (compact && isConstantUnion(node))
    return {
      type: (node as any).anyOf[0].type,
      enum: (node as any).anyOf.map((option: any) => option.const),
    };
  if (compact && isUniformTuple(node)) {
    const { prefixItems, items: _closed, ...rest } = node as any;
    return tidySchema({ ...rest, items: prefixItems[0] }, compact);
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (
      (key === "minimum" && value === -SAFE_INTEGER) ||
      (key === "maximum" && value === SAFE_INTEGER)
    )
      continue;
    if (
      compact &&
      (key === "default" ||
        (key === "additionalProperties" && value === false) ||
        looseBound(key, value))
    )
      continue;
    if (compact && key === "pattern" && isColorPattern(value)) {
      result.description = "#hex color or transparent";
      continue;
    }
    result[key] = tidySchema(value, compact);
  }
  return result;
}
/** An input JSON Schema generated from a validator: fields with defaults are optional. */
export function readableSchema(schema: z.ZodType, compact = false) {
  return tidySchema(
    z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    compact,
  );
}

type ActionOption = (typeof AgentActionSchema.options)[number];
type CommandOption = (typeof CommandSchema.options)[number];
const typeOf = (option: ActionOption | CommandOption) =>
  String(option.shape.type.value);
/** Still accepted from older clients; cutline_apply_edits is the low-level path. */
const unadvertisedActions = new Set(["command"]);
const advertisedActions = () =>
  AgentActionSchema.options.filter(
    (option) => !unadvertisedActions.has(typeOf(option)),
  );
/** "clipId, at, trackId?": a field list for one action or command, optional fields marked. */
function fieldList(option: ActionOption | CommandOption) {
  return Object.entries(option.shape as Record<string, z.ZodType>)
    .filter(([name]) => name !== "type")
    .map(([name, schema]) =>
      schema.safeParse(undefined).success ? `${name}?` : name,
    )
    .join(", ");
}

/** One validator per cutline_editing_schema section. */
const schemaSections: Record<string, () => z.ZodType> = {
  explainer: () => ExplainerInputSchema,
  story: () => StoryPlanSchema,
  storyScene: () => StorySceneSchema,
  clip: () => ClipSchema,
  clipPatch: () => AgentClipPatchSchema,
  captionPatch: () => captionPatch,
  clipKeyframe: () => PropertyKeyframeSchema,
  motion: () => MotionSchema,
  motionLayer: () => MotionLayerSchema,
  motionLayerPatch: () => AgentMotionLayerPatchSchema,
  motionKeyframe: () => KeyframeSchema,
  track: () => TrackSchema,
  trackPatch: () => trackPatch,
  asset: () => AssetSchema,
  project: () => ProjectSchema,
  projectPatch: () => projectPatch,
  time: () => AgentTimeSchema,
  transaction: () => TransactionSchema,
};
export const editingSchemaSections = [
  "workflow",
  "guide",
  "actions",
  "commands",
  "motionRecipes",
  ...Object.keys(schemaSections),
];

/** The short guide: rules, the action list and value lists, without schemas. */
export function agentEditingGuide() {
  const clip = ClipSchema.shape,
    layer = MotionLayerSchema.shape;
  const transition = AgentActionSchema.options.find(
    (option) => typeOf(option) === "clip.transition",
  )!.shape as Record<string, z.ZodType>;
  return {
    version: 2,
    sections: `This is the short guide. For every field, bound and default of one part, call cutline_editing_schema with section set to one of ${editingSchemaSections.join(", ")}, or action:<type> for one action (for example action:clip.update).`,
    workflow:
      "Inspect first. Send the exact current projectId and revision. cutline_edit applies all actions as one undoable step; dryRun checks the whole edit and returns the same summary without changing anything. Then commit with the same revision. After the edit, inspect only what you need and check it with cutline_preview images.",
    canvas:
      "x, y, width and height are canvas pixels, and x/y place the top-left corner of a clip or layer, not its center. To center something W wide, set x = (project width - W) / 2. For a centered title, give the text clip the frame's width (x 0) and align center. project.update width/height rescales every clip and layer onto the new canvas.",
    timing: {
      timeline:
        "at/start/end accept {frame} or {seconds}; seconds round to the project fps. End times are exclusive. Source media sourceIn and word timestamps are seconds; word timestamps are clip-relative. project.update fps (24, 25, 30 or 60) works only while the timeline is empty, so set it before adding clips.",
      clips:
        "clip.keyframe.frame is clip-relative and automatically includes animationOffset. Split/trim preserve existing animation phase. Semantic clip.move/duplicate follows linked captions by default; clip.trim bounds linked captions; clip.delete deletes linked captions by default. Ripple deletion closes the gap on the clip's track; other tracks move back as far as they can without overlapping. reverse=true plays a video or audio clip backwards from a reversed copy Cutline makes on this Mac (export waits for it); its sourceIn then counts from the end of the source, and switching reverse with clip.update and no sourceIn keeps the same footage, so the usual way is to place the clip forward, then set reverse. freeze=true holds the clip's first frame, silently, for its whole duration, which may run past the source. Reversed and held clips have no captions, pause removal or beat sync.",
      motion:
        "motion.keyframe.frame and motion.keyframe.move fromFrame/toFrame are motion curve frames, including loop endpoints; they do not add a clip animationOffset. Key moves preserve the selected property's easing and Bezier handles and leave sibling curves unchanged. An occupied destination for that property rejects the whole transaction. Layers and track indices start at 0. Last motion layer is on top; track index 0 is topmost. Motion x/y keys are movement offsets from layer placement. Other curves override static values. Easing belongs to the outgoing key segment; cubic-bezier accepts bezier=[x1,y1,x2,y2], x in 0..1 and y in -2..3. Duplicate keys use the last specified value per property. motion.scene.durationFrames retimes choreography; leaving it out uses four seconds. Typography overrides and masked line-reveal timing are editable per layer. Layer name is optional and limited to 80 characters; hidden=true keeps the layer editable but excludes it from rendering and music accents. musicAccent=false keeps a graphical layer steady in accents mode.",
      references:
        "Creation ref aliases are used as $name in later IDs. motion.scene/shape/recipe creates $name for its clip and $name.motion for its motion. clip.split rightRef names its right-hand clip. References are scoped to one transaction; the result lists the IDs they became, and a created motion with named layers lists their names by index.",
    },
    recipes:
      "motion.recipe builds a finished, editable graphic in one action: kinetic-title, lower-third, callout, end-card or logo-sting. text is the main line and subtitle the second (role, detail, call to action or tagline). Entrances ease out with 2 to 4 frame staggers, text holds at least 1.5 seconds at the default length and exits ease in on the last frames. style clean (default), bold or minimal; position is one of nine anchors; callout takes point {x, y} in canvas pixels; colors {text, accent, panel, background}; durationFrames stretches the hold. Tweak the named layers afterwards with motion.layer.update and motion.keyframe on $ref.motion. Section motionRecipes lists each recipe's layers and defaults.",
    media:
      "Media tools work beside cutline_edit, each as one undoable edit that needs the current projectId and revision: cutline_stock_import {id, provider?, kind?, at?, duration?, trackId?} downloads a cutline_stock_search result with its credits and, with at, places muted B-roll; cutline_voiceover {text, voice?, speed?, name?, at?, trackId?} makes Kokoro narration on this Mac; cutline_auto_edit {assetId or path, options?} replaces the timeline with an automatic Reel; cutline_relink {assetId, path} fixes moved media. Use the assetId or clipId they return in later actions, for example audio.duck with the voiceover's clipId.",
    audio:
      "audio.duck lowers a music clip under voice clips in one undoable action. by words (default) follows each spoken phrase in the transcript, and a clip without a transcript ducks for its whole span; by clips uses the whole span. depthDb defaults to -14 (12 to 18 dB under speech reads well), attackFrames to 0.2 s before speech and releaseFrames to 0.3 s after it; pauses under about 0.75 s stay ducked. level is the volume outside speech: by default the clip's volume, or its loudest earlier volume key. It replaces the clip's earlier volume keys, so ducking again with a new depth starts over. Volume is linear: 0.5 is about -6 dB, 0.25 about -12 dB, 0.1 is -20 dB.",
    music:
      "Use cutline_music_create/analyze/grid/inspect/sync/reactive. Rhythm belongs to source audio; beats map through the music clip start, sourceIn and speed. clip.musicReactive binds visual pulse to a placed audio clip; scope=accents responds only on graphical motion accents, leaving headline and full-frame backgrounds steady. Use restrained strength for Signature and Studio scenes. Missing music bindings remain inert. Defaults protect spoken clips from cut syncing; dryRun shows proposed commands. Captions follow their owned source clips.",
    limits: {
      actions: 500,
      motionLayers: MAX_VECTOR_LAYERS,
      motionKeys: 100,
      clipKeys: 2000,
    },
    actions: Object.fromEntries(
      advertisedActions().map((option) => [typeOf(option), fieldList(option)]),
    ),
    clipProperties: propertyBounds,
    motionProperties: motionPropertyBounds,
    values: {
      fonts: enumOptions(clip.fontFamily),
      fontWeights: enumOptions(clip.fontWeight),
      layerFontWeight: "100 to 900, per motion layer",
      looks: enumOptions(clip.look),
      presets: enumOptions(clip.preset),
      cameraMotion: enumOptions(clip.cameraMotion),
      overlays: enumOptions(clip.overlay),
      blendModes: enumOptions(clip.blendMode),
      masks: enumOptions(clip.mask),
      exitAnimations: enumOptions(clip.exitAnimation),
      transitions: enumOptions(transition.kind),
      clipEasings: enumOptions(PropertyKeyframeSchema.shape.easing),
      motionEasings: [...motionEasings],
      layerTypes: enumOptions(layer.type),
      textAnimations: enumOptions(layer.textAnimation),
      loops: enumOptions(layer.loop),
      shapeTypes: [...shapeTypes],
      captionStyles: captionStyles.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
      motionScenes: motionScenes.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
      motionRecipes: motionRecipes.map(({ id, name, seconds, layers }) => ({
        id,
        name,
        seconds,
        layers,
      })),
      recipeStyles: [...motionRecipeStyles],
      recipePositions: [...motionRecipePositions],
    },
  };
}

/** One section of the editing schema, with every field, bound and default. */
export function editingSchemaSection(section: string): unknown {
  // External clients keep only the start of the server instructions.
  if (section === "workflow") return { workflow: cutlineWorkflow };
  if (section === "guide") return agentEditingGuide();
  if (section === "motionRecipes") return motionRecipeCatalog();
  if (section === "actions")
    return Object.fromEntries(
      advertisedActions().map((option) => [typeOf(option), fieldList(option)]),
    );
  if (section === "commands")
    return Object.fromEntries(
      CommandSchema.options.map((option) => [
        typeOf(option),
        fieldList(option),
      ]),
    );
  if (schemaSections[section]) return readableSchema(schemaSections[section]());
  const [kind, type] = section.split(/:(.*)/s);
  const option =
    kind === "action"
      ? AgentActionSchema.options.find((item) => typeOf(item) === type)
      : kind === "command"
        ? CommandSchema.options.find((item) => typeOf(item) === type)
        : undefined;
  if (option) return readableSchema(option);
  throw Error(
    `Unknown section "${section}". Use one of ${editingSchemaSections.join(", ")}, action:<type> (${advertisedActions().map(typeOf).join(", ")}) or command:<type>.`,
  );
}

export const EditingSchemaArgsSchema = z.strictObject({
  section: z.string().trim().min(1).max(100).optional(),
});
/** cutline_editing_schema: the short guide, or one section when asked. */
export function agentEditingSchema(raw: unknown = {}) {
  const { section } = EditingSchemaArgsSchema.parse(raw ?? {});
  if (!section || section === "guide") return agentEditingGuide();
  return { section, schema: editingSchemaSection(section) };
}

/** Every schema at once. Far too large for one tool result; tests and docs use it. */
export function agentEditingSchemas() {
  return {
    edit: readableSchema(AgentEditSchema),
    action: readableSchema(AgentActionSchema),
    command: readableSchema(CommandSchema),
    ...Object.fromEntries(
      Object.entries(schemaSections).map(([name, schema]) => [
        name,
        readableSchema(schema()),
      ]),
    ),
  } as Record<string, any>;
}

const described = (description: string) => ({ type: "object", description });
/** Nested definitions described once in tools/list; sections hold the full versions. */
const actionStubs: Record<string, Record<string, object>> = {
  "clip.add": {
    patch: described("Fields for the new clip: same as clip.update patch."),
  },
  "motion.layer.add": {
    definition: described(
      "A layer: type plus any motion.layer.update patch fields. Section motionLayer lists every field.",
    ),
  },
  "motion.put": {
    motion: described(
      "{id, name, layers[]}; each layer is a motion.layer.add definition. Prefer motion.scene or motion.shape, then layer edits.",
    ),
  },
  "caption.update": {
    patch: described(
      "Caption appearance fields. Read section captionPatch for exact fields and bounds.",
    ),
  },
  "caption.style": {
    patch: described("Caption appearance fields. Read section captionPatch."),
  },
  "motion.recipe": {
    point: described(
      "Callout only: {x, y}, the spot to mark in canvas pixels.",
    ),
    colors: described("{text, accent, panel, background}: #hex colors."),
  },
};
/** Patch fields with their own actions; still accepted, not advertised. */
const ownActions: Record<
  string,
  { field: string; omit: string[]; note: string }
> = {
  "clip.update": {
    field: "patch",
    omit: ["keyframes", "words", "transition", "musicReactive"],
    note: "Clip fields to change. Keyframes, transitions and music pulses have their own actions (clip.keyframe, clip.transition, cutline_music_reactive).",
  },
  "motion.layer.update": {
    field: "patch",
    omit: ["keyframes"],
    note: "Layer fields to change. Keys have their own actions (motion.keyframe, motion.keyframe.move).",
  },
};
/** cutline_edit's input schema: every action and field, nested definitions described once. */
export function agentEditInputSchema() {
  return {
    type: "object" as const,
    properties: {
      projectId: { type: "string" },
      revision: {
        type: "integer",
        minimum: 0,
        description: "Current revision from cutline_inspect or the last edit.",
      },
      label: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Name of this step in undo history.",
      },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        description:
          "Run in order as one undoable step. A creation can set ref; later actions use $ref (and $ref.motion for scenes and shapes).",
        items: {
          oneOf: advertisedActions().map((option) => {
            const schema = readableSchema(option, true);
            for (const [field, stub] of Object.entries(
              actionStubs[typeOf(option)] ?? {},
            ))
              schema.properties[field] = stub;
            const own = ownActions[typeOf(option)];
            if (own) {
              const patch = schema.properties[own.field];
              for (const name of own.omit) delete patch.properties[name];
              patch.description = own.note;
            }
            return schema;
          }),
        },
      },
      dryRun: {
        type: "boolean",
        description:
          "Check the whole edit and summarize it without changing anything.",
      },
      detail: {
        type: "string",
        enum: ["summary", "full"],
        description:
          "full also returns every field of the changed clips and motions.",
      },
    },
    required: ["projectId", "revision", "label", "actions"],
  };
}
export const agentEditTools: Tool[] = [
  {
    name: "cutline_editing_schema",
    description:
      "Editing guide, actions, presets and keyframe bounds. Pass section (e.g. clip, motionLayer, action:clip.update) for exact fields and defaults.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: `Optional: ${editingSchemaSections.join(", ")}, action:<type> or command:<type>.`,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cutline_edit",
    description:
      "Atomic, undoable edit of clips, motion, vectors, keyframes, transitions, captions, audio ducking, tracks and settings. Read cutline_editing_schema for actions and recipes. Requires current projectId/revision; returns revision, created IDs and summary. dryRun validates without edits.",
    inputSchema: agentEditInputSchema() as Tool["inputSchema"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];
