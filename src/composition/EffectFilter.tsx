import React from "react";
import type { SvgEffect } from "./compositing";

/**
 * One SVG filter for what CSS filters cannot draw: directional motion blur
 * (whips and pushes), glitch tearing, where every row of the picture slips
 * sideways by its own amount, color separation, and halation, a soft glow
 * that only the highlights give off. The displacement map is a noise texture
 * that varies down the frame and hardly at all across it, with its green
 * channel pinned to 0.5 so rows never move vertically. The filter is
 * referenced as `url(#id)`; preview and export run the same Chromium, so the
 * picture matches. Only the steps an effect needs are built.
 */
export function EffectFilter({ id, effect }: { id: string; effect: SvgEffect }) {
  const steps: React.ReactNode[] = [];
  let source = "SourceGraphic";
  if (effect.displace > 0) {
    steps.push(
      <feTurbulence
        key="noise"
        type="fractalNoise"
        baseFrequency="0.0012 0.32"
        numOctaves={1}
        seed={effect.seed}
        result="noise"
      />,
      <feColorMatrix
        key="rows"
        in="noise"
        type="matrix"
        values="1 0 0 0 0  0 0 0 0 0.5  0 0 1 0 0  0 0 0 0 1"
        result="rows"
      />,
      <feDisplacementMap
        key="tear"
        in={source}
        in2="rows"
        scale={effect.displace}
        xChannelSelector="R"
        yChannelSelector="G"
        result="torn"
      />,
    );
    source = "torn";
  }
  if (effect.rgb > 0) {
    steps.push(
      <feColorMatrix
        key="red"
        in={source}
        type="matrix"
        values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
        result="red"
      />,
      <feOffset key="redShift" in="red" dx={effect.rgb} result="redShift" />,
      <feColorMatrix
        key="green"
        in={source}
        type="matrix"
        values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
        result="green"
      />,
      <feColorMatrix
        key="blue"
        in={source}
        type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
        result="blue"
      />,
      <feOffset
        key="blueShift"
        in="blue"
        dx={-effect.rgb}
        result="blueShift"
      />,
      <feBlend
        key="redGreen"
        in="redShift"
        in2="green"
        mode="screen"
        result="redGreen"
      />,
      <feBlend
        key="split"
        in="redGreen"
        in2="blueShift"
        mode="screen"
        result="split"
      />,
    );
    source = "split";
  }
  if (effect.blurX > 0 || effect.blurY > 0) {
    steps.push(
      <feGaussianBlur
        key="blur"
        in={source}
        stdDeviation={`${effect.blurX} ${effect.blurY}`}
        result="blurred"
      />,
    );
    source = "blurred";
  }
  if (effect.bloom > 0) {
    // Keep only the brightest tones, soften them, warm them and screen them
    // back over the picture: film halation around lights and skin highlights.
    const tint = [1, 0.72, 0.5].map((channel) =>
      (channel * effect.bloom).toFixed(3),
    );
    steps.push(
      <feComponentTransfer key="highlights" in={source} result="highlights">
        <feFuncR type="linear" slope={3} intercept={-1.9} />
        <feFuncG type="linear" slope={3} intercept={-1.9} />
        <feFuncB type="linear" slope={3} intercept={-1.9} />
      </feComponentTransfer>,
      <feGaussianBlur
        key="glow"
        in="highlights"
        stdDeviation={effect.bloomRadius}
        result="glow"
      />,
      <feColorMatrix
        key="warm"
        in="glow"
        type="matrix"
        values={`${tint[0]} 0 0 0 0  0 ${tint[1]} 0 0 0  0 0 ${tint[2]} 0 0  0 0 0 1 0`}
        result="warm"
      />,
      <feBlend key="halation" in={source} in2="warm" mode="screen" />,
    );
  }
  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      style={{ position: "absolute", pointerEvents: "none" }}
    >
      <defs>
        <filter
          id={id}
          x="-25%"
          y="-25%"
          width="150%"
          height="150%"
          colorInterpolationFilters="sRGB"
        >
          {steps}
        </filter>
      </defs>
    </svg>
  );
}
