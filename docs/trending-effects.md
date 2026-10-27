# Trending effects

Cutline 0.39 adds the moves that short-form video runs on today: whip, zoom, flash, spin, shake and glitch transitions, punch and shake camera moves, letterbox, flash-cut, glitch and halation finishing, the Hormozi caption look, speed ramps, progress bars, notification banners, a subscribe button and built-in sound accents. Everything renders in the same composition for preview and export, stays editable, and needs no download or account.

The catalogue was drawn from a late-2026 survey of Reels, TikTok, Shorts and YouTube editing (creator breakdowns, CapCut and Premiere preset markets). Timings below are the usual values; every one is a starting point.

## Transitions

Select a video or photo that sits right after another one on its track, then choose in **Effects › Transition from previous clip** (or **Properties**). Each kind starts at its usual length; the slider changes it. A transition overlaps the two clips and moves later clips on that track.

| Transition             | What it does                                                                       | Usual length |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------ |
| Crossfade              | The shots dissolve into each other.                                                | 0.5 s        |
| Dip to black           | Dips through black in the middle.                                                  | 0.5 s        |
| Flash                  | A white pop hides the cut: bright at the cut, clear within a few frames.           | 0.2 s        |
| Blur dissolve          | The outgoing shot softens as the next one sharpens.                                | 0.5 s        |
| Zoom in                | Pushes into the outgoing shot with motion blur; the next settles from large.       | 0.5 s        |
| Zoom out               | The outgoing shot shrinks away over the next one settling into place.              | 0.5 s        |
| Whip left / Whip right | Both shots whip across with directional motion blur, like a fast pan.              | 0.3 s        |
| Slide left / right     | The next shot slides in.                                                           | 0.4 s        |
| Push up / Push down    | The next shot pushes the outgoing one out vertically.                              | 0.4 s        |
| Wipe                   | A soft edge wipes across.                                                          | 0.5 s        |
| Spin                   | The outgoing shot spins and zooms away; the next spins into place.                 | 0.4 s        |
| Shake                  | A hard cut in the middle with a camera jolt that settles.                          | 0.4 s        |
| Glitch                 | Digital tearing and color separation build to a hard cut, then clear.              | 0.3 s        |

Whips carry a whoosh well; zooms and shakes an impact; flashes and glitches usually need nothing. Zooms and spins keep the outgoing shot on top of the next one inside the pair's own compositing group, so a clip with a blend mode falls back to a plain dissolve of the same shape.

## Camera moves

In **Effects › Camera motion**: **Punch in** snaps 18% tighter in a fifth of a second (the jump-cut punch), **Punch out** starts tight and snaps back, **Pop in** springs a screenshot or insert up from 82%, and **Shake** knocks the frame on the first frames and settles within half a second. Split a clip and the move carries on across the cut instead of restarting.

## Finishing overlays

In **Effects › Finishing overlays**, with **Overlay strength**:

- **Letterbox**: black bars top and bottom. Half strength is the classic 2.39:1 band on a 16:9 frame.
- **Flash cut**: a white pop on the clip's first frames. It hides a hard cut with no transition and no overlap, so later clips never move.
- **Glitch**: short bursts of tearing and color separation (about a quarter of the time), with faint scan lines.
- **Halation**: a soft warm glow bleeding from the highlights, like film.

Film grain, light leak, VHS scan and halftone remain. Grain plus halation plus a slow push is the current "analog" look; keep light leaks over B-roll, not faces.

## Caption looks

In **Captions › Style**:

- **Impact**: big black-outlined capitals in Arial Black, the spoken word in yellow with a pop. This is the Hormozi/MrBeast look; set **Words per caption** to short (one to three words). Use green (`#39ff14`) as the accent for money and business topics.
- **Bounce**: each word springs in as it is spoken and stays.
- **Neon**: glowing type in a cool color, the spoken word lit brightest.

Arial Black and Impact are now font choices for any text, title or caption. The quieter counter-trend (white sans, soft shadow, one accent word, fades) is the existing **Clean** and **Minimal** looks.

## Speed ramps

Select a video or audio clip and choose a **Speed ramp** in **Properties**: **Slow, fast, slow** (the classic velocity edit), **Fast, then slow**, **Slow, then fast** or **Hold, then rush**. The clip is cut into pieces that stay contiguous in the source, each at its own speed, and later clips on the track move with the new length. Each piece is an ordinary clip afterwards: trim it, change its speed, or put a flash cut on it. Ramps apply before reversing or freezing, and to clips without generated captions.

For assistants, `clip.speedRamp {clipId, segments: [{seconds, speed}]}` takes source seconds in order, the same seconds the transcript uses; the rest of the clip keeps its speed.

## Overlay recipes

**Motion** recipes now include:

- **Progress bar**: a thin bar that fills from empty to full over the clip's length, with a label above it and a percentage counting to 100. Set its duration to the span it covers.
- **Notification**: a phone-style banner (app tile, title, message) that drops in from the top edge with a small settle and slides back out. Pair with a ding.
- **Subscribe button**: a red pill with the label that presses after a second, turns dark with the pressed label, and rings a bell in beside it. `colors.accent` recolors it; the text defaults to Subscribe.

All three are ordinary named layers afterwards. `motion.recipe {recipe: "progress-bar" | "notification" | "subscribe", text, subtitle?, at, durationFrames?, position?, style?, colors?}` for assistants.

## Sound accents

**Audio › Accents** has six sounds made on this Mac from scratch (nothing to download or credit): **Whoosh**, **Impact**, **Pop**, **Click**, **Riser** and **Ding**. Each lands at the playhead on a Sound effects track, two frames early so sound and picture meet, at half volume. Whoosh on a whip or slide, impact on a punch or reveal, pop on a word or sticker, click on a cut, riser ending on a reveal, ding on a result. One sound per event reads best; a whoosh on every cut is the most common mistake.

For assistants, `cutline_sound_accent {kind, at, volume?, trackId?}`; `at` is the event, and the clip starts two frames before it.

## Pacing notes from the survey

Short-form: a meaningful visual change every two to three seconds, the first fifteen seconds with no composition held past three, captions always, a hook in the first frame. Long-form: a visual change every ten to twenty seconds in the opening minutes, cutaways on the exact phrase, and quieter pacing for older audiences. These are observations, not rules Cutline enforces.
