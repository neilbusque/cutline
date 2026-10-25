# Cutline: agent control

Cutline exposes MCP tools for local editing. Agents can inspect a project, import local media and editable SVGs, download stock B-roll with its credits, generate narration, auto edit a video into a Reel, relink moved media, create custom vector paths and logo reveals, cut/trim/move/duplicate clips, edit tracks, build motion scenes, shapes and one-call motion recipes, animate layers, duck music under speech, correct and style captions, transcribe speech locally, search and read transcripts, remove pauses, list, save and open projects (by path or by name), look at rendered frames, export MP4, wait for jobs and undo/redo.

Open Cutline and choose **Settings & connections → Connect an assistant**. The bundled launcher uses Cutline's own runtime, so a packaged app does not require a separate Node installation for its launcher. Running from source still needs the [development prerequisites](development.md).

| Client                   | Connection                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Desktop           | Choose Claude Desktop and **Install Claude Desktop connection**. Cutline merges its server into the existing config and saves a backup. Fully quit and reopen Claude Desktop, then enable its Cutline tools.         |
| Claude Code              | Choose Claude Code and **Add to Claude Code**, or copy its install command and run it. Start a new session and check the Cutline tools with `/mcp`.                                                                  |
| Codex                    | Choose Codex and **Install Codex connection**. Cutline updates only its own server tables, saves a backup, permits automatic Cutline tool use and sets a ten-minute tool timeout. Reconnect MCP or start a new chat. |
| Assistant inside Cutline | Open the Assistant panel and pick Claude (your signed-in Claude Code) or Codex (ChatGPT sign-in). Both receive every editing tool, including rendered preview images.                                                |
| ChatGPT on the web       | Connect this MCP server through OpenAI's Secure MCP Tunnel, or an authenticated remote HTTPS endpoint. A local stdio config alone does not connect the ChatGPT website.                                              |

Use **Test local connection** to verify the real MCP launcher and the running app. Then ask the client:

> Inspect the open Cutline project. Tell me its canvas size, tracks, clips and motion layers. Do not change it.

A working bridge test proves local tool access. The client's successful inspection proves that client is connected. Client permissions, sign-in and account access still apply.

## When Cutline is closed

The launcher that Claude Code, Claude Desktop and Codex start lists Cutline's tools even while the app is closed, so a session started before Cutline still sees them. When a tool is called and Cutline is not running, the launcher opens the installed Cutline.app in the background, waits up to 20 seconds for it and then makes the call. If it cannot (a development build, or `CUTLINE_NO_AUTOSTART=1` in the server's environment), the call answers: "Cutline is not open. Open Cutline, then try again." `cutline_connection_status` and `cutline_jobs` never open the app: the status reports `ready: false` and jobs answers that Cutline is closed.

Quitting Cutline removes its `connection.json`, and a file left by a crash is recognized by its stopped process, so agents get that message instead of a network error.

## How agents should work

Claude Code keeps only the first 2,048 characters of a server's instructions, so the server sends a short core (the steps below, in brief) and the full workflow is one call away: `cutline_editing_schema` with `section: "workflow"`. Agents should read it once before their first edit. The assistant inside Cutline gets the whole workflow as its system prompt (`src/shared/assistant-instructions.ts`).

External chats first call `cutline_sessions` with `action: "list"`. Choose the intended session, or create one for a separate video, then include that `sessionId` on every later call, including previews, job checks and cancellation. Keep project, asset and job IDs within that session. If it is unavailable, open that same session instead of switching to another window. The assistant inside Cutline is already bound to its own window and does not use this routing step.

1. Inspect first. Read `cutline_editing_schema` before the first edit, and `cutline_effects_guide` for motion.
2. Make each coherent change one `cutline_edit` with the current `projectId` and `revision`. Every result gives the next revision.
3. Check the work visually with `cutline_preview` images, and describe how something looks only after seeing them.
4. Keep the user's manual work.
5. Timeline times are frames or explicit seconds; `sourceIn` and transcript times are seconds.
6. Wait for long work with `cutline_jobs`, and never claim an export finished without checking it.
7. Use the media tools instead of asking the user to click: `cutline_stock_import` for B-roll, `cutline_voiceover` for narration, `cutline_auto_edit` for a new Reel, `cutline_relink` for moved files, `cutline_reference` for the real logo or web page a script names, `cutline_graphic` for an original illustration.
8. Run `cutline_quality_check` after substantial edits, fix relevant issues and review the suggested frames. Structural checks do not replace watching or listening. Save the editable project and state any review that could not be performed.

Use filters and paging to keep project reads small. Follow a returned `page.nextOffset` instead of requesting the whole project repeatedly. If a result is too large, request fewer clips, a narrower time range or a smaller limit. An edit can finish before its result is returned, so inspect the current revision before retrying a mutation. Read-only tools are marked `readOnlyHint`; each client still controls its own approval behavior.

