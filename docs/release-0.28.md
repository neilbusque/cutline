# Changes in 0.28.0

This version adds creator-style Shorts and prepares Cutline for source distribution under the MIT license. The current supported target is macOS 15 or later on Apple Silicon.

## Editing

- **Creator punch** keeps the speaker prominent with short, outlined captions and an active-word highlight.
- **Screen demo** supports explicit proof shots from your imported screenshots and recordings.
- **Proof shots** in Reel Builder can show a split view or a cutaway while the original speech continues. Timing refers to the original source clip, and every shot stays editable on the timeline.
- Auto edit offers both formats. Choose **Build manually** to place proof shots at specific moments.

See the [creator shorts guide](creator-shorts.md) for timing, layout and source requirements.

## Source setup and maintenance

- Documented setup covers the Electron runtime, media-tool permissions, local transcription tools, voice models and export browser.
- Source/model downloads are pinned and checked against hashes.
- Development includes voiceover workers and cleans up its child processes on exit.
- Preview-frame workers close their browser when the editor disconnects.
- Local packaging validates model files and stages only expected vendor resources. Browser framework symlinks must match the reviewed manifest and stay inside the browser directory; other symlinks and unexpected files are rejected.
- Dependency updates include the MCP SDK and targeted native-image/network overrides. The lockfile records exact runtime and development-tool versions.
- Remotion components use the matching 4.0.538 release. Rendering uses the pinned full Chrome for Testing 156.0.8078.47 application with explicit `chrome-for-testing` mode. Setup verifies the official archive and file inventory. Rerun vendor setup and rebuild when upgrading an existing checkout.
- Public contribution, security reporting and troubleshooting guides are included.
- Source CI is configured to run checks sequentially on the standard `macos-15` ARM64 runner. Full speech and export review remains a separate release step.

## Distribution

Cutline's original source uses the [MIT License](../LICENSE). Dependencies retain their own terms. Remotion uses a custom license, and the local speech stack includes separately licensed components.

This is a source-only release. The currently pinned FFmpeg binary is nonfree and must not be redistributed. Packaging rejects it by default; the private local-build override does not authorize distribution. Read the [third-party notices](../THIRD_PARTY_NOTICES.md) before preparing any application bundle.
