import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Clip, Motion, MotionLayer } from "../shared/model";
import { planeTransform } from "../shared/plane-transform";
import {
  evaluatedMotionLayer,
  motionShapePath,
  motionTextTokens,
  motionTextLines,
  isMotionAccentLayer,
} from "../shared/motion";
import { captionTextWidth } from "../shared/caption-layout";
export { isMotionAccentLayer } from "../shared/motion";
export type MotionAccentPulse = { scale: number; glow: number };

function gradientStyle(layer: MotionLayer): React.CSSProperties {
  return layer.fillStyle === "gradient"
    ? {
        backgroundImage: `linear-gradient(${layer.gradientAngle}deg, ${layer.color}, ${layer.gradientColor})`,
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        color: "transparent",
      }
    : { color: layer.color };
}

function MotionText({
  layer,
  original,
  clip,
  frame,
  fps,
}: {
  layer: MotionLayer;
  original: MotionLayer;
  clip: Clip;
  frame: number;
  fps: number;
}) {
  const text = layer.text || clip.text;
  const fill = gradientStyle(layer);
  const align = layer.align ?? clip.align;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent:
          align === "left"
            ? "flex-start"
            : align === "right"
              ? "flex-end"
              : "center",
        textAlign: align,
        fontFamily: layer.fontFamily ?? clip.fontFamily,
        fontStyle: layer.fontStyle,
        fontWeight: layer.fontWeight ?? clip.fontWeight,
        fontSize: layer.fontSize,
        lineHeight: layer.lineHeight ?? 1.18,
        letterSpacing: layer.letterSpacing ?? 0,
        background: layer.background,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        borderRadius: layer.radius,
        WebkitTextStroke:
          layer.strokeWidth > 0
            ? `${layer.strokeWidth}px ${layer.stroke}`
            : undefined,
        paintOrder: "stroke fill",
      }}
    >
      <div
        style={{
          minWidth: 0,
          maxWidth: "100%",
          width: layer.textAnimation === "line-reveal" ? "100%" : undefined,
        }}
      >
        {layer.textAnimation === "line-reveal" ? (
          motionTextLines(original, text, frame).map((line, index) => (
            <div
              key={index}
              data-motion-line={index}
              style={{ overflow: "hidden", display: "block" }}
            >
              <span
                data-motion-line-progress={line.progress}
                style={{
                  ...fill,
                  display: "block",
                  transform: `translateY(${line.y}%)`,
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          ))
        ) : layer.textAnimation === "none" ? (
          <span style={fill}>{text}</span>
        ) : (
          <MotionTokens
            layer={layer}
            original={original}
            clip={clip}
            text={text}
            frame={frame}
            fps={fps}
            fill={fill}
          />
        )}
      </div>
    </div>
  );
}

/** Metric weight for the deterministic advance tables (system fonts have few weights). */
const metricWeight = (weight: number | string): Clip["fontWeight"] => {
  const value = Number(weight);
  return value >= 700 ? "800" : value >= 600 ? "600" : "400";
};

/**
 * Animated letters and words sit in their own boxes, so each one draws its
 * slice of a single gradient that spans the whole run of text, as unanimated
 * text does. Offsets come from the same advance tables as caption layout.
 */
export function gradientSlices(
  tokens: string[],
  font: {
    family: Clip["fontFamily"];
    weight: number | string;
    size: number;
    tracking: number;
  },
) {
  const weight = metricWeight(font.weight);
  const width = (text: string) => {
    const visible = text.replace(/[\r\n]/gu, "");
    return visible
      ? captionTextWidth(visible, font.size, font.family, weight, font.tracking)
      : 0;
  };
  const offsets: number[] = [];
  let at = 0;
  for (const token of tokens) {
    offsets.push(at);
    at += width(token);
  }
  return { offsets, total: width(tokens.join("")) };
}

