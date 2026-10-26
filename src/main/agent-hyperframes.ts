import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AgentTimeSchema,
  agentFrame,
  readableSchema,
} from "../shared/agent-edit";
import {
  makeClip,
  validateProject,
  type Asset,
  type Project,
} from "../shared/model";
import { newTrack } from "../shared/layers";
import { sameOpening } from "./edit-jobs";
import type { Hyperframes } from "./hyperframes";

const guarded = {
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
};
export const HyperframesArgsSchema = z
  .object({
    ...guarded,
    action: z.enum(["import", "update", "read"]),
    assetId: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(8192).optional(),
    html: z.string().min(1).max(1_000_000).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    transparent: z.boolean().optional(),
    expectedSourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    at: AgentTimeSchema.optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50_000).default(20_000),
  })
  .strict()
  .superRefine((args, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (args.action !== "read" && args.offset)
      issue("Source pagination is available only when reading a scene.");
    if (args.action !== "update" && args.expectedSourceHash)
      issue("Source version checks are available only when updating a scene.");
    if (args.action === "import") {
      if (!!args.path === !!args.html)
        issue("Import needs one local HTML path or HTML source, not both.");
      if (args.assetId) issue("Import creates a new scene; omit assetId.");
    } else {
      if (!args.assetId) issue("Choose the scene's assetId.");
      if (args.path)
        issue(
          "Update the scene's HTML source; importing another path creates a new scene.",
        );
      if (args.at) issue("Only import can place a scene on the timeline.");
      if (
        args.action === "read" &&
        (args.html || args.name || args.transparent !== undefined)
      )
        issue("Read does not change a scene.");
    }
  });

