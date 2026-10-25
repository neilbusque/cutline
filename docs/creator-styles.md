# Creator-style Shorts

Cutline can lay out a vertical Short from a timed beat plan. The three styles are composition starting points. Choose the actual visual action, timing and treatment for the story. Start with the [motion reference library](motion-reference-library/README.md), including the Jack Roberts, Nick Automates and Aasil Khan studies. Keep your own footage, words and verified product evidence.

| Style          | Inspired by    | What it looks like                                                                                                                                                                 |
| -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `split`        | Jack Roberts   | Graphic above the speaker, with full-screen evidence and selected face emphasis. Author the entrance, backdrop and emphasis per beat; older omitted options retain pastel pop-ins. |
| `cards`        | sebintel       | You on camera for the hook and the close; in between, a warm grid canvas with soft cards that drift slowly closer. Clean bold captions, dark on the canvas.                        |
| `locked-split` | Matthew Berman | Real screens and recordings fill the top half for the whole video, changing with each topic; speaker below; heavy outlined captions on the seam.                                   |

## Make one

1. Put your speaker video on the timeline (remove pauses first if you like) and transcribe it, or import its subtitles.
2. Open **Assistant** and choose **Jack Roberts-style Short**, **sebintel-style Short** or **Matthew Berman-style Short**, then send.
3. The assistant reads your transcript, plans the beats, fetches the real logos and pages you mention, and builds the Short. It previews the result and fixes what looks wrong.

Everything stays editable: the speaker is cut at each layout change on its own track, and the backdrop, media and graphics sit on **Style backdrop**, **Style media** and **Style graphics** tracks above it. Running it again replaces that previous pass; Undo restores the edit before it.

## For assistants: `cutline_style_reel`

`style` is `split`, `cards` or `locked-split`. `beats` is a list of up to 200 beats in timeline seconds:

| Field           | Meaning                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`    | Timeline seconds. Cut on phrase boundaries from the transcript's word times.                                                                                                                                                        |
| `layout`        | `split`, `full`, `face` (punch-in on the speaker) or `speaker`. Defaults to the style's usual choice.                                                                                                                               |
| `kind` + `show` | `logo` + product name or website, `page` + address, `asset` + an imported asset ID, `text` + 2 to 5 words, or `draw` + a short description of an original illustration (drawn by the signed-in Claude or ChatGPT, 15 to 30 s each). |
| `selector`      | For a page: a CSS selector to capture one part, such as `article.markdown-body` for a GitHub README.                                                                                                                                |

Captions on the speaker take the style's look (Pill, Clean or Heavy), are re-split into one to three words, and move to the seam during splits. Between beats the speaker fills the frame. A locked split holds each page until the next one replaces it.

Direction follows the spoken idea and visible action. A full-screen proof shot earns its place when a control or result needs attention; a speaker may continue through a sustained demonstration or personal thought. Do not force a cut interval or a full beat every N scenes. Use real named products and actual operation recordings; a label or screenshot alone does not prove an operation. Review returned `directionReview` notes and the actual rendered sequence.

Optional beat controls are `entrance` (`cut`, `fade`, `rise`, `slide-left`, `pop`), `backdrop` (`plain`, `sunburst`, `grid`), `background` (`#RRGGBB`), `emphasis` (`none`, `ripple`), `framing` (`contain`, `fill`), and `sourceIn` (proof-video seconds). Explicit entrance choices suppress automatic ripples and card drift. Omission preserves older output. Use `contain` for an intact readable screen and select its actual source passage.

Read [effects and native tools](motion-reference-library/effects.md) for mapping and a sample plan structure. Assistants can fetch the same structured direction with `cutline_editing_schema {section:"motionReferences"}` or `cutline_director_guide`. Choose voice, music, physical accents and silence as part of the beat plan. Openverse photos and audio are available in Stock.
