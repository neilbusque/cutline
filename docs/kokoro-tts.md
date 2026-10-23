# Local text to speech

Open **Audio → Text to speech**. Paste a script, choose a voice and pace, then select **Generate voiceover**. Listen to the preview before adding it to the timeline or saving a WAV. The Audio panel opens here by default; Music sync and My audio remain available.

Cutline uses the Kokoro 82M v1.0 model and eight English voices. Speech synthesis runs on this Mac with no API key, credit balance or per-use charge. [Source setup](development.md#prepare-local-voiceover) downloads the model, and private local builds can include it. If a development install lacks the model, Download Kokoro performs a one-time download; generation then works offline. Broken bundled voice files require repairing the app, rather than downloading the model again.

The default voice is Heart at 1.08x. Pace ranges from 0.65x to 1.5x, and a script can contain up to 5,000 characters. Long scripts are split into bounded passages while preserving their words. Output is mono 24 kHz PCM WAV. Cancel stops the isolated inference process and clears incomplete output. The engine uses two CPU inference threads.

Changing the script, voice or pace marks the displayed take as an earlier version. Generate another take to add the new version directly. Earlier takes remain available under My audio.

The assistant's **Create a local voiceover** starter uses the same Kokoro engine through `cutline_voiceover`. It imports the audio unless timeline placement was requested. Scripts entered directly in Audio stay on the Mac. Text supplied through assistant chat is also shared with the selected assistant provider.

Cloud connection status checks only inspect whether credentials have been saved. They do not decrypt those credentials or request Keychain access for local speech. Saved credentials remain encrypted and are read when their cloud service is used.

Kokoro's source and model weights use Apache 2.0 licensing. Notices remain bundled with the model and runtime.

- [Kokoro source and model](https://github.com/hexgrad/kokoro)
- Model revision: `1939ad2a8e416c0acfeecc08a694d14ef25f2231`
- Runtime: `kokoro-js` 1.2.1, quantized CPU inference

Verification command: `CUTLINE_QA_OFFLINE=1 CUTLINE_QA_ACTIVE_CANCEL=1 one-at-a-time npm run qa:audio`.

For an installed app, additionally set `CUTLINE_PACKAGED=1` and `CUTLINE_APP_EXECUTABLE=/Applications/Cutline.app/Contents/MacOS/Cutline`. QA uses an isolated project and profile. Its test-only network guard runs inside the synthesis worker and fails external network attempts while allowing the editor's local bridge. Screenshots cover the desktop and the Text to speech panel at 390px; the whole Mac editor retains its desktop minimum width.
