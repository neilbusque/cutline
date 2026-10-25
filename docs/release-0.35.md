# Cutline 0.35

Custom HTML animation now stays editable inside Cutline. Import an existing HyperFrames project or start with a title, chart or real Three.js scene from **Media → New scene**.

- **Scene source editor:** change HTML, CSS and animation code, then render the update. Each use of the scene updates together. Undo restores the previous source and video.
- **Reliable playback:** scenes render locally through HyperFrames before entering the timeline. Scrubbing, still previews, trimming, effects and MP4 export use the rendered version.
- **Offline starters:** local GSAP and Three.js runtimes are supplied with every source snapshot. Other project media and libraries remain local when imported with the HTML.
- **Transparent scenes:** render alpha WebM for overlays. Cutline preserves transparency through playback and export and avoids opaque preview copies. Reverse these animations in their source; the ordinary Reverse control is unavailable for transparent scenes.
- **Assistant access:** `cutline_hyperframes` imports, reads and updates source with revision checks, paged reads, cancellable jobs and protection against overwriting a newer scene.
- **Recovery:** managed source and rendered versions remain separate from original files. Missing rendered scenes can be rebuilt from **Edit source**.

HTML objects remain source-editable inside a scene. Native Cutline text, vectors, captions, footage and audio keep their existing editing controls. See [editable HTML scenes](hyperframes.md) for source requirements and moving projects.

Earlier: [0.34](release-0.34.md).
