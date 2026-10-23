import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Music2,
  Play,
  Scissors,
  Sparkles,
} from "lucide-react";
import {
  duration,
  type Asset,
  type Clip,
  type Job,
  type Project,
} from "../shared/model";
import { beatFrames } from "../shared/music-sync";
import { isMotionAccentLayer } from "../shared/motion";
import { countLabel } from "./labels";
import { usePlayheadValue, type Playhead } from "./playhead";
import "./music-sync.css";

type Reactive = NonNullable<Clip["musicReactive"]>;
type Props = {
  project: Project;
  jobs: Job[];
  selectedClipId?: string;
  playhead: Playhead;
  /** False while the Audio panel is hidden, so it stops following playback. */
  active?: boolean;
  musicClipId?: string;
  onMusicClipId: (id: string) => void;
  showBeats: boolean;
  onShowBeats: (show: boolean) => void;
  onSeek: (frame: number) => void;
  onPlayFrom?: (frame: number) => void;
  report: (error: string) => void;
};

const clipName = (clip: Clip, assets: Asset[]) =>
  clip.text ||
  assets.find((asset) => asset.id === clip.assetId)?.name ||
  clip.kind;
const secondsLabel = (frame: number, fps: number) =>
  `${(frame / fps).toFixed(2)}s`;
/**
 * Where the playhead sits among the beats, as one number: twice the index of
 * the first beat at or after it, plus one when it is exactly on that beat.
 */
export const beatPosition = (beats: number[], frame: number) => {
  const index = beats.findIndex((beat) => beat >= frame);
  if (index < 0) return beats.length * 2;
  return index * 2 + (beats[index] === frame ? 1 : 0);
};

