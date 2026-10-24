import React, { useEffect, useRef, useState } from "react";
import { Plus, Trash2, MousePointer2, PenLine } from "lucide-react";
import { MotionLayerSchema, type MotionLayer } from "../shared/model";
import {
  MAX_VECTOR_PATH_LENGTH,
  pointsToVectorPath,
  parseVectorPath,
  vectorPathToPoints,
  validateVectorPath,
  type PenPoint,
} from "../shared/vector-path";
import { NumberField } from "./Inspector";
import "./vector-editor.css";

type Point = { x: number; y: number };
type Draft = {
  path: string;
  box: [string, string, string, string];
  fillRule: "nonzero" | "evenodd";
};
const fromLayer = (layer: MotionLayer): Draft => ({
  path: layer.vectorPath ?? "",
  box: (layer.vectorViewBox ?? [0, 0, 100, 100]).map(String) as Draft["box"],
  fillRule: layer.vectorFillRule ?? "nonzero",
});
const round = (n: number) => Math.round(n * 100) / 100;
const signature = (layer: MotionLayer) => JSON.stringify(fromLayer(layer));

// Unapplied path drafts outlive the editor, so clicking the preview or
// pressing Escape (which deselects the clip and closes Properties) does not
// throw away a path in progress. A draft is only restored onto the exact path
// it was drawn from.
const savedDrafts = new Map<string, { base: string; draft: Draft }>();
export function rememberVectorDraft(
  key: string,
  layer: MotionLayer,
  draft: Draft,
) {
  savedDrafts.set(key, { base: signature(layer), draft });
}
export function restoreVectorDraft(key: string, layer: MotionLayer) {
  const saved = savedDrafts.get(key);
  if (saved && saved.base === signature(layer)) return saved.draft;
  savedDrafts.delete(key);
  return undefined;
}
export function forgetVectorDraft(key: string) {
  savedDrafts.delete(key);
}

