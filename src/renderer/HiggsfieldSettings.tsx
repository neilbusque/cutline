import React, { useEffect, useState } from "react";
import { ExternalLink, KeyRound, LoaderCircle } from "lucide-react";
import "./agent-connections.css";

type GenerationSettings = {
  configured: boolean;
  secureStorageAvailable: boolean | null;
  storageError?: string;
};
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
    : String(error);
/** The Generate panel listens for this to refresh its connection state. */
export const GENERATION_SETTINGS_EVENT = "cutline:generation-settings";

/** Video generation in Settings: the Higgsfield key, saved encrypted on this Mac. */
export function HiggsfieldSettings({
  report,
}: {
  report: (error: unknown) => void;
}) {
  const api = window.cutline;
  const [settings, setSettings] = useState<GenerationSettings>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    api
      .invoke("generation.settings")
      .then((value: GenerationSettings) => live && setSettings(value))
      .catch((failure: unknown) => live && setError(errorText(failure)));
    return () => {
      live = false;
    };
  }, []);

  const change = async (disconnect: boolean) => {
    if (busy || (!disconnect && !key.trim())) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value: GenerationSettings = await api.invoke(
        disconnect ? "generation.disconnect" : "generation.configure",
        disconnect ? undefined : { key: key.trim() },
      );
      setSettings(value);
      setNotice(
        disconnect
          ? "Higgsfield key removed from this Mac."
          : "Higgsfield is connected.",
      );
      window.dispatchEvent(new CustomEvent(GENERATION_SETTINGS_EVENT));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setKey("");
      setBusy(false);
    }
  };

  return (
    <div className="agent-connections higgsfield-settings">
      <h3>Video generation</h3>
      <div className="ac-group">
        <div className="ac-row">
          <div>
            <strong>Higgsfield</strong>
            <small>
              {settings?.configured
                ? "Connected. Generate creates clips with your credits."
                : "Paste your API key to create video clips in Generate."}
            </small>
          </div>
          {settings?.configured ? (
            <button
              className="ac-button"
              disabled={busy}
              onClick={() => void change(true)}
            >
              {busy ? "Removing…" : "Disconnect"}
            </button>
          ) : (
            <button
              className="ac-button"
              onClick={() =>
                void api.invoke("generation.openKeys").catch(report)
              }
            >
              Get an API key <ExternalLink size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        {!settings?.configured && (
          <form
            className="ac-row"
            onSubmit={(event) => {
              event.preventDefault();
              void change(false);
            }}
          >
            <input
              type="password"
              aria-label="Higgsfield API key"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your complete API key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              disabled={busy || !settings}
            />
            <button
              type="submit"
              className="ac-button"
              disabled={busy || !settings || !key.trim()}
            >
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <KeyRound size={14} />
              )}
              {busy ? "Connecting…" : "Connect Higgsfield"}
            </button>
          </form>
        )}
      </div>
      {(error ||
        settings?.storageError ||
        settings?.secureStorageAvailable === false) && (
        <p className="ac-note ac-error" role="alert">
          {error ||
            settings?.storageError ||
            "Unlock your macOS keychain to save an API key securely."}
        </p>
      )}
      {notice && !error && (
        <p className="ac-note" role="status">
          {notice}
        </p>
      )}
      <p className="ac-note">
        Saved encrypted on this Mac. Generating uses your Higgsfield credits.
      </p>
    </div>
  );
}