/** Letter-by-letter reveals keep each word in one piece, so lines wrap at spaces. */
function MotionTokens({
  layer,
  original,
  clip,
  text,
  frame,
  fps,
  fill,
}: {
  layer: MotionLayer;
  original: MotionLayer;
  clip: Clip;
  text: string;
  frame: number;
  fps: number;
  fill: React.CSSProperties;
}) {
  const tokens = motionTextTokens(original, text, frame, fps);
  const slices =
    layer.fillStyle === "gradient"
      ? gradientSlices(
          tokens.map((token) => token.text),
          {
            family: layer.fontFamily ?? clip.fontFamily,
            weight: layer.fontWeight ?? clip.fontWeight,
            size: layer.fontSize,
            tracking: layer.letterSpacing ?? 0,
          },
        )
      : undefined;
  const letters = layer.textAnimation !== "word-rise";
  const out: React.ReactNode[] = [];
  let word: React.ReactNode[] = [],
    wordStart = 0;
  const closeWord = () => {
    if (word.length)
      out.push(
        <span key={`word-${wordStart}`} style={{ display: "inline-block" }}>
          {word}
        </span>,
      );
    word = [];
  };
  tokens.forEach((token, index) => {
    if (/^\s+$/u.test(token.text)) {
      closeWord();
      out.push(
        <React.Fragment key={`space-${index}`}>{token.text}</React.Fragment>,
      );
      return;
    }
    const span = (
      <span
        key={index}
        style={{
          ...fill,
          ...(slices && {
            backgroundSize: `${slices.total}px 100%`,
            backgroundPosition: `${-slices.offsets[index]}px 0`,
            backgroundRepeat: "no-repeat",
            // Past the measured run, letters keep the gradient's end color.
            backgroundColor: layer.gradientColor,
          }),
          display: "inline-block",
          whiteSpace: "pre-wrap",
          opacity: token.opacity,
          transform: `translateY(${token.y}px)`,
          filter: token.blur > 0 ? `blur(${token.blur}px)` : undefined,
        }}
      >
        {token.text}
      </span>
    );
    if (!letters) out.push(span);
    else {
      if (!word.length) wordStart = index;
      word.push(span);
    }
  });
  closeWord();
  return <>{out}</>;
}

/**
 * Path outlines are stored in canvas pixels. They are drawn in path units so the
 * stroke and its dash reveal share one coordinate space: a non-scaling stroke
 * sizes the dash from the path length but draws it in pixels, which breaks the
 * outline into dashes and leaves draw reveals unfinished.
 */
