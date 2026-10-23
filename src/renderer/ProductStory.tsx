import React, { useState } from "react";
import { ArrowRight, Check, MonitorPlay, Play, Type } from "lucide-react";
import type { Asset } from "../shared/model";
import type { StoryPlan, StoryScene } from "../shared/story-schema";
import { productBrand, productLayouts } from "../shared/product-scenes";

type Recipe = "launch" | "walkthrough" | "type-led";
type Design = NonNullable<StoryScene["design"]>;
type Brand = NonNullable<StoryPlan["brand"]>;
const recipes: {
  id: Recipe;
  name: string;
  description: string;
  layout: Design["layout"];
}[] = [
  {
    id: "launch",
    name: "Launch film",
    description: "A bold opening, product reveal, and clear next step.",
    layout: "title",
  },
  {
    id: "walkthrough",
    name: "Product walkthrough",
    description: "Show your screens and explain one feature at a time.",
    layout: "split",
  },
  {
    id: "type-led",
    name: "Type-led teaser",
    description: "Make your message move. No footage needed.",
    layout: "features",
  },
];

function LayoutDiagram({ layout }: { layout: Design["layout"] }) {
  return (
    <span className={`product-layout-diagram is-${layout}`} aria-hidden="true">
      <span className="diagram-copy">
        <i />
        <i />
        <i />
      </span>
      <span className="diagram-media">
        <i />
        <i />
        <i />
      </span>
      {layout === "cta" && <span className="diagram-button" />}
      {layout === "quote" && <b>“</b>}
    </span>
  );
}

