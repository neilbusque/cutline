import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { analyzeAutoReel, finalizeAutoReelPlan } from "../shared/auto-reel";
import { applyCommands } from "../shared/commands";
import {
  AutoReelOptionsSchema,
  resolveAutoReelOptions,
} from "../shared/auto-reel-options";
import { acquireAutoStock } from "./auto-stock";
import { createMusicBed } from "./music";
import type { Jobs, Media } from "./media";
import type { Store } from "./store";
import type { StockLibrary } from "./stock";
import type { Asset } from "../shared/model";
import type { StockProvider } from "../shared/stock";

export { AutoReelOptionsSchema };

export type AutoReelDependencies = {
  store: Store;
  media: Media;
  jobs: Jobs;
  stock: StockLibrary;
  musicFolder: string;
  provider: () => StockProvider;
};

/**
 * All preparation is private until the finished edit can commit in one Undo.
 * It starts from the revision the person clicked on, then lands on the
 * project as it is when preparation ends, so edits made meanwhile are kept.
 */
export async function buildAutoReel(raw: unknown, deps: AutoReelDependencies) {
  const args = z
    .object({
      projectId: z.string(),
      revision: z.number().int().min(0),
      path: z.string().min(1).optional(),
      assetId: z.string().min(1).optional(),
      options: AutoReelOptionsSchema.default({
        style: "bold",
        pace: "natural",
        openingTitle: false,
        broll: true,
        music: true,
      }),
    })
    .strict()
    .parse(raw);
  const options = resolveAutoReelOptions(args.options);
  if ((!args.path && !args.assetId) || (args.path && args.assetId))
    throw Error("Choose one video to edit.");
  const { store, media, jobs, stock } = deps;
  const assertCurrent = () => {
    if (
      store.project.id !== args.projectId ||
      store.project.revision !== args.revision
    )
      throw Error(
        "The project changed while the Reel was being prepared. Your current edit was kept; try again.",
      );
  };
  assertCurrent();
  const start = store.project;
  const prepared = structuredClone(start);
  const downloaded: Asset[] = [];
  return jobs.run("auto-reel", "1 of 5 · Reading your video", async (job) => {
    const check = () => {
      if (job.state === "cancelled") throw Error("Automatic edit cancelled");
      if (store.project.id !== args.projectId)
        throw Error(
          "Another project was opened while the Reel was being prepared. Open this project again and try again.",
        );
    };
    try {
      const progress = (message: string, value: number) => {
        check();
        jobs.update(job, { message, progress: value });
      };
      let asset = args.assetId
        ? prepared.assets.find((a) => a.id === args.assetId)
        : undefined;
      if (args.assetId && !asset)
        throw Error("That video is no longer in this project.");
      if (args.path) {
        if (!existsSync(args.path))
          throw Error("The selected video could not be found.");
        // Check the length first: importing a long video takes minutes.
        const probe = await media.probe(args.path);
        if (probe.kind !== "video")
          throw Error("Choose a video file for automatic editing.");
        if (probe.duration > 30 * 60)
          throw Error(
            "Choose a video under 30 minutes for automatic Reel editing.",
          );
        check();
        asset = await media.import(args.path);
        check();
        prepared.assets.push(asset);
      }
      if (!asset || asset.kind !== "video")
        throw Error("Choose a video file for automatic editing.");
      if (!existsSync(asset.path))
        throw Error(`Relink ${asset.name} before editing.`);
      if (asset.duration > 30 * 60)
        throw Error(
          "Choose a video under 30 minutes for automatic Reel editing.",
        );
      const warnings: string[] = [];
      progress("2 of 5 · Transcribing speech on your Mac", 0.12);
      if (asset.hasAudio && !asset.words?.length)
        asset.words = await media.transcribe(asset);
      check();
      progress("3 of 5 · Shaping the story and timing captions", 0.36);
      const analysis = analyzeAutoReel(asset, {
        ...options,
        fps: prepared.fps,
      });
      let placements: {
        assetId: string;
        startSeconds: number;
        durationSeconds: number;
        query: string;
      }[] = [];
      if (options.broll && analysis.beats.length) {
        const found = await acquireAutoStock({
          beats: analysis.beats,
          stock,
          provider: deps.provider(),
          checkCancelled: check,
          onProgress: ({ message, progress: stockProgress }) =>
            progress(
              `4 of 5 · ${message}`,
              0.42 + Math.min(1, stockProgress) * 0.32,
            ),
        });
        downloaded.push(...found.assets);
        check();
        prepared.assets.push(...found.assets);
        placements = found.placements;
        warnings.push(...found.warnings);
      } else if (options.broll) {
        warnings.push(
          "There were no clear spoken topics to match with stock footage. Your own video remains visible.",
        );
      }
      progress("5 of 5 · Composing music and finishing the edit", 0.79);
      let musicAssetId: string | undefined;
      if (options.music) {
        const music = await createMusicBed({
          folder: deps.musicFolder,
          seconds: Math.max(1, analysis.durationSeconds),
          style: analysis.style,
          media,
          jobs,
        });
        check();
        prepared.assets.push(music);
        musicAssetId = music.id;
      }
      // Land on the project as it is now. The media this job added comes along;
      // finishing fails only if the source video was removed or retimed.
      check();
      const base = structuredClone(store.project);
      const existing = new Set(start.assets.map((item) => item.id));
      for (const item of prepared.assets)
        if (
          !existing.has(item.id) &&
          !base.assets.some((other) => other.id === item.id)
        )
          base.assets.push(item);
      const source = base.assets.find((item) => item.id === asset!.id);
      if (source && source.path === asset.path && asset.words)
        source.words = asset.words;
      const plan = finalizeAutoReelPlan(
        base,
        analysis,
        placements,
        musicAssetId,
        {
          broll: options.broll,
          music: options.music,
          openingTitle: options.openingTitle,
          captionStyle: options.captionStyle,
          beats: options.beats,
        },
      );
      check();
      const next = applyCommands(base, {
        projectId: base.id,
        revision: base.revision,
        label: "Auto edit Reel",
        commands: plan.commands,
      });
      // A name the person typed meanwhile is kept.
      if (base.name === start.name)
        next.name = `${path.parse(asset.name).name} · Reel`.slice(0, 150);
      store.commit(next, "Auto edit Reel");
      const { commands, ...summary } = plan;
      return {
        ...summary,
        warnings: [...new Set([...summary.warnings, ...warnings])],
        music: !!musicAssetId,
        sourceName: asset.name,
        pace: options.pace,
        clipIds: next.clips.map((clip) => clip.id),
        queries: placements.map((p) => ({
          query: p.query,
          startSeconds: p.startSeconds,
          clipId: next.clips.find(
            (clip) => clip.assetId === p.assetId && clip.kind !== "audio",
          )?.id,
        })),
      };
    } catch (error) {
      // Downloads that never reached the project are deleted again.
      await Promise.all(downloaded.map((item) => stock.discard?.(item))).catch(
        () => {},
      );
      throw error;
    }
  });
}
