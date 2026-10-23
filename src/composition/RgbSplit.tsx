import React, { useId } from "react";

/**
 * One filtered source, so video never creates extra decoders or audio.
 * Recombine opaque channels, then apply the original alpha once: screen-blending
 * three translucent copies would darken footage underneath a fading title.
 * Color separation stays inside the source silhouette.
 */
export function RgbSplit({
  amount,
  children,
}: {
  amount: number;
  children: React.ReactNode;
}) {
  // A clip can appear in several library thumbnails and players at once.
  // React's per-instance ID prevents one preview's amount leaking into another.
  const id = `rgb-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <>
      {amount > 0 && (
        <svg
          width="0"
          height="0"
          aria-hidden="true"
          style={{ position: "absolute", pointerEvents: "none" }}
        >
          <defs>
            <filter
              id={id}
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
              colorInterpolationFilters="sRGB"
            >
              <feColorMatrix
                in="SourceGraphic"
                type="matrix"
                values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1"
                result="red"
              />
              <feOffset in="red" dx={amount} result="redShift" />
              <feColorMatrix
                in="SourceGraphic"
                type="matrix"
                values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1"
                result="green"
              />
              <feColorMatrix
                in="SourceGraphic"
                type="matrix"
                values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 1"
                result="blue"
              />
              <feOffset in="blue" dx={-amount} result="blueShift" />
              <feBlend
                in="redShift"
                in2="green"
                mode="screen"
                result="redGreen"
              />
              <feBlend
                in="redGreen"
                in2="blueShift"
                mode="screen"
                result="splitColors"
              />
              <feComposite in="splitColors" in2="SourceAlpha" operator="in" />
            </filter>
          </defs>
        </svg>
      )}
      <div
        style={{
          width: "100%",
          height: "100%",
          filter: amount > 0 ? `url(#${id})` : undefined,
        }}
      >
        {children}
      </div>
    </>
  );
}
