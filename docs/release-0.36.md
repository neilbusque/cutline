# Cutline 0.36

Generated 3D models now have a direct path into Cutline. Drop a GLB or glTF into Media, choose a view and animation, and render it onto the timeline.

- **3D scene controls:** duration, turntable or camera orbit, camera angle and distance, exposure, background and embedded animation selection.
- **Transparent overlays:** place a model over footage or native graphics on another track.
- **Kept source:** model files, textures and buffers are copied with each scene version. Later edits preserve the asset ID, timeline clips and Undo history.
- **Assistant access:** `cutline_model3d` imports, reads and updates scenes with project and source-version guards. Claude and Codex can generate a file and add it without writing a scene wrapper.
- **Local rendering:** no model upload or generation service is used by import. Completed renders provide responsive timeline playback and consistent exports.
- **Advanced source:** edit the generated HTML when custom animation is needed. Rendering custom source detaches automatic settings to preserve those changes.

See [3D models](model-3d.md) for file support, examples and current limitations.

Earlier: [0.35](release-0.35.md).
