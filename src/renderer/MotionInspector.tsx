import React, { useEffect, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Copy,
  ChevronUp,
  ChevronDown,
  Diamond,
  Eye,
  EyeOff,
  AlignLeft,
  AlignCenterHorizontal,
  AlignRight,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  Columns3,
  Rows3,
} from "lucide-react";
import {
  MotionLayerSchema,
  type Motion,
  type Clip,
  type Project,
} from "../shared/model";
import { createLogoRevealCommands } from "../shared/logo-presets";
import { VectorEditor } from "./VectorEditor";
import { MAX_VECTOR_LAYERS } from "../shared/vector-path";
import {
  motionProperties,
  motionPropertyBounds,
  motionEasings,
  motionValue,
  motionFrame,
  defaultMotionBezier,
  type MotionBezier,
  type MotionEasing,
} from "../shared/motion";
import type { Command } from "../shared/commands";
import {
  upsertMotionKey,
  motionKeySeekFrame,
  moveMotionKey,
} from "../shared/motion-edit";
import {
  alignMotionLayers,
  distributeMotionLayers,
  orderedMotionLayers,
  shiftMotionLayerTiming,
  scaleMotionLayerTiming,
  type LayerAlignment,
  type MotionLayerEditResult,
} from "../shared/motion-layout";
import { ColorInput, NumberField, optionLabel } from "./Inspector";
import { easingLabel } from "./labels";
import "./motion-inspector.css";
type Layer = Motion["layers"][number];
type Property = (typeof motionProperties)[number];
const names: Record<Property, string> = {
  x: "Move X",
  y: "Move Y",
  scale: "Scale",
  rotate: "Rotation",
  opacity: "Opacity",
  blur: "Blur",
  trim: "Stroke reveal",
  strokeWidth: "Stroke width",
  fillOpacity: "Fill opacity",
};
const shapes = [
  "text",
  "rectangle",
  "ellipse",
  "triangle",
  "star",
  "line",
  "path",
] as const;
const curvePresets: { id: string; name: string; bezier: MotionBezier }[] = [
  { id: "smooth-out", name: "Smooth out", bezier: [0.16, 1, 0.3, 1] },
  { id: "smooth-in-out", name: "Smooth in & out", bezier: [0.65, 0, 0.35, 1] },
  { id: "quick-settle", name: "Quick settle", bezier: [0.22, 1, 0.36, 1] },
  { id: "overshoot", name: "Overshoot", bezier: [0.34, 1.56, 0.64, 1] },
  { id: "sharp", name: "Sharp transition", bezier: [0.76, 0, 0.24, 1] },
];
export function MotionInspector({
  project,
  motion,
  clip,
  frame,
  seek,
  edit,
}: {
  project: Project;
  motion: Motion;
  clip: Clip;
  frame: number;
  seek: (frame: number) => void;
  edit: (label: string, ops: Command[]) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [selectedLayers, setSelectedLayers] = useState<number[]>([0]);
  const [layoutTarget, setLayoutTarget] = useState<"canvas" | "selection">(
    "canvas",
  );
  const [batchError, setBatchError] = useState("");
  const [batchStatus, setBatchStatus] = useState("");
  const [timingOffset, setTimingOffset] = useState("0");
  const [timingStagger, setTimingStagger] = useState("4");
  const [timingScale, setTimingScale] = useState("100");
  const [timingOrder, setTimingOrder] = useState<
    "top-first" | "bottom-first" | "left-first"
  >("top-first");
  const [property, setProperty] = useState<Property>("opacity");
  const [keyTarget, setKeyTarget] = useState<number>();
  const [keyError, setKeyError] = useState("");
  const [moveFrame, setMoveFrame] = useState("");
  const [bezierDraft, setBezierDraft] = useState<MotionBezier>();
  const [vectorDirty, setVectorDirty] = useState(false);
  const [logoStyle, setLogoStyle] = useState<"draw" | "orbit" | "signal">(
    "draw",
  );
  const [logoError, setLogoError] = useState("");
  const bezierSvg = useRef<SVGSVGElement>(null);
  const bezierDrag = useRef<
    | {
        pointerId: number;
        target: HTMLButtonElement;
        handle: 0 | 1;
        points: MotionBezier;
        low: number;
        high: number;
      }
    | undefined
  >(undefined);
  // Arrow keys on a bezier handle preview here and commit once on release.
  const bezierKeys = useRef<MotionBezier | undefined>(undefined);
  const requestedIndex = Math.min(selected, motion.layers.length - 1);
  const included = selectedLayers.filter((i) => i < motion.layers.length);
  const index = included.includes(requestedIndex)
    ? requestedIndex
    : (included[0] ?? requestedIndex);
  const layer = motion.layers[index];
  const selection = included.length ? included : [index];
  useEffect(() => {
    setSelectedLayers((current) => {
      const valid = current.filter((i) => i < motion.layers.length);
      return valid.length
        ? valid
        : [Math.min(selected, motion.layers.length - 1)];
    });
  }, [motion.layers.length]);
  const selectOnly = (i: number) => {
    setSelected(i);
    setSelectedLayers([i]);
    setBatchError("");
    setBatchStatus("");
  };
  const toggleLayer = (i: number) => {
    const next = selection.includes(i)
      ? selection.filter((n) => n !== i)
      : [...selection, i];
    if (!next.length) return;
    setSelectedLayers(next);
    if (!next.includes(index)) setSelected(next[0]);
    setBatchError("");
    setBatchStatus("");
  };
  const local = frame - clip.start;
  const inside = local >= 0 && local < clip.duration;
  const at =
    keyTarget ?? Math.round(motionFrame(layer, local + clip.animationOffset));
  useEffect(() => {
    setKeyTarget(undefined);
    setKeyError("");
  }, [index, property]);
  const put = (layers: Layer[], label = "Adjust motion layer") =>
    edit(label, [{ type: "motion.put", motion: { ...motion, layers } }]);
  const update = (patch: Partial<Layer>) =>
    put(motion.layers.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const move = (direction: number) => {
    const next = index + direction;
    if (next < 0 || next >= motion.layers.length) return;
    const layers = [...motion.layers];
    [layers[index], layers[next]] = [layers[next], layers[index]];
    put(layers, "Reorder motion layers");
    selectOnly(next);
  };
  const applyBatch = (result: MotionLayerEditResult, label: string) => {
    if (result.error) {
      setBatchError(result.error);
      setBatchStatus("");
      return;
    }
    setBatchError("");
    const layers = result.layers!;
    if (JSON.stringify(layers) !== JSON.stringify(motion.layers)) {
      put(layers, label);
      setBatchStatus(`${label}. Undo restores the whole edit.`);
    } else setBatchStatus("The selected layers already match this adjustment.");
  };
  const alignSelection = (alignment: LayerAlignment) =>
    applyBatch(
      alignMotionLayers(
        motion.layers,
        selection,
        clip,
        alignment,
        selection.length < 2 ? "canvas" : layoutTarget,
        Math.max(0, local) + clip.animationOffset,
      ),
      "Align motion layers",
    );
  const key = [...layer.keyframes]
    .reverse()
    .find((k) => k.frame === at && k[property] !== undefined);
  const keyframes = [
    ...new Map(
      layer.keyframes
        .filter((k) => k[property] !== undefined)
        .map((k) => [k.frame, k]),
    ).values(),
  ].sort((a, b) => a.frame - b.frame);
  const keyValue =
    keyTarget !== undefined && key
      ? key[property]!
      : motionValue(layer, property, local + clip.animationOffset);
  const moveMax = layer.loop === "none" ? clip.duration - 1 : layer.loopFrames;
  useEffect(() => {
    const relative = layer.loop === "none" ? at - clip.animationOffset : at;
    setMoveFrame(String(Math.max(0, Math.min(moveMax, relative))));
  }, [at, index, property, clip.animationOffset, moveMax, layer.loop]);
  useEffect(() => {
    const drag = bezierDrag.current;
    bezierDrag.current = undefined;
    bezierKeys.current = undefined;
    if (drag?.target.hasPointerCapture(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
    setBezierDraft(undefined);
  }, [motion.layers, index, property, at]);
  const canKey = !!upsertMotionKey(
    layer,
    property,
    at,
    keyValue,
    key?.easing ?? "ease-in-out",
    key?.easing === "cubic-bezier"
      ? (key.bezier ?? defaultMotionBezier)
      : undefined,
  );
  const setKey = (
    value: number,
    easing: MotionEasing = key?.easing ?? "ease-in-out",
    bezier: MotionBezier | undefined = key?.bezier,
  ) => {
    const next = upsertMotionKey(
      layer,
      property,
      at,
      value,
      easing,
      easing === "cubic-bezier" ? (bezier ?? defaultMotionBezier) : undefined,
    );
    if (!next) {
      setKeyError(
        "This layer has 100 curve keys. Remove a key before adding another easing segment.",
      );
      return;
    }
    setKeyError("");
    update({ keyframes: next });
  };
  const removeKey = () =>
    update({
      keyframes: layer.keyframes
        .map((k) => {
          if (k.frame !== at) return k;
          const next = { ...k };
          delete next[property];
          return next;
        })
        .filter((k) => motionProperties.some((p) => k[p] !== undefined)),
    });
  const moveKey = () => {
    if (!key) return;
    const relative = Number(moveFrame);
    if (
      !moveFrame.trim() ||
      !Number.isInteger(relative) ||
      relative < 0 ||
      relative > moveMax
    ) {
      setKeyError(`Choose a whole frame from 0 to ${moveMax}.`);
      return;
    }
    const destination =
      layer.loop === "none" ? relative + clip.animationOffset : relative;
    if (destination === at) {
      setKeyError("");
      return;
    }
    const next = moveMotionKey(layer, property, at, destination);
    if (!next) {
      setKeyError(
        layer.keyframes.some(
          (k) => k.frame === destination && k[property] !== undefined,
        )
          ? `A ${names[property].toLowerCase()} key already exists at that frame. Choose another frame.`
          : "This layer cannot fit another curve segment. Remove a key and try again.",
      );
      return;
    }
    put(
      motion.layers.map((l, i) =>
        i === index ? { ...l, keyframes: next } : l,
      ),
      "Move motion keyframe",
    );
    setKeyError("");
    setKeyTarget(destination);
    seek(motionKeySeekFrame(layer, clip, destination, frame));
  };
  const previewKeys =
    bezierDraft && key
      ? upsertMotionKey(
          layer,
          property,
          at,
          keyValue,
          "cubic-bezier",
          bezierDraft,
        )
      : undefined;
  const previewLayer = previewKeys
    ? { ...layer, keyframes: previewKeys }
    : layer;
  const [min, max] = motionPropertyBounds[property];
  const graphEnd =
    layer.loop === "none"
      ? Math.max(1, clip.duration - 1)
      : layer.loopFrames * (layer.loop === "ping-pong" ? 2 : 1);
  const graphFrame =
    layer.loop === "none" ? local : Math.max(0, local) % graphEnd;
  const samples = Array.from({ length: 61 }, (_, i) =>
    motionValue(
      previewLayer,
      property,
      (i * graphEnd) / 60 + clip.animationOffset,
    ),
  );
  const low = Math.min(...samples),
    high = Math.max(...samples),
    span = Math.max(0.01, high - low);
  const path = samples
    .map(
      (v, i) => `${i ? "L" : "M"}${8 + i * 4},${72 - ((v - low) / span) * 56}`,
    )
    .join(" ");
  const evaluatedValue = motionValue(
    previewLayer,
    property,
    local + clip.animationOffset,
  );
  const bezier = bezierDraft ?? key?.bezier ?? defaultMotionBezier;
  const curvePreset =
    curvePresets.find((preset) =>
      preset.bezier.every((value, i) => value === bezier[i]),
    )?.id ?? "custom";
  const bezierLow =
      bezierDrag.current?.low ?? Math.min(0, bezier[1], bezier[3]),
    bezierHigh = bezierDrag.current?.high ?? Math.max(1, bezier[1], bezier[3]);
  const bezierX = (value: number) => 18 + value * 220;
  const bezierY = (value: number) =>
    96 - ((value - bezierLow) / (bezierHigh - bezierLow)) * 80;
  const clampPoint = (value: number, coordinate: number) =>
    Math.round(
      Math.max(
        coordinate % 2 === 0 ? 0 : -2,
        Math.min(coordinate % 2 === 0 ? 1 : 3, value),
      ) * 100,
    ) / 100;
  const updateDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = bezierDrag.current;
    const matrix = bezierSvg.current?.getScreenCTM();
    if (!drag || drag.pointerId !== event.pointerId || !matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    const next = [...drag.points] as MotionBezier;
    next[drag.handle * 2] = clampPoint((point.x - 18) / 220, 0);
    next[drag.handle * 2 + 1] = clampPoint(
      drag.low + ((96 - point.y) / 80) * (drag.high - drag.low),
      1,
    );
    drag.points = next;
    setBezierDraft(next);
  };
  const colorField = (
    label: string,
    value: string,
    field: "background" | "color" | "stroke" | "gradientColor",
  ) => (
    <label className="field">
      <span>{label}</span>
      <ColorInput
        // One well per layer, so a pending color never lands on the next layer.
        key={`${index}:${field}`}
        aria-label={label}
        value={value === "transparent" ? "#ffffff" : value.slice(0, 7)}
        onCommit={(color) => update({ [field]: color })}
      />
    </label>
  );
  const number = (
    label: string,
    field: keyof Layer,
    value: number,
    min?: number,
    max?: number,
    step = 1,
  ) => (
    <NumberField
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(n) => update({ [field]: n })}
    />
  );
  const layerName = (l: Layer) =>
    l.name || (l.type === "text" ? l.text || "Clip text" : optionLabel(l.type));
  return (
    <details open className="motion-inspector">
      <summary>Motion layers · {motion.layers.length}</summary>
      {/* Top layer first, like the timeline. Numbers follow the stored order
          (layer 1 is at the back) so they match what agents call each layer. */}
      <div
        className="motion-layer-list"
        role="group"
        aria-label="Motion layers"
      >
        {motion.layers
          .map((l, i) => ({ l, i }))
          .reverse()
          .map(({ l, i }) => (
            <div
              key={i}
              className={`motion-layer-row${l.hidden ? " is-hidden" : ""}${selection.includes(i) ? " is-included" : ""}`}
            >
              <label
                className="motion-layer-check"
                title={`Include ${layerName(l)} in layout and timing edits`}
              >
                <input
                  type="checkbox"
                  aria-label={`Include motion layer ${i + 1} in selection`}
                  checked={selection.includes(i)}
                  onChange={() => toggleLayer(i)}
                />
              </label>
              <button
                aria-label={`Select motion layer ${i + 1}`}
                aria-description={`${layerName(l)} · ${l.hidden ? "hidden" : "visible"}`}
                title={layerName(l)}
                aria-pressed={i === index}
                className={`motion-layer-select${i === index ? " active" : ""}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey) toggleLayer(i);
                  else if (event.shiftKey) {
                    const low = Math.min(index, i),
                      high = Math.max(index, i);
                    setSelectedLayers(
                      Array.from(
                        { length: high - low + 1 },
                        (_, offset) => low + offset,
                      ),
                    );
                    setSelected(i);
                  } else if (selection.includes(i)) setSelected(i);
                  else selectOnly(i);
                }}
              >
                <span>{i + 1}</span>
                <strong>{layerName(l)}</strong>
                <small>
                  {l.keyframes.length}{" "}
                  {l.keyframes.length === 1 ? "key" : "keys"}
                </small>
              </button>
              <button
                className="motion-layer-visibility"
                aria-label={`${l.hidden ? "Show" : "Hide"} motion layer ${i + 1}`}
                aria-pressed={!l.hidden}
                title={`${l.hidden ? "Show" : "Hide"} ${layerName(l)}`}
                onClick={() =>
                  put(
                    motion.layers.map((item, j) =>
                      j === i ? { ...item, hidden: !item.hidden } : item,
                    ),
                    l.hidden ? "Show motion layer" : "Hide motion layer",
                  )
                }
              >
                {l.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          ))}
      </div>
      <div className="motion-selection-bar">
        <span>{selection.length} selected</span>
        <button
          className="subtle"
          onClick={() => setSelectedLayers(motion.layers.map((_, i) => i))}
        >
          Select all
        </button>
        <button
          className="subtle"
          disabled={selection.length === 1}
          onClick={() => selectOnly(index)}
        >
          Only this layer
        </button>
      </div>
      <div className="motion-layer-actions">
        <button
          className="control"
          aria-label="Move layer forward"
          title="Bring forward"
          disabled={selection.length > 1 || index === motion.layers.length - 1}
          onClick={() => move(1)}
        >
          <ChevronUp size={14} />
        </button>
        <button
          className="control"
          aria-label="Move layer backward"
          title="Send backward"
          disabled={selection.length > 1 || index === 0}
          onClick={() => move(-1)}
        >
          <ChevronDown size={14} />
        </button>
        <button
          className="control"
          aria-label="Duplicate motion layer"
          disabled={motion.layers.length + selection.length > MAX_VECTOR_LAYERS}
          onClick={() => {
            const layers: Layer[] = [];
            const copies: number[] = [];
            motion.layers.forEach((item, i) => {
              layers.push(item);
              if (selection.includes(i)) {
                copies.push(layers.length);
                layers.push(structuredClone(item));
              }
            });
            put(layers, "Duplicate motion layers");
            setSelectedLayers(copies);
            setSelected(copies.at(-1)!);
          }}
        >
          <Copy size={14} /> Duplicate
        </button>
        <button
          className="control"
          aria-label="Remove motion layer"
          disabled={selection.length === motion.layers.length}
          onClick={() => {
            const layers = motion.layers.filter(
              (_, i) => !selection.includes(i),
            );
            put(layers, "Remove motion layers");
            selectOnly(Math.min(index, layers.length - 1));
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <details className="motion-batch" open>
        <summary>Layout & choreography</summary>
        <label className="field">
          <span>Align to</span>
          <select
            aria-label="Align motion layers to"
            value={selection.length < 2 ? "canvas" : layoutTarget}
            onChange={(event) =>
              setLayoutTarget(event.target.value as typeof layoutTarget)
            }
          >
            <option value="canvas">Scene canvas</option>
            <option value="selection" disabled={selection.length < 2}>
              Selected layer bounds
            </option>
          </select>
        </label>
        <div
          className="motion-align-grid"
          role="group"
          aria-label="Align selected motion layers"
        >
          {(
            [
              ["left", "Align left", AlignLeft],
              ["center-x", "Align horizontal centers", AlignCenterHorizontal],
              ["right", "Align right", AlignRight],
              ["top", "Align top", AlignStartVertical],
              ["center-y", "Align vertical centers", AlignCenterVertical],
              ["bottom", "Align bottom", AlignEndVertical],
            ] as const
          ).map(([alignment, label, Icon]) => (
            <button
              key={alignment}
              className="control"
              aria-label={label}
              title={label}
              onClick={() => alignSelection(alignment)}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
        <div className="motion-distribute-grid">
          <button
            className="control"
            disabled={selection.length < 3}
            onClick={() =>
              applyBatch(
                distributeMotionLayers(
                  motion.layers,
                  selection,
                  "x",
                  Math.max(0, local) + clip.animationOffset,
                ),
                "Distribute motion layers horizontally",
              )
            }
          >
            <Columns3 size={14} /> Space across
          </button>
          <button
            className="control"
            disabled={selection.length < 3}
            onClick={() =>
              applyBatch(
                distributeMotionLayers(
                  motion.layers,
                  selection,
                  "y",
                  Math.max(0, local) + clip.animationOffset,
                ),
                "Distribute motion layers vertically",
              )
            }
          >
            <Rows3 size={14} /> Space down
          </button>
        </div>
        <p className="hint">
          Aligns transformed layer boxes at the playhead and preserves their
          motion paths. Select three layers for equal gaps.
        </p>
        <details className="motion-batch-timing">
          <summary>
            Timing for {selection.length} selected{" "}
            {selection.length === 1 ? "layer" : "layers"}
          </summary>
          <div className="two-col">
            <label className="field">
              <span>Offset · frames</span>
              <input
                type="number"
                step={1}
                aria-label="Selected layer timing offset"
                value={timingOffset}
                onChange={(event) => setTimingOffset(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Stagger · frames</span>
              <input
                type="number"
                min={0}
                step={1}
                aria-label="Selected layer timing stagger"
                value={timingStagger}
                onChange={(event) => setTimingStagger(event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Stagger order</span>
            <select
              aria-label="Layer stagger order"
              value={timingOrder}
              onChange={(event) =>
                setTimingOrder(event.target.value as typeof timingOrder)
              }
            >
              <option value="top-first">Top layer first</option>
              <option value="bottom-first">Bottom layer first</option>
              <option value="left-first">Left to right</option>
            </select>
          </label>
          <div className="two-col">
            <button
              disabled={!timingOffset.trim()}
              onClick={() =>
                applyBatch(
                  shiftMotionLayerTiming(
                    motion.layers,
                    selection,
                    Number(timingOffset),
                  ),
                  "Shift selected layer timing",
                )
              }
            >
              Apply offset
            </button>
            <button
              disabled={
                selection.length < 2 ||
                !timingOffset.trim() ||
                !timingStagger.trim()
              }
              onClick={() =>
                applyBatch(
                  shiftMotionLayerTiming(
                    motion.layers,
                    orderedMotionLayers(
                      motion.layers,
                      selection,
                      timingOrder,
                      Math.max(0, local) + clip.animationOffset,
                    ),
                    Number(timingOffset),
                    Number(timingStagger),
                  ),
                  "Stagger selected layers",
                )
              }
            >
              Apply stagger
            </button>
          </div>
          <div className="motion-key-time">
            <label className="field">
              <span>Timing scale · %</span>
              <input
                type="number"
                min={10}
                max={1000}
                step={5}
                aria-label="Selected layer timing scale"
                value={timingScale}
                onChange={(event) => setTimingScale(event.target.value)}
              />
            </label>
            <button
              disabled={!timingScale.trim()}
              onClick={() =>
                applyBatch(
                  scaleMotionLayerTiming(
                    motion.layers,
                    selection,
                    Number(timingScale),
                  ),
                  "Retime selected layers",
                )
              }
            >
              Retime
            </button>
          </div>
          <p className="hint">
            50% is faster; 200% is slower. Retimes keys and masked line reveals
            from scene frame 0. Word and character spacing stays in Text reveal.
            Clip duration stays the same.
          </p>
        </details>
        {batchError && (
          <p role="alert" className="motion-batch-feedback error">
            {batchError}
          </p>
        )}
        {batchStatus && !batchError && (
          <p role="status" className="motion-batch-feedback">
            {batchStatus}
          </p>
        )}
      </details>
      {selection.length > 1 && (
        <p className="motion-focused-layer">
          Editing {layerName(layer)} below. Layout and timing affect all{" "}
          {selection.length} selected layers.
        </p>
      )}
      <label className="field">
        <span>Layer name</span>
        <input
          key={`${motion.id}:${index}:${layer.name ?? ""}`}
          aria-label="Layer name"
          defaultValue={layer.name ?? ""}
          maxLength={80}
          placeholder={
            layer.type === "text" ? "Text layer" : optionLabel(layer.type)
          }
          onBlur={(event) => {
            if (event.target.value === (layer.name ?? "")) return;
            const name = event.target.value.trim() || undefined;
            if (name !== layer.name) update({ name });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape")
              event.currentTarget.value = layer.name ?? "";
            if (event.key === "Enter" || event.key === "Escape")
              event.currentTarget.blur();
          }}
        />
      </label>
      <label className="field">
        <span>Layer type</span>
        <select
          aria-label="Layer type"
          value={layer.type}
          onChange={(e) =>
            update({
              type: e.target.value as Layer["type"],
              ...(e.target.value === "line" && !layer.strokeWidth
                ? { strokeWidth: 8 }
                : {}),
              ...(e.target.value === "path"
                ? {
                    vectorPath: layer.vectorPath ?? "M 10 90 L 50 10 L 90 90 Z",
                    vectorViewBox: layer.vectorViewBox ?? [0, 0, 100, 100],
                    strokeWidth: layer.strokeWidth || 2,
                  }
                : {}),
            })
          }
        >
          {shapes.map((s) => (
            <option key={s} value={s}>
              {optionLabel(s)}
            </option>
          ))}
        </select>
      </label>
      {layer.type === "path" && (
        <>
          <VectorEditor
            key={`${motion.id}:${index}`}
            draftKey={`${motion.id}:${index}`}
            layer={layer}
            onApply={(patch) => {
              put(
                motion.layers.map((item, i) =>
                  i === index ? { ...item, ...patch } : item,
                ),
                "Edit vector path",
              );
            }}
            onDraftChange={setVectorDirty}
          />
          <details className="motion-logo-reveal">
            <summary>Logo reveal</summary>
            <label className="field">
              <span>Reveal style</span>
              <select
                aria-label="Logo reveal style"
                value={logoStyle}
                onChange={(event) => {
                  setLogoStyle(event.target.value as typeof logoStyle);
                  setLogoError("");
                }}
              >
                <option value="draw">Draw</option>
                <option value="orbit">Orbit</option>
                <option value="signal">Signal</option>
              </select>
            </label>
            <button
              className="full"
              disabled={vectorDirty}
              onClick={() => {
                try {
                  const commands = createLogoRevealCommands(
                    project,
                    clip.id,
                    logoStyle,
                  );
                  edit("Apply logo reveal", commands);
                  setLogoError("");
                } catch (cause) {
                  setLogoError(
                    cause instanceof Error
                      ? cause.message
                      : "Check the logo paths.",
                  );
                }
              }}
            >
              Apply logo reveal
            </button>
            {vectorDirty && (
              <p className="hint">
                Apply or cancel the path draft before adding a reveal.
              </p>
            )}
            {logoError && (
              <p role="alert" className="hint">
                {logoError}
              </p>
            )}
          </details>
        </>
      )}
      {layer.type === "text" && (
        <>
          <label className="field">
            <span>Layer text</span>
            <textarea
              key={layer.text}
              aria-label="Layer text"
              defaultValue={layer.text}
              placeholder="Use clip text"
              onBlur={(e) => {
                if (e.target.value !== layer.text)
                  update({ text: e.target.value });
              }}
            />
          </label>
          {number("Layer font size", "fontSize", layer.fontSize, 8, 500)}
          <details className="motion-typography">
            <summary>Typography</summary>
            <label className="field">
              <span>Layer font weight</span>
              <select
                aria-label="Layer font weight"
                value={layer.fontWeight ?? "inherit"}
                onChange={(e) =>
                  update({
                    fontWeight:
                      e.target.value === "inherit"
                        ? undefined
                        : Number(e.target.value),
                  })
                }
              >
                <option value="inherit">
                  Use clip weight · {clip.fontWeight}
                </option>
                {Array.from({ length: 9 }, (_, i) => (i + 1) * 100).map(
                  (weight) => (
                    <option key={weight} value={weight}>
                      {weight}
                      {weight === 400
                        ? " · Regular"
                        : weight === 700
                          ? " · Bold"
                          : weight === 900
                            ? " · Black"
                            : ""}
                    </option>
                  ),
                )}
                {layer.fontWeight !== undefined &&
                  layer.fontWeight % 100 !== 0 && (
                    <option value={layer.fontWeight}>
                      {layer.fontWeight} · Custom
                    </option>
                  )}
              </select>
            </label>
            <label className="field">
              <span>Layer text alignment</span>
              <select
                aria-label="Layer text alignment"
                value={layer.align ?? "inherit"}
                onChange={(e) =>
                  update({
                    align:
                      e.target.value === "inherit"
                        ? undefined
                        : (e.target.value as Layer["align"]),
                  })
                }
              >
                <option value="inherit">
                  Use clip alignment · {clip.align}
                </option>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
            <div className="two-col">
              {number(
                "Layer letter spacing",
                "letterSpacing",
                layer.letterSpacing,
                -30,
                100,
                0.1,
              )}
              {number(
                "Layer line height",
                "lineHeight",
                layer.lineHeight,
                0.8,
                2.4,
                0.05,
              )}
            </div>
          </details>
          <label className="field">
            <span>Text reveal</span>
            <select
              aria-label="Text reveal"
              value={layer.textAnimation}
              onChange={(e) =>
                update({
                  textAnimation: e.target.value as Layer["textAnimation"],
                })
              }
            >
              <option value="none">Whole text</option>
              <option value="character-rise">Stagger characters</option>
              <option value="word-rise">Stagger words</option>
              <option value="typewriter">Typewriter</option>
              <option value="line-reveal">Reveal lines</option>
            </select>
          </label>
          {layer.textAnimation !== "none" &&
            number(
              "Stagger (frames)",
              "staggerFrames",
              layer.staggerFrames,
              1,
              30,
            )}
          {layer.textAnimation === "line-reveal" && (
            <div className="two-col">
              {number(
                "Line reveal start (frames)",
                "textRevealStart",
                layer.textRevealStart,
                0,
                18000,
              )}
              {number(
                "Line reveal duration (frames)",
                "textRevealFrames",
                layer.textRevealFrames,
                1,
                1800,
              )}
            </div>
          )}
          {layer.textAnimation === "line-reveal" && (
            <p className="hint">Each new line in the text reveals in turn.</p>
          )}
        </>
      )}
      <details open>
        <summary>Fill & outline</summary>
        {number("Fill opacity", "fillOpacity", layer.fillOpacity, 0, 1, 0.05)}
        <div className="two-col">
          {colorField(
            layer.type === "text" ? "Text color" : "Layer fill",
            layer.type === "text" ? layer.color : layer.background,
            layer.type === "text" ? "color" : "background",
          )}
          {colorField("Layer stroke", layer.stroke, "stroke")}
          {number(
            "Layer stroke width",
            "strokeWidth",
            layer.strokeWidth,
            0,
            100,
          )}
        </div>
        {layer.type !== "text" && (
          <label className="checkbox">
            <input
              aria-label="No shape fill"
              type="checkbox"
              checked={layer.background === "transparent"}
              onChange={(e) =>
                update({
                  background: e.target.checked ? "transparent" : clip.accent,
                })
              }
            />
            No fill
          </label>
        )}
        <label className="field">
          <span>Fill style</span>
          <select
            aria-label="Fill style"
            value={layer.fillStyle}
            onChange={(e) =>
              update({ fillStyle: e.target.value as Layer["fillStyle"] })
            }
          >
            <option value="solid">Solid</option>
            <option value="gradient">Gradient</option>
          </select>
        </label>
        {layer.fillStyle === "gradient" && (
          <div className="two-col">
            {colorField("Gradient color", layer.gradientColor, "gradientColor")}
            {number(
              "Gradient angle",
              "gradientAngle",
              layer.gradientAngle,
              -360,
              360,
            )}
          </div>
        )}
        {layer.type !== "text" && (
          <>
            <label className="field">
              <span>Music response</span>
              <select
                aria-label="Music response"
                value={
                  layer.musicAccent === undefined
                    ? "auto"
                    : layer.musicAccent
                      ? "accent"
                      : "steady"
                }
                onChange={(e) =>
                  update({
                    musicAccent:
                      e.target.value === "auto"
                        ? undefined
                        : e.target.value === "accent",
                  })
                }
              >
                <option value="auto">Auto</option>
                <option value="accent">Graphical accent</option>
                <option value="steady">Steady</option>
              </select>
            </label>
            <p className="hint">Auto keeps full-canvas panels steady.</p>
          </>
        )}
      </details>
      <details>
        <summary>Transform & effects</summary>
        <div className="two-col">
          <button onClick={() => update({ x: (clip.width - layer.width) / 2 })}>
            Center horizontally
          </button>
          <button
            onClick={() => update({ y: (clip.height - layer.height) / 2 })}
          >
            Center vertically
          </button>
        </div>
        <div className="two-col">
          {number("Layer X", "x", layer.x, -4000, 4000)}
          {number("Layer Y", "y", layer.y, -4000, 4000)}
          {number("Layer width", "width", layer.width, 1, 4000)}
          {number("Layer height", "height", layer.height, 1, 4000)}
          {number("Layer scale", "scale", layer.scale, 0, 10, 0.05)}
          {number("Layer rotation", "rotate", layer.rotate, -3600, 3600)}
          {number("Layer opacity", "opacity", layer.opacity, 0, 1, 0.05)}
          {number("Roundness", "radius", layer.radius, 0, 2000)}
          {number("Anchor X", "anchorX", layer.anchorX, 0, 1, 0.05)}
          {number("Anchor Y", "anchorY", layer.anchorY, 0, 1, 0.05)}
          {number("Layer glow", "glow", layer.glow, 0, 100)}
          {number("Layer blur", "blur", layer.blur, 0, 100)}
          {layer.type !== "text" &&
            number("Stroke reveal", "trim", layer.trim, 0, 1, 0.05)}
        </div>
        <p className="hint">
          Animated values override these. Move X and Y keys are offsets.
        </p>
      </details>
      <details open className="motion-curves">
        <summary>Animate layer</summary>
        <label className="field">
          <span>Layer animated property</span>
          <select
            aria-label="Layer animated property"
            value={property}
            onChange={(e) => setProperty(e.target.value as Property)}
          >
            {motionProperties.map((p) => (
              <option key={p} value={p}>
                {names[p]}
              </option>
            ))}
          </select>
        </label>
        <div className="motion-curve">
          <svg
            viewBox="0 0 256 88"
            role="img"
            aria-label={`${names[property]} animation curve`}
          >
            <path className="curve-axis" d="M8 16V72H248" />
            <path className="curve-line" d={path} />
            <line
              className="curve-playhead"
              x1={8 + Math.min(1, Math.max(0, graphFrame / graphEnd)) * 240}
              x2={8 + Math.min(1, Math.max(0, graphFrame / graphEnd)) * 240}
              y1="8"
              y2="80"
            />
          </svg>
          <span>
            Range {low.toFixed(2)} → {high.toFixed(2)}
          </span>
          <output
            aria-label="Layer evaluated value"
            data-value={evaluatedValue}
          >
            At playhead · {evaluatedValue.toFixed(3)}
          </output>
        </div>
        <label className="field">
          <span>
            Scene frame {Math.max(0, local)} / {clip.duration - 1}
          </span>
          <input
            aria-label="Motion playhead"
            type="range"
            min={0}
            max={clip.duration - 1}
            step={1}
            value={Math.min(clip.duration - 1, Math.max(0, local))}
            onChange={(e) => {
              setKeyTarget(undefined);
              setKeyError("");
              seek(clip.start + Number(e.target.value));
            }}
          />
        </label>
        <div className="two-col">
          <button
            disabled={!inside || !canKey}
            onClick={() => setKey(keyValue)}
          >
            <Diamond size={12} />
            {key ? "Update layer keyframe" : "Add layer keyframe"}
          </button>
          <button disabled={!key || !inside} onClick={removeKey}>
            Remove layer keyframe
          </button>
        </div>
        {inside && (
          <NumberField
            label="Layer keyframe value"
            value={keyValue}
            min={min}
            max={max}
            step={
              property === "x" || property === "y" || property === "rotate"
                ? 1
                : 0.05
            }
            disabled={!canKey}
            onChange={(n) => setKey(n)}
          />
        )}
        {key && (
          <>
            <div className="motion-key-time">
              <label className="field">
                <span>Keyframe frame</span>
                <input
                  aria-label="Keyframe frame"
                  type="number"
                  min={0}
                  max={moveMax}
                  step={1}
                  value={moveFrame}
                  onChange={(event) => {
                    setMoveFrame(event.target.value);
                    setKeyError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      moveKey();
                    }
                  }}
                />
              </label>
              <button onClick={moveKey}>Move keyframe</button>
            </div>
            {layer.loop === "none" &&
              (at < clip.animationOffset ||
                at >= clip.animationOffset + clip.duration) && (
                <p className="hint">
                  This key is outside the clip. Move it to a frame inside it.
                </p>
              )}
            <label className="field">
              <span>Layer easing</span>
              <select
                aria-label="Layer easing"
                value={key.easing}
                onChange={(e) =>
                  setKey(keyValue, e.target.value as typeof key.easing)
                }
              >
                {motionEasings.map((e) => (
                  <option key={e} value={e}>
                    {easingLabel(e)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {key?.easing === "cubic-bezier" && (
          <div className="motion-bezier">
            <label className="field">
              <span>Curve preset</span>
              <select
                aria-label="Curve preset"
                value={curvePreset}
                onChange={(e) => {
                  const preset = curvePresets.find(
                    (preset) => preset.id === e.target.value,
                  );
                  if (preset) setKey(keyValue, "cubic-bezier", preset.bezier);
                }}
              >
                <option value="custom">Custom curve</option>
                {curvePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="motion-bezier-graph">
              <svg
                ref={bezierSvg}
                viewBox="0 0 256 112"
                role="img"
                aria-label="Cubic Bezier easing curve"
              >
                <title>
                  Time moves left to right. Progress moves bottom to top. Drag a
                  handle or use its arrow keys. Shift makes larger steps.
                </title>
                <path
                  className="curve-axis"
                  d={`M18 ${bezierY(1)}V${bezierY(0)}H238`}
                />
                <path
                  className="bezier-handles"
                  d={`M18 ${bezierY(0)}L${bezierX(bezier[0])} ${bezierY(bezier[1])}M238 ${bezierY(1)}L${bezierX(bezier[2])} ${bezierY(bezier[3])}`}
                />
                <path
                  className="curve-line"
                  d={`M18 ${bezierY(0)}C${bezierX(bezier[0])} ${bezierY(bezier[1])} ${bezierX(bezier[2])} ${bezierY(bezier[3])} 238 ${bezierY(1)}`}
                />
                <circle
                  className="bezier-point"
                  cx={bezierX(bezier[0])}
                  cy={bezierY(bezier[1])}
                  r="3"
                />
                <circle
                  className="bezier-point"
                  cx={bezierX(bezier[2])}
                  cy={bezierY(bezier[3])}
                  r="3"
                />
                <text x="18" y="109">
                  0
                </text>
                <text x="232" y="109">
                  1
                </text>
              </svg>
              {([0, 1] as const).map((handle) => (
                <button
                  key={handle}
                  className="motion-bezier-handle"
                  aria-label={`Bezier handle ${handle + 1}`}
                  aria-description={`X ${bezier[handle * 2]}, Y ${bezier[handle * 2 + 1]}. Drag to adjust time and progress. Arrow keys adjust by 0.01; Shift adjusts by 0.1. Escape cancels a drag.`}
                  title={`X ${bezier[handle * 2]} · Y ${bezier[handle * 2 + 1]}`}
                  disabled={!canKey}
                  style={{
                    left: `${(bezierX(bezier[handle * 2]) / 256) * 100}%`,
                    top: `${(bezierY(bezier[handle * 2 + 1]) / 112) * 100}%`,
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    bezierDrag.current = {
                      pointerId: event.pointerId,
                      target: event.currentTarget,
                      handle,
                      points: [...bezier] as MotionBezier,
                      low: bezierLow,
                      high: bezierHigh,
                    };
                    setBezierDraft([...bezier] as MotionBezier);
                  }}
                  onPointerMove={updateDrag}
                  onPointerUp={(event) => {
                    const drag = bezierDrag.current;
                    if (!drag || drag.pointerId !== event.pointerId) return;
                    updateDrag(event);
                    const points = drag.points;
                    bezierDrag.current = undefined;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    // A changed curve stays drawn until its edit lands and the
                    // layers update, instead of snapping back for a moment.
                    if (
                      points.some(
                        (value, i) =>
                          value !== (key.bezier ?? defaultMotionBezier)[i],
                      )
                    )
                      setKey(keyValue, "cubic-bezier", points);
                    else setBezierDraft(undefined);
                  }}
                  onPointerCancel={() => {
                    bezierDrag.current = undefined;
                    setBezierDraft(undefined);
                  }}
                  onLostPointerCapture={() => {
                    // Capture also ends after a normal release, which keeps
                    // its draft; only an interrupted drag drops it.
                    if (!bezierDrag.current) return;
                    bezierDrag.current = undefined;
                    setBezierDraft(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      const drag = bezierDrag.current;
                      bezierDrag.current = undefined;
                      bezierKeys.current = undefined;
                      if (drag?.target.hasPointerCapture(drag.pointerId))
                        drag.target.releasePointerCapture(drag.pointerId);
                      setBezierDraft(undefined);
                      event.preventDefault();
                      event.stopPropagation();
                      return;
                    }
                    const horizontal =
                      event.key === "ArrowLeft" || event.key === "ArrowRight";
                    const vertical =
                      event.key === "ArrowUp" || event.key === "ArrowDown";
                    if (!horizontal && !vertical) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const coordinate = handle * 2 + (vertical ? 1 : 0);
                    const direction =
                      event.key === "ArrowRight" || event.key === "ArrowUp"
                        ? 1
                        : -1;
                    const from = bezierKeys.current ?? bezier;
                    const points = [...from] as MotionBezier;
                    points[coordinate] = clampPoint(
                      points[coordinate] +
                        direction * (event.shiftKey ? 0.1 : 0.01),
                      coordinate,
                    );
                    if (points[coordinate] === from[coordinate]) return;
                    // Holding an arrow moves the handle; one edit lands on release.
                    bezierKeys.current = points;
                    setBezierDraft(points);
                  }}
                  onKeyUp={(event) => {
                    if (!event.key.startsWith("Arrow")) return;
                    const points = bezierKeys.current;
                    bezierKeys.current = undefined;
                    if (points) setKey(keyValue, "cubic-bezier", points);
                  }}
                  onBlur={() => {
                    const points = bezierKeys.current;
                    bezierKeys.current = undefined;
                    if (points) setKey(keyValue, "cubic-bezier", points);
                  }}
                />
              ))}
            </div>
            <div className="two-col">
              {bezier.map((value, i) => (
                <NumberField
                  key={i}
                  label={`Bezier ${["X1", "Y1", "X2", "Y2"][i]}`}
                  value={value}
                  min={i % 2 === 0 ? 0 : -2}
                  max={i % 2 === 0 ? 1 : 3}
                  step={0.01}
                  onChange={(next) => {
                    const points = [...bezier] as MotionBezier;
                    points[i] = next;
                    setKey(keyValue, "cubic-bezier", points);
                  }}
                />
              ))}
            </div>
          </div>
        )}
        <div className="keyframe-list">
          {keyframes.map((k, i) => (
            <button
              key={i}
              onClick={() => {
                setKeyTarget(k.frame);
                // Show the key's frame right away instead of after the
                // effect that follows `at`, so the field is never stale.
                const relative =
                  layer.loop === "none"
                    ? k.frame - clip.animationOffset
                    : k.frame;
                setMoveFrame(String(Math.max(0, Math.min(moveMax, relative))));
                setKeyError("");
                seek(motionKeySeekFrame(layer, clip, k.frame, frame));
              }}
            >
              ◆ {k.frame} · {Math.round(k[property]! * 100) / 100} ·{" "}
              {easingLabel(k.easing)}
            </button>
          ))}
        </div>
        {keyTarget !== undefined && (
          <p className="hint">
            Editing curve key {keyTarget}.{" "}
            <button className="subtle" onClick={() => setKeyTarget(undefined)}>
              Use playhead
            </button>
          </p>
        )}
        {keyError && (
          <p role="status" className="hint">
            {keyError}
          </p>
        )}
        {!!keyframes.length && (
          <button
            className="full subtle"
            onClick={() =>
              update({
                keyframes: layer.keyframes
                  .map((k) => {
                    const next = { ...k };
                    delete next[property];
                    return next;
                  })
                  .filter((k) =>
                    motionProperties.some((p) => k[p] !== undefined),
                  ),
              })
            }
          >
            Clear layer {names[property].toLowerCase()} animation
          </button>
        )}
        <div className="two-col">
          <label className="field">
            <span>Layer loop</span>
            <select
              aria-label="Layer loop"
              value={layer.loop}
              onChange={(e) =>
                update({ loop: e.target.value as Layer["loop"] })
              }
            >
              <option value="none">Play once</option>
              <option value="cycle">Repeat</option>
              <option value="ping-pong">Ping-pong</option>
            </select>
          </label>
          {layer.loop !== "none" &&
            number("Loop (frames)", "loopFrames", layer.loopFrames, 1, 1800)}
        </div>
      </details>
      <details>
        <summary>Add a layer</summary>
        <div className="motion-add-layer">
          {shapes.map((type) => (
            <button
              className="control"
              key={type}
              disabled={motion.layers.length >= MAX_VECTOR_LAYERS}
              onClick={() => {
                const width = Math.min(
                  4000,
                  type === "text" ? clip.width * 0.7 : clip.width * 0.25,
                );
                const height = Math.min(
                  4000,
                  type === "text"
                    ? clip.height * 0.2
                    : type === "line"
                      ? 8
                      : width,
                );
                put(
                  [
                    ...motion.layers,
                    MotionLayerSchema.parse({
                      type,
                      x: (clip.width - width) / 2,
                      y: (clip.height - height) / 2,
                      width,
                      height,
                      background:
                        type === "text" || type === "line"
                          ? "transparent"
                          : clip.accent,
                      strokeWidth: type === "line" ? 8 : 0,
                      ...(type === "path"
                        ? {
                            vectorPath: "M 10 90 L 50 10 L 90 90 Z",
                            vectorViewBox: [0, 0, 100, 100],
                            strokeWidth: 2,
                          }
                        : {}),
                      keyframes: [
                        { frame: 0, opacity: 0 },
                        { frame: Math.min(18, clip.duration - 1), opacity: 1 },
                      ],
                    }),
                  ],
                  "Add motion layer",
                );
                selectOnly(motion.layers.length);
              }}
            >
              <Plus size={12} />
              {type === "ellipse" ? "Circle" : optionLabel(type)}
            </button>
          ))}
        </div>
      </details>
    </details>
  );
}
