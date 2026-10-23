# Studio motion in Cutline

1. Open Text → Scenes → Studio. Choose Title, System, Identity or Outro. Preview a card on hover or keyboard focus, then add it to the timeline.
2. Select the scene. In Properties → Motion layers, select a layer. Edit copy, fill, outline, placement and scale. Text has per-layer weight, alignment, tracking and leading. Short, deliberate copy fits the supplied hierarchy best.
3. For masked typography, choose Line reveal. Explicit newlines define the lines. Set start and duration, then scrub the entrance and hold. Stagger separates each line. Trim/split keep the original animation phase.
4. Expand Animate layer, choose a property and add keys. Choose Cubic Bézier for custom timing; pick a curve preset or edit its four handles. The graph samples the actual animation, including the clip's trim offset. Easing on one key controls the segment leading to the next key for that property.
5. Open Audio → Music sync. Compose Gentle momentum or import and analyze a song. Set the beat grid, then use beat markers or Sync cuts to align the sequence. Choose Graphical accents under Pulse motion, use Scale and a low strength, and adjust Decay · frames. Studio ornaments are explicitly marked as accents. In a shape's Properties, Music response can keep it steady or mark it as an eligible accent.
6. Play the whole sequence with music, inspect entrances, holds and exits, then export. Save the .cutline project to retain editable layers, keys, typography and music bindings.

The supplied Studio study uses four scenes of eight beats each, at 30 fps and 104 BPM. The title has a masked two-line entrance, the system scene introduces an ordered composition, identity brings controlled secondary motion, and the outro resolves the sequence. Restrained accents follow the music while the type remains readable. Its original music is generated locally.

Connected editing agents use the same validated operations as the interface. Open Settings → Agent connections to connect Claude or Codex. For the ChatGPT-signed-in assistant, open the assistant in Cutline. Ask it to read the current editing schema, make one revision-checked transaction, inspect rendered previews and export. The ChatGPT website needs its own configured HTTPS/tunnel connection; the local launcher alone connects local clients.

Custom Bézier handles are bounded: X 0–1 and Y -2–3. Each scene supports up to twenty-four layers and one hundred keyframe records per layer. Typography spacing is measured in canvas pixels. Masked reveals use explicit lines, so preview the layout when changing copy or canvas size. These tools provide editable 2D vector/text motion; 3D, tracking and external After Effects plugins are outside this build.
