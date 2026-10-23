# Changes in 0.29.1

Cutline now has a guided explainer workflow in **Story → Explainer**. Choose a direction, enter your authored script, review the outline and select **Create explainer**.

## Fix in 0.29.1

Local connection metadata, session information and MCP handshakes now use the package version directly. This corrects the stale 0.28.0 label in version 0.29.0 and prevents future release labels from drifting. The four explainer styles and production workflow introduced in 0.29.0 are unchanged.

## Four editable directions

- **Kinetic type:** large phrases, scale changes and a moving graphic motif.
- **Product focus:** real product screenshots or recordings, an opening and a closing action.
- **Sketch flow:** process steps, drawn connectors and neutral side-by-side comparisons.
- **Editorial collage:** layered paper, labels and statement layouts.

These are reference-informed starters. They do not promise virality, copy a creator, generate factual scripts from a topic, or render true 3D scenes. See the [style research](explainer-styles.md) and [workflow guide](explainer-guide.md).

## Local production

- One action saves the outline, creates narration serially, aligns captions and assembles native editable scenes.
- Changing the visual style can reuse narration when the spoken words and voice settings still match.
- Cancelling keeps completed narration for a later retry. Caption failures keep the audio and stop automatic assembly until alignment succeeds or captions are turned off.
- The timeline follows actual voice duration. Rebuilding replaces the sequence owned by that story while preserving other clips.
- Concurrent story edits, canvas changes, edits to the previous story sequence and project switches stop automatic assembly.
- Existing Story and Product film controls remain available. Assistants can use `cutline_explainer` and `cutline_story_produce` for the same workflow.

## Source distribution

The supported target remains macOS 15 or later on Apple Silicon. This is a source-only release under the original source's MIT license. The pinned FFmpeg binary cannot be redistributed in an application bundle. Read the [third-party notices](../THIRD_PARTY_NOTICES.md) before packaging.
