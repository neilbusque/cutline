# Troubleshooting

Start with the exact error, app version and a small reproducible project. Preserve the original project and media before recovery work. [Getting started](getting-started.md) covers normal use; [development](development.md) covers source setup.

## The source app does not start

- Confirm you are on an Apple Silicon Mac running macOS 15 or later. Current binary paths and packaging target macOS arm64.
- Run `npm ci` from the repository root and check its output for failed dependency steps.
- Run `npm run build` before `npm start`. A fresh checkout does not contain the compiled app.

If Electron's executable is missing, prepare the binary from the installed local package:

```sh
npx --no-install install-electron
```

Electron 42 and later no longer download through npm postinstall. The normal Electron CLI can download lazily, but scripts that launch the binary directly need it prepared first. `npm rebuild electron` does not perform that installation. See [Electron's explanation](https://www.electronjs.org/blog/electron-42-0#electron-no-longer-downloads-itself-via-postinstall-script). Other native dependencies may have separate requirements; inspect their error before rebuilding them.

When launching Electron directly from another Electron-based tool, ensure `ELECTRON_RUN_AS_NODE` is not inherited. That setting changes Electron's behavior. Cutline's development and assistant launchers remove it when starting the editor.

## FFmpeg or FFprobe reports a permissions error

Run `npm run setup:runtime` after installing dependencies. This download-free step restores executable permissions on the installed media binaries. Some npm configurations skip package install scripts that would normally set those permissions. Cutline also checks them before build, development and packaging; no global npm policy change is needed.

## The development port is occupied

The development UI uses `127.0.0.1:5178` with a strict port. Inspect its listener:

```sh
lsof -iTCP:5178 -sTCP:LISTEN
```

Reuse the existing process if it belongs to the same checkout. Otherwise stop your own old process or close its app before retrying. Do not terminate an unrelated process just to free the port.

## Export or rendered previews fail in development

Prepare the export browser with `npm run setup:vendor`, then run `npm run build`. The renderer needs `dist/composition` and the pinned full Chrome for Testing application. A Vite-only update does not rebuild the export composition.

Run vendor setup again after a renderer or browser-manifest update. It prepares the browser selected in Cutline's tracked manifest; an old `vendor/` folder is not refreshed by `npm ci` alone. Cutline uses Chrome for Testing 156.0.8078.47 with explicit `chrome-for-testing` mode. Headless-shell builds stalled animation callbacks during macOS 27 testing, so substituting one can leave composition loading stuck. Restore the pinned browser and rebuild before increasing a render timeout.

If setup reports an inventory or hash mismatch, retain the error and restore the official download through setup. Do not edit expected hashes to accept an unrelated browser. The full application contains approved relative framework symlinks; unexpected links and links outside its directory are rejected.

Relink missing source media, check free disk space and choose a writable output folder. Render intermediates need additional disk space while a job runs. Wait for the finished state before relying on the MP4.

If an export is waiting for a slot, another session may already be rendering. Check its jobs. Cancel work you no longer need instead of repeatedly starting it.

## Packaging stops at the FFmpeg check

The current FFmpeg binary is marked nonfree and is not redistributable. The default packaging guard is intentional. Source-only distribution avoids shipping that binary.

The [development guide](development.md#local-packaging-and-distribution) describes the explicit private local-build override. It is not permission to publish the resulting app. Public binary distribution needs a compatible replacement and a complete dependency review.

## Media is missing or the preview is blank

Use **Relink missing file** in Media and choose the original file. Projects reference media; moving only a `.cutline` file does not move its sources.

Some source formats require a local preview copy. Allow **Preparing preview** or **Preparing reversed copy** to finish. If it fails, retain the original and try a small compatible MP4 to distinguish a source-format problem from an editor problem.

Check track visibility, clip opacity, position and timing. A muted track affects audio; a hidden track affects its visual output.

## Captions are unavailable or inaccurate

Local transcription needs `vendor/whisper-cli` and `vendor/ggml-base.bin` in a source build. Follow [vendor setup](development.md#prepare-local-rendering-and-transcription) if either is absent. A packaged app uses vendor files in its resources.

The source must contain audible speech. Whisper can mishear names, punctuation and short phrases. Review **Captions → Edit words** and replay the surrounding audio. Changing the word count cannot preserve word-level timings that do not exist.

After reversing, freezing or retiming footage, inspect its caption behavior instead of assuming the previous transcription still fits.

## Local voiceover does not run

Open **Audio → Text to speech**. If offered, download the model. For a source build, run `npm run setup:speech`, then `npm run build`. Model preparation and compiled workers are separate requirements.

Use an English script within the panel's length limit. Generate another take when the script, voice or pace changes; an earlier preview is not automatically regenerated.

Repair corrupt bundled assets from a trusted build. Do not replace verified model files with unrelated downloads. Assistant sign-in and a Higgsfield API key are not required for local voiceover.

## A proof shot prevents building a Reel

Open **Reel → Build manually** and check the flagged row in **Style → Proof shots**:

- Choose a source that is still in your selected footage.
- Choose an available screenshot or recording yourself.
- Keep the duration between 0.5 and 12 seconds and within the source's used range.
- For video proof, leave enough media after **Start proof video at**.
- Move or shorten overlapping shots.

**Show at** uses original-source time, not finished-Reel time. Target length and footage selection can change the available range. Remove an unused row with its trash button. See [creator shorts](creator-shorts.md).

## The assistant cannot reach the editor

1. Open the intended Cutline session.
2. Open **Settings & connections → Connect an assistant** and run **Test local connection**.
3. Reconnect the client's MCP server or start a new client chat after installing its connection.
4. Ask the client to inspect the project without editing it.

A saved connection is not proof of current sign-in or account access. Multiple sessions require an explicit `sessionId`; use **Copy Codex prompt** from the correct session. A development build may need to be opened manually.

After a disconnect, inspect the timeline before retrying. The request may have made edits before its connection failed. Never share `connection.json` or a token-bearing bridge URL in a public issue. [Agent details](agent-control.md).

## A cloud generation is pending or failed

Saved credentials confirm local storage, not funded access or provider availability. Review the existing request's state; it may still be running after a restart.

Do not submit a new paid request just to check an uncertain earlier one. Use the existing request's recovery/status controls. Selecting a reference image does not itself submit generation. [Higgsfield guide](higgsfield.md).

## Autosave reports an error

Check whether the folder exists, the disk has space and macOS allows writing there. Use **File → Save as** to a writable location. A visible save error means the project file may not be current.

Use **File → Open backup** to inspect a recovery copy and save it under a new name. Keep the previous project until recovery is checked. Avoid deleting app data as a first troubleshooting step.

## Report a bug

Include the version, macOS version, Apple chip, source or packaged build, exact steps, expected result and actual result. For export problems, include canvas size, frame rate and source format. State whether it also happens with synthetic media.

Remove private media paths, transcripts, assistant messages, credentials and token-bearing URLs before sharing a minimal project or diagnostics. Security-sensitive findings follow [private reporting](../SECURITY.md).
