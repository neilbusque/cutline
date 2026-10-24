import { captionTextPatch } from "../shared/caption-edit";
import { KeyframeInspector } from "./KeyframeInspector";
import {
  activeTransition,
  previousClip,
  transitionNames,
  type TransitionKind,
} from "../shared/transitions";
import React, { useEffect, useRef, useState } from "react";
import { compatibleTrack } from "../shared/timeline";
import { MotionInspector } from "./MotionInspector";
import {
  type Clip,
  type Project,
  presets,
  MotionSchema,
  uid,
} from "../shared/model";
import { type Command } from "../shared/commands";
import { SlidersHorizontal, Sparkles } from "lucide-react";
import { createDraftCommit } from "./edit-gestures";
import { kindLabel, optionLabel } from "./labels";
import { usePlayheadFrame, type Playhead } from "./playhead";
export { optionLabel };
export { NumberField } from "./NumberField";
import { NumberField } from "./NumberField";
import { alignOnStage, type Alignment } from "../shared/stage-layout";
import { evaluatedClip } from "../shared/animation";
import { transformCommands } from "./edit-gestures";
/**
 * A color well that shows every change at once but saves one edit: when the
 * color panel commits, on blur, or after a short pause in a drag. Dragging
 * across the macOS color panel used to send an undoable edit per pixel.
 */