export function VectorEditor({
  layer,
  draftKey,
  onApply,
  onDraftChange,
}: {
  layer: MotionLayer;
  /** Where an unapplied draft for this layer is kept between selections. */
  draftKey?: string;
  onApply: (
    patch: Pick<MotionLayer, "vectorPath" | "vectorViewBox" | "vectorFillRule">,
  ) => void;
  onDraftChange?: (changed: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(
    () => (draftKey && restoreVectorDraft(draftKey, layer)) || fromLayer(layer),
  );
  const [selected, setSelected] = useState(0);
  const [tool, setTool] = useState<"select" | "add">("select");
  const [notice, setNotice] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const gesture = useRef<
    | {
        pointerId: number;
        target: SVGCircleElement;
        index: number;
        kind: "point" | "in" | "out";
        origin: Point;
        points: PenPoint[];
        closed: boolean;
        path: string;
      }
    | undefined
  >(undefined);
  const releaseGesture = () => {
    const current = gesture.current;
    gesture.current = undefined;
    if (current?.target.hasPointerCapture(current.pointerId))
      current.target.releasePointerCapture(current.pointerId);
  };
  const layerSignature = signature(layer);
  const seenLayer = useRef(layerSignature);
  useEffect(() => {
    // Only a change to the stored path resets the draft, not the first render.
    if (seenLayer.current === layerSignature) return;
    seenLayer.current = layerSignature;
    releaseGesture();
    setDraft(fromLayer(layer));
    setSelected(0);
    setTool("select");
    setNotice("");
  }, [layerSignature]);
  useEffect(() => () => releaseGesture(), []);

  const box = draft.box.map(Number) as [number, number, number, number];
  let error = "";
  try {
    if (
      draft.box.some((value) => !value.trim()) ||
      !box.every(Number.isFinite) ||
      box[2] <= 0 ||
      box[3] <= 0
    )
      throw Error("ViewBox width and height must be positive numbers.");
    validateVectorPath(draft.path);
    MotionLayerSchema.parse({
      ...layer,
      type: "path",
      vectorPath: draft.path,
      vectorViewBox: box,
      vectorFillRule: draft.fillRule,
    });
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message.startsWith("[")
          ? "Check the path coordinates and viewBox dimensions."
          : cause.message
        : "Check the SVG path data.";
  }
  const safeBox =
    box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
      ? box
      : ([0, 0, 100, 100] as const);
  const matrix = layer.vectorTransform ?? [1, 0, 0, 1, 0, 0];
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  let editable: { points: PenPoint[]; closed: boolean } | null = null;
  try {
    editable = draft.path.trim()
      ? vectorPathToPoints(draft.path)
      : { points: [], closed: false };
    if (!editable) {
      const segments = parseVectorPath(draft.path);
      if (segments.length === 1 && segments[0].command.toUpperCase() === "M")
        editable = {
          points: [{ x: segments[0].values[0], y: segments[0].values[1] }],
          closed: false,
        };
    }
  } catch {
    // The validation message below explains incomplete path data.
  }
  const nodeMode = editable !== null && Math.abs(determinant) > 1e-10;
  useEffect(() => {
    if (!nodeMode) setAdvancedOpen(true);
  }, [nodeMode]);
  const points = editable?.points ?? [];
  const closed = editable?.closed ?? false;
  if (editable?.points.length === 1)
    error = "Add a second point before applying.";
  const index = Math.min(selected, points.length - 1);
  const node = points[index];
  const changed = JSON.stringify(draft) !== layerSignature;
  useEffect(() => {
    onDraftChange?.(changed);
  }, [changed, onDraftChange]);
  useEffect(() => {
    if (!draftKey) return;
    if (changed) rememberVectorDraft(draftKey, layer, draft);
    else forgetVectorDraft(draftKey);
  }, [draftKey, changed, draft, layerSignature]);
  useEffect(() => () => onDraftChange?.(false), [onDraftChange]);
  const scale = Math.min(safeBox[2], safeBox[3]);
  const step = Math.max(0.1, scale / 100);
  const pointRadius = Math.max(safeBox[2], safeBox[3]) / 85;
  const hitRadius = Math.max(safeBox[2], safeBox[3]) / 22;
  const writePoints = (next: PenPoint[], nextClosed = closed) => {
    try {
      const path =
        next.length > 1
          ? pointsToVectorPath(next, { closed: nextClosed })
          : next.length
            ? `M ${next[0].x} ${next[0].y}`
            : "";
      setDraft((current) => ({ ...current, path }));
      setNotice("");
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "Check the point coordinates.",
      );
    }
  };
  const sourcePoint = (clientX: number, clientY: number): Point | undefined => {
    const screen = svg.current?.getScreenCTM();
    if (!screen || Math.abs(determinant) <= 1e-10) return;
    const p = new DOMPoint(clientX, clientY).matrixTransform(screen.inverse());
    const x = p.x - matrix[4],
      y = p.y - matrix[5];
    return {
      x: round((matrix[3] * x - matrix[2] * y) / determinant),
      y: round((-matrix[1] * x + matrix[0] * y) / determinant),
    };
  };
  const shifted = (point: PenPoint, dx: number, dy: number): PenPoint => ({
    x: round(point.x + dx),
    y: round(point.y + dy),
    ...(point.in
      ? { in: { x: round(point.in.x + dx), y: round(point.in.y + dy) } }
      : {}),
    ...(point.out
      ? { out: { x: round(point.out.x + dx), y: round(point.out.y + dy) } }
      : {}),
  });
  const changeNode = (next: PenPoint) =>
    writePoints(points.map((point, i) => (i === index ? next : point)));
  const startDrag = (
    event: React.PointerEvent<SVGCircleElement>,
    i: number,
    kind: "point" | "in" | "out",
  ) => {
    if (event.button !== 0 || !nodeMode) return;
    const origin = sourcePoint(event.clientX, event.clientY);
    if (!origin) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(i);
    gesture.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      index: i,
      kind,
      origin,
      points: structuredClone(points),
      closed,
      path: draft.path,
    };
  };
  const drag = (event: React.PointerEvent<SVGCircleElement>) => {
    const current = gesture.current;
    const at = sourcePoint(event.clientX, event.clientY);
    if (!current || current.pointerId !== event.pointerId || !at) return;
    const dx = at.x - current.origin.x,
      dy = at.y - current.origin.y;
    const original = current.points[current.index];
    const next = structuredClone(current.points);
    if (current.kind === "point")
      next[current.index] = shifted(original, dx, dy);
    else {
      const handle = original[current.kind]!;
      next[current.index][current.kind] = {
        x: round(handle.x + dx),
        y: round(handle.y + dy),
      };
    }
    writePoints(next, current.closed);
  };
  const keyMove = (
    event: React.KeyboardEvent<SVGCircleElement>,
    i: number,
    kind: "point" | "in" | "out",
  ) => {
    if (event.key === "Escape" && gesture.current) {
      const path = gesture.current.path;
      releaseGesture();
      setDraft((current) => ({ ...current, path }));
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Delete removes the focused point, never the clip.
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      if (kind !== "point" || points.length <= 2) return;
      releaseGesture();
      writePoints(points.filter((_, j) => j !== i));
      setSelected(Math.max(0, i - 1));
      return;
    }
    const direction: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const delta = direction[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const amount = step * (event.shiftKey ? 10 : 1);
    const next = structuredClone(points);
    if (kind === "point")
      next[i] = shifted(next[i], delta.x * amount, delta.y * amount);
    else {
      const handle = next[i][kind]!;
      next[i][kind] = {
        x: round(handle.x + delta.x * amount),
        y: round(handle.y + delta.y * amount),
      };
    }
    setSelected(i);
    writePoints(next);
  };
  const pointControl = (
    point: Point,
    i: number,
    kind: "point" | "in" | "out",
  ) => (
    <React.Fragment key={`${i}:${kind}`}>
      <circle
        className="vector-node-hit"
        data-vector-node={kind === "point" ? i : undefined}
        cx={point.x}
        cy={point.y}
        r={hitRadius}
        fill="transparent"
        role="button"
        tabIndex={0}
        aria-label={
          kind === "point"
            ? `Path node ${i + 1}`
            : `${kind === "in" ? "Incoming" : "Outgoing"} path handle`
        }
        aria-description={`X ${point.x}, Y ${point.y}. Drag or use arrow keys; Shift moves farther.`}
        onClick={(event) => {
          event.stopPropagation();
          setSelected(i);
        }}
        onFocus={() => setSelected(i)}
        onPointerDown={(event) => startDrag(event, i, kind)}
        onPointerMove={drag}
        onPointerUp={(event) => {
          drag(event);
          releaseGesture();
        }}
        onPointerCancel={() => {
          const path = gesture.current?.path;
          releaseGesture();
          if (path !== undefined) setDraft((current) => ({ ...current, path }));
        }}
        onLostPointerCapture={() => {
          gesture.current = undefined;
        }}
        onKeyDown={(event) => keyMove(event, i, kind)}
      />
      <circle
        className={`vector-node ${i === index && kind === "point" ? "selected" : ""} ${kind !== "point" ? "handle" : ""}`}
        cx={point.x}
        cy={point.y}
        r={pointRadius}
        pointerEvents="none"
      />
    </React.Fragment>
  );

  return (
    <details open className="vector-editor">
      <summary>Path designer</summary>
      {nodeMode && (
        <div
          className="vector-tools"
          role="group"
          aria-label="Path drawing tools"
        >
          <button
            aria-pressed={tool === "select"}
            onClick={() => setTool("select")}
          >
            <MousePointer2 size={13} /> Select
          </button>
          <button aria-pressed={tool === "add"} onClick={() => setTool("add")}>
            <Plus size={13} /> Add points
          </button>
          <button
            onClick={() => {
              releaseGesture();
              setDraft((current) => ({ ...current, path: "" }));
              setSelected(0);
              setTool("add");
            }}
          >
            <PenLine size={13} /> New path
          </button>
        </div>
      )}
      <svg
        className={`vector-drawing ${tool === "add" && nodeMode ? "adding" : ""}`}
        ref={svg}
        viewBox={safeBox.join(" ")}
        preserveAspectRatio={
          layer.vectorAspectRatio === "none" ? "none" : "xMidYMid meet"
        }
        role="group"
        aria-label="Vector path point editor"
        onPointerDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            tool !== "add" ||
            !nodeMode ||
            event.button !== 0
          )
            return;
          event.preventDefault();
          const point = sourcePoint(event.clientX, event.clientY);
          if (point) {
            writePoints([...points, point], closed);
            setSelected(points.length);
          }
        }}
      >
        <g transform={`matrix(${matrix.join(" ")})`}>
          {!error && (
            <path
              d={draft.path}
              fill={layer.background}
              fillRule={draft.fillRule}
              fillOpacity={layer.fillOpacity}
              stroke={layer.strokeWidth > 0 ? layer.stroke : "#8f9bb3"}
              strokeWidth={
                layer.strokeWidth > 0 ? layer.strokeWidth : scale / 180
              }
              strokeLinecap={layer.vectorLineCap}
              strokeLinejoin={layer.vectorLineJoin}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
          {nodeMode &&
            node &&
            (["in", "out"] as const).map((kind) =>
              node[kind] ? (
                <line
                  key={kind}
                  className="vector-handle-line"
                  x1={node.x}
                  y1={node.y}
                  x2={node[kind].x}
                  y2={node[kind].y}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}
          {nodeMode &&
            points.map((point, i) => pointControl(point, i, "point"))}
          {nodeMode &&
            node &&
            (["in", "out"] as const).map((kind) =>
              node[kind] ? pointControl(node[kind], index, kind) : null,
            )}
        </g>
      </svg>
      {!nodeMode && (
        <p className="hint">
          {Math.abs(determinant) <= 1e-10
            ? "This path has a flat transform. Edit its SVG data below."
            : "Edit this complex path using its SVG data below."}
        </p>
      )}
      {nodeMode && (
        <>
          <label className="checkbox">
            <input
              aria-label="Close path"
              type="checkbox"
              checked={closed}
              disabled={points.length < 2}
              onChange={(event) => writePoints(points, event.target.checked)}
            />
            Close path
          </label>
          {node && (
            <details open className="vector-node-fields">
              <summary>
                Point {index + 1} · {points.length} points
              </summary>
              <div className="two-col">
                <NumberField
                  label="Node X"
                  value={node.x}
                  step={step}
                  onChange={(x) => changeNode(shifted(node, x - node.x, 0))}
                />
                <NumberField
                  label="Node Y"
                  value={node.y}
                  step={step}
                  onChange={(y) => changeNode(shifted(node, 0, y - node.y))}
                />
              </div>
              <label className="field">
                <span>Point style</span>
                <select
                  aria-label="Point style"
                  value={node.in || node.out ? "bezier" : "straight"}
                  onChange={(event) => {
                    if (event.target.value === "straight") {
                      const next = { ...node };
                      delete next.in;
                      delete next.out;
                      changeNode(next);
                    } else {
                      const distance = scale / 8;
                      changeNode({
                        ...node,
                        in: { x: round(node.x - distance), y: node.y },
                        out: { x: round(node.x + distance), y: node.y },
                      });
                    }
                  }}
                >
                  <option value="straight">Straight</option>
                  <option value="bezier">Bezier handles</option>
                </select>
              </label>
              {(node.in || node.out) && (
                <details>
                  <summary>Handle coordinates</summary>
                  {(["in", "out"] as const).map((kind) => {
                    const handle = node[kind];
                    return handle ? (
                      <div className="two-col" key={kind}>
                        {(["x", "y"] as const).map((coordinate) => (
                          <NumberField
                            key={coordinate}
                            label={`${kind === "in" ? "Incoming" : "Outgoing"} ${coordinate.toUpperCase()}`}
                            value={handle[coordinate]}
                            step={step}
                            onChange={(value) =>
                              changeNode({
                                ...node,
                                [kind]: { ...handle, [coordinate]: value },
                              })
                            }
                          />
                        ))}
                      </div>
                    ) : null;
                  })}
                </details>
              )}
              <button
                className="subtle"
                disabled={points.length <= 2}
                onClick={() => {
                  writePoints(points.filter((_, i) => i !== index));
                  setSelected(Math.max(0, index - 1));
                }}
              >
                <Trash2 size={13} /> Remove point
              </button>
            </details>
          )}
        </>
      )}
      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        className="vector-data"
      >
        <summary>SVG path data</summary>
        <label className="field">
          <span>Path data · d</span>
          <textarea
            aria-label="SVG path data"
            value={draft.path}
            maxLength={MAX_VECTOR_PATH_LENGTH}
            spellCheck={false}
            onChange={(event) => {
              releaseGesture();
              setDraft((current) => ({ ...current, path: event.target.value }));
              setNotice("");
            }}
          />
        </label>
        <div className="two-col">
          {(["X", "Y", "width", "height"] as const).map((name, i) => (
            <label className="field" key={name}>
              <span>ViewBox {name}</span>
              <input
                type="number"
                aria-label={`Path viewBox ${name}`}
                min={i >= 2 ? 0.001 : undefined}
                value={draft.box[i]}
                onChange={(event) => {
                  const next = [...draft.box] as Draft["box"];
                  next[i] = event.target.value;
                  setDraft((current) => ({ ...current, box: next }));
                }}
              />
            </label>
          ))}
        </div>
        <label className="field">
          <span>Fill rule</span>
          <select
            aria-label="Path fill rule"
            value={draft.fillRule}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                fillRule: event.target.value as Draft["fillRule"],
              }))
            }
          >
            <option value="nonzero">Nonzero</option>
            <option value="evenodd">Even-odd · cut out overlaps</option>
          </select>
        </label>
      </details>
      {(error || notice) && (
        <p role="alert" className="vector-error">
          {error || notice}
        </p>
      )}
      <div className="two-col vector-draft-actions">
        <button
          disabled={!changed || !!error}
          onClick={() => {
            releaseGesture();
            onApply({
              vectorPath: draft.path,
              vectorViewBox: box,
              vectorFillRule: draft.fillRule,
            });
            setNotice("Path applied.");
          }}
        >
          Apply path
        </button>
        <button
          disabled={!changed}
          onClick={() => {
            releaseGesture();
            setDraft(fromLayer(layer));
            setSelected(0);
            setNotice("");
          }}
        >
          Cancel changes
        </button>
      </div>
    </details>
  );
}
