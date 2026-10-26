import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AgentTimeSchema, readableSchema } from "../shared/agent-edit";
import {
  Model3DSettingsSchema,
  type Model3DSettings,
} from "../shared/model-3d";
import type { Asset, Project } from "../shared/model";
import { createHyperframesControl } from "./agent-hyperframes";
import type { Hyperframes } from "./hyperframes";

// Removing field defaults keeps a partial update from resetting untouched controls.
export const Model3DSettingsPatchSchema = z
  .object({
    durationSeconds: Model3DSettingsSchema.shape.durationSeconds
      .removeDefault()
      .optional(),
    motion: Model3DSettingsSchema.shape.motion.removeDefault().optional(),
    rotationDegrees: Model3DSettingsSchema.shape.rotationDegrees
      .removeDefault()
      .optional(),
    cameraAzimuth: Model3DSettingsSchema.shape.cameraAzimuth
      .removeDefault()
      .optional(),
    cameraElevation: Model3DSettingsSchema.shape.cameraElevation
      .removeDefault()
      .optional(),
    cameraDistance: Model3DSettingsSchema.shape.cameraDistance
      .removeDefault()
      .optional(),
    animationIndex: Model3DSettingsSchema.shape.animationIndex
      .removeDefault()
      .optional(),
    animationSpeed: Model3DSettingsSchema.shape.animationSpeed
      .removeDefault()
      .optional(),
    loop: Model3DSettingsSchema.shape.loop.removeDefault().optional(),
    exposure: Model3DSettingsSchema.shape.exposure.removeDefault().optional(),
    background: Model3DSettingsSchema.shape.background
      .removeDefault()
      .optional(),
  })
  .strict();
export const Model3DArgsSchema = z
  .object({
    projectId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    action: z.enum(["import", "read", "update"]),
    path: z.string().min(1).max(8192).optional(),
    assetId: z.string().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    settings: Model3DSettingsPatchSchema.optional(),
    transparent: z.boolean().optional(),
    expectedSourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    at: AgentTimeSchema.optional(),
  })
  .strict()
  .superRefine((args, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (args.action === "import") {
      if (!args.path) issue("Import needs a local .glb or .gltf file path.");
      if (args.assetId || args.expectedSourceHash)
        issue(
          "Import creates a new model scene; omit assetId and expectedSourceHash.",
        );
    } else {
      if (!args.assetId) issue("Choose the 3D scene's assetId.");
      if (args.path || args.at)
        issue("Only import accepts a model path or timeline placement.");
      if (
        args.action === "read" &&
        (args.name !== undefined ||
          args.settings !== undefined ||
          args.transparent !== undefined ||
          args.expectedSourceHash !== undefined)
      )
        issue("Read does not change a 3D scene.");
    }
  });
// Runtime validation keeps the bounds; the tool catalog needs only the field contract.
function modelToolSchema(node: unknown): any {
  if (Array.isArray(node)) return node.map(modelToolSchema);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(
        ([key]) =>
          !["minimum", "maximum", "minLength", "maxLength", "pattern"].includes(
            key,
          ),
      )
      .map(([key, value]) => [key, modelToolSchema(value)]),
  );
}
export const model3dTools: Tool[] = [
  {
    name: "cutline_model3d",
    description:
      "Import/read/update GLB/glTF scenes. Settings: schema model3d. at places; wait on jobs.",
    inputSchema: modelToolSchema(readableSchema(Model3DArgsSchema, true)),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

type ModelStore = {
  project: Project;
  openSession: string;
  commit: (next: Project, label: string) => unknown;
};
type ModelRenderer = Pick<Hyperframes, "render"> & {
  accept?: (asset: Asset) => void;
  discard?: (asset: Asset) => Promise<void>;
};
export function createModel3DControl({
  store,
  renderer,
}: {
  store: ModelStore;
  renderer: ModelRenderer;
}) {
  return async (raw: unknown) => {
    const args = Model3DArgsSchema.parse(raw);
    const before = store.project;
    const width = before.width,
      height = before.height;
    if (args.projectId !== before.id || args.revision !== before.revision)
      throw Error("Project changed. Inspect the project and retry.");
    const previous = args.assetId
      ? before.assets.find((asset) => asset.id === args.assetId)
      : undefined;
    if (args.assetId && !previous?.composition?.model3d)
      throw Error(
        "Choose a 3D model scene in this project. A scene with edited HTML uses Edit source instead.",
      );
    if (args.action === "read") {
      const composition = previous!.composition!;
      return {
        assetId: previous!.id,
        name: previous!.name,
        sourceHash: composition.sourceHash,
        transparent: composition.transparent,
        model3d: composition.model3d,
        revision: before.revision,
      };
    }
    const scene = createHyperframesControl({
      store,
      renderer: {
        render: async (renderArgs, oldAsset) => {
          const rendered = await renderer.render(
            {
              name: renderArgs.name,
              fps: renderArgs.fps,
              transparent: renderArgs.transparent,
              model3d: {
                path: args.path,
                width,
                height,
                settings: args.settings as Partial<Model3DSettings> | undefined,
              },
            },
            oldAsset,
          );
          if (
            store.project.width !== width ||
            store.project.height !== height
          ) {
            await renderer.discard?.(rendered);
            throw Error(
              "The project canvas changed while the model was rendering. Render it again.",
            );
          }
          return rendered;
        },
        accept: (asset) => renderer.accept?.(asset),
        discard: (asset) => renderer.discard?.(asset) ?? Promise.resolve(),
      },
    });
    const result = await scene({
      projectId: args.projectId,
      revision: args.revision,
      action: args.action,
      ...(args.action === "import"
        ? { html: "<model3d/>" }
        : {
            assetId: args.assetId,
            expectedSourceHash: args.expectedSourceHash,
          }),
      name: args.name,
      transparent: args.transparent,
      at: args.at,
    });
    const asset = store.project.assets.find(
      (item) => item.id === result.assetId,
    );
    return { ...result, model3d: asset?.composition?.model3d };
  };
}
