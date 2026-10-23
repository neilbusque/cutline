# Third-party notices

Cutline's original source code and documentation are provided under the [MIT License](LICENSE). That license does not replace third-party licenses, grant rights in imported media, or relicense downloaded runtimes, models and binaries.

This release distributes source only. Dependencies are resolved from `package-lock.json`; tools and model files are downloaded or built locally. `node_modules/`, `vendor/`, app bundles, installers, model weights and generated media are not part of the source release.

## Remotion

Cutline uses `remotion`, `@remotion/player`, `@remotion/renderer` and `@remotion/bundler` at version 4.0.538. Remotion is source-available under its custom license and is not OSI open source. Eligibility and usage conditions apply independently of Cutline's MIT license. Review the [Remotion license FAQ](https://www.remotion.dev/docs/license/faq) and the [license shipped with the pinned package](licenses/remotion-LICENSE.md).

Cutline does not grant a Remotion license, establish eligibility for its free tier, or grant permission to relicense Remotion code. The dependency's own notices and terms remain applicable.

## FFmpeg and FFprobe

The current `@ffmpeg-installer/darwin-arm64` 4.1.5 binary reports `--enable-nonfree` and states that it is not redistributable. **Do not distribute an app, installer or archive containing that binary.** The package script rejects it by default. `CUTLINE_ALLOW_NONFREE_LOCAL_BUILD=1` allows a private local build only and does not change its terms.

FFmpeg's license depends on its build configuration and incorporated components. See [FFmpeg's legal guidance](https://ffmpeg.org/legal.html). The separate FFprobe package's declared license is not evidence that every bundled media binary has identical terms. A future binary release needs exact build provenance, corresponding source/notices and a complete distribution review.

## Local speech

- **whisper.cpp:** MIT. The pinned source revision is recorded in [licenses/whisper-source-revision.txt](licenses/whisper-source-revision.txt); its [license](licenses/whisper-LICENSE) is retained. Setup downloads verified source/model inputs and builds the CLI locally.
- **Kokoro 82M model:** the upstream model and the selected ONNX conversion declare Apache-2.0. The exact conversion revision and file hashes are recorded in `src/shared/tts-model.ts`. See the [original model card](https://huggingface.co/hexgrad/Kokoro-82M) and [pinned ONNX model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/blob/1939ad2a8e416c0acfeecc08a694d14ef25f2231/README.md).
- **kokoro-js 1.2.1:** Apache-2.0; its [package license](licenses/kokoro-js-LICENSE) is retained.
- **phonemizer 1.2.1:** the JavaScript wrapper declares Apache-2.0, but it uses embedded eSpeak NG. See the [wrapper source](https://github.com/xenova/phonemizer.js), [wrapper license](licenses/phonemizer-LICENSE) and [eSpeak NG GPLv3 license](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING). Do not describe the entire voice stack as Apache-2.0. The exact embedded eSpeak build and any source-distribution obligations require review before distributing binaries.
- **Transformers.js and ONNX Runtime:** retain their own Apache-2.0 and MIT terms and transitive notices. Package metadata alone does not inventory every included native component.

The speech setup retains the model license, model card and notice beside downloaded files. These notices do not establish that a packaged application satisfies all downstream distribution obligations.

## Browser and application runtime

Rendering uses the full Google Chrome for Testing 156.0.8078.47 application, downloaded locally from Google's official distribution and verified against the tracked archive and file manifest. See the [official download documentation](https://developer.chrome.com/docs/automation-and-testing/download-test-binaries) and [Google's Chrome terms](https://www.google.com/chrome/terms/). Retain the downloaded build's `ABOUT`, embedded credits and component notices, including its Widevine license. The Chromium source license alone does not describe all terms of this Google browser distribution.

Electron, Chromium, Node.js and their incorporated components retain their own licenses and notices. Electron is MIT licensed; Chromium includes BSD-style licensed code and many separately licensed components. A future binary distribution must preserve and review the terms of the actual included builds. See [Electron's license](https://github.com/electron/electron/blob/main/LICENSE) and [Chromium's license](https://chromium.googlesource.com/chromium/src/+/main/LICENSE). Cutline's source-only release does not include the downloaded browser application.

## Other packages and media

React, React DOM, Zod, Lucide, the MCP SDK, build tools and test tools retain their package licenses. Exact installed versions are in `package-lock.json`. [Source references](licenses/source-notices.md) identify important upstream sources and the provenance of included notice copies; this is not an exhaustive software bill of materials.

Imported footage, stock assets, fonts, logos, reference images and generated content require their own rights review. Stock credits are stored with assets, but attribution alone does not grant permission to use an asset. No third-party creator's videos or identity are licensed by Cutline's source license.

The source release is not a guarantee of legal suitability for a particular use, organization or jurisdiction. Review the actual components and upstream terms before redistribution.
