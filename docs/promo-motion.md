# Editable promo direction

Cutline's `promo` director style supports reference-inspired advertising with bold typography, impact/hold pacing, palette changes and purposeful scale transitions. Read it with `cutline_director_guide {"style":"promo"}`. This is reusable direction and native editing capability, not model training or an automatic reproduction of a source film.

## Native building blocks

The Motion library includes four editable starting compositions:

| Scene | Intended use |
| --- | --- |
| `promo-punch` | A short headline arrives with a decisive change of scale, then settles. |
| `promo-stack` | A compact phrase develops through stacked lines and holds as one thought. |
| `promo-invert` | A deliberate dark/light composition change punctuates a message. |
| `promo-zoom` | A readable headline moves into a scale-through bridge. |

Each composition uses named native text and shape layers with editable animation. Discover the installed catalog with `cutline_editing_schema` section `guide`, under `values.motionScenes`; older app versions may not include these scenes. Read section `action:motion.scene`, create the chosen scene with the current project ID and revision, then refine its returned layers with `motion.layer.update` and `motion.keyframe`. Set `durationFrames` when creating the scene to retime its choreography; changing a clip's duration alone changes its visible span.

Clip effects add keyframeable `rgbSplit` (0–30 clip pixels, scaled with the clip) and `invert` (0–1). Read the current `clipPatch` and `clipKeyframe` schemas for supported fields. These effects belong to the clip, not individual motion layers. Use brief color separation around an impact and return to zero for the hold. A held inversion can be an intentional palette decision; repeated full-frame flashing is not the default. Preview how inversion affects source footage, skin tones and logos before applying it broadly.

Place real footage under the editable titles. An opaque scene background covers underlying media; inspect the named layers and hide only its background if a transparent overlay is wanted. Native motion does not supply physical objects, 3D lighting, material reflections or a moving 3D camera. Those require appropriate imported footage or another authorized asset workflow.

## Reference evidence

The user supplied `nolimitvmgcasino.mp4` through Dropbox and requested a capability upgrade, not a finished derivative video. The local source metadata is 1920×1080, 30 fps, approximately 25.03 seconds, H.264 video and AAC audio. The visual review used a contact sheet sampled at roughly one frame per second and a denser eight-frame-per-second sheet covering approximately 15–18 seconds. These samples establish visible composition changes, not exact edit boundaries or continuous movement quality.

| Approximate source span | Observed in sampled frames | Reusable direction decision |
| --- | --- | --- |
| Opening, about 0–2 seconds | A dark roulette image with separated color edges leads to a large, heavy white headline over objects. | Pair one strong subject with a concise headline; reserve RGB separation for a selected impact. |
| About 2–9 seconds | Chips, slot imagery, roulette and a phone alternate behind short benefit labels. Type varies between centered, stacked and widely spaced compositions. | Alternate subject scale and type composition when the message changes. Keep claims original and verified. |
| About 9–14 seconds | Black-on-white title cards interrupt darker object footage; compact stacked headlines become the dominant subject. | Use a deliberate palette reversal and complete phrase hold to vary the rhythm. |
| About 15–18 seconds | A large subject/type frame scales out, a small phrase builds on black, the complete phrase holds, color-separated/glitch samples precede a light field, and oversized blurred type leads to the next object shot. | Build an editable sequence of impact, phrase development, clean hold and scale-through exit. Exact easing and sound synchronization remain unverified. |
| Closing, about 20–25 seconds | A short invitation leads to a contact/identity frame and fade. | Resolve on one user-supplied identity and next action with enough stable reading time. |

The source has casino objects, persistent corner logos, contact details and advertising promises. These are observations of that reference, not defaults or assets for new projects. Do not transfer its branding, claims, phone number, music or complete sequence into another user's film. The new native presets use original placeholder copy and shapes.

No continuous audio audition was performed for this reference study. Do not describe its musical genre, exact beat grid, sound accents, mix quality or voice timing as verified. No exact transition easing was measured from the samples.

## Applying the direction

Choose an original visual system and write a short beat sheet before filling the timeline. A useful starting point is 2–4 seconds per message, occasional 0.3–0.8 second visual inserts, and a longer closing hold. At 30 fps, try 4–8 frame impacts and 6–10 frame exits, then adjust to actual readability and source/audio timing. These ranges are design choices, not measurements of the reference.

Keep essential copy settled and readable for at least 1.5 seconds, longer for dense copy or a call to action. A phrase can build quickly only if the complete thought gets a readable hold. Alternate clean and energetic beats. Constant glitch, perpetual zooming and decorative headline underlines are not required by this style.

Inspect the entrance, maximum travel, settled hold, exit and adjacent frames around each significant cut. Use `cutline_preview` with `image:true` in batches of at most 12 frames. Run `cutline_quality_check`, then perform actual visual/audio review where available; structural success does not certify timing, sound or taste. Analyze chosen music before syncing cuts and preserve actual speech timing. When export is requested, save the editable project and wait for the export job to complete before verifying its output.
