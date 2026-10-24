import React, { useEffect, useMemo, useRef, useState } from "react";
import { plural } from "../shared/plural";
import {
  captionPaceOf,
  regroupCaptionCommands,
  type CaptionPace,
} from "../shared/caption-grouping";
import {
  Captions,
  Check,
  Pause,
  Pencil,
  Play,
  Search,
  SlidersHorizontal,
  Type,
} from "lucide-react";
import { makeClip, type Project, type Clip } from "../shared/model";
import type { Command } from "../shared/commands";
import {
  captionStyles,
  captionStylePatch,
  captionPlacement,
} from "../shared/caption-styles";
import {
  captionReplacementPlan,
  captionTextPatch,
  captionTimestamp,
} from "../shared/caption-edit";
import { CaptionText } from "../composition/CaptionText";
import { usePlayheadValue, type Playhead } from "./playhead";
import "./caption-studio.css";

/**
 * A style draft belongs to one project and canvas size. Selecting another
 * clip, Escape or a click on the preview keep it; switching projects or the
 * aspect ratio clears it, because sizes and positions were set for the old
 * canvas.
 */
export const captionDraftScope = (
  p: Pick<Project, "id" | "width" | "height">,
) => `${p.id}:${p.width}x${p.height}`;

type Props = {
  p: Project;
  selected?: string;
  playhead: Playhead;
  select: (id: string) => void;
  seek: (f: number) => void;
  edit: (label: string, commands: Command[]) => Promise<boolean>;
  transcribe: () => void;
  run: (name: string) => unknown;
  busy: boolean;
  active?: boolean;
};
type PhraseEdit = {
  id: string;
  original: string;
  text: string;
  error?: string;
};
const accents = [
  "#c6f16d",
  "#ffd76a",
  "#92dffc",
  "#d8b6ff",
  "#ffad74",
  "#ffffff",
];

