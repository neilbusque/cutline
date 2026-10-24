import React, { useCallback, useEffect, useRef, useState } from "react";
import { FilePlus, FolderOpen, FolderSearch, Trash2, X } from "lucide-react";
import { IconButton, keepFocusInside } from "./controls";

type ProjectSummary = {
  path: string;
  name: string;
  durationSeconds: number;
  clips: number;
  editedAt: string;
  open: boolean;
  inFolder: boolean;
};

/** 1:57 style length. */
export function projectLength(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** Today 4:03 AM, Yesterday 9:10 PM, or Oct 11. */
export function projectEdited(iso: string, now = new Date()) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}
const folderName = (file: string) => file.split("/").slice(-2, -1)[0] ?? "";

/**
 * Every project the person has: the Projects folder and recently opened files
 * elsewhere. Opening one leaves the current project saved in its own file.
 */
export function Projects({
  onClose,
  report,
}: {
  onClose: () => void;
  report: (e: unknown) => void;
}) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const sheet = useRef<HTMLElement>(null);
  const placed = useRef(false);
  const load = useCallback(() => {
    window.cutline
      .invoke("projects.list")
      .then((r: { folder: string; projects: ProjectSummary[] }) => {
        setFolder(r.folder);
        setList(r.projects);
      })
      .catch(report);
  }, [report]);
  // Return opens the highlighted project, as in Finder, never New project:
  // Close holds focus until the list is in, then the first other project.
  const close = () =>
    sheet.current?.querySelector<HTMLElement>(
      'button[aria-label="Close projects"]',
    );
  useEffect(() => {
    load();
    const previous = document.activeElement as HTMLElement | null;
    close()?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [load]);
  useEffect(() => {
    if (list === null || placed.current) return;
    placed.current = true;
    (
      sheet.current?.querySelector<HTMLElement>(
        ".projects-row:not(.current) .projects-open",
      ) ?? close()
    )?.focus();
  }, [list]);
  const act = async (name: string, args?: unknown, close = true) => {
    setBusy(true);
    try {
      const result = await window.cutline.invoke(name, args);
      // A cancelled save prompt or file dialog leaves the sheet open.
      if (close && result !== null) onClose();
      return result;
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const open = (p: ProjectSummary) =>
    p.open ? onClose() : act("projects.open", { path: p.path });
  const trash = async (p: ProjectSummary) => {
    const next = await act("projects.trash", { path: p.path }, false);
    if (next) setList(next);
  };
  // The usual place reads like Finder shows it; any other folder as a short path.
  const shortFolder = /\/Users\/[^/]+\/Movies\/Cutline$/.test(folder)
    ? "Movies › Cutline"
    : folder.replace(/^\/Users\/[^/]+/, "~");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={sheet}
        className="settings-modal projects-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Projects"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          keepFocusInside(e);
        }}
      >
        <div className="section-heading">
          <h2>Projects</h2>
          <div className="projects-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => act("new")}
            >
              <FilePlus size={14} />
              New project
            </button>
            <button
              className="control"
              disabled={busy}
              onClick={() => act("open")}
            >
              <FolderOpen size={14} />
              Open file…
            </button>
            <IconButton title="Close projects" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        </div>
        <p className="projects-note">
          Each project is its own file and keeps saving as you edit. Folder:{" "}
          <button
            className="link"
            onClick={() => act("projects.folder", undefined, false)}
          >
            {shortFolder || "Projects"}
          </button>
        </p>
        {list === null ? (
          <p className="projects-empty">Loading…</p>
        ) : !list.length ? (
          <p className="projects-empty">
            No projects yet. Add media or a title and the project appears here.
          </p>
        ) : (
          <div className="projects-table" role="table" aria-label="Projects">
            <div className="projects-row projects-head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Length</span>
              <span role="columnheader">Edited</span>
              <span role="columnheader">Folder</span>
              <span />
            </div>
            {list.map((p) => (
              <div
                key={p.path}
                className={"projects-row" + (p.open ? " current" : "")}
                role="row"
              >
                <button
                  className="projects-open"
                  role="cell"
                  title={p.open ? "This project is open" : `Open ${p.name}`}
                  disabled={busy}
                  onClick={() => open(p)}
                >
                  <span className="projects-name">{p.name}</span>
                  {p.open && <span className="projects-current">Current</span>}
                </button>
                <span role="cell" className="projects-num">
                  {p.clips ? projectLength(p.durationSeconds) : "Empty"}
                </span>
                <span role="cell">{projectEdited(p.editedAt)}</span>
                <span role="cell" className="projects-folder" title={p.path}>
                  {p.inFolder ? "Projects" : folderName(p.path)}
                </span>
                <span role="cell" className="projects-row-actions">
                  <IconButton
                    title="Show in Finder"
                    onClick={() =>
                      act("projects.reveal", { path: p.path }, false)
                    }
                  >
                    <FolderSearch size={15} />
                  </IconButton>
                  <IconButton
                    title={
                      p.open
                        ? "Open another project to move this one to the Trash"
                        : "Move to Trash"
                    }
                    disabled={p.open || busy}
                    onClick={() => trash(p)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