export function MusicSync({
  project,
  jobs,
  selectedClipId,
  playhead,
  active = true,
  musicClipId,
  onMusicClipId,
  showBeats,
  onShowBeats,
  onSeek,
  onPlayFrom,
  report,
}: Props) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tempo, setTempo] = useState("120");
  const [offset, setOffset] = useState("0");
  const [trackId, setTrackId] = useState("");
  const [subdivision, setSubdivision] = useState<"beat" | "bar">("beat");
  const [allowSourceAudio, setAllowSourceAudio] = useState(false);
  const [pulseStyle, setPulseStyle] = useState<Reactive["style"]>("both");
  const [pulseMode, setPulseMode] = useState<Reactive["mode"]>("beat");
  const [pulseScope, setPulseScope] = useState<"clip" | "accents">("clip");
  // The field keeps exactly what is typed (so clearing it doesn't snap to 1);
  // the pulse uses the clamped number.
  const [pulseDecayText, setPulseDecayText] = useState(
    String(Math.max(1, Math.round(project.fps * 0.2))),
  );
  const pulseDecay = Math.max(
    1,
    Math.min(600, Math.round(Number(pulseDecayText) || 1)),
  );
  const setPulseDecay = (value: number) => setPulseDecayText(String(value));
  const [amount, setAmount] = useState(0.35);
  const [musicStyle, setMusicStyle] = useState("bold");
  const [musicSeconds, setMusicSeconds] = useState(
    String(
      Math.min(180, Math.max(8, Math.ceil(duration(project) / project.fps))),
    ),
  );
  const current = useRef(project);
  current.current = project;
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    request.current++;
    setBusy("");
    setError("");
    setNotice("");
    setAllowSourceAudio(false);
  }, [project.id]);

  const musicClips = project.clips.filter(
    (clip) => clip.kind === "audio" && clip.assetId,
  );
  const music =
    musicClips.find((clip) => clip.id === musicClipId) ?? musicClips[0];
  const asset = project.assets.find((item) => item.id === music?.assetId);
  const rhythm = asset?.rhythm;
  const selected = project.clips.find((clip) => clip.id === selectedClipId);
  const reactive = selected?.musicReactive;
  const selectedMotion =
    selected?.motionId &&
    project.motions.find((motion) => motion.id === selected.motionId);
  const canAccent =
    !!selected &&
    selected.kind === "text" &&
    selected.preset === "custom" &&
    !!selectedMotion &&
    selectedMotion.layers.some((layer) => isMotionAccentLayer(layer, selected));
  const selectedStudio =
    !!selectedMotion &&
    /^(studio|signature|logo)-/.test(selectedMotion.source ?? "");
  const canPulse =
    !!selected && ["text", "video", "image"].includes(selected.kind);
  const hasEnergy = !!rhythm?.envelope.values.length;
  const running = [...jobs]
    .reverse()
    .find(
      (job) =>
        job.state === "running" &&
        ["music", "music-analysis", "beat-analysis"].includes(job.kind),
    );
  const disabled = !!busy || !!running;
  const beats = useMemo(() => {
    if (!music || !rhythm) return [];
    return beatFrames(project, music.id);
  }, [project, music?.id, rhythm]);
  // The beat list only changes when the playhead reaches another beat, so
  // follow that position instead of every frame.
  const position = usePlayheadValue(playhead, (frame) =>
    active ? beatPosition(beats, frame) : -1,
  );
  const at = position < 0 ? beatPosition(beats, playhead.get()) : position;
  const foundIndex =
    Math.floor(at / 2) < beats.length ? Math.floor(at / 2) : -1;
  const onBeat = at % 2 === 1;
  const nextBeat =
    foundIndex < 0 ? undefined : beats[onBeat ? foundIndex + 1 : foundIndex];
  const previousBeat = foundIndex < 0 ? beats.at(-1) : beats[foundIndex - 1];
  const nearIndex = foundIndex < 0 ? Math.max(0, beats.length - 1) : foundIndex;
  const visibleBeats = beats.slice(
    Math.max(0, nearIndex - 1),
    Math.max(0, nearIndex - 1) + 6,
  );
  const sequences = project.tracks
    .filter((track) => track.kind !== "audio" && !track.hidden)
    .map((track) => ({
      track,
      clips: project.clips
        .filter(
          (clip) =>
            clip.trackId === track.id &&
            ["video", "image", "text"].includes(clip.kind),
        )
        .sort((a, b) => a.start - b.start),
    }))
    .filter((item) => item.clips.length >= 2);
  const sequence =
    sequences.find((item) => item.track.id === trackId) ??
    sequences.find((item) => item.track.id === selected?.trackId) ??
    sequences[0];
  const contiguous =
    !!sequence &&
    sequence.clips
      .slice(1)
      .every(
        (clip, index) =>
          clip.start ===
          sequence.clips[index].start + sequence.clips[index].duration,
      );
  const hasSourceAudio = !!sequence?.clips.some(
    (clip) =>
      clip.kind === "video" &&
      clip.volume > 0 &&
      !sequence.track.muted &&
      (project.assets.find((item) => item.id === clip.assetId)?.hasAudio ||
        !!project.assets.find((item) => item.id === clip.assetId)?.words
          ?.length ||
        !!clip.words.length ||
        project.clips.some((item) => item.captionSourceId === clip.id)),
  );

  useEffect(() => {
    if (music && music.id !== musicClipId) onMusicClipId(music.id);
  }, [music?.id, musicClipId]);
  useEffect(() => {
    setTempo(String(rhythm?.bpm ? Math.round(rhythm.bpm * 100) / 100 : 120));
    setOffset(String(rhythm?.beats[0]?.time ?? 0));
  }, [music?.id, rhythm?.bpm, rhythm?.beats[0]?.time]);
  useEffect(() => {
    setError("");
    setNotice("");
  }, [music?.id]);
  useEffect(() => {
    setPulseStyle(reactive?.style ?? (selectedStudio ? "scale" : "both"));
    setPulseMode(reactive?.mode ?? "beat");
    setAmount(reactive?.amount ?? (selectedStudio ? 0.16 : 0.35));
    setPulseScope(
      reactive
        ? (reactive.scope ?? "clip")
        : selectedStudio && canAccent
          ? "accents"
          : "clip",
    );
    setPulseDecay(
      reactive?.releaseFrames ?? Math.max(1, Math.round(project.fps * 0.2)),
    );
  }, [
    selected?.id,
    reactive?.style,
    reactive?.mode,
    reactive?.amount,
    reactive?.scope,
    reactive?.releaseFrames,
    selectedStudio,
    canAccent,
    project.fps,
  ]);

  async function run(
    name: string,
    label: string,
    extra: Record<string, unknown>,
    success: (result: any) => string,
  ) {
    const token = ++request.current,
      projectId = current.current.id;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const result = await window.cutline.invoke(name, {
        projectId,
        revision: current.current.revision,
        ...extra,
      });
      if (
        !mounted.current ||
        request.current !== token ||
        current.current.id !== projectId
      )
        return;
      setNotice(success(result));
    } catch (reason) {
      if (mounted.current && request.current === token) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        if (/cancelled|canceled/i.test(message))
          setNotice("Music operation cancelled. Your project was kept.");
        else {
          setError(message);
          report(message);
        }
      }
    } finally {
      if (mounted.current && request.current === token) setBusy("");
    }
  }
  const createMusic = () => {
    const seconds = Number(musicSeconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 180) {
      setError("Choose a duration from 1 to 180 seconds.");
      return;
    }
    void run(
      "music.create",
      "Composing music…",
      { style: musicStyle, seconds, startFrame: 0 },
      (result) => {
        onMusicClipId(result.musicClipId);
        onShowBeats(true);
        return "Original music added. Preview the track, then sync your cuts.";
      },
    );
  };
  const applyGrid = () => {
    const bpm = Number(tempo),
      offsetSeconds = Number(offset);
    if (
      !Number.isFinite(bpm) ||
      bpm < 20 ||
      bpm > 300 ||
      !Number.isFinite(offsetSeconds) ||
      offsetSeconds < 0 ||
      !asset ||
      offsetSeconds >= Math.min(1200, asset.duration)
    ) {
      setError(
        "Choose 20–300 BPM and an offset inside the analyzed source music.",
      );
      return;
    }
    void run(
      "music.grid",
      "Updating beat grid…",
      { musicClipId: music?.id, bpm, offsetSeconds },
      () => {
        onShowBeats(true);
        return "Beat grid updated. Existing cuts stay in place until you sync them.";
      },
    );
  };

  return (
    <section
      className="music-sync"
      aria-label="Music sync"
      aria-busy={disabled}
    >
      <div className="ms-intro">
        <strong>
          <Music2 size={16} aria-hidden="true" /> Music sync
        </strong>
      </div>
      {!music ? (
        <>
          <div className="ms-empty">
            <AudioLines size={24} aria-hidden="true" />
            <p>Add music from My audio, or compose it below.</p>
          </div>
          <div className="ms-row">
            <label>
              Style
              <select
                aria-label="Original music style"
                value={musicStyle}
                disabled={disabled}
                onChange={(event) => setMusicStyle(event.target.value)}
              >
                <option value="bold">Bright momentum</option>
                <option value="clean">Gentle momentum</option>
                <option value="cinematic">Quiet horizons</option>
              </select>
            </label>
            <label>
              Seconds
              <input
                aria-label="Original music duration"
                type="number"
                min="1"
                max="180"
                value={musicSeconds}
                disabled={disabled}
                onChange={(event) => setMusicSeconds(event.target.value)}
              />
            </label>
          </div>
          <button
            className="ms-primary primary"
            disabled={disabled}
            onClick={createMusic}
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} aria-hidden="true" />
            ) : (
              <Sparkles size={15} aria-hidden="true" />
            )}{" "}
            Compose original music
          </button>
          {reactive && canPulse && (
            <div className="ms-orphaned">
              <p className="ms-note">
                The selected clip’s music track was removed. Clear its pulse or
                add music to bind it again.
              </p>
              <button
                className="ms-secondary control"
                disabled={disabled}
                onClick={() =>
                  void run(
                    "music.reactive",
                    "Removing pulse…",
                    {
                      musicClipId: reactive.musicClipId,
                      clipIds: [selected!.id],
                      remove: true,
                    },
                    () =>
                      "Music pulse removed. Your other animation is preserved.",
                  )
                }
              >
                Remove pulse
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <label className="ms-field">
            Music track
            <select
              aria-label="Music track"
              value={music.id}
              disabled={disabled}
              onChange={(event) => onMusicClipId(event.target.value)}
            >
              {musicClips.map((clip) => (
                <option key={clip.id} value={clip.id}>
                  {clipName(clip, project.assets)} ·{" "}
                  {secondsLabel(clip.start, project.fps)}
                </option>
              ))}
            </select>
          </label>
          <button
            className={rhythm ? "ms-secondary" : "ms-primary"}
            disabled={disabled}
            onClick={() =>
              void run(
                "music.analyze",
                "Analyzing music…",
                { musicClipId: music.id },
                () => {
                  onShowBeats(true);
                  return "Analysis ready. Listen and adjust the beat grid if needed.";
                },
              )
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} aria-hidden="true" />
            ) : (
              <AudioLines size={15} aria-hidden="true" />
            )}
            {rhythm ? "Analyze again locally" : "Analyze locally"}
          </button>
          {music.speed !== 1 && (
            <p className="ms-note">
              For the tightest beat sync, keep music at its original speed.
              Speed changes can shift audio attacks.
            </p>
          )}
          {asset && asset.duration > 1200 && (
            <p className="ms-note">
              Analysis and the beat grid cover the first 20 minutes of this
              source.
            </p>
          )}
          {rhythm && (
            <>
              <div className="ms-analysis">
                <strong>
                  {rhythm.bpm
                    ? `${Math.round(rhythm.bpm * 10) / 10} BPM`
                    : "Tempo unclear"}
                </strong>
                <span>
                  {rhythm.source === "generated"
                    ? "Original music grid"
                    : rhythm.source === "manual"
                      ? "Manual beat grid"
                      : `${Math.round(rhythm.confidence * 100)}% confidence`}
                </span>
                <small>
                  {beats.length} {beats.length === 1 ? "beat" : "beats"} in this
                  clip
                </small>
              </div>
              {rhythm.source !== "generated" &&
                rhythm.source !== "manual" &&
                rhythm.confidence < 0.5 && (
                  <p className="ms-note">
                    The rhythm is less regular. Listen before syncing, or set
                    the tempo below.
                  </p>
                )}
              <label className="ms-switch">
                <span>Show beats on timeline</span>
                <input
                  aria-label="Show beats"
                  type="checkbox"
                  checked={showBeats}
                  onChange={(event) => onShowBeats(event.target.checked)}
                />
              </label>
              <div className="ms-beats" aria-label="Beat navigator">
                <button
                  aria-label="Previous music beat"
                  disabled={previousBeat === undefined}
                  onClick={() =>
                    previousBeat !== undefined && onSeek(previousBeat)
                  }
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <div>
                  {visibleBeats.map((beat) => (
                    <button
                      key={beat}
                      aria-label={`Seek to music beat at frame ${beat}`}
                      title={`Beat at ${secondsLabel(beat, project.fps)}`}
                      className={
                        onBeat && beat === beats[foundIndex] ? "active" : ""
                      }
                      onClick={() => onSeek(beat)}
                    >
                      {secondsLabel(beat, project.fps)}
                    </button>
                  ))}
                </div>
                <button
                  aria-label="Next music beat"
                  disabled={nextBeat === undefined}
                  onClick={() => nextBeat !== undefined && onSeek(nextBeat)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            </>
          )}
          <details className="ms-details">
            <summary>Edit beat grid</summary>
            <p className="ms-note">
              Offset is the first beat’s position in the original audio.
            </p>
            <div className="ms-row">
              <label>
                Tempo
                <input
                  aria-label="Music tempo"
                  type="number"
                  min="20"
                  max="300"
                  step="0.1"
                  value={tempo}
                  disabled={disabled}
                  onChange={(event) => setTempo(event.target.value)}
                />
              </label>
              <label>
                Offset (seconds)
                <input
                  aria-label="Beat offset (seconds)"
                  type="number"
                  min="0"
                  max={Math.min(1200, asset?.duration ?? 0)}
                  step="0.01"
                  value={offset}
                  disabled={disabled}
                  onChange={(event) => setOffset(event.target.value)}
                />
              </label>
            </div>
            <button
              className="ms-secondary control"
              disabled={disabled}
              onClick={applyGrid}
            >
              Apply beat grid
            </button>
          </details>
          <div className="ms-cut-section">
            <label className="ms-field">
              Cut sequence
              <select
                aria-label="Cut sequence"
                value={sequence?.track.id ?? ""}
                disabled={disabled || !sequences.length}
                onChange={(event) => setTrackId(event.target.value)}
              >
                {!sequences.length && (
                  <option value="">No cut sequence yet</option>
                )}
                {sequences.map((item) => (
                  <option key={item.track.id} value={item.track.id}>
                    {item.track.name} · {countLabel(item.clips.length, "clip")}
                  </option>
                ))}
              </select>
            </label>
            <p className="ms-note">
              {!sequence
                ? "Place at least two video, image or text clips together on one track."
                : !contiguous
                  ? "Close gaps and overlaps in this sequence before syncing cuts."
                  : `${sequence.clips.length - 1} ${sequence.clips.length === 2 ? "cut" : "cuts"}. The sequence keeps its length.`}
            </p>
            <label className="ms-field">
              Cut on
              <select
                aria-label="Music cut subdivision"
                value={subdivision}
                disabled={disabled}
                onChange={(event) =>
                  setSubdivision(event.target.value as "beat" | "bar")
                }
              >
                <option value="beat">Nearest beat</option>
                <option value="bar">Every four beats</option>
              </select>
            </label>
            {hasSourceAudio && (
              <label className="ms-check">
                <input
                  aria-label="Allow cuts in clips with source audio"
                  type="checkbox"
                  checked={allowSourceAudio}
                  disabled={disabled}
                  onChange={(event) =>
                    setAllowSourceAudio(event.target.checked)
                  }
                />
                <span>
                  Allow cuts in clips with source audio
                  <small>Cut points can affect spoken dialogue.</small>
                </span>
              </label>
            )}
            <button
              className="ms-primary primary"
              disabled={
                disabled ||
                !beats.length ||
                !contiguous ||
                (hasSourceAudio && !allowSourceAudio)
              }
              onClick={() =>
                void run(
                  "music.sync",
                  "Syncing cuts…",
                  {
                    musicClipId: music.id,
                    clipIds: sequence!.clips.map((clip) => clip.id),
                    mode: "cuts",
                    subdivision,
                    maxShiftFrames: Math.round(project.fps * 0.4),
                    allowAudibleVideo: allowSourceAudio,
                  },
                  (result) => {
                    onShowBeats(true);
                    return result.summary?.changedClips
                      ? `Synced ${result.summary.snappedBoundaries} cuts. Preview the sequence; one Undo restores it.${result.warnings?.length ? ` ${result.warnings.join(" ")}` : ""}`
                      : result.warnings?.join(" ") ||
                          "Already aligned, or no nearby beat was found.";
                  },
                )
              }
            >
              <Scissors size={15} aria-hidden="true" /> Sync cuts
            </button>
          </div>
          <details className="ms-details">
            <summary>Pulse motion</summary>
            <p className="ms-target">
              {canPulse
                ? `Selected: ${clipName(selected!, project.assets)}`
                : "Select a text, shape, image or video clip on the timeline."}
            </p>
            <div className="ms-row">
              <label>
                Style
                <select
                  aria-label="Pulse style"
                  value={pulseStyle}
                  disabled={disabled || !canPulse}
                  onChange={(event) =>
                    setPulseStyle(event.target.value as Reactive["style"])
                  }
                >
                  <option value="both">Scale + glow</option>
                  <option value="scale">Scale</option>
                  <option value="glow">Glow</option>
                </select>
              </label>
              <label>
                Follow
                <select
                  aria-label="Pulse mode"
                  value={pulseMode}
                  disabled={disabled || !canPulse}
                  onChange={(event) =>
                    setPulseMode(event.target.value as Reactive["mode"])
                  }
                >
                  <option value="beat">Beats</option>
                  <option value="energy" disabled={!hasEnergy}>
                    Music energy
                  </option>
                </select>
              </label>
            </div>
            <label className="ms-strength">
              Strength <output>{Math.round(amount * 100)}%</output>
              <input
                aria-label="Pulse strength"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={amount}
                disabled={disabled || !canPulse}
                onChange={(event) => setAmount(Number(event.target.value))}
              />
            </label>
            <div className="ms-row">
              <label>
                Apply to
                <select
                  aria-label="Pulse target"
                  value={pulseScope}
                  disabled={disabled || !canPulse}
                  onChange={(event) =>
                    setPulseScope(event.target.value as "clip" | "accents")
                  }
                >
                  <option value="clip">Entire clip</option>
                  <option value="accents" disabled={!canAccent}>
                    Graphical accents
                  </option>
                </select>
              </label>
              <label>
                Decay · frames
                <input
                  aria-label="Pulse decay frames"
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  value={pulseDecayText}
                  disabled={disabled || !canPulse}
                  onChange={(event) => setPulseDecayText(event.target.value)}
                  onBlur={() => setPulseDecayText(String(pulseDecay))}
                />
              </label>
            </div>
            {pulseScope === "accents" && (
              <p className="ms-help">
                Headlines and full-frame backgrounds stay steady.
              </p>
            )}
            <button
              className="ms-secondary control"
              disabled={
                disabled ||
                !canPulse ||
                !rhythm ||
                (pulseMode === "energy" && !hasEnergy)
              }
              onClick={() =>
                void run(
                  "music.reactive",
                  "Applying pulse…",
                  {
                    musicClipId: music.id,
                    clipIds: [selected!.id],
                    style: pulseStyle,
                    mode: pulseMode,
                    amount,
                    scope: pulseScope,
                    releaseFrames: pulseDecay,
                  },
                  () =>
                    "Pulse applied to the selected clip. Preview it to the music; one Undo restores it.",
                )
              }
            >
              <Sparkles size={14} aria-hidden="true" /> Apply pulse
            </button>
            {reactive && (
              <button
                className="ms-quiet"
                disabled={disabled || !canPulse}
                onClick={() =>
                  void run(
                    "music.reactive",
                    "Removing pulse…",
                    {
                      musicClipId: reactive.musicClipId,
                      clipIds: [selected!.id],
                      style: pulseStyle,
                      mode: pulseMode,
                      amount,
                      remove: true,
                    },
                    () =>
                      "Music pulse removed. Your other animation is preserved.",
                  )
                }
              >
                Remove pulse
              </button>
            )}
          </details>
          <button
            className="ms-preview"
            disabled={disabled}
            onClick={(event) => {
              if (onPlayFrom) onPlayFrom(music.start);
              else onSeek(music.start);
              event.currentTarget.blur();
            }}
          >
            <Play size={13} aria-hidden="true" /> Preview from music start
          </button>
        </>
      )}
      {disabled && (
        <div className="ms-progress" role="status">
          <span>{running?.message || busy}</span>
          {running && (
            <button
              className="ms-cancel"
              aria-label="Cancel music operation"
              onClick={() =>
                window.cutline
                  .invoke("job.cancel", { id: running.id })
                  .catch((reason) => {
                    const message =
                      reason instanceof Error ? reason.message : String(reason);
                    setError(message);
                    report(message);
                  })
              }
            >
              Cancel
            </button>
          )}
          {running ? (
            <progress max="1" value={running.progress} />
          ) : (
            <progress />
          )}
        </div>
      )}
      {error && (
        <p className="ms-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ms-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
