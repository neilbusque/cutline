# Contributing to Cutline

Start with the [development guide](docs/development.md) and the workflow guide for the feature you plan to change.

## Before you begin

Describe a reproducible bug or concrete proposal in an issue. Check existing issues and pull requests first. For a large change, explain the user workflow and compatibility impact before implementing it.

Read the repository's current license and applicable dependency terms. Contributions must not include code, fonts, media or models that the project cannot distribute. Third-party additions need their notices and provenance. Current public distribution is source-only because the pinned FFmpeg binary is nonfree and not redistributable.

## Make a focused change

- Preserve existing projects, source media and unrelated features.
- Use validated project commands and keep coherent changes undoable.
- Keep preview and export behavior consistent.
- Use actual speech timings for captions and explicitly selected assets for proof shots.
- Keep editing local unless the user selects a connected service.
- Use plain English for settings, errors and recovery steps.
- Include keyboard access, visible focus and useful labels for changed controls.

Keep unrelated refactoring and formatting out of a pull request. Do not commit profiles, connection files, API keys, generated media, private projects, render outputs, dependency folders or app bundles.

## Test the behavior

Run checks sequentially:

```sh
npm run typecheck
npm test -- --maxWorkers=1
npm run build
```

Add a targeted regression test when it protects meaningful behavior. For UI work, exercise the actual flow and capture the supported desktop size. Check narrow panels when changing panel controls. For rendering changes, inspect frames and play the exported video with sound.

Read the relevant `qa:*` script before running it. Use disposable profiles and synthetic or licensed fixtures. Do not use private projects, send messages or spend generation credits for a routine test. Run one browser/app QA suite at a time and close processes you start.

Report what passed, failed and was not exercised. Simulated provider responses do not prove a live account works. Frame samples do not prove continuous playback or audio quality.

## Submit a pull request

Explain the problem, resulting behavior and verification. Include reproduction steps for a fix, before/after images when useful, and any migration, platform, dependency or licensing implications.

Do not silently change the project-file format, upgrade render dependencies, regenerate large fixtures or add bundled assets as a side effect of a small feature. Explain those changes so reviewers can assess compatibility and distribution impact.

Security-sensitive reports follow [SECURITY.md](SECURITY.md), not public issues or pull requests.
