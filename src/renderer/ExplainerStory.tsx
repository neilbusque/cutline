import React, { useState } from "react";
import { ArrowRight, Check, Clapperboard } from "lucide-react";
import {
  explainerStyles,
  type ExplainerInput,
  type ExplainerStyleId,
} from "../shared/explainer";
import type { StoryPlan } from "../shared/story-schema";

export function explainerInputFromStory(story: StoryPlan): ExplainerInput {
  return {
    style: story.explainer?.style ?? "kinetic",
    topic: story.explainer?.topic ?? "",
    script: story.explainer
      ? story.scenes
          .map((scene) => scene.narration)
          .filter(Boolean)
          .join("\n\n")
      : "",
    audience: story.explainer?.audience ?? "",
    cta: story.explainer?.cta ?? "",
  };
}

/** Refresh fields that still match their source, without replacing authored
 * form edits. In particular, choosing only a new style keeps scene edits. */
export function refreshExplainerInput(
  input: ExplainerInput,
  baseline: ExplainerInput,
  source: ExplainerInput,
): ExplainerInput {
  const value = <Key extends keyof ExplainerInput>(key: Key) =>
    input[key] === baseline[key] ? source[key] : input[key];
  return {
    style: value("style"),
    topic: value("topic"),
    script: value("script"),
    audience: value("audience"),
    cta: value("cta"),
  };
}

const example = {
  topic: "Turn an idea into an editable video",
  script:
    "Start with one clear idea. Write what you want to explain in your own words.\n\nChoose a visual style in Cutline. Your script becomes an outline with editable scenes.\n\nRefine the words and add your own screens when the story needs them. Create local narration and captions, then bring the scenes onto the timeline.\n\nPlay it back. Adjust the details. Export a video you can keep making your own.",
  audience: "Creators making their first explainer",
  cta: "Make your next cut with Cutline",
};

function StylePreview({ style }: { style: ExplainerStyleId }) {
  return (
    <span className={`explainer-style-preview is-${style}`} aria-hidden="true">
      {style === "kinetic" && (
        <>
          <b>
            One clear
            <br />
            <em>idea.</em>
          </b>
          <i />
        </>
      )}
      {style === "screen" && (
        <>
          <small>Your product</small>
          <span className="explainer-mini-screen">
            <i />
            <b>Your screen</b>
          </span>
        </>
      )}
      {style === "diagram" && (
        <>
          <small>How it works</small>
          <span className="explainer-mini-flow">
            <i>1</i>
            <span />
            <i>2</i>
            <span />
            <i>3</i>
          </span>
        </>
      )}
      {style === "editorial" && (
        <>
          <i className="explainer-mini-paper" />
          <b>
            Make it
            <br />
            <em>make sense.</em>
          </b>
          <small>A closer look</small>
        </>
      )}
    </span>
  );
}

export function ExplainerStory({
  story,
  input,
  onInput,
  onCreate,
}: {
  story: StoryPlan;
  input: ExplainerInput;
  onInput: (input: ExplainerInput) => void;
  onCreate: (input: ExplainerInput) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const selected = explainerStyles.find((style) => style.id === input.style);
  const change = (patch: Partial<ExplainerInput>) => {
    setConfirm(false);
    onInput({ ...input, ...patch });
  };
  const ready = !!input.topic.trim() && !!input.script.trim();
  return (
    <details
      className="story-explainer"
      open={!story.scenes.length || !!story.explainer}
    >
      <summary>
        <Clapperboard size={15} aria-hidden="true" />
        <strong>Explainer</strong>
        <span>Script to editable video</span>
      </summary>
      <div
        className="explainer-styles"
        role="radiogroup"
        aria-label="Explainer visual style"
      >
        {explainerStyles.map((style) => (
          <label
            key={style.id}
            className={input.style === style.id ? "is-selected" : ""}
          >
            <input
              type="radio"
              name="explainer-style"
              value={style.id}
              checked={input.style === style.id}
              onChange={() => change({ style: style.id })}
            />
            <StylePreview style={style.id} />
            <span>
              <strong>{style.name}</strong>
              {input.style === style.id && (
                <Check size={12} aria-hidden="true" />
              )}
            </span>
            <small>{style.description}</small>
          </label>
        ))}
      </div>
      <label className="story-field">
        Topic or title
        <input
          aria-label="Explainer topic"
          maxLength={120}
          value={input.topic}
          placeholder="What should viewers understand?"
          onChange={(event) => change({ topic: event.target.value })}
        />
      </label>
      <label className="story-field">
        Your script or key points
        <textarea
          aria-label="Explainer script"
          rows={6}
          maxLength={60000}
          value={input.script}
          placeholder="Write what the voice should say. Each line starts a scene. Longer passages split at sentence breaks."
          onChange={(event) => change({ script: event.target.value })}
        />
      </label>
      <p className="story-hint">
        Your words become the narration. Cutline organizes them into scenes you
        can edit.
      </p>
      <details className="explainer-context">
        <summary>Audience &amp; next step</summary>
        <label className="story-field">
          Audience
          <input
            aria-label="Explainer audience"
            maxLength={200}
            value={input.audience ?? ""}
            placeholder="Who is this for?"
            onChange={(event) => change({ audience: event.target.value })}
          />
        </label>
        <label className="story-field">
          Closing action
          <input
            aria-label="Explainer closing action"
            maxLength={160}
            value={input.cta ?? ""}
            placeholder="What should viewers do next?"
            onChange={(event) => change({ cta: event.target.value })}
          />
        </label>
        <p className="story-hint">
          The closing action appears on screen. Add it to your script if you
          want it spoken.
        </p>
      </details>
      {selected?.requiresMedia && (
        <p className="story-hint">
          Product focus needs your real screenshots or recordings. Import and
          choose them for each screen scene in Produce before creating the
          video.
        </p>
      )}
      <div className="explainer-outline-actions panel-action-bar">
        <button
          className="primary"
          disabled={!ready}
          onClick={() =>
            story.scenes.length ? setConfirm(true) : onCreate(input)
          }
        >
          Create outline <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button className="story-inline-action" onClick={() => change(example)}>
          Use Cutline example
        </button>
      </div>
      {confirm && (
        <div className="story-warning product-recipe-confirm" role="status">
          <p>
            Replace your {story.scenes.length} scene outline? Your previous
            draft stays available to restore until you save. The timeline
            changes when you create or rebuild the video.
          </p>
          <div>
            <button
              className="control"
              onClick={() => {
                onCreate(input);
                setConfirm(false);
              }}
            >
              Replace outline
            </button>
            <button onClick={() => setConfirm(false)}>
              Keep current outline
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
