# Creator-style Shorts

Cutline can lay out a vertical Short in three styles measured from popular creators' videos. The structure, timing and look follow those references. The artwork does not: every Short shows your own footage, your words, and the real logos and pages your script names.

| Style          | Inspired by    | What it looks like                                                                                                                                         |
| -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `split`        | Jack Roberts   | Graphic on top, speaker below, with full-screen graphics and face punch-ins on hard cuts every 1.5 to 2.5 s. Pastel sunburst, pop-ins with a ring ripple, grey pill captions on the seam. |
| `cards`        | sebintel       | You on camera for the hook and the close; in between, a warm grid canvas with soft cards that drift slowly closer. Clean bold captions, dark on the canvas.  |
| `locked-split` | Matthew Berman | Real screens and recordings fill the top half for the whole video, changing with each topic; speaker below; heavy outlined captions on the seam.            |

## Make one

1. Put your speaker video on the timeline (remove pauses first if you like) and transcribe it, or import its subtitles.
2. Open **Assistant** and choose **Jack Roberts-style Short**, **sebintel-style Short** or **Matthew Berman-style Short**, then send.
3. The assistant reads your transcript, plans the beats, fetches the real logos and pages you mention, and builds the Short. It previews the result and fixes what looks wrong.

Everything stays editable: the speaker is cut at each layout change on its own track, and the backdrop, media and graphics sit on **Style backdrop**, **Style media** and **Style graphics** tracks above it. Running it again replaces that previous pass; Undo restores the edit before it.

## For assistants: `cutline_style_reel`

`style` is `split`, `cards` or `locked-split`. `beats` is a list of up to 80 beats in timeline seconds:

| Field                     | Meaning                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `from`, `to`              | Timeline seconds. Cut on phrase boundaries from the transcript's word times.                                 |
| `layout`                  | `split`, `full`, `face` (punch-in on the speaker) or `speaker`. Defaults to the style's usual choice.       |
| `kind` + `show`           | `logo` + product name or website, `page` + address, `asset` + an imported asset ID, `text` + 2 to 5 words, or `draw` + a short description of an original illustration (drawn by the signed-in Claude or ChatGPT, 15 to 30 s each). |
| `selector`                | For a page: a CSS selector to capture one part, such as `article.markdown-body` for a GitHub README.        |

Captions on the speaker take the style's look (Pill, Clean or Heavy), are re-split into one to three words, and move to the seam during splits. Between beats the speaker fills the frame. A locked split holds each page until the next one replaces it.

Planning rules that match each reference:

- **split:** change what is on screen every 1.5 to 2.5 s. Most beats are splits with a visual; use a full beat for the key reveal every few beats, and `face` for short emphasis lines under 1.5 s ("it's free", "for you").
- **cards:** the speaker only for the opening hook and the closing call to action. Everything between is `full`, with a new page, logo or line every 1.3 to 2.5 s.
- **locked-split:** one page or recording per topic, changing every 5 to 8 s.
- Every product, site or repo named gets its real logo or page on the words that name it. Ideas with no product get a `draw` illustration on the 2 to 5 key beats; text beats use the speaker's own words; never invent claims.
