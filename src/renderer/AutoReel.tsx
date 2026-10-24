import React, { useState, useRef, useEffect } from "react";
import {
  Check,
  Clapperboard,
  LoaderCircle,
  Music2,
  Sparkles,
  Upload,
  X,
  Captions,
  Play,
  WandSparkles,
  Type,
} from "lucide-react";
import type { Job, Project } from "../shared/model";
import { captionStyles } from "../shared/caption-styles";
import { reelFormats, type ReelFormat } from "../shared/reel-formats";
import { errorText } from "./controls";
import "./auto-reel.css";

type Result = {
  durationFrames: number;
  captionCount: number;
  brollCount: number;
  footageCount: number;
  startFrame: number;
  music: boolean;
  clipIds: string[];
  sourceName: string;
  warnings: string[];
  queries: { query: string; startSeconds: number; clipId?: string }[];
};
export function AutoReel({
  project,
  jobs,
  missing = [],
  onCreated,
  reviewCaptions,
  reviewEffects,
  preview,
  seek,
  report,
}: {
  project: Project;
  jobs: Job[];
  missing?: string[];
  onCreated: (frame: number) => void;
  reviewCaptions: () => void;
  reviewEffects: () => void;
  preview: (frame: number) => void;
  seek: (frame: number) => void;
  report: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false),
    [over, setOver] = useState(false);
  const [style, setStyle] = useState("bold"),
    [target, setTarget] = useState("auto"),
    [format, setFormat] = useState<ReelFormat>("montage");
  const [broll, setBroll] = useState(true),
    [music, setMusic] = useState(true);
  const [pace, setPace] = useState("natural"),
    [captionStyle, setCaptionStyle] = useState("auto"),
    [openingTitle, setOpeningTitle] = useState(false);
  const [assetId, setAssetId] = useState("");
  const [result, setResult] = useState<Result>(),
    [failure, setFailure] = useState("");
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ block: "nearest" });
  }, [result]);
  const job = [...jobs]
    .reverse()
    .find((j) => j.kind === "auto-reel" && j.state === "running");
  const videos = project.assets.filter(
    (a) => a.kind === "video" && !missing.includes(a.id),
  );
  const formatInfo = reelFormats.find((item) => item.id === format)!;
  const usesProofShots = format === "creator-punch" || format === "screen-demo";
  const currentResult =
    result &&
    result.clipIds.some((id) => project.clips.some((clip) => clip.id === id))
      ? result
      : undefined;
  const run = async (source?: { path?: string; assetId?: string }) => {
    if (busy || job) return;
    setBusy(true);
    setFailure("");
    setResult(undefined);
    try {
      const res = await window.cutline.invoke("reel.auto", {
        projectId: project.id,
        revision: project.revision,
        ...source,
        options: {
          format,
          style,
          broll,
          music,
          pace,
          openingTitle,
          ...(captionStyle !== "auto" ? { captionStyle } : {}),
          ...(target !== "auto" ? { targetSeconds: Number(target) } : {}),
        },
      });
      if (res) {
        setResult(res);
        onCreated(res.startFrame);
      }
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const working = busy || !!job;
  return (
    <div className="library-content auto-reel">
      <div className={`auto-intro ${currentResult ? "has-result" : ""}`}>
        <h2>
          {currentResult
            ? "Your Reel is ready to refine"
            : "Turn one video into a Reel"}
        </h2>
      </div>
      {currentResult && (
        <section
          ref={resultRef}
          className="auto-result"
          aria-label="Automatic Reel result"
        >
          <span className="auto-result-title">
            <Check size={16} /> Your Reel is ready
          </span>
          <div className="auto-stats">
            <span>
              <strong>
                {(currentResult.durationFrames / project.fps).toFixed(1)}s
              </strong>{" "}
              edited
            </span>
            <span>
              <strong>{currentResult.captionCount}</strong> captions
            </span>
            <span>
              <strong>{currentResult.brollCount}</strong> cutaways
            </span>
          </div>
          <div className="auto-review-actions">
            <button
              className="primary"
              onClick={() => preview(currentResult.startFrame)}
            >
              <Play size={14} /> Play your Reel
            </button>
            <button className="control" onClick={reviewCaptions}>
              <Captions size={14} /> Refine captions
            </button>
            <button className="control" onClick={reviewEffects}>
              <WandSparkles size={14} /> Adjust the look
            </button>
          </div>
          {currentResult.queries.length > 0 && (
            <details>
              <summary>Matched B-roll</summary>
              <ul>
                {currentResult.queries.map((q, i) => {
                  const clip = project.clips.find(
                    (item) => item.id === q.clipId,
                  );
                  if (q.clipId && !clip) return null;
                  const frame =
                    clip?.start ?? Math.round(q.startSeconds * project.fps);
                  return (
                    <li key={i}>
                      <button className="auto-beat" onClick={() => seek(frame)}>
                        <Play size={10} /> {(frame / project.fps).toFixed(1)}s ·{" "}
                        {q.query}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          {currentResult.warnings.length > 0 && (
            <details open>
              <summary>Review notes</summary>
              <ul>
                {currentResult.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {working && (
        <div className="auto-progress" role="status" aria-live="polite">
          <div>
            <LoaderCircle size={14} className="spin" />
            <strong>{job?.message ?? "Choose a video to begin"}</strong>
          </div>
          <progress
            max={1}
            value={job?.progress ?? 0}
            aria-label="Automatic edit progress"
          />
          {job && (
            <button
              onClick={() =>
                void window.cutline
                  .invoke("job.cancel", { id: job.id })
                  .catch(report)
              }
            >
              <X size={12} /> Cancel edit
            </button>
          )}
        </div>
      )}
      {failure && (
        <div className="auto-failure" role="alert">
          {failure}
        </div>
      )}
      <fieldset disabled={working} className="auto-options">
        <legend className="sr-only">Automatic edit options</legend>
        <div className="auto-choice-row auto-format-choice">
          <label>
            Reel format
            <select
              aria-label="Automatic Reel format"
              aria-describedby="auto-reel-format-description"
              value={format}
              onChange={(e) => {
                const next = e.target.value as ReelFormat;
                setFormat(next);
                if (next === "creator-education") {
                  setStyle("clean");
                  setCaptionStyle("box");
                  setPace("natural");
                }
                if (next === "creator-punch" || next === "screen-demo") {
                  setStyle("clean");
                  setCaptionStyle("auto");
                  setPace(next === "creator-punch" ? "tight" : "natural");
                  setBroll(false);
                  setMusic(false);
                  setOpeningTitle(false);
                }
                setResult(undefined);
                setFailure("");
              }}
            >
              {reelFormats.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <small id="auto-reel-format-description">
              {formatInfo.description}
            </small>
          </label>
        </div>
        {usesProofShots && (
          <p className="auto-proof-note">
            Keeps your original voice. To add real screenshots or recordings,
            use Proof shots in Reel Builder.
          </p>
        )}
        <div className="auto-choice-row">
          <label>
            Length
            <select
              value={target}
              title="Best fit ends on a sentence, up to 90 seconds"
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="auto">Best fit</option>
              {[15, 30, 60, 90].map((n) => (
                <option value={n} key={n}>
                  {n} seconds
                </option>
              ))}
            </select>
          </label>
          <label>
            Style
            <select value={style} onChange={(e) => setStyle(e.target.value)}>
              <option value="bold">Bold</option>
              <option value="clean">Clean</option>
              <option value="cinematic">Cinematic</option>
            </select>
          </label>
        </div>
        <div className="auto-choice-row auto-caption-choice">
          <label>
            Caption style
            <select
              aria-label="Automatic caption style"
              value={captionStyle}
              onChange={(e) => setCaptionStyle(e.target.value)}
            >
              <option value="auto">Match the edit</option>
              {captionStyles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pacing
            <select
              aria-label="Automatic edit pacing"
              value={pace}
              title={
                pace === "tight"
                  ? "Shorter pauses, with a little room around each cut"
                  : "Keeps natural pauses and trims long ones"
              }
              onChange={(e) => setPace(e.target.value)}
            >
              <option value="natural">Natural</option>
              <option value="tight">Tight</option>
            </select>
          </label>
        </div>
        <div className="auto-toggles">
          <label>
            <input
              type="checkbox"
              checked={broll}
              onChange={(e) => setBroll(e.target.checked)}
            />
            <Clapperboard size={13} /> Relevant B-roll
          </label>
          <label>
            <input
              type="checkbox"
              checked={music}
              onChange={(e) => setMusic(e.target.checked)}
            />
            <Music2 size={13} /> Original music
          </label>
          <label>
            <input
              type="checkbox"
              checked={openingTitle}
              onChange={(e) => setOpeningTitle(e.target.checked)}
            />
            <Type size={13} /> Opening title
          </label>
        </div>
      </fieldset>
      <button
        className={`auto-upload ${over ? "is-over" : ""}`}
        disabled={working}
        onClick={() => void run()}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={(e) => {
          e.stopPropagation();
          setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length !== 1) {
            setFailure("Drop one video to make a Reel.");
            return;
          }
          void run({ path: window.cutline.pathForFile(files[0]) });
        }}
      >
        <span className="auto-upload-icon">
          {working ? (
            <LoaderCircle size={25} className="spin" />
          ) : (
            <Upload size={25} />
          )}
        </span>
        <strong>{working ? "Editing your Reel…" : "Upload & auto edit"}</strong>
        <span>
          {working ? "You can cancel while we work" : "or drop a video here"}
        </span>
      </button>
      {project.clips.length > 0 && (
        <p className="auto-note">
          Replaces the current timeline. Undo brings it back.
        </p>
      )}
      {videos.length > 0 && (
        <details className="auto-existing">
          <summary>Use a video already in this project</summary>
          <select
            disabled={working}
            aria-label="Video to auto edit"
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
          >
            <option value="">Choose a video</option>
            {videos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            className="control"
            disabled={!assetId || working}
            onClick={() => void run({ assetId })}
          >
            <Sparkles size={13} /> Auto edit this video
          </button>
        </details>
      )}
    </div>
  );
}
