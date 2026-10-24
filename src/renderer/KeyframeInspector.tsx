import React, { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Diamond, Trash2 } from "lucide-react";
import type { Clip } from "../shared/model";
import type { Command } from "../shared/commands";
import {
  animatedValue,
  propertyBounds,
  type AnimatedProperty,
} from "../shared/animation";
import { captionTimestamp } from "../shared/caption-edit";
import { motionCurvePresets, type MotionBezier } from "../shared/motion";
import { NumberField } from "./Inspector";
import {
  relocateClipKey,
  retimeClipKeys,
  visibleClipKeys,
  type ClipKeyEdit,
} from "../shared/clip-keyframe-edit";
import "./keyframe-inspector.css";
import {
  defaultKeyframeProperty,
  formatKeyValue,
  keyframeProperties,
  propertyLabel,
} from "./labels";
type Key = Clip["keyframes"][number];
const easingLabels: Record<Key["easing"], string> = {
  linear: "Linear",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "Ease in and out",
  hold: "Hold",
  spring: "Spring",
  back: "Back",
  "cubic-bezier": "Custom curve",
};
const plainEasings = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "hold",
  "spring",
  "back",
] as const;
/** Curve presets share one select with the named easings. */
function easingChoice(key: Pick<Key, "easing" | "bezier">) {
  if (key.easing !== "cubic-bezier") return key.easing;
  const preset = motionCurvePresets.find((curve) =>
    curve.bezier.every((value, i) => value === key.bezier?.[i]),
  );
  return preset ? `curve:${preset.id}` : "cubic-bezier";
}
function easingName(key: Pick<Key, "easing" | "bezier">) {
  const choice = easingChoice(key);
  return choice.startsWith("curve:")
    ? motionCurvePresets.find((curve) => `curve:${curve.id}` === choice)!.name
    : easingLabels[key.easing];
}
const round = (value: number) => Math.round(value * 1000) / 1000;
const keyTime = (frames: number, fps: number) =>
  (frames < 0 ? "-" : "") + captionTimestamp(Math.abs(frames), fps);