export const hyperframesTools: Tool[] = [
  {
    name: "cutline_hyperframes",
    description:
      "Import/read/update HTML scenes (GSAP/Three.js). Keeps source and local video. at places; wait on jobs.",
    inputSchema: readableSchema(HyperframesArgsSchema, true),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

type SceneStore = {
  project: Project;
  openSession: string;
  commit: (next: Project, label: string) => unknown;
};
const findScene = (project: Project, id: string) => {
  const asset = project.assets.find((item) => item.id === id);
  if (!asset?.composition || asset.composition.engine !== "hyperframes")
    throw Error("Choose a HyperFrames scene in this project.");
  return asset;
};

/** A rendered scene refresh must not invalidate any existing use of its media. */
export function assertSceneFits(
  project: Project,
  previous: Asset,
  replacement: Asset,
) {
  for (const clip of project.clips.filter(
    (item) => item.assetId === previous.id,
  )) {
    const used =
      clip.sourceIn +
      (clip.freeze ? 0 : (clip.duration / project.fps) * clip.speed);
    if (used > replacement.duration + 1 / project.fps)
      throw Error(
        `The updated scene is too short for "${previous.name}". Keep at least ${used.toFixed(2)} seconds in the source or trim that clip first.`,
      );
    // Reverse sourceIn is counted from the end. A changed duration would move
    // the selected passage even when the same numeric trim still fits.
    if (
      clip.reverse &&
      Math.abs(previous.duration - replacement.duration) > 1 / project.fps
    )
      throw Error(
        "Keep the scene's duration unchanged while it has reversed clips, or turn Reverse off first.",
      );
  }
}

/** Validated scene edits shared by the UI and every assistant. */
export function createHyperframesControl({
  store,
  renderer,
}: {
  store: SceneStore;
  renderer: Pick<Hyperframes, "render"> & {
    discard?: (asset: Asset) => Promise<void>;
    accept?: (asset: Asset) => void;
  };
}) {
  return async (raw: unknown) => {
    const args = HyperframesArgsSchema.parse(raw);
    if (
      args.projectId !== store.project.id ||
      args.revision !== store.project.revision
    )
      throw Error("Project changed. Inspect the project and retry.");
    const opening = store.openSession;
    const before = store.project;
    const previous = args.assetId ? findScene(before, args.assetId) : undefined;
    if (
      args.expectedSourceHash &&
      previous?.composition?.sourceHash !== args.expectedSourceHash
    )
      throw Error(
        "The scene changed after this source was opened. Read its current source before updating it.",
      );
    if (args.action === "read") {
      const asset = previous!;
      const { source, ...composition } = asset.composition!;
      if (args.offset > source.length)
        throw Error(
          "Source offset is beyond this scene. Start at offset 0 or follow nextOffset.",
        );
      const end = Math.min(source.length, args.offset + args.limit);
      return {
        assetId: asset.id,
        name: asset.name,
        ...composition,
        source: source.slice(args.offset, end),
        offset: args.offset,
        total: source.length,
        ...(end < source.length ? { nextOffset: end } : {}),
      };
    }
    // Validate timeline time before spending time rendering the scene.
    if (args.at) agentFrame(args.at, before.fps);
    const rendered = await renderer.render(
      {
        path: args.path,
        html: args.html,
        name: args.name,
        transparent: args.transparent,
        fps: before.fps,
      },
      previous,
    );
    let applied = false;
    try {
      sameOpening(store, opening, "the scene was rendering");
      const current = store.project;
      if (current.fps !== before.fps)
        throw Error(
          "The project frame rate changed while the scene was rendering. Render it again.",
        );
      let next: Project;
      let clipId: string | undefined;
      const asset = previous ? { ...rendered, id: previous.id } : rendered;
      if (
        !asset.composition ||
        asset.kind !== "video" ||
        !Number.isFinite(asset.duration) ||
        asset.duration <= 0
      )
        throw Error(
          "The scene did not produce a valid video. The project was kept unchanged.",
        );
      if (previous) {
        const existing = findScene(current, previous.id);
        if (
          existing.path !== previous.path ||
          existing.composition?.sourceHash !== previous.composition?.sourceHash
        )
          throw Error(
            "The scene changed while this version was rendering. Read its current source and retry.",
          );
        assertSceneFits(current, previous, asset);
        next = {
          ...current,
          assets: current.assets.map((item) =>
            item.id === previous.id ? asset : item,
          ),
        };
      } else {
        next = { ...current, assets: [...current.assets, asset] };
        if (args.at) {
          const start = agentFrame(args.at, current.fps);
          const frames = Math.max(1, Math.floor(asset.duration * current.fps));
          const free = current.tracks.find(
            (track) =>
              track.kind === "video" &&
              !track.hidden &&
              !track.muted &&
              !current.clips.some(
                (clip) =>
                  clip.trackId === track.id &&
                  clip.start < start + frames &&
                  clip.start + clip.duration > start,
              ),
          );
          const track = free ?? {
            ...newTrack(current, "video"),
            name: "Scenes",
          };
          const clip = {
            ...makeClip(current, "video", track.id, start, asset),
            duration: frames,
          };
          clipId = clip.id;
          next = {
            ...next,
            tracks: free ? next.tracks : [track, ...next.tracks],
            clips: [...next.clips, clip],
          };
        }
      }
      store.commit(
        validateProject(next),
        previous ? "Update scene" : "Import scene",
      );
      applied = true;
      renderer.accept?.(rendered);
      const uses = new Set(
        current.clips
          .filter((clip) => clip.assetId === previous?.id)
          .map((clip) => clip.id),
      );
      const hasCaptions =
        !!previous &&
        (!!previous.words?.length ||
          current.clips.some(
            (clip) => !!clip.captionSourceId && uses.has(clip.captionSourceId),
          ));
      return {
        assetId: asset.id,
        ...(clipId ? { clipId } : {}),
        name: asset.name,
        durationSeconds: asset.duration,
        revision: store.project.revision,
        sourceHash: asset.composition.sourceHash,
        transparent: asset.composition.transparent,
        ...(hasCaptions
          ? {
              warnings: [
                "Scene updated. Regenerate its captions if the speech changed.",
              ],
            }
          : {}),
      };
    } catch (error) {
      if (!applied) {
        try {
          await renderer.discard?.(rendered);
        } catch {
          /* Cleanup must not replace the original apply error. */
        }
      }
      throw error;
    }
  };
}
