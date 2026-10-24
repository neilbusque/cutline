import React, { useEffect, useRef, useState } from "react";
import {
  Search,
  Download,
  ExternalLink,
  LoaderCircle,
  Play,
  X,
  Image as ImageIcon,
  Film,
  KeyRound,
  Check,
} from "lucide-react";
import type {
  StockItem,
  StockResults,
  StockProvider,
  StockKind,
  StockOrientation,
  StockCredentialStatus,
  StockQuota,
} from "../shared/stock";
import type { Asset } from "../shared/model";

type Filters = {
  provider: StockProvider;
  kind: StockKind;
  orientation: StockOrientation;
};
const defaults: Filters = {
  provider: "commons",
  kind: "video",
  orientation: "all",
};
const labelFor = (kind: StockKind) => (kind === "image" ? "photos" : "videos");

export function StockLibrary({
  active = true,
  addBroll,
  report,
}: {
  active?: boolean;
  addBroll: (asset: Asset) => Promise<void>;
  report: (error: unknown) => void;
}) {
  const api = window.cutline;
  const [query, setQuery] = useState(""),
    [searched, setSearched] = useState("");
  const [filters, setFilters] = useState<Filters>(defaults);
  const [items, setItems] = useState<StockItem[]>([]),
    [next, setNext] = useState<number>();
  const [busy, setBusy] = useState(false),
    [downloading, setDownloading] = useState<string>();
  const [preview, setPreview] = useState<string>(),
    [message, setMessage] = useState("");
  const [settings, setSettings] = useState<StockCredentialStatus>();
  const [key, setKey] = useState(""),
    [configuring, setConfiguring] = useState(false),
    [showKey, setShowKey] = useState(false);
  const [quota, setQuota] = useState<StockQuota>();
  const request = useRef(0),
    mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    api
      .invoke("stock.settings")
      .then((value) => {
        if (mounted.current) setSettings(value);
      })
      .catch((error) => {
        if (mounted.current) setMessage((error as Error).message);
      });
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);

  useEffect(() => {
    if (!active) setPreview(undefined);
  }, [active]);

  async function search(term = query, offset = 0, selection = filters) {
    if (!term.trim()) return;
    const id = ++request.current;
    setBusy(true);
    setMessage("");
    setPreview(undefined);
    if (!offset) {
      setItems([]);
      setNext(undefined);
      setQuota(undefined);
    }
    try {
      const result: StockResults = await api.invoke("stock.search", {
        query: term,
        offset,
        ...selection,
      });
      if (request.current !== id || !mounted.current) return;
      const results = result.items ?? result.videos;
      setSearched(term);
      setItems((previous) =>
        offset
          ? [
              ...new Map(
                [...previous, ...results].map((item) => [item.key, item]),
              ).values(),
            ]
          : results,
      );
      setNext(result.next);
      setQuota(result.quota);
      if (!results.length)
        setMessage(
          result.next !== undefined
            ? "No matches on this page. Load more or try All orientations."
            : `No ${labelFor(selection.kind)} found. Try a broader search or another orientation.`,
        );
    } catch (error) {
      if (request.current === id && mounted.current)
        setMessage((error as Error).message);
    } finally {
      if (request.current === id && mounted.current) setBusy(false);
    }
  }

  function changeFilters(patch: Partial<Filters>) {
    const updated = { ...filters, ...patch };
    setFilters(updated);
    request.current++;
    setItems([]);
    setNext(undefined);
    setPreview(undefined);
    setMessage("");
    setBusy(false);
    setQuota(undefined);
    if (updated.provider === "pexels" && !settings?.pexelsConfigured) return;
    if (searched) void search(searched, 0, updated);
  }

  async function configure() {
    setConfiguring(true);
    setMessage("");
    try {
      const result: StockCredentialStatus = await api.invoke(
        "stock.configure",
        { key },
      );
      setKey("");
      setShowKey(false);
      setSettings(result);
      setMessage("Pexels connected. Search photos and videos above.");
      if (searched && filters.provider === "pexels") void search(searched);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setKey("");
      setConfiguring(false);
    }
  }

  async function disconnect() {
    setConfiguring(true);
    setMessage("");
    try {
      const result: StockCredentialStatus =
        await api.invoke("stock.disconnect");
      setSettings(result);
      setKey("");
      request.current++;
      setItems([]);
      setNext(undefined);
      setBusy(false);
      setQuota(undefined);
      setMessage("Pexels key removed. Wikimedia Commons is ready to use.");
      setFilters({ ...filters, provider: "commons" });
      setSearched("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setConfiguring(false);
    }
  }

  async function download(item: StockItem, place: boolean) {
    setDownloading(item.key);
    setMessage("");
    try {
      const asset: Asset = await api.invoke("stock.download", {
        id: item.id,
        provider: item.provider,
        kind: item.kind,
      });
      if (place) await addBroll(asset);
      if (mounted.current)
        setMessage(
          place
            ? item.kind === "image"
              ? "Photo added at the playhead with a slow zoom."
              : "Muted B-roll added at the playhead."
            : "Downloaded to your media library.",
        );
    } catch (error) {
      report(error);
      if (mounted.current) setMessage((error as Error).message);
    } finally {
      if (mounted.current) setDownloading(undefined);
    }
  }

  const needsKey = filters.provider === "pexels" && !settings?.pexelsConfigured;
  const openSource = (url: string) =>
    api.invoke("stock.source", { url }).catch(report);

  return (
    <div className="library-content stock-library">
      <div className="section-heading">
        <span>Stock media</span>
      </div>
      <div
        className="stock-kind-tabs pill-tabs"
        role="group"
        aria-label="Stock media type"
      >
        <button
          className={filters.kind === "video" ? "active" : ""}
          aria-pressed={filters.kind === "video"}
          onClick={() => changeFilters({ kind: "video" })}
        >
          <Film size={14} /> B-roll videos
        </button>
        <button
          className={filters.kind === "image" ? "active" : ""}
          aria-pressed={filters.kind === "image"}
          onClick={() => changeFilters({ kind: "image" })}
        >
          <ImageIcon size={14} /> Photos
        </button>
      </div>
      <form
        className="stock-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="search-field library-search">
          <Search size={14} />
          <input
            aria-label={`Search stock ${labelFor(filters.kind)}`}
            placeholder="Coffee, city, ocean…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !query.trim() || needsKey}
          aria-label={`Search stock ${labelFor(filters.kind)}`}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Search size={15} />
          )}
        </button>
      </form>
      <div className="stock-filters">
        <label>
          Source
          <select
            aria-label="Stock provider"
            value={filters.provider}
            onChange={(event) =>
              changeFilters({ provider: event.target.value as StockProvider })
            }
          >
            <option value="commons">Wikimedia</option>
            <option value="pexels">Pexels</option>
          </select>
        </label>
        <label>
          Orientation
          <select
            aria-label="Stock orientation"
            value={filters.orientation}
            onChange={(event) =>
              changeFilters({
                orientation: event.target.value as StockOrientation,
              })
            }
          >
            <option value="all">All</option>
            <option value="portrait">Vertical</option>
            <option value="landscape">Landscape</option>
            <option value="square">Square</option>
          </select>
        </label>
      </div>

      {filters.provider === "pexels" && (
        <div className="stock-connect">
          <button
            className="stock-attribution"
            onClick={() => openSource("https://www.pexels.com/")}
          >
            Photos &amp; videos provided by Pexels <ExternalLink size={11} />
          </button>
          {settings?.pexelsConfigured ? (
            <div className="stock-connected">
              <span>
                <Check size={12} /> API key saved
              </span>
              <button disabled={configuring} onClick={() => void disconnect()}>
                Disconnect
              </button>
            </div>
          ) : (
            <>
              <p className="library-note">
                Add a free Pexels key to search. It is saved encrypted on this
                Mac.
              </p>
              {settings?.storageError && (
                <p className="library-note" role="status">
                  {settings.storageError}
                </p>
              )}
              {!showKey ? (
                <button className="full" onClick={() => setShowKey(true)}>
                  <KeyRound size={13} /> Connect Pexels
                </button>
              ) : (
                <form
                  className="stock-key-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void configure();
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
                  />
                  <div>
                    <button
                      type="button"
                      onClick={() => openSource("https://www.pexels.com/api/")}
                    >
                      Get a free key <ExternalLink size={11} />
                    </button>
                    <button
                      type="submit"
                      className="primary"
                      disabled={configuring || !key.trim()}
                    >
                      {configuring ? "Saving…" : "Save key"}
                    </button>
                  </div>
                  {settings?.secureStorageAvailable === false && (
                    <p className="library-note">
                      Unlock your macOS keychain to save a key securely.
                    </p>
                  )}
                </form>
              )}
            </>
          )}
        </div>
      )}

      {filters.provider === "commons" && (
        <p className="library-note">
          Each result shows its license. Some need credit.
        </p>
      )}
      {!searched && !busy && !needsKey && (
        <div className="stock-topics">
          {["Coffee", "City", "Ocean", "Nature", "Food", "Travel"].map(
            (topic) => (
              <button
                key={topic}
                onClick={() => {
                  setQuery(topic);
                  void search(topic);
                }}
              >
                {topic}
              </button>
            ),
          )}
        </div>
      )}
      <div className="stock-providers">
        <button onClick={() => api.invoke("stock.credits").catch(report)}>
          Export credits
        </button>
        {filters.provider === "commons" && (
          <button
            onClick={() =>
              api
                .invoke("stock.browse", { provider: "pexels", query })
                .catch(report)
            }
          >
            Browse Pexels <ExternalLink size={11} />
          </button>
        )}
      </div>
      {quota?.remaining !== undefined && (
        <p className="stock-quota">
          {quota.remaining.toLocaleString()} Pexels requests remaining
        </p>
      )}
      {message && (
        <p className="library-note stock-status" role="status">
          {message}
        </p>
      )}
      {busy && !items.length && (
        <div className="stock-loading" role="status">
          <LoaderCircle size={18} className="spin" /> Finding{" "}
          {labelFor(filters.kind)}…
        </div>
      )}

      <div className="stock-results">
        {items.map((item) => (
          <article className="stock-result" key={item.key}>
            <div
              className={`stock-preview ${item.kind === "image" ? "stock-photo" : ""}`}
            >
              {preview === item.key ? (
                <>
                  {item.kind === "image" ? (
                    <img
                      src={item.preview}
                      alt={item.title}
                      onError={() =>
                        setMessage(
                          "Preview unavailable. Open the source page or choose another photo.",
                        )
                      }
                    />
                  ) : (
                    <video
                      src={item.preview}
                      controls
                      autoPlay
                      muted
                      playsInline
                      onError={() =>
                        setMessage(
                          "Preview unavailable. Open the source page or download this clip.",
                        )
                      }
                    />
                  )}
                  <button
                    aria-label={`Close preview ${item.title}`}
                    className="stock-close"
                    onClick={() => setPreview(undefined)}
                  >
                    <X size={13} />
                  </button>
                </>
              ) : (
                <button
                  aria-label={`Preview ${item.title}`}
                  onClick={() => setPreview(item.key)}
                >
                  {item.thumbnail && (
                    <img src={item.thumbnail} alt="" loading="lazy" />
                  )}
                  <span>
                    {item.kind === "image" ? (
                      <ImageIcon size={20} />
                    ) : (
                      <Play size={20} />
                    )}
                  </span>
                  <small>
                    {item.kind === "video"
                      ? `${Math.round(item.duration)}s · `
                      : ""}
                    {item.width} × {item.height}
                  </small>
                </button>
              )}
            </div>
            <strong title={item.title}>{item.title}</strong>
            <button
              className="stock-author stock-credit-link"
              onClick={() => openSource(item.page)}
            >
              {item.kind === "image" ? "Photo" : "Video"} by {item.creator}
              {item.provider === "pexels" ? " on Pexels" : ""}{" "}
              <ExternalLink size={10} />
            </button>
            <button
              className="stock-license"
              onClick={() => openSource(item.page)}
            >
              {item.license}
              <ExternalLink size={11} />
            </button>
            <div className="stock-actions">
              <button
                disabled={downloading !== undefined}
                onClick={() => void download(item, false)}
                aria-label={`Download ${item.title} to library`}
              >
                {downloading === item.key ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <Download size={13} />
                )}{" "}
                Library
              </button>
              <button
                className="primary"
                disabled={downloading !== undefined}
                title={
                  item.kind === "image"
                    ? "Adds a 4-second shot with a slow zoom at the playhead"
                    : "Adds a muted clip above your video at the playhead"
                }
                onClick={() => void download(item, true)}
              >
                {item.kind === "image" ? "Add photo" : "Add B-roll"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {next !== undefined && (
        <button
          disabled={busy}
          className="full subtle"
          onClick={() => void search(searched, next)}
        >
          {busy ? "Searching…" : "Load more"}
        </button>
      )}
    </div>
  );
}
