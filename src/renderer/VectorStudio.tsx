import React, { useEffect, useMemo, useState } from "react";
import { Thumbnail } from "@remotion/player";
import { Globe, Search, Sparkles, X } from "lucide-react";
import { Film } from "../composition/Video";
import { newProject, type Project } from "../shared/model";
import type { Command } from "../shared/commands";
import { parseEditableSvg } from "../shared/vector-path";
import { createVectorScene } from "../shared/vector-scenes";
import { vectorStyles, type VectorStyle } from "../shared/vector-generation";
import { placePicture, type GraphicResult } from "../shared/graphics";
import { plural } from "../shared/plural";
import { GENERATION_SETTINGS_EVENT } from "./HiggsfieldSettings";
import type { Playhead } from "./playhead";

type Generated = GraphicResult & { assetId?: string };
type Step = "drawing" | "reviewing" | "picture";
type LogoMatch = { title: string; slug: string; color: string };

const providers = [
  ["claude", "Claude"],
  ["chatgpt", "ChatGPT"],
] as const;
const aspects = [
  ["square", "Square"],
  ["wide", "Wide"],
  ["tall", "Tall"],
] as const;
const logoColors = [
  ["brand", "Brand"],
  ["white", "White"],
  ["black", "Black"],
] as const;

/** The vector exactly as Cutline will draw it, on a neutral board. */
function VectorPreview({ svg }: { svg: string }) {
  const project = useMemo(() => {
    const board = {
      ...newProject(),
      width: 640,
      height: 640,
      background: "#f4f3ef",
    };
    const created = createVectorScene(board, 0, parseEditableSvg(svg), {
      name: "Preview",
    });
    return { ...board, clips: [created.clip], motions: [created.motion] };
  }, [svg]);
  return (
    <div className="vs-preview" aria-label="Generated vector preview">
      <Thumbnail
        component={Film}
        inputProps={{ project, mediaBase: "", preview: true }}
        durationInFrames={project.fps * 4}
        compositionWidth={640}
        compositionHeight={640}
        fps={project.fps}
        frameToDisplay={project.fps * 2}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

/**
 * Make vectors with the assistants signed in on this Mac, and bring in the
 * real logos and pages a video talks about.
 */
export function VectorStudio({
  p,
  playhead,
  edit,
  select,
  onError,
  mediaBase,
  openSettings,
}: {
  p: Project;
  playhead: Playhead;
  edit: (label: string, commands: Command[]) => Promise<boolean>;
  select: (id: string) => void;
  onError: (message: string) => void;
  mediaBase: string;
  openSettings?: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState<VectorStyle>("flat");
  const [aspect, setAspect] = useState<(typeof aspects)[number][0]>("square");
  const [provider, setProvider] =
    useState<(typeof providers)[number][0]>("claude");
  const [generating, setGenerating] = useState(false);
  const [step, setStep] = useState<Step>("drawing");
  const [result, setResult] = useState<Generated>();
  // Higgsfield connected: offers "Make it a picture" on a drawn result.
  const [pictures, setPictures] = useState(false);
  useEffect(() => {
    const refresh = () =>
      window.cutline
        .invoke("graphic.settings")
        .then((value: { connected: boolean }) => setPictures(!!value?.connected))
        .catch(() => setPictures(false));
    refresh();
    window.addEventListener(GENERATION_SETTINGS_EVENT, refresh);
    const off = window.cutline.on("graphic", (event: { step?: Step }) => {
      if (event?.step) setStep(event.step);
    });
    return () => {
      window.removeEventListener(GENERATION_SETTINGS_EVENT, refresh);
      off();
    };
  }, []);
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

  const fail = (failure: unknown) =>
    onError(
      failure instanceof Error
        ? failure.message.replace(
            /^Error invoking remote method '[^']+': (Error: )?/u,
            "",
          )
        : String(failure),
    );

  const generate = async (route: "auto" | "vector" | "picture" = "auto") => {
    if (generating || prompt.trim().length < 2) return;
    setGenerating(true);
    setStep(route === "picture" ? "picture" : "drawing");
    setResult(undefined);
    setNote("");
    onError("");
    try {
      setResult(
        await window.cutline.invoke("graphic.generate", {
          prompt: prompt.trim(),
          style,
          aspect,
          provider,
          route,
        }),
      );
    } catch (failure) {
      if (!/Cancelled/u.test(String(failure))) fail(failure);
    } finally {
      setGenerating(false);
    }
  };
  const addGenerated = async () => {
    if (!result) return;
    try {
      const name =
        prompt.trim().replace(/\s+/gu, " ").slice(0, 60) || "Generated graphic";
      const at = playhead.get();
      let clipId: string;
      if (result.kind === "picture") {
        const asset = p.assets.find((item) => item.id === result.assetId);
        if (!asset) throw Error("The picture is no longer in Media. Generate it again.");
        const placed = placePicture(p, at, asset);
        if (!(await edit(`Add ${name}`, placed.commands))) return;
        clipId = placed.clip.id;
      } else {
        const created = createVectorScene(p, at, parseEditableSvg(result.svg), {
          name,
        });
        if (!(await edit(`Add ${name}`, created.commands))) return;
        clipId = created.clip.id;
      }
      select(clipId);
      setNote(
        result.kind === "picture"
          ? `${name} added at ${(at / p.fps).toFixed(1)}s.`
          : `${name} added at ${(at / p.fps).toFixed(1)}s. Select it to animate its layers or apply a logo reveal.`,
      );
    } catch (failure) {
      fail(failure);
    }
  };
  const drawer = provider === "claude" ? "Claude" : "ChatGPT";
  const progress =
    step === "picture"
      ? "Making a picture with Higgsfield…"
      : step === "reviewing"
        ? `${drawer} is checking the drawing…`
        : `Drawing with ${drawer}…`;
  const summary = (made: Generated) => {
    if (made.kind === "picture")
      return [
        made.reason === "asked"
          ? "Picture made with Higgsfield"
          : "Too detailed for a vector, so Higgsfield made a picture",
        made.usd ? ` for about $${Number(made.usd).toFixed(2)}` : "",
        ". It is in Media.",
        made.cutout ? "" : " Its background could not be removed.",
      ].join("");
    return [
      `${plural(made.layers, "editable layer")}.`,
      made.revised ? ` ${drawer} checked the drawing and refined it.` : "",
      made.warnings.length ? ` ${made.warnings.join(" ")}` : "",
      made.note ? ` ${made.note}` : "",
    ].join("");
  };
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

  const pictureAsset =
    result?.kind === "picture"
      ? p.assets.find((item) => item.id === result.assetId)
      : undefined;
  return (
    <div className="vs-studio">
      <section className="vs-section" aria-labelledby="vs-generate">
        <div className="section-heading">
          <span id="vs-generate">Generate a graphic</span>
        </div>
        <label className="mg-sequence-field">
          <span>Describe it</span>
          <textarea
            aria-label="Describe the graphic"
            rows={3}
            maxLength={2000}
            placeholder="A coffee cup with rising steam"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                void generate();
            }}
          />
        </label>
        <div className="vs-pair">
          <label className="mg-sequence-field">
            <span>Style</span>
            <select
              aria-label="Graphic style"
              value={style}
              onChange={(event) => setStyle(event.target.value as VectorStyle)}
            >
              {vectorStyles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="mg-sequence-field">
            <span>Shape</span>
            <select
              aria-label="Graphic shape"
              value={aspect}
              onChange={(event) =>
                setAspect(event.target.value as (typeof aspects)[number][0])
              }
            >
              {aspects.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {segmented("Drawn by", providers, provider, setProvider)}
        {generating ? (
          <div className="vs-progress" role="status">
            <span>{progress}</span>
            <button
              className="vs-link"
              onClick={() => void window.cutline.invoke("graphic.cancel")}
            >
              <X size={12} /> Cancel
            </button>
          </div>
        ) : (
          <button
            className="import-button primary"
            disabled={prompt.trim().length < 2}
            onClick={() => void generate()}
          >
            <Sparkles size={15} />
            {result ? "Generate again" : "Generate"}
          </button>
        )}
        {result && !generating && (
          <div className="vs-result">
            {result.kind === "vector" ? (
              <VectorPreview svg={result.svg} />
            ) : (
              <div className="vs-preview vs-picture" aria-label="Generated picture preview">
                {pictureAsset && (
                  <img
                    src={`${mediaBase}/media/${pictureAsset.id}/original`}
                    alt=""
                  />
                )}
              </div>
            )}
            <p className="mg-sequence-hint">{summary(result)}</p>
            <button
              className="import-button control"
              onClick={() => void addGenerated()}
            >
              Add to timeline
            </button>
            {result.kind === "vector" && pictures && (
              <button className="vs-link vs-switch" onClick={() => void generate("picture")}>
                Make it a picture with Higgsfield instead
              </button>
            )}
            {result.kind === "vector" && !pictures && openSettings && result.note && (
              <button className="vs-link vs-switch" onClick={openSettings}>
                Open Settings
              </button>
            )}
            {result.kind === "picture" && (
              <button className="vs-link vs-switch" onClick={() => void generate("vector")}>
                Draw it as a vector instead
              </button>
            )}
          </div>
        )}
      </section>

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
          !matches.length && (
            <p className="mg-sequence-hint">
              Not in the library. Type its website below to capture the page, or
              ask the assistant to add the logo from its domain.
            </p>
          )}
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
