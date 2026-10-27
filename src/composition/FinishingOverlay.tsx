import React from "react";
import type { Clip } from "../shared/model";

/** Frame-driven effects use the same composition in preview and export. */
export function FinishingOverlay({
  clip: c,
  frame,
}: {
  clip: Clip;
  frame: number;
}) {
  const amount = c.overlayAmount;
  const shared: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
  };
  switch (c.overlay) {
    case "film-grain": {
      const seed = Math.floor(frame / 3) % 17;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="3" seed="${seed}" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity=".7"/></svg>`;
      return (
        <div
          style={{
            ...shared,
            opacity: amount * 0.42,
            mixBlendMode: "soft-light",
            backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
          }}
        />
      );
    }
    case "light-leak":
      return (
        <div
          style={{
            ...shared,
            opacity: amount * (0.45 + 0.2 * Math.sin(frame * 0.045)),
            mixBlendMode: "screen",
            background: `radial-gradient(ellipse at ${-15 + 20 * Math.sin(frame * 0.03)}% 30%, #ff7940 0%, #ec356b80 25%, transparent 70%)`,
          }}
        />
      );
    case "vhs":
      return (
        <>
          <div
            style={{
              ...shared,
              opacity: amount * 0.26,
              background:
                "repeating-linear-gradient(0deg, transparent 0px, transparent 3px, #000 3px, #000 5px)",
            }}
          />
          <div
            style={{
              ...shared,
              opacity: amount * 0.15,
              mixBlendMode: "screen",
              background: `linear-gradient(0deg,transparent ${frame % 90}%,#94ffd640 ${(frame % 90) + 3}%,transparent ${(frame % 90) + 6}%)`,
            }}
          />
        </>
      );
    case "letterbox": {
      // Half strength is the classic 2.39:1 band on a 16:9 frame (about 13%
      // of the height each); full strength is a tighter cinema crop.
      const bar = `${Number((amount * 26).toFixed(2))}%`;
      return (
        <>
          <div style={{ ...shared, bottom: "auto", height: bar, background: "#000" }} />
          <div style={{ ...shared, top: "auto", height: bar, background: "#000" }} />
        </>
      );
    }
    case "flash-in": {
      // White on the first frame, clear by the sixth: a pop that hides a hard cut.
      const fade = Math.max(0, 1 - frame / 6);
      if (fade <= 0) return null;
      return (
        <div
          style={{
            ...shared,
            background: "#fff",
            opacity: Math.min(1, amount * 2) * fade * fade,
          }}
        />
      );
    }
    case "glitch":
      // The tearing itself is a filter on the picture (finishingEffect);
      // faint scan lines sit over it.
      return (
        <div
          style={{
            ...shared,
            opacity: amount * 0.18,
            background:
              "repeating-linear-gradient(0deg, transparent 0px, transparent 2px, #000 2px, #000 3px)",
          }}
        />
      );
    case "halftone":
      return (
        <div
          style={{
            ...shared,
            opacity: amount * 0.3,
            mixBlendMode: "multiply",
            backgroundImage: "radial-gradient(#111 1.8px, transparent 2px)",
            backgroundSize: "7px 7px",
          }}
        />
      );
    default:
      return null;
  }
}