function AnimatedPreview({
  clip,
  fps,
  active,
}: {
  clip: Clip;
  fps: number;
  active: boolean;
}) {
  const [playing, setPlaying] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [localFrame, setLocalFrame] = useState(0);
  const [width, setWidth] = useState(260);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      if (media.matches) setPlaying(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!playing || !active) return;
    let request = 0,
      previous = performance.now(),
      elapsed = 0;
    const tick = (now: number) => {
      if (!document.hidden) elapsed += Math.min(now - previous, 100);
      previous = now;
      setLocalFrame(
        Math.floor((elapsed / 1000) * fps) % Math.max(1, clip.duration),
      );
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, active, clip.duration, fps]);
  const scale = Math.min((width - 20) / clip.width, 91 / clip.height);
  return (
    <div className="cs-preview">
      <div className="cs-preview-meta">
        <span>Preview</span>
        <button
          aria-label={
            playing ? "Pause caption preview" : "Play caption preview"
          }
          onClick={() => setPlaying(!playing)}
        >
          {playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
      </div>
      <div
        className="cs-preview-stage"
        ref={stage}
        aria-label="Animated caption preview"
      >
        <div style={{ width: clip.width * scale, height: clip.height * scale }}>
          <div
            style={{
              width: clip.width,
              height: clip.height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <CaptionText clip={clip} frame={localFrame} fps={fps} />
          </div>
        </div>
      </div>
      <div className="cs-preview-progress" aria-hidden="true">
        <span
          style={{
            width: `${(100 * localFrame) / Math.max(1, clip.duration)}%`,
          }}
        />
      </div>
    </div>
  );
}

export function CaptionLibrary({
  p,
  selected,
  playhead,
  select,
  seek,
  edit,
  transcribe,
  run,
  busy,
  active = true,
}: Props) {
  const [tab, setTab] = useState<"style" | "edit">("style");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [draft, setDraft] = useState<Partial<Clip>>({});
  const [notice, setNotice] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState("");
  const studio = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<PhraseEdit | null>(null);
  const [replace, setReplace] = useState("");
  const [review, setReview] = useState(false);
  const [replaceError, setReplaceError] = useState("");
  const captions = useMemo(
    () =>
      p.clips
        .filter((c) => c.kind === "caption")
        .sort((a, b) => a.start - b.start),
    [p.clips],
  );
  const selectedCaption = captions.find((c) => c.id === selected);
  const source = p.clips.find((c) => c.id === selected);
  const canTranscribe = source?.kind === "audio" || source?.kind === "video";
  const regenerating =
    canTranscribe && captions.some((c) => c.captionSourceId === source.id);
  const visible = captions.filter((c) =>
    c.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const targets =
    scope === "all" ? captions : selectedCaption ? [selectedCaption] : [];
  const base = useMemo(
    () =>
      selectedCaption ||
      captions[0] || {
        ...makeClip(p, "caption", p.tracks[0]?.id || "preview"),
        ...captionStylePatch("standard", p),
        ...captionPlacement(p),
      },
    [selectedCaption, captions, p.width, p.height, p.id],
  );
  const styled = { ...base, ...draft };
  const dirty = Object.keys(draft).length > 0;
  const preview = useMemo<Clip>(() => {
    if (selectedCaption) return { ...styled, start: 0 };
    return {
      ...styled,
      start: 0,
      duration: Math.round(p.fps * 3.2),
      text: "Make every word matter.",
      words: [
        { text: "Make", start: 0.15, end: 0.65 },
        { text: "every", start: 0.65, end: 1.2 },
        { text: "word", start: 1.2, end: 1.85 },
        { text: "matter.", start: 1.85, end: 2.75 },
      ],
    };
  }, [styled, selectedCaption, p.fps]);
  useEffect(() => {
    if (studio.current) studio.current.scrollTop = 0;
  }, [tab]);
  const draftScope = captionDraftScope(p);
  useEffect(() => {
    setDraft({});
  }, [draftScope]);
  useEffect(() => {
    setNotice("");
    setCommitError("");
  }, [selected, draftScope]);
  // Only the phrase under the playhead changes during playback, so the list
  // re-renders when that phrase changes instead of on every frame.
  const playingId = usePlayheadValue(playhead, (frame) =>
    active && tab === "edit"
      ? captions.find((c) => frame >= c.start && frame < c.start + c.duration)
          ?.id
      : undefined,
  );
  useEffect(() => {
    setEditing(null);
    setQuery("");
    setReview(false);
  }, [p.id]);
  useEffect(() => {
    setReview(false);
    setReplaceError("");
  }, [query, replace, p.revision]);
  const change = (patch: Partial<Clip>) => {
    setDraft((current) => ({
      ...current,
      captionLayout: "balanced",
      ...patch,
    }));
    setNotice("");
  };
  const commit = async (label: string, commands: Command[]) => {
    setCommitting(true);
    setCommitError("");
    setNotice("");
    try {
      const saved = await edit(label, commands);
      if (!saved)
        setCommitError("Changes were not saved. Your draft is still here.");
      return saved;
    } catch (error) {
      setCommitError((error as Error).message);
      return false;
    } finally {
      setCommitting(false);
    }
  };
  const pace = captionPaceOf(captions);
  const changePace = async (next: CaptionPace) => {
    if (next === pace || committing) return;
    const { commands, count } = regroupCaptionCommands(p, captions, next);
    if (!commands.length) return;
    if (
      await commit(
        next === "short" ? "Short captions" : "Phrase captions",
        commands,
      )
    )
      setNotice(
        `Captions regrouped into ${count} ${next === "short" ? "short chunks" : "phrases"}.`,
      );
  };
  const applyStyle = async () => {
    if (!dirty || !targets.length || committing) return;
    const saved = await commit(
      `Style ${scope === "all" ? "all captions" : "selected caption"}`,
      targets.map((c) => ({ type: "clip.update", id: c.id, patch: draft })),
    );
    if (!saved) return;
    setNotice(
      `Style applied to ${targets.length === 1 ? "1 caption" : `${targets.length} captions`}.`,
    );
    setDraft((current) => (current === draft ? {} : current));
  };
  const position = (value: string) => {
    const placement = captionPlacement(p);
    const height = placement.height;
    const center =
      value === "upper"
        ? p.height * 0.2
        : value === "middle"
          ? p.height * 0.5
          : (placement.y ?? p.height * 0.72) + (placement.height ?? height) / 2;
    change({
      ...placement,
      align: "center",
      y: Math.max(
        p.height * 0.08,
        Math.min(p.height * 0.87 - height, center - height / 2),
      ),
    });
  };
  const currentPosition =
    styled.y + styled.height / 2 < p.height * 0.35
      ? "upper"
      : styled.y + styled.height / 2 < p.height * 0.65
        ? "middle"
        : "lower";
  const savePhrase = async () => {
    if (!editing || committing) return;
    const current = captions.find((c) => c.id === editing.id);
    if (!current || current.text !== editing.original) {
      setEditing({
        ...editing,
        error:
          "This caption changed. Cancel and open it again to keep the latest edit.",
      });
      return;
    }
    try {
      const correction = captionTextPatch(current, editing.text);
      if (correction.patch.text !== current.text) {
        const saved = await commit("Correct caption text", [
          { type: "clip.update", id: current.id, patch: correction.patch },
        ]);
        if (!saved) return;
      }
      setNotice(
        correction.timing === "cleared" && current.words.length
          ? "Caption saved. Word timing cleared."
          : "Caption saved.",
      );
      setEditing(null);
    } catch (error) {
      setEditing({ ...editing, error: String((error as Error).message) });
    }
  };
  const reviewReplacement = () => {
    try {
      captionReplacementPlan(captions, query, replace);
      setReplaceError("");
      setReview(true);
    } catch (error) {
      setReplaceError((error as Error).message);
      setReview(false);
    }
  };
  const replacementPlan = useMemo(() => {
    if (!review) return [];
    try {
      return captionReplacementPlan(captions, query, replace);
    } catch {
      return [];
    }
  }, [review, captions, query, replace]);
  const applyReplacement = async () => {
    if (!review || !replacementPlan.length || committing) return;
    const saved = await commit(
      "Replace caption text",
      replacementPlan.map((item) => ({
        type: "clip.update",
        id: item.id,
        patch: item.patch,
      })),
    );
    if (!saved) return;
    setNotice(
      `Updated ${replacementPlan.length} ${replacementPlan.length === 1 ? "caption" : "captions"}.`,
    );
    setReview(false);
  };
  const editingCaption = editing
    ? captions.find((c) => c.id === editing.id)
    : undefined;
  const retimed =
    !!editingCaption?.words.length &&
    !!editing &&
    editing.text.trim().split(/\s+/).length !== editingCaption.words.length;
  const generateControls = (
    <>
      <button
        className="cs-generate primary"
        disabled={!canTranscribe || busy}
        onClick={transcribe}
      >
        <Captions size={15} aria-hidden="true" />
        {busy
          ? "Transcribing…"
          : regenerating
            ? "Regenerate captions"
            : "Generate captions"}
      </button>
      {(regenerating || !canTranscribe) && (
        <p className="cs-hint">
          {regenerating
            ? "Replaces this clip's generated captions."
            : "Select a video or audio clip first."}
        </p>
      )}
      <div className="cs-files">
        <button className="control" onClick={() => run("srt.import")}>
          Import SRT
        </button>
        <button
          className="control"
          disabled={!captions.length}
          onClick={() => run("srt.export")}
        >
          Export SRT
        </button>
      </div>
    </>
  );
  return (
    <div className="caption-studio" ref={studio} aria-busy={committing}>
      <div className="section-heading">
        <span>Caption studio</span>
        <small>
          {captions.length ? plural(captions.length, "phrase") : "On device"}
        </small>
      </div>
      {captions.length ? (
        <details className="cs-generate-details">
          <summary>Generate & files</summary>
          <div>{generateControls}</div>
        </details>
      ) : (
        <div className="cs-empty-generation">{generateControls}</div>
      )}
      <div
        className="cs-tabs pill-tabs"
        role="tablist"
        aria-label="Caption Studio view"
      >
        <button
          role="tab"
          id="caption-style-tab"
          aria-selected={tab === "style"}
          aria-controls="caption-style-panel"
          tabIndex={tab === "style" ? 0 : -1}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              setTab("edit");
              document.getElementById("caption-edit-tab")?.focus();
            }
          }}
          onClick={() => setTab("style")}
        >
          <SlidersHorizontal size={13} aria-hidden="true" />
          Style
          {dirty && tab !== "style" && (
            <span className="cs-unsaved" title="Unsaved style">
              <span className="sr-only">, unsaved style</span>
            </span>
          )}
        </button>
        <button
          role="tab"
          id="caption-edit-tab"
          aria-selected={tab === "edit"}
          aria-controls="caption-edit-panel"
          tabIndex={tab === "edit" ? 0 : -1}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              setTab("style");
              document.getElementById("caption-style-tab")?.focus();
            }
          }}
          onClick={() => setTab("edit")}
        >
          <Type size={14} aria-hidden="true" />
          Edit words
        </button>
      </div>
      {tab === "style" ? (
        <div
          role="tabpanel"
          id="caption-style-panel"
          aria-labelledby="caption-style-tab"
          className="cs-style-panel"
        >
          <AnimatedPreview clip={preview} fps={p.fps} active={active} />
          <label className="cs-field cs-scope">
            Apply to
            <select
              aria-label="Caption style scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as "all" | "selected")}
            >
              <option value="all">
                {captions.length === 1
                  ? "The 1 caption"
                  : `All ${captions.length} captions`}
              </option>
              <option value="selected" disabled={!selectedCaption}>
                Selected caption{selectedCaption ? "" : " (select one first)"}
              </option>
            </select>
          </label>
          <label className="cs-field">
            Words per caption
            <select
              aria-label="Words per caption"
              value={pace}
              disabled={!captions.some((c) => c.words.length) || committing}
              onChange={(e) => void changePace(e.target.value as CaptionPace)}
            >
              <option value="phrases">Natural phrases</option>
              <option value="short">Short: 1 to 3 words</option>
            </select>
          </label>
          <div className="cs-presets" aria-label="Caption style presets">
            {captionStyles.map((style) => (
              <button
                key={style.id}
                aria-label={`Preview ${style.name} caption style`}
                aria-pressed={styled.captionStyle === style.id}
                onClick={() => {
                  setDraft(captionStylePatch(style.id, p));
                  setNotice("");
                }}
              >
                <span
                  className={`cs-preset-type cs-preset-${style.id}`}
                  style={
                    {
                      "--preset-accent": style.patch.accent,
                    } as React.CSSProperties
                  }
                >
                  {style.id === "focus" ? "word" : "Aa"}
                </span>
                <span>{style.name}</span>
                {styled.captionStyle === style.id && (
                  <Check
                    className="cs-preset-check"
                    size={10}
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
          </div>
          <div className="cs-controls">
            <label className="cs-field">
              Size <output>{Math.round(styled.fontSize)} px</output>
              <input
                aria-label="Caption size"
                type="range"
                min={Math.max(
                  12,
                  Math.round(Math.min(p.width, p.height) * 0.022),
                )}
                max={Math.min(
                  240,
                  Math.round(Math.min(p.width, p.height) * 0.15),
                )}
                value={styled.fontSize}
                onChange={(e) => change({ fontSize: Number(e.target.value) })}
              />
            </label>
            <div className="cs-control-row">
              <label className="cs-field">
                Position
                <select
                  aria-label="Caption position"
                  value={currentPosition}
                  onChange={(e) => position(e.target.value)}
                >
                  <option value="lower">Lower safe area</option>
                  <option value="middle">Middle</option>
                  <option value="upper">Upper safe area</option>
                </select>
              </label>
              <label className="cs-field cs-color">
                Accent
                <input
                  type="color"
                  aria-label="Caption accent color"
                  value={
                    /^#[\da-f]{6}/i.test(styled.accent)
                      ? styled.accent.slice(0, 7)
                      : "#c6f16d"
                  }
                  onChange={(e) => change({ accent: e.target.value })}
                />
              </label>
            </div>
            <div className="cs-accent-swatches" aria-label="Accent colors">
              {accents.map((color) => (
                <button
                  key={color}
                  aria-label={`Use ${color} caption accent`}
                  aria-pressed={styled.accent === color}
                  style={{ background: color }}
                  onClick={() => change({ accent: color })}
                >
                  {styled.accent === color && (
                    <Check size={12} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
            <label className="checkbox cs-highlight">
              <input
                type="checkbox"
                aria-label="Highlight the spoken word"
                checked={styled.highlight}
                onChange={(e) => change({ highlight: e.target.checked })}
              />
              Highlight the spoken word
            </label>
            <div className="cs-control-row">
              <label className="cs-field">
                Letter case
                <select
                  aria-label="Caption letter case"
                  value={styled.captionCase}
                  onChange={(e) =>
                    change({
                      captionCase: e.target.value as "original" | "upper",
                    })
                  }
                >
                  <option value="original">As written</option>
                  <option value="upper">UPPERCASE</option>
                </select>
              </label>
              <label className="cs-field">
                Lines
                <select
                  aria-label="Caption maximum lines"
                  value={styled.captionMaxLines}
                  onChange={(e) =>
                    change({ captionMaxLines: Number(e.target.value) as 1 | 2 })
                  }
                >
                  <option value="1">One line</option>
                  <option value="2">Two lines</option>
                </select>
              </label>
            </div>
            <label className="cs-field">
              Outline <output>{styled.captionStrokeWidth} px</output>
              <input
                aria-label="Caption outline width"
                type="range"
                min="0"
                max="12"
                step="0.5"
                value={styled.captionStrokeWidth}
                onChange={(e) =>
                  change({ captionStrokeWidth: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <div className="cs-apply-row">
            <button
              className="cs-apply primary"
              disabled={!dirty || !targets.length || committing}
              onClick={applyStyle}
            >
              {scope === "selected"
                ? "Apply to selected caption"
                : `Apply to ${captions.length} caption${captions.length === 1 ? "" : "s"}`}
            </button>
            {dirty && (
              <button
                aria-label="Discard caption style changes"
                onClick={() => setDraft({})}
              >
                Reset
              </button>
            )}
          </div>
          {(!captions.length || dirty) && (
            <p className="cs-hint">
              {!captions.length
                ? "Generate or import captions to apply a style."
                : "Unsaved style. Apply it or reset."}
            </p>
          )}
        </div>
      ) : (
        <div
          role="tabpanel"
          id="caption-edit-panel"
          aria-labelledby="caption-edit-tab"
          className="cs-edit-panel"
        >
          <label className="search-field cs-search">
            <Search size={14} aria-hidden="true" />
            <input
              aria-label="Search caption phrases"
              value={query}
              placeholder="Search words…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                aria-label="Clear caption search"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </label>
          {!!captions.length && (
            <details className="cs-replace">
              <summary>Find & replace</summary>
              <label className="cs-field">
                Replace matching words with
                <input
                  aria-label="Replace caption words with"
                  value={replace}
                  onChange={(e) => setReplace(e.target.value)}
                  placeholder="Replacement text"
                />
              </label>
              <button
                className="control"
                disabled={!query}
                onClick={reviewReplacement}
              >
                Review changes
              </button>
              {replaceError && (
                <p className="cs-error" role="alert">
                  {replaceError}
                </p>
              )}
              {review && (
                <div className="cs-replace-review">
                  <strong>
                    {replacementPlan.length}{" "}
                    {replacementPlan.length === 1 ? "phrase" : "phrases"} will
                    change
                  </strong>
                  {replacementPlan.slice(0, 3).map((item) => (
                    <div key={item.id}>
                      <del>{item.before}</del>
                      <span>{item.after}</span>
                    </div>
                  ))}
                  {replacementPlan.some(
                    (item) =>
                      item.timing === "cleared" &&
                      captions.find((c) => c.id === item.id)?.words.length,
                  ) && (
                    <p className="cs-hint">
                      Changed word counts clear word timing.
                    </p>
                  )}
                  <button
                    className="cs-apply primary"
                    disabled={!replacementPlan.length || committing}
                    onClick={applyReplacement}
                  >
                    Replace in {plural(replacementPlan.length, "caption")}
                  </button>
                </div>
              )}
            </details>
          )}
          {query && (
            <div className="cs-phrase-count">
              {visible.length} of {plural(captions.length, "phrase")}
            </div>
          )}
          <div className="cs-phrases">
            {visible.map((c) => (
              <article
                key={c.id}
                className={`${selected === c.id ? "selected" : ""} ${playingId === c.id ? "playing" : ""}`}
              >
                <div className="cs-phrase-row">
                  <button
                    className="cs-phrase-select"
                    aria-label={`Select caption at ${captionTimestamp(c.start, p.fps)}: ${c.text}`}
                    aria-pressed={selected === c.id}
                    onClick={() => {
                      select(c.id);
                      seek(c.start);
                    }}
                  >
                    <span className="cs-timestamp">
                      {captionTimestamp(c.start, p.fps)}
                      <span>
                        – {captionTimestamp(c.start + c.duration, p.fps)}
                      </span>
                    </span>
                    <span>{c.text}</span>
                  </button>
                  <button
                    className="cs-edit-button"
                    disabled={committing}
                    aria-label={`Edit caption at ${captionTimestamp(c.start, p.fps)}`}
                    onClick={() => {
                      select(c.id);
                      seek(c.start);
                      setEditing({ id: c.id, original: c.text, text: c.text });
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                </div>
                {editing?.id === c.id && (
                  <div className="cs-phrase-editor">
                    <label className="cs-field">
                      Caption text
                      <textarea
                        disabled={committing}
                        autoFocus
                        aria-label="Edit caption text"
                        aria-describedby={
                          editing.error
                            ? "caption-edit-error"
                            : retimed
                              ? "caption-edit-hint"
                              : undefined
                        }
                        value={editing.text}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            text: e.target.value,
                            error: undefined,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                          }
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            savePhrase();
                          }
                        }}
                      />
                    </label>
                    {retimed && (
                      <p id="caption-edit-hint" className="cs-hint">
                        Word timing will be cleared; caption timing retained.
                      </p>
                    )}
                    {editing.error && (
                      <p
                        id="caption-edit-error"
                        className="cs-error"
                        role="alert"
                      >
                        {editing.error}
                      </p>
                    )}
                    <div className="cs-edit-actions">
                      <button
                        disabled={committing}
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="cs-apply primary"
                        onClick={savePhrase}
                        disabled={!editing.text.trim() || committing}
                      >
                        Save caption
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
          {!visible.length && (
            <p className="cs-empty">
              {query ? `No captions match “${query}”.` : "No captions yet."}
            </p>
          )}
        </div>
      )}
      {commitError && (
        <p className="cs-error" role="alert">
          {commitError}
        </p>
      )}
      <p className="cs-notice" role="status" aria-live="polite">
        {notice}
      </p>
    </div>
  );
}
