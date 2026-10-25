/** Small, offline starters. Every animation is a function of scene time. */
export const sceneStarters = [
  {
    id: "title",
    name: "Title reveal",
    description: "Typography with a staggered entrance",
  },
  {
    id: "chart",
    name: "Animated chart",
    description: "Three values growing into view",
  },
  {
    id: "three",
    name: "3D scene",
    description: "A lit object with a moving camera",
  },
] as const;
export type SceneStarter = (typeof sceneStarters)[number]["id"];

export function hyperframesStarter(
  kind: SceneStarter,
  { width, height, fps }: { width: number; height: number; fps: number },
) {
  const size = Math.round(Math.min(width, height) * 0.075);
  const root = `id="scene" data-composition-id="scene" data-start="0" data-duration="6" data-width="${width}" data-height="${height}" data-fps="${fps}"`;
  const head = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
* { box-sizing: border-box }
html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #15131c }
body { font-family: Arial, sans-serif; color: #f6f5f9 }
#scene { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #15131c }
.content { position: absolute; inset: 12%; display: flex; flex-direction: column; justify-content: center; gap: ${Math.round(size * 0.4)}px }
h1, p { margin: 0 }
h1 { font-size: ${size}px; line-height: 1.05; letter-spacing: -0.045em }
p { font-size: ${Math.round(size * 0.38)}px; color: #c3bdcf; line-height: 1.4 }
</style></head><body>`;
  if (kind === "three")
    return `${head}
<div ${root} data-no-timeline>
  <div id="object" style="position:absolute;inset:0"></div>
  <div class="content" style="justify-content:flex-end;pointer-events:none">
    <h1>A new perspective</h1><p>Real depth and light</p>
  </div>
</div>
<script type="module">
import * as THREE from './cutline-runtime/three.module.min.js';
const host = document.getElementById('object');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(${width}, ${height});
renderer.setPixelRatio(1);
host.appendChild(renderer.domElement);
const world = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, ${width / height}, 0.1, 100);
const geometry = new THREE.BoxGeometry(1.7, 1.7, 1.7);
const material = new THREE.MeshStandardMaterial({ color: 0xb8a0ee, roughness: 0.28, metalness: 0.35 });
const object = new THREE.Mesh(geometry, material);
object.position.y = 0.5;
world.add(object, new THREE.HemisphereLight(0xffffff, 0x282038, 2));
const key = new THREE.DirectionalLight(0xffffff, 4);
key.position.set(3, 5, 4);
world.add(key);
window.__hyperframes.registerFrameSource({
  element: document.getElementById('scene'),
  render(time) {
    object.rotation.set(0.2 + time * 0.12, time * 0.55, 0.08);
    camera.position.set(Math.sin(time * 0.25) * 0.7, 1.2, ${width < height ? 9 : 7});
    camera.lookAt(0, 0.25, 0);
    renderer.render(world, camera);
  },
  dispose() { geometry.dispose(); material.dispose(); renderer.dispose(); }
});
</script></body></html>`;
  const content =
    kind === "chart"
      ? `<div class="content">
    <h1>Weekly progress</h1><p>Change the labels and values in the source</p>
    <div style="display:flex;align-items:flex-end;gap:${Math.round(size * 0.7)}px;height:${Math.round(height * 0.32)}px;margin-top:${size}px">
      ${[12, 24, 36]
        .map(
          (
            value,
            i,
          ) => `<div style="flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:16px">
      <div class="bar" style="height:${(value / 36) * 100}%;background:${["#84759f", "#a393c2", "#c6b1ef"][i]};transform-origin:bottom;border-radius:8px 8px 0 0"></div>
      <p style="color:#f6f5f9">${["Week 1", "Week 2", "Week 3"][i]} / ${value}</p></div>`,
        )
        .join("\n      ")}
    </div>
  </div>`
      : `<div class="content"><h1>Your next idea</h1><p>Make it move</p></div>`;
  return `${head}
<div ${root}>${content}</div>
<script src="./cutline-runtime/gsap.min.js"></script>
<script>
const timeline = gsap.timeline({ paused: true });
timeline.fromTo('h1', { y: 48, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, ease: 'power3.out' }, 0.2);
timeline.fromTo('.content > p', { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: 'power2.out' }, 0.5);
${kind === "chart" ? "timeline.fromTo('.bar', { scaleY: 0 }, { scaleY: 1, duration: 1.2, stagger: 0.22, ease: 'power3.out' }, 1);" : "timeline.to('h1', { x: 12, duration: 3, ease: 'none' }, 1.2);"}
window.__timelines = { scene: timeline };
</script></body></html>`;
}
