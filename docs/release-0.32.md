# Changes in 0.32.1

- **Main actions stay in view.** Build Reel, Generate video, Generate voiceover, Add sequence, Create outline, Produce scenes, Build video and the scene navigation sit in a bar pinned to the bottom of their panel, so they never disappear below the fold on a smaller window.
- **The Higgsfield key moved to Settings → Video generation**, next to your other connections. Generate shows whether Higgsfield is connected and opens Settings to connect or manage it.
- **One heading style for every panel.** Story studio, Caption studio and Build a Reel use the same plain heading as the rest; repeated headings under the Audio tabs and the filler intro line are gone. Effects is called Effects. Buttons no longer carry a redundant plus sign.

# Changes in 0.32.0

## Drawn illustrations in creator-style Shorts

A beat can now show an original illustration: `kind: "draw"` with a short description ("a friendly green monster eating buzzword stickers"). The signed-in Claude or ChatGPT draws it as an editable vector, three at a time, and Cutline places it large in the style's panel with the style's entrance. Any background the model adds behind the subject is removed. The assistant uses drawings for the key ideas a script names without a real product, so Shorts no longer fall back to plain text there. Long style builds and page captures now hand back a job to wait on instead of timing out.

## Clearer everywhere

- The player clock reads minutes and seconds first, with frames quieter (0:03:00 is three seconds).
- Counts read naturally ("1 caption", "1 scene", "2 cutaways").
- Settings says **Reconnect** once Claude is connected and **Sign in again** once ChatGPT is.
- Motion → Scenes shows every category, wrapping instead of hiding them off the edge.
- Motion tabs, the Vectors style picker (it has its dropdown arrow again), the Captions apply bar and the Properties caption hint have proper spacing.
- Plain labels: Text to speech says "Voices run on this Mac, free", Music sync says where the music starts, Stock lists "Wikimedia", Projects marks the open one **Current**, Media says "Select media to stack as layers" until you have.
- The Story panel shows unsaved storyline edits in a calm grey instead of a warning color, and the status bar no longer repeats filler text.
- The Assistant intro is shorter, so more suggestions fit.

Earlier: [0.31](release-0.31.md).
