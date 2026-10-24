import { snapOnStage, resizeOnStage } from "../shared/stage-layout";
import { HiggsfieldSettings } from "./HiggsfieldSettings";
import "./stage-controls.css";
import { evaluatedClip } from "../shared/animation";
import { musicBindings, reactiveClipVisual } from "../shared/music-reactive";
import { beatFrames } from "../shared/music-sync";
import { resizeCanvas } from "../shared/canvas";
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { Film } from "../composition/Video";
import {
  duration,
  makeClip,
  uid,
  type Snapshot,
  type Project,
  type Clip,
  type Asset,
  type Job,
} from "../shared/model";
import { type Command } from "../shared/commands";
import { Inspector } from "./Inspector";
import { Timeline } from "./Timeline";
import { EffectsPanel } from "./EffectsPanel";
import { ReelBuilder } from "./ReelBuilder";
import { AutoReel } from "./AutoReel";
import { AudioLibrary } from "./AudioLibrary";
import { MusicSync } from "./MusicSync";
import { StockLibrary } from "./StockLibrary";
import { GenerateLibrary } from "./GenerateLibrary";
import { GraphicStudio } from "./GraphicStudio";
import { StoryLibrary } from "./StoryLibrary";
import { stackAssets, sequenceAssets, titleLayer } from "../shared/layers";
import { MotionLibrary } from "./MotionLibrary";
import { CaptionLibrary } from "./CaptionLibrary";
import { Assistant } from "./Assistant";
import { AgentConnections } from "./AgentConnections";
import { Sessions } from "./Sessions";
import { errorText, IconButton, keepFocusInside } from "./controls";
import { Projects } from "./Projects";
import {
  createEditQueue,
  duplicateCommands,
  hasUnsavedWork,
  previewTransform,
  transformCommands,
  withDraft,
} from "./edit-gestures";
import { kindLabel } from "./labels";
import {
  ASSET_DRAG,
  assetKindDrag,
  isTextField,
  keyStaysInFocus,
} from "./timeline-focus";
import {
  createValueStore,
  usePlayheadFrame,
  useStoreSelect,
  useStoreValue,
  type Playhead,
  type ValueStore,
} from "./playhead";
import {
  Film as FilmIcon,
  Upload,
  Plus,
  FilePlus,
  Type,
  Captions,
  Music2,
  Image,
  Play,
  Pause,
  SkipBack,
  Undo2,
  Redo2,
  Download,
  FolderOpen,
  Settings2,
  Sparkles,
  SlidersHorizontal,
  X,
  Check,
  ChevronDown,
  Save,
  PanelRightClose,
  PanelRightOpen,
  Link2,
  LoaderCircle,
  Search,
  WandSparkles,
  Clapperboard,
  Layers,
  Smartphone,
  Images,
  Palette,
} from "lucide-react";
const api = window.cutline;
/** The left panels. Each has its own icon, so the grid can be scanned. */
export const libraryTabs = [
  { id: "story", icon: Clapperboard, label: "Story" },
  { id: "reel", icon: Smartphone, label: "Reel" },
  { id: "media", icon: FilmIcon, label: "Media" },
  { id: "stock", icon: Images, label: "Stock" },
  { id: "generate", icon: WandSparkles, label: "Generate" },
  { id: "audio", icon: Music2, label: "Audio" },
  { id: "text", icon: Layers, label: "Motion" },
  { id: "effects", icon: Palette, label: "Effects" },
  { id: "captions", icon: Captions, label: "Captions" },
];
function ErrorView({ error }: { error: string }) {
  return (
    <div className="preview-error">
      <strong>Preview unavailable</strong>
      <p>{error}</p>
      <p>Relink missing media or undo the last animation change.</p>
    </div>
  );
}
// Keep the media player independent of playhead/inspector UI updates.
const StablePlayer = React.memo(
  React.forwardRef<PlayerRef, { project: Project; mediaBase: string }>(
    ({ project, mediaBase }, ref) => (
      <Player
        ref={ref}
        component={Film}
        inputProps={{ project, mediaBase, preview: true }}
        durationInFrames={duration(project)}
        compositionWidth={project.width}
        compositionHeight={project.height}
        fps={project.fps}
        style={{ width: "100%", height: "100%" }}
        controls={false}
        clickToPlay={false}
        loop
        errorFallback={({ error }) => <ErrorView error={error.message} />}
      />
    ),
  ),
);
// Both sides read minutes:seconds, then frames in a quieter weight, so
// "0:03:00" reads as three seconds rather than three minutes.
const timecode = (f: number, fps: number) => {
  const s = Math.floor(f / fps);
  return (
    <>
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      <small className="timecode-frames">
        :{String(Math.round(f % fps)).padStart(2, "0")}
      </small>
    </>
  );
};
/** The only part of the transport that redraws on every frame. */
function Timecode({
  playhead,
  fps,
  total,
}: {
  playhead: Playhead;
  fps: number;
  total: number;
}) {
  const frame = useStoreValue(playhead);
  return (
    <span className="timecode">
      {timecode(frame, fps)}
      <span> / {timecode(total, fps)}</span>
    </span>
  );
}
type Jobs = ValueStore<Job[]>;
const running = (jobs: Job[], kind: string) =>
  jobs.some((j) => j.kind === kind && j.state === "running");
/**
 * Hands the job list to one panel. Job progress redraws the panels that show
 * it, not the whole editor.
 */
function WithJobs({
  jobs,
  children,
}: {
  jobs: Jobs;
  children: (list: Job[]) => React.ReactNode;
}) {
  return <>{children(useStoreValue(jobs))}</>;
}
/** The status bar's job line: the running job, or how the last one ended. */
export function JobStatus({
  jobs: store,
  run,
  report,
}: {
  jobs: Jobs;
  run: (name: string, args?: unknown) => Promise<unknown>;
  report: (e: unknown) => void;
}) {
  const jobs = useStoreValue(store);
  // Jobs the person started come before background preview copies, so the
  // status bar's message and Cancel point at what they are waiting for.
  const active = jobs
    .filter((j) => j.state === "running")
    .sort(
      (a, b) => Number(a.kind === "preview") - Number(b.kind === "preview"),
    );
  const latest = jobs.filter((j) => j.kind !== "preview").at(-1) ?? jobs.at(-1);
  return active.length ? (
    <div className="status-job">
      <LoaderCircle size={12} className="spin" />
      <span>{active[0].message}</span>
      <progress value={active[0].progress} max={1} />
      <button onClick={() => run("job.cancel", { id: active[0].id })}>
        Cancel
      </button>
    </div>
  ) : latest?.state === "done" && latest.output ? (
    <button onClick={() => run("reveal", { id: latest.id })}>
      <Check size={12} />
      Export complete · Show in Finder
    </button>
  ) : latest?.state === "error" ? (
    <button className="status-error" onClick={() => report(latest.message)}>
      Job failed · View details
    </button>
  ) : (
    <span />
  );
}
type LayerDraft = ValueStore<Clip | undefined>;
/** The preview player. A layer being dragged moves with the pointer. */
const LivePlayer = React.forwardRef<
  PlayerRef,
  { project: Project; mediaBase: string; draft: LayerDraft }
