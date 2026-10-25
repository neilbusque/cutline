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
  AudioLines,
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
import { errorText } from "./controls";
import { STOCK_SETTINGS_EVENT } from "./StockSettings";

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
const labelFor = (kind: StockKind) =>
  kind === "image" ? "photos" : kind === "audio" ? "audio" : "videos";

export function StockLibrary({
  active = true,
  addBroll,
  report,
  openSettings,
}: {
  active?: boolean;
  addBroll: (asset: Asset) => Promise<void>;
  report: (error: unknown) => void;
  /** The Pexels key lives in Settings with the other keys. */
  openSettings: () => void;
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
  const [quota, setQuota] = useState<StockQuota>();
  const request = useRef(0),
    mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Connecting or disconnecting Pexels in Settings refreshes this panel.
    const refresh = () =>
      api
        .invoke("stock.settings")
        .then((value) => {
          if (mounted.current) setSettings(value);
        })
        .catch((error) => {
          if (mounted.current) setMessage(errorText(error));
        });
    refresh();
    window.addEventListener(STOCK_SETTINGS_EVENT, refresh);
    return () => {
      mounted.current = false;
      request.current++;
      window.removeEventListener(STOCK_SETTINGS_EVENT, refresh);
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
        setMessage(errorText(error));
    } finally {
      if (request.current === id && mounted.current) setBusy(false);
    }
  }

  function changeFilters(patch: Partial<Filters>) {
    const updated = { ...filters, ...patch };
    if (
      patch.provider &&
      patch.provider !== "openverse" &&
      updated.kind === "audio"
    )
      updated.kind = "image";
    if (patch.kind === "video" && updated.provider === "openverse")
      updated.provider = "commons";
    if (updated.kind === "audio") {
      updated.provider = "openverse";
      updated.orientation = "all";
    }
    if (updated.provider === "openverse" && updated.kind === "video")
      updated.kind = "image";
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
            ? item.kind === "audio"
              ? "Sound effect added at the playhead. Adjust its level in Properties."
              : item.kind === "image"
                ? "Photo added at the playhead with a slow zoom."
                : "Muted B-roll added at the playhead."
            : "Downloaded to your media library.",
        );
    } catch (error) {
      if (mounted.current) setMessage(errorText(error));
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
        <button
          className={filters.kind === "audio" ? "active" : ""}
          aria-pressed={filters.kind === "audio"}
          onClick={() => changeFilters({ kind: "audio" })}
        >
          <AudioLines size={14} /> Audio
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
            placeholder={
              filters.kind === "audio"
                ? "Click, paper, transition…"
                : "Coffee, city, ocean…"
            }
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
            <option value="openverse">Openverse</option>
          </select>
        </label>
        <label>
          Orientation
          <select
            disabled={filters.kind === "audio"}
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

      {filters.provider === "openverse" && (
        <p className="library-note">
          Key-free photos and sounds. Attribution stays with each import. Review
          the source license before publishing.
        </p>
      )}
      {filters.provider === "pexels" && (
        <div className="stock-connect stock-connect-line">
          {settings?.pexelsConfigured ? (
            <button
              className="stock-attribution"
              onClick={() => openSource("https://www.pexels.com/")}
            >
              Photos &amp; videos provided by Pexels <ExternalLink size={11} />
            </button>
          ) : (
            <span>Connect Pexels in Settings to search.</span>
          )}
          <button onClick={openSettings}>
            {settings?.pexelsConfigured ? "Manage" : "Open Settings"}
          </button>
        </div>
      )}

      {filters.provider === "commons" && (
        <p className="library-note">
          Each result shows its license. Some need credit.
        </p>
      )}
      {!searched && !busy && !needsKey && (
        <div className="stock-topics">
          {(filters.kind === "audio"
            ? ["Click", "Paper", "Footsteps", "Impact", "Water", "Wind"]
            : ["Coffee", "City", "Ocean", "Nature", "Food", "Travel"]
          ).map((topic) => (
            <button
              key={topic}
              onClick={() => {
                setQuery(topic);
                void search(topic);
              }}
            >
              {topic}
            </button>
          ))}
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
              className={`stock-preview ${item.kind === "image" ? "stock-photo" : item.kind === "audio" ? "stock-audio" : ""}`}
            >
              {preview === item.key ? (
                <>
                  {item.kind === "audio" ? (
                    <audio
                      src={item.preview}
                      controls
                      autoPlay
                      onError={() =>
                        setMessage(
                          "Audio preview unavailable. Open the source page or choose another sound.",
                        )
                      }
                    />
                  ) : item.kind === "image" ? (
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
                    {item.kind === "audio"
                      ? `${item.duration.toFixed(1)}s`
                      : `${item.kind === "video" ? `${Math.round(item.duration)}s · ` : ""}${item.width} × ${item.height}`}
                  </small>
                </button>
              )}
            </div>
            <strong title={item.title}>{item.title}</strong>
            <button
              className="stock-author stock-credit-link"
              onClick={() => openSource(item.page)}
            >
              {item.kind === "image"
                ? "Photo"
                : item.kind === "audio"
                  ? "Audio"
                  : "Video"}{" "}
              by {item.creator}
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
                  item.kind === "audio"
                    ? "Adds audible audio on a separate Sound effects track at the playhead"
                    : item.kind === "image"
                      ? "Adds a 4-second shot with a slow zoom at the playhead"
                      : "Adds a muted clip above your video at the playhead"
                }
                onClick={() => void download(item, true)}
              >
                {item.kind === "image"
                  ? "Add photo"
                  : item.kind === "audio"
                    ? "Add audio"
                    : "Add B-roll"}
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