## Give the agent a complete editing task

> Make an eight-second motion graphic in Cutline. Use animated circles and lines, a kinetic title, spring easing, a gradient and a soft glow. Keep everything editable. Read the editing schema, create the layers and keys in one transaction, and show me a contact sheet of the opening, middle and end.

> Trim the first clip, cut out the long pauses, generate local captions, correct the transcript, apply karaoke styling, add a lower third, and export the result. Preserve the original media and verify the export job finishes.

> Make a 30-second screen-demo Short from my speaker recording and imported screenshots. Keep my original voice. Read the transcript, place real proof shots at the matching source times and use short word-timed captions. Preserve existing work, show the opening and each proof shot, save the editable project and verify the MP4 export.

For creator Shorts, `options.format: "creator-punch"` keeps the speaker prominent; `"screen-demo"` supports timed evidence from imported media. Use `cutline_create_reel` with `proofBeats` for explicit split views or cutaways. Proof timing refers to the original speaker source, before trimming and speed changes. Auto edit supports these formats but does not accept explicit proof shots or identify the best passage anywhere in a long recording. See the [creator shorts guide](creator-shorts.md) for exact fields and examples.

## Editable HTML scenes

`cutline_hyperframes` imports, reads and updates custom HTML/GSAP/Three.js scenes. Imports accept one absolute HTML `path` or complete `html` source, optional `name`, `transparent`, and `at` in frames or explicit seconds. Updates use `assetId` and replacement `html`. Read returns source in pages with `offset`, `limit`, `total` and optional `nextOffset`. Every action checks the current project ID and revision. Native timeline clips use a local rendered copy while the source remains editable; a render update is one Undo. Wait on returned jobs. See [editable HTML scenes](hyperframes.md) for the source contract, local libraries, safe project snapshots and examples.

## Reading the project

`cutline_inspect` returns a summary by default: the revision, canvas, tracks, assets, and each clip's ID, kind, track, start and duration plus only the fields that differ from the defaults. Motion definitions list their layers by index with type, name, text and which properties have keys. Long runs of generated captions appear as one line per source clip in `captionGroups`.

| Parameter              | Use                                                          |
| ---------------------- | ------------------------------------------------------------ |
| `detail: "full"`       | Every field of each clip and motion.                         |
| `clipIds`              | Only these clips and the motions they use.                   |
| `kinds`                | Only clips of these kinds, for example `["caption"]`.        |
| `fromFrame`, `toFrame` | Only clips that overlap this range (`toFrame` is exclusive). |
| `offset`, `limit`      | Paging. A result that stops early has `page.nextOffset`.     |

Neither view includes local file paths, waveforms or transcript words. Assets report `transcriptWords` instead. Read speech with:

- `cutline_search_transcript {query, limit?, clipId?}` finds a word or phrase, ignoring case and punctuation. Each hit has the `clipId` that plays it, timeline `startFrame` and `endFrame` (end exclusive), source `start` and `end` in seconds, and nearby words. A phrase split across clips or partly trimmed gives one hit per clip with `partial: true`. Hits cut out of the timeline have `clipId: null`.
- `cutline_transcript {clipId | assetId, offset?, limit?}` returns what is said as lines, with timeline frames for a clip or source seconds for a whole asset.

## Editing API