>(({ project, mediaBase, draft }, ref) => {
  const moving = useStoreValue(draft);
  const shown = useMemo(() => withDraft(project, moving), [project, moving]);
  return <StablePlayer ref={ref} project={shown} mediaBase={mediaBase} />;
});
/** Selection boxes over the paused preview; they follow the playhead. */
function PreviewOverlays({
  p,
  playhead,
  draft,
  music,
  size,
  selected,
  onPress,
  onSelect,
  onNudge,
}: {
  p: Project;
  playhead: Playhead;
  draft: LayerDraft;
  music: ReturnType<typeof musicBindings>;
  size: { width: number; height: number };
  selected?: string;
  onPress: (e: React.PointerEvent, c: Clip, resize?: boolean) => void;
  onSelect: (id: string) => void;
  onNudge: (c: Clip, x: number, y: number) => void;
}) {
  const frame = usePlayheadFrame(playhead);
  const project = withDraft(p, useStoreValue(draft));
  return (
    <>
      {project.clips
        .filter(
          (c) =>
            c.kind !== "audio" &&
            frame >= c.start &&
            frame < c.start + c.duration &&
            !project.tracks.find((t) => t.id === c.trackId)?.hidden,
        )
        .sort(
          (a, b) =>
            project.tracks.findIndex((t) => t.id === b.trackId) -
            project.tracks.findIndex((t) => t.id === a.trackId),
        )
        .map((c) => {
          const evaluated = evaluatedClip(c, frame - c.start);
          const pulse = reactiveClipVisual(
            c,
            frame,
            c.musicReactive
              ? music.get(c.musicReactive.musicClipId)
              : undefined,
          );
          return {
            ...evaluated,
            scale: evaluated.scale * pulse.scale,
          };
        })
        .map((c) => (
          <div
            key={c.id}
            data-overlay={c.id}
            tabIndex={selected === c.id ? 0 : -1}
            role="button"
            aria-label={`Move ${kindLabel(c.kind)} on canvas`}
            title="Drag to position · Shift locks an axis · Option bypasses snapping · Arrow keys nudge"
            onKeyDown={(e) => {
              const direction = (
                {
                  ArrowLeft: [-1, 0],
                  ArrowRight: [1, 0],
                  ArrowUp: [0, -1],
                  ArrowDown: [0, 1],
                } as Record<string, number[]>
              )[e.key];
              if (!direction) return;
              e.preventDefault();
              e.stopPropagation();
              const step = e.shiftKey ? 10 : 1;
              onNudge(c, direction[0] * step, direction[1] * step);
            }}
            className={"layer-overlay " + (selected === c.id ? "selected" : "")}
            style={{
              left: (c.x * size.width) / project.width,
              top: (c.y * size.height) / project.height,
              width: (c.width * size.width) / project.width,
              height: (c.height * size.height) / project.height,
              transform: `rotate(${c.rotation}deg) scale(${c.scale})`,
            }}
            onPointerDown={(e) => onPress(e, c)}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(c.id);
            }}
          >
            {selected === c.id && (
              <>
                <span className="layer-tag">{kindLabel(c.kind)}</span>
                <button
                  className="resize-handle"
                  aria-label="Resize selected layer"
                  onPointerDown={(e) => onPress(e, c, true)}
                />
              </>
            )}
          </div>
        ))}
    </>
  );
}
export function App() {
  const [snap, setSnap] = useState<Snapshot>();
  const [base, setBase] = useState("");
  const [settings, setSettings] = useState<any>();
  // Jobs live outside React state: only the status bar and the panels that
  // show a job follow its progress.
  const [jobs] = useState<Jobs>(() => createValueStore<Job[]>([]));
  const exporting = useStoreSelect(jobs, (list) => running(list, "export"));
  const transcribing = useStoreSelect(jobs, (list) =>
    running(list, "transcribe"),
  );
  const findingPauses = useStoreSelect(jobs, (list) =>
    running(list, "analyze"),
  );
  const [selected, setSelected] = useState<string>();
  const [musicClipId, setMusicClipId] = useState<string>();
  const [showBeats, setShowBeats] = useState(true);
  // The playhead lives outside React state: only the views that follow it
  // (timecode, playhead line, preview boxes) redraw while the video plays.
  const [playhead] = useState(() => createValueStore(0));
  const [layerDraft] = useState<LayerDraft>(() =>
    createValueStore<Clip | undefined>(undefined),
  );
  const pendingLayer = useRef<number | undefined>(undefined);
  const [sendEdit] = useState(() =>
    createEditQueue((request) => api.invoke("edit.brief", request)),
  );
  const [playing, setPlaying] = useState(false);
  const [mediaSelection, setMediaSelection] = useState<string[]>([]);
  const [mediaQuery, setMediaQuery] = useState("");
  const [mediaKind, setMediaKind] = useState("all");
  const [left, setLeft] = useState("story");
  const [assistantDraft, setAssistantDraft] = useState<{
    id: number;
    text: string;
  }>();
  const [reelMode, setReelMode] = useState("auto");
  // Claude or ChatGPT draws first; Higgsfield video is the other mode.
  const [generateMode, setGenerateMode] = useState<"graphic" | "video">(
    "graphic",
  );
  const [right, setRight] = useState("properties");
  const [sidebar, setSidebar] = useState(true);
  const [error, setError] = useState("");
  const [safeGuides, setSafeGuides] = useState(false);
  const [thirdsGuides, setThirdsGuides] = useState(false);
  const [stageSnap, setStageSnap] = useState(true);
  const canvasNudge = useRef<
    | {
        original: Clip;
        local: number;
        x: number;
        y: number;
        finish: () => void;
      }
    | undefined
  >(undefined);
  const [snapGuides, setSnapGuides] = useState<{ x?: number; y?: number }>({});
  // A drag redraws the editor only when a guide appears, moves or goes away.
  const showGuides = (x?: number, y?: number) =>
    setSnapGuides((shown) =>
      shown.x === x && shown.y === y ? shown : { x, y },
    );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  // Undo from the menu leaves the project alone while a dialog is open.
  const modalOpen = useRef(false);
  modalOpen.current = settingsOpen || projectsOpen;
  const settingsModal = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    settingsModal.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [settingsOpen]);
  const [previewSize, setPreviewSize] = useState({ width: 360, height: 640 });
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const player = useRef<PlayerRef>(null);
  const pendingSeek = useRef<{ id: string; frame: number } | undefined>(
    undefined,
  );
  const stage = useRef<HTMLDivElement>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const p = snap?.project;
  const music = useMemo(() => (p ? musicBindings(p) : new Map()), [p]);
  const effectiveMusicClipId =
    musicClipId &&
    p?.clips.some((c) => c.id === musicClipId && c.kind === "audio")
      ? musicClipId
      : (p?.clips.find((c) => c.kind === "audio" && music.has(c.id))?.id ??
        p?.clips.find((c) => c.kind === "audio")?.id);
  const beats = useMemo(
    () =>
      p && effectiveMusicClipId && showBeats
        ? beatFrames(p, effectiveMusicClipId)
        : [],
    [p, effectiveMusicClipId, showBeats],
  );
  useEffect(() => {
    setMusicClipId(undefined);
    setShowBeats(true);
  }, [p?.id]);
  const clip = p?.clips.find((c) => c.id === selected);
  const report = useCallback((e: unknown) => {
    setError(errorText(e));
  }, []);
  const run = useCallback(
    async (name: string, args?: unknown) => {
      try {
        return await api.invoke(name, args);
      } catch (e) {
        report(e);
      }
    },
    [report],
  );
  useEffect(() => {
    // The first reply carries the media address with the project, so media
    // URLs are never built without it. Updates pushed before that reply are
    // older than it (IPC keeps order) and are skipped.
    let started = false;
    api
      .invoke("state")
      .then((s) => {
        started = true;
        setSnap(s.snapshot);
        setBase(s.mediaBase);
        setSettings(s.settings);
        jobs.set(s.jobs);
      })
      .catch(report);
    const off = api.on("state", (next: Snapshot) => {
      if (started) setSnap(next);
    });
    const offJob = api.on("job", (j: Job) =>
      jobs.set([...jobs.get().filter((x) => x.id !== j.id), j]),
    );
    // File › Projects… (⌘O) opens the projects sheet. Edit › Undo and Redo
    // (⌘Z, ⇧⌘Z) undo typing in a text field, otherwise the last project edit.
    const offUi = api.on(
      "ui",
      (event: { show?: string; edit?: "undo" | "redo" }) => {
        if (event?.show === "projects") {
          setSettingsOpen(false);
          setProjectsOpen(true);
        }
        if (event?.edit !== "undo" && event?.edit !== "redo") return;
        const focused = document.activeElement as HTMLElement | null;
        if (focused && isTextField(focused)) document.execCommand(event.edit);
        else if (!modalOpen.current) void run(event.edit);
      },
    );
    return () => {
      off();
      offJob();
      offUi();
    };
  }, []);
  const edit = async (label: string, commands: Command[]): Promise<boolean> => {
    // A gesture commits against the revision at its start, never a newer AI
    // edit. Edits from this window queue up, so a burst that lands before the
    // next render builds on this window's own previous edit.
    const current = snap?.project;
    if (!current) return false;
    try {
      await sendEdit({
        projectId: current.id,
        revision: current.revision,
        label,
        commands,
      });
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  };
  const seek = useCallback((f: number) => {
    const n = Math.max(0, Math.min(duration(snapRef.current!.project) - 1, f));
    player.current?.seekTo(n);
    playhead.set(n);
  }, []);
  useEffect(
    () =>
      api.on("agent", async (request) => {
        try {
          const project = snapRef.current?.project;
          if (
            !project ||
            project.id !== request.projectId ||
            project.revision !== request.revision
          )
            throw Error("Project changed. Inspect the project and retry.");
          if (
            request.clipId &&
            !project.clips.some((clip) => clip.id === request.clipId)
          )
            throw Error("Clip is missing");
          if (request.frame !== undefined || request.seconds !== undefined)
            seek(request.frame ?? Math.round(request.seconds * project.fps));
          if (request.clipId) {
            setSelected(request.clipId);
            // An agent looking at a clip must not hide the Assistant chat
            // (its reply and Stop button); Properties is one click away.
            setRight((current) =>
              current === "assistant" ? current : "properties",
            );
            setSidebar(true);
          }
          if (request.playing === true) await player.current?.play();
          if (request.playing === false || request.image)
            player.current?.pause();
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const bounds = stage.current
            ?.querySelector(".canvas")
            ?.getBoundingClientRect();
          await api.invoke("agent.preview.ack", {
            requestId: request.requestId,
            state: {
              frame: player.current?.getCurrentFrame() ?? 0,
              playing: player.current?.isPlaying() ?? false,
              selectedClipId: request.clipId ?? selectedRef.current ?? null,
              rect: bounds
                ? {
                    x: Math.round(bounds.x),
                    y: Math.round(bounds.y),
                    width: Math.round(bounds.width),
                    height: Math.round(bounds.height),
                  }
                : undefined,
            },
          });
        } catch (error) {
          await api.invoke("agent.preview.ack", {
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    [seek],
  );
  const select = (id: string) => {
    setSelected(id);
    // Keep an open Assistant conversation in view; Properties is one click away.
    setRight((current) => (current === "assistant" ? current : "properties"));
    setSidebar(true);
  };
  const split = () => {
    const frame = playhead.get();
    if (clip && frame > clip.start && frame < clip.start + clip.duration)
      edit("Split clip", [{ type: "clip.split", id: clip.id, frame }]);
  };
  const remove = (ripple: boolean, id = selected) => {
    if (id) {
      edit(ripple ? "Ripple delete" : "Delete clip", [
        { type: "clip.delete", id, ripple },
      ]);
      setSelected(undefined);
    }
  };
  const duplicate = () => {
    if (!clip || !p) return;
    const copy = duplicateCommands(p, clip);
    edit("Duplicate clip", copy.commands);
    setSelected(copy.id);
  };
  useEffect(() => {
    setSelected(undefined);
    setMediaSelection([]);
    playhead.set(0);
    setPlaying(false);
    player.current?.pause();
    player.current?.seekTo(0);
  }, [p?.id]);
  // A layer dragged in the preview stays where it was dropped until the edit
  // lands, instead of jumping back for a moment.
  useLayoutEffect(() => {
    if (pendingLayer.current === undefined || p?.revision === undefined) return;
    if (p.revision === pendingLayer.current) return;
    pendingLayer.current = undefined;
    layerDraft.set(undefined);
  }, [p?.revision]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // A dialog owns the keyboard while it is open, even when focus fell
      // back to the page behind it.
      if (settingsOpen || projectsOpen) {
        if (e.key === "Escape") {
          setSettingsOpen(false);
          setProjectsOpen(false);
        }
        return;
      }
      const target = e.target as HTMLElement;
      if (target.matches("input,textarea,select") || target.isContentEditable)
        return;
      const focused = keyStaysInFocus(target, e.key);
      if (e.key === "Escape") {
        setSelected(undefined);
        setSettingsOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicate();
        return;
      }
      if (e.code === "Space" && !focused) {
        // A clicked button keeps focus; Space should still play, not click it
        // again. Keyboard-focused buttons keep their normal Space behaviour.
        const button = target.closest("button");
        if (!button || !button.matches(":focus-visible")) {
          e.preventDefault();
          button?.blur();
          player.current?.toggle();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        split();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void run(e.shiftKey ? "save.as" : "save");
      }
      if (focused) return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        remove(e.shiftKey);
      }
      if (e.key === "ArrowRight") seek(playhead.get() + (e.shiftKey ? 10 : 1));
      if (e.key === "ArrowLeft") seek(playhead.get() - (e.shiftKey ? 10 : 1));
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [selected, p, settingsOpen, projectsOpen]);
  useEffect(() => {
    // Panels that handle their own drops stop propagation, so clear the
    // full-window drop overlay from the capture phase.
    const clear = () => setDragging(false);
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("dragend", clear, true);
    };
  }, []);
  useEffect(() => {
    if (!p || !stage.current) return;
    const el = stage.current;
    const resize = () => {
      const ratio = Math.min(
        (el.clientWidth - 64) / p.width,
        (el.clientHeight - 40) / p.height,
      );
      setPreviewSize({ width: p.width * ratio, height: p.height * ratio });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    return () => observer.disconnect();
  }, [p?.width, p?.height, sidebar]);
  useEffect(() => {
    if (!p || !player.current) return;
    const el = player.current;
    const update = (e: any) => playhead.set(e.detail.frame);
    const play = () => setPlaying(true),
      pause = () => setPlaying(false);
    el.addEventListener("frameupdate", update);
    el.addEventListener("play", play);
    el.addEventListener("pause", pause);
    return () => {
      el.removeEventListener("frameupdate", update);
      el.removeEventListener("play", play);
      el.removeEventListener("pause", pause);
    };
  }, [!!p]);
  useEffect(() => {
    const pending = pendingSeek.current;
    if (pending && p?.clips.some((c) => c.id === pending.id)) {
      pendingSeek.current = undefined;
      seek(pending.frame);
    }
  }, [p?.revision]);
  if (!p || !snap)
    return (
      <div className="loading">
        <FilmIcon size={26} />
        <span>Opening Cutline…</span>
      </div>
    );
  const addAsset = (a: Asset, targetTrack?: string, at?: number) => {
    const kind = a.kind === "audio" ? "audio" : "video";
    const track = (
      targetTrack
        ? p.tracks.find((t) => t.id === targetTrack)
        : (p.tracks.find((t) => t.id === kind && t.kind === kind) ??
          p.tracks.find((t) => t.kind === kind))
    )!;
    const end =
      at ??
      Math.max(
        0,
        ...p.clips
          .filter((c) => c.trackId === track.id)
          .map((c) => c.start + c.duration),
      );
    const c = makeClip(p, a.kind, track.id, end, a);
    edit("Add media", [{ type: "clip.add", clip: c }]);
    setSelected(c.id);
    pendingSeek.current = { id: c.id, frame: end };
  };
  const addSequence = (assets: Asset[]) => {
    if (!assets.length) return;
    edit("Add media sequence", sequenceAssets(p, assets));
    setMediaSelection([]);
  };
  const addLayers = () => {
    const assets = p.assets.filter(
      (a) => mediaSelection.includes(a.id) && !snap.missing.includes(a.id),
    );
    if (!assets.length) return;
    edit("Stack media layers", stackAssets(p, assets, playhead.get()));
    setMediaSelection([]);
  };
  const toggleMedia = (id: string, picked: boolean) =>
    setMediaSelection((old) =>
      picked
        ? [...old.filter((item) => item !== id), id]
        : old.filter((item) => item !== id),
    );
  const addBroll = async (asset: Asset) => {
    const current: Project = (await api.invoke("state")).snapshot.project;
    if (current.id !== p.id)
      throw Error(
        "Project changed before B-roll placement. Select it again from the library.",
      );
    if (asset.kind === "audio") return;
    const track = current.tracks.find(
      (t) => t.name === "B-roll" && t.kind === "video",
    );
    const trackId = track?.id ?? uid();
    const clip = {
      ...makeClip(current, asset.kind, trackId, playhead.get(), asset),
      duration: Math.max(
        1,
        Math.min(
          asset.kind === "image"
            ? current.fps * 4
            : Math.floor(asset.duration * current.fps),
          current.fps * 5,
        ),
      ),
      volume: 0,
      cameraMotion:
        asset.kind === "image" ? ("zoom-in" as const) : ("none" as const),
    };
    const commands: Command[] = [];
    if (!track)
      commands.push({
        type: "track.add",
        track: {
          id: trackId,
          name: "B-roll",
          kind: "video",
          muted: false,
          hidden: false,
        },
      });
    commands.push({ type: "clip.add", clip });
    await sendEdit({
      projectId: current.id,
      revision: current.revision,
      label: "Add B-roll",
      commands,
    });
    select(clip.id);
  };
  const addText = (preset: Clip["preset"] = "spring") => {
    const { clip, commands } = titleLayer(p, playhead.get(), preset);
    edit("Add text layer", commands);
    select(clip.id);
  };
  const transcribe = () =>
    selected
      ? run("transcribe", {
          projectId: p.id,
          revision: p.revision,
          clipId: selected,
        })
      : report("Select a video or audio clip first.");
  const pauses = async (): Promise<{ removed: boolean } | undefined> => {
    if (!selected) {
      report("Select a video or audio clip first.");
      return;
    }
    return run("pauses", {
      projectId: p.id,
      revision: p.revision,
      clipId: selected,
    });
  };
  async function importMedia(paths?: string[], kind?: "audio") {
    setImporting(true);
    try {
      await api.invoke("import", { paths, kind });
    } catch (e) {
      report(e);
    } finally {
      setImporting(false);
    }
  }
  // A project that was never saved lives only in the recovery file, which a
  // new or opened project replaces.
  const unsaved = hasUnsavedWork(snap);
  // The main process asks "Save first?" with a native dialog (for the
  // toolbar, the File menu, Finder and launch alike) and keeps a dated backup.
  const leaveProject = async (action: "new" | "open") => {
    await run(action);
    if (action === "new") setSelected(undefined);
  };
  // `shown` is the layer as drawn at the playhead, animation included.
  const startTransform = (
    e: React.PointerEvent,
    shown: Clip,
    resize = false,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).focus();
    select(shown.id);
    player.current?.pause();
    const original = p.clips.find((c) => c.id === shown.id);
    if (!original) return;
    const local = playhead.get() - original.start;
    const initial = { x: e.clientX, y: e.clientY };
    const scale = p.width / previewSize.width;
    let change: Partial<Pick<Clip, "x" | "y" | "width" | "height">> = {};
    const frame = playhead.get();
    const others = p.clips
      .filter(
        (c) =>
          c.id !== original.id &&
          c.kind !== "audio" &&
          frame >= c.start &&
          frame < c.start + c.duration &&
          !p.tracks.find((t) => t.id === c.trackId)?.hidden,
      )
      .map((c) => {
        const evaluated = evaluatedClip(c, frame - c.start);
        const pulse = reactiveClipVisual(
          c,
          frame,
          c.musicReactive ? music.get(c.musicReactive.musicClipId) : undefined,
        );
        return { ...evaluated, scale: evaluated.scale * pulse.scale };
      });
    // The video and its box move together while dragging, at most once a frame.
    let request = 0;
    const show = () => {
      request = 0;
      layerDraft.set(previewTransform(original, change, local));
    };
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - initial.x) * scale),
        dy = Math.round((ev.clientY - initial.y) * scale);
      if (resize) {
        change = resizeOnStage(shown, dx, dy, ev.shiftKey);
        showGuides();
      } else {
        const axis = ev.shiftKey
          ? Math.abs(dx) >= Math.abs(dy)
            ? "x"
            : "y"
          : undefined;
        const moved = {
          ...shown,
          x: Math.max(-8000, Math.min(8000, shown.x + (axis === "y" ? 0 : dx))),
          y: Math.max(-8000, Math.min(8000, shown.y + (axis === "x" ? 0 : dy))),
        };
        if (stageSnap && !ev.altKey) {
          const snapped = snapOnStage(moved, p, others, 6 * scale, axis);
          change = { x: snapped.x, y: snapped.y };
          showGuides(snapped.guideX, snapped.guideY);
        } else {
          change = { x: moved.x, y: moved.y };
          showGuides();
        }
      }
      if (!request) request = requestAnimationFrame(show);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      showGuides();
      cancelAnimationFrame(request);
      request = 0;
    };
    const escape = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
      }
    };
    const cancel = () => {
      stop();
      layerDraft.set(undefined);
    };
    const end = () => {
      stop();
      if (!Object.keys(change).length) {
        layerDraft.set(undefined);
        return;
      }
      show();
      const from = p.revision;
      pendingLayer.current = from;
      void edit(
        resize ? "Resize layer" : "Move layer",
        transformCommands(original, change, local),
      ).then((saved) => {
        if (saved || pendingLayer.current !== from) return;
        pendingLayer.current = undefined;
        layerDraft.set(undefined);
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel, { once: true });
  };
  const nudgeOnStage = (shown: Clip, dx: number, dy: number) => {
    if (canvasNudge.current && canvasNudge.current.original.id !== shown.id)
      canvasNudge.current.finish();
    if (!canvasNudge.current) {
      const original = snapRef.current?.project.clips.find(
        (c) => c.id === shown.id,
      );
      if (!original) return;
      const local = playhead.get() - original.start;
      const cleanup = () => {
        window.removeEventListener("keyup", release);
        window.removeEventListener("blur", finish);
        window.removeEventListener("keydown", escape, true);
      };
      const finish = () => {
        const state = canvasNudge.current;
        if (!state) return;
        cleanup();
        canvasNudge.current = undefined;
        const revision = snapRef.current?.project.revision;
        if (revision === undefined) return;
        pendingLayer.current = revision;
        void edit(
          "Nudge layer",
          transformCommands(
            state.original,
            { x: state.x, y: state.y },
            state.local,
          ),
        ).then((saved) => {
          if (!saved && pendingLayer.current === revision) {
            pendingLayer.current = undefined;
            layerDraft.set(undefined);
          }
        });
      };
      const release = (e: KeyboardEvent) => {
        if (e.key.startsWith("Arrow")) finish();
      };
      const escape = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cleanup();
          canvasNudge.current = undefined;
          layerDraft.set(undefined);
        }
      };
      canvasNudge.current = { original, local, x: shown.x, y: shown.y, finish };
      window.addEventListener("keyup", release);
      window.addEventListener("blur", finish);
      window.addEventListener("keydown", escape, true);
    }
    const state = canvasNudge.current;
    if (!state) return;
    state.x = Math.max(-8000, Math.min(8000, state.x + dx));
    state.y = Math.max(-8000, Math.min(8000, state.y + dy));
    layerDraft.set(
      previewTransform(state.original, { x: state.x, y: state.y }, state.local),
    );
  };
  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const paths = Array.from(e.dataTransfer.files).map((f) =>
          api.pathForFile(f),
        );
        if (paths.length) void importMedia(paths);
      }}
    >
      <header className="titlebar">
        <div className="brand">
          <div className="brand-mark">
            <span />
            <span />
            <span />
          </div>
          Cutline
        </div>
        <div className="project-title">
          <input
            aria-label="Project name"
            key={p.id + p.name}
            defaultValue={p.name}
            title={p.name}
            maxLength={120}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== p.name)
                edit("Rename project", [
                  { type: "project.update", patch: { name } },
                ]);
              else e.target.value = p.name;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = p.name;
                e.currentTarget.blur();
              }
            }}
          />
          {snap.filePath ? (
            <span className="saved">
              <Check size={11} /> Autosaved
            </span>
          ) : p.assets.length ||
            p.clips.length ||
            p.motions.length ||
            p.story ? (
            <span className="saved not-saved">Not saved</span>
          ) : null}
        </div>
        <div className="header-actions">
          <Sessions />
          <IconButton title="New project" onClick={() => leaveProject("new")}>
            <FilePlus size={16} />
          </IconButton>
          <IconButton
            title="Projects (⌘O)"
            onClick={() => setProjectsOpen(true)}
          >
            <FolderOpen size={16} />
          </IconButton>
          <IconButton title="Save project (⌘S)" onClick={() => run("save")}>
            <Save size={16} />
          </IconButton>
          <IconButton
            title="Settings & connections"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={16} />
          </IconButton>
          <button
            className="primary export"
            onClick={() => run("export")}
            disabled={!p.clips.length || exporting}
          >
            <Download size={14} />
            Export
          </button>
        </div>
      </header>
      <main className={"workspace " + (!sidebar ? "no-sidebar" : "")}>
        <aside className="library">
          <nav className="library-tabs">
            {libraryTabs.map((t) => (
              <button
                key={t.id}
                aria-pressed={left === t.id}
                className={left === t.id ? "active" : ""}
                onClick={() => setLeft(t.id)}
              >
                <t.icon size={17} />
                {t.label}
              </button>
            ))}
          </nav>
          <div style={{ display: left === "story" ? "contents" : "none" }}>
            <WithJobs jobs={jobs}>
              {(list) => (
                <StoryLibrary
                  project={p}
                  base={base}
                  jobs={list}
                  active={left === "story"}
                  missing={snap.missing}
                  importMedia={() => void importMedia()}
                  openGenerate={() => {
                    setGenerateMode("video");
                    setLeft("generate");
                  }}
                  openCaptions={() => setLeft("captions")}
                  openSettings={() => setSettingsOpen(true)}
                  onCreated={(frame) => {
                    // Playing follows the player's pause event, as everywhere.
                    player.current?.pause();
                    seek(frame);
                  }}
                  onAskAssistant={(text) => {
                    setSidebar(true);
                    setRight("assistant");
                    setAssistantDraft({ id: Date.now(), text });
                  }}
                  report={report}
                />
              )}
            </WithJobs>
          </div>
          <div
            className="reel-workspace"
            style={{ display: left === "reel" ? "flex" : "none" }}
          >
            <nav className="reel-mode pill-tabs" aria-label="Reel editing mode">
              <button
                className={reelMode === "auto" ? "active" : ""}
                aria-pressed={reelMode === "auto"}
                onClick={() => setReelMode("auto")}
              >
                Auto edit
              </button>
              <button
                className={reelMode === "manual" ? "active" : ""}
                aria-pressed={reelMode === "manual"}
                onClick={() => setReelMode("manual")}
              >
                Build manually
              </button>
            </nav>
            <div style={{ display: reelMode === "auto" ? "contents" : "none" }}>
              <WithJobs jobs={jobs}>
                {(list) => (
                  <AutoReel
                    key={p.id}
                    project={p}
                    jobs={list}
                    missing={snap.missing}
                    report={report}
                    onCreated={(f) => {
                      setSelected(undefined);
                      player.current?.pause();
                      seek(f);
                    }}
                    reviewCaptions={() => {
                      const first = p.clips
                        .filter((c) => c.kind === "caption")
                        .sort((a, b) => a.start - b.start)[0];
                      if (first) {
                        select(first.id);
                        seek(first.start);
                      }
                      setLeft("captions");
                    }}
                    reviewEffects={() => {
                      const first = p.clips.find(
                        (c) =>
                          c.kind === "video" &&
                          !p.assets.find((a) => a.id === c.assetId)?.origin,
                      );
                      if (first) {
                        select(first.id);
                        seek(first.start);
                      }
                      setLeft("effects");
                    }}
                    preview={(f) => {
                      seek(f);
                      player.current?.play();
                    }}
                    seek={(f) => {
                      player.current?.pause();
                      seek(f);
                    }}
                  />
                )}
              </WithJobs>
            </div>
            <div
              style={{ display: reelMode === "manual" ? "contents" : "none" }}
            >
              <ReelBuilder
                key={p.id}
                p={p}
                base={base}
                missing={snap.missing}
                importMedia={() => void importMedia()}
                openStock={() => setLeft("stock")}
                openCaptions={() => setLeft("captions")}
                onCreated={(f) => {
                  setSelected(undefined);
                  player.current?.pause();
                  seek(f);
                }}
                report={report}
              />
            </div>
          </div>
          <div style={{ display: left === "audio" ? "contents" : "none" }}>
            <WithJobs jobs={jobs}>
              {(list) => (
                <AudioLibrary
                  key={p.id}
                  project={p}
                  base={base}
                  jobs={list}
                  active={left === "audio"}
                  musicSync={
                    <MusicSync
                      project={p}
                      jobs={list}
                      selectedClipId={selected}
                      playhead={playhead}
                      active={left === "audio"}
                      musicClipId={effectiveMusicClipId}
                      onMusicClipId={setMusicClipId}
                      showBeats={showBeats}
                      onShowBeats={setShowBeats}
                      onSeek={seek}
                      onPlayFrom={(f) => {
                        seek(f);
                        player.current?.play();
                      }}
                      report={report}
                    />
                  }
                  addAudio={(a) => {
                    const frame = playhead.get();
                    const empty = p.tracks.find(
                      (t) =>
                        t.kind === "audio" &&
                        !t.muted &&
                        !t.hidden &&
                        !p.clips.some((c) => c.trackId === t.id),
                    );
                    if (empty) {
                      addAsset(a, empty.id, frame);
                      return;
                    }
                    const commands = stackAssets(p, [a], frame);
                    edit("Add audio layer", commands);
                    const added = commands.find((c) => c.type === "clip.add");
                    if (added?.type === "clip.add") {
                      setSelected(added.clip.id);
                      pendingSeek.current = { id: added.clip.id, frame };
                    }
                  }}
                  importAudio={() => void importMedia(undefined, "audio")}
                  report={report}
                />
              )}
            </WithJobs>
          </div>
          {left === "media" && (
            <div className="library-content">
              <div className="section-heading">
                <span>Project media</span>
                <small>{p.assets.length}</small>
              </div>
              <button
                className="import-button primary"
                disabled={importing}
                onClick={() => importMedia()}
              >
                {importing ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Upload size={16} />
                )}{" "}
                {importing ? "Importing…" : "Import media"}
              </button>
              {!p.assets.length ? (
                <div className="empty-library">
                  <div className="empty-media-icon">
                    <FilmIcon size={30} />
                    <Music2 size={14} />
                  </div>
                  <h3>No media yet</h3>
                  <p>Drop videos, photos or music here.</p>
                </div>
              ) : (
                <>
                  <label className="search-field library-search">
                    <Search size={14} />
                    <input
                      aria-label="Search media"
                      placeholder="Find media…"
                      value={mediaQuery}
                      onChange={(e) => setMediaQuery(e.target.value)}
                    />
                  </label>
                  <div
                    className="media-filters pill-tabs"
                    aria-label="Media types"
                  >
                    {["all", "video", "image", "audio"].map((kind) => (
                      <button
                        key={kind}
                        aria-pressed={mediaKind === kind}
                        className={mediaKind === kind ? "active" : ""}
                        onClick={() => setMediaKind(kind)}
                      >
                        {kind === "all"
                          ? "All"
                          : kind === "image"
                            ? "Photos"
                            : kind[0].toUpperCase() + kind.slice(1)}
                      </button>
                    ))}
                  </div>
                  <div className="media-batch">
                    <span>
                      {mediaSelection.length
                        ? `${mediaSelection.length} selected`
                        : "Build your sequence"}
                    </span>
                    <button
                      disabled={
                        !p.assets.some((a) => !snap.missing.includes(a.id))
                      }
                      onClick={() =>
                        addSequence(
                          p.assets.filter(
                            (a) =>
                              !snap.missing.includes(a.id) &&
                              (!mediaSelection.length ||
                                mediaSelection.includes(a.id)),
                          ),
                        )
                      }
                    >
                      {mediaSelection.length ? "Add selected" : "Add all"}{" "}
                      <Plus size={12} />
                    </button>
                  </div>
                  <button
                    className="full subtle stack-layers"
                    disabled={!mediaSelection.length}
                    onClick={addLayers}
                  >
                    <Layers size={14} />
                    {mediaSelection.length
                      ? `Stack ${mediaSelection.length} as layers`
                      : "Select media to stack as layers"}
                  </button>
                  <div className="asset-list">
                    {p.assets
                      .filter(
                        (a) =>
                          (mediaKind === "all" || a.kind === mediaKind) &&
                          a.name
                            .toLowerCase()
                            .includes(mediaQuery.toLowerCase()),
                      )
                      .map((a) => (
                        <div
                          key={a.id}
                          className={
                            "asset " +
                            (mediaSelection.includes(a.id) ? "picked" : "")
                          }
                        >
                          <label className="asset-select">
                            <input
                              aria-label={`Select ${a.name}`}
                              type="checkbox"
                              checked={mediaSelection.includes(a.id)}
                              onChange={(e) =>
                                toggleMedia(a.id, e.target.checked)
                              }
                            />
                          </label>
                          {/* A click selects, like the checkbox. Adding is
                              the + button, a double-click or a drag. */}
                          <button
                            className="asset-preview"
                            draggable={!snap.missing.includes(a.id)}
                            onDragStart={(e) => {
                              e.dataTransfer.setData(ASSET_DRAG, a.id);
                              // The kind lets tracks that refuse it say so
                              // while dragging; data is unreadable until drop.
                              e.dataTransfer.setData(assetKindDrag(a.kind), a.kind);
                              e.dataTransfer.effectAllowed = "copy";
                            }}
                            title="Double-click to add, or drag onto a track"
                            aria-label={a.name}
                            aria-pressed={mediaSelection.includes(a.id)}
                            onClick={() =>
                              toggleMedia(a.id, !mediaSelection.includes(a.id))
                            }
                            onDoubleClick={() => {
                              if (!snap.missing.includes(a.id)) addAsset(a);
                            }}
                          >
                            {a.thumbnail ? (
                              <img src={`${base}/media/${a.id}/thumb`} alt="" />
                            ) : (
                              <Music2 size={22} />
                            )}
                            <span className="asset-duration">
                              {Math.round(a.duration)}s
                            </span>
                          </button>
                          <button
                            className="asset-add"
                            aria-label={`Add ${a.name} to timeline`}
                            title="Add to timeline"
                            disabled={snap.missing.includes(a.id)}
                            onClick={() => addAsset(a)}
                          >
                            <Plus size={14} />
                          </button>
                          <div className="asset-caption">
                            <span title={a.name}>{a.name}</span>
                            <small>{kindLabel(a.kind)}</small>
                          </div>
                          {a.kind !== "audio" && (
                            <button
                              className="asset-broll"
                              disabled={snap.missing.includes(a.id)}
                              onClick={() => void addBroll(a).catch(report)}
                            >
                              <Layers size={11} /> Add as B-roll
                            </button>
                          )}
                          {a.origin && (
                            <button
                              className="asset-credit"
                              title={`${a.origin.creator} · ${a.origin.license}`}
                              onClick={() =>
                                run("stock.source", { url: a.origin!.page })
                              }
                            >
                              {a.origin.license} ↗
                            </button>
                          )}
                          {snap.missing.includes(a.id) && (
                            <button
                              className="missing"
                              onClick={() => run("relink", { id: a.id })}
                            >
                              <Link2 size={12} />
                              Relink missing file
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                </>
              )}
              <div className="library-footer">
                <span className="local-dot" />
                Local files · Original quality
              </div>
            </div>
          )}
          {/* Kept mounted: a logo search or page capture can take a while. */}
          <div style={{ display: left === "text" ? "contents" : "none" }}>
            <MotionLibrary
              visible={left === "text"}
              mediaBase={base}
              openGraphic={() => {
                setGenerateMode("graphic");
                setLeft("generate");
              }}
              p={p}
              playhead={playhead}
              edit={edit}
              select={select}
              addText={addText}
            />
          </div>
          {left === "effects" && (
            <EffectsPanel p={p} clip={clip} edit={edit} base={base} />
          )}
          <div
            className="stock-holder"
            style={{ display: left === "stock" ? "contents" : "none" }}
          >
            <StockLibrary
              active={left === "stock"}
              addBroll={addBroll}
              report={report}
              openSettings={() => setSettingsOpen(true)}
            />
          </div>
          {/* Both modes stay mounted: a graphic can take a minute to draw. */}
          <div
            className="generate-workspace"
            style={{ display: left === "generate" ? "flex" : "none" }}
          >
            <nav className="generate-mode pill-tabs" aria-label="Generate">
              <button
                className={generateMode === "graphic" ? "active" : ""}
                aria-pressed={generateMode === "graphic"}
                onClick={() => setGenerateMode("graphic")}
              >
                Graphic
              </button>
              <button
                className={generateMode === "video" ? "active" : ""}
                aria-pressed={generateMode === "video"}
                onClick={() => setGenerateMode("video")}
              >
                Video
              </button>
            </nav>
            <div
              style={{ display: generateMode === "graphic" ? "contents" : "none" }}
            >
              <GraphicStudio
                p={p}
                playhead={playhead}
                edit={edit}
                select={select}
                mediaBase={base}
                openSettings={() => setSettingsOpen(true)}
              />
            </div>
            <div
              style={{ display: generateMode === "video" ? "contents" : "none" }}
            >
              <GenerateLibrary
                openSettings={() => setSettingsOpen(true)}
                active={left === "generate" && generateMode === "video"}
                projectId={p.id}
                aspectRatio={
                  p.width > p.height
                    ? "16:9"
                    : p.height > p.width
                      ? "9:16"
                      : "1:1"
                }
                addBroll={addBroll}
                report={report}
              />
            </div>
          </div>
          <div style={{ display: left === "captions" ? "contents" : "none" }}>
            <CaptionLibrary
              key={p.id}
              active={left === "captions"}
              p={p}
              playhead={playhead}
              selected={selected}
              select={select}
              seek={seek}
              edit={edit}
              transcribe={transcribe}
              run={run}
              busy={transcribing}
            />
          </div>
        </aside>
        <section className="preview-panel">
          <div className="preview-toolbar">
            <div className="row">
              <select
                aria-label="Project aspect ratio"
                value={`${p.width}:${p.height}`}
                onChange={(e) => {
                  const [width, height] = e.target.value.split(":").map(Number);
                  try {
                    const commands = resizeCanvas(p, width, height);
                    if (commands.length) void edit("Change canvas", commands);
                  } catch (e) {
                    report(e);
                  }
                }}
              >
                {![
                  [1080, 1920],
                  [1920, 1080],
                  [1080, 1080],
                ].some(([w, h]) => w === p.width && h === p.height) && (
                  <option value={`${p.width}:${p.height}`}>
                    {Math.abs(p.width / p.height - 16 / 9) < 0.01
                      ? "16:9"
                      : Math.abs(p.width / p.height - 9 / 16) < 0.01
                        ? "9:16"
                        : p.width === p.height
                          ? "1:1"
                          : "Custom"}{" "}
                    · {p.width}×{p.height}
                  </option>
                )}
                <option value="1080:1920">9:16 · Portrait</option>
                <option value="1920:1080">16:9 · Landscape</option>
                <option value="1080:1080">1:1 · Square</option>
              </select>
            </div>
            <div className="row">
              <button
                aria-pressed={stageSnap}
                title="Snap canvas edges and centers while dragging · Option bypasses snapping"
                onClick={() => setStageSnap(!stageSnap)}
              >
                Snap
              </button>
              <button
                aria-pressed={thirdsGuides}
                title="Rule-of-thirds guides (not exported)"
                onClick={() => setThirdsGuides(!thirdsGuides)}
              >
                Grid
              </button>
              <button
                aria-pressed={safeGuides}
                title="Preview safe area for Reel captions (not exported)"
                onClick={() => setSafeGuides(!safeGuides)}
              >
                Safe area
              </button>
              {p.clips.length ? (
                <span className="muted">{p.fps} fps</span>
              ) : (
                // Clip timing is counted in frames, so the rate is set first.
                <select
                  aria-label="Frame rate"
                  title="Choose the frame rate before adding clips"
                  value={p.fps}
                  onChange={(e) =>
                    void edit("Change frame rate", [
                      {
                        type: "project.update",
                        patch: {
                          fps: Number(e.target.value) as Project["fps"],
                        },
                      },
                    ])
                  }
                >
                  {[24, 25, 30, 60].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate} fps
                    </option>
                  ))}
                </select>
              )}
              <IconButton
                title={sidebar ? "Hide inspector" : "Show inspector"}
                onClick={() => setSidebar(!sidebar)}
              >
                {sidebar ? (
                  <PanelRightClose size={15} />
                ) : (
                  <PanelRightOpen size={15} />
                )}
              </IconButton>
            </div>
          </div>
          <div
            className="stage"
            ref={stage}
            onClick={() => {
              if (selected) setSelected(undefined);
            }}
          >
            <div
              className="canvas"
              style={previewSize}
              onClick={(e) => e.stopPropagation()}
            >
              <LivePlayer
                ref={player}
                project={p}
                mediaBase={base}
                draft={layerDraft}
              />
              {thirdsGuides && (
                <div className="thirds-guide" aria-hidden="true" />
              )}
              {snapGuides.x !== undefined && (
                <div
                  className="stage-guide vertical"
                  style={{ left: `${(snapGuides.x / p.width) * 100}%` }}
                />
              )}
              {snapGuides.y !== undefined && (
                <div
                  className="stage-guide horizontal"
                  style={{ top: `${(snapGuides.y / p.height) * 100}%` }}
                />
              )}
              {safeGuides && (
                <div className="safe-guide">
                  <span>Reel safe area</span>
                </div>
              )}
              {!p.clips.length && (
                <div className="canvas-empty">
                  <div className="frame-corners">
                    <FilmIcon size={28} />
                  </div>
                  <span>No clips yet</span>
                  <small>Import media or drop a video anywhere</small>
                </div>
              )}
              {!playing && (
                <PreviewOverlays
                  p={p}
                  playhead={playhead}
                  draft={layerDraft}
                  music={music}
                  size={previewSize}
                  selected={selected}
                  onPress={startTransform}
                  onSelect={select}
                  onNudge={nudgeOnStage}
                />
              )}
            </div>
          </div>
          <div className="transport">
            <div className="row">
              <IconButton
                title="Undo (⌘Z)"
                disabled={!snap.canUndo}
                onClick={() => run("undo")}
              >
                <Undo2 size={15} />
              </IconButton>
              <IconButton
                title="Redo (⇧⌘Z)"
                disabled={!snap.canRedo}
                onClick={() => run("redo")}
              >
                <Redo2 size={15} />
              </IconButton>
            </div>
            <div className="play-controls">
              <IconButton title="Go to start" onClick={() => seek(0)}>
                <SkipBack size={16} />
              </IconButton>
              <button
                className="play-button"
                aria-label={playing ? "Pause" : "Play"}
                onClick={() => player.current?.toggle()}
              >
                {playing ? (
                  <Pause size={17} />
                ) : (
                  <Play size={17} fill="currentColor" />
                )}
              </button>
              <Timecode playhead={playhead} fps={p.fps} total={duration(p)} />
            </div>
            <span className="fit-label">
              Fit · {Math.round((previewSize.width / p.width) * 100)}%
            </span>
          </div>
        </section>
        {/* Hidden, not removed: the assistant's conversation must survive. */}
        {(
          <aside
            className="right-panel"
            style={sidebar ? undefined : { display: "none" }}
          >
            <nav className="right-tabs pill-tabs">
              <button
                className={right === "properties" ? "active" : ""}
                onClick={() => setRight("properties")}
              >
                <SlidersHorizontal size={14} />
                Properties
              </button>
              <button
                className={right === "assistant" ? "active" : ""}
                onClick={() => setRight("assistant")}
              >
                <Sparkles size={14} />
                Assistant
              </button>
            </nav>
            <div
              style={{ display: right === "properties" ? "contents" : "none" }}
            >
              <Inspector
                key={clip?.id ?? "none"}
                project={p}
                playhead={playhead}
                playing={playing}
                active={sidebar && right === "properties"}
                seek={seek}
                clip={clip}
                edit={edit}
                transcribe={transcribe}
                pauses={pauses}
                transcribing={transcribing}
                findingPauses={findingPauses}
                report={report}
                openPanel={setLeft}
              />
            </div>
            <div
              className="assistant-holder"
              style={{ display: right === "assistant" ? "flex" : "none" }}
            >
              <Assistant
                selected={selected}
                report={report}
                draft={assistantDraft}
                playhead={playhead}
                fps={p.fps}
                hasVideo={p.clips.some((c) => c.kind === "video")}
              />
            </div>
          </aside>
        )}
      </main>
      <Timeline
        beats={beats}
        p={p}
        playhead={playhead}
        selected={selected}
        select={select}
        seek={seek}
        edit={edit}
        split={split}
        remove={remove}
        base={base}
        playing={playing}
        duplicate={duplicate}
        addMedia={(assetId, trackId, start) => {
          const asset = p.assets.find((a) => a.id === assetId);
          if (asset) addAsset(asset, trackId, start);
        }}
      />
      <footer className="statusbar">
        <span>
          <span className="local-dot" />{" "}
          {snap.filePath ? "Project saved" : "Recovery saved locally"}
        </span>
        <JobStatus jobs={jobs} run={run} report={report} />
      </footer>
      {error && (
        <div className="error-toast" role="alert">
          <div>
            <strong>Couldn’t complete that action</strong>
            <p>{error}</p>
          </div>
          <IconButton title="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <Upload size={34} />
          <h2>Drop your media</h2>
          <p>Video, photos, and audio</p>
        </div>
      )}
      {projectsOpen && (
        <Projects
          onClose={() => {
            setProjectsOpen(false);
            setSelected(undefined);
          }}
          report={report}
        />
      )}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section
            ref={settingsModal}
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                setSettingsOpen(false);
                return;
              }
              keepFocusInside(e);
            }}
          >
            <div className="section-heading">
              <h2>Settings & connections</h2>
              <IconButton
                title="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={18} />
              </IconButton>
            </div>
            <h3>Local transcription</h3>
            <p>
              {settings?.transcriptionReady
                ? "Whisper base multilingual model is installed. Speech stays on this Mac."
                : "Speech tools are missing from this install. Reinstall Cutline to transcribe."}
            </p>
            <HiggsfieldSettings report={report} />
            <AgentConnections
              settings={settings}
              report={report}
              openAssistant={() => {
                setSettingsOpen(false);
                setRight("assistant");
                setSidebar(true);
              }}
            />
          </section>
        </div>
      )}
    </div>
  );
}
