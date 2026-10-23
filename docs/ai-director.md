# Directing films with Cutline

Cutline's built-in assistant and connected editing agents share a filmmaking workflow. `cutline_director_guide` returns practical direction for `cinematic`, `product`, `social` or `promo` work. The default is `cinematic`; an explicit user preference takes precedence over a genre default. The guide lives in `src/shared/director-guide.ts`, and `src/shared/assistant-instructions.ts` tells assistants when and how to use it. For bold type, impact/hold pacing, palette changes and editable promo compositions, see [promo-motion.md](promo-motion.md).

This improves the instructions and review process available to the AI. It does not train or fine-tune model weights, and it does not guarantee the quality of a provider's generated footage. A request to “train the AI” should result in a concrete direction or workflow improvement and its application to the film.

## The filmmaking loop

1. Inspect the current project. For an existing film, call `cutline_quality_check` to establish what needs attention before changing it. Preserve manual work and the useful assets already present.
2. Read `cutline_director_guide` with the relevant style. Set the main message, audience, aspect ratio, approximate length and visual direction. Store the chosen direction and specific user preferences in `story.brief` and `story.style` when the project has a story.
3. Plan beats by purpose, picture, source asset, shot scale, movement, copy, voice and expected duration. These are planning notes. Use the existing story schema for actual edits; do not invent beat-sheet fields in tool requests.
4. Select or generate local narration, then use its actual duration and aligned words to set the edit. A scene should not end halfway through its last word. Shorten the script or lengthen the shot before accelerating a meaningful demonstration.
5. Assemble and refine native media clips, motion layers, keyframes, separate audio tracks and linked captions. Assembly is a starting point; rebuilding an assembled story can replace bespoke choreography, so refine the existing timeline when appropriate.
6. Run `cutline_quality_check` again. Address relevant `issues`, render its `previewFrames` with `cutline_preview` (`image: true`, at most 12 frames per call), and work through `checksRequiringReview`. Add samples at important entrances, exits, long captions and both sides of cuts.
7. Inspect those actual images and review playback with sound when available. Fix composition, timing, clipping, collisions, weak screen crops and distractions. Repeat the affected checks and previews.
8. Save the editable project, export when requested, and wait for `cutline_jobs` to confirm completion. Confirm the actual output and duration. State any audio, playback or delivery check that could not be performed.

The quality check reports structural findings and useful review moments. An empty issue list is not a cinematic-quality rating, a successful audio audition or proof that the entire video has been watched. Do not fabricate a percentage or a score.

## What “more cinematic” means here

Start with anticipation, reveal, proof and resolution. Let each scene have a clear subject and one dominant visual action. Alternate wider context with meaningful details. Let a large reveal settle before introducing more copy. Keep color, light direction, character or product identity and screen direction coherent.

Use clean typography and generous negative space. Default to no decorative underlines or accent rules beneath headlines. Size, weight, spacing and alignment should establish the hierarchy. Remove only decorative elements: functional interface lines, waveform marks, diagrams and intentional callouts may still matter. Permanent step numbers, chips and repeated labels usually weaken an otherwise cinematic frame.

A useful starting point at 30 fps is a restrained 12 to 24 frame entrance, at least a 1.5 second readable hold, and a shorter exit. A still image may support a small 2 to 5 percent push over 3 to 6 seconds. Those ranges are starting points, not requirements for every shot. A static composition can be stronger than another zoom. Native motion is editable 2D; it does not turn a still into a real tracked 3D scene.

Cinematic direction does not require black bars, strong grain, heavy color filters or constant motion. In a product film, avoid effects that make the interface harder to read. Finish the narration, then let the picture and music resolve together.

## Lessons from the 39.733-second Cutline demo

The multi-scene demo established an editable workflow using original app captures, local voice takes, aligned captions, native motion and a full export. Those mechanics are useful, but export success alone does not establish visual quality. The next treatment should apply the user's specific feedback: more cinematic compositions and no decorative underlines.

The reference films provided broad inspiration through short confident headlines, contrasts in scale, controlled reveals, legible product close-ups and purposeful movement between screens. Apply those principles to an original Cutline story. Do not reuse a reference's complete sequence, branding, claims or media as if it were Cutline's own work.

Several production details are worth retaining:

- Use a few strong screen compositions. A narrow sidebar crop placed with `contain` in a broad frame becomes a small stripe. Either show it in a tall composition beside restrained copy, or capture a wider meaningful view. Inspect the rendered result at its intended viewing size.
- Give each UI shot a purpose: establish context, show an action or reveal its outcome. A pile of screen cards may look active while saying very little. The important view needs enough scale and hold time to be understood.
- Be precise about source material. The demo's animated app screenshots are authentic captures, but they are not continuous interaction recordings. A synthetic pointer is an editorial focus cue. Use actual recordings when the film needs to prove a click, loading sequence or successful operation.
- Keep headline and narration complementary. Captions already represent the spoken words; another block repeating the same sentence crowds the screen. Reserve a quiet caption region before adding titles and screens.
- Preserve actual speech timing. Word alignment and a completed export cannot compensate for an edit that truncates a syllable, rushes the last phrase or masks the narrator with music.
- Preserve the editable project. Keep media, motion, narration, music and captions independently adjustable so visual feedback can be applied without rebuilding the whole film.

## Reference consistency and provider boundaries

Use shared reference images for the stable visual world and per-scene references for a specific shot. Keep real imported asset IDs and their order. Each scene supports at most nine unique combined shared and scene references. Reuse stable identity, wardrobe, location, palette and light descriptions; vary the framing or action deliberately.

Reference images guide generation, but do not guarantee identity or detail consistency. Inspect actual returned footage. Planning a story and choosing references do not authorize uploading them or spending provider credits. Keep the existing explicit paid-generation step. Local voice, editing, screenshots and rendering can support a complete film without a new cloud video job when the necessary media already exists.

## Example request

> Make this product film more cinematic. Preserve the story, voice and useful screen media. Read the cinematic director guide, inspect the existing quality findings, remove decorative headline underlines, simplify the compositions and give the important screens more room. Keep all layers editable. Check the entrances, captions and both sides of the cuts in rendered previews, then export the full film and report what you verified.