export function ProductFilmSetup({
  story,
  onRecipe,
  onBrand,
}: {
  story: StoryPlan;
  onRecipe: (recipe: Recipe) => void;
  onBrand: (brand: Brand) => void;
}) {
  const [pending, setPending] = useState<Recipe>();
  const brand = story.brand ?? productBrand;
  const hasDesign = story.scenes.some((scene) => scene.design);
  return (
    <details
      className="story-product-film"
      open={hasDesign && !story.explainer}
    >
      <summary>
        <MonitorPlay size={15} aria-hidden="true" />
        <strong>Product film</strong>
        <span>Type · screens · motion</span>
      </summary>
      <p className="story-hint">
        Turn a launch or product walkthrough into an editable film. Start with a
        recipe, then make it yours.
      </p>
      <div className="product-recipes" aria-label="Product film recipes">
        {recipes.map((recipe) => (
          <button
            key={recipe.id}
            className={pending === recipe.id ? "is-selected" : ""}
            aria-label={`Use ${recipe.name} recipe`}
            onClick={() => {
              if (story.scenes.length) setPending(recipe.id);
              else onRecipe(recipe.id);
            }}
          >
            <LayoutDiagram layout={recipe.layout} />
            <span>
              <strong>{recipe.name}</strong>
              <small>{recipe.description}</small>
            </span>
            <ArrowRight size={13} aria-hidden="true" />
          </button>
        ))}
      </div>
      {pending && (
        <div className="story-warning product-recipe-confirm" role="status">
          <p>
            Use {recipes.find((recipe) => recipe.id === pending)?.name}? This
            replaces the {story.scenes.length} scenes in your storyline. Your
            timeline changes only when you rebuild.
          </p>
          <div>
            <button
              className="control"
              onClick={() => {
                onRecipe(pending);
                setPending(undefined);
              }}
            >
              Replace storyline with recipe
            </button>
            <button onClick={() => setPending(undefined)}>
              Keep current storyline
            </button>
          </div>
        </div>
      )}
      {(hasDesign || story.brand) && (
        <details className="product-brand" open>
          <summary>Brand &amp; colors</summary>
          <label className="story-field">
            Brand name
            <input
              aria-label="Product brand name"
              value={brand.name}
              maxLength={80}
              onChange={(event) =>
                onBrand({ ...brand, name: event.target.value })
              }
            />
          </label>
          <div className="product-brand-colors">
            {(
              [
                ["accent", "Accent"],
                ["background", "Background"],
                ["foreground", "Text"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="color"
                  aria-label={`Product ${label.toLowerCase()} color`}
                  value={brand[key]}
                  onChange={(event) =>
                    onBrand({ ...brand, [key]: event.target.value })
                  }
                />
                <small>{brand[key].toUpperCase()}</small>
              </label>
            ))}
          </div>
          <p className="story-hint">
            Colors apply to every designed scene. Your on-screen copy stays
            editable on the timeline.
          </p>
        </details>
      )}
    </details>
  );
}

export function ProductLayoutPicker({
  scene,
  onChange,
}: {
  scene: StoryScene;
  onChange: (design: StoryScene["design"]) => void;
}) {
  return (
    <div className="product-scene-layout">
      <div className="story-section-heading">
        <h3>
          <Type size={13} aria-hidden="true" />
          Visual layout
        </h3>
      </div>
      <div
        className="product-layout-options"
        role="radiogroup"
        aria-label="Scene visual layout"
      >
        <label
          className={`product-media-choice${!scene.design ? " is-selected" : ""}`}
        >
          <input
            type="radio"
            name={`layout-${scene.id}`}
            aria-label="Use full-frame media"
            checked={!scene.design}
            onChange={() => onChange(undefined)}
          />
          <MonitorPlay size={16} aria-hidden="true" />
          <span>Full-frame media</span>
          {!scene.design && <Check size={12} aria-hidden="true" />}
        </label>
        {productLayouts.map((layout) => (
          <label
            key={layout.id}
            className={scene.design?.layout === layout.id ? "is-selected" : ""}
            title={layout.description}
          >
            <input
              type="radio"
              name={`layout-${scene.id}`}
              aria-label={`Use ${layout.name} layout`}
              checked={scene.design?.layout === layout.id}
              onChange={() =>
                onChange({
                  headline: "",
                  eyebrow: "",
                  body: "",
                  points: [],
                  motion: "smooth",
                  ...scene.design,
                  layout: layout.id,
                })
              }
            />
            <LayoutDiagram layout={layout.id} />
            <span>{layout.name}</span>
          </label>
        ))}
      </div>
      <p className="story-hint">
        {scene.design
          ? productLayouts.find((layout) => layout.id === scene.design?.layout)
              ?.description
          : "Use a video or image as the scene’s visual."}
      </p>
    </div>
  );
}

export function ProductScenePreview({
  scene,
  brand: savedBrand,
  asset,
  base,
  aspectRatio = 16 / 9,
}: {
  scene: StoryScene;
  brand?: Brand;
  asset?: Asset;
  base: string;
  aspectRatio?: number;
}) {
  const [replay, setReplay] = useState(0);
  const design = scene.design;
  if (!design) return null;
  const brand = savedBrand ?? productBrand;
  const editorial =
    design.layout === "editorial" || design.layout === "editorial-quote";
  const image =
    asset &&
    (asset.kind === "image"
      ? `${base}/media/${asset.id}`
      : asset.thumbnail
        ? `${base}/media/${asset.id}/thumb`
        : undefined);
  return (
    <div className="product-preview-block">
      <div className="product-preview-caption">
        <span>Layout preview</span>
        <button
          aria-label="Preview scene motion"
          onClick={() => setReplay((value) => value + 1)}
        >
          <Play size={11} aria-hidden="true" />
          Preview motion
        </button>
      </div>
      <div
        className={`product-scene-preview is-${design.layout}${aspectRatio <= 1 ? " is-portrait" : ""}`}
        role="img"
        aria-label={`${productLayouts.find((layout) => layout.id === design.layout)?.name} layout preview: ${design.headline || scene.title}`}
        style={
          {
            "--product-accent": brand.accent,
            "--product-background": brand.background,
            "--product-foreground": brand.foreground,
            "--product-duration":
              design.motion === "snappy"
                ? "450ms"
                : design.motion === "minimal"
                  ? "300ms"
                  : "900ms",
            aspectRatio,
          } as React.CSSProperties
        }
      >
        <span className="product-preview-brand">{brand.name}</span>
        <div
          key={replay}
          className={`product-preview-content${replay ? " is-playing" : ""} motion-${design.motion}`}
        >
          {editorial ? (
            <div className="product-preview-editorial">
              {design.eyebrow && <small>{design.eyebrow}</small>}
              <div className="product-preview-paper">
                <strong>{design.headline || scene.title}</strong>
                {design.layout === "editorial" && design.points[0] && (
                  <span className="product-preview-cutout">
                    {design.points[0]}
                  </span>
                )}
              </div>
              {design.body && <p>{design.body}</p>}
            </div>
          ) : (
            <div className="product-preview-copy">
              {design.eyebrow && <small>{design.eyebrow}</small>}
              <strong>
                {design.layout === "quote" ? "“" : ""}
                {design.headline || scene.title}
                {design.layout === "quote" ? "”" : ""}
              </strong>
              {design.body && <p>{design.body}</p>}
              {["features", "process", "comparison"].includes(
                design.layout,
              ) && (
                <div className="product-preview-points">
                  {design.points
                    .filter(Boolean)
                    .slice(0, design.layout === "comparison" ? 2 : 3)
                    .map((point, index) => (
                      <span key={index}>
                        <i>{index + 1}</i>
                        {point}
                      </span>
                    ))}
                </div>
              )}
              {design.layout === "cta" && (
                <span className="product-preview-button">
                  <ArrowRight size={13} />
                </span>
              )}
            </div>
          )}
          {(design.layout === "screen" || design.layout === "split") && (
            <div className="product-preview-screen">
              <div>
                <i />
                <i />
                <i />
              </div>
              {image ? (
                <img src={image} alt="" />
              ) : (
                <span>
                  <MonitorPlay size={22} />
                  <small>Add a screen or video in Produce</small>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="story-hint">
        Build the sequence to preview the full animation on your canvas.
      </p>
    </div>
  );
}

export function ProductCopyEditor({
  scene,
  onChange,
}: {
  scene: StoryScene;
  onChange: (design: Design) => void;
}) {
  const design = scene.design;
  if (!design) return null;
  return (
    <div className="product-copy-fields">
      <div className="story-section-heading">
        <h3>On-screen copy</h3>
        <span className="story-hint">Separate from voiceover</span>
      </div>
      <label className="story-field">
        Headline
        <textarea
          aria-label="On-screen headline"
          rows={2}
          maxLength={180}
          placeholder={scene.title || "One clear message"}
          value={design.headline}
          onChange={(event) =>
            onChange({ ...design, headline: event.target.value })
          }
        />
      </label>
      <label className="story-field">
        Eyebrow
        <input
          aria-label="On-screen eyebrow"
          maxLength={80}
          placeholder="A short label above the headline"
          value={design.eyebrow}
          onChange={(event) =>
            onChange({ ...design, eyebrow: event.target.value })
          }
        />
      </label>
      <label className="story-field">
        Supporting text
        <textarea
          aria-label="On-screen supporting text"
          rows={2}
          maxLength={500}
          value={design.body}
          placeholder="Add detail, attribution, or a web address"
          onChange={(event) =>
            onChange({ ...design, body: event.target.value })
          }
        />
      </label>
      {["features", "process", "comparison"].includes(design.layout) &&
        (design.layout === "comparison" ? [0, 1] : [0, 1, 2]).map((index) => (
          <label key={index} className="story-field">
            {design.layout === "process"
              ? "Step"
              : design.layout === "comparison"
                ? "Side"
                : "Feature"}{" "}
            {index + 1}
            <input
              aria-label={`${design.layout === "process" ? "Process step" : design.layout === "comparison" ? "Comparison side" : "Feature point"} ${index + 1}`}
              maxLength={140}
              value={design.points[index] ?? ""}
              onChange={(event) => {
                const points = Array.from(
                  { length: Math.max(index + 1, design.points.length) },
                  (_, item) => design.points[item] ?? "",
                );
                points[index] = event.target.value;
                onChange({ ...design, points });
              }}
            />
          </label>
        ))}
      {design.layout === "editorial" && (
        <label className="story-field">
          Cutout label
          <input
            aria-label="Editorial cutout label"
            maxLength={140}
            value={design.points[0] ?? ""}
            onChange={(event) =>
              onChange({
                ...design,
                points: [event.target.value, ...design.points.slice(1)],
              })
            }
          />
        </label>
      )}
      <label className="story-field">
        Motion pace
        <select
          aria-label="Scene motion pace"
          value={design.motion}
          onChange={(event) =>
            onChange({
              ...design,
              motion: event.target.value as Design["motion"],
            })
          }
        >
          <option value="smooth">Smooth · calm reveals</option>
          <option value="snappy">Snappy · quick entrances</option>
          <option value="minimal">Minimal · gentle fades</option>
        </select>
      </label>
    </div>
  );
}
