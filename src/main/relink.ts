import { existsSync } from "node:fs";
import path from "node:path";
import type { Asset } from "../shared/model";
import type { Store } from "./store";
import type { Media } from "./media";

const kindNames: Record<Asset["kind"], string> = {
  video: "video",
  audio: "audio file",
  image: "image",
};
/** Within one frame: the same recording, moved or copied. */
const sameLength = (a: number, b: number, fps: number) =>
  Math.abs(a - b) <= 1 / fps + 1e-6;

/**
 * The asset pointed at a newly imported file. What Cutline knows about the
 * media (its name, stock credits, transcript and beat grid) is kept; the
 * transcript and beats only when the new file has the same length, since
 * they are timed against the file.
 */
export function relinkedAsset(old: Asset, replacement: Asset, fps: number) {
  const same = sameLength(old.duration, replacement.duration, fps);
  const {
    proxy: _proxy,
    thumbnail: _thumbnail,
    waveform: _waveform,
    words,
    rhythm,
    ...kept
  } = old;
  const asset: Asset = {
    ...kept,
    path: replacement.path,
    kind: replacement.kind,
    duration: replacement.duration,
    width: replacement.width,
    height: replacement.height,
    hasAudio: replacement.hasAudio,
    ...(replacement.thumbnail ? { thumbnail: replacement.thumbnail } : {}),
    ...(replacement.waveform ? { waveform: replacement.waveform } : {}),
    ...(same && words ? { words } : {}),
    ...(same && rhythm ? { rhythm } : {}),
  };
  return { asset, cleared: !same && !!(words?.length || rhythm) };
}

/**
 * Points a missing asset at the file the person chose. Other missing files
 * with the same name, kind and length in that folder (a project folder that
 * was moved or copied to another drive) are relinked in the same Undo.
 */
export async function relinkMedia(
  { store, media }: { store: Store; media: Pick<Media, "import" | "probe"> },
  assetId: string,
  chosen: string,
) {
  const start = store.project;
  const old = start.assets.find((a) => a.id === assetId);
  if (!old) throw Error("Asset missing");
  const probe = await media.probe(chosen);
  if (probe.kind !== old.kind)
    throw Error(`Choose a ${kindNames[old.kind]} to relink ${old.name}.`);
  const replacement = await media.import(chosen, { id: old.id });
  const folder = path.dirname(chosen);
  const moved = new Map<
    string,
    Awaited<ReturnType<Media["probe"]>> & { path: string }
  >();
  for (const other of start.assets) {
    if (other.id === old.id || existsSync(other.path)) continue;
    const candidate = path.join(folder, path.basename(other.path));
    if (!existsSync(candidate)) continue;
    const found = await media.probe(candidate).catch(() => undefined);
    if (
      found &&
      found.kind === other.kind &&
      sameLength(found.duration, other.duration, start.fps)
    )
      moved.set(other.id, { ...found, path: candidate });
  }
  const now = store.project;
  if (now.id !== start.id)
    throw Error(
      "Another project was opened while relinking. Open this project again and retry.",
    );
  if (!now.assets.some((a) => a.id === old.id))
    throw Error(`${old.name} was removed from the project while relinking.`);
  let cleared = false,
    relinked = 0;
  const next = structuredClone(now);
  next.assets = next.assets.map((asset) => {
    if (asset.id === old.id) {
      const result = relinkedAsset(asset, replacement, now.fps);
      cleared = result.cleared;
      relinked++;
      return result.asset;
    }
    const found = moved.get(asset.id);
    if (!found || existsSync(asset.path)) return asset;
    relinked++;
    return {
      ...asset,
      path: found.path,
      ...(found.width ? { width: found.width } : {}),
      ...(found.height ? { height: found.height } : {}),
      hasAudio: found.hasAudio,
    };
  });
  store.commit(
    next,
    relinked > 1 ? `Relink ${relinked} files` : "Relink media",
  );
  return { relinked, cleared };
}
