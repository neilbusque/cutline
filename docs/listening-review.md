# Listening review

In **Settings & connections → Listening review**, enable **Review every export**. Cutline reviews the whole exported soundtrack, applies supported fixes when enabled, and reviews the corrected export again. The same workflow runs for exports requested by Claude, Codex or another MCP client.

This sends audio to the official hosted Qwen3.5 Omni demo, which uses Alibaba DashScope. It does not upload the video or use a connected paid API account. The setting is shared by Cutline sessions and is off on a fresh installation. Hosted availability and retention are controlled by the provider. Local editing and export still work with review off.

## What happens on export

1. Render the current project and preserve a snapshot of the edit.
2. Measure the actual exported audio locally. Align speech with the bundled Whisper model and compare existing caption phrases without rewriting their words.
3. Review every part of the soundtrack with the audio model. Longer videos use consecutive 60-second sections with a short overlap, including the ending. Missing or invalid sections never count as a complete review.
4. Corroborate model observations against local measurements and isolated native voice, music and effects mixes.
5. Render one candidate with supported corrections, then review its complete soundtrack again. Accept the changes as one Undo step only if the project is still the same revision and the candidate passes the regression checks.
6. Keep a JSON report next to the MP4. The export status offers **Review report** and **Show in Finder**.

The renderer closes before cloud review. Audio analysis and review requests run sequentially. Cancel stops the current render, local audio process or hosted request. It cannot retract data already sent to the provider.

## Audio roles

Select a media clip, then use **Inspector → Audio & fades → Audio role** to identify **Voice**, **Music**, **Sound effects** or **Mixed**. Known generated narration, composed music and sound-effect placements receive roles automatically. Imported recordings remain unspecified until their role is known. A recording containing voice and music should be Mixed.

Roles let Cutline render exact isolated native mixes while preserving clip timing, transitions, fades and volume automation. The model does not guess a file's role and then alter it.

## Supported corrections

- Reduce measured output clipping risk by adding gain headroom. This does not repair distortion already recorded in a source.
- Make bounded voice gain adjustments when an explicit voice mix and local measurements support the model's finding.
- Lower explicit music or effects that mask speech when both the model and relative stem levels agree. Existing volume curves retain their shape.
- Correct adjacent caption boundaries when fresh local speech alignment, matching wording and audio activity agree. Preserve spelling, phrase structure and protected reveal cues.
- Add a short ending fade to an explicit audio-only music or effects clip when its active tail supports a reported abrupt ending and no existing fade explains it.

Cutline does not replace or clone a voice, rewrite dialogue, remove spoken content, move the whole timeline, or apply uncertain model suggestions. Ambiguous mixes, pronunciation, performance, baked-in noise and unsupported caption changes stay in the report for review. The correction loop is bounded to one pass.

## Reading the result

**Reviewed** means every audio section was processed and no unresolved finding remains. It is audio-model review, not human listening or continuous picture approval.

**Needs review** means the complete soundtrack was reviewed but a concern, local limitation or concurrent edit prevented full automatic acceptance. Check the report.

**Review incomplete** means a provider, decoding or full-audio coverage failure prevented completion. The original usable export is retained; it is never silently labelled reviewed. Missing local caption alignment appears as a limitation under Needs review.

**No audible soundtrack** is based on complete local measurement, not a model response.

The report includes source and final revisions, audio-file hashes, full coverage, local evidence, model observations, accepted fixes and unresolved findings. Model timestamps and transcripts can be wrong. An observation is never an instruction to execute.

## Assistant tools

Use `cutline_listening_review` with `action: "settings"` to read shared settings. `action: "configure"` sets `enabled` and/or `autoFix` when the user authorizes hosted audio review. `cutline_export` then uses that setting automatically. Wait for its export job, inspect its `listening` status, and read `cutline_listening_review` with `action: "report"` and the export `jobId`.

Use `cutline_edit` with `clip.update` and `patch.audioRole` to label known components. Preserve original footage and voices. An empty structural quality report, transcription, or successful encode alone does not prove listening quality.

## Regression checks

After `one-at-a-time npm run build`, run `one-at-a-time npm run qa:listening`. This uses disposable synthetic media and a separate profile. It exercises the settings UI, native rendering and isolated mixes, local alignment, supported corrections, a full second review, one-step Undo, assistant exports, provider failure, cancellation and concurrent edits. Hosted responses are controlled fixtures in this run.

To verify the installed app against the actual hosted reviewer, run:

```sh
CUTLINE_PACKAGED=1 CUTLINE_LISTENING_LIVE_ONLY=1 one-at-a-time npm run qa:listening
```

Only the synthetic soundtrack is uploaded. The script records screenshots, review sidecars and a JSON result under the system temporary folder, closes its app and browser, and leaves existing Cutline sessions untouched.
