import React, { useState, useRef } from "react";
import { RotateCcw } from "lucide-react";
import type { Project, Clip } from "../shared/model";
import type { Command } from "../shared/commands";
import {
  videoLooks,
  cameraMoves,
  filterFor,
  lookStrength,
} from "../shared/effects";
import { optionLabel } from "./labels";
export function EffectSlider({
  label,
  value,
  min,
  max,
  step = 0.05,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const commit = (n: number) => {
    if (n !== committed.current) {
      committed.current = n;
      onCommit(n);
    }
  };
  return (
    <label className="effect-slider">
      <span>
        {label}
        <output>{Math.round(draft * 100) / 100}</output>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => commit(Number(e.currentTarget.value))}
        onBlur={(e) => commit(Number(e.currentTarget.value))}
      />
    </label>
  );
}
export function EffectsPanel({
  p,
  clip,
  edit,
  base,
}: {
  p: Project;
  clip?: Clip;
  edit: (label: string, ops: Command[]) => void;
  base: string;
}) {
  const valid = clip && ["video", "image"].includes(clip.kind);
  const asset = p.assets.find((a) => a.id === clip?.assetId);
  const patch = (value: Partial<Clip>, label = "Adjust effect") => {
    if (clip) edit(label, [{ type: "clip.update", id: clip.id, patch: value }]);
  };
  return (
    <div className="library-content effects-library">
      <div className="section-heading">
        <span>Effects</span>
      </div>
      {!valid && <p className="library-note">Select a video or photo first.</p>}
      <div className="look-grid">
        {videoLooks.map((look) => (
          <button
            disabled={!valid}
            aria-label={`Apply ${look} look`}
            aria-pressed={clip?.look === look}
            className={clip?.look === look ? "selected" : ""}
            key={look}
            onClick={() =>
              patch(
                { look, effectAmount: lookStrength(look) },
                `Apply ${look} look`,
              )
            }
          >
            <div
              style={{
                filter: filterFor({
                  ...clip!,
                  look,
                  effectAmount: lookStrength(look),
                  brightness: 1,
                  contrast: 1,
                  saturation: 1,
                  blur: 0,
                }),
              }}
            >
              {asset?.thumbnail ? (
                <img src={`${base}/media/${asset.id}/thumb`} alt="" />
              ) : (
                <div className="look-sample" />
              )}
            </div>
            <span>{look === "none" ? "Original" : optionLabel(look)}</span>
          </button>
        ))}
      </div>
      {valid && (
        <>
          <div className="section-heading effect-heading">
            <span>Fine-tune</span>
            <button
              aria-label="Reset effects"
              onClick={() =>
                patch(
                  {
                    look: "none",
                    effectAmount: 1,
                    brightness: 1,
                    contrast: 1,
                    saturation: 1,
                    blur: 0,
                    vignette: 0,
                    rgbSplit: 0,
                    invert: 0,
                    cameraMotion: "none",
                    overlay: "none",
                    overlayAmount: 0.5,
                  },
                  "Reset effects",
                )
              }
            >
              <RotateCcw size={13} />
            </button>
          </div>
          {(
            [
              ["Strength", "effectAmount", 0, 1],
              ["Brightness", "brightness", 0.2, 2],
              ["Contrast", "contrast", 0.2, 2],
              ["Saturation", "saturation", 0, 2],
              ["Soft blur", "blur", 0, 30],
              ["Vignette", "vignette", 0, 1],
            ] as const
          ).map(([label, key, min, max]) => (
            <EffectSlider
              key={clip.id + key + clip[key]}
              label={label}
              value={clip[key]}
              min={min}
              max={max}
              step={key === "blur" ? 0.5 : 0.05}
              onCommit={(n) => patch({ [key]: n })}
            />
          ))}
          <div className="section-heading effect-heading">
            <span>Camera motion</span>
          </div>
          <div className="camera-grid">
            {cameraMoves.map((m) => (
              <button
                key={m}
                aria-pressed={clip.cameraMotion === m}
                className={clip.cameraMotion === m ? "selected" : ""}
                onClick={() => patch({ cameraMotion: m }, "Camera motion")}
              >
                {m === "none" ? "Still" : optionLabel(m)}
              </button>
            ))}
          </div>
          <div className="section-heading effect-heading">
            <span>Finishing overlays</span>
          </div>
          <div className="camera-grid">
            {(
              [
                ["none", "None"],
                ["film-grain", "Film grain"],
                ["light-leak", "Light leak"],
                ["vhs", "VHS scan"],
                ["halftone", "Halftone"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={clip.overlay === value}
                className={clip.overlay === value ? "selected" : ""}
                onClick={() => patch({ overlay: value }, `Add ${label}`)}
              >
                {label}
              </button>
            ))}
          </div>
          {clip.overlay !== "none" && (
            <EffectSlider
              key={clip.id + "overlay" + clip.overlayAmount}
              label="Overlay strength"
              value={clip.overlayAmount}
              min={0}
              max={1}
              onCommit={(n) => patch({ overlayAmount: n })}
            />
          )}
          <button
            className="full subtle"
            onClick={() =>
              edit(
                "Copy look to this track",
                p.clips
                  .filter(
                    (c) =>
                      c.trackId === clip.trackId &&
                      (c.kind === "video" || c.kind === "image"),
                  )
                  .map((c) => ({
                    type: "clip.update",
                    id: c.id,
                    patch: { look: clip.look, effectAmount: clip.effectAmount },
                  })),
              )
            }
          >
            Copy look to this track
          </button>
          <button
            className="full subtle"
            onClick={() =>
              edit(
                "Match video looks",
                p.clips
                  .filter((c) => c.kind === "video" || c.kind === "image")
                  .map((c) => ({
                    type: "clip.update",
                    id: c.id,
                    patch: {
                      look: clip.look,
                      effectAmount: clip.effectAmount,
                      brightness: clip.brightness,
                      contrast: clip.contrast,
                      saturation: clip.saturation,
                      blur: clip.blur,
                      vignette: clip.vignette,
                    },
                  })),
              )
            }
          >
            Apply this look to all video & photos
          </button>
        </>
      )}
    </div>
  );
}
