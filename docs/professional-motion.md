# Professional motion in Cutline 0.12

Open **Text → Scenes → Signature** to build a three-part sequence: Pace, Intent and Mark. Each scene has a coordinated crescent and baton motif, masked typography and sequenced geometry. The composition adapts to landscape and portrait canvases. Search finds scenes across the entire collection; clear the search to return to the selected category. The Studio collection remains available alongside Signature.

Select a scene and open **Properties → Motion layers**. Give layers descriptive names and use the eye button to hide a layer while working. Hidden layers retain their settings and animation, and do not respond to music. Names and visibility save with the project. Layer selection still identifies the original layer index, so agents and the inspector target the same object.

Expand **Animate layer**, select a property, then select a key in its key list. Set **Keyframe frame** and press **Move keyframe** to adjust its timing. For Play once, the field measures frames from the visible clip's start, including after a trim. For Cycle and Ping-pong, it measures the repeated animation curve from zero to its loop endpoint. The move preserves that property's value, easing and custom curve. Other properties keep their timing. An occupied destination for that property is rejected with an explanation; choose another frame. Undo restores a move in one step.

Choose **Cubic Bézier** to shape the outgoing segment. Drag either graph handle; release to commit one undoable edit. Escape cancels the drag. Focus a handle and use arrow keys for 0.01 steps, or Shift with an arrow for 0.1 steps. The four numeric fields provide a precise alternative. X values are bounded to 0–1 and Y to -2–3, allowing anticipation and overshoot. The property graph samples the actual animation, including clip phase after trimming.

In **Audio → Music sync**, import and analyze music or compose an original track locally. Check the beat grid and use markers or Sync cuts to place transitions on beats. New Signature and Studio scenes default to a subtle scale pulse on **Graphical accents**. Set a shape's **Music response** to Accent or Steady, then tune pulse strength and decay. Typography and large layout surfaces stay steady in this mode. Existing whole-clip bindings retain their scope until you change them.

The Signature example uses three eight-beat scenes at 104 BPM, 30 fps and 1280×720. Its original soundtrack is generated locally. Play the complete sequence with sound, scrub entrances and cuts, then export and retain the editable `.cutline` project.

Connected Claude and Codex clients, and Cutline's ChatGPT-signed-in assistant, can read names and visibility, edit animation and move keys through the same validated editing schema. Ask the agent to inspect the project and schema, apply one revision-checked transaction, inspect rendered previews, then save or export. See [Agent control](agent-control.md) for connection details. The ChatGPT website requires its own configured HTTPS/tunnel connection; a local launcher connects local clients.

The editor supports editable 2D vector/text animation, compositing, captions, transitions and music response. Each motion supports up to 24 layers and 100 keyframe records per layer. It does not provide After Effects project import, 3D, tracking, rotoscoping or third-party After Effects plugins.
