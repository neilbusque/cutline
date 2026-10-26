# 3D models

Generate a model in Claude, Codex or a 3D tool, save it as **GLB**, then drop it into Cutline. A self-contained GLB is the easiest handoff because its geometry, materials, textures and animation can live in one file. Cutline also accepts glTF 2.0 JSON files with local buffers and textures.

## In Cutline

1. Open **Media → Import 3D**, or drop a `.glb` or `.gltf` file into the editor.
2. Choose the duration, camera and motion. **Turntable** rotates the model, **Orbit** moves the camera, and **Static** keeps the view still. An embedded animation can play alongside any of these.
3. Turn on **Transparent background** to put the model over footage, graphics or a background on a lower track.
4. Render the scene. Cutline adds it to the timeline at the playhead. Move, trim, scale and layer it like other scene clips.
5. Choose **Edit 3D scene** in Media or the Inspector to change the settings and render again. All clips using that asset update together; Undo restores the earlier settings, source and rendered video.

Camera distance is a multiplier of the automatically fitted view. A value below 1 moves closer and can intentionally crop the model. Imported materials and textures are retained. Exposure changes the lighting of the rendered scene.

The original model and its dependencies are copied into an immutable local scene folder. Editing or moving the original file after import does not break the scene. Rendering finishes before the new version replaces the old one, so the timeline keeps its current working version if a render fails or is cancelled.

## With Claude or Codex

Ask the assistant to create a GLB, then import it with `cutline_model3d`. The app does not need Blender installed to read the resulting file. Generating a model through another paid service requires the user's authorization for that service.

```json
{
  "action": "import",
  "projectId": "current-project-id",
  "revision": 0,
  "path": "/absolute/path/to/product.glb",
  "name": "Product orbit",
  "transparent": true,
  "settings": {
    "durationSeconds": 6,
    "motion": "orbit",
    "rotationDegrees": 70,
    "cameraAzimuth": 25,
    "cameraElevation": 15,
    "cameraDistance": 1,
    "animationIndex": 0,
    "animationSpeed": 1,
    "loop": true
  },
  "at": { "seconds": 2 }
}
```

Include the selected `sessionId` on every call. Omit `at` to import into Media only. Wait for a returned job with `cutline_jobs`; do not start the same render twice.

Use `action: "read"` with the current project guard and `assetId` to inspect settings and animation names. Use `action: "update"` with that asset ID, `expectedSourceHash` from the read, and only the settings you want to change. `animationIndex: -1` disables embedded animation; 0 selects the first animation when present. An update retains the asset ID and existing timeline clips. Shortening a scene below the footage already used by a clip is refused.

Read `cutline_editing_schema` section `model3d` for every setting's bounds and default.

For custom choreography, **Edit source** opens the generated HyperFrames HTML. Rendering replacement HTML detaches the structured 3D controls, so a later settings edit cannot overwrite custom code. The model and textures remain in the scene folder. Advanced scenes can use the supplied local GLTFLoader and Three.js modules; animation must be a deterministic function of scene time.

## Supported files and limits

- GLB and glTF **2.0**, including standard materials, textures and embedded animation. FBX, OBJ, USDZ and Blender project files need conversion to GLB or glTF first.
- Resources must be embedded or local to the model's folder. Remote URLs, paths outside that folder and symbolic links are refused. Only referenced resources are copied.
- A model and its dependencies must fit within 128 MB and 256 files. Textures are limited to 8192 pixels per side and 32 million decoded pixels in total.
- Draco or Meshopt compressed geometry and KTX2/Basis compressed textures need an uncompressed export for this version. Cutline reports unsupported compression before starting a render.
- Models are source-editable scenes, not native mesh-editing layers. Cutline supplies camera and animation controls; it is not a modeling or rigging application.
- Rendering runs locally. The timeline and export use the same rendered video, so scrubbing does not keep a 3D browser running. Transparent scenes retain alpha; ordinary reverse is unavailable for them.
- A `.cutline` project file alone does not package external scene folders. Keep the managed sources on this Mac, or bring the original model and its dependencies and import them again on another Mac.

The loader uses [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html). Embedded animation is sought by absolute scene time with [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html), rather than a wall-clock loop.
