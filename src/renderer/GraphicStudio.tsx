import React, { useEffect, useMemo, useState } from "react";
import { Thumbnail } from "@remotion/player";
import { Sparkles, X } from "lucide-react";
import { Film } from "../composition/Video";
import { newProject, type Project } from "../shared/model";
import type { Command } from "../shared/commands";
import { parseEditableSvg } from "../shared/vector-path";
import { createVectorScene } from "../shared/vector-scenes";
import { vectorStyles, type VectorStyle } from "../shared/vector-generation";
import { placePicture, type GraphicResult } from "../shared/graphics";
import { plural } from "../shared/plural";
import { GENERATION_SETTINGS_EVENT } from "./HiggsfieldSettings";
import { errorText } from "./controls";
import type { Playhead } from "./playhead";
import "./motion.css";

type Generated = GraphicResult & { assetId?: string };
type Step = "drawing" | "reviewing" | "picture";

const providers = [
  ["claude", "Claude"],
  ["chatgpt", "ChatGPT"],
] as const;
const aspects = [
  ["square", "Square"],
  ["wide", "Wide"],
  ["tall", "Tall"],
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
 * Generate > Graphic: Claude or ChatGPT, signed in on this Mac, draws an
 * editable graphic from a sentence. Higgsfield only paints the subjects too
 * detailed to draw, or when asked.
 */
export function GraphicStudio({
  p,
  playhead,
  edit,
  select,
  mediaBase,
  openSettings,
}: {
  p: Project;
  playhead: Playhead;
  edit: (label: string, commands: Command[]) => Promise<boolean>;
  select: (id: string) => void;
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
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  // Higgsfield connected: offers a picture as the fallback for a drawing.
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

  const generate = async (route: "auto" | "vector" | "picture" = "auto") => {
    if (generating || prompt.trim().length < 2) return;
    setGenerating(true);
    setStep(route === "picture" ? "picture" : "drawing");
    setResult(undefined);
    setNote("");
    setError("");
    try {
      setResult(
        await window.cutline.invoke("graphic.generate", {
          prompt: prompt.trim(),
          style,
          aspect,
          provider,
          route,
          onto: `video with a ${p.background} background`,
        }),
      );
    } catch (failure) {
      if (!/Cancelled/u.test(String(failure))) setError(errorText(failure));
    } finally {
      setGenerating(false);
    }
  };
  const addGenerated = async () => {
    if (!result) return;
    setError("");
    try {
      const name =
        prompt.trim().replace(/\s+/gu, " ").slice(0, 60) || "Generated graphic";
      const at = playhead.get();
      let clipId: string;
      if (result.kind === "picture") {
        const asset = p.assets.find((item) => item.id === result.assetId);
        if (!asset)
          throw Error("The picture is no longer in Media. Generate it again.");
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
      setError(errorText(failure));
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
    <div className="library-content graphic-studio">
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
        {error && (
          <p className="mg-error" role="alert">
            {error}
          </p>
        )}
        {error && pictures && !generating && (
          <button
            className="vs-link vs-switch"
            onClick={() => void generate("picture")}
          >
            Make it a picture with Higgsfield instead
          </button>
        )}
        {result && !generating && (
          <div className="vs-result">
            {result.kind === "vector" ? (
              <VectorPreview svg={result.svg} />
            ) : (
              <div
                className="vs-preview vs-picture"
                aria-label="Generated picture preview"
              >
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
              <button
                className="vs-link vs-switch"
                onClick={() => void generate("picture")}
              >
                Make it a picture with Higgsfield instead
              </button>
            )}
            {result.kind === "vector" &&
              !pictures &&
              openSettings &&
              result.note && (
                <button className="vs-link vs-switch" onClick={openSettings}>
                  Open Settings
                </button>
              )}
            {result.kind === "picture" &&
              (result.drawing ? (
                <button
                  className="vs-link vs-switch"
                  onClick={() =>
                    setResult({
                      kind: "vector",
                      ...result.drawing!,
                      attempts: 0,
                    })
                  }
                >
                  Use the drawing instead
                </button>
              ) : (
                <button
                  className="vs-link vs-switch"
                  onClick={() => void generate("vector")}
                >
                  Draw it as a vector instead
                </button>
              ))}
          </div>
        )}
        {note && (
          <p className="mg-sequence-result" role="status">
            {note}
          </p>
        )}
      </section>
    </div>
  );
}
