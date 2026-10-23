import { build } from "esbuild";
import path from "node:path";
import { build as viteBuild } from "vite";
import { bundle } from "@remotion/bundler";
import { mainEntryPoints, prepareMediaBinaries } from "./setup-support.mjs";
await prepareMediaBinaries();
await build({
  entryPoints: mainEntryPoints,
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist/main",
  outExtension: { ".js": ".cjs" },
  packages: "external",
  sourcemap: true,
});
await viteBuild();
await bundle({
  entryPoint: "src/composition/index.tsx",
  outDir: path.resolve("dist/composition"),
  onProgress: (p) => {
    if (p === 100) console.log("Composition bundled");
  },
});