export function pathStrokeScale(
  layer: Pick<
    MotionLayer,
    | "width"
    | "height"
    | "vectorViewBox"
    | "vectorTransform"
    | "vectorAspectRatio"
  >,
) {
  const box = layer.vectorViewBox;
  if (!box) return 1;
  const vx = layer.width / box[2],
    vy = layer.height / box[3];
  const view =
    layer.vectorAspectRatio === "none" ? Math.sqrt(vx * vy) : Math.min(vx, vy);
  const m = layer.vectorTransform ?? [1, 0, 0, 1, 0, 0];
  const matrix = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const scale = view * matrix;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** An imported SVG gradient, drawn in the same units the source file used. */
function VectorGradientDef({
  id,
  gradient: g,
}: {
  id: string;
  gradient: NonNullable<MotionLayer["vectorGradient"]>;
}) {
  const shared = {
    id,
    gradientUnits: g.units,
    spreadMethod: g.spread,
    gradientTransform: g.transform
      ? `matrix(${g.transform.join(" ")})`
      : undefined,
  };
  const stops = g.stops.map((stop, index) => (
    <stop
      key={index}
      offset={stop.offset}
      stopColor={stop.color}
      stopOpacity={stop.opacity}
    />
  ));
  return g.type === "linear" ? (
    <linearGradient {...shared} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
      {stops}
    </linearGradient>
  ) : (
    <radialGradient {...shared} cx={g.cx} cy={g.cy} r={g.r} fx={g.fx} fy={g.fy}>
      {stops}
    </radialGradient>
  );
}

function MotionShape({ layer, id }: { layer: MotionLayer; id: string }) {
  const angle = (layer.gradientAngle * Math.PI) / 180;
  const path = layer.type === "path";
  const revealing = layer.trim < 1;
  const dx = Math.sin(angle) / 2,
    dy = -Math.cos(angle) / 2;
  const imported = path ? layer.vectorGradient : undefined;
  const fill =
    layer.type === "line" || layer.background === "transparent"
      ? "none"
      : imported || layer.fillStyle === "gradient"
        ? `url(#${id})`
        : layer.background;
  return (
    <svg
      width={layer.width}
      height={layer.height}
      viewBox={
        path
          ? layer.vectorViewBox?.join(" ")
          : `0 0 ${layer.width} ${layer.height}`
      }
      preserveAspectRatio={
        path
          ? layer.vectorAspectRatio === "none"
            ? "none"
            : "xMidYMid meet"
          : undefined
      }
      style={{ display: "block", overflow: "visible" }}
      aria-hidden="true"
    >
      {imported ? (
        <defs>
          <VectorGradientDef id={id} gradient={imported} />
        </defs>
      ) : (
        layer.fillStyle === "gradient" && (
          <defs>
            <linearGradient
              id={id}
              x1={`${(0.5 - dx) * 100}%`}
              y1={`${(0.5 - dy) * 100}%`}
              x2={`${(0.5 + dx) * 100}%`}
              y2={`${(0.5 + dy) * 100}%`}
            >
              <stop offset="0%" stopColor={layer.background} />
              <stop offset="100%" stopColor={layer.gradientColor} />
            </linearGradient>
          </defs>
        )
      )}
      <path
        d={motionShapePath(layer)}
        fill={fill}
        fillOpacity={layer.fillOpacity}
        fillRule={path ? layer.vectorFillRule : undefined}
        transform={
          path && layer.vectorTransform
            ? `matrix(${layer.vectorTransform.join(" ")})`
            : undefined
        }
        stroke={layer.stroke}
        strokeWidth={
          path ? layer.strokeWidth / pathStrokeScale(layer) : layer.strokeWidth
        }
        strokeLinejoin={path ? (layer.vectorLineJoin ?? "miter") : "round"}
        strokeLinecap={
          layer.trim === 0
            ? "butt"
            : path
              ? (layer.vectorLineCap ?? "butt")
              : "round"
        }
        // A finished outline draws without a dash so closed shapes keep a clean
        // corner where the path starts and ends.
        pathLength={revealing ? 1 : undefined}
        strokeDasharray={revealing ? "1 1" : undefined}
        strokeDashoffset={revealing ? 1 - layer.trim : undefined}
      />
    </svg>
  );
}

/** Explicit frames also let QA inspect the same markup used by preview and export. */
export function MotionGraphicAtFrame({
  motion,
  c,
  frame,
  fps = 30,
  accentPulse,
}: {
  motion: Motion;
  c: Clip;
  frame: number;
  fps?: number;
  accentPulse?: MotionAccentPulse;
}) {
  const phase = frame + (c.animationOffset ?? 0);
  return (
    <>
      {motion.layers.map((original, index) => {
        if (original.hidden) return null;
        const layer = evaluatedMotionLayer(original, phase);
        const accent =
          accentPulse && isMotionAccentLayer(original, c)
            ? accentPulse
            : undefined;
        const scale = layer.scale * (accent?.scale ?? 1);
        const glow = Math.max(
          0,
          Math.min(100, layer.glow + (accent?.glow ?? 0)),
        );
        const glowColor =
          layer.type === "text"
            ? layer.color
            : layer.background === "transparent" || layer.type === "line"
              ? layer.stroke
              : layer.background;
        const filters = [
          layer.blur > 0 ? `blur(${layer.blur}px)` : "",
          glow > 0 ? `drop-shadow(0 0 ${glow}px ${glowColor})` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const id = `motion-gradient-${c.id}-${index}`.replace(
          /[^a-zA-Z0-9_-]/g,
          "_",
        );
        return (
          <div
            key={index}
            data-motion-layer={index}
            data-motion-type={layer.type}
            style={{
              position: "absolute",
              left: layer.x,
              top: layer.y,
              width: layer.width,
              height: layer.height,
              opacity: layer.opacity,
              transform: [
                planeTransform(layer),
                `scale(${scale}) rotate(${layer.rotate}deg)`,
              ]
                .filter(Boolean)
                .join(" "),
              transformOrigin: `${layer.anchorX * 100}% ${layer.anchorY * 100}%`,
              filter: filters || undefined,
            }}
          >
            {layer.type === "text" ? (
              <MotionText
                layer={layer}
                original={original}
                clip={c}
                frame={phase}
                fps={fps}
              />
            ) : (
              <MotionShape layer={layer} id={id} />
            )}
          </div>
        );
      })}
    </>
  );
}

export function MotionGraphic({
  motion,
  c,
  accentPulse,
}: {
  motion: Motion;
  c: Clip;
  accentPulse?: MotionAccentPulse;
}) {
  return (
    <MotionGraphicAtFrame
      motion={motion}
      c={c}
      frame={useCurrentFrame()}
      fps={useVideoConfig().fps}
      accentPulse={accentPulse}
    />
  );
}
