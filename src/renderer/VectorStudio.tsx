import React, { useEffect, useState } from "react";
import { Globe, Search } from "lucide-react";
import type { Project } from "../shared/model";
import { errorText } from "./controls";
import type { Playhead } from "./playhead";

type LogoMatch = { title: string; slug: string; color: string };

const logoColors = [
  ["brand", "Brand"],
  ["white", "White"],
  ["black", "Black"],
] as const;

/** Bring in the real logos and pages a video talks about. */
export function VectorStudio({
  p,
  playhead,
  select,
  onError,
}: {
  p: Project;
  playhead: Playhead;
  select: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Results remember the text they answer, so a quick click never adds the
  // previous search's logo.
  const [found, setFound] = useState<{ query: string; matches: LogoMatch[] }>({
    query: "",
    matches: [],
  });
  const matches = found.query === query.trim() ? found.matches : [];
  const [logoColor, setLogoColor] =
    useState<(typeof logoColors)[number][0]>("brand");
  const [url, setUrl] = useState("");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [working, setWorking] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      window.cutline
        .invoke("reference.search", { query: text })
        .then(
          (result: LogoMatch[]) =>
            live && setFound({ query: text, matches: result ?? [] }),
        )
        .catch(() => live && setFound({ query: text, matches: [] }));
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const fail = (failure: unknown) => onError(errorText(failure));

  const addReference = async (args: Record<string, unknown>, label: string) => {
    if (working) return;
    setWorking(label);
    setNote("");
    onError("");
    try {
      const added = await window.cutline.invoke("reference.add", {
        projectId: p.id,
        revision: p.revision,
        at: { frame: playhead.get() },
        ...args,
      });
      if (added?.clipId) select(added.clipId);
      setNote(
        `${added?.title ?? "Reference"} added at ${(playhead.get() / p.fps).toFixed(1)}s.`,
      );
    } catch (failure) {
      fail(failure);
    } finally {
      setWorking("");
    }
  };
  const capture = () => {
    let address = url.trim();
    if (!address) return;
    if (!/^https?:\/\//iu.test(address)) address = `https://${address}`;
    void addReference(
      { kind: "screenshot", target: address, phone: device === "phone" },
      "Capturing the page…",
    );
  };

  const segmented = <T extends string>(
    label: string,
    options: readonly (readonly [T, string])[],
    value: T,
    change: (value: T) => void,
  ) => (
    <fieldset className="vs-segmented">
      <legend>{label}</legend>
      <div>
        {options.map(([id, name]) => (
          <button
            key={id}
            aria-pressed={value === id}
            onClick={() => change(id)}
          >
            {name}
          </button>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className="vs-studio">
      <section className="vs-section" aria-labelledby="vs-logos">
        <div className="section-heading">
          <span id="vs-logos">Brand logos</span>
        </div>
        <label className="search-field">
          <Search size={13} />
          <input
            aria-label="Search brand logos"
            placeholder="Claude, Cursor, ChatGPT, n8n…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {segmented("Color", logoColors, logoColor, setLogoColor)}
        {matches.length > 0 && (
          <ul className="vs-matches" aria-label="Matching logos">
            {matches.map((match) => (
              <li key={match.slug}>
                <button
                  disabled={!!working}
                  onClick={() =>
                    void addReference(
                      {
                        kind: "logo",
                        target: match.title,
                        color: logoColor,
                      },
                      `Adding ${match.title}…`,
                    )
                  }
                >
                  <i
                    style={{ background: match.color || "var(--fill)" }}
                    aria-hidden="true"
                  />
                  <span>{match.title}</span>
                  <small>
                    {match.slug.startsWith("site:")
                      ? match.slug.slice(5)
                      : "Vector"}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim().length >= 2 &&
          found.query === query.trim() &&
          !matches.length &&
          (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/iu.test(query.trim()) ? (
            <button
              className="import-button control"
              disabled={!!working}
              onClick={() =>
                void addReference(
                  { kind: "logo", target: query.trim(), color: logoColor },
                  `Getting the logo from ${query.trim()}…`,
                )
              }
            >
              Add the logo from {query.trim()}
            </button>
          ) : (
            <p className="mg-sequence-hint">
              Not in the library. Type its website, such as gamma.app, to use
              the logo from its site.
            </p>
          ))}
      </section>

      <section className="vs-section" aria-labelledby="vs-page">
        <div className="section-heading">
          <span id="vs-page">Page screenshot</span>
        </div>
        <label className="search-field">
          <Globe size={13} />
          <input
            aria-label="Page address"
            placeholder="github.com/owner/repo"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && capture()}
          />
        </label>
        <div className="vs-row">
          {segmented(
            "View",
            [
              ["desktop", "Desktop"],
              ["phone", "Phone"],
            ] as const,
            device,
            setDevice,
          )}
        </div>
        <button
          className="import-button control"
          disabled={!url.trim() || !!working}
          onClick={capture}
        >
          Capture and add
        </button>
      </section>

      {working && (
        <p className="mg-sequence-hint" role="status">
          {working}
        </p>
      )}
      {note && (
        <p className="mg-sequence-result" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