`cutline_editing_schema` returns a short guide: workflow and timing rules, every `cutline_edit` action with its fields (optional ones end in `?`), value lists (fonts, looks, presets, camera moves, transitions, caption styles, motion scenes, motion recipes, easings), ducking and recipe notes, and keyframe bounds. Pass `section` for the exact fields, bounds and defaults of one part: `clip`, `clipPatch`, `captionPatch`, `motion`, `motionLayer`, `motionLayerPatch`, `motionKeyframe`, `track`, `asset`, `project`, `transaction`, `actions`, `commands`, `motionRecipes` (each recipe's layers, styles, positions and default colors), `action:<type>` (for example `action:clip.update` or `action:audio.duck`) or `command:<type>`.

`cutline_edit` is the high-level entry point. `cutline_apply_edits` applies the low-level transaction format directly; prefer `cutline_edit`.

Every editing transaction supplies the current `projectId` and `revision`, a label and an ordered list of actions. A stale revision or invalid action rejects the entire edit. One committed transaction creates one Undo entry.

An edit answers with the new `revision`, the `created` items (ID, kind and `ref`; a new motion with named layers also lists their names by index in `layers`), `references` and a `summary` of changed clip, motion and track IDs, the duration before and after, and warnings. It does not echo the project. Pass `detail: "full"` to also get every field of the changed clips and motions.

`dryRun: true` checks the whole edit and returns the same summary without changing the timeline or undo history. Its `revision` is the live one, so commit the same actions with `dryRun: false` and that revision.

When the project changed since the agent's revision (for example, the user nudged a clip), the error names the revision to retry with, the edits since and the IDs they touched, so the agent can retry without reading the whole project again. Validation errors name the field and the schema section to read, for example `Invalid input: actions.1: Unrecognized key: "id". Read cutline_editing_schema with section action:clip.keyframe for its fields.`

Creation actions can name a `ref`. Later actions in that transaction use `$ref`. A motion creation also provides `$ref.motion`. Times use explicit `{frame: 30}` or `{seconds: 1}`; trim ends are exclusive. Source-in and word times are seconds. Split and trim preserve animation phase, and semantic clip operations follow linked generated captions.

Example for `cutline_edit`, after inspecting the project:

```json
{
  "projectId": "ID_FROM_INSPECT",
  "revision": 1,
  "label": "Animated line reveal",
  "actions": [
    {
      "type": "motion.shape",
      "shape": "line",
      "at": { "frame": 0 },
      "ref": "line"
    },
    {
      "type": "motion.layer.update",
      "motionId": "$line.motion",
      "layer": 0,
      "patch": { "stroke": "#67e8f9", "strokeWidth": 9, "glow": 12 }
    },
    {
      "type": "motion.keyframe",
      "motionId": "$line.motion",
      "layer": 0,
      "property": "trim",
      "frame": 0,
      "value": 0,
      "easing": "spring"
    },
    {
      "type": "motion.keyframe",
      "motionId": "$line.motion",
      "layer": 0,
      "property": "trim",
      "frame": 30,
      "value": 1,
      "easing": "linear"
    }
  ]
}
```

## Looking at the result

`cutline_preview` with `image: true` renders the frame with the export's own composition, browser and media, so the image shows exactly that moment of the exported video, without selection outlines, guides or open dialogs. One frame comes back at 1280 pixels on its long edge.

Several frames come back as one labeled contact sheet. Each tile shows its number, timecode and frame, and the text part of the result lists them in order:

| Parameter             | Use                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------- |
| `frames: [0, 15, 30]` | These timeline frames (up to 12).                                                      |
| `count`               | Evenly spaced frames across `clipId`, or `fromFrame` to `toFrame`, or the whole video. |
| `width`               | Pixel width of each frame.                                                             |
| `layout: "separate"`  | Separate images instead of one sheet.                                                  |

`frame`, `seconds`, `clipId` and `playing` also move the editor's playhead, select the clip and play or pause, as before. Selecting a clip keeps the Assistant panel open. `projectId` and `revision` are optional for previews; the result reports the revision it rendered. A development build without the export renderer (`npm run build`) falls back to one frame captured from the editor view and says so in `renderer` and `note`.

The built-in assistant receives the same images. This shares the requested frames with the connected model. Project details, asset names and transcripts also become model context; original media files remain on this Mac.

## Stock, narration, Auto edit and relink

These tools do what the app's buttons do, without dialogs. Each one needs the current `projectId` and `revision`, lands as one undoable edit on the project as it is when its slow part finishes (so edits made meanwhile are kept), and answers with the next `revision`. Slow work answers with a job ID after 45 seconds, like the other long tools.

| Tool                   | Inputs                                                                                                                                                                                                                 | What it does                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cutline_stock_import` | `id` from `cutline_stock_search`; optional `provider`, `kind`, `at`, `duration`, `trackId`                                                                                                                             | Downloads the result into the media bin with its credits (creator, license, source page, also saved beside the file). With `at` it places muted B-roll on a free "B-roll" video track above the footage: up to 5 seconds of video, or a 4 second photo with a slow zoom. Returns `assetId`, the public asset with its credits, and `clipId`. |
| `cutline_voiceover`    | `text`; optional `voice` (default `af_heart`), `speed` (0.65 to 1.5, default 1.08), `name`, `at`, `trackId`                                                                                                            | Generates narration on this Mac with Kokoro and adds it to the media bin. With `at` it places it on a free "Voiceover" audio track. Until the voice engine is installed (Audio, Text to speech, Download Kokoro), it explains that instead.                                                                                                  |
| `cutline_auto_edit`    | `assetId` of an imported video or an absolute `path`; optional `options` exactly as the Auto edit panel: `targetSeconds` (15, 30, 60, 90), `style`, `format`, `pace`, `captionStyle`, `openingTitle`, `broll`, `music` | Runs Auto edit: local transcription, pause cuts, captions, stock B-roll matched to the speech and a music bed ducked under the voice. It replaces the timeline and sets a 1080 x 1920 canvas, so use it for a new Reel; Undo restores the previous edit. Returns counts, the B-roll queries and warnings, not every clip ID.                 |
| `cutline_relink`       | `assetId`, absolute `path`                                                                                                                                                                                             | Points a missing asset at the file, keeping its name, credits, transcript and beats (the last two only when the length matches), and relinks other missing files found in that folder.                                                                                                                                                       |
| `cutline_reference`    | `kind` (`logo` or `screenshot`), `target` (product name or website for a logo, page address for a screenshot); optional `phone`, `selector`, `color` (`brand`, `white`, `black`), `at` | Adds the product's real mark (an editable vector from Simple Icons, or the icon its website publishes) or a 2× screenshot of the page as a rounded card above the captions, for three seconds at `at`. `selector` captures one part of the page, such as `article.markdown-body` for a GitHub README. |
| `cutline_graphic`      | `prompt`; optional `style` (`flat`, `line`, `glyph`, `gradient`, `badge`), `aspect` (`square`, `wide`, `tall`), `palette` (up to 6 hex colors), `route` (`auto`, `vector`, `picture`), `at` | Makes an original graphic: Claude or ChatGPT draws an editable vector and checks its render. A subject too detailed for a vector becomes a cut-out Higgsfield picture when Higgsfield is connected and Detailed graphics as pictures is on; `route: "picture"` asks for one (uses the user's credits). With `at` it is placed; a picture without `at` is only imported. Long-running: may answer with a job. |
| `cutline_style_reel`   | `style` (`split`, `cards`, `locked-split`), `beats`: `{from, to, layout?, kind?, show?, selector?}` in timeline seconds | Lays out a creator-style Short on the speaker video: hard-cut speaker framing per beat, the style's backdrop, real logos and page screenshots fetched from `show`, styled short captions. Replaces its previous pass; one Undo. See [Creator-style Shorts](creator-styles.md). |

For Ali Abdaal-inspired educational storytelling, use `options.format: "creator-education"` in either `cutline_create_reel` or `cutline_auto_edit`. It keeps the original voice with short light caption pills and native teaching cards. Use append with `cutline_create_reel` to preserve an existing edit. See [Reel formats](reel-formats.md) for timing, caption overrides and the reference treatment.

> Find coffee B-roll, place the best match at 0:04 for three seconds, then generate a voiceover of my script at 0:00, duck the music under it and show me a contact sheet.

## Duck music under speech

The `cutline_edit` action `audio.duck` lowers a music clip (or any audio or video clip) under the chosen voice clips in one undoable step. By default it follows each spoken phrase in the voice clip's transcript; a clip without a transcript ducks for its whole span, with a warning. `by: "clips"` always uses whole clips.

| Field                           | Default                                              |
| ------------------------------- | ---------------------------------------------------- |
| `depthDb`                       | -14 (12 to 18 dB under speech reads well)            |
| `attackFrames`, `releaseFrames` | 0.2 seconds before speech, 0.3 seconds after it      |
| `level`                         | The clip's volume, or its loudest earlier volume key |

Pauses shorter than about 0.75 seconds stay ducked, so the music never pumps between phrases. The action replaces the clip's earlier volume keys, so ducking again with a new depth starts over; clip fades are separate and stay. Auto Reel's music bed uses the same curve. Volume elsewhere is linear: 0.5 is about -6 dB, 0.25 about -12 dB and 0.1 is -20 dB.

```json
{
  "projectId": "ID_FROM_INSPECT",
  "revision": 7,
  "label": "Duck the music under the voiceover",
  "actions": [
    {
      "type": "audio.duck",
      "musicClipId": "MUSIC_CLIP_ID",
      "speechClipIds": ["VOICE_CLIP_ID"],
      "depthDb": -16
    }
  ]
}
```

## Motion recipes

The `cutline_edit` action `motion.recipe` builds a finished graphic in one call. It expands into ordinary named motion layers and keys on a free text track, so everything stays editable. Every recipe eases out on entrances, staggers related elements 2 to 4 frames apart, holds text at least 1.5 seconds at its default length and leaves faster than it came in, with an ease-in exit ending on the clip's last frame. Timing scales with the frame rate; a longer `durationFrames` stretches the hold, and one shorter than the recipe needs is compressed with a warning. Type is sized for where the video plays: a quarter larger on vertical canvases, which phones show edge to edge. A recipe placed while captions are on screen steps above them (or below when there is no room) and warns when it cannot.

| Recipe          | Default | Layers                                                                   | `subtitle` is         |
| --------------- | ------- | ------------------------------------------------------------------------ | --------------------- |
| `kinetic-title` | 4 s     | Background (only with `colors.background`), Title, Accent line, Subtitle | A quieter second line |
| `lower-third`   | 5 s     | Accent bar, Panel, Name, Role                                            | The role              |
| `callout`       | 3.5 s   | Ring, Dot, Leader, Label panel, Label, Detail                            | A detail line         |
| `end-card`      | 5 s     | Background, Title, Accent line, Button, Call to action                   | The call to action    |
| `logo-sting`    | 3.5 s   | Background, Ring, Mark, Monogram, Wordmark, Tagline                      | The tagline           |

Options: `style` is `clean` (default), `bold` (heavier type, letter rises on short titles, a 2 percent settle) or `minimal` (lighter type, masked line reveals, hairline accents). `position` is one of nine anchors from `top-left` to `bottom-right`, inside a safe area that keeps tall videos clear of captions and app buttons. A callout marks `point: {x, y}` in canvas pixels and puts its label on the side with room. `colors` takes `text`, `accent`, `panel` and `background`. Long text is balanced over more lines or set smaller; no words are dropped.

The result's `references` hold the clip (`$ref`) and motion (`$ref.motion`) IDs, and the created motion lists its layer names by index, so the same or a later edit can refine them:

```json
{
  "projectId": "ID_FROM_INSPECT",
  "revision": 8,
  "label": "Lower third for Jordan",
  "actions": [
    {
      "type": "motion.recipe",
      "recipe": "lower-third",
      "at": { "seconds": 2 },
      "text": "Jordan Lee",
      "subtitle": "Head of product, Northwind",
      "colors": { "accent": "#FFB347" },
      "ref": "jordan"
    },
    {
      "type": "motion.layer.update",
      "motionId": "$jordan.motion",
      "layer": 2,
      "patch": { "letterSpacing": -1 }
    }
  ]
}
```

For an SVG logo, use `cutline_vector_import` and `motion.logoReveal` instead of `logo-sting`.

## Long work

Transcription, pause removal, reels, Auto edit, music analysis and composition, stock downloads, narration, relinking and imports that need proxies can take minutes. These tools answer within 45 seconds, so clients with a one-minute request limit (Claude Desktop) never lose the result. Work that takes longer keeps running and answers with a job ID:

```json
{ "id": "JOB_ID", "jobId": "JOB_ID", "state": "running", "message": "..." }
```

Call `cutline_jobs {"id": "JOB_ID", "waitSeconds": 30}` until its `state` is `done`; the job's `result` holds what the tool would have returned. Without an ID, `cutline_jobs` lists recent jobs, always including running ones. Export returns a job ID right away. Long-running work can be stopped with `cutline_cancel_job`, using either the processing job ID or the ID a long tool returned (that stops the processing it started; exports are never stopped this way).

Imports accept explicit local media paths. Files that fail are listed in `failures` with the reason, and the rest still import as one undoable edit. Project saving and MP4 export support explicit paths or unique local defaults and require no file dialog. They protect source media and existing unrelated files. `cutline_get_srt` pages long caption tracks with `offset`.

## ChatGPT web setup

OpenAI currently supports private MCP servers via [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). This requires a tunnel ID and runtime API key from the user’s OpenAI account/workspace. The ChatGPT tab in Cutline provides the local stdio launch command for the tunnel client. No tunnel credentials are stored by Cutline, and this release does not automatically create or publish an account connection.

Install the official tunnel client, initialize a local stdio profile with Cutline’s copied launch command, run its doctor check, then keep the profile running. In ChatGPT Plugins choose **Add custom MCP server → Tunnel**, select the account’s tunnel, and install the resulting plugin. See the official guide for current account permissions and exact commands.

The HTTP MCP endpoint is also recorded in Cutline’s owner-only `connection.json`. It binds to `127.0.0.1`, uses an unguessable capability URL and changes each launch. The persistent stdio launcher reads the latest connection for each call, so it reconnects after an app restart. Public tools cannot invoke test-only handlers, shell commands or arbitrary generated JavaScript.

## Verification

Run `npm run typecheck`, `npm test`, `npm run build` and `npm run qa:agents`. The packaged QA uses disposable app data and synthetic media. `tests/agents-fixes.test.ts` checks tool and result sizes, the closed-app launcher and contact sheets without starting the app. `tests/agents2-fixes.test.ts` checks the stock, narration, Auto edit and relink tools with stand-in services, ducking curves (including Auto Reel's) and every motion recipe's layout, easing, staggers, holds and rendering. Set `CUTLINE_TEST_CODEX=1` for an optional real, locally signed-in assistant edit and preview check. The test never changes the user’s recovery project or real client configs.

Cutline’s motion graphics remain 2D vector and text compositions. This interface controls the editor’s supported features; it does not add third-party After Effects plugins or arbitrary computer control.

## Music tools in 0.10

Six tools expose local original music creation, source rhythm analysis, manual beat grids, rhythm inspection, visual timing alignment and beat/energy pulse bindings. They remain available alongside vector import in the current 35-tool build. See [Music workflow](music-sync.md). Existing launcher/configuration works after restarting Cutline; reconnect the client to refresh its tool list.

## Studio motion in 0.11

Ask the agent to read the current editing schema before building. The four scene IDs are `studio-title`, `studio-grid`, `studio-identity` and `studio-outro`. `motion.scene` accepts optional `durationFrames` (2–18,000); the scene timing scales with its duration. `motion.layer.update` accepts per-layer `fontWeight`, `align`, `letterSpacing`, `lineHeight`, `textAnimation: "line-reveal"`, `textRevealStart`, `textRevealFrames` and optional `musicAccent`. False keeps a shape steady; true marks eligible ornaments, while text and full-canvas backgrounds always remain steady in accent scope. Unset uses automatic geometric eligibility.

`motion.keyframe` accepts `easing: "cubic-bezier"` and `bezier: [x1, y1, x2, y2]`. X values range from 0 to 1; Y values from -2 to 3. Easing belongs to the outgoing segment of a property. Different properties can have different curves at the same frame. `cutline_music_reactive` accepts `scope: "accents"` for eligible custom motion scenes and `releaseFrames` (1–600). Omitted scope/decay preserve the existing binding when updating it.

> Build a restrained Studio title and identity sequence. Use masked line reveals, a clear type hierarchy, custom easing and room to hold the finished composition. Compose Gentle momentum music and place the cuts on eight-beat boundaries. Apply a subtle scale pulse only to graphical accents; keep the headline, background and layout panels steady. Show opening, hold and exit previews, then export the finished edit. Keep all layers editable.

The supplied Studio demo is an eighteen-second motion study at 104 BPM. Art direction remains a creative choice: inspect actual rendered frames and adjust copy, spacing and timing to the brief.

## Name, show and hide motion layers

Use `motion.layer.update` to give a layer an optional `name` of up to 80 characters and set `hidden`. Existing projects open with every layer visible. A hidden layer keeps its text, styling and animation keys; it is excluded from preview, export and graphical music accents. Set `hidden: false` to show it again.

After inspecting the scene, replace the project/motion IDs and revision below with current values. This example assumes layer 0 is the headline and layer 2 is a guide:

```json
{
  "projectId": "ID_FROM_INSPECT",
  "revision": 1,
  "label": "Organize motion layers",
  "actions": [
    {
      "type": "motion.layer.update",
      "motionId": "MOTION_ID_FROM_INSPECT",
      "layer": 0,
      "patch": { "name": "Main headline", "hidden": false }
    },
    {
      "type": "motion.layer.update",
      "motionId": "MOTION_ID_FROM_INSPECT",
      "layer": 2,
      "patch": { "name": "Layout guide", "hidden": true }
    }
  ]
}
```

Renaming or hiding a layer does not change its index. Adding, removing or reordering layers can change indices, so inspect the current order before editing again.

## Move an individual motion keyframe

`motion.keyframe.move` retimes one property's existing key without changing its value, outgoing easing or Bézier handles. Other properties at the source and destination keep their own curves. Compatible destination keys merge; a destination already keyed for the selected property rejects the entire transaction. The 100-key limit also applies after independent curves are regrouped.

This example assumes layer 0 has an opacity key at curve frame 18 and no opacity key at frame 30:

```json
{
  "projectId": "ID_FROM_INSPECT",
  "revision": 2,
  "label": "Give the title more time to enter",
  "dryRun": true,
  "actions": [
    {
      "type": "motion.keyframe.move",
      "motionId": "MOTION_ID_FROM_INSPECT",
      "layer": 0,
      "property": "opacity",
      "fromFrame": 18,
      "toFrame": 30
    }
  ]
}
```

Read the summary, then commit with `dryRun: false` and the same revision. `fromFrame` and `toFrame` are raw motion curve frames, from 0 to 864,000. They include neither the clip's timeline start nor an automatic trim offset. For a nonlooping clip trimmed by 12 frames, a key shown six frames into the remaining clip is curve frame 18. Loop endpoints remain explicit curve frames. When duplicate entries define the same property at the source, the last value and its easing are moved; earlier duplicates cannot reappear there.

> Rename the title and accent layers, hide the layout guide, and move only the title's opacity key from curve frame 18 to 30. Preserve its Bézier handles and all position keys. Dry-run the changes, commit once, and verify the opening and hold previews. Keep the edit undoable.

## Custom vectors and logo reveals in 0.13

The `Logos` library includes `logo-draw`, `logo-orbit` and `logo-signal`. Each scene contains an original two-path C/L monogram, editable typography and restrained supporting geometry. `motion.scene` can retime them with `durationFrames` like the other scene presets. Imported logos can use the same reveal styles.

| Operation                        | Required inputs                                                                                        | Optional inputs                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| MCP tool `cutline_vector_import` | Current `projectId`, `revision`, absolute local `.svg` `path`                                          | `startFrame` (defaults to 0), `name`                                                                                                |
| Edit action `motion.svg`         | SVG markup in `svg`, explicit `at` time                                                                | `name`, placement `width`/`height`, `ref`                                                                                           |
| Edit action `motion.vector`      | Exactly one of SVG path data `path` or pen `points`; `viewBox: [x,y,width,height]`; explicit `at` time | `closed`, affine `transform: [a,b,c,d,e,f]`, `fill`, `stroke`, `strokeWidth`, `fillRule`, `name`, placement `width`/`height`, `ref` |
| Edit action `motion.logoReveal`  | A custom vector motion `clipId`, `style: "draw"`, `"orbit"` or `"signal"`                              | `durationFrames` (2–18,000, must fit the clip)                                                                                      |

SVG import accepts up to 256 KiB of supported vector markup and creates path layers in one undoable, revision-checked transaction. It returns the actual `clipId`, `motionId` and `vectorLayers`. The original file stays unchanged; the project stores validated paths, paint and transforms so it remains editable after that file moves. Unsupported SVG features reject the import with an explanation. Read the current editing schema for precise bounds.

Pen points use source viewBox coordinates: each point has `x` and `y`, with optional absolute `in: {x,y}` and `out: {x,y}` cubic handles. `closed: true` closes the contour. On `motion.vector`, `strokeWidth` uses source viewBox units and is converted to placement pixels. Layer updates use pixel stroke widths. A generated path can be edited through `motion.layer.update` using `vectorPath`, `vectorViewBox`, `vectorTransform`, `vectorFillRule`, `background` (fill), `stroke`, `strokeWidth` and `fillOpacity`. `fillOpacity` also accepts independent `motion.keyframe` animation from 0 to 1; `trim` controls the drawn stroke separately.

For `cutline_edit`, replace the project ID and revision below with inspected values:

```json
{
  "projectId": "ID_FROM_INSPECT",
  "revision": 1,
  "label": "Editable vector logo reveal",
  "dryRun": true,
  "actions": [
    {
      "type": "motion.vector",
      "path": "M20 20H140V100H90V60H20Z",
      "viewBox": [0, 0, 160, 120],
      "fill": "#1E2827",
      "strokeWidth": 0,
      "name": "Original mark",
      "width": 360,
      "height": 270,
      "at": { "frame": 0 },
      "ref": "logo"
    },
    {
      "type": "motion.logoReveal",
      "clipId": "$logo",
      "style": "draw",
      "durationFrames": 90
    }
  ]
}
```

Review the dry run summary, then commit with the same revision and `dryRun: false`. Omitted reveal duration uses the selected clip's duration, capped at 18,000 frames. Draw reveals the contour before the fill. Fill-only paths receive a temporary outline derived from their fill; stroke-only paths keep their stroke and stay unfilled. Multiple visible paths enter with a bounded stagger. Orbit adds a rotation and scale settle; Signal adds an opacity and scale reveal. Existing position curves, path data, viewBoxes, colors, placement and non-vector layers remain intact.

A reveal clones the selected clip's motion definition. Other clips using the original definition keep their animation. Within the same transaction, a creation reference such as `$logo.motion` follows the revealed clone for subsequent actions. Split/trim phase is preserved: the new reveal starts at the selected clip's local beginning while its existing motion curve offset remains unchanged. Visible vectors with cycle or ping-pong looping require their loop to be turned off first; hidden alternatives are left untouched. The whole reveal is one Undo entry. Read the clip's current `motionId` with `cutline_inspect {clipIds}`, or an edit with `detail: "full"`, before later edits.

> Import my local SVG as editable paths. Apply a restrained Draw reveal, preserve its fill colors and existing placement, then add a masked wordmark beneath it. Keep other clips using that logo unchanged. Show a contact sheet from the outline to the completed mark, then export and verify the job finishes.

## Story planning and reference images

`cutline_story {}` reads the saved storyline. Read `cutline_editing_schema {section: "story"}` for the schema, then save a complete story with current `projectId` and `revision`. Preserve scene IDs and media links while revising. Blank narration makes a silent scene. Story drafts persist with the project and do not spend video credits.

In 0.19, set `story.referenceAssetIds` to ordered image asset IDs for shared character/style references, and `scene.referenceAssetIds` for scene-specific images. Import local images with `cutline_import_media` first and use its returned IDs. Shared references come first; each scene's references follow, with duplicates removed and no more than nine unique images in total. Preserve reference arrays when revising. These guide future shots; they do not replace timeline footage. The user submits paid image-guided generation from Story → Produce. Merely planning or saving references never uploads them or spends credits.

`cutline_story_voice {projectId, revision, sceneId}` generates local Kokoro narration and aligns words with local transcription. It reuses unchanged narration and retries missing caption alignment without resynthesizing speech.

`cutline_story_assemble {projectId, revision, mode}` builds editable visuals, narration, captions and optional music. `append` keeps existing work; `rebuild` replaces only the last assembled story sequence. Footage scenes and screen/split product layouts require visual assets; native graphics layouts do not. Any narration must match the current script, voice and pace. Short visuals loop with a warning to fill narration.

Paid Higgsfield shots are submitted explicitly from the Story panel. These planning tools do not initiate paid video generation.

## Explainers

Read `cutline_editing_schema {section: "explainer"}`, the current project and its saved storyline before planning. `cutline_explainer {projectId, revision, input}` creates and saves an outline from authored text. `input` contains `style`, `topic`, `script`, and optional `audience` and `cta`. Style values are `kinetic`, `screen`, `diagram` and `editorial`. Each nonempty script line starts a scene; longer lines split at sentence boundaries while preserving the narration words. A closing action changes on-screen copy, not spoken narration.

This tool replaces the saved outline and keeps the timeline unchanged. Preserve existing authored work unless replacing it is part of the request. Matching unchanged narration can retain its existing scene and media links. No factual script, screen evidence or paid media is generated from the topic. Read [styles and references](explainer-styles.md) for the intended use and limits of each treatment.

Before producing Product focus, import the user's actual screenshots or recordings and assign their returned asset IDs to every `screen` or `split` scene. Inspect and revise the saved plan with `cutline_story`. Native graphics scenes need no external media.

Call `cutline_story_produce {projectId, revision}` with the latest revision to create or reuse local narration, align captions and assemble all scenes. An optional `mode` accepts `append` or `rebuild`; omitted mode rebuilds the prior story sequence when one exists and appends otherwise. Unrelated timeline clips are preserved. Production checks required media before generating speech and stops automatic assembly if its storyline, canvas or previously owned sequence changes while work is running.

Wait on long-running work with `cutline_jobs`, using the returned job or task ID and the same `sessionId`. Cancel with `cutline_cancel_job`. Completed narration remains reusable after cancellation. If requested captions cannot be aligned, production keeps the audio and stops before assembly; fix the local transcription setup and retry, or explicitly disable captions in the saved story. Do not invent word timestamps to bypass that check.

After production, read the returned warnings and quality report, inspect representative frames with `cutline_preview`, and review actual playback with sound. Save the editable project and verify that export finishes. The structural report cannot judge the full listening experience. Per-scene `cutline_story_voice` and manual `cutline_story_assemble` remain available.

> Build a Sketch flow explainer from the script I supplied. Keep all narration words, use editable process diagrams and preserve unrelated timeline work. Create local narration and captions, review the assembled scenes, then save the editable project and verify the MP4 export.

## Product films (0.20)

A story may include `brand: {name, accent, background, foreground}` (colors are six-digit hex strings). Each scene may include `design: {layout, headline, eyebrow, body, points, motion}`. Product layouts are `title`, `screen`, `split`, `features`, `quote`, and `cta`; explainers add `kinetic`, `process`, `comparison`, `editorial`, and `editorial-quote`. `motion` is `smooth`, `snappy`, or `minimal`. Headline, eyebrow, and body are editable on-screen copy, separate from narration. `points` holds up to three strings, used as benefits, process steps, two comparison sides, or the first editorial cutout label. Read the live story schema for lengths and defaults. Absence of `design` preserves the existing full-frame footage workflow.

All designed layouts except `screen` and `split` build native editable graphics locally. `screen` and `split` additionally require an imported image or video `assetId` and frame that media without inventing interface details. Narration remains optional. Avoid unsupported claims, synthetic testimonials, and invented metrics. A quoted statement layout is not evidence of a customer endorsement.

Assembly creates ordinary motion definitions and replaceable media clips. Inspect with `cutline_preview`; refine through the existing motion and clip tools. Rebuild owns only its last generated clips, tracks, and unused motion definitions; unrelated or reused work remains. Assembly ownership IDs are managed by the editor and cannot be supplied by a client to delete arbitrary work.

## AI director and quality review (0.21)

Read `cutline_director_guide` with `style: "cinematic"`, `"product"` or `"social"` before building a complete film. Cinematic is the default; it uses clean typography, intentional movement and no decorative underlines. See [AI director](ai-director.md) for the production workflow.

`cutline_quality_check` is a read-only check of the open timeline. It returns actionable issues, affected clips and up to 12 suggested preview frames. It checks the timeline and local asset availability; it does not measure rendered audio or judge the finished imagery. Call `cutline_preview` on the suggested frames, fix issues within the requested scope, and rerun the check. Story assembly also returns this report automatically. A clean structural report does not replace reviewing the exported film.
