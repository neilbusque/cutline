import React, { useEffect, useRef, useState } from "react";
import { Code2, LoaderCircle, X } from "lucide-react";
import type { Asset, Project } from "../shared/model";
import {
  hyperframesStarter,
  sceneStarters,
  type SceneStarter,
} from "../shared/hyperframes-starters";
import { errorText, keepFocusInside } from "./controls";
import "./hyperframes.css";

export function HyperframesStudio({
  project,
  asset,
  at,
  onClose,
  onRendered,
}: {
  project: Project;
  asset?: Asset;
  at: number;
  onClose: () => void;
  onRendered: (result: {
    assetId?: string;
    clipId?: string;
    warnings?: string[];
  }) => void;
}) {
  const [starter, setStarter] = useState<SceneStarter>("title");
  const [name, setName] = useState(asset?.name ?? "Title reveal");
  const [source, setSource] = useState(
    asset?.composition?.source ?? hyperframesStarter("title", project),
  );
  const [transparent, setTransparent] = useState(
    asset?.composition?.transparent ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<string | undefined>(undefined);
  const dialog = useRef<HTMLElement>(null);
  const initial = useRef({ source, name, transparent });
  const original = useRef({
    projectId: project.id,
    assetId: asset?.id,
    sourceHash: asset?.composition?.sourceHash,
  });
  const latest = useRef(project);
  latest.current = project;
  const changed =
    source !== initial.current.source ||
    name !== initial.current.name ||
    transparent !== initial.current.transparent;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      if (request.current)
        void window.cutline
          .invoke("hyperframes.cancel", { requestId: request.current })
          .catch(() => {});
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const close = () => {
    if (busy) return;
    if (changed && !window.confirm("Discard your unrendered scene changes?"))
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
        if (!existing?.composition)
          throw Error(
            "This scene was removed. Close the source editor and open it again.",
          );
        if (existing.composition.sourceHash !== original.current.sourceHash)
          throw Error(
            "This scene changed while you were editing. Copy your draft, then reopen the scene to use its latest source.",
          );
      }
      const result = await window.cutline.invoke("hyperframes.render", {
        requestId: (request.current = crypto.randomUUID()),
        projectId: current.id,
        revision: current.revision,
        action: asset ? "update" : "import",
        ...(original.current.assetId
          ? {
              assetId: original.current.assetId,
              expectedSourceHash: original.current.sourceHash,
            }
          : { at: { frame: at } }),
        html: source,
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
          ? "Render stopped. Your source changes are still here."
          : message,
      );
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="settings-modal hyperframes-studio"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scene-heading"
        ref={dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            if (!busy && name.trim() && source.trim()) void render();
          }
          keepFocusInside(e);
        }}
      >
        <div className="section-heading">
          <h2 id="scene-heading">
            <Code2 size={18} />
            {asset ? "Edit scene" : "New scene"}
          </h2>
          <button
            aria-label="Close scene editor"
            title="Close"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <div className="scene-options">
          <label className="field stack">
            <span>Name</span>
            <input
              value={name}
              maxLength={100}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {!asset && (
            <label className="field stack">
              <span>Starting point</span>
              <select
                value={starter}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.value as SceneStarter;
                  if (
                    source !== hyperframesStarter(starter, project) &&
                    !window.confirm(
                      "Replace the current source with this starting point?",
                    )
                  )
                    return;
                  setStarter(next);
                  setSource(hyperframesStarter(next, project));
                  setName(sceneStarters.find((item) => item.id === next)!.name);
                }}
              >
                {sceneStarters.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label className="scene-source-label" htmlFor="scene-source">
          HTML source
        </label>
        <textarea
          id="scene-source"
          className="scene-source"
          value={source}
          disabled={busy}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={1_000_000}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              const field = e.currentTarget;
              const start = field.selectionStart;
              const end = field.selectionEnd;
              setSource(source.slice(0, start) + "  " + source.slice(end));
              requestAnimationFrame(() =>
                field.setSelectionRange(start + 2, start + 2),
              );
            }
          }}
        />
        <div className="scene-footer">
          <label className="scene-transparency">
            <input
              type="checkbox"
              checked={transparent}
              disabled={busy}
              onChange={(e) => setTransparent(e.target.checked)}
            />
            Transparent background
          </label>
          {busy && (
            <button
              className="control"
              onClick={async () => {
                if (!request.current) return;
                try {
                  await window.cutline.invoke("hyperframes.cancel", {
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
            disabled={busy || !name.trim() || !source.trim()}
            onClick={() => void render()}
          >
            {busy && <LoaderCircle size={14} className="spin" />}
            {busy
              ? "Rendering scene…"
              : asset
                ? "Render changes"
                : "Add to timeline"}
          </button>
        </div>
        <p className="scene-note">
          {busy
            ? "Rendering locally. Your current timeline stays available."
            : "Source stays editable after rendering. Clear the scene background to export transparency."}
        </p>
        {error && (
          <p className="scene-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