export function ColorInput({
  value,
  onCommit,
  ...input
}: {
  value: string;
  /** Resolving to false means the edit was refused; the well shows the stored color again. */
  onCommit: (value: string) => unknown;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "defaultValue"
>) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(onCommit);
  latest.current = onCommit;
  const stored = useRef(value);
  stored.current = value;
  const [color] = useState(() =>
    createDraftCommit<string>((next) => {
      void Promise.resolve(latest.current(next)).then((ok) => {
        if (ok !== false) return;
        color.sync(stored.current);
        setDraft(stored.current);
      });
    }),
  );
  const element = useRef<HTMLInputElement>(null);
  useEffect(() => {
    color.sync(value);
    if (!color.pending()) setDraft(value);
  }, [value, color]);
  useEffect(() => {
    const well = element.current;
    // The native change event fires when the color panel settles on a color.
    const settle = () => color.flush();
    well?.addEventListener("change", settle);
    return () => {
      well?.removeEventListener("change", settle);
      color.flush();
    };
  }, [color]);
  return (
    <input
      {...input}
      ref={element}
      type="color"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        color.change(e.target.value);
      }}
      onBlur={(e) => {
        color.flush();
        input.onBlur?.(e);
      }}
    />
  );
}
export function Inspector({
  project: p,
  clip: c,
  playhead,
  playing,
  active = true,
  seek,
  edit,
  transcribe,
  pauses,
  report,
  openPanel,
}: {
  project: Project;
  clip?: Clip;
  playhead: Playhead;
  playing: boolean;
  /** False while Properties is hidden behind the Assistant. */
  active?: boolean;
  seek: (frame: number) => void;
  edit: (label: string, ops: Command[]) => unknown;
  transcribe: () => void;
  pauses: () => void;
  report: (e: unknown) => void;
  openPanel?: (panel: "captions" | "effects") => void;
}) {
  const [custom, setCustom] = useState(false);
  const [ratioLocked, setRatioLocked] = useState(false);
  const [code, setCode] = useState("");
  // Keyframe values follow the playhead while scrubbing and a few times a
  // second during playback, so Properties is not redrawn on every frame.
  const frame = usePlayheadFrame(playhead, {
    live: !!c && active,
    every: playing ? 250 : 0,
  });
  if (!c)
    return (
      <div className="inspector empty-inspector">
        <SlidersHorizontal size={28} />
        <h3>Select a clip to edit it</h3>
        <div className="shortcut-list">
          <span>
            Split clip<kbd>⌘ B</kbd>
          </span>
          <span>
            Play / pause<kbd>Space</kbd>
          </span>
          <span>
            Undo<kbd>⌘ Z</kbd>
          </span>
          <span>
            Save project<kbd>⌘ S</kbd>
          </span>
        </div>
      </div>
    );
  const patch = (change: Partial<Clip>, label = "Adjust clip") =>
    edit(label, [{ type: "clip.update", id: c.id, patch: change }]);
  const text = c.kind === "text" || c.kind === "caption";
  const transition = activeTransition(p, c);
  const previous = previousClip(p, c);
  const canTransition =
    !!transition ||
    (!!previous && previous.start + previous.duration === c.start);
  const changeTransition = (
    kind: TransitionKind | "none",
    frames = transition?.frames ?? Math.round(p.fps * 0.5),
  ) =>
    edit("Change transition", [
      { type: "clip.transition", id: c.id, kind, frames },
    ]);
  const asset = p.assets.find((a) => a.id === c.assetId);
  const motion =
    c.preset === "custom"
      ? p.motions.find((m) => m.id === c.motionId)
      : undefined;
  const audioSection = (open: boolean) => (
    <details open={open}>
      <summary>{text ? "Fades" : "Audio & fades"}</summary>
      {asset?.hasAudio && (
        <NumberField
          label="Volume"
          value={c.volume}
          min={0}
          max={2}
          step={0.05}
          onChange={(n) => patch({ volume: n })}
        />
      )}
      <div className="two-col">
        <NumberField
          label="Fade in (s)"
          value={c.fadeIn / p.fps}
          min={0}
          step={0.1}
          onChange={(n) => patch({ fadeIn: Math.round(n * p.fps) })}
        />
        <NumberField
          label="Fade out (s)"
          value={c.fadeOut / p.fps}
          min={0}
          step={0.1}
          onChange={(n) => patch({ fadeOut: Math.round(n * p.fps) })}
        />
      </div>
    </details>
  );
  return (
    <div className="inspector" key={c.id}>
      <div className="section-heading">
        <span>{text ? "Text & motion" : (asset?.name ?? "Clip")}</span>
        <small>{kindLabel(c.kind)}</small>
      </div>
      {text && (
        <>
          <label className="field stack">
            <span>Text</span>
            <textarea
              key={c.text}
              defaultValue={c.text}
              rows={3}
              onBlur={(e) => {
                if (e.target.value !== c.text) {
                  try {
                    patch(
                      c.kind === "caption"
                        ? captionTextPatch(c, e.target.value).patch
                        : { text: e.target.value },
                      "Edit text",
                    );
                  } catch (error) {
                    report(error);
                    e.target.value = c.text;
                  }
                }
              }}
            />
          </label>
          {c.kind === "caption" && (
            <p className="hint">
              Adding or removing words resets their timing.
            </p>
          )}
        </>
      )}
      <label className="field">
        <span>Track</span>
        <select
          value={c.trackId}
          onChange={(e) => patch({ trackId: e.target.value }, "Move to track")}
        >
          {p.tracks
            .filter((t) => compatibleTrack(c, t))
            .map((t) => (
              <option value={t.id} key={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      <details open>
        <summary>Timing</summary>
        <div className="two-col">
          <NumberField
            label="Start (s)"
            value={c.start / p.fps}
            min={0}
            step={1 / p.fps}
            onChange={(n) => patch({ start: Math.round(n * p.fps) })}
          />
          <NumberField
            label="Duration (s)"
            value={c.duration / p.fps}
            min={1 / p.fps}
            step={1 / p.fps}
            onChange={(n) => patch({ duration: Math.round(n * p.fps) })}
          />
        </div>
        {asset && asset.kind !== "image" && (
          <div className="two-col">
            <NumberField
              label={c.reverse ? "Source in from end (s)" : "Source in (s)"}
              value={c.sourceIn}
              min={0}
              step={0.01}
              onChange={(n) => patch({ sourceIn: n })}
            />
            <NumberField
              label="Speed"
              value={c.speed}
              min={0.1}
              max={8}
              step={0.1}
              onChange={(n) =>
                patch({
                  speed: n,
                  duration: Math.max(1, Math.floor((c.duration * c.speed) / n)),
                })
              }
            />
          </div>
        )}
        {asset && asset.kind !== "image" && (
          <div className="two-col">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={c.reverse}
                onChange={(e) =>
                  patch(
                    { reverse: e.target.checked },
                    e.target.checked ? "Reverse clip" : "Play clip forward",
                  )
                }
              />
              Reverse
            </label>
            {c.kind === "video" && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={c.freeze}
                  onChange={(e) =>
                    patch(
                      { freeze: e.target.checked },
                      e.target.checked ? "Freeze frame" : "Play frames",
                    )
                  }
                />
                Freeze frame
              </label>
            )}
          </div>
        )}
      </details>
      {c.kind === "audio" ? (
        audioSection(true)
      ) : (
        <details open>
          <summary>Transform</summary>
          <div
            className="stage-align"
            role="group"
            aria-label="Align clip to canvas"
          >
            {(
              [
                ["left", "Left"],
                ["center", "Center X"],
                ["right", "Right"],
                ["top", "Top"],
                ["middle", "Center Y"],
                ["bottom", "Bottom"],
              ] as [Alignment, string][]
            ).map(([alignment, label]) => (
              <button
                key={alignment}
                disabled={frame < c.start || frame >= c.start + c.duration}
                onClick={() =>
                  edit(
                    `Align clip ${label}`,
                    transformCommands(
                      c,
                      alignOnStage(
                        evaluatedClip(c, frame - c.start),
                        p,
                        alignment,
                      ),
                      frame - c.start,
                    ),
                  )
                }
              >
                {label}
              </button>
            ))}
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ratioLocked}
              onChange={(e) => setRatioLocked(e.target.checked)}
            />
            Lock aspect ratio
          </label>
          <div className="two-col">
            <NumberField
              label="X"
              value={c.x}
              onChange={(n) => patch({ x: n })}
            />
            <NumberField
              label="Y"
              value={c.y}
              onChange={(n) => patch({ y: n })}
            />
            <NumberField
              label="Width"
              value={c.width}
              min={ratioLocked ? Math.max(1, c.width / c.height) : 1}
              max={
                ratioLocked ? Math.min(8000, (8000 * c.width) / c.height) : 8000
              }
              onChange={(n) =>
                patch(
                  ratioLocked
                    ? { width: n, height: (n * c.height) / c.width }
                    : { width: n },
                )
              }
            />
            <NumberField
              label="Height"
              value={c.height}
              min={ratioLocked ? Math.max(1, c.height / c.width) : 1}
              max={
                ratioLocked ? Math.min(8000, (8000 * c.height) / c.width) : 8000
              }
              onChange={(n) =>
                patch(
                  ratioLocked
                    ? { height: n, width: (n * c.width) / c.height }
                    : { height: n },
                )
              }
            />
            <NumberField
              label="Rotation"
              value={c.rotation}
              onChange={(n) => patch({ rotation: n })}
            />
            <NumberField
              label="Opacity"
              value={c.opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(n) => patch({ opacity: n })}
            />
          </div>
          {!text && (
            <>
              <label className="field">
                <span>Fit</span>
                <select
                  value={c.fit}
                  onChange={(e) => patch({ fit: e.target.value as any })}
                >
                  <option value="cover">Fill frame</option>
                  <option value="contain">Fit inside</option>
                </select>
              </label>
              <div className="two-col">
                {(["top", "right", "bottom", "left"] as const).map((side) => (
                  <NumberField
                    key={side}
                    label={`Crop ${side} %`}
                    value={c.crop[side]}
                    min={0}
                    max={45}
                    onChange={(n) => patch({ crop: { ...c.crop, [side]: n } })}
                  />
                ))}
              </div>
            </>
          )}
          {(c.kind === "video" || c.kind === "image") && openPanel && (
            <button
              className="inspector-link"
              onClick={() => openPanel("effects")}
            >
              Edit look and color in Effects
            </button>
          )}
        </details>
      )}
      {motion && (
        <MotionInspector
          project={p}
          key={c.motionId}
          motion={motion}
          clip={c}
          frame={frame}
          seek={seek}
          edit={edit}
        />
      )}
      {text && (
        <>
          {c.kind === "caption" && openPanel && (
            <button
              className="inspector-link"
              onClick={() => openPanel("captions")}
            >
              Style all captions in Caption studio
            </button>
          )}
          <div className="two-col">
            <NumberField
              label="Font size"
              value={c.fontSize}
              min={8}
              max={500}
              onChange={(n) => patch({ fontSize: n })}
            />
            <label className="field">
              <span>Weight</span>
              <select
                value={c.fontWeight}
                onChange={(e) => patch({ fontWeight: e.target.value as any })}
              >
                <option value="400">Regular</option>
                <option value="600">Semibold</option>
                <option value="800">Bold</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Typeface</span>
            <select
              value={c.fontFamily}
              onChange={(e) => patch({ fontFamily: e.target.value as any })}
            >
              {["Arial", "Helvetica", "Georgia", "Courier New"].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <div className="two-col">
            <label className="field">
              <span>Color</span>
              <ColorInput
                aria-label="Text color"
                value={c.color}
                onCommit={(color) => patch({ color })}
              />
            </label>
            <label className="field">
              <span>Accent</span>
              <ColorInput
                aria-label="Accent color"
                value={c.accent}
                onCommit={(accent) => patch({ accent })}
              />
            </label>
          </div>
          <label className="field">
            <span>Background</span>
            <div className="row">
              <ColorInput
                aria-label="Text background"
                value={
                  c.background === "transparent" ? "#101112" : c.background
                }
                onCommit={(background) => patch({ background })}
              />
              <button onClick={() => patch({ background: "transparent" })}>
                Clear
              </button>
            </div>
          </label>
          <label className="field">
            <span>Alignment</span>
            <select
              value={c.align}
              onChange={(e) => patch({ align: e.target.value as any })}
            >
              {["left", "center", "right"].map((a) => (
                <option key={a} value={a}>
                  {optionLabel(a)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Animation</span>
            <select
              value={c.preset}
              onChange={(e) => patch({ preset: e.target.value as any })}
            >
              {presets
                .filter((x) => x !== "custom" || !!c.motionId)
                .map((x) => (
                  <option key={x} value={x}>
                    {optionLabel(x)}
                  </option>
                ))}
            </select>
          </label>
          <div className="two-col">
            <NumberField
              label="Animation (s)"
              value={c.animationFrames / p.fps}
              min={1 / p.fps}
              max={20}
              step={0.1}
              onChange={(n) =>
                patch({ animationFrames: Math.max(1, Math.round(n * p.fps)) })
              }
            />
            <label className="field">
              <span>Exit animation</span>
              <select
                aria-label="Exit animation"
                value={c.exitAnimation}
                onChange={(e) =>
                  patch({
                    exitAnimation: e.target.value as Clip["exitAnimation"],
                  })
                }
              >
                {["none", "fade", "slide", "shrink"].map((x) => (
                  <option key={x} value={x}>
                    {optionLabel(x)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {c.kind === "caption" && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={c.highlight}
                  onChange={(e) => patch({ highlight: e.target.checked })}
                />
                Highlight spoken words
              </label>
              <details>
                <summary>Word timing</summary>
                {c.words.map((w, i) => (
                  <div className="word-row" key={i}>
                    <input
                      aria-label={`Word ${i + 1}`}
                      defaultValue={w.text}
                      key={w.text}
                      onBlur={(e) => {
                        const words = structuredClone(c.words);
                        words[i].text = e.target.value;
                        patch(
                          { words, text: words.map((w) => w.text).join(" ") },
                          "Correct caption word",
                        );
                      }}
                    />
                    <NumberField
                      label="Start"
                      value={w.start}
                      step={0.01}
                      onChange={(n) => {
                        const words = structuredClone(c.words);
                        words[i].start = n;
                        patch({ words });
                      }}
                    />
                    <NumberField
                      label="End"
                      value={w.end}
                      step={0.01}
                      onChange={(n) => {
                        const words = structuredClone(c.words);
                        words[i].end = n;
                        patch({ words });
                      }}
                    />
                  </div>
                ))}
              </details>
            </>
          )}
          <button
            className="full subtle"
            onClick={() => {
              const motion = p.motions.find((m) => m.id === c.motionId);
              if (motion) {
                setCode(JSON.stringify(motion, null, 2));
                setCustom(!custom);
              } else {
                const created = MotionSchema.parse({
                  id: uid(),
                  name: "Custom title",
                  layers: [
                    {
                      type: "rectangle",
                      background: c.accent,
                      width: c.width,
                      height: 10,
                      y: c.height - 10,
                      keyframes: [
                        { frame: 0, scale: 0 },
                        { frame: 18, scale: 1 },
                      ],
                    },
                    {
                      type: "text",
                      text: "",
                      width: c.width,
                      height: c.height,
                      color: c.color,
                      fontSize: c.fontSize,
                      keyframes: [
                        { frame: 0, y: 40, opacity: 0 },
                        { frame: 18, y: 0, opacity: 1 },
                      ],
                    },
                  ],
                });
                edit("Create custom animation", [
                  { type: "motion.put", motion: created },
                  {
                    type: "clip.update",
                    id: c.id,
                    patch: { preset: "custom", motionId: created.id },
                  },
                ]);
                setCustom(false);
              }
            }}
          >
            <Sparkles size={14} />
            {c.motionId
              ? "Advanced motion definition"
              : "Create custom animation"}
          </button>
          {custom && (
            <div className="custom-editor">
              <textarea
                aria-label="Motion definition"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                rows={12}
                spellCheck={false}
              />
              <button
                className="primary full"
                onClick={() => {
                  try {
                    const motion = MotionSchema.parse(JSON.parse(code));
                    edit("Create custom animation", [
                      { type: "motion.put", motion },
                      {
                        type: "clip.update",
                        id: c.id,
                        patch: { preset: "custom", motionId: motion.id },
                      },
                    ]);
                    setCustom(false);
                  } catch (e) {
                    report(e);
                  }
                }}
              >
                Apply animation
              </button>
            </div>
          )}
        </>
      )}
      {c.kind !== "audio" && audioSection(false)}
      {(c.kind === "video" || c.kind === "image") && (
        <section className="transition-controls">
          <label className="field">
            <span>Transition from previous clip</span>
            <select
              aria-label="Transition"
              value={c.transition?.kind ?? "none"}
              disabled={!canTransition && !c.transition}
              onChange={(e) =>
                changeTransition(e.target.value as TransitionKind | "none")
              }
            >
              <option value="none">None · hard cut</option>
              {Object.entries(transitionNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {transition && (
            <NumberField
              label="Transition duration (s)"
              value={transition.frames / p.fps}
              min={2 / p.fps}
              max={
                Math.min(c.duration, transition.previous.duration) / 2 / p.fps
              }
              step={1 / p.fps}
              onChange={(seconds) =>
                changeTransition(
                  transition.kind,
                  Math.max(2, Math.min(600, Math.round(seconds * p.fps))),
                )
              }
            />
          )}
          {!transition && (
            <p className="hint">
              {c.transition
                ? "Transition is off because the clips no longer overlap."
                : canTransition
                  ? "Overlaps the previous clip and moves later clips on this track."
                  : "Place this clip right after another video or photo on its track."}
            </p>
          )}
        </section>
      )}
      {c.kind !== "audio" && (
        <details>
          <summary>Compositing</summary>
          <NumberField
            label="Scale"
            value={c.scale}
            min={0.01}
            max={10}
            step={0.05}
            onChange={(scale) => patch({ scale })}
          />
          <label className="field">
            <span>Blend mode</span>
            <select
              aria-label="Blend mode"
              value={c.blendMode}
              onChange={(e) =>
                patch({ blendMode: e.target.value as Clip["blendMode"] })
              }
            >
              {[
                "normal",
                "multiply",
                "screen",
                "overlay",
                "lighten",
                "darken",
              ].map((v) => (
                <option key={v} value={v}>
                  {optionLabel(v)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Mask</span>
            <select
              aria-label="Mask"
              value={c.mask}
              onChange={(e) => patch({ mask: e.target.value as Clip["mask"] })}
            >
              {["none", "ellipse", "rounded"].map((v) => (
                <option key={v} value={v}>
                  {optionLabel(v)}
                </option>
              ))}
            </select>
          </label>
          {c.mask === "rounded" && (
            <NumberField
              label="Corner radius"
              value={c.cornerRadius}
              min={0}
              max={2000}
              onChange={(cornerRadius) => patch({ cornerRadius })}
            />
          )}
          <NumberField
            label="Shadow blur"
            value={c.shadowBlur}
            min={0}
            max={200}
            onChange={(shadowBlur) => patch({ shadowBlur })}
          />
          <div className="two-col">
            <NumberField
              label="Shadow X"
              value={c.shadowX}
              min={-500}
              max={500}
              onChange={(shadowX) => patch({ shadowX })}
            />
            <NumberField
              label="Shadow Y"
              value={c.shadowY}
              min={-500}
              max={500}
              onChange={(shadowY) => patch({ shadowY })}
            />
          </div>
          <label className="field">
            <span>Shadow color</span>
            <ColorInput
              aria-label="Shadow color"
              value={c.shadowColor}
              onCommit={(shadowColor) => patch({ shadowColor })}
            />
          </label>
        </details>
      )}
      {c.kind !== "audio" && (
        <details>
          <summary>Promo accents</summary>
          <NumberField
            label="RGB split (px)"
            value={c.rgbSplit}
            min={0}
            max={30}
            step={0.5}
            onChange={(rgbSplit) => patch({ rgbSplit })}
          />
          <NumberField
            label="Invert colors"
            value={c.invert}
            min={0}
            max={1}
            step={0.05}
            onChange={(invert) => patch({ invert })}
          />
          <p className="hint">
            Animate these in {motion ? "Animate whole clip" : "Keyframes"}{" "}
            below. Use short accents, then return RGB split to 0 for a clear
            hold.
          </p>
          {c.keyframes.some(
            (key) => key.property === "rgbSplit" || key.property === "invert",
          ) && (
            <p className="hint">Animation keys override these base values.</p>
          )}
          <button
            className="control"
            onClick={() =>
              patch({
                rgbSplit: 0,
                invert: 0,
                keyframes: c.keyframes.filter(
                  (key) =>
                    key.property !== "rgbSplit" && key.property !== "invert",
                ),
              })
            }
          >
            Reset promo accents
          </button>
        </details>
      )}
      <KeyframeInspector
        clip={c}
        frame={frame}
        fps={p.fps}
        audible={c.kind === "audio" || !!asset?.hasAudio}
        title={motion ? "Animate whole clip" : "Keyframes"}
        seek={seek}
        edit={edit}
      />
      {asset?.hasAudio && (
        <div className="action-stack">
          <button className="control" onClick={transcribe}>
            Generate subtitles
          </button>
          <button className="control" onClick={pauses}>
            Remove long pauses
          </button>
        </div>
      )}
    </div>
  );
}
