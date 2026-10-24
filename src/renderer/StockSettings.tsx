import React, { useEffect, useState } from "react";
import { ExternalLink, KeyRound, LoaderCircle } from "lucide-react";
import type { StockCredentialStatus } from "../shared/stock";
import { errorText } from "./controls";
import "./agent-connections.css";

/** The Stock panel listens for this to refresh its Pexels status. */
export const STOCK_SETTINGS_EVENT = "cutline:stock-settings";

/** The Pexels key in Settings, saved encrypted on this Mac. */
export function StockSettings({
  report,
}: {
  report: (error: unknown) => void;
}) {
  const api = window.cutline;
  const [settings, setSettings] = useState<StockCredentialStatus>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    api
      .invoke("stock.settings")
      .then((value: StockCredentialStatus) => live && setSettings(value))
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
      const value: StockCredentialStatus = await api.invoke(
        disconnect ? "stock.disconnect" : "stock.configure",
        disconnect ? undefined : { key: key.trim() },
      );
      setSettings(value);
      // Cleared only once it is saved, so a failed save keeps the pasted key.
      setKey("");
      setNotice(
        disconnect ? "Pexels key removed from this Mac." : "Pexels is connected.",
      );
      window.dispatchEvent(new CustomEvent(STOCK_SETTINGS_EVENT));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ac-group">
        <div className="ac-row">
          <div>
            <strong>Pexels</strong>
            <small>
              {settings?.pexelsConfigured
                ? "Connected. Stock searches Pexels photos and video."
                : "Paste your free API key to search Pexels in Stock."}
            </small>
          </div>
          {settings?.pexelsConfigured ? (
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
                void api
                  .invoke("stock.source", { url: "https://www.pexels.com/api/" })
                  .catch(report)
              }
            >
              Get a free key <ExternalLink size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        {!settings?.pexelsConfigured && (
          <form
            className="ac-row"
            onSubmit={(event) => {
              event.preventDefault();
              void change(false);
            }}
          >
            <input
              type="password"
              aria-label="Pexels API key"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your Pexels API key"
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
              {busy ? "Connecting…" : "Connect Pexels"}
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
    </>
  );
}
