# Editable HTML scenes

Cutline can keep a HyperFrames scene's HTML source alongside its video. Use a scene for custom animation, procedural diagrams, GSAP motion or Three.js objects and cameras. Keep ordinary titles and shapes as native layers when direct canvas editing is more useful.

## In the editor

Open **Media → Import scene** and choose a HyperFrames HTML file. Cutline copies the project files into a managed scene folder and renders a local video. Add it to the timeline like any other video.

Choose **Edit source** on a scene in Media or the Inspector. Change the HTML, then render the new version. Every use of that asset updates together. Moving, trimming, effects and sound still work on the timeline. Undo returns the previous source and rendered version together. Importing and editing leave the original HTML project untouched.

The source editor changes the scene's code. HTML objects do not become native Cutline vector layers. Once rendered, preview and final export use the same local video, so scrubbing does not need another browser or a running project server.

Cutline refuses an update that is too short for an existing clip. Keep the scene long enough or trim its clips first. A scene used backwards must keep its duration when updated, so the selected passage does not silently move.

Transparent scenes keep their original alpha-capable video for preview instead of making an opaque H.264 proxy. Reverse is unavailable for transparent scenes because the current reverse encoder cannot preserve their alpha channel.

## With an assistant

Use `cutline_hyperframes` with the selected session ID, current `projectId` and `revision`.

```json
{
  "action": "import",
  "projectId": "current-project-id",
  "revision": 0,
  "path": "/absolute/path/to/my-scene/index.html",
  "name": "Product reveal",
  "at": { "seconds": 2 }
}
```

`html` can replace `path` for a new scene written by the agent. `transparent: true` produces an overlay with an alpha channel. Omit `at` to add the scene to Media without changing the timeline.

Read before updating:

```json
{
  "action": "read",
  "projectId": "current-project-id",
  "revision": 1,
  "assetId": "returned-asset-id",
  "offset": 0,
  "limit": 20000
}
```

Follow `nextOffset` until all source is read. An update uses `action: "update"`, the scene's `assetId`, and the complete replacement `html`. Pass the read result's `sourceHash` as `expectedSourceHash` to prevent an older draft from overwriting a scene changed by another editor or assistant. Name and transparency can be changed in the same update. Omitting HTML renders the kept source again. A long call returns a job ID; wait with `cutline_jobs` and do not start it twice. Cancelling leaves the project unchanged. Existing captions remain in place; regenerate them when the scene's speech changes.

## Authoring a scene

A scene declares its width, height and finite duration on its root with `data-composition-id`, `data-width`, `data-height` and `data-duration`. Match the root ID to a paused GSAP timeline in `window.__timelines`. HyperFrames can also seek registered frame sources for custom drawing and Three.js.

Cutline supplies these local runtime files in each scene snapshot:

- `cutline-runtime/gsap.min.js`
- `cutline-runtime/three.module.min.js`
- `cutline-runtime/three.core.min.js`

For GSAP, load the local script and register a paused timeline. For Three.js, use the module path and a seekable frame source. Any other libraries and media should be supplied as project files. Use time as an input: do not start an independent clock with timers or animation loops, fetch new media mid-render, or use unseeded randomness.

Project scripts and package installation commands are never run. Importing copies the HTML's containing folder with bounded file count and total size, excluding dependency caches, Git data and symbolic links. Keep scenes in their own folder with their assets. Remote resources still need a network connection; use local resources for offline rendering. HyperFrames rendering is local and does not use HeyGen credits.

Each finished version has its own source snapshot and rendered video. Managed snapshots stay available on this Mac after reopening the project, including versions needed by Undo. The project records the HTML, source hash and HyperFrames engine version, but its source and media paths are absolute. Moving the `.cutline` file alone does not move external assets or remap those paths. To continue on another Mac or after relocating source folders, bring the original HTML project and its assets, then import that folder as a scene again. A self-contained HTML scene can be recovered from its saved source; external dependencies still need their files.

Read the upstream [composition guide](https://hyperframes.heygen.com/reference/html-schema) and [frame-source contract](https://hyperframes.heygen.com/guides/frame-sources) for advanced scenes.
