import { z } from "zod";
import { effectsGuide } from "./animation";
import { motionEasings, motionPropertyBounds } from "./motion";
import { shapeTypes } from "./motion-presets";
import { ClipSchema, MotionLayerSchema } from "./model";
import { captionStyles } from "./caption-styles";
import { reelFormats } from "./reel-formats";

/** The values of an enum field, looking through defaults and optionals. */
export function enumOptions(schema: z.ZodType): string[] {
  let current: any = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  )
    current = current.unwrap();
  return current instanceof z.ZodEnum ? [...current.options].map(String) : [];
}

/** cutline_effects_guide: the written guide plus lists generated from the validators. */
export function effectsGuideResult() {
  const clip = ClipSchema.shape,
    layer = MotionLayerSchema.shape;
  const transition = (clip.transition as z.ZodOptional<z.ZodObject>).unwrap()
    .shape as Record<string, z.ZodType>;
  return {
    ...effectsGuide,
    motionReferences: {
      section: "motionReferences",
      read: "Read cutline_editing_schema section motionReferences or cutline_director_guide for dated creator studies, varied visual mechanisms, effects, color and sound. Plan the visible action and payoff before choosing a recipe.",
    },
    explainerMotion: {
      scenes:
        "Motion > Scenes > Explainer motion contains native editable examples of paths, quantities, comparison reveals and detail focus. Use motion.scene, then edit named layers.",
      path: "motionPath.points is exactly four {x,y} cubic Bezier offsets from the layer origin. Animate pathProgress 0..1 for distance-based travel. autoOrient adds the tangent angle to layer rotation. Existing x/y keys remain additional offsets. Points are editable in Motion path; null disables it.",
      reveal:
        "revealMask: wipe-right, wipe-left, wipe-up, wipe-down or iris. Animate reveal 0..1; 0 hides the layer, 1 reveals it fully. This clips one native layer, not a cross-layer alpha matte. Text, fills and outlines use the same mask.",
      counter:
        "Text layer counter: {from,to,startFrame,durationFrames,decimals,prefix,suffix,easing,bezier?}. Values are frame-deterministic and follow loops and clip animationOffset. Counts replace that layer's text; null disables the counter. Use actual sourced data for factual quantities.",
      limits:
        "These features do not add arbitrary parent hierarchies, track mattes, true 3D cameras or physical shutter motion blur. Clip keyframes can move a complete native scene. Imported GLB and HyperFrames remain separate routes.",
    },
    values: {
      layerTypes: enumOptions(layer.type),
      textAnimations: enumOptions(layer.textAnimation),
      motionEasings: [...motionEasings],
      motionProperties: motionPropertyBounds,
      shapeTypes: [...shapeTypes],
      looks: enumOptions(clip.look),
      cameraMotion: enumOptions(clip.cameraMotion),
      overlays: enumOptions(clip.overlay),
      overlayAmount: "0 to 1",
      transitions: ["none", ...enumOptions(transition.kind)],
      captionStyles: captionStyles.map((style) => style.id),
    },
    reel: {
      tool: "cutline_create_reel",
      targets: [15, 30, 60, 90],
      styles: ["clean", "bold", "cinematic"],
      formats: reelFormats,
      requestFormats: {
        "Ali Abdaal": "creator-education",
        "educational storyteller": "creator-education",
        "Nathan Bentley": "creator-punch",
        "podcast short": "creator-punch",
        "Nate Herk": "screen-demo",
        "screen explainer": "screen-demo",
      },
      captionStyles: captionStyles.map(({ id }) => id),
      beats:
        "Optional, at most 24: {sourceIndex, sourceSeconds, text, kind: callout|step|takeaway}. sourceIndex is zero-based in options.sources; sourceSeconds is absolute source-media time, before trim/speed. Text is 1 to 80 characters. Omit for transcript-based format beats; [] disables them. Never invent speech timestamps.",
      proofBeats:
        "Reel Builder/create_reel only, at most 24: {sourceIndex, sourceSeconds, assetId, sourceIn?, durationSeconds, layout: split|cutaway}. Choose actual imported screen evidence. sourceSeconds is absolute speaker source time before trim/speed; sourceIn is the proof video's starting time; durationSeconds is 0.5 to 12 output seconds. Keep each shot inside the used source range with no overlapping proofs. Split shows a large contained screen above the speaker; cutaway shows the screen on an opaque backdrop. Proof media is muted and the original voice continues. Preview the screen, crop and captions together. Auto edit supports the formats but does not accept proofBeats.",
    },
  };
}
