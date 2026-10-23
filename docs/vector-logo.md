# Custom vectors and logo reveals

## Build or import a mark

1. Open **Text → Vectors**.
2. Choose **Draw vector** for an editable starter or **Import SVG** for your artwork. Import creates a centered composition at the playhead on an available text track, adding a track if needed.
3. Select the path layer in **Properties → Motion layers** and expand **Path designer**. Add points on the drawing area, select a point to move it, and edit its Bézier handles or precise coordinates. Use arrow keys to nudge; Shift makes larger steps. Numeric fields offer the same edits without dragging.
4. Choose an open or closed contour. **Apply path** saves the draft as one Undo; **Cancel changes** restores the saved path. Escape cancels a point/handle drag. Fill, outline, stroke width, size, position and animation remain editable in the layer controls.

Advanced SVG data and viewBox fields are available for compound paths, arcs and other curves. The point editor handles a single line or cubic Bézier contour; other valid SVG paths remain editable as path data. Imported transforms are retained, and the point controls work in the original vector coordinate system.

SVG imports support paths and basic rectangle, circle, ellipse, polygon, polyline and line geometry, nested groups, transforms, inherited solid fill/outline and supported paint styles. They preserve fill rules and stroke caps/joins. Limits are 256 KiB per file, 24 path layers and 16,000 characters per path. Text must be converted to outlines. Expand nonuniformly transformed strokes to filled paths before importing. Gradients, filters, masks, external references, embedded images and scripts are rejected with an explanation before the project changes.

## Reveal a logo

Choose **Logo / Draw**, **Logo / Orbit** or **Logo / Signal** in the Vectors library for a finished editable scene using an original Cutline mark. The same scenes are in **Scenes → Logos**.

For your own mark, select its clip, choose a visible path layer in **Properties → Motion layers**, expand **Logo reveal**, choose a style and click **Apply logo reveal**. Finish or cancel an unsaved vector draft first. Reveal styles animate outline and fill separately with staggered path timing. Draw builds the outline before the fill; Orbit adds a controlled turn and settle; Signal adds a short scale-and-opacity arrival. Fill-only artwork receives a temporary outline in its existing color. Open stroke-only artwork remains unfilled.

Applying a reveal clones the selected clip's motion, so other clips using the same mark keep their animation. Existing vector coordinates, transforms, colors and position curves remain intact. Reveal curves are editable through **Animate layer**, including **Fill opacity**, **Stroke reveal**, **Scale**, **Rotation** and **Opacity**. Trimmed clips start the new reveal at their current animation phase. Disable Repeat or Ping-pong looping before applying a reveal.

## Follow the music

Place music on the timeline, analyze it or compose an original track in **Audio → Music sync**, then use **Pulse motion → Graphical accents**. Logo scenes default to a subtle response on designated ornaments while their lettering stays steady. Beat markers and **Sync cuts** can align scene changes. See [Music workflow](music-sync.md).

## Save, export and ask an agent

Save a `.cutline` project to keep the editable vector geometry and keyframes. SVG paths are embedded in the project; the original SVG file is not a continuing media dependency. Audio, video and image files still need their normal media paths. MP4 export uses the same vector and animation renderer as the editor.

Claude, Codex and the ChatGPT-signed-in assistant receive vector fields and actions through the editing schema. For example: “Import my SVG logo, apply a Draw reveal, keep the brand colors, time three scenes to this music, and export a preview.” The local file import tool is `cutline_vector_import`; structured actions include `motion.svg`, `motion.vector` and `motion.logoReveal`. Changes are revision checked and undoable. See [Agent setup and tools](agent-control.md).
