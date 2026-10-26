import { z } from "zod";

const finite = z.number().finite();
export const Model3DSettingsSchema = z
  .object({
    durationSeconds: finite.min(0.1).max(120).default(6),
    motion: z.enum(["turntable", "orbit", "static"]).default("turntable"),
    rotationDegrees: finite.min(-1440).max(1440).default(90),
    cameraAzimuth: finite.min(-360).max(360).default(25),
    cameraElevation: finite.min(-85).max(85).default(15),
    cameraDistance: finite.min(0.25).max(5).default(1),
    animationIndex: finite.int().min(-1).max(127).default(0),
    animationSpeed: finite.min(0.1).max(4).default(1),
    loop: z.boolean().default(true),
    exposure: finite.min(0.1).max(4).default(1),
    background: z
      .string()
      .regex(/^#[a-f\d]{6}$/iu)
      .default("#15131c"),
  })
  .strict();
export type Model3DSettings = z.infer<typeof Model3DSettingsSchema>;
export const Model3DMetadataSchema = z
  .object({
    file: z
      .string()
      .min(1)
      .max(8192)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !value
            .split("/")
            .some((part) => !part || part === "." || part === "..") &&
          !/[\x00-\x1f:?#]/u.test(value),
        "The model file must be a local relative asset path.",
      ),
    format: z.enum(["glb", "gltf"]),
    settings: Model3DSettingsSchema,
    animations: z.array(z.string().max(200)).max(128),
  })
  .strict();
export type Model3DMetadata = z.infer<typeof Model3DMetadataSchema>;

/** This wrapper owns no clock: every pose is derived from the requested frame time. */
export function model3DSource(
  model: Model3DMetadata,
  canvas: { width: number; height: number; fps: number },
  transparent: boolean,
): string {
  const { width, height, fps } = canvas;
  const config = JSON.stringify(model.settings).replace(/</gu, "\\u003c");
  const url = JSON.stringify(
    "./" + model.file.split("/").map(encodeURIComponent).join("/"),
  );
  const background = transparent ? "transparent" : model.settings.background;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${background}}
#scene{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${background}}
canvas{display:block;width:100%;height:100%}
</style><script type="importmap">{"imports":{"three":"./cutline-runtime/three.module.min.js"}}</script></head><body>
<div id="scene" data-composition-id="scene" data-no-timeline data-start="0" data-duration="${model.settings.durationSeconds}" data-width="${width}" data-height="${height}" data-fps="${fps}"></div>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from './cutline-runtime/addons/loaders/GLTFLoader.js';
const settings = ${config};
const host = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({antialias:true,alpha:true});
renderer.setPixelRatio(1);
renderer.setSize(${width},${height});
renderer.setClearColor(settings.background,${transparent ? 0 : 1});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = settings.exposure;
host.appendChild(renderer.domElement);
const world = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38,${width / height},0.01,100);
const pivot = new THREE.Group();
const normalized = new THREE.Group();
pivot.add(normalized);
world.add(pivot);
world.add(new THREE.HemisphereLight(0xffffff,0x333340,2.5));
const key = new THREE.DirectionalLight(0xffffff,4.5); key.position.set(3,5,4); world.add(key);
const fill = new THREE.DirectionalLight(0xe5edff,2); fill.position.set(-4,1,2); world.add(fill);
const rim = new THREE.DirectionalLight(0xffffff,3); rim.position.set(1,3,-4); world.add(rim);
let model, mixer, action, clip, distance;
function pose(seconds, forBounds=false) {
  if (!action) return;
  action.reset();
  const loop = settings.loop && !forBounds;
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce,loop ? Infinity : 1);
  action.clampWhenFinished = true;
  action.play();
  const time = Math.max(0,seconds)*settings.animationSpeed;
  mixer.setTime(loop && clip.duration > 0 ? time % clip.duration : Math.min(time,clip.duration));
  model.updateMatrixWorld(true);
}
const ready = new GLTFLoader().loadAsync(${url}).then((loaded) => {
  model = loaded.scene;
  if (!model) throw new Error('This model does not contain a scene');
  normalized.add(model);
  if (settings.animationIndex >= loaded.animations.length && loaded.animations.length > 0)
    throw new Error('The selected animation is missing; choose an available animation');
  clip = settings.animationIndex >= 0 ? loaded.animations[settings.animationIndex] : undefined;
  if (clip) { mixer = new THREE.AnimationMixer(model); action = mixer.clipAction(clip); }
  const bounds = new THREE.Box3();
  // Include sampled animation poses in the framing, then return to the first pose.
  const samples = clip ? 16 : 0;
  for (let i=0;i<=samples;i++) {
    pose(samples ? clip.duration*i/samples/settings.animationSpeed : 0,true);
    model.updateMatrixWorld(true);
    bounds.union(new THREE.Box3().setFromObject(model,true));
  }
  pose(0);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = size.length()/2;
  if (bounds.isEmpty() || ![...size.toArray(),...center.toArray(),radius].every(Number.isFinite) || radius<=0)
    throw new Error('This model has no visible finite geometry');
  normalized.scale.setScalar(1/radius);
  normalized.position.copy(center).multiplyScalar(-1/radius);
  const vertical = THREE.MathUtils.degToRad(camera.fov)/2;
  const horizontal = Math.atan(Math.tan(vertical)*camera.aspect);
  distance = 1.18/Math.sin(Math.min(vertical,horizontal))*settings.cameraDistance;
});
window.__hyperframes.registerFrameSource({
  element:host,
  ready,
  render(time) {
    pose(time);
    const travel = THREE.MathUtils.degToRad(settings.rotationDegrees)*(time/settings.durationSeconds);
    pivot.rotation.y = settings.motion === 'turntable' ? travel : 0;
    const azimuth = THREE.MathUtils.degToRad(settings.cameraAzimuth)+(settings.motion === 'orbit' ? travel : 0);
    const elevation = THREE.MathUtils.degToRad(settings.cameraElevation);
    camera.position.set(Math.sin(azimuth)*Math.cos(elevation)*distance,Math.sin(elevation)*distance,Math.cos(azimuth)*Math.cos(elevation)*distance);
    camera.lookAt(0,0,0);
    renderer.render(world,camera);
  },
  dispose() {
    mixer?.stopAllAction();
    if (model) mixer?.uncacheRoot(model);
    const textures = new Set(), materials = new Set(), geometries = new Set();
    world.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of (Array.isArray(object.material) ? object.material : object.material ? [object.material] : [])) materials.add(material);
    });
    for (const material of materials) {
      for (const value of Object.values(material)) if(value?.isTexture) textures.add(value);
      material.dispose();
    }
    for (const texture of textures) { texture.source?.data?.close?.(); texture.dispose(); }
    for (const geometry of geometries) geometry.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
});
</script></body></html>`;
}
