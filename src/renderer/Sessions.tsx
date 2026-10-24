import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Copy,
  LoaderCircle,
  Plus,
  RefreshCw,
  PanelsTopLeft,
  X,
} from "lucide-react";
import { errorText, keepFocusInside } from "./controls";
import "./sessions.css";

type Session = {
  id: string;
  name: string;
  projectName?: string;
  projectId?: string;
  running: boolean;
  active?: boolean;
};
type SessionList = { currentId: string; sessions: Session[] };

/** Each window and external assistant keeps its own project and session. */
export function Sessions() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SessionList>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const request = useRef(0);
  const live = useRef(true);
  const current = list?.sessions.find(
    (session) => session.id === list.currentId,
  );

  const load = useCallback(async (visible = false) => {
    const version = ++request.current;
    if (visible) setLoading(true);
    try {
      const value: SessionList = await window.cutline.invoke("sessions.list");
      if (live.current && version === request.current) {
        setList(value);
        if (visible) setError("");
      }
    } catch (error) {
      if (live.current && version === request.current)
        setError(errorText(error));
    } finally {
      if (live.current && version === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => {
      live.current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    void load(true);
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const refresh = setInterval(() => void load(), 4000);
    return () => {
      clearInterval(refresh);
      trigger.current?.focus();
    };
  }, [open, load]);

  const act = async (
    action: "create" | "open" | "copyPrompt",
    sessionId?: string,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action === "open" ? sessionId! : action);
    setError("");
    setCopied(false);
    try {
      await window.cutline.invoke(
        `sessions.${action}`,
        action === "create"
          ? { name: name.trim() || undefined }
          : action === "open"
            ? { sessionId }
            : undefined,
      );
      if (!live.current) return;
      if (action === "copyPrompt") setCopied(true);
      else {
        if (action === "create") setName("");
        setOpen(false);
        void load();
      }
    } catch (error) {
      if (live.current) setError(errorText(error));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy("");
    }
  };

  return (
    <>
      <button
        ref={trigger}
        className="sessions-trigger"
        aria-label={`Sessions${current ? `: ${current.name}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "sessions-panel" : undefined}
        title={current ? `Sessions · ${current.name}` : "Sessions"}
        onClick={() => setOpen((value) => !value)}
      >
        <PanelsTopLeft size={15} />
        <span>{current?.name ?? "Sessions"}</span>
        <ChevronDown size={12} />
      </button>
      {open &&
        createPortal(
          <div className="sessions-backdrop" onClick={() => setOpen(false)}>
            <section
              ref={panel}
              className="sessions-panel"
              id="sessions-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="sessions-heading"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                } else keepFocusInside(event);
              }}
            >
              <div className="sessions-heading">
                <h2 id="sessions-heading">Sessions</h2>
                <button
                  className="icon-button"
                  aria-label="Close sessions"
                  onClick={() => setOpen(false)}
                >
                  <X size={17} />
                </button>
              </div>
              <p className="sessions-intro">
                Make different videos at the same time. Each session has its own
                project, assistant, and jobs.
              </p>
              <div className="sessions-list" aria-busy={loading}>
                {!list && !error && (
                  <p className="sessions-empty">Loading sessions…</p>
                )}
                {list?.sessions.map((session) => {
                  const isCurrent = session.id === list.currentId;
                  return (
                    <button
                      key={session.id}
                      className={`sessions-item${isCurrent ? " current" : ""}`}
                      aria-label={
                        isCurrent
                          ? `${session.name}, current session`
                          : `${session.running || session.active ? "Show" : "Reopen"} ${session.name}`
                      }
                      aria-current={isCurrent ? "true" : undefined}
                      disabled={!!busy}
                      onClick={() =>
                        isCurrent
                          ? setOpen(false)
                          : void act("open", session.id)
                      }
                    >
                      <span
                        className={`sessions-dot${session.running ? " running" : ""}`}
                      />
                      <span className="sessions-item-info">
                        <strong>{session.name}</strong>
                        <small>{session.projectName || "New project"}</small>
                      </span>
                      <span className="sessions-item-state">
                        {busy === session.id ? (
                          <LoaderCircle size={13} className="spin" />
                        ) : isCurrent ? (
                          <>
                            <Check size={12} /> This window
                          </>
                        ) : session.running ? (
                          "Show"
                        ) : session.active ? (
                          "Connecting…"
                        ) : (
                          "Reopen"
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              <form
                className="sessions-new"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act("create");
                }}
              >
                <label htmlFor="session-name">New session</label>
                <div className="sessions-new-row">
                  <input
                    id="session-name"
                    placeholder="Name (optional)"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={80}
                    disabled={!!busy}
                    autoComplete="off"
                  />
                  <button className="primary" type="submit" disabled={!!busy}>
                    {busy === "create" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    New session
                  </button>
                </div>
              </form>
              <div className="sessions-codex">
                <strong>One Codex chat per video</strong>
                <p>
                  Paste this session’s prompt into a separate Codex chat to
                  connect it to this window.
                </p>
                <button
                  className="control"
                  disabled={!!busy || !current}
                  onClick={() => void act("copyPrompt")}
                >
                  {busy === "copyPrompt" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : copied ? (
                    <Check size={14} />
                  ) : (
                    <Copy size={14} />
                  )}
                  {copied ? "Copied session prompt" : "Copy Codex prompt"}
                </button>
                {copied && (
                  <p className="sessions-copied" role="status">
                    Ready to paste into your Codex chat.
                  </p>
                )}
              </div>
              {error && (
                <div className="sessions-error" role="alert">
                  <p>{error}</p>
                  <button
                    disabled={loading || !!busy}
                    onClick={() => void load(true)}
                  >
                    <RefreshCw size={13} /> Retry
                  </button>
                </div>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
