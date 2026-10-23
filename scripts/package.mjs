import { browserRelativePath } from "./browser-config.mjs";
import {
  assertSelfContainedDirectory,
  packageWithVendorResources,
} from "./package-vendor.mjs";
import { packager } from "@electron/packager";
import { VERSION as remotionVersion } from "remotion/version";
import path from "node:path";
import {
  assertPortableWhisper,
  assertChromeManifestVersion,
  assertSupportedPlatform,
  assertRedistributableFfmpeg,
  loadSpeechManifest,
  packageIgnore,
  prepareMediaBinaries,
  speechNotices,
  verifiedFile,
  whisperModel,
} from "./setup-support.mjs";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
} from "node:fs";
assertSupportedPlatform();
assertChromeManifestVersion(remotionVersion);
await prepareMediaBinaries();
const ffmpeg = path.resolve(
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const notice = assertRedistributableFfmpeg(
  execFileSync(ffmpeg, ["-version"], { encoding: "utf8" }),
  process.env.CUTLINE_ALLOW_NONFREE_LOCAL_BUILD === "1",
);
if (notice) console.warn(notice);
assertPortableWhisper(
  execFileSync("lipo", ["-archs", "vendor/whisper-cli"], { encoding: "utf8" }),
  execFileSync("otool", ["-L", "vendor/whisper-cli"], { encoding: "utf8" }),
);
const { speechModelFiles, speechVoices } = await loadSpeechManifest();
for (const voice of speechVoices) {
  const file = path.resolve("node_modules/kokoro-js/voices", `${voice.id}.bin`);
  if (
    !existsSync(file) ||
    !statSync(file).isFile() ||
    statSync(file).size !== 510 * 256 * 4
  )
    throw Error(
      `Missing or damaged bundled voice ${voice.id}. Run npm ci to restore dependency files.`,
    );
}
for (const file of [...speechModelFiles, ...speechNotices]) {
  if (!(await verifiedFile(path.resolve("vendor/kokoro", file.name), file)))
    throw Error(
      `Missing or damaged voice dependency ${file.name}. Run npm run setup:speech.`,
    );
}
if (!(await verifiedFile(path.resolve("vendor/ggml-base.bin"), whisperModel)))
  throw Error("Missing or damaged Whisper model. Run npm run setup:vendor.");
for (const file of [
  "vendor/whisper-cli",
  "vendor/ggml-base.bin",
  `vendor/${browserRelativePath}`,
  "dist/main/main.cjs",
  "dist/main/tts-worker.cjs",
  "dist/main/tts-inference.cjs",
  "vendor/kokoro/NOTICE",
  "dist/main/preload.cjs",
  "dist/main/render-worker.cjs",
  "dist/main/still-worker.cjs",
  "dist/main/mcp.cjs",
  "dist/ui/index.html",
  "dist/composition/index.html",
])
  if (!existsSync(file))
    throw Error(`Missing ${file}. Run vendor setup and npm run build.`);
const out = await packageWithVendorResources({
  vendorRoot: path.resolve("vendor"),
  speechFiles: speechModelFiles,
  createPackages: () =>
    packager({
      dir: process.cwd(),
      out: path.resolve("release"),
      name: "Cutline",
      icon: path.resolve("assets/Cutline.icns"),
      platform: "darwin",
      arch: "arm64",
      overwrite: true,
      asar: false,
      prune: true,
      appBundleId: "local.cutline.editor",
      appCategoryType: "public.app-category.video",
      appVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
      executableName: "Cutline",
      ignore: packageIgnore,
      extendInfo: {
        NSHighResolutionCapable: true,
        CFBundleDocumentTypes: [
          {
            CFBundleTypeName: "Cutline Project",
            CFBundleTypeRole: "Editor",
            LSHandlerRank: "Owner",
            LSItemContentTypes: ["local.cutline.project"],
          },
        ],
        UTExportedTypeDeclarations: [
          {
            UTTypeIdentifier: "local.cutline.project",
            UTTypeDescription: "Cutline Project",
            UTTypeConformsTo: ["public.json"],
            UTTypeTagSpecification: {
              "public.filename-extension": ["cutline"],
            },
          },
        ],
        NSHumanReadableCopyright:
          "Third-party licenses and source notices are included in app resources",
      },
    }),
});
// Keep the staged copy out of Spotlight and Finder's Open With, so searching
// "Cutline" finds only /Applications/Cutline.app. QA and install scripts keep
// using release/Cutline-darwin-arm64, which now links to the hidden folder.
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
for (const dir of out) {
  const hidden = `${dir}.noindex`;
  try {
    execFileSync(lsregister, ["-u", path.join(dir, "Cutline.app")], {
      stdio: "ignore",
    });
  } catch {
    /* Not registered yet. */
  }
  rmSync(hidden, { recursive: true, force: true });
  renameSync(dir, hidden);
  symlinkSync(path.basename(hidden), dir);
  await assertSelfContainedDirectory(path.join(hidden, "Cutline.app"));
}
console.log(out.join("\n"));
