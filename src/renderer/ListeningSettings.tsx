import React, { useEffect, useState } from "react";
import { errorText } from "./controls";
import "./agent-connections.css";
import "./listening.css";

type ListeningPreferences = { enabled: boolean; autoFix: boolean };

export function ListeningSettings() {
  const [settings, setSettings] = useState<ListeningPreferences>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError("");
    window.cutline
      .invoke("listening.settings")
      .then((value: ListeningPreferences) => live && setSettings(value))
      .catch((failure: unknown) => live && setError(errorText(failure)));
    return () => {
      live = false;
    };
  }, [attempt]);

  const change = async (patch: Partial<ListeningPreferences>) => {
    if (busy || !settings) return;
    setBusy(true);
    setError("");
    try {
      const saved: ListeningPreferences = await window.cutline.invoke(
        "listening.settings.set",
        patch,
      );
      setSettings(saved);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="agent-connections listening-settings"
      aria-labelledby="listening-settings-heading"
      aria-busy={busy || (!settings && !error)}
    >
      <h3 id="listening-settings-heading">Listening review</h3>
      <div className="ac-group">
        <label className="ac-row ac-toggle">
          <div>
            <strong>Review every export</strong>
            <small id="listening-upload-disclosure">
              Sends the full soundtrack to Qwen's hosted audio model to check
              voice, captions, music and sound effects.
            </small>
          </div>
          <input
            type="checkbox"
            aria-label="Review every export"
            aria-describedby="listening-upload-disclosure"
            checked={settings?.enabled ?? false}
            disabled={!settings || busy}
            onChange={(event) => void change({ enabled: event.target.checked })}
          />
        </label>
        <label className="ac-row ac-toggle">
          <div>
            <strong>Apply supported fixes</strong>
            <small id="listening-fixes-description">
              Apply fixes backed by source evidence, then review again. Changes
              can be undone.
            </small>
          </div>
          <input
            type="checkbox"
            aria-label="Apply supported fixes"
            aria-describedby="listening-fixes-description"
            checked={settings?.autoFix ?? false}
            disabled={!settings?.enabled || busy}
            onChange={(event) => void change({ autoFix: event.target.checked })}
          />
        </label>
      </div>
      <p className="listening-review-note">
        The model can be wrong. Unresolved findings stay in the review report.
      </p>
      {!settings && !error && <p role="status">Loading review settings…</p>}
      {error && (
        <div className="listening-settings-error">
          <p className="ac-error" role="alert">
            {error}
          </p>
          {!settings && (
            <button
              className="ac-button"
              onClick={() => setAttempt(attempt + 1)}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </section>
  );
}
