import type { Clip, Track } from "../shared/model";
import { compatibleTrack } from "../shared/timeline";

/** A media item dragged from the library carries its id and its kind. */
export const ASSET_DRAG = "application/x-cutline-asset";
export const assetKindDrag = (kind: Clip["kind"]) =>
  `application/x-cutline-kind-${kind}`;

/**
 * Whether a library drag can land on this track. Only matching tracks light
 * up; the others show the not-allowed cursor instead of a drop that does
 * nothing.
 */
export function acceptsAssetDrag(types: readonly string[], track: Track) {
  if (!types.includes(ASSET_DRAG)) return false;
  const kind = types
    .find((type) => type.startsWith("application/x-cutline-kind-"))
    ?.slice("application/x-cutline-kind-".length);
  return !kind || compatibleTrack({ kind: kind as Clip["kind"] }, track);
}

type TrackRef = { id: string };
type ClipRef = Pick<Clip, "id" | "trackId" | "start" | "duration">;

/** Clips in reading order: top track first, then left to right. */
export function laneOrder<C extends ClipRef>(tracks: TrackRef[], clips: C[]) {
  const row = new Map(tracks.map((track, index) => [track.id, index]));
  return [...clips].sort(
    (a, b) =>
      (row.get(a.trackId) ?? 0) - (row.get(b.trackId) ?? 0) ||
      a.start - b.start,
  );
}

/**
 * The timeline is one Tab stop: the selected clip, or the first clip when
 * nothing on the timeline is selected. Arrow keys move from there.
 */
export function clipTabStop(
  tracks: TrackRef[],
  clips: ClipRef[],
  selected?: string,
) {
  if (selected && clips.some((c) => c.id === selected)) return selected;
  return laneOrder(tracks, clips)[0]?.id;
}

export type ClipMove = "previous" | "next" | "first" | "last" | "up" | "down";

/**
 * Keys on a focused clip. Up and down change track, Home and End jump along
 * the track, and Option with left or right steps to the neighbouring clip.
 * Plain left and right stay as the nudge, so they are not moves.
 */
export function clipKeyMove(
  key: string,
  altKey: boolean,
): ClipMove | undefined {
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  if (altKey && key === "ArrowLeft") return "previous";
  if (altKey && key === "ArrowRight") return "next";
  return undefined;
}

/**
 * Where keyboard focus goes from a clip: along its track, to either end of
 * the track, or to the clip nearest in time on the next track up or down
 * that has clips.
 */
export function clipFocusTarget(
  tracks: TrackRef[],
  clips: ClipRef[],
  currentId: string,
  move: ClipMove,
): string | undefined {
  const current = clips.find((c) => c.id === currentId);
  if (!current) return undefined;
  const onTrack = (trackId: string) =>
    clips
      .filter((c) => c.trackId === trackId)
      .sort((a, b) => a.start - b.start);
  const row = onTrack(current.trackId);
  const at = row.findIndex((c) => c.id === currentId);
  if (move === "previous") return row[at - 1]?.id;
  if (move === "next") return row[at + 1]?.id;
  if (move === "first") return row[0]?.id;
  if (move === "last") return row[row.length - 1]?.id;
  const distance = (c: ClipRef) =>
    c.start <= current.start && current.start < c.start + c.duration
      ? 0
      : Math.min(
          Math.abs(c.start - current.start),
          Math.abs(c.start + c.duration - 1 - current.start),
        );
  const step = move === "up" ? -1 : 1;
  const index = tracks.findIndex((t) => t.id === current.trackId);
  for (let i = index + step; i >= 0 && i < tracks.length; i += step) {
    const others = onTrack(tracks[i].id);
    if (others.length)
      return others.reduce((best, c) =>
        distance(c) < distance(best) ? c : best,
      ).id;
  }
  return undefined;
}

/** Where typing goes: ⌘Z there undoes the typing, not a project edit. */
export function isTextField(
  el: Pick<HTMLElement, "tagName" | "isContentEditable"> & {
    type?: string;
  },
) {
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return (
    el.tagName === "INPUT" &&
    /^(?:text|search|url|email|password|number|tel)?$/u.test(el.type ?? "")
  );
}

/**
 * Keys the editor leaves to the focused control. Delete and the left and right
 * arrows act on what is focused in Properties, a library panel or a dialog (a
 * path point, a key, a layer row), never the selected clip or the playhead.
 * Space on a section heading opens or closes the section instead of playing.
 */
export function keyStaysInFocus(
  target: Pick<Element, "tagName" | "closest">,
  key: string,
) {
  if (key === " ") return target.tagName === "SUMMARY";
  return (
    ["Delete", "Backspace", "ArrowLeft", "ArrowRight"].includes(key) &&
    !!target.closest(".right-panel, .library, [role=dialog]")
  );
}
