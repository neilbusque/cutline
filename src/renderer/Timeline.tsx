import React, {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  Plus,
  Scissors,
  Trash2,
  Magnet,
  ZoomIn,
  ZoomOut,
  Copy,
  ScanLine,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Music2,
} from "lucide-react";
import {
  duration,
  uid,
  type Asset,
  type Project,
  type Clip,
} from "../shared/model";
import { newTrack } from "../shared/layers";
import { assetMediaVersion } from "../composition/Video";
import {
  compatibleTrack,
  trimClip,
  audioWaveformPath,
} from "../shared/timeline";
import { type Command } from "../shared/commands";
import { linkedCaptionCommands } from "../shared/linked-captions";
import { createNudge, dragStarted, trimCommands } from "./edit-gestures";
import { clipLabel, clipNote, countLabel, kindLabel } from "./labels";
import { usePlayheadValue, useStoreValue, type Playhead } from "./playhead";
import {
  acceptsAssetDrag,
  ASSET_DRAG,
  clipFocusTarget,
  clipKeyMove,
  clipTabStop,
} from "./timeline-focus";
/**
 * Waveform paths by clip. A drag changes only the dragged clip, so every
 * other clip reuses its path instead of rebuilding it on each pointer move.
 */
const waveformPaths = new WeakMap<Clip, string>();
function waveformPath(asset: Asset, clip: Clip, fps: number) {
  let path = waveformPaths.get(clip);
  if (path === undefined) {
    path = audioWaveformPath(asset, clip, fps);
    waveformPaths.set(clip, path);
  }
  return path;
}
/** The playhead line is the only part of the timeline that moves every frame. */
function PlayheadLine({
  playhead,
  zoom,
}: {
  playhead: Playhead;
  zoom: number;
}) {
  const frame = useStoreValue(playhead);
  return (
    <div className="playhead" style={{ left: frame * zoom }}>
      <span />
    </div>
  );
}
export function Timeline({
  p,
  playhead,
  selected,
  select,
  seek,
  edit,
  split,
  remove,
  base,
  duplicate,
  addMedia,
  playing,
  beats = [],
}: {
  p: Project;
  playhead: Playhead;
  selected?: string;
  select: (id: string) => void;
  seek: (f: number) => void;
  edit: (label: string, ops: Command[]) => Promise<boolean>;
  split: () => void;
  remove: (ripple: boolean, id?: string) => void;
  base: string;
  duplicate: () => void;
  addMedia: (assetId: string, trackId: string, start: number) => void;
  playing: boolean;
  beats?: number[];
}) {
  const [trackKind, setTrackKind] = useState<"video" | "text" | "audio">(
    "video",
  );
  // Smaller windows start with a shorter timeline so the panels keep room.
  const [height, setHeight] = useState(() =>
    window.innerHeight < 900 ? 230 : 294,
  );
  const maxHeight = () =>
    Math.max(180, Math.min(500, window.innerHeight - 400));
  useEffect(() => {
    const resize = () => setHeight((h) => Math.min(h, maxHeight()));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [zoom, setZoom] = useState(0.85);
  const [snap, setSnap] = useState(true);
  const [ghost, setGhost] = useState<Clip>();
  // After a drag or nudge the clip stays where it was dropped until the
  // edit lands (a new revision), instead of flashing back to its old spot.
  const pending = useRef<number | undefined>(undefined);
  const revision = useRef(p.revision);
  revision.current = p.revision;
  useLayoutEffect(() => {
    if (pending.current === undefined || pending.current === p.revision) return;
    pending.current = undefined;
    setGhost(undefined);
  }, [p.revision]);
  const settle = (saved: Promise<boolean>) => {
    const from = revision.current;
    pending.current = from;
    void saved.then((ok) => {
      if (ok || pending.current !== from) return;
      pending.current = undefined;
      setGhost(undefined);
    });
  };
  // Holding an arrow key moves the clip; one edit lands when it is released,
  // against the project as it was when the key went down.
  const gestureEdit = useRef(edit);
  const gestureProject = useRef(p);
  gestureProject.current = p;
  const [nudge] = useState(() =>
    createNudge((id, start) => {
      const project = gestureProject.current;
      const clip = project.clips.find((x) => x.id === id);
      settle(
        gestureEdit.current("Nudge clip", [
          { type: "clip.update", id, patch: { start } },
          ...(clip
            ? linkedCaptionCommands(
                project,
                clip,
                { start, duration: clip.duration },
                "move",
              )
            : []),
        ]),
      );
    }),
  );
  const releaseNudge = () => {
    if (!nudge.active()) return;
    nudge.release();
    if (pending.current === undefined) setGhost(undefined);
  };
  const scroll = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 1200 });
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const measure = () =>
      setViewport({ left: el.scrollLeft, width: el.clientWidth });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  const visibleBeats = useMemo(() => {
    const first = (viewport.left - 20) / zoom,
      last = (viewport.left + viewport.width + 20) / zoom;
    const visible = beats
      .map((at, index) => ({ at, index }))
      .filter((b) => b.at >= first && b.at <= last);
    // Dense, zoomed-out timelines show a representative grid; snapping retains every beat.
    const stride = Math.max(
      1,
      Math.ceil(visible.length / Math.max(1, viewport.width / 9)),
    );
    return visible.filter((_, index) => index % stride === 0);
  }, [beats, viewport, zoom]);
  const labels = useRef<HTMLDivElement>(null);
  const syncVertical = (
    source: HTMLDivElement,
    target: HTMLDivElement | null,
  ) => {
    if (target && target.scrollTop !== source.scrollTop)
      target.scrollTop = source.scrollTop;
  };
  const length = Math.max(duration(p) + p.fps * 5, p.fps * 20);
  const width = Math.max(1, length * zoom);
  const assets = useMemo(
    () => new Map(p.assets.map((a) => [a.id, a])),
    [p.assets],
  );
  const clipsByTrack = useMemo(() => {
    const map = new Map<string, Clip[]>();
    for (const original of p.clips) {
      const c = ghost?.id === original.id ? ghost : original;
      const list = map.get(c.trackId) ?? [];
      list.push(c);
      map.set(c.trackId, list);
    }
    return map;
  }, [p.clips, ghost]);
  // Waveforms are drawn only for clips within a screen of the view; a long
  // podcast edit has hundreds of clips, and each path is 160 segments.
  const near = {
    from: (viewport.left - viewport.width) / zoom,
    to: (viewport.left + 2 * viewport.width) / zoom,
  };
  const currentClip = p.clips.find((c) => c.id === selected);
  // These follow the playhead but only redraw when the answer changes.
  const atSelected = usePlayheadValue(
    playhead,
    (f) =>
      !!currentClip &&
      f > currentClip.start &&
      f < currentClip.start + currentClip.duration,
  );
  const beatBefore = usePlayheadValue(playhead, (f) =>
    beats.some((at) => at < f),
  );
  const beatAfter = usePlayheadValue(playhead, (f) =>
    beats.some((at) => at > f),
  );
  const tabStop = clipTabStop(p.tracks, p.clips, selected);
  const focusClip = (id: string | undefined) => {
    if (!id) return;
    scroll.current
      ?.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(id)}"]`)
      ?.focus();
  };
  useEffect(() => {
    const el = scroll.current,
      clip = el?.querySelector(".timeline-clip.selected");
    if (!el || !clip) return;
    const area = el.getBoundingClientRect(),
      box = clip.getBoundingClientRect();
    if (box.top < area.top + 30) el.scrollTop -= area.top + 30 - box.top;
    else if (box.bottom > area.bottom - 8)
      el.scrollTop += box.bottom - area.bottom + 8;
    syncVertical(el, labels.current);
  }, [selected, p.clips.length]);
  const [dropTrack, setDropTrack] = useState<string>();
  const [follow, setFollow] = useState(true);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  useEffect(() => {
    const el = scroll.current;
    if (!el || !playing || !follow) return;
    const keepVisible = () => {
      const x = playhead.get() * zoom;
      if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40)
        el.scrollLeft = Math.max(0, x - el.clientWidth * 0.2);
    };
    keepVisible();
    return playhead.subscribe(keepVisible);
  }, [playhead, playing, follow, zoom]);
  const fit = () => {
    if (scroll.current) {
      setZoom(
        Math.min(3, Math.max(0.02, (scroll.current.clientWidth - 40) / length)),
      );
      scroll.current.scrollLeft = 0;
    }
  };
  function drag(
    e: React.PointerEvent,
    c: Clip,
    mode: "move" | "left" | "right",
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    select(c.id);
    const x = e.clientX,
      y = e.clientY;
    let latest = c,
      moved = false;
    // Track rows are measured once, and again only after the timeline
    // scrolls, instead of forcing a layout on every pointer move.
    let rows: { id: string; top: number; bottom: number }[] | undefined;
    const forgetRows = () => (rows = undefined);
    const rowAt = (y: number) =>
      (rows ??= Array.from(
        document.querySelectorAll<HTMLElement>("[data-track-id]"),
        (el) => {
          const r = el.getBoundingClientRect();
          return { id: el.dataset.trackId!, top: r.top, bottom: r.bottom };
        },
      )).find((row) => y >= row.top && y < row.bottom);
    const points = [
      0,
      playhead.get(),
      ...beats,
      ...p.clips
        .filter((x) => x.id !== c.id)
        .flatMap((x) => [x.start, x.start + x.duration]),
    ];
    const snapped = (n: number) => {
      if (!snap) return n;
      const near = points.reduce(
        (a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a),
        points[0],
      );
      return Math.abs(near - n) * zoom < 8 ? near : n;
    };
    const move = (event: PointerEvent) => {
      if (!moved && !dragStarted(event.clientX - x, event.clientY - y)) return;
      moved = true;
      let delta = Math.round((event.clientX - x) / zoom);
      let next = { ...c };
      if (mode === "move") {
        const raw = Math.max(0, c.start + delta);
        const startSnap = snapped(raw),
          endSnap = snapped(raw + c.duration) - c.duration;
        next.start = Math.max(0, startSnap !== raw ? startSnap : endSnap);
        const row = rowAt(event.clientY);
        const dest = p.tracks.find((t) => t.id === row?.id);
        if (dest && compatibleTrack(c, dest)) next.trackId = dest.id;
      } else {
        next = trimClip(
          p,
          c,
          mode,
          snapped((mode === "left" ? c.start : c.start + c.duration) + delta),
        );
      }
      latest = next;
      setGhost(next);
    };
    // Back to where the clip showed when the drag began, which may be an
    // earlier change that has not landed yet.
    const restore = () =>
      setGhost(pending.current === undefined ? undefined : c);
    const cancel = () => {
      cleanup.current();
      restore();
    };
    const end = () => {
      cleanup.current();
      if (
        !moved ||
        (latest.start === c.start &&
          latest.duration === c.duration &&
          latest.trackId === c.trackId)
      ) {
        restore();
        return;
      }
      setGhost(latest);
      settle(
        edit(mode === "move" ? "Move clip" : "Trim clip", [
          {
            type: "clip.update",
            id: c.id,
            patch: {
              start: latest.start,
              duration: latest.duration,
              sourceIn: latest.sourceIn,
              trackId: latest.trackId,
              words: latest.words,
              text: latest.text,
              animationOffset: latest.animationOffset,
              keyframes: latest.keyframes,
            },
          },
          // Generated captions follow their clip, as they do for agents.
          ...linkedCaptionCommands(
            p,
            c,
            latest,
            mode === "move" ? "move" : "trim",
          ),
        ]),
      );
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape);
      scroll.current?.removeEventListener("scroll", forgetRows);
    };
    scroll.current?.addEventListener("scroll", forgetRows);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("keydown", escape);
  }
  const ticks = Array.from(
    { length: Math.ceil(length / (p.fps * (zoom < 0.4 ? 10 : 5))) + 1 },
    (_, i) => i * (zoom < 0.4 ? 10 : 5),
  );
  return (
    <section className="timeline" style={{ height }}>
      <div
        role="separator"
        aria-label="Resize timeline"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-valuenow={height}
        aria-valuemin={180}
        aria-valuemax={maxHeight()}
        className="timeline-resizer"
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            setHeight((h) =>
              Math.max(
                180,
                Math.min(maxHeight(), h + (e.key === "ArrowUp" ? 20 : -20)),
              ),
            );
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          const y = e.clientY,
            initial = height;
          const move = (event: PointerEvent) =>
            setHeight(
              Math.max(180, Math.min(maxHeight(), initial + y - event.clientY)),
            );
          const end = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end, { once: true });
          window.addEventListener("pointercancel", end, { once: true });
        }}
      />

      <div className="timeline-toolbar">
        <div className="row">
          <button
            title="Split at playhead (⌘B)"
            aria-label="Split clip"
            onClick={split}
            disabled={!atSelected}
          >
            <Scissors size={15} />
          </button>
          <button
            title="Trim start to playhead"
            aria-label="Trim start to playhead"
            disabled={!atSelected}
            onClick={() => {
              if (currentClip)
                edit(
                  "Trim start to playhead",
                  trimCommands(p, currentClip, "left", playhead.get()),
                );
            }}
          >
            Trim start
          </button>
          <button
            title="Trim end to playhead"
            aria-label="Trim end to playhead"
            disabled={!atSelected}
            onClick={() => {
              if (currentClip)
                edit(
                  "Trim end to playhead",
                  trimCommands(p, currentClip, "right", playhead.get()),
                );
            }}
          >
            Trim end
          </button>
          <button
            title="Delete clip"
            aria-label="Delete clip"
            onClick={() => remove(false)}
            disabled={!currentClip}
          >
            <Trash2 size={15} />
          </button>
          <button
            onClick={() => remove(true)}
            disabled={!currentClip}
            title="Delete clip and close the gap"
          >
            Ripple delete
          </button>
          <button
            aria-label="Duplicate clip"
            title="Duplicate clip (⌘D)"
            disabled={!currentClip}
            onClick={duplicate}
          >
            <Copy size={15} />
          </button>
          <span className="divider" />
          {!!beats.length && (
            <>
              <button
                aria-label="Previous beat"
                title="Seek to previous beat"
                disabled={!beatBefore}
                onClick={() => {
                  const frame = playhead.get();
                  const at = [...beats].reverse().find((at) => at < frame);
                  if (at !== undefined) seek(at);
                }}
              >
                <ChevronLeft size={13} />
                <Music2 size={13} />
              </button>
              <button
                aria-label="Next beat"
                title="Seek to next beat"
                disabled={!beatAfter}
                onClick={() => {
                  const frame = playhead.get();
                  const at = beats.find((at) => at > frame);
                  if (at !== undefined) seek(at);
                }}
              >
                <Music2 size={13} />
                <ChevronRight size={13} />
              </button>
            </>
          )}
          <button
            className={snap ? "active" : ""}
            aria-label="Toggle snapping"
            aria-pressed={snap}
            onClick={() => setSnap(!snap)}
          >
            <Magnet size={15} />
          </button>
        </div>
        <div className="row">
          <button onClick={fit} title="Fit entire project to timeline">
            <ScanLine size={14} /> Fit
          </button>
          <button
            aria-pressed={follow}
            className={follow ? "active" : ""}
            onClick={() => setFollow(!follow)}
            title="Keep the playhead visible during playback"
          >
            Follow
          </button>
          <span className="muted">
            {countLabel(p.clips.length, "clip")} ·{" "}
            {Math.round((duration(p) / p.fps) * 10) / 10}s
          </span>
          <button
            aria-label="Zoom out"
            onClick={() => setZoom(Math.max(0.02, zoom / 1.4))}
          >
            <ZoomOut size={15} />
          </button>
          <input
            className="zoom"
            aria-label="Timeline zoom"
            type="range"
            min="0.02"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <button
            aria-label="Zoom in"
            onClick={() => setZoom(Math.min(3, zoom * 1.4))}
          >
            <ZoomIn size={15} />
          </button>
        </div>
      </div>
      <div className="timeline-body">
        <div
          className="track-labels"
          ref={labels}
          onScroll={(e) => syncVertical(e.currentTarget, scroll.current)}
        >
          <div className="ruler-label">
            <select
              aria-label="New layer type"
              value={trackKind}
              onChange={(e) => setTrackKind(e.target.value as typeof trackKind)}
            >
              <option value="video">Video</option>
              <option value="text">Text</option>
              <option value="audio">Audio</option>
            </select>
            <button
              className="add-layer"
              title={`Add a ${trackKind} layer`}
              aria-label="Add track"
              onClick={() =>
                edit("Add layer", [
                  { type: "track.add", track: newTrack(p, trackKind) },
                ])
              }
            >
              <Plus size={13} />
              Add
            </button>
          </div>
          {p.tracks.map((t, index) => (
            <div key={t.id} className="track-label">
              <div className="track-identity">
                <input
                  aria-label={`Rename ${t.name}`}
                  key={t.name}
                  defaultValue={t.name}
                  title={t.name}
                  maxLength={100}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== t.name)
                      edit("Rename layer", [
                        { type: "track.update", id: t.id, patch: { name } },
                      ]);
                    else e.target.value = t.name;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      e.currentTarget.value = t.name;
                      e.currentTarget.blur();
                    }
                  }}
                />
                <div className="layer-order">
                  <button
                    aria-label={`Move ${t.name} up`}
                    disabled={index === 0}
                    onClick={() =>
                      edit("Reorder layer", [
                        { type: "track.move", id: t.id, direction: "up" },
                      ])
                    }
                  >
                    <ChevronUp size={10} />
                  </button>
                  <button
                    aria-label={`Move ${t.name} down`}
                    disabled={index === p.tracks.length - 1}
                    onClick={() =>
                      edit("Reorder layer", [
                        { type: "track.move", id: t.id, direction: "down" },
                      ])
                    }
                  >
                    <ChevronDown size={10} />
                  </button>
                  <small>{kindLabel(t.kind)}</small>
                </div>
              </div>
              <div className="row">
                <button
                  aria-label={`${t.hidden ? "Show" : "Hide"} ${t.name}`}
                  onClick={() =>
                    edit("Toggle track visibility", [
                      {
                        type: "track.update",
                        id: t.id,
                        patch: { hidden: !t.hidden },
                      },
                    ])
                  }
                >
                  {t.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button
                  aria-label={`${t.muted ? "Unmute" : "Mute"} ${t.name}`}
                  onClick={() =>
                    edit("Toggle track audio", [
                      {
                        type: "track.update",
                        id: t.id,
                        patch: { muted: !t.muted },
                      },
                    ])
                  }
                >
                  {t.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div
          className="timeline-scroll"
          ref={scroll}
          onScroll={(e) => {
            syncVertical(e.currentTarget, labels.current);
            const el = e.currentTarget;
            setViewport((v) =>
              v.left === el.scrollLeft && v.width === el.clientWidth
                ? v
                : { left: el.scrollLeft, width: el.clientWidth },
            );
          }}
        >
          <div className="track-content" style={{ width, minWidth: "100%" }}>
            <div
              className="ruler"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                seek(Math.round((e.clientX - rect.left) / zoom));
                const move = (event: PointerEvent) =>
                  seek(Math.round((event.clientX - rect.left) / zoom));
                const end = () => {
                  window.removeEventListener("pointermove", move);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", end, { once: true });
              }}
            >
              {ticks.map((t) => (
                <span key={t} style={{ left: t * p.fps * zoom }}>
                  {Math.floor(t / 60)}:{String(t % 60).padStart(2, "0")}
                </span>
              ))}
              {visibleBeats.map(({ at, index }) => (
                <button
                  key={at}
                  tabIndex={-1}
                  className={`beat-marker ${index % 4 === 0 ? "strong" : ""}`}
                  style={{ left: at * zoom }}
                  title={`Beat ${index + 1} · ${(at / p.fps).toFixed(2)}s`}
                  aria-label={`Beat at ${(at / p.fps).toFixed(2)} seconds`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    seek(at);
                  }}
                />
              ))}
            </div>
            {p.tracks.map((t) => (
              <div
                data-track-id={t.id}
                className={
                  "track " +
                  (t.hidden ? "track-hidden " : "") +
                  (dropTrack === t.id ? "drop-target" : "")
                }
                onDragOver={(e) => {
                  if (acceptsAssetDrag(e.dataTransfer.types, t)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    setDropTrack(t.id);
                  } else if (dropTrack === t.id) setDropTrack(undefined);
                }}
                onDragLeave={() => setDropTrack(undefined)}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(ASSET_DRAG);
                  if (!id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTrack(undefined);
                  const asset = p.assets.find((a) => a.id === id);
                  if (asset && compatibleTrack(asset, t))
                    addMedia(
                      id,
                      t.id,
                      Math.max(
                        0,
                        Math.round(
                          (e.clientX -
                            e.currentTarget.getBoundingClientRect().left) /
                            zoom,
                        ),
                      ),
                    );
                }}
                key={t.id}
                onDoubleClick={(e) => {
                  if (e.target === e.currentTarget) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    seek(Math.round((e.clientX - rect.left) / zoom));
                  }
                }}
              >
                {!p.clips.length && t.kind === "video" && (
                  <span className="track-empty">
                    Drop clips here · Drag edges to trim · ⌘B to split
                  </span>
                )}
                {(clipsByTrack.get(t.id) ?? []).map((original) => {
                  const c = ghost?.id === original.id ? ghost : original;
                  const a = c.assetId ? assets.get(c.assetId) : undefined;
                  const label = clipLabel(c, p.motions, a?.name);
                  return (
                    <div
                      key={c.id}
                      data-clip-id={c.id}
                      role="button"
                      // One Tab stop for all clips; arrows move from there.
                      tabIndex={c.id === tabStop ? 0 : -1}
                      aria-label={`${c.kind} clip ${label === kindLabel(c.kind) ? "" : label}`}
                      aria-pressed={selected === c.id}
                      className={`timeline-clip ${c.kind} ${selected === c.id ? "selected" : ""}`}
                      style={{
                        left: c.start * zoom,
                        width: Math.max(8, c.duration * zoom),
                      }}
                      onPointerDown={(e) => drag(e, c, "move")}
                      onClick={() => select(c.id)}
                      onFocus={() => {
                        if (selected !== c.id) select(c.id);
                      }}
                      onBlur={releaseNudge}
                      onKeyUp={(e) => {
                        if (e.key === "ArrowLeft" || e.key === "ArrowRight")
                          releaseNudge();
                      }}
                      onKeyDown={(e) => {
                        const move = clipKeyMove(e.key, e.altKey);
                        if (move) {
                          e.preventDefault();
                          e.stopPropagation();
                          releaseNudge();
                          focusClip(
                            clipFocusTarget(p.tracks, p.clips, c.id, move),
                          );
                          return;
                        }
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          select(c.id);
                          seek(c.start);
                        }
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault();
                          e.stopPropagation();
                          releaseNudge();
                          remove(e.shiftKey, c.id);
                        }
                        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!nudge.active()) gestureEdit.current = edit;
                          // Starts from where the clip shows, which may be a
                          // nudge that has not landed yet.
                          const start = nudge.press(
                            c.id,
                            c.start,
                            (e.key === "ArrowLeft" ? -1 : 1) *
                              (e.shiftKey ? 10 : 1),
                          );
                          setGhost({ ...c, start });
                        }
                      }}
                    >
                      {a?.thumbnail && (
                        <div
                          className="filmstrip"
                          style={{
                            backgroundImage: `url(${base}/media/${a.id}/thumb${assetMediaVersion(a)})`,
                          }}
                        />
                      )}
                      {a?.waveform &&
                        c.kind === "audio" &&
                        c.start + c.duration >= near.from &&
                        c.start <= near.to && (
                          <svg
                            className="waveform"
                            viewBox="0 0 160 40"
                            preserveAspectRatio="none"
                          >
                            <path
                              d={waveformPath(a, c, p.fps)}
                              stroke="currentColor"
                              strokeWidth=".6"
                            />
                          </svg>
                        )}
                      <span className="clip-label">
                        {c.transition ? "◈ " : ""}
                        {label}
                        {clipNote(c) && (
                          <span className="clip-note"> · {clipNote(c)}</span>
                        )}
                      </span>
                      <div
                        className="trim-handle left"
                        title="Trim start"
                        onPointerDown={(e) => drag(e, c, "left")}
                      />
                      <div
                        className="trim-handle right"
                        title="Trim end"
                        onPointerDown={(e) => drag(e, c, "right")}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
            <PlayheadLine playhead={playhead} zoom={zoom} />
          </div>
        </div>
      </div>
    </section>
  );
}
