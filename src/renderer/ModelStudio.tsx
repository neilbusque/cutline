import React, { useEffect, useRef, useState } from "react";
import { Box, LoaderCircle, X } from "lucide-react";
import type { Asset, Project } from "../shared/model";
import {
  Model3DSettingsSchema,
  type Model3DSettings,
} from "../shared/model-3d";
import { errorText, keepFocusInside } from "./controls";
import "./model-studio.css";

type RenderedModel = {
  assetId?: string;
  clipId?: string;
  warnings?: string[];
  durationSeconds?: number;
};

export function ModelStudio({
  project,
  asset,
  path,
  name: importedName,
  at,
  onClose,
  onRendered,
}: {
  project: Project;
  asset?: Asset;
  path?: string;
  name?: string;
  at: number;
  onClose: () => void;
  onRendered: (result: RenderedModel) => void;
}) {
  const model = asset?.composition?.model3d;
  const [name, setName] = useState(asset?.name ?? importedName ?? "3D scene");
  const [settings, setSettings] = useState<Model3DSettings>(() =>
    Model3DSettingsSchema.parse(model?.settings ?? {}),
  );
  const [transparent, setTransparent] = useState(
    asset?.composition?.transparent ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<string | undefined>(undefined);
  const dialog = useRef<HTMLElement>(null);
  const initial = useRef({ name, settings, transparent });
  const original = useRef({
    projectId: project.id,
    assetId: asset?.id,
    sourceHash: asset?.composition?.sourceHash,
  });
  const latest = useRef(project);
  latest.current = project;
  const changed =
    name !== initial.current.name ||
    transparent !== initial.current.transparent ||
    JSON.stringify(settings) !== JSON.stringify(initial.current.settings);
  const patch = <K extends keyof Model3DSettings>(
    key: K,
    value: Model3DSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      if (request.current)
        void window.cutline
          .invoke("model3d.cancel", { requestId: request.current })
          .catch(() => {});
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const close = () => {
    if (busy) return;
    if (changed && !window.confirm("Discard your unrendered 3D changes?"))
      return;
    onClose();
  };
  const render = async () => {
    setBusy(true);
    setError("");
    try {
      const current = latest.current;
      if (current.id !== original.current.projectId)
        throw Error(
          "A different project is open. Close this scene and try again.",
        );
      if (original.current.assetId) {
        const existing = current.assets.find(
          (item) => item.id === original.current.assetId,
        );
        if (!existing?.composition?.model3d)
          throw Error(
            "This 3D scene changed or was removed. Close it and open it again.",
          );
        if (existing.composition.sourceHash !== original.current.sourceHash)
          throw Error(
            "This scene changed while you were editing. Reopen it to use the latest version.",
          );
      }
      const validated = Model3DSettingsSchema.safeParse(settings);
      if (!validated.success)
        throw Error(
          validated.error.issues.map((issue) => issue.message).join(" "),
        );
      if (!asset && !path) throw Error("Choose a GLB or glTF model first.");
      const result = await window.cutline.invoke("model3d.render", {
        requestId: (request.current = crypto.randomUUID()),
        projectId: current.id,
        revision: current.revision,
        action: asset ? "update" : "import",
        ...(original.current.assetId
          ? {
              assetId: original.current.assetId,
              expectedSourceHash: original.current.sourceHash,
            }
          : { path, at: { frame: at } }),
        settings: validated.data,
        ...(!asset || name !== initial.current.name
          ? { name: name.trim() }
          : {}),
        ...(!asset || transparent !== initial.current.transparent
          ? { transparent }
          : {}),
      });
      onRendered(result ?? {});
      onClose();
    } catch (e) {
      const message = errorText(e);
      setError(
        /cancel/i.test(message)
          ? "Render stopped. Your settings are still here."
          : message,
      );
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const number = (
    key: keyof Pick<
      Model3DSettings,
      | "durationSeconds"
      | "rotationDegrees"
      | "cameraAzimuth"
      | "cameraElevation"
      | "cameraDistance"
      | "animationSpeed"
      | "exposure"
    >,
    label: string,
    min: number,
    max: number,
    step = 1,
    disabled = false,
  ) => (
    <label className="field stack">
      <span>{label}</span>
      <input
        type="number"
        value={Number.isFinite(settings[key]) ? settings[key] : ""}
        min={min}
        max={max}
        step={step}
        disabled={busy || disabled}
        onChange={(e) => patch(key, e.currentTarget.valueAsNumber)}
      />
    </label>
  );
  const fileName = (path ?? model?.file ?? "").split(/[\\/]/).pop();
  const hasAnimations = !model || model.animations.length > 0;
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="settings-modal model-studio"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-heading"
        ref={dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            if (!busy && name.trim()) void render();
          }
          keepFocusInside(e);
        }}
      >
        <div className="section-heading">
          <h2 id="model-heading">
            <Box size={18} />
            {asset ? "Edit 3D scene" : "Import 3D model"}
          </h2>
          <button
            aria-label="Close 3D editor"
            title="Close"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p className="model-file" title={fileName}>
          {fileName}
        </p>
        <div className="model-fields">
          <label className="field stack model-name">
            <span>Name</span>
            <input
              value={name}
              maxLength={100}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {number("durationSeconds", "Duration (s)", 0.1, 120, 0.1)}
        </div>
        <fieldset className="model-section" disabled={busy}>
          <legend>Motion</legend>
          <div className="model-fields">
            <label className="field stack">
              <span>Movement</span>
              <select
                aria-label="Movement"
                value={settings.motion}
                onChange={(e) =>
                  patch("motion", e.target.value as Model3DSettings["motion"])
                }
              >
                <option value="turntable">Turntable</option>
                <option value="orbit">Camera orbit</option>
                <option value="static">Still camera</option>
              </select>
            </label>
            {number(
              "rotationDegrees",
              "Travel (degrees)",
              -1440,
              1440,
              1,
              settings.motion === "static",
            )}
          </div>
        </fieldset>
        <fieldset className="model-section" disabled={busy}>
          <legend>Camera</legend>
          <div className="model-fields model-three-fields">
            {number("cameraAzimuth", "Angle (degrees)", -360, 360)}
            {number("cameraElevation", "Height (degrees)", -85, 85)}
            {number("cameraDistance", "Distance", 0.25, 5, 0.05)}
          </div>
        </fieldset>
        <fieldset className="model-section" disabled={busy}>
          <legend>Model animation</legend>
          <div className="model-fields">
            <label className="field stack">
              <span>Animation</span>
              <select
                aria-label="Animation"
                value={hasAnimations ? settings.animationIndex : -1}
                disabled={!hasAnimations}
                onChange={(e) =>
                  patch("animationIndex", Number(e.target.value))
                }
              >
                <option value={-1}>None</option>
                {model ? (
                  model.animations.map((animation, index) => (
                    <option key={index} value={index}>
                      {animation || `Animation ${index + 1}`}
                    </option>
                  ))
                ) : (
                  <option value={0}>First animation, if present</option>
                )}
              </select>
            </label>
            {number(
              "animationSpeed",
              "Playback speed",
              0.1,
              4,
              0.1,
              !hasAnimations || settings.animationIndex < 0,
            )}
          </div>
          <label className="model-check">
            <input
              type="checkbox"
              checked={settings.loop}
              disabled={!hasAnimations || settings.animationIndex < 0}
              onChange={(e) => patch("loop", e.target.checked)}
            />
            Loop animation
          </label>
        </fieldset>
        <fieldset className="model-section" disabled={busy}>
          <legend>Appearance</legend>
          <div className="model-fields">
            {number("exposure", "Exposure", 0.1, 4, 0.1)}
            <label className="field stack">
              <span>Background</span>
              <input
                type="color"
                value={settings.background}
                disabled={transparent}
                onChange={(e) => patch("background", e.target.value)}
              />
            </label>
          </div>
          <label className="model-check">
            <input
              type="checkbox"
              checked={transparent}
              onChange={(e) => setTransparent(e.target.checked)}
            />
            Transparent background
          </label>
        </fieldset>
        {error && (
          <p className="model-error" role="alert">
            {error}
          </p>
        )}
        <div className="model-footer">
          <span role="status">
            {busy ? "Rendering locally…" : "Model and settings stay editable"}
          </span>
          <div>
            {busy && (
              <button
                className="control"
                onClick={async () => {
                  if (!request.current) return;
                  try {
                    await window.cutline.invoke("model3d.cancel", {
                      requestId: request.current,
                    });
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                Stop render
              </button>
            )}
            <button
              className="control primary"
              disabled={busy || !name.trim()}
              onClick={() => void render()}
            >
              {busy && <LoaderCircle size={14} className="spin" />}
              {busy
                ? "Rendering…"
                : asset
                  ? "Render changes"
                  : "Add to timeline"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
