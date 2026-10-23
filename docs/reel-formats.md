# Reel formats

Use **Reel Builder** to choose footage, a format, a visual style and captions. The assistant uses the same `cutline_create_reel` options. Every result is native editable clips, captions, motion layers and keyframes, rendered by the same preview and export composition.

| Format              | Use it for                                                                                       | Default caption treatment                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `montage`           | Ordered footage, B-roll, hook and closing title                                                  | Existing visual-style default                                 |
| `talking-head`      | A speaker with gentle punch-ins and timed callouts                                               | Spotlight (`karaoke`)                                         |
| `explainer`         | Spoken ideas with animated takeaway cards                                                        | Clear (`standard`)                                            |
| `listicle`          | Numbered spoken points with editable step cards                                                  | Punch (`pop`)                                                 |
| `product-demo`      | Imported screens shown in full with feature labels                                               | Minimal (`minimal`)                                           |
| `creator-education` | Ali Abdaal-inspired educational storytelling with a speaker, teaching cards and gentle punch-ins | Compact off-white pills with dark type (`box`)                |
| `creator-punch`     | A full-frame speaker with short bold captions, quick punch-ins and sparse spoken emphasis        | White outlined captions with lime word highlights (`outline`) |
| `screen-demo`       | A speaker with deliberately timed screenshots or recordings in split view or full-screen cutaway | White outlined captions with lime word highlights (`outline`) |

Format controls the structure. Visual style (`clean`, `bold` or `cinematic`) controls the treatment. `captionStyle` can override the format's caption choice. Captions stay linked to actual spoken words; a format never invents speech or source imagery.

## Ask in plain English

- “Turn this into a 30-second talking-head Reel with Spotlight captions and animated callouts.”
- “Make this Ali Abdaal-inspired: keep my voice, use short light caption pills, cream teaching cards and subtle punch-ins.”
- “Make a listicle from these three takes, with numbered points and bold word highlights.”
- “Build an explainer with short takeaway cards. Keep the original voice.”
- “Make a product demo from my recording. Keep the whole screen visible and use quiet captions.”
- “Keep the same footage and caption style, but remove the animated cards.”
- “Make a Creator punch Short with my original voice and short bold captions.”
- “Use Screen demo and show this screenshot when I explain the result. Keep my voice playing.”

The assistant inspects imported assets and real transcript timings, chooses supported options and checks rendered frames. It can refine the result with native editing tools. It does not infer unseen source actions or promise face tracking, cutouts, arbitrary 3D graphics or an exact reconstruction of a reference.

## Ali Abdaal-inspired educational reels

Choose **Ali Abdaal-inspired** in Reel Builder or Auto edit. Both use `options.format: "creator-education"`. The format defaults to clean speaker footage, groups three or four aligned spoken words into small off-white caption pills with dark text, and adds cream educational cards, numbered steps and gentle punch-ins at speech boundaries. Supporting B-roll stays muted in the upper graphic zone so the original voice continues. Visual style and caption treatment remain editable; long imported subtitle cues use two lines without inventing word timings.

The [reviewed reference](https://www.youtube.com/shorts/DDzQTEiEOWk) uses a lower central speaker, an upper supporting graphic and a small light caption pill. Use suitable source framing and inspect the actual result so cards, B-roll and captions clear the speaker. The layout does not perform face tracking. It provides an original educational treatment, not an exact copy of a creator's Reel.

Keep the original voice. Generate Kokoro narration only when new narration was requested. Use real transcript phrases and actual timings for cards, or supply verified source-timed beats. Do not invent statistics, source actions or claims. Omitting `captionStyle` or selecting `box` applies this format's caption theme; another explicit caption style keeps that chosen look. Omitting `beats` creates transcript-based cards, while `beats: []` disables its cards and punch-ins.

Use Reel Builder's append mode to keep an existing edit. Auto edit replaces the timeline and is for a requested new Reel. Preview card entrances and holds, the longest caption, the source framing and the final spoken words before exporting.

## Creator shorts and screen proof

Choose **Creator punch** for a speaker-led Short or **Screen demo** when you have real screenshots or recordings to show. Both default to clean styling and the recommended caption treatment. The speaker stays full frame between proof shots. The original speech continues through every proof shot, with proof-video audio muted.

In **Reel Builder → Style → Proof shots**, add up to 24 shots and choose each imported image or video yourself. **Show at** is the time in the original selected source clip. **Duration** is how long the proof remains on screen in the finished Reel. **Screen above speaker** creates a split view; **Full-screen proof** temporarily covers the speaker. A proof video can start at its own source time. Choose a screenshot or recording that supports the spoken point, and inspect its readability in the preview.

The entire shot must fit the source range used in the Reel and, for proof videos, the remaining proof media. Proof shots cannot overlap. Shorten a shot or move its timing if the builder flags it. Source selection, source order and target length can change the available range.

Auto edit supports both formats and keeps the source voice. Explicit proof shots are available in Reel Builder and `cutline_create_reel`, not `cutline_auto_edit`. Auto edit defaults stock B-roll and generated background music off for these formats. See [Creator shorts](creator-shorts.md) for the full workflow and timing example.

## API example

Get the real project ID, revision and asset ID from `cutline_inspect`. Then call `cutline_create_reel` with:

```json
{
  "projectId": "<current project ID>",
  "revision": 12,
  "options": {
    "sources": [{ "assetId": "<imported speaker asset ID>" }],
    "targetSeconds": 30,
    "mode": "append",
    "format": "talking-head",
    "style": "clean",
    "captions": true,
    "captionStyle": "karaoke"
  }
}
```

Omitting `beats` uses actual transcript phrases to create format-appropriate cards. Supplying `beats: []` disables those cards. The default format remains `montage`, preserving existing callers. `append` preserves existing clips and the current canvas when the project already contains an edit. Choose `replace` only for a requested rebuild.

## Selected animated beats

For deliberate emphasis, provide up to 24 beats:

```json
{
  "sourceIndex": 0,
  "sourceSeconds": 8.2,
  "text": "One clear next step",
  "kind": "takeaway"
}
```

This is the beat object inside `options.beats`, not a standalone tool call. Replace the sample time and text with actual source-supported values. `sourceIndex` is zero-based in `options.sources`. `sourceSeconds` is absolute source-media time before trimming and playback speed, not timeline time. It must fall inside that source's used range. Supported kinds are `callout`, `step` and `takeaway`; text must contain 1 to 80 characters.

Do not fabricate transcript timestamps, product results, numbers or claims. Keep overlay copy short enough to read. Edit generated layers directly when refining a card instead of rebuilding a manually tuned sequence.

## Review and completion

Preview the hook, card entrances and holds, the longest caption, important cuts and the ending. Keep faces, captions and essential screen controls clear. Frame samples verify those sampled images, not continuous motion or audio. Review playback with sound when available, save the editable project and wait for the export job to report completion before saying the export is ready.

Format construction is local editing. It does not spend paid generation credits or authorize cloud asset generation.
