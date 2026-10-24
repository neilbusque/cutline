import path from "node:path";
import { z } from "zod";
import {
  RhythmSchema,
  MusicReactiveSchema,
  makeClip,
  publicRhythm,
  type Project,
} from "../shared/model";
import {
  manualBeatGrid,
  beatFrames,
  syncClipTiming,
} from "../shared/music-sync";
import { newTrack } from "../shared/layers";
import { analyzeMusicFile } from "./music-analysis";
import { createMusicBed } from "./music";
import type { Store } from "./store";
import type { Media, Jobs } from "./media";
import { sameOpening } from "./edit-jobs";
import { isMotionAccentLayer } from "../shared/motion";

const guard = {
  projectId: z.string(),
  revision: z.number().int().nonnegative(),
};
const source = { ...guard, musicClipId: z.string() };
const schemas = {
  analyze: z.object(source).strict(),
  grid: z
    .object({
      ...source,
      bpm: z.number().finite().min(20).max(300),
      offsetSeconds: z.number().finite().nonnegative().default(0),
    })
    .strict(),
  sync: z
    .object({
      ...source,
      clipIds: z.array(z.string()).min(1).max(1000),
      mode: z.enum(["cuts", "starts"]).default("cuts"),
      subdivision: z.enum(["beat", "bar"]).default("beat"),
      maxShiftFrames: z.number().int().min(0).max(1800).optional(),
      allowAudibleVideo: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    })
    .strict(),
  reactive: z
    .object({
      ...source,
      clipIds: z.array(z.string()).min(1).max(1000),
      mode: z.enum(["beat", "energy"]).default("beat"),
      style: z.enum(["scale", "glow", "both"]).default("both"),
      amount: z.number().finite().min(0).max(1).default(0.35),
      releaseFrames: z.number().int().min(1).max(600).optional(),
      scope: z.enum(["clip", "accents"]).optional(),
      remove: z.boolean().default(false),
    })
    .strict(),
  create: z
    .object({
      ...guard,
      style: z.enum(["clean", "bold", "cinematic"]).default("bold"),
      seconds: z.number().finite().min(1).max(180),
      startFrame: z.number().int().nonnegative().default(0),
    })
    .strict(),
  inspect: z
    .object({
      musicClipId: z.string(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(1000).default(500),
    })
    .strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  analyze:
    "Analyze local beats/confidence/energy, first 20 minutes. Saves editable source timing; grid corrects tempo/phase. Undoable.",
  grid: "Set source BPM/first-beat offset; anchors four-beat bars, preserves measured energy. Undoable.",
  sync: "Align visual starts/cuts to beats/bars; keeps edges/source bounds/linked captions. Max shift defaults to 0.4s; audible video requires allowance. Remove transitions first; use dryRun before editing.",
  reactive:
    "Pulse selected clips to music. accents requires native motion, preserves text/backgrounds; clip pulses all. Omitted scope/decay stay unchanged. Follows trims/speed/mute/fades; remove clears. Undoable.",
  create:
    "Compose/place local instrumental with BPM/energy. No external service or samples. Undoable.",
  inspect:
    "Read placed music tempo/confidence/source beats/timeline frames. Page with offset/limit (default 500, max 1000). Omits raw audio/energy.",
};
export const musicTools = Object.entries(schemas).map(([action, schema]) => ({
  name: `cutline_music_${action}`,
  description: descriptions[action as keyof typeof schemas],
  inputSchema: z.toJSONSchema(schema),
  annotations: {
    readOnlyHint: action === "inspect",
    destructiveHint: false,
    openWorldHint: false,
  },
}));

export function createMusicControl({
  store,
  media,
  jobs,
  directory,
}: {
  store: Store;
  media: Media;
  jobs: Jobs;
  directory: string;
}) {
  const assertRevision = (a: any) => {
    if (
      a.projectId !== store.project.id ||
      a.revision !== store.project.revision
    )
      throw Error("Project changed. Inspect the project and retry.");
  };
  /**
   * Slow work (composing, analysis) lands on the project as it is when it
   * finishes, so edits made meanwhile are kept.
   */
  const current = (opening: string, what: string) => {
    sameOpening(store, opening, what);
    return store.project;
  };
  const sourceClip = (p: Project, id: string) => {
    const clip = p.clips.find((c) => c.id === id);
    const asset = p.assets.find((a) => a.id === clip?.assetId);
    if (!clip || clip.kind !== "audio" || !asset)
      throw Error("Choose a placed music audio clip.");
    return { clip, asset };
  };
  return async (name: string, raw: unknown) => {
    const action = name.replace(
      /^cutline_music_|^music\./,
      "",
    ) as keyof typeof schemas;
    if (!schemas[action]) throw Error("Unknown music command");
    const a = schemas[action].parse(raw ?? {}) as any;
    if ("revision" in a) assertRevision(a);
    const opening = store.openSession;
    const p = store.project;
    if (action === "create") {
      const asset = await createMusicBed({
        folder: path.join(directory, "original-music"),
        seconds: a.seconds,
        style: a.style,
        media,
        jobs,
      });
      const now = current(opening, "the music was being composed");
      const track =
        now.tracks.find(
          (t) =>
            t.kind === "audio" &&
            !t.muted &&
            !now.clips.some((c) => c.trackId === t.id),
        ) ?? newTrack(now, "audio");
      const clip = {
        ...makeClip(now, "audio", track.id, a.startFrame, asset),
        duration: Math.round(asset.duration * now.fps),
        volume: 0.45,
      };
      store.commit(
        {
          ...now,
          assets: [...now.assets, asset],
          tracks: now.tracks.some((t) => t.id === track.id)
            ? now.tracks
            : [...now.tracks, track],
          clips: [...now.clips, clip],
        },
        "Compose original music",
      );
      return {
        musicClipId: clip.id,
        assetId: asset.id,
        revision: store.project.revision,
      };
    }
    if (action === "reactive" && a.remove) {
      const ids = new Set<string>(a.clipIds);
      if (ids.size !== a.clipIds.length)
        throw Error("Select each visual clip only once.");
      for (const id of ids) {
        const target = p.clips.find((c) => c.id === id);
        if (!target || !["video", "image", "text"].includes(target.kind))
          throw Error("Choose video, image or motion/text clips to pulse.");
      }
      if (
        [...ids].some((id) => p.clips.find((c) => c.id === id)?.musicReactive)
      )
        store.commit(
          {
            ...p,
            clips: p.clips.map((c) =>
              ids.has(c.id) ? { ...c, musicReactive: undefined } : c,
            ),
          },
          "Remove music pulse",
        );
      return { clipIds: [...ids], revision: store.project.revision };
    }
    const { clip, asset } = sourceClip(p, a.musicClipId);
    if (action === "inspect") {
      const frames = beatFrames(p, clip.id),
        sourceBeats = asset.rhythm?.beats ?? [];
      return {
        musicClipId: clip.id,
        sourceIn: clip.sourceIn,
        speed: clip.speed,
        start: clip.start,
        duration: clip.duration,
        muted: p.tracks.find((t) => t.id === clip.trackId)?.muted ?? false,
        rhythm: asset.rhythm
          ? {
              ...publicRhythm(asset.rhythm),
              beats: sourceBeats.slice(a.offset, a.offset + a.limit),
            }
          : null,
        beatFrames: frames.slice(a.offset, a.offset + a.limit),
        timelineBeatCount: frames.length,
        offset: a.offset,
        limit: a.limit,
        hasMore:
          Math.max(sourceBeats.length, frames.length) > a.offset + a.limit,
      };
    }
    if (action === "analyze" || action === "grid") {
      const rhythm = RhythmSchema.parse(
        action === "analyze"
          ? {
              ...(await analyzeMusicFile({
                path: asset.path,
                duration: asset.duration,
                bin: media.bin,
                jobs,
                cacheDirectory: path.join(directory, "rhythm-cache"),
              })),
              source: "detected",
            }
          : {
              ...manualBeatGrid({
                bpm: a.bpm,
                offsetSeconds: a.offsetSeconds,
                duration: Math.min(asset.duration, 1200),
              }),
              envelope: asset.rhythm?.envelope ?? { step: 0.05, values: [] },
            },
      );
      const now = current(opening, "the music was being analyzed");
      const target = now.assets.find((item) => item.id === asset.id);
      if (!target || target.path !== asset.path)
        throw Error(
          "That music was removed or replaced while it was being analyzed. Add it again and retry.",
        );
      store.commit(
        {
          ...now,
          assets: now.assets.map((item) =>
            item.id === asset.id ? { ...item, rhythm } : item,
          ),
        },
        action === "analyze" ? "Analyze music rhythm" : "Set music beat grid",
      );
      return {
        rhythm: name.startsWith("cutline_") ? publicRhythm(rhythm) : rhythm,
        revision: store.project.revision,
      };
    }
    if (action === "sync") {
      const plan = syncClipTiming(p, {
        ...a,
        maxShiftFrames: a.maxShiftFrames ?? Math.round(p.fps * 0.4),
      });
      if (!a.dryRun && plan.commands.length) store.transact(plan);
      return { ...plan, revision: store.project.revision, dryRun: a.dryRun };
    }
    if (!a.remove && !asset.rhythm)
      throw Error("Analyze the music or set its beat grid first.");
    if (a.mode === "beat" && !asset.rhythm?.beats.length)
      throw Error(
        "No beats were detected. Set a manual beat grid or choose measured energy.",
      );
    const ids = new Set<string>(a.clipIds);
    if (ids.size !== a.clipIds.length)
      throw Error("Select each visual clip only once.");
    const clips = [...ids].map((id) => {
      const target = p.clips.find((c) => c.id === id);
      if (!target || !["video", "image", "text"].includes(target.kind))
        throw Error("Choose video, image or motion/text clips to pulse.");
      if (
        a.mode === "energy" &&
        !a.remove &&
        !asset.rhythm?.envelope.values.length
      )
        throw Error("Analyze the audio first to measure its energy.");
      if ((a.scope ?? target.musicReactive?.scope) === "accents") {
        const motion =
          target.motionId &&
          p.motions.find((item) => item.id === target.motionId);
        if (
          target.kind !== "text" ||
          target.preset !== "custom" ||
          !motion ||
          !motion.layers.some((layer) => isMotionAccentLayer(layer, target))
        )
          throw Error(
            "Graphical accents require a motion scene with an editable shape or line. Choose Entire clip for this layer.",
          );
      }
      return target;
    });
    const next = {
      ...p,
      clips: p.clips.map((c) =>
        ids.has(c.id)
          ? {
              ...c,
              musicReactive: MusicReactiveSchema.parse({
                ...a,
                ...((a.scope ?? c.musicReactive?.scope) !== undefined
                  ? { scope: a.scope ?? c.musicReactive?.scope }
                  : {}),
                releaseFrames:
                  a.releaseFrames ??
                  c.musicReactive?.releaseFrames ??
                  Math.max(1, Math.round(p.fps * 0.2)),
              }),
            }
          : c,
      ),
    };
    store.commit(next, a.remove ? "Remove music pulse" : "Apply music pulse");
    return {
      clipIds: clips.map((c) => c.id),
      revision: store.project.revision,
    };
  };
}
