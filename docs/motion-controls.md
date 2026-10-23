# Motion Studio controls · 0.22

## Build a connected film

Open **Motion → Sequence**. Set your brand, opening headline, supporting idea and closing headline. Choose 12, 18 or 24 seconds, optionally pick an imported screenshot or recording, and open **Brand colors** to change the palette. The preview uses the same composition as export.

**Add sequence** creates three editable scenes at the playhead in one undo step. A traveling orbital mark connects the acts, clears the screen during its reading hold, and returns for the next transition. The middle screen is a separate editable media clip. Recordings play once, silently, and never extend beyond their available source duration. Existing captions remain above the inserted scenes. No decorative headline underlines are added.

The sequence creates the visual structure. Use Story/Audio and Captions for speech, music and subtitles; these remain independent timeline clips. Check actual speech timing before final export.

## Arrange several motion layers

Select a scene and open **Properties → Motion layers**. Check multiple layers, or use Cmd/Ctrl/Shift selection. The focused layer still has its own property editor; the selection count shows which layers receive layout and timing operations.

- Align left, center, right, top, middle or bottom to the scene canvas or selected bounds.
- **Space across / Space down** distributes three or more layers with equal gaps.
- **Timing for selected layers** offsets their animation, staggers by layer order, or scales timing. 50% is faster; 200% is slower.
- Duplicate or delete the selection as one undoable operation.

Alignment uses each transformed layer box at the playhead, including rotation, scale and anchor. It does not measure glows or music pulses. Timing preserves property-specific keyframes and easing. It retimes keys and masked line reveals from scene frame zero; word/character spacing remains in Text reveal, and clip duration stays unchanged. Unsafe collisions, out-of-range keys and unsupported looping edits are rejected instead of silently losing animation.

## Edit clip keyframes precisely

The graph displays the evaluated property curve, including easing overshoot. Select a key, seek to the previous/next visible key, move it to an explicit clip-local frame, or duplicate it at the playhead. Expand **Retime** to fit the visible keys into a chosen frame range.

Trims retain their animation phase. Retiming preserves hidden keys, other properties and custom Bézier curves. Occupied destinations and rounded frame collisions require a different frame range. Rapid full-curve edits use the revision guard rather than overwriting another edit.

## Place clips on the canvas

- **Snap** aligns clip edges and centers to the canvas and other visible clips; guides show the target. Hold Option while dragging to bypass it.
- Hold Shift while dragging to lock the movement axis. Arrow keys nudge 1 px; Shift+arrow nudges 10 px. A held nudge is one undo step; Escape cancels it.
- Drag resize handles with Shift to preserve aspect ratio. Rotated/scaled clips keep the opposite transformed corner fixed.
- Use the six inspector alignment buttons or **Lock aspect ratio** for numeric dimensions.
- Drag a numeric field's label to scrub its value. Shift uses larger steps, Option uses finer steps, Escape cancels and release commits once. The numeric draft changes during scrubbing; the composition updates when committed.
- **Grid** and **Safe area** are preview guides and never appear in export.

## Review before export

Check entrance, hold, cut boundaries and the final frame. Keep captions clear of important content. Inspect the actual exported movie and measure audio; structural checks and a successful encode cannot guarantee visual quality. The native motion engine is 2D and bounded; use appropriate media for true 3D scenes or unsupported effects.
