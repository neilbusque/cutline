# Cutline music workflow

1. Open Audio → Music sync. Add a song through My audio, or compose a local original bed. Choose the placed music clip when a project has several audio layers.
2. Analyze locally. Confirm the tempo and first-beat phase by listening and seeking the markers. Expand Edit beat grid to set 20–300 BPM and an offset measured from the original audio start. Detected energy stays available after a grid correction.
3. Choose a contiguous visual cut sequence, then Sync cuts. The sequence's first and last edges stay fixed. A boundary moves only when a feasible nearby beat exists; unavailable source handles, transitions and caption ownership are respected. Dialogue is protected unless explicitly included.
4. Select a motion, text, image or video clip. Expand Pulse motion, choose Beat or Measured energy, Scale/Glow/Both, strength and decay in frames; apply once. For an editable motion scene, choose Graphical accents to keep the clip frame, headlines and background steady. Studio scenes default to this restrained accent response; per-shape Music response can mark an ornament as an accent or keep a layout panel steady. Remove pulse keeps the other motion keys and styling.
5. Preview, refine, Undo/Redo, and export. Rhythm metadata and bindings save inside the editable .cutline project.

Show beats controls music markers and snapping. The sticky ruler keeps beat navigation visible while scrolling tracks. Dense zoomed-out views show a representative grid; snapping retains all beats.

Original music styles are generated on this Mac: Bright momentum 116 BPM, Gentle momentum 104 BPM and Quiet horizons 82 BPM. These arrangements use original local synthesis. The current composer accepts 1–180 seconds.

Analysis is bounded to 20 minutes. Beat detection estimates onset rhythm; it may need manual correction for syncopation, sparse percussion or changing tempo. Every four beats starts at the first grid beat and does not infer a time signature/downbeat. Manual grids without analysis cannot supply measured energy. Beat mode requires beat markers; energy mode requires measured audio.

## Agent tools

- cutline_music_create: compose and place original music; one undoable edit.
- cutline_music_analyze: measure source rhythm/energy; one undoable edit.
- cutline_music_grid: set source BPM/offset, retaining energy.
- cutline_music_inspect: inspect source beats and mapped timeline frames.
- cutline_music_sync: align starts or contiguous cuts; dryRun previews commands.
- cutline_music_reactive: apply/remove editable visual pulse bindings.

Editing tools require the current projectId/revision. Analyze and compose recheck the revision after processing; a concurrent edit prevents an outdated result from overwriting the project. Missing/deleted music bindings become inactive and can be removed or rebound.

Example request: “Analyze this music, align the silent B-roll cuts to nearby beats, and give the title a subtle scale-and-glow pulse. Preserve dialogue and captions. Show me a preview before exporting.”

## Preview and export

Music response uses the same source-time math in preview and export. Pitch-preserving audio time stretching can move transients, especially at very slow playback speeds; use music at its original speed for the most accurate audible beat alignment. Fractional source trims are preserved.

On this Mac, hardware-composited video previews can appear slightly brighter than source-based export; synthetic shapes and the exported source colors remain correct. GPU acceleration remains enabled for playback performance.
