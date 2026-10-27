import React from "react";
import type { MotionLayer } from "../shared/model";
import { motionProperties, motionValue, motionFrame } from "../shared/motion";
import { upsertMotionKey } from "../shared/motion-edit";
import { NumberField } from "./Inspector";

type Props = {
  layer: MotionLayer;
  duration: number;
  width: number;
  animationOffset: number;
  frame: number;
  update: (patch: Partial<MotionLayer>) => void;
};

/** These controls author the same native fields used by previews, exports and assistants. */
export function PremiumMotionControls({
  layer,
  duration,
  width,
  animationOffset,
  frame,
  update,
}: Props) {
  const path = layer.motionPath;
  const counter = layer.counter;
  const start = layer.loop === "none" ? animationOffset : 0;
  const last = Math.max(
    1,
    Math.min(
      90,
      layer.loop === "none" ? duration - 1 : layer.loopFrames,
      864000 - start,
    ),
  );
  const at = Math.round(
    motionFrame(
      layer,
      animationOffset + Math.max(0, Math.min(duration - 1, frame)),
    ),
  );
  const removeCurve = (property: "pathProgress" | "reveal") =>
    layer.keyframes
      .map((key) => {
        const next = { ...key };
        delete next[property];
        return next;
      })
      .filter((key) =>
        motionProperties.some((name) => key[name] !== undefined),
      );
  const animate = (property: "pathProgress" | "reveal") => {
    const keys = removeCurve(property);
    if (keys.length > 98) return;
    update({
      [property]: 0,
      keyframes: [
        ...keys,
        { frame: start, [property]: 0, easing: "ease-in-out" as const },
        { frame: start + last, [property]: 1, easing: "linear" as const },
      ].sort((a, b) => a.frame - b.frame),
    });
  };
  const amount = (property: "pathProgress" | "reveal", value: number) => {
    if (!layer.keyframes.some((key) => key[property] !== undefined)) {
      update({ [property]: value });
      return;
    }
    const existing = [...layer.keyframes]
      .reverse()
      .find((key) => key.frame === at && key[property] !== undefined);
    const keyframes = upsertMotionKey(
      layer,
      property,
      at,
      value,
      existing?.easing ?? "ease-in-out",
      existing?.bezier,
    );
    if (keyframes) update({ keyframes });
  };
  const pointLabels = ["Start", "First handle", "Second handle", "End"];
  const span = Math.min(500, Math.round(width * 0.4));
  const points = path?.points ?? [];
  const pathBounds = path
    ? {
        x: Math.min(...points.map((p) => p.x)) - 40,
        y: Math.min(...points.map((p) => p.y)) - 40,
        width:
          Math.max(...points.map((p) => p.x)) -
          Math.min(...points.map((p) => p.x)) +
          80,
        height:
          Math.max(...points.map((p) => p.y)) -
          Math.min(...points.map((p) => p.y)) +
          80,
      }
    : undefined;
  return (
    <>
      <details className="motion-path-controls">
        <summary>Motion path</summary>
        <label className="checkbox">
          <input
            type="checkbox"
            aria-label="Follow a curved path"
            checked={Boolean(path)}
            onChange={(event) =>
              update({
                motionPath: event.target.checked
                  ? {
                      points: [
                        { x: 0, y: 0 },
                        { x: span * 0.25, y: -span * 0.5 },
                        { x: span * 0.75, y: span * 0.5 },
                        { x: span, y: 0 },
                      ],
                      autoOrient: false,
                    }
                  : undefined,
              })
            }
          />
          Follow a curved path
        </label>
        {path && (
          <>
            <svg
              viewBox={`${pathBounds!.x} ${pathBounds!.y} ${pathBounds!.width} ${pathBounds!.height}`}
              className="motion-path-miniature"
              role="img"
              aria-label="Motion path shape"
              style={{ width: "100%", height: 88 }}
            >
              <path
                d={`M ${path.points[0].x} ${path.points[0].y} C ${path.points[1].x} ${path.points[1].y}, ${path.points[2].x} ${path.points[2].y}, ${path.points[3].x} ${path.points[3].y}`}
                fill="none"
                stroke="currentColor"
                vectorEffect="non-scaling-stroke"
                strokeWidth={2}
              />
            </svg>
            {path.points.map((point, index) => (
              <div className="two-col" key={index}>
                {(["x", "y"] as const).map((axis) => (
                  <NumberField
                    key={axis}
                    label={`${pointLabels[index]} ${axis.toUpperCase()}`}
                    value={point[axis]}
                    min={-4000}
                    max={4000}
                    onChange={(value) =>
                      update({
                        motionPath: {
                          ...path,
                          points: path.points.map((p, i) =>
                            i === index ? { ...p, [axis]: value } : p,
                          ) as typeof path.points,
                        },
                      })
                    }
                  />
                ))}
              </div>
            ))}
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="Rotate along path"
                checked={path.autoOrient ?? false}
                onChange={(event) =>
                  update({
                    motionPath: { ...path, autoOrient: event.target.checked },
                  })
                }
              />
              Rotate along path
            </label>
            <NumberField
              label="Path progress"
              value={motionValue(layer, "pathProgress", at)}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => amount("pathProgress", value)}
            />
            <button
              className="full"
              disabled={
                start >= 864000 || removeCurve("pathProgress").length > 98
              }
              onClick={() => animate("pathProgress")}
            >
              Animate path
            </button>
            <p className="hint">
              Points are offsets from this layer. Adjust Path progress in
              Animate layer to change the timing.
            </p>
          </>
        )}
      </details>
      <details>
        <summary>Reveal mask</summary>
        <label className="field">
          <span>Mask shape</span>
          <select
            aria-label="Mask shape"
            value={layer.revealMask ?? "none"}
            onChange={(event) =>
              update({
                revealMask:
                  event.target.value === "none"
                    ? undefined
                    : (event.target.value as MotionLayer["revealMask"]),
              })
            }
          >
            <option value="none">None</option>
            <option value="wipe-right">Wipe right</option>
            <option value="wipe-left">Wipe left</option>
            <option value="wipe-up">Wipe up</option>
            <option value="wipe-down">Wipe down</option>
            <option value="iris">Iris</option>
          </select>
        </label>
        {layer.revealMask && layer.revealMask !== "none" && (
          <>
            <NumberField
              label="Mask reveal"
              value={motionValue(layer, "reveal", at)}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => amount("reveal", value)}
            />
            <button
              className="full"
              disabled={start >= 864000 || removeCurve("reveal").length > 98}
              onClick={() => animate("reveal")}
            >
              Animate reveal
            </button>
          </>
        )}
      </details>
      {layer.type === "text" && (
        <details>
          <summary>Number counter</summary>
          <label className="checkbox">
            <input
              type="checkbox"
              aria-label="Animate a number"
              checked={Boolean(counter)}
              onChange={(event) =>
                update({
                  counter: event.target.checked
                    ? {
                        from: 0,
                        to: 100,
                        startFrame: start,
                        durationFrames: last,
                        decimals: 0,
                        prefix: "",
                        suffix: "",
                        easing: "ease-out",
                      }
                    : undefined,
                })
              }
            />
            Animate a number
          </label>
          {counter && (
            <>
              <div className="two-col">
                <NumberField
                  label="Count from"
                  value={counter.from}
                  min={-1e12}
                  max={1e12}
                  step={0.01}
                  onChange={(from) => update({ counter: { ...counter, from } })}
                />
                <NumberField
                  label="Count to"
                  value={counter.to}
                  min={-1e12}
                  max={1e12}
                  step={0.01}
                  onChange={(to) => update({ counter: { ...counter, to } })}
                />
                <NumberField
                  label="Counter start (frames)"
                  value={counter.startFrame}
                  min={0}
                  max={864000}
                  onChange={(startFrame) =>
                    update({
                      counter: {
                        ...counter,
                        startFrame: Math.round(startFrame),
                      },
                    })
                  }
                />
                <NumberField
                  label="Counter duration (frames)"
                  value={counter.durationFrames}
                  min={1}
                  max={864000}
                  onChange={(durationFrames) =>
                    update({
                      counter: {
                        ...counter,
                        durationFrames: Math.round(durationFrames),
                      },
                    })
                  }
                />
                <NumberField
                  label="Decimal places"
                  value={counter.decimals ?? 0}
                  min={0}
                  max={6}
                  onChange={(decimals) =>
                    update({
                      counter: { ...counter, decimals: Math.round(decimals) },
                    })
                  }
                />
              </div>
              {(["prefix", "suffix"] as const).map((key) => (
                <label className="field" key={key}>
                  <span>
                    {key === "prefix" ? "Before number" : "After number"}
                  </span>
                  <input
                    aria-label={
                      key === "prefix" ? "Before number" : "After number"
                    }
                    key={`${key}:${counter[key]}`}
                    defaultValue={counter[key]}
                    maxLength={64}
                    onBlur={(event) => {
                      if (event.target.value !== counter[key])
                        update({
                          counter: { ...counter, [key]: event.target.value },
                        });
                    }}
                  />
                </label>
              ))}
              <label className="field">
                <span>Counter easing</span>
                <select
                  aria-label="Counter easing"
                  value={counter.easing}
                  onChange={(event) =>
                    update({
                      counter: {
                        ...counter,
                        easing: event.target.value as typeof counter.easing,
                      },
                    })
                  }
                >
                  <option value="linear">Linear</option>
                  <option value="ease-in">Ease in</option>
                  <option value="ease-out">Ease out</option>
                  <option value="ease-in-out">Ease in and out</option>
                  <option value="hold">Hold</option>
                  <option value="spring">Spring</option>
                  <option value="back">Back</option>
                  <option value="cubic-bezier">Custom curve</option>
                </select>
              </label>
            </>
          )}
        </details>
      )}
    </>
  );
}
