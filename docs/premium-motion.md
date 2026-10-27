# Explainer motion

Cutline 0.38 adds reusable native motion tools for informational Shorts, Reels and product explanations. Open **Motion > Scenes**, choose **Explainer motion**, then select a layer to edit its controls. Each scene contains ordinary editable layers and curves.

## Curved motion paths

Open **Motion path**, enable **Follow a curved path**, and set the start, two handles and end. These are offsets from the layer's position. **Animate path** adds progress keys from 0 to 1. Change those keys in **Animate layer > Path progress** to adjust timing, holds or reverse travel.

**Rotate along path** adds the curve's tangent to the layer's rotation. A horizontal arrow therefore faces along the route. Set the layer's rotation to correct a differently oriented source shape. The path uses sampled arc length for approximately constant distance at linear easing. Stroke drawing remains a separate trim curve, so the traveler and route are independently editable.

## Reveals

Open **Reveal mask**, choose a wipe direction or iris, then choose **Animate reveal**. **Mask reveal** runs from fully hidden at 0 to fully visible at 1. The mask clips the complete native layer, including its text, fill and outline, before its transform. Animate it backward to conceal an object.

Wipe right opens from left to right. Wipe left does the opposite. Iris opens from the center. These are geometric masks on an individual layer; another layer cannot yet act as an alpha or luminance matte.

## Number counters

On a text layer, open **Number counter** and enable **Animate a number**. Set the first and last values, start frame, duration, decimal places, text before/after the number, and easing. The counter replaces the layer's text while enabled. Disabling it restores the authored text.

Numbers are calculated from the frame, so seeking, exporting, reopening and looping produce the same values. Decimal formatting is stable across computer locales. Counters preserve their phase when a clip is split or trimmed. Layer timing controls move and stretch counters together with their other animation.

Use sourced numbers for factual claims. The example quantities in the scene collection demonstrate animation and are not business metrics. Count the work contains twenty editable unit layers. When changing its total, update the units as well; changing a counter does not generate or remove shapes.

## Assistants

Read `cutline_effects_guide` and `cutline_editing_schema` section `motionLayer`. Use `motion.scene` for a starting scene, `motion.layer.update` for properties, and `motion.keyframe` for `pathProgress` or `reveal`. Edits remain revision-checked and undoable. Send `motionPath: null` or `counter: null` to disable either feature through JSON; use `revealMask: "none"` to disable a reveal.

```json
{
  "motionPath": {
    "points": [{"x":0,"y":0},{"x":100,"y":-120},{"x":300,"y":120},{"x":400,"y":0}],
    "autoOrient": true
  },
  "pathProgress": 0,
  "revealMask": "wipe-right",
  "reveal": 1
}
```

For a text layer, a counter can be added independently:

```json
{"counter":{"from":0,"to":20,"startFrame":12,"durationFrames":60,"decimals":0,"prefix":"","suffix":" items","easing":"linear"}}
```

Path and reveal progress follow the layer's loop and clip animation phase. Canvas resizing scales path coordinates while preserving progress and timing. Existing projects omit the new optional fields and retain their previous appearance.

## Scope

This release provides native tools inspired by common compositing techniques. It does not import After Effects projects or add arbitrary parent/null hierarchies, alpha/luma track mattes, subject rotoscoping, or physical shutter motion blur. Existing 2.5D transforms, clip-level scene moves, SVG stroke drawing, GLB scenes and HyperFrames can be combined with these tools.

The [dated reference study](motion-reference-library/shorts-study-2026-10-27.md) separates observed techniques from popularity and platform-wide trend claims.
