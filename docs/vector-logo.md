# Custom vectors and logo reveals

## Generate a graphic

Open **Generate → Graphic** (Generate opens on Graphic; **Motion → Vectors** has a **Generate** button that goes there), describe it and choose a style:

- **Flat:** solid fills in 3 to 5 harmonious colors.
- **Line icon:** one stroke width with round ends; each stroke draws on separately.
- **Logo mark:** a bold silhouette that reads at small sizes.
- **Soft gradient:** app-icon style gradients and soft highlights.
- **Badge:** a base shape with a symbol on top.

Choose **Square**, **Wide** or **Tall**, and **Claude** or **ChatGPT** to draw it. Claude uses the Claude Code you are signed in to; ChatGPT uses the Codex in the ChatGPT app.

1. The assistant draws an editable vector. Cutline checks it and asks for one correction when something would be lost.
2. The assistant then looks at its own drawing exactly as it renders and fixes what reads wrong (proportions, overlaps, missing parts). This takes 20 to 40 seconds in all.
3. A subject too detailed for a clean vector (a busy scene, realistic texture, a crowd) becomes a picture instead: Higgsfield's Recraft model paints it on a flat backdrop and Cutline removes the backdrop, so it sits on your video like a sticker. This needs Higgsfield connected in **Settings → Pictures and video** and **Detailed graphics as pictures** on. It uses your Higgsfield credits; Settings shows the price. Pictures are added to Media at once, so you never pay twice for the same one.

After a drawing, **Make it a picture with Higgsfield instead** asks for a picture directly. After a picture, **Draw it as a vector instead** goes back to an editable drawing. **Add to timeline** places the result at the playhead: a vector as editable layers, a picture on a Graphics track above your footage, centered above the captions on tall videos. Words are added as live titles, not drawn into the graphic.

## Real logos and pages

- **Brand logos:** search a product name and click a result. Library marks (Simple Icons) arrive as editable vectors in the brand color, white or black. Products the library does not carry use the icon from their own website (shown with the site name), as a vector when the site offers an SVG and otherwise as its largest app icon.
- **Page screenshot:** enter a web address and choose Desktop or Phone. The page is captured at 2× in a private window without your cookies. Cookie banners and sign-in prompts are removed. The shot is placed as a rounded card above the caption area.

Logos and pages are placed for three seconds at the playhead. Use them on the words that name the product.

## Build or import a mark

1. Open **Motion → Vectors**.
2. Choose **Draw vector** to draw a path of your own (the Path designer opens empty with **Add points** on; the starter shape shows until you apply) or **Import SVG** for your artwork. Import creates a centered composition at the playhead on an available text track, adding a track if needed.
3. Select the path layer in **Properties → Motion layers** and expand **Path designer**. Add points on the drawing area, select a point to move it, and edit its Bézier handles or precise coordinates. Use arrow keys to nudge; Shift makes larger steps. Numeric fields offer the same edits without dragging.
4. Choose an open or closed contour. **Apply path** saves the draft as one Undo; **Cancel changes** restores the saved path. Escape cancels a point/handle drag. Fill, outline, stroke width, size, position and animation remain editable in the layer controls.

Advanced SVG data and viewBox fields are available for compound paths, arcs and other curves. The point editor handles a single line or cubic Bézier contour; other valid SVG paths remain editable as path data. Imported transforms are retained, and the point controls work in the original vector coordinate system.

SVG import reads files from Illustrator, Figma, Inkscape and AI tools: paths and basic shapes, nested groups and `<svg>` viewports, `<use>` and `<symbol>`, transforms, CSS classes in `<style>`, every CSS color form, `currentColor`, group opacity (applied to each shape), fill rules, caps and joins, and linear or radial gradient fills with their transforms. Limits are 1 MiB per file, 64 layers and 65,536 characters per path; files with more shapes combine neighbors that share a color. Text, embedded images, filters, masks, clipping paths, patterns and dashes are left out or simplified, and the import lists what changed. Scripts, event handlers and external references never reach the project.

## Reveal a logo

Choose **Logo / Draw**, **Logo / Orbit** or **Logo / Signal** in the Vectors library for a finished editable scene using an original Cutline mark. The same scenes are in **Scenes → Logos**.

For your own mark, select its clip, choose a visible path layer in **Properties → Motion layers**, expand **Logo reveal**, choose a style and click **Apply logo reveal**. Finish or cancel an unsaved vector draft first. Reveal styles animate outline and fill separately with staggered path timing. Draw builds the outline before the fill; Orbit adds a controlled turn and settle; Signal adds a short scale-and-opacity arrival. Fill-only artwork receives a temporary outline in its existing color. Open stroke-only artwork remains unfilled.

Applying a reveal clones the selected clip's motion, so other clips using the same mark keep their animation. Existing vector coordinates, transforms, colors and position curves remain intact. Reveal curves are editable through **Animate layer**, including **Fill opacity**, **Stroke reveal**, **Scale**, **Rotation** and **Opacity**. Trimmed clips start the new reveal at their current animation phase. Disable Repeat or Ping-pong looping before applying a reveal.

## Follow the music

Place music on the timeline, analyze it or compose an original track in **Audio → Music sync**, then use **Pulse motion → Graphical accents**. Logo scenes default to a subtle response on designated ornaments while their lettering stays steady. Beat markers and **Sync cuts** can align scene changes. See [Music workflow](music-sync.md).

## Save, export and ask an agent

Save a `.cutline` project to keep the editable vector geometry and keyframes. SVG paths are embedded in the project; the original SVG file is not a continuing media dependency. Audio, video and image files still need their normal media paths. MP4 export uses the same vector and animation renderer as the editor.

Claude, Codex and the ChatGPT-signed-in assistant receive vector fields and actions through the editing schema. For example: “Import my SVG logo, apply a Draw reveal, keep the brand colors, time three scenes to this music, and export a preview.” The local file import tool is `cutline_vector_import`; structured actions include `motion.svg` (inline SVG text), `motion.vector` and `motion.logoReveal`. `cutline_graphic` makes a graphic from a sentence through the same route as the panel (`prompt`, optional `style`, `aspect`, `palette`, `route` auto, vector or picture, and `at` to place it). `cutline_reference` adds a real logo (`kind: "logo"`, `target`: product name or website) or a page screenshot (`kind: "screenshot"`, `target`: address, optional `selector` and `phone`). Changes are revision checked and undoable. See [Agent setup and tools](agent-control.md).