export function KeyframeInspector({
  clip: c,
  frame,
  fps,
  audible,
  title = "Keyframes",
  seek,
  edit,
}: {
  clip: Clip;
  frame: number;
  fps: number;
  /** Whether the clip makes sound, so volume is worth animating. */
  audible: boolean;
  title?: string;
  seek: (frame: number) => void;
  edit: (label: string, commands: Command[]) => unknown;
}) {
  const [property, setProperty] = useState<AnimatedProperty>(() =>
    defaultKeyframeProperty(c, audible),
  );
  // Closed until the clip has keys, so basics stay on top. The section keeps
  // whatever open state you give it while this clip stays selected.
  const [open] = useState(() => c.keyframes.length > 0);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [moveFrame, setMoveFrame] = useState("");
  const [rangeStart, setRangeStart] = useState("0");
  const [rangeEnd, setRangeEnd] = useState(String(c.duration - 1));
  const [error, setError] = useState("");
  // The chosen property stays listed even after its last key is cleared.
  const allowed = keyframeProperties(c, audible);
  const properties = allowed.includes(property)
    ? allowed
    : [...allowed, property];
  const local = frame - c.start,
    inside = local >= 0 && local < c.duration;
  const keys = c.keyframes
    .filter((k) => k.property === property)
    .sort((a, b) => a.frame - b.frame);
  const visibleKeys = visibleClipKeys(c, property);
  const at = local + c.animationOffset;
  const playheadKey = keys.find((k) => k.frame === at);
  const current =
    visibleKeys.find((k) => k.frame === selectedFrame) ??
    (inside ? playheadKey : undefined);
  const currentLocal = current ? current.frame - c.animationOffset : local;
  const previous = visibleKeys.filter((key) => key.frame < at).at(-1);
  const next = visibleKeys.find((key) => key.frame > at);
  useEffect(() => {
    setSelectedFrame(null);
    setError("");
    setRangeStart("0");
    setRangeEnd(String(c.duration - 1));
  }, [c.id, property, c.duration, c.animationOffset]);
  useEffect(
    () =>
      setMoveFrame(current ? String(current.frame - c.animationOffset) : ""),
    [current?.frame, c.animationOffset],
  );
  const select = (key: Key) => {
    setSelectedFrame(key.frame);
    setError("");
    seek(c.start + key.frame - c.animationOffset);
  };
  const change = (
    f: number,
    value: number,
    easing: Key["easing"] = current?.easing ?? "ease-in-out",
    remove = false,
    bezier: MotionBezier | undefined = current?.bezier,
  ) =>
    edit("Edit property keyframe", [
      {
        type: "clip.keyframe",
        id: c.id,
        property,
        frame: f,
        value,
        easing,
        ...(easing === "cubic-bezier" && bezier ? { bezier } : {}),
        remove,
      },
    ]);
  const choose = (choice: string) => {
    if (!current) return;
    const curve = motionCurvePresets.find(
      (preset) => `curve:${preset.id}` === choice,
    );
    if (curve)
      change(currentLocal, current.value, "cubic-bezier", false, [
        ...curve.bezier,
      ]);
    else if (choice !== "cubic-bezier")
      change(currentLocal, current.value, choice as Key["easing"]);
  };
  const commitKeys = (label: string, result: ClipKeyEdit) => {
    if (result.error) {
      setError(result.error);
      return false;
    }
    setError("");
    if (result.keyframes !== c.keyframes)
      edit(label, [
        {
          type: "clip.update",
          id: c.id,
          patch: { keyframes: result.keyframes },
        },
      ]);
    return true;
  };
  const relocate = (copy: boolean) => {
    if (!current) return;
    const destination = copy
      ? local
      : moveFrame.trim()
        ? Number(moveFrame)
        : NaN;
    if (
      commitKeys(
        copy ? "Duplicate animation key" : "Move animation key",
        relocateClipKey(c, property, current.frame, destination, copy),
      )
    ) {
      setSelectedFrame(destination + c.animationOffset);
      seek(c.start + destination);
    }
  };
  const [min, max] = propertyBounds[property];
  const name = propertyLabel(property);
  // Sample the actual composition evaluator, including trim phase and overshoot.
  const samples = Array.from({ length: 81 }, (_, index) => {
    const atFrame = (index / 80) * Math.max(0, c.duration - 1);
    return { frame: atFrame, value: animatedValue(c, property, atFrame) };
  });
  const values = [
    ...samples.map((sample) => sample.value),
    ...visibleKeys.map((key) => key.value),
  ];
  const low = Math.min(...values),
    high = Math.max(...values);
  const spread = Math.max(
    high - low,
    Math.abs(high) * 0.1,
    property === "x" || property === "y" ? 10 : 0.1,
  );
  const graphLow = low - spread * 0.12,
    graphHigh = high + spread * 0.12;
  const gx = (atFrame: number) =>
    12 + (atFrame / Math.max(1, c.duration - 1)) * 232;
  const gy = (value: number) =>
    90 - ((value - graphLow) / (graphHigh - graphLow)) * 76;
  const graphPath = samples
    .map(
      (sample, index) =>
        `${index ? "L" : "M"}${12 + (index / 80) * 232},${gy(sample.value)}`,
    )
    .join(" ");
  return (
    <details open={open} className="clip-keyframe-inspector">
      <summary>{title}</summary>
      <label className="field">
        <span>Animated property</span>
        <select
          aria-label="Animated property"
          value={property}
          onChange={(e) => setProperty(e.target.value as AnimatedProperty)}
        >
          {properties.map((p) => (
            <option key={p} value={p}>
              {propertyLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <div className="clip-curve" aria-label={`${name} animation curve`}>
        <svg
          viewBox="0 0 256 104"
          role="img"
          aria-label={`Evaluated ${name.toLowerCase()} over ${c.duration} frames. ${visibleKeys.length} visible keys.`}
        >
          {[22, 52, 82].map((y) => (
            <line
              key={y}
              x1="12"
              x2="244"
              y1={y}
              y2={y}
              className="clip-curve-grid"
            />
          ))}
          <path d={graphPath} className="clip-curve-line" />
          {inside && (
            <line
              x1={gx(local)}
              x2={gx(local)}
              y1="8"
              y2="96"
              className="clip-curve-playhead"
            />
          )}
          {visibleKeys.map((key) => (
            <path
              key={key.frame}
              d="M0,-3.5 L3.5,0 L0,3.5 L-3.5,0Z"
              transform={`translate(${gx(key.frame - c.animationOffset)} ${gy(key.value)})`}
              className={
                current?.frame === key.frame
                  ? "clip-curve-key selected"
                  : "clip-curve-key"
              }
            />
          ))}
        </svg>
        <div className="clip-curve-scale">
          <span>0f</span>
          <span>
            {formatKeyValue(property, low)} – {formatKeyValue(property, high)}
          </span>
          <span>{c.duration - 1}f</span>
        </div>
      </div>
      <div className="clip-key-navigation">
        <button
          aria-label="Previous property keyframe"
          title="Previous keyframe"
          disabled={!previous}
          onClick={() => previous && select(previous)}
        >
          <ChevronLeft size={15} />
        </button>
        <output>
          {inside ? `Playhead ${local}f` : "Playhead outside clip"}
        </output>
        <button
          aria-label="Next property keyframe"
          title="Next keyframe"
          disabled={!next}
          onClick={() => next && select(next)}
        >
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="keyframe-actions">
        <button
          className="control"
          disabled={!inside || !!playheadKey}
          onClick={() => {
            change(
              local,
              round(animatedValue(c, property, local)),
              "ease-in-out",
              false,
              undefined,
            );
            setSelectedFrame(at);
            setError("");
          }}
        >
          <Diamond size={13} />{" "}
          {playheadKey && inside ? "Key at playhead" : "Add at playhead"}
        </button>
        <button
          className="control"
          disabled={!current}
          onClick={() => {
            change(currentLocal, current!.value, current!.easing, true);
            setSelectedFrame(null);
            setError("");
          }}
        >
          <Trash2 size={13} /> Remove key
        </button>
      </div>
      {(inside || current) && (
        <NumberField
          label={current ? "Selected key value" : "Keyframe value"}
          value={current?.value ?? animatedValue(c, property, local)}
          min={min}
          max={max}
          step={property === "x" || property === "y" ? 1 : 0.05}
          onChange={(value) => change(current ? currentLocal : local, value)}
        />
      )}
      {current && (
        <div className="clip-key-edit">
          <div className="clip-key-caption">
            Selected key · {currentLocal}f · {keyTime(currentLocal, fps)}
          </div>
          <div className="clip-key-move">
            <label className="field">
              <span>Move to frame</span>
              <input
                type="number"
                aria-label="Move selected key to frame"
                min={0}
                max={c.duration - 1}
                step={1}
                value={moveFrame}
                onChange={(event) => {
                  setMoveFrame(event.target.value);
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") relocate(false);
                  if (event.key === "Escape")
                    setMoveFrame(String(currentLocal));
                }}
              />
            </label>
            <button
              disabled={moveFrame === String(currentLocal)}
              onClick={() => relocate(false)}
            >
              Move
            </button>
          </div>
          <button
            className="clip-key-copy"
            disabled={!inside || at === current.frame}
            onClick={() => relocate(true)}
          >
            <Copy size={13} /> Duplicate at playhead
          </button>
        </div>
      )}
      {current && (
        <label className="field">
          <span>Easing to next key</span>
          <select
            aria-label="Keyframe easing"
            value={easingChoice(current)}
            onChange={(e) => choose(e.target.value)}
          >
            {plainEasings.map((easing) => (
              <option key={easing} value={easing}>
                {easingLabels[easing]}
              </option>
            ))}
            {motionCurvePresets.map((curve) => (
              <option key={curve.id} value={`curve:${curve.id}`}>
                {curve.name}
              </option>
            ))}
            {easingChoice(current) === "cubic-bezier" && (
              <option value="cubic-bezier">
                {easingLabels["cubic-bezier"]}
              </option>
            )}
          </select>
        </label>
      )}
      <div className="keyframe-list">
        {keys.map((k) => (
          <button
            key={k.frame}
            title={easingName(k)}
            aria-pressed={current?.frame === k.frame}
            disabled={
              k.frame < c.animationOffset ||
              k.frame >= c.animationOffset + c.duration
            }
            onClick={() => select(k)}
            onKeyDown={(event) => {
              if (event.key !== "Delete" && event.key !== "Backspace") return;
              event.preventDefault();
              event.stopPropagation();
              change(k.frame - c.animationOffset, k.value, k.easing, true);
              setSelectedFrame(null);
              setError("");
            }}
          >
            ◆ {keyTime(k.frame - c.animationOffset, fps)} ·{" "}
            {formatKeyValue(property, k.value)} · {easingName(k)}
          </button>
        ))}
      </div>
      {keys.length > visibleKeys.length && (
        <p className="hint">
          {keys.length - visibleKeys.length} keys outside this trim are
          preserved.
        </p>
      )}
      {visibleKeys.length >= 2 && (
        <details className="clip-key-retime">
          <summary>Retime {name.toLowerCase()}</summary>
          <p className="hint">
            Fit the {visibleKeys.length} visible keys into a new frame range.
            Their values and easing stay editable.
          </p>
          <div className="two-col">
            <label className="field">
              <span>Start frame</span>
              <input
                type="number"
                aria-label="Retime start frame"
                min={0}
                max={c.duration - 2}
                step={1}
                value={rangeStart}
                onChange={(event) => setRangeStart(event.target.value)}
              />
            </label>
            <label className="field">
              <span>End frame</span>
              <input
                type="number"
                aria-label="Retime end frame"
                min={1}
                max={c.duration - 1}
                step={1}
                value={rangeEnd}
                onChange={(event) => setRangeEnd(event.target.value)}
              />
            </label>
          </div>
          <button
            className="control"
            onClick={() => {
              const result = retimeClipKeys(
                c,
                property,
                rangeStart.trim() ? Number(rangeStart) : NaN,
                rangeEnd.trim() ? Number(rangeEnd) : NaN,
              );
              if (commitKeys("Retime property animation", result))
                setSelectedFrame(null);
            }}
          >
            Apply timing
          </button>
        </details>
      )}
      {error && (
        <p className="clip-key-error" role="alert">
          {error}
        </p>
      )}
      {!!keys.length && (
        <button
          onClick={() => {
            edit("Clear property animation", [
              {
                type: "clip.update",
                id: c.id,
                patch: {
                  keyframes: c.keyframes.filter((k) => k.property !== property),
                },
              },
            ]);
            setSelectedFrame(null);
            setError("");
          }}
        >
          Clear {name[0].toLowerCase() + name.slice(1)} animation
        </button>
      )}
    </details>
  );
}
