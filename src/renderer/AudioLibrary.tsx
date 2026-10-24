import React, { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Download,
  LoaderCircle,
  Mic2,
  Plus,
  Upload,
  X,
} from "lucide-react";
import type { Asset, Job, Project } from "../shared/model";
import { errorText } from "./controls";
import { speechVoices, type SpeechVoice, type TtsStatus } from "../shared/tts";
import "./audio.css";

export function AudioLibrary({
  project,
  base,
  jobs,
  addAudio,
  importAudio,
  report,
  active = true,
  musicSync,
}: {
  project: Project;
  base: string;
  jobs: Job[];
  addAudio: (asset: Asset) => void;
  importAudio: () => void;
  report: (error: unknown) => void;
  active?: boolean;
  musicSync?: React.ReactNode;
}) {
  const api = window.cutline;
  const [mode, setMode] = useState<"music" | "voice" | "library">("voice");
  const [text, setText] = useState("");
  const [voice, setVoice] = useState<SpeechVoice>("af_heart");
  const [speed, setSpeed] = useState(1.08);
  const [status, setStatus] = useState<TtsStatus>();
  const [operation, setOperation] = useState<"setup" | "generate">();
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [statusError, setStatusError] = useState("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<string>();
  const [createdSignature, setCreatedSignature] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const mounted = useRef(true);
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const statusRequest = useRef(0);
  const currentProject = useRef(project.id);
  currentProject.current = project.id;
  const running = [...jobs]
    .reverse()
    .find(
      (job) =>
        ["tts", "tts-setup", "voiceover"].includes(job.kind) &&
        job.state === "running",
    );
  const assets = project.assets.filter((asset) => asset.kind === "audio");
  const generated = assets.find((asset) => asset.id === created);
  const selected = assets.find((asset) => asset.id === preview);
  const selectedVoice = speechVoices.find((item) => item.id === voice)!;
  const busy = operation !== undefined;
  const draftSignature = JSON.stringify({ text: text.trim(), voice, speed });
  const stale = !!generated && createdSignature !== draftSignature;

  async function checkStatus() {
    const id = ++statusRequest.current;
    setCheckingStatus(true);
    setStatusError("");
    try {
      const next: TtsStatus = await api.invoke("tts.status");
      if (mounted.current && statusRequest.current === id) setStatus(next);
    } catch (error) {
      if (mounted.current && statusRequest.current === id)
        setStatusError(errorText(error));
    } finally {
      if (mounted.current && statusRequest.current === id)
        setCheckingStatus(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void checkStatus();
    return () => {
      mounted.current = false;
      request.current++;
      statusRequest.current++;
    };
  }, []);
  useEffect(() => {
    if (!active) audio.current?.pause();
  }, [active]);
  useEffect(() => {
    setCreated(undefined);
    setCreatedSignature(undefined);
    setPreview(undefined);
    setError("");
    request.current++;
    setOperation(undefined);
  }, [project.id]);

  async function generate() {
    if (disabled || checkingStatus || !status?.ready || !text.trim()) return;
    const id = ++request.current,
      projectId = project.id,
      signature = draftSignature;
    setError("");
    setOperation("generate");
    audio.current?.pause();
    try {
      const asset: Asset = await api.invoke("tts.generate", {
        text,
        voice,
        speed,
        name: `${selectedVoice.name} voiceover`,
      });
      if (
        !mounted.current ||
        request.current !== id ||
        currentProject.current !== projectId
      )
        return;
      setCreated(asset.id);
      setCreatedSignature(signature);
      setPreview(asset.id);
    } catch (error) {
      if (mounted.current && request.current === id)
        setError(errorText(error));
    } finally {
      if (mounted.current && request.current === id) setOperation(undefined);
    }
  }
  async function setup() {
    if (disabled || checkingStatus) return;
    const id = ++request.current;
    setError("");
    setOperation("setup");
    try {
      const next: TtsStatus = await api.invoke("tts.setup");
      if (mounted.current && request.current === id) {
        statusRequest.current++;
        setStatus(next);
        setStatusError("");
      }
    } catch (error) {
      if (mounted.current && request.current === id)
        setError(errorText(error));
    } finally {
      if (mounted.current && request.current === id) setOperation(undefined);
    }
  }
  const exportAudio = (asset: Asset) =>
    api.invoke("audio.export", { assetId: asset.id }).catch(report);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const disabled = busy || !!running;
  return (
    <section className="audio-library" aria-label="Audio library">
      <div
        className="audio-modes pill-tabs"
        role="group"
        aria-label="Audio source"
      >
        <button
          className={mode === "music" ? "active" : ""}
          aria-pressed={mode === "music"}
          onClick={() => setMode("music")}
        >
          <AudioLines size={14} /> Music sync
        </button>
        <button
          className={mode === "voice" ? "active" : ""}
          aria-pressed={mode === "voice"}
          onClick={() => setMode("voice")}
        >
          <Mic2 size={14} />
          Text to speech
        </button>
        <button
          className={mode === "library" ? "active" : ""}
          aria-pressed={mode === "library"}
          onClick={() => setMode("library")}
        >
          <AudioLines size={14} />
          My audio <span>{assets.length}</span>
        </button>
      </div>
      {mode === "music" ? (
        musicSync
      ) : mode === "voice" ? (
        <>
          <div className="audio-intro">
            <p className="audio-engine-note" role="status">
              {checkingStatus
                ? "Checking the voice engine…"
                : statusError
                  ? "Could not check the local voice engine."
                  : status?.ready
                    ? "Ready. Voices run on this Mac, free."
                    : "Voices run on this Mac, free. A one-time download sets them up."}
            </p>
            {statusError && (
              <div className="audio-status-error">
                <span>{statusError}</span>
                <button
                  className="control"
                  disabled={disabled || checkingStatus}
                  onClick={() => void checkStatus()}
                >
                  Retry check
                </button>
              </div>
            )}
          </div>
          <label className="audio-field">
            Script
            <textarea
              aria-label="Voiceover script"
              value={text}
              maxLength={5000}
              disabled={disabled}
              rows={7}
              placeholder="Start with the line that makes them stop scrolling…"
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="audio-script-meta">
            <span>{text.length.toLocaleString()} / 5,000</span>
            {!!words && (
              <span>
                About {Math.max(1, Math.round(words / (2.5 * speed)))} sec
              </span>
            )}
          </div>
          <label className="audio-field">
            Voice
            <select
              aria-label="Narration voice"
              disabled={disabled}
              value={voice}
              onChange={(event) => setVoice(event.target.value as SpeechVoice)}
            >
              {speechVoices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.accent}
                </option>
              ))}
            </select>
            <small>{selectedVoice.description}</small>
          </label>
          <label className="audio-field">
            Pace <span className="audio-pace-value">{speed.toFixed(2)}×</span>
            <input
              aria-label="Narration pace"
              type="range"
              disabled={disabled}
              min="0.65"
              max="1.5"
              step="0.01"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
            <div className="audio-pace-labels">
              <small>Slower</small>
              <button
                disabled={disabled}
                onClick={() => setSpeed(1.08)}
                type="button"
              >
                Default pace
              </button>
              <small>Faster</small>
            </div>
          </label>
          {!checkingStatus && !statusError && status && !status.ready && (
            <div className="audio-engine">
              <strong>Download Kokoro once</strong>
              <p>
                The voice engine needs a one-time {status.downloadMB} MB
                download. After setup, speech works offline. Your script stays
                on this Mac.
              </p>
              <button
                className="control"
                disabled={disabled}
                onClick={() => void setup()}
              >
                <Download size={14} />
                Download Kokoro
              </button>
            </div>
          )}
          <div className="panel-action-bar">
            <button
              className="audio-generate primary"
              disabled={
                disabled ||
                checkingStatus ||
                !!statusError ||
                !text.trim() ||
                !status?.ready
              }
              onClick={() => void generate()}
            >
              {disabled ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Mic2 size={17} />
              )}
              {operation === "setup" || running?.kind === "tts-setup"
                ? "Setting up Kokoro…"
                : operation === "generate" || !!running
                  ? "Creating your voiceover…"
                  : "Generate voiceover"}
            </button>
          </div>
          {running && (
            <div className="audio-progress" role="status">
              <div>
                <span>{running.message}</span>
                <button
                  title="Cancel voice generation"
                  aria-label="Cancel voice generation"
                  onClick={() =>
                    api.invoke("job.cancel", { id: running.id }).catch(report)
                  }
                >
                  <X size={13} />
                </button>
              </div>
              <progress max="1" value={running.progress} />
            </div>
          )}
          {error && (
            <p className="audio-error" role="alert">
              {error}
            </p>
          )}
          {generated && (
            <div className="audio-result">
              <span>{stale ? "Previous voiceover" : "Your voiceover"}</span>
              <strong>{generated.name}</strong>
              <small>{generated.duration.toFixed(1)} seconds · WAV</small>
              {stale && (
                <p className="audio-take-note">
                  Script, voice, or pace changed. Generate again to update this
                  take.
                </p>
              )}
              <button
                className="audio-add primary"
                disabled={disabled || stale}
                title={
                  stale
                    ? "Generate the updated script before adding this take"
                    : "Add at the current playhead"
                }
                onClick={() => {
                  if (!disabled && !stale) addAudio(generated);
                }}
              >
                <Plus size={14} />
                Add to timeline
              </button>
              <button
                className="control"
                onClick={() => void exportAudio(generated)}
              >
                <Download size={13} />
                Save WAV
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <button className="audio-import control" onClick={importAudio}>
            <Upload size={14} />
            Import audio
          </button>
          {!assets.length && (
            <div className="audio-empty">
              <AudioLines size={28} />
              <p>No audio yet.</p>
            </div>
          )}
          <div className="audio-items">
            {assets.map((asset) => (
              <article
                key={asset.id}
                className={preview === asset.id ? "selected" : ""}
              >
                <button
                  className="audio-item-preview"
                  onClick={() => setPreview(asset.id)}
                >
                  <AudioLines size={17} />
                  <span>
                    <strong>{asset.name}</strong>
                    <small>{asset.duration.toFixed(1)} sec · Preview</small>
                  </span>
                </button>
                <button
                  aria-label={`Add ${asset.name} to timeline`}
                  title="Add to timeline"
                  onClick={() => addAudio(asset)}
                >
                  <Plus size={14} />
                </button>
              </article>
            ))}
          </div>
        </>
      )}
      {selected && (
        <div className="audio-preview">
          <div>
            <span>{selected.name}</span>
            <button
              aria-label="Close audio preview"
              onClick={() => setPreview(undefined)}
            >
              <X size={13} />
            </button>
          </div>
          <audio
            ref={audio}
            controls
            preload="metadata"
            src={`${base}/media/${selected.id}`}
          />
        </div>
      )}
    </section>
  );
}
