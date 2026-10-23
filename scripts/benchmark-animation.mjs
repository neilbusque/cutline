import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
const bundle = await build({
  entryPoints: ["src/shared/animation.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { evaluatedClip, eased, animatedProperties } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const c = { animationOffset: 0, keyframes: [] };
for (let frame = 0; frame < 200; frame++)
  for (const property of animatedProperties)
    c.keyframes.push({
      frame: frame * 10,
      property,
      value: Math.sin(frame) * 0.3 + 0.6,
      easing: "ease-in-out",
    });
function old(c, f) {
  const result = { ...c };
  for (const property of animatedProperties) {
    const keys = c.keyframes.filter((k) => k.property === property);
    let value = keys.at(-1).value;
    if (f <= keys[0].frame) value = keys[0].value;
    else
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1],
          b = keys[i];
        if (f < b.frame) {
          value =
            a.value +
            (b.value - a.value) *
              eased((f - a.frame) / (b.frame - a.frame), a.easing);
          break;
        }
      }
    result[property] = value;
  }
  return result;
}
const run = (fn) => {
  let sum = 0;
  const started = performance.now();
  for (let i = 0; i < 12000; i++) sum += fn(c, i % 2000).x;
  return { ms: performance.now() - started, checksum: sum };
};
run(evaluatedClip);
const baseline = run(old),
  optimized = run(evaluatedClip);
if (Math.abs(baseline.checksum - optimized.checksum) > 1e-8)
  throw Error("Output changed");
const result = {
  evaluations: 12000,
  keysPerClip: 2000,
  baseline,
  optimized,
  speedup: baseline.ms / optimized.ms,
};
console.log(JSON.stringify(result));
await writeFile(
  "qa-animation-performance.json",
  JSON.stringify(result, null, 2),
);
