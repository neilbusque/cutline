import {
  uid,
  makeClip,
  type Project,
  type Asset,
  type Track,
  type Clip,
} from "./model";
import type { Command } from "./commands";
export function newTrack(p: Project, kind: Track["kind"]): Track {
  const prefix =
    kind === "text" ? "Text" : kind === "audio" ? "Audio" : "Video";
  let n = 1;
  while (p.tracks.some((t) => t.name === `${prefix} ${n}`)) n++;
  return {
    id: uid(),
    name: `${prefix} ${n}`,
    kind,
    muted: false,
    hidden: false,
  };
}
export function stackAssets(
  p: Project,
  assets: Asset[],
  start: number,
): Command[] {
  const temp = structuredClone(p),
    commands: Command[] = [];
  for (const a of assets) {
    const track = newTrack(temp, a.kind === "audio" ? "audio" : "video");
    temp.tracks.push(track);
    commands.push(
      { type: "track.add", track },
      { type: "clip.add", clip: makeClip(p, a.kind, track.id, start, a) },
    );
  }
  return commands;
}
export function sequenceAssets(p: Project, assets: Asset[]): Command[] {
  const commands: Command[] = [],
    ends = new Map<string, number>();
  for (const a of assets) {
    const kind = a.kind === "audio" ? "audio" : "video";
    const track =
      p.tracks.find((t) => t.id === kind && t.kind === kind) ??
      p.tracks.find((t) => t.kind === kind);
    if (!track) throw Error(`Add an ${kind} track first`);
    const end =
      ends.get(track.id) ??
      Math.max(
        0,
        ...p.clips
          .filter((c) => c.trackId === track.id)
          .map((c) => c.start + c.duration),
      );
    const clip = makeClip(p, a.kind, track.id, end, a);
    ends.set(track.id, end + clip.duration);
    commands.push({ type: "clip.add", clip });
  }
  return commands;
}
export function titleLayer(
  p: Project,
  start: number,
  preset: Clip["preset"],
): { clip: Clip; commands: Command[] } {
  const track = p.tracks.find(
    (t) =>
      t.kind === "text" &&
      t.id !== "captions" &&
      !p.clips.some(
        (c) =>
          c.trackId === t.id &&
          c.start < start + p.fps * 4 &&
          c.start + c.duration > start,
      ),
  );
  const dest = track ?? newTrack(p, "text");
  const clip = { ...makeClip(p, "text", dest.id, start), preset };
  return {
    clip,
    commands: [
      ...(!track ? [{ type: "track.add" as const, track: dest }] : []),
      { type: "clip.add", clip },
    ],
  };
}
