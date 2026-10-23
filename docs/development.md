# Development

These instructions describe the repository's current scripts. They are not a claim that a fresh installation has been verified on every Mac or Node release.

## Requirements

- An Apple Silicon Mac running macOS 15 or later. The package and FFmpeg paths target `darwin-arm64`, and [Remotion requires macOS 15 or later](https://www.remotion.dev/docs/).
- Node.js 22.12 or newer in a version accepted by the pinned tools. Node 24 fits their declared engine ranges.
- npm, Git, CMake and Xcode Command Line Tools for building the local transcription binary.
- Internet access for npm packages, Chrome for Testing and speech-model downloads.
- Free disk space for dependencies, model files, imported media, render intermediates and packaged builds.

Run commands from the repository root. Use the committed `package-lock.json`. Do not fix an install problem by deleting the lockfile.

## Install dependencies

```sh
npm ci
npm run setup:runtime
npx --no-install install-electron
```

The runtime setup checks executable permissions on the installed FFmpeg and FFprobe binaries. It repairs missing execute bits without downloading files or changing npm's global install policy. Run it again after reinstalling dependencies if media tools report a permissions error. Build, development and packaging also run this check.

Electron 42 and later download the runtime on first CLI launch instead of during npm's postinstall phase. The explicit `install-electron` step prepares the pinned local Electron package before scripts or Playwright launch its executable directly. `--no-install` prevents npx from fetching a different package. See [Electron's installation change](https://www.electronjs.org/blog/electron-42-0#electron-no-longer-downloads-itself-via-postinstall-script).

A successful dependency install alone does not prepare the Electron binary, export browser or speech models. Other native dependencies may have their own install-script requirements.

The lockfile includes a targeted `sharp` override for the Transformers dependency. It keeps the current speech integration while selecting a patched native image runtime. Review that override when updating Transformers, and keep it until the upstream dependency includes a suitable version. The dependency-runtime test exercises native image decoding/resizing and loads the speech modules.

## Prepare local rendering and transcription

```sh
npm run setup:vendor
```

The vendor setup prepares the full Google Chrome for Testing application, the Whisper base model and the local `whisper-cli` transcription binary. A fresh build needs CMake and Xcode Command Line Tools. The script uses the pinned Whisper source revision and verifies downloaded source/model files. Follow any prerequisite error before retrying.

Install missing Apple tools with `xcode-select --install`. Install CMake through its official installer or a package manager such as Homebrew. Whisper compilation uses two jobs by default; `CUTLINE_BUILD_JOBS` accepts an integer from 1 to 8.

If you already have a compatible static `whisper-cli`, supply its absolute path through `WHISPER_CLI_PATH` instead of building a new copy. Review the script before substituting a binary. Static libraries and the embedded Metal library are required for the current app bundle.

Cutline pins Google Chrome for Testing 156.0.8078.47 for macOS arm64 and uses Remotion's documented [`chromeMode: "chrome-for-testing"`](https://www.remotion.dev/docs/renderer/open-browser#chromemode) option. This full-browser configuration was selected after the headless-shell builds stalled animation callbacks during macOS 27 testing. Chrome 156 was [promoted to the stable channel on October 20, 2026](https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_02018666648.html). The pin is a reviewed build choice, not an automatic update to the latest browser.

The local executable is `vendor/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`. The tracked [Chrome manifest](../scripts/chrome-manifest.json) records the official Google archive URL, size and SHA-256, expected browser file paths, sizes and hashes, and exact relative framework symlink targets. Setup and packaging validate the inventory and reject unexpected or escaping entries. Keep this JSON in every source checkout; the full browser application remains a local download with its own upstream terms.

When updating Remotion, keep `remotion` and all `@remotion/*` dependencies on the same exact version, as described in the [upstream upgrade guide](https://www.remotion.dev/docs/upgrading). Review the compatible browser pin and explicit launch mode together. After installing the updated lockfile, run `npm run setup:vendor` again, rebuild and check preview and MP4 export. Updating npm dependencies alone does not replace an older browser already in `vendor/`.

Review the matching browser manifest in the same upgrade. Verify the new upstream archive and derive file entries from a fresh trusted download, never from the mutable `vendor/` cache or by changing hashes to accept a failed check. Commit the dependency pins, manifest and updated notices together.

## Prepare local voiceover

```sh
npm run setup:speech
```

This downloads the Kokoro model, tokenizer and configuration from the revision recorded in `src/shared/tts-model.ts`. The script checks each listed file's SHA-256 value before writing it into `vendor/kokoro/`, and keeps the model license and notices beside those files. Voice files come from the locked `kokoro-js` npm dependency.

Model preparation and compiled voiceover workers are separate requirements. Keep downloaded weights and generated speech out of source changes unless repository policy explicitly includes them.

## Build and run

```sh
npm run build
npm start
```

The build writes Electron main/preload/worker bundles into `dist/main`, the editor UI into `dist/ui`, and the export composition into `dist/composition`. `npm start` runs the built Electron app.

For UI development, build once and then run:

```sh
npm run dev
```

The dev script uses Vite at `http://127.0.0.1:5178`. Check for an existing dev process before starting another one. Vite uses a strict port, so an occupied port fails instead of choosing a different one.

The dev script compiles main/preload and worker entry points, including voiceover, before launch. Restart after main-process or worker changes. A full build is needed for fresh export-composition changes; Vite updates do not rebuild that artifact. Closing development stops its Electron/Vite processes. Stop the terminal command when finished.

Preview-frame workers close their browser when the editor disconnects. If a preview is interrupted by closing the app, reopen the intended session and request a new preview.

## Data and sessions

Source runs use a checkout-specific profile under `~/Library/Application Support/Cutline Dev/`. They do not default to the installed app's recovery data. For an explicitly isolated run:

```sh
CUTLINE_DATA_DIR="$PWD/work/dev-profile" npm start
```

Keep the profile private and out of Git. It can contain media paths, transcripts, assistant state and local connection details. Only one app process should own a given data folder. Do not point tests at your normal profile or an important project: opening a project can autosave it.

## Validate a change

Run memory-heavy checks sequentially:

```sh
npm run typecheck
npm test -- --maxWorkers=1
npm run build
```

There is no separate lint script at present. `npm run format` applies Prettier to source, tests and scripts. Review its diff so unrelated formatting does not enter a change.

Use the QA suite that exercises the changed behavior. Suites can launch Electron, create media and render video, so run one at a time and read each script's requirements first.

| Command                     | Scope and requirements                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run qa:creator-shorts` | Creates a synthetic fixture with macOS speech, exercises creator formats/proof shots and exports through an isolated source app |
| `npm run qa:screens`        | Captures editor panels with isolated data; populated screens may require a configured local fixture                             |
| `npm run qa:agents`         | Exercises MCP editing and connection setup with isolated data; defaults to the staged packaged app                              |
| `npm run qa:audio`          | Exercises local voiceover; requires the model and compiled workers                                                              |
| `npm run qa:generation`     | Tests generation integration with simulated provider responses                                                                  |

Other feature suites are listed in `package.json`. Some integration suites can use a signed-in assistant or network provider. Inspect opt-in settings and do not assume every `qa:*` command is offline or cost-free. Synthetic fixtures and frame samples do not replace watching and listening to the finished video.

GitHub Actions is configured to run dependency installation, runtime preparation, typechecking, tests and a source build sequentially on the standard `macos-15` ARM64 runner. [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) lists this label as Apple Silicon. The workflow does not package an app or run the full local speech/export QA. Linux is not a supported install target because the current media dependencies are pinned to macOS arm64.

Never run tests against private client media. Do not start paid generation or modify a real assistant configuration as a routine smoke test.

## Local packaging and distribution

The current release path is source-only. The pinned FFmpeg binary was built with `--enable-nonfree` and cannot be redistributed as part of an app bundle. The packaging guard rejects that binary by default.

For a private local build only, after preparing vendor files and completing a full build:

```sh
CUTLINE_ALLOW_NONFREE_LOCAL_BUILD=1 npm run package
```

This override acknowledges the current binary limitation. It does not grant redistribution rights. Do not upload the resulting app, DMG or archive. A distributable build needs compatible replacement binaries and a review of all dependency and bundled-asset terms, including Remotion. Start with the [third-party notices](../THIRD_PARTY_NOTICES.md).

The script targets macOS arm64 and exposes the result at `release/Cutline-darwin-arm64/Cutline.app`. The staged directory has a `.noindex` suffix and is linked through the conventional path to keep duplicate entries out of Finder search.

Packaging stages only the expected vendor files and checks model integrity, required app bundles and the Whisper binary's architecture/library links. The browser's exact manifest-listed relative framework symlinks are permitted only when they stay inside the browser directory. Other symlinks and unexpected files or directories inside `vendor/` stop packaging. Keep personal media, caches and unrelated tools elsewhere; review the named item before removing or relocating it. The application copy also uses an explicit list of allowed top-level files and folders.

Packaging overwrites the previous staged build. It does not install into Applications, sign, notarize, upload or publish it.

## Code map

| Path               | Responsibility                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `src/main/`        | Electron lifecycle, files/media, project storage, sessions, jobs, integrations and MCP           |
| `src/renderer/`    | React editor panels, timeline and inspector                                                      |
| `src/shared/`      | Validated model, atomic commands, editing plans, caption/motion logic and assistant instructions |
| `src/composition/` | Shared preview/export composition and media/text rendering                                       |
| `tests/`           | Unit and integration tests                                                                       |
| `scripts/`         | Setup, development, build, packaging and feature QA                                              |
| `docs/`            | User and developer workflows                                                                     |

Project changes should use validated commands and preserve Undo. Assistant edits check the current project ID and revision. Keep source timestamps in seconds and timeline positions in frames or explicit time objects. Preserve native editable clips and layers instead of flattening an edit unnecessarily.
