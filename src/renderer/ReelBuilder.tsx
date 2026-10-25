import React, { useMemo, useState, useEffect, useRef } from "react";
import { plural } from "../shared/plural";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Film,
  LoaderCircle,
  Music2,
  Sparkles,
  Upload,
  Plus,
  Trash2,
} from "lucide-react";
import type { Clip, Project } from "../shared/model";
import { captionStyles } from "../shared/caption-styles";
import { reelFormats, type ReelFormat } from "../shared/reel-formats";
import { allocateReelFrames } from "../shared/reel";
import { errorText } from "./controls";
import { assetMediaVersion } from "../composition/Video";

type BeatDraft = {
  id: string;
  assetId: string;
  sourceSeconds: string;
  text: string;
  kind: "callout" | "step" | "takeaway";
};

type ProofDraft = {
  id: string;
  sourceAssetId: string;
  sourceSeconds: string;
  assetId: string;
  sourceIn: string;
  durationSeconds: string;
  layout: "split" | "cutaway";
};

type Result = {
  durationFrames: number;
  captionCount: number;
  brollCount: number;
  beatCount?: number;
  proofCount?: number;
  warnings: string[];
  startFrame: number;
};
export function ReelBuilder({
  p,
  base,
  missing = [],
  importMedia,
  openStock,
  openCaptions,
  onCreated,
  report,
}: {
  p: Project;
  base: string;
  missing?: string[];
  importMedia: () => void;
  openStock: () => void;
  openCaptions: () => void;
  onCreated: (frame: number) => void;
  report: (e: unknown) => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]),
    [broll, setBroll] = useState<string[]>([]);
  const [target, setTarget] = useState(30),
    [style, setStyle] = useState("bold"),
    [hook, setHook] = useState(""),
    [cta, setCta] = useState("");
  const [captions, setCaptions] = useState(true),
    [music, setMusic] = useState(""),
    [mode, setMode] = useState("append");
  const [format, setFormat] = useState<ReelFormat>("montage"),
    [captionStyle, setCaptionStyle] = useState<Clip["captionStyle"] | "">(""),
    [beats, setBeats] = useState<BeatDraft[]>([]),
    [proofBeats, setProofBeats] = useState<ProofDraft[]>([]),
    [automaticAnimations, setAutomaticAnimations] = useState(true);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<Result>(),
    [failure, setFailure] = useState("");
  const panelRef = useRef<HTMLDivElement>(null),
    resultRef = useRef<HTMLDivElement>(null),
    projectIdRef = useRef(p.id);
  projectIdRef.current = p.id;
  useEffect(() => {
    setChosen([]);
    setBroll([]);
    setBeats([]);
    setProofBeats([]);
    setTarget(30);
    setStyle("bold");
    setHook("");
    setCta("");
    setCaptions(true);
    setMusic("");
    setFormat("montage");
    setCaptionStyle("");
    setAutomaticAnimations(true);
    setMode("append");
    setStep(1);
    setResult(undefined);
    setFailure("");
  }, [p.id]);
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [step]);
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ block: "nearest" });
  }, [result]);
  const visual = p.assets.filter((a) => a.kind !== "audio");
  const sources = chosen.filter(
    (id) => !missing.includes(id) && visual.some((a) => a.id === id),
  );
  const selectedSet = useMemo(() => new Set(sources), [sources.join(",")]);
  const sourceAllocations = allocateReelFrames(
    sources.map((id) => {
      const asset = visual.find((item) => item.id === id)!;
      return asset.kind === "image"
        ? target * p.fps
        : Math.min(target * p.fps, Math.floor(asset.duration * p.fps + 1e-7));
    }),
    target * p.fps,
  );
  const usedFramesById = new Map(
    sources.map((id, index) => [id, sourceAllocations[index]]),
  );
  const formatInfo = reelFormats.find((item) => item.id === format)!;
  const usesProofShots = format === "creator-punch" || format === "screen-demo";
  const proofAssets = visual.filter((asset) => !missing.includes(asset.id));
  const captionInfo = captionStyles.find((item) => item.id === captionStyle);
  const invalidBeat = beats.some((beat) => {
    const asset = p.assets.find((item) => item.id === beat.assetId);
    const seconds = Number(beat.sourceSeconds);
    const usedFrames = usedFramesById.get(beat.assetId) ?? 0;
    return (
      !selectedSet.has(beat.assetId) ||
      !beat.text.trim() ||
      !beat.sourceSeconds.trim() ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      usedFrames <= 0 ||
      (asset?.kind === "image"
        ? seconds !== 0
        : seconds >= usedFrames / p.fps ||
          Math.round(seconds * p.fps) >= usedFrames)
    );
  });
  const proofErrors = proofBeats.map((beat, index) => {
    const source = p.assets.find((asset) => asset.id === beat.sourceAssetId);
    const asset = proofAssets.find((item) => item.id === beat.assetId);
    const seconds = Number(beat.sourceSeconds);
    const duration = Number(beat.durationSeconds);
    const sourceIn = Number(beat.sourceIn);
    const usedFrames = usedFramesById.get(beat.sourceAssetId) ?? 0;
    const startFrame = Math.round(seconds * p.fps);
    const durationFrames = Math.floor(duration * p.fps + 1e-7);
    if (!selectedSet.has(beat.sourceAssetId))
      return "Choose a source clip from your selected footage.";
    if (!asset) return "Choose the screenshot or recording to show.";
    if (
      !beat.durationSeconds.trim() ||
      !Number.isFinite(duration) ||
      duration < 0.5 ||
      duration > 12
    )
      return "Set a duration from 0.5 to 12 seconds.";
    if (
      !beat.sourceSeconds.trim() ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      (source?.kind === "image" && seconds !== 0) ||
      startFrame < 0 ||
      seconds + duration > usedFrames / p.fps + 1e-7 ||
      startFrame + durationFrames > usedFrames
    )
      return "Keep the full proof shot within this source clip’s used range.";
    if (
      asset.kind === "video" &&
      (!beat.sourceIn.trim() ||
        !Number.isFinite(sourceIn) ||
        sourceIn < 0 ||
        sourceIn + duration > asset.duration + 1e-7)
    )
      return "Keep the start time and full duration within the proof video.";
    if (
      proofBeats.some((other, otherIndex) => {
        if (otherIndex >= index || other.sourceAssetId !== beat.sourceAssetId)
          return false;
        const otherStart = Math.round(Number(other.sourceSeconds) * p.fps);
        const otherEnd =
          otherStart + Math.floor(Number(other.durationSeconds) * p.fps + 1e-7);
        return (
          startFrame < otherEnd && startFrame + durationFrames > otherStart
        );
      })
    )
      return "Move this shot so it does not overlap another proof shot.";
    return "";
  });
  const invalidProof = usesProofShots && proofErrors.some(Boolean);
  const updateProof = (id: string, patch: Partial<ProofDraft>) => {
    setProofBeats((items) =>
      items.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat)),
    );
    setResult(undefined);
  };
  const addProof = () => {
    setProofBeats((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        sourceAssetId: sources[0] ?? "",
        sourceSeconds: "0",
        assetId: "",
        sourceIn: "0",
        durationSeconds: "3",
        layout: "split",
      },
    ]);
    setResult(undefined);
  };
  const updateBeat = (id: string, patch: Partial<BeatDraft>) => {
    setBeats((items) =>
      items.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat)),
    );
    setResult(undefined);
  };
  const addBeat = () => {
    setBeats((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        assetId: sources[0] ?? "",
        sourceSeconds: "0",
        text: "",
        kind: format === "listicle" ? "step" : "callout",
      },
    ]);
    setResult(undefined);
  };
  const toggle = (id: string) => {
    setChosen((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
    setBroll((ids) => ids.filter((x) => x !== id));
    setResult(undefined);
  };
  const move = (id: string, delta: number) =>
    setChosen((ids) => {
      const copy = [...ids];
      const i = copy.indexOf(id),
        j = i + delta;
      if (j >= 0 && j < copy.length) [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  async function create() {
    if (!sources.length || invalidBeat || invalidProof) return;
    const projectId = p.id;
    setBusy(true);
    setResult(undefined);
    setFailure("");
    try {
      const res = await window.cutline.invoke("reel.create", {
        projectId: p.id,
        revision: p.revision,
        options: {
          sources: sources.map((assetId) => ({ assetId })),
          brollAssetIds: broll.filter(
            (id) =>
              !missing.includes(id) &&
              !selectedSet.has(id) &&
              p.assets.some((a) => a.id === id),
          ),
          targetSeconds: target,
          style,
          format,
          ...(captionStyle ? { captionStyle } : {}),
          ...(usesProofShots && proofBeats.length
            ? {
                proofBeats: proofBeats.map((beat) => ({
                  sourceIndex: sources.indexOf(beat.sourceAssetId),
                  sourceSeconds: Number(beat.sourceSeconds),
                  assetId: beat.assetId,
                  ...(p.assets.find((asset) => asset.id === beat.assetId)
                    ?.kind === "video"
                    ? { sourceIn: Number(beat.sourceIn) }
                    : {}),
                  durationSeconds: Number(beat.durationSeconds),
                  layout: beat.layout,
                })),
              }
            : {}),
          ...(beats.length
            ? {
                beats: beats.map(({ assetId, sourceSeconds, text, kind }) => ({
                  sourceIndex: sources.indexOf(assetId),
                  sourceSeconds: Number(sourceSeconds),
                  text: text.trim(),
                  kind,
                })),
              }
            : automaticAnimations
              ? {}
              : { beats: [] }),
          hook,
          cta,
          captions,
          musicAssetId:
            !missing.includes(music) && p.assets.some((a) => a.id === music)
              ? music
              : undefined,
          mode,
        },
      });
      if (projectIdRef.current === projectId) {
        setResult(res);
        onCreated(res.startFrame);
      }
    } catch (e) {
      if (projectIdRef.current !== projectId) return;
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div ref={panelRef} className="library-content reel-builder">
      <div className="section-heading">
        <span>Build a Reel</span>
        <small>
          {mode === "append" && p.clips.length
            ? `${p.width} × ${p.height}, current canvas`
            : "1080 × 1920, 9:16"}
        </small>
      </div>
      <nav className="reel-stepper pill-tabs" aria-label="Reel setup steps">
        {["Footage", "Style", "Finish"].map((name, index) => (
          <button
            key={name}
            disabled={busy || (index > 0 && !sources.length)}
            aria-current={step === index + 1 ? "step" : undefined}
            className={step === index + 1 ? "active" : ""}
            onClick={() => setStep(index + 1)}
          >
            <span>{index + 1}</span>
            {name}
          </button>
        ))}
      </nav>
      <fieldset disabled={busy} className="reel-fieldset">
        <legend className="sr-only">Reel setup</legend>
        <section hidden={step !== 1}>
          <div className="reel-step">
            <span>1</span>
            <h3>Choose your footage</h3>
            <small>{sources.length} selected</small>
          </div>
          <div className="row reel-source-actions">
            <button className="control" onClick={importMedia}>
              <Upload size={13} />
              Import
            </button>
            <button className="control" onClick={openStock}>
              <Film size={13} />
              Find stock
            </button>
          </div>
          {!visual.length ? (
            <div className="reel-empty">Import footage or find stock.</div>
          ) : (
            <>
              <div className="reel-sources">
                {[
                  ...sources.map((id) => visual.find((a) => a.id === id)!),
                  ...visual.filter(
                    (a) => !selectedSet.has(a.id) && !missing.includes(a.id),
                  ),
                ].map((a) => (
                  <div
                    className={
                      "reel-source " +
                      (selectedSet.has(a.id) ? "is-selected" : "")
                    }
                    key={a.id}
                  >
                    <label>
                      <input
                        type="checkbox"
                        disabled={missing.includes(a.id)}
                        checked={selectedSet.has(a.id)}
                        onChange={() => toggle(a.id)}
                      />
                      {a.thumbnail ? (
                        <img src={`${base}/media/${a.id}/thumb${assetMediaVersion(a)}`} alt="" />
                      ) : (
                        <Film size={18} />
                      )}
                      <span>
                        <strong title={a.name}>{a.name}</strong>
                        <small>
                          {missing.includes(a.id)
                            ? "Missing · relink in Media"
                            : a.kind === "image"
                              ? "Photo"
                              : `${Math.round(a.duration)}s`}
                          {a.hasAudio ? " · audio" : ""}
                        </small>
                      </span>
                    </label>
                    {selectedSet.has(a.id) && (
                      <div className="reel-order">
                        <button
                          aria-label={`Move ${a.name} earlier`}
                          disabled={sources.indexOf(a.id) === 0}
                          onClick={() => move(a.id, -1)}
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          aria-label={`Move ${a.name} later`}
                          disabled={
                            sources.indexOf(a.id) === sources.length - 1
                          }
                          onClick={() => move(a.id, 1)}
                        >
                          <ArrowDown size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <p className="reel-hint">Clips play in the order you pick.</p>
            </>
          )}
        </section>
        <section hidden={step !== 2}>
          <div className="reel-step">
            <span>2</span>
            <h3>Set the direction</h3>
          </div>
          <label className="reel-label">
            Reel format
            <select
              value={format}
              aria-describedby="reel-format-description"
              onChange={(e) => {
                const next = e.target.value as ReelFormat;
                setFormat(next);
                if (next === "creator-education") {
                  setStyle("clean");
                  setCaptionStyle("box");
                  setAutomaticAnimations(true);
                }
                if (next === "creator-punch" || next === "screen-demo") {
                  setStyle("clean");
                  setCaptionStyle("");
                  setCaptions(true);
                  setBroll([]);
                  setMusic("");
                }
                setResult(undefined);
              }}
            >
              {reelFormats.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <small id="reel-format-description">{formatInfo.description}</small>
          </label>
          <label className="reel-label">
            Target length
            <select
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
            >
              {[15, 30, 60, 90].map((s) => (
                <option key={s} value={s}>
                  {s} seconds
                </option>
              ))}
            </select>
          </label>
          <div
            className="reel-style-options"
            role="group"
            aria-label="Reel style"
          >
            {[
              { id: "clean", name: "Clean", note: "Quiet + clear" },
              { id: "bold", name: "Bold", note: "Pop + punch" },
              { id: "cinematic", name: "Cinematic", note: "Warm + slow" },
            ].map((s) => (
              <button
                key={s.id}
                aria-pressed={style === s.id}
                className={
                  "reel-style style-" + s.id + (style === s.id ? " active" : "")
                }
                onClick={() => setStyle(s.id)}
              >
                <span>Aa</span>
                <strong>{s.name}</strong>
                <small>{s.note}</small>
              </button>
            ))}
          </div>
          <label className="reel-label">
            Opening hook
            <input
              maxLength={100}
              value={hook}
              onChange={(e) => setHook(e.target.value)}
              placeholder="What should make them stop scrolling?"
            />
          </label>
          <label className="reel-label">
            Closing line
            <input
              maxLength={100}
              value={cta}
              onChange={(e) => setCta(e.target.value)}
              placeholder="A takeaway, or what to do next"
            />
          </label>
          {usesProofShots && (
            <div className="reel-proofs" aria-label="Proof shots">
              <div className="reel-proof-heading">
                <h4>Proof shots</h4>
                <span>{proofBeats.length}/24</span>
              </div>
              <p className="reel-hint">
                {format === "screen-demo"
                  ? "Choose real screenshots or recordings to show while your voice continues."
                  : "Show a screenshot or recording at the moment you mention it. Your voice continues."}
              </p>
              {!proofBeats.length && (
                <p className="reel-proof-empty">
                  {format === "screen-demo"
                    ? "Add a proof shot to show your screen. Until then, the speaker stays full frame."
                    : "The speaker stays full frame between proof shots."}
                </p>
              )}
              {proofBeats.map((beat, index) => {
                const source = p.assets.find(
                  (asset) => asset.id === beat.sourceAssetId,
                );
                const asset = proofAssets.find(
                  (item) => item.id === beat.assetId,
                );
                const usedSeconds =
                  (usedFramesById.get(beat.sourceAssetId) ?? 0) / p.fps;
                return (
                  <div
                    className="reel-beat reel-proof"
                    key={beat.id}
                    role="group"
                    aria-label={`Proof shot ${index + 1}`}
                  >
                    <div className="reel-beat-heading">
                      <strong>Proof shot {index + 1}</strong>
                      <button
                        aria-label={`Remove proof shot ${index + 1}`}
                        onClick={() => {
                          setProofBeats((items) =>
                            items.filter((item) => item.id !== beat.id),
                          );
                          setResult(undefined);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <label className="reel-label">
                      Source clip
                      <select
                        value={beat.sourceAssetId}
                        onChange={(e) =>
                          updateProof(beat.id, {
                            sourceAssetId: e.target.value,
                            sourceSeconds: "0",
                          })
                        }
                      >
                        {!selectedSet.has(beat.sourceAssetId) && (
                          <option value={beat.sourceAssetId}>
                            Choose selected footage
                          </option>
                        )}
                        {sources.map((id) => (
                          <option key={id} value={id}>
                            {p.assets.find((item) => item.id === id)?.name}
                          </option>
                        ))}
                      </select>
                      <small>
                        Used range: 0-{Number(usedSeconds.toFixed(2))} seconds
                      </small>
                    </label>
                    <label className="reel-label">
                      Proof image or video
                      <select
                        value={beat.assetId}
                        onChange={(e) =>
                          updateProof(beat.id, {
                            assetId: e.target.value,
                            sourceIn: "0",
                          })
                        }
                      >
                        <option value="">
                          Choose a screenshot or recording
                        </option>
                        {!!beat.assetId && !asset && (
                          <option value={beat.assetId}>
                            Unavailable media. Choose another file
                          </option>
                        )}
                        {proofAssets.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="reel-beat-controls">
                      <label className="reel-label">
                        Show at (seconds)
                        <input
                          type="number"
                          min={0}
                          max={usedSeconds}
                          step={0.1}
                          disabled={source?.kind === "image"}
                          value={beat.sourceSeconds}
                          onChange={(e) =>
                            updateProof(beat.id, {
                              sourceSeconds: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="reel-label">
                        Duration (seconds)
                        <input
                          type="number"
                          min={0.5}
                          max={12}
                          step={0.1}
                          value={beat.durationSeconds}
                          onChange={(e) =>
                            updateProof(beat.id, {
                              durationSeconds: e.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    <p className="reel-proof-time-note">
                      {source?.kind === "image"
                        ? "Photos start at 0 seconds. Duration is how long the proof stays on screen."
                        : "Show at uses the time in your original source clip. Duration is how long the proof stays on screen."}
                    </p>
                    {asset?.kind === "video" && (
                      <label className="reel-label">
                        Start proof video at (seconds)
                        <input
                          type="number"
                          min={0}
                          max={asset.duration}
                          step={0.1}
                          value={beat.sourceIn}
                          onChange={(e) =>
                            updateProof(beat.id, { sourceIn: e.target.value })
                          }
                        />
                        <small>
                          Time in {asset.name}. Its audio stays muted.
                        </small>
                      </label>
                    )}
                    <label className="reel-label">
                      Layout
                      <select
                        value={beat.layout}
                        onChange={(e) =>
                          updateProof(beat.id, {
                            layout: e.target.value as ProofDraft["layout"],
                          })
                        }
                      >
                        <option value="split">Screen above speaker</option>
                        <option value="cutaway">Full-screen proof</option>
                      </select>
                    </label>
                    {!!proofErrors[index] && (
                      <p className="reel-proof-error" role="status">
                        {proofErrors[index]}
                      </p>
                    )}
                  </div>
                );
              })}
              <div className="reel-proof-actions">
                <button
                  className="control"
                  disabled={proofBeats.length >= 24 || !sources.length}
                  onClick={addProof}
                >
                  <Plus size={13} /> Add proof shot
                </button>
                <button className="control" onClick={importMedia}>
                  <Upload size={13} /> Import proof
                </button>
              </div>
            </div>
          )}
          {format !== "montage" && (
            <label className="reel-check">
              <input
                type="checkbox"
                checked={automaticAnimations}
                onChange={(e) => {
                  setAutomaticAnimations(e.target.checked);
                  setResult(undefined);
                }}
              />
              <span>
                <strong>Automatic animations</strong>
                <small>
                  {beats.length
                    ? "Your timed animations replace automatic selections."
                    : "Choose spoken phrases for animated callouts."}
                </small>
              </span>
            </label>
          )}
          <details className="reel-details reel-beats">
            <summary>
              Timed animations{" "}
              <span>{beats.length ? `${beats.length} added` : "Optional"}</span>
            </summary>
            <p className="reel-hint">
              {format !== "montage" && automaticAnimations
                ? "Uses spoken phrases automatically. Add your own timings to replace them."
                : "Add a callout or step at a moment in your source."}
            </p>
            {beats.map((beat, index) => {
              const asset = p.assets.find((item) => item.id === beat.assetId);
              const usedFrames = usedFramesById.get(beat.assetId) ?? 0;
              const usedSeconds = usedFrames / p.fps;
              const words = (asset?.words ?? []).filter(
                (word) =>
                  word.text.trim() &&
                  Math.round(word.start * p.fps) < usedFrames,
              );
              return (
                <div className="reel-beat" key={beat.id}>
                  <div className="reel-beat-heading">
                    <strong>Animation {index + 1}</strong>
                    <button
                      aria-label={`Remove animation ${index + 1}`}
                      onClick={() =>
                        setBeats((items) =>
                          items.filter((item) => item.id !== beat.id),
                        )
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <label className="reel-label">
                    Source
                    <select
                      value={beat.assetId}
                      onChange={(e) =>
                        updateBeat(beat.id, {
                          assetId: e.target.value,
                          sourceSeconds: "0",
                        })
                      }
                    >
                      {!selectedSet.has(beat.assetId) && (
                        <option value={beat.assetId}>
                          Choose selected footage
                        </option>
                      )}
                      {sources.map((id) => (
                        <option key={id} value={id}>
                          {p.assets.find((item) => item.id === id)?.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      Used range: 0-{Number(usedSeconds.toFixed(2))}s
                    </small>
                  </label>
                  <div className="reel-beat-controls">
                    <label className="reel-label">
                      Source time (seconds)
                      <input
                        type="number"
                        min={0}
                        max={
                          asset?.kind === "image"
                            ? 0
                            : Math.max(0, (usedFrames - 1) / p.fps)
                        }
                        disabled={asset?.kind === "image"}
                        step={0.1}
                        value={beat.sourceSeconds}
                        onChange={(e) =>
                          updateBeat(beat.id, { sourceSeconds: e.target.value })
                        }
                      />
                      {asset?.kind === "image" && (
                        <small>
                          Photos animate from their start at 0 seconds.
                        </small>
                      )}
                    </label>
                    <label className="reel-label">
                      Animation type
                      <select
                        value={beat.kind}
                        onChange={(e) =>
                          updateBeat(beat.id, {
                            kind: e.target.value as BeatDraft["kind"],
                          })
                        }
                      >
                        <option value="callout">Callout</option>
                        <option value="step">Numbered step</option>
                        <option value="takeaway">Takeaway</option>
                      </select>
                    </label>
                  </div>
                  {asset?.kind !== "image" && !!words.length && (
                    <label className="reel-label">
                      Jump to spoken word
                      <select
                        value=""
                        onChange={(e) => {
                          if (e.target.value)
                            updateBeat(beat.id, {
                              sourceSeconds: String(
                                words[Number(e.target.value)].start,
                              ),
                            });
                        }}
                      >
                        <option value="">
                          Choose a moment from the transcript
                        </option>
                        {words.map((word, wordIndex) => (
                          <option key={wordIndex} value={String(wordIndex)}>
                            {word.start.toFixed(1)}s:{" "}
                            {words
                              .slice(wordIndex, wordIndex + 5)
                              .map((item) => item.text)
                              .join(" ")}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="reel-label">
                    On-screen text
                    <input
                      maxLength={80}
                      value={beat.text}
                      onChange={(e) =>
                        updateBeat(beat.id, { text: e.target.value })
                      }
                      placeholder="The point to remember"
                    />
                  </label>
                </div>
              );
            })}
            <button
              className="control reel-add-beat"
              disabled={beats.length >= 24 || !sources.length}
              onClick={addBeat}
            >
              <Plus size={13} /> Add animation
            </button>
            {invalidBeat && (
              <p className="reel-hint" role="status">
                Give each animation text and a time within its used source
                range. Photo animations start at 0 seconds.
              </p>
            )}
          </details>
        </section>
        <section hidden={step !== 3}>
          <div className="reel-step">
            <span>3</span>
            <h3>Finish the edit</h3>
          </div>
          <label className="reel-check">
            <input
              type="checkbox"
              checked={captions}
              onChange={(e) => setCaptions(e.target.checked)}
            />
            <span>
              <strong>Generate word captions</strong>
              <small>Transcribes selected speech on this Mac</small>
            </span>
          </label>
          {captions && (
            <label className="reel-label">
              Caption style
              <select
                value={captionStyle}
                onChange={(e) => {
                  setCaptionStyle(e.target.value as Clip["captionStyle"] | "");
                  setResult(undefined);
                }}
              >
                <option value="">Recommended for this format</option>
                {captionStyles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <small>
                {captionInfo?.description ??
                  "Uses this format’s caption treatment, timed to the spoken words."}
              </small>
            </label>
          )}
          {!!beats.length && (
            <div className="reel-animation-summary">
              <span>
                {beats.length} timed{" "}
                {beats.length === 1 ? "animation" : "animations"}
              </span>
              <button onClick={() => setStep(2)}>Edit timings</button>
            </div>
          )}
          {usesProofShots && !!proofBeats.length && (
            <div className="reel-animation-summary">
              <span>
                {proofBeats.length} proof{" "}
                {proofBeats.length === 1 ? "shot" : "shots"}
              </span>
              <button onClick={() => setStep(2)}>Edit proof shots</button>
            </div>
          )}
          {invalidProof && (
            <p className="reel-proof-error" role="status">
              Check your proof shots in Style before building.
            </p>
          )}
          {!!visual.filter(
            (a) => !selectedSet.has(a.id) && !missing.includes(a.id),
          ).length && (
            <details className="reel-details">
              <summary>
                B-roll overlays <span>{broll.length} selected</span>
              </summary>
              <p className="reel-hint">
                Short, muted cutaways over your main footage.
              </p>
              {visual
                .filter(
                  (a) => !selectedSet.has(a.id) && !missing.includes(a.id),
                )
                .map((a) => (
                  <label key={a.id} className="reel-check">
                    <input
                      type="checkbox"
                      checked={broll.includes(a.id)}
                      onChange={() =>
                        setBroll((ids) =>
                          ids.includes(a.id)
                            ? ids.filter((x) => x !== a.id)
                            : [...ids, a.id],
                        )
                      }
                    />
                    <span className="ellipsis" title={a.name}>
                      {a.name}
                    </span>
                  </label>
                ))}
            </details>
          )}
          <label className="reel-label">
            <span>
              <Music2 size={12} /> Background music
            </span>
            <select value={music} onChange={(e) => setMusic(e.target.value)}>
              <option value="">No music</option>
              {p.assets
                .filter((a) => a.kind === "audio" && !missing.includes(a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          {!!p.clips.length && (
            <label className="reel-label">
              Timeline
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="replace">
                  Build a new Reel · replace current timeline
                </option>
                <option value="append">Append after the current edit</option>
              </select>
              <small>
                {mode === "replace"
                  ? `${p.clips.length} existing clips will be replaced. Undo restores them.`
                  : "Current clips stay in place. Export includes both sequences."}
              </small>
            </label>
          )}
        </section>
        <div className="panel-action-bar">
          {step < 3 ? (
            <button
              className="primary reel-build-button"
              disabled={!sources.length || busy}
              onClick={() => setStep(step + 1)}
            >
              Continue to {step === 1 ? "style" : "finishing"} →
            </button>
          ) : (
            <button
              className="primary reel-build-button"
              disabled={!sources.length || busy || invalidBeat || invalidProof}
              onClick={create}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Sparkles size={16} />
              )}{" "}
              {busy ? "Building your Reel…" : "Build Reel"}
            </button>
          )}
        </div>
      </fieldset>
      {busy && (
        <div role="status" className="reel-progress">
          Building your Reel. Progress shows in the status bar.
        </div>
      )}
      {failure && (
        <div role="alert" className="reel-inline-error">
          {failure}
        </div>
      )}
      {result && (
        <div ref={resultRef} role="status" className="reel-result">
          <strong>
            <Check size={15} />
            Your{" "}
            {format === "creator-education"
              ? formatInfo.label
              : formatInfo.label.toLowerCase()}{" "}
            edit is ready
          </strong>
          <p>
            {(result.durationFrames / p.fps).toFixed(1)}s ·{" "}
            {plural(result.captionCount, "caption")} ·{" "}
            {plural(result.brollCount, "cutaway")}
            {!!result.beatCount &&
              ` · ${plural(result.beatCount, "animation")}`}
            {!!result.proofCount && ` · ${result.proofCount} proof shots`}
          </p>
          {result.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
          <button onClick={openCaptions}>Review captions →</button>
        </div>
      )}
    </div>
  );
}
