import React, { useEffect, useMemo, useState } from "react";
import { Player, Thumbnail } from "@remotion/player";
import {
  Layers,
  Shapes,
  Type,
  Search,
  Plus,
  PenTool,
  Upload,
  Clapperboard,
  Play,
  Pause,
} from "lucide-react";
import { Film } from "../composition/Video";
import { newProject, type Clip, type Project } from "../shared/model";
import { applyCommands, type Command } from "../shared/commands";
import { textAnimations } from "../shared/effects";
import {
  createMotionScene,
  createShapeLayer,
  motionScenes,
  motionSceneCategories,
  shapeTypes,
  type MotionSceneId,
  type ShapeType,
} from "../shared/motion-presets";
import { MotionTile } from "./MotionTile";
import { parseEditableSvg } from "../shared/vector-path";
import { createVectorScene } from "../shared/vector-scenes";
import { VectorStudio } from "./VectorStudio";
import type { Playhead } from "./playhead";
import {
  createMotionSequence,
  defaultMotionSequence,
  motionSequencePaces,
  type MotionSequenceOptions,
} from "../shared/motion-sequence";
import "./motion.css";

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * A scene or shape card. Idle cards show one still frame; only the card being
 * hovered or focused mounts a live player, so a full grid stays light.
 */
export function MotionPreviewTile({
  id,
  name,
  description,
  color,
  kind,
  active,
  reduced,
  busy,
  onPreview,
  onAdd,
}: {
  id: MotionSceneId | ShapeType;
  name: string;
  description: string;
  color: string;
  kind: "scene" | "shape";
  active: boolean;
  reduced: boolean;
  busy: boolean;
  onPreview: (active: boolean) => void;
  onAdd: () => void;
}) {
  const project = useMemo(() => {
    const p = {
      ...newProject(),
      width: 640,
      height: 360,
      background: "#0d0d10",
    };
    const created =
      kind === "scene"
        ? createMotionScene(p, 0, id as MotionSceneId)
        : createShapeLayer(p, 0, id as ShapeType);
    p.clips = [created.clip];
    p.motions = [created.motion];
    return p;
  }, [id, kind]);
  const playing = active && !reduced;
  return (
    <button
      className={`mg-tile mg-${kind}`}
      aria-label={`Add ${name} ${kind}`}
      disabled={busy}
      onMouseEnter={() => onPreview(true)}
      onMouseLeave={() => onPreview(false)}
      onFocus={() => onPreview(true)}
      onBlur={() => onPreview(false)}
      onClick={onAdd}
      style={{ "--mg-color": color } as React.CSSProperties}
    >
      <div className="mg-preview" aria-hidden="true">
        {playing ? (
          <Player
            component={Film}
            inputProps={{ project, mediaBase: "", preview: true }}
            durationInFrames={project.fps * 4}
            compositionWidth={640}
            compositionHeight={360}
            fps={project.fps}
            autoPlay
            loop
            controls={false}
            clickToPlay={false}
            style={{ width: "100%", height: "100%", pointerEvents: "none" }}
          />
        ) : (
          <Thumbnail
            component={Film}
            inputProps={{ project, mediaBase: "", preview: true }}
            durationInFrames={project.fps * 4}
            compositionWidth={640}
            compositionHeight={360}
            fps={project.fps}
            frameToDisplay={48}
            style={{ width: "100%", height: "100%", pointerEvents: "none" }}
          />
        )}
        <span className="mg-preview-action">
          <Plus size={12} /> Add
        </span>
      </div>
      <span className="mg-tile-label">
        <strong>{name}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

export function MotionLibrary({
  p,
  playhead,
  edit,
  select,
  addText,
  mediaBase = "",
  openSettings,
  visible = true,
}: {
  p: Project;
  /** New items start at the playhead; read when they are added. */
  playhead: Playhead;
  edit: (label: string, commands: Command[]) => Promise<boolean>;
  select: (id: string) => void;
  addText: (preset: Clip["preset"]) => void;
  mediaBase?: string;
  openSettings?: () => void;
  /** False while another library tab is showing; previews pause. */
  visible?: boolean;
}) {
  const [tab, setTab] = useState<
    "sequence" | "scenes" | "shapes" | "vectors" | "text"
  >("sequence");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Signature");
  const [active, setActive] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sequence, setSequence] = useState<MotionSequenceOptions>({
    ...defaultMotionSequence,
  });
  const [sequencePlaying, setSequencePlaying] = useState(false);
  useEffect(() => {
    if (!visible) setSequencePlaying(false);
  }, [visible]);
  const [sequenceAdded, setSequenceAdded] = useState("");
  const reduced = useReducedMotion();
  const matches = (value: string) =>
    value.toLowerCase().includes(query.trim().toLowerCase());
  const scenes = motionScenes.filter(
    (scene) =>
      (query.trim() || category === "All" || scene.category === category) &&
      matches(`${scene.name} ${scene.description} ${scene.category}`),
  );
  const shapes = shapeTypes.filter((type) =>
    matches(type === "ellipse" ? "circle ellipse" : type),
  );
  const titles = textAnimations.filter((title) =>
    matches(`${title.label} ${title.preset}`),
  );
  const logos = motionScenes.filter(
    (scene) =>
      scene.category === "Logos" &&
      matches(`${scene.name} ${scene.description}`),
  );
  useEffect(() => {
    setError("");
    setSequenceAdded("");
    setSequencePlaying(false);
    setSequence((current) => ({ ...current, assetId: undefined }));
  }, [p.id]);
  const sequencePreview = useMemo(() => {
    if (tab !== "sequence") return undefined;
    try {
      const preview = {
        ...newProject(),
        width: p.width,
        height: p.height,
        fps: p.fps,
        assets: p.assets,
      };
      const built = createMotionSequence(preview, 0, sequence);
      return {
        project: applyCommands(preview, {
          projectId: preview.id,
          revision: preview.revision,
          label: "Preview sequence",
          commands: built.commands,
        }),
        duration: built.durationFrames,
      };
    } catch {
      return undefined;
    }
  }, [tab, p.width, p.height, p.fps, p.assets, sequence]);
  const updateSequence = (patch: Partial<MotionSequenceOptions>) => {
    setSequence((current) => ({ ...current, ...patch }));
    setSequenceAdded("");
    setError("");
  };
  const addSequence = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setSequenceAdded("");
    try {
      const start = playhead.get();
      const built = createMotionSequence(p, start, sequence);
      if (await edit("Build connected motion sequence", built.commands)) {
        select(built.firstClipId);
        setSequenceAdded(
          `${sequence.seconds}s added at ${(start / p.fps).toFixed(1)}s. Select any scene to edit its layers.`,
        );
        setSequencePlaying(false);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const addVector = async (importSvg: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (importSvg) {
        const result = await window.cutline.invoke("vector.import", {
          projectId: p.id,
          revision: p.revision,
          startFrame: playhead.get(),
        });
        if (result?.clipId) select(result.clipId);
      } else {
        const parsed = parseEditableSvg(
          '<svg viewBox="0 0 100 100"><path d="M15 75 L50 15 L85 75" fill="none" stroke="#81b6ff" stroke-width="4"/></svg>',
        );
        const created = createVectorScene(p, playhead.get(), parsed, {
          name: "Custom vector",
        });
        if (await edit("Draw custom vector", created.commands))
          select(created.clip.id);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const add = async (
    id: MotionSceneId | ShapeType,
    kind: "scene" | "shape",
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const frame = playhead.get();
      const created =
        kind === "scene"
          ? createMotionScene(p, frame, id as MotionSceneId)
          : createShapeLayer(p, frame, id as ShapeType);
      if (await edit(`Add ${created.motion.name}`, created.commands))
        select(created.clip.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="library-content motion-library">
      <div className="section-heading">
        <span>Motion graphics</span>
        <small>
          {tab === "sequence"
            ? "3 connected acts"
            : tab === "scenes"
              ? scenes.length !== motionScenes.length
                ? `${scenes.length} of ${motionScenes.length} scenes`
                : `${motionScenes.length} scenes`
              : tab === "shapes"
                ? `${shapes.length} shapes`
                : tab === "text"
                  ? `${titles.length} styles`
                  : ""}
        </small>
      </div>
      <div
        className="mg-tabs pill-tabs"
        role="tablist"
        aria-label="Motion library"
      >
        {(
          [
            ["sequence", "Sequence", Clapperboard],
            ["scenes", "Scenes", Layers],
            ["shapes", "Shapes", Shapes],
            ["vectors", "Vectors", PenTool],
            ["text", "Text", Type],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`mg-panel-${id}`}
            id={`mg-tab-${id}`}
            onClick={() => {
              setTab(id);
              setQuery("");
              setError("");
              setCategory(id === "scenes" ? "Signature" : "All");
              setActive(undefined);
              setSequencePlaying(false);
            }}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>
      {tab !== "sequence" && tab !== "vectors" && (
        <label className="search-field mg-search">
          <Search size={13} />
          <input
            aria-label="Search motion library"
            placeholder={
              tab === "scenes" ? "Search all scenes…" : `Search ${tab}…`
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
      <div
        id={`mg-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`mg-tab-${tab}`}
      >
        {tab === "sequence" && (
          <div className="mg-sequence">
            <p className="mg-sequence-intro">
              A strong opening, a developing idea, and a resolved ending.
              Connected by one traveling mark.
            </p>
            {sequencePreview && (
              <div
                className="mg-sequence-preview"
                style={{
                  aspectRatio: `${p.width} / ${p.height}`,
                  maxWidth:
                    p.height > p.width ? (p.width / p.height) * 260 : undefined,
                }}
              >
                {sequencePlaying ? (
                  <Player
                    component={Film}
                    inputProps={{
                      project: sequencePreview.project,
                      mediaBase,
                      preview: true,
                    }}
                    durationInFrames={sequencePreview.duration}
                    compositionWidth={p.width}
                    compositionHeight={p.height}
                    fps={p.fps}
                    autoPlay
                    loop
                    controls={false}
                    clickToPlay={false}
                    style={{ width: "100%", height: "100%" }}
                  />
                ) : (
                  <Thumbnail
                    component={Film}
                    inputProps={{
                      project: sequencePreview.project,
                      mediaBase,
                      preview: true,
                    }}
                    durationInFrames={sequencePreview.duration}
                    compositionWidth={p.width}
                    compositionHeight={p.height}
                    fps={p.fps}
                    frameToDisplay={Math.round(p.fps * 1.5)}
                    style={{ width: "100%", height: "100%" }}
                  />
                )}
                <button
                  className="mg-sequence-play"
                  aria-label={
                    sequencePlaying
                      ? "Pause sequence preview"
                      : "Play sequence preview"
                  }
                  aria-pressed={sequencePlaying}
                  onClick={() => setSequencePlaying((value) => !value)}
                >
                  {sequencePlaying ? <Pause size={13} /> : <Play size={13} />}
                  {sequencePlaying ? "Pause" : "Preview"}
                </button>
              </div>
            )}
            <div className="mg-sequence-steps" aria-label="Sequence structure">
              <span>
                <b>01</b> Open
              </span>
              <span>
                <b>02</b> {sequence.assetId ? "Demo" : "Develop"}
              </span>
              <span>
                <b>03</b> Resolve
              </span>
            </div>
            <label className="mg-sequence-field">
              <span>Brand</span>
              <input
                aria-label="Sequence brand"
                value={sequence.brand}
                maxLength={28}
                onChange={(event) =>
                  updateSequence({ brand: event.target.value })
                }
              />
            </label>
            <label className="mg-sequence-field">
              <span>Opening headline</span>
              <textarea
                aria-label="Sequence opening headline"
                rows={2}
                maxLength={60}
                value={sequence.headline}
                onChange={(event) =>
                  updateSequence({ headline: event.target.value })
                }
              />
            </label>
            <label className="mg-sequence-field">
              <span>Supporting idea</span>
              <textarea
                aria-label="Sequence supporting idea"
                rows={2}
                maxLength={100}
                value={sequence.detail}
                onChange={(event) =>
                  updateSequence({ detail: event.target.value })
                }
              />
            </label>
            <label className="mg-sequence-field">
              <span>Closing headline</span>
              <textarea
                aria-label="Sequence closing headline"
                rows={2}
                maxLength={60}
                value={sequence.closing}
                onChange={(event) =>
                  updateSequence({ closing: event.target.value })
                }
              />
            </label>
            <fieldset className="mg-sequence-pace">
              <legend>Pace</legend>
              <div>
                {motionSequencePaces.map((pace) => (
                  <button
                    key={pace.seconds}
                    aria-pressed={sequence.seconds === pace.seconds}
                    title={pace.description}
                    onClick={() => updateSequence({ seconds: pace.seconds })}
                  >
                    <strong>{pace.seconds}s</strong>
                    <span>{pace.label}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="mg-sequence-field">
              <span>
                Screen demo <small>optional</small>
              </span>
              <select
                aria-label="Sequence screen demo"
                value={sequence.assetId ?? ""}
                onChange={(event) =>
                  updateSequence({ assetId: event.target.value || undefined })
                }
              >
                <option value="">Graphic development</option>
                {p.assets
                  .filter(
                    (asset) => asset.kind === "image" || asset.kind === "video",
                  )
                  .map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="mg-sequence-hint">
              Choose an imported screenshot or recording for the middle act.
              Recordings play once, with their sound muted.
            </p>
            <details className="mg-sequence-palette">
              <summary>Brand colors</summary>
              <div>
                {(
                  [
                    ["paper", "Light"],
                    ["ink", "Dark"],
                    ["accent", "Accent"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="color"
                      aria-label={`Sequence ${label.toLowerCase()} color`}
                      value={sequence[key]}
                      onChange={(event) =>
                        updateSequence({ [key]: event.target.value })
                      }
                    />
                    <span>{label}</span>
                    <code>{sequence[key]}</code>
                  </label>
                ))}
              </div>
            </details>
            <div className="panel-action-bar">
              <button
                className="import-button primary mg-sequence-add"
                disabled={busy}
                onClick={() => void addSequence()}
              >
                <Clapperboard size={16} />
                {busy
                  ? "Building sequence…"
                  : `Add ${sequence.seconds}s sequence`}
              </button>
            </div>
            <p className="mg-sequence-hint">
              New tracks at the playhead · one undo step · every layer stays
              editable.
            </p>
            {sequenceAdded && (
              <p className="mg-sequence-result" role="status">
                {sequenceAdded}
              </p>
            )}
          </div>
        )}
        {tab === "scenes" && (
          <>
            <div className="mg-filters pill-tabs" aria-label="Scene categories">
              {motionSceneCategories.map((value) => (
                <button
                  key={value}
                  aria-pressed={category === value}
                  onClick={() => setCategory(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="mg-grid">
              {scenes.map((scene) => (
                <MotionPreviewTile
                  key={scene.id}
                  id={scene.id}
                  name={scene.name}
                  description={scene.description}
                  color={scene.color}
                  kind="scene"
                  active={active === scene.id}
                  reduced={reduced}
                  busy={busy}
                  onPreview={(value) => setActive(value ? scene.id : undefined)}
                  onAdd={() => void add(scene.id, "scene")}
                />
              ))}
            </div>
            {!scenes.length && <p className="mg-empty">No scenes match.</p>}
          </>
        )}
        {tab === "shapes" && (
          <>
            <div className="mg-grid">
              {shapes.map((type) => {
                const name =
                  type === "ellipse"
                    ? "Circle"
                    : type[0].toUpperCase() + type.slice(1);
                return (
                  <MotionPreviewTile
                    key={type}
                    id={type}
                    name={name}
                    description={
                      type === "line" ? "Draw-on stroke" : "Elastic entrance"
                    }
                    color="#81b6ff"
                    kind="shape"
                    active={active === type}
                    reduced={reduced}
                    busy={busy}
                    onPreview={(value) => setActive(value ? type : undefined)}
                    onAdd={() => void add(type, "shape")}
                  />
                );
              })}
            </div>
            {!shapes.length && <p className="mg-empty">No shapes match.</p>}
          </>
        )}
        {/* Vectors stays mounted across sub-tabs so a drawing in progress
            and its result are still there when you come back. */}
        <div style={{ display: tab === "vectors" ? "contents" : "none" }}>
            <VectorStudio
              p={p}
              playhead={playhead}
              edit={edit}
              select={select}
              onError={setError}
              mediaBase={mediaBase}
              openSettings={openSettings}
            />
            <div className="section-heading">
              <span>Draw or import</span>
            </div>
            <div className="mg-vector-actions">
              <button
                className="import-button control"
                disabled={busy}
                onClick={() => void addVector(false)}
              >
                <PenTool size={16} />
                Draw vector
              </button>
              <button
                className="import-button control"
                disabled={busy}
                onClick={() => void addVector(true)}
              >
                <Upload size={16} />
                Import SVG
              </button>
            </div>
            <div className="section-heading mg-logo-heading">
              <span>Logo reveals</span>
              <small>{logos.length} scenes</small>
            </div>
            <div className="mg-grid">
              {logos.map((scene) => (
                <MotionPreviewTile
                  key={scene.id}
                  id={scene.id}
                  name={scene.name}
                  description={scene.description}
                  color={scene.color}
                  kind="scene"
                  active={active === scene.id}
                  reduced={reduced}
                  busy={busy}
                  onPreview={(value) => setActive(value ? scene.id : undefined)}
                  onAdd={() => void add(scene.id, "scene")}
                />
              ))}
            </div>
            {!logos.length && <p className="mg-empty">No logo scenes match.</p>}
        </div>
        {tab === "text" && (
          <>
            <button
              className="import-button primary"
              onClick={() => addText("none")}
            >
              <Type size={16} />
              Add plain text
            </button>
            <div className="motion-grid">
              {titles.map((title) => (
                <MotionTile
                  key={title.preset}
                  preset={title.preset}
                  label={title.label}
                  onAdd={() => addText(title.preset)}
                />
              ))}
            </div>
            {!titles.length && (
              <p className="mg-empty">No text styles match.</p>
            )}
          </>
        )}
      </div>
      <div className="mg-footer">Adds at the playhead</div>
    </div>
  );
}
