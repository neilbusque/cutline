import {
  browserDirectory,
  browserExecutable,
  browserOptions,
} from "./browser-config.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  readFileSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  symlink,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const mainEntryPoints = [
  "src/main/main.ts",
  "src/main/preload.ts",
  "src/main/render-worker.ts",
  "src/main/still-worker.ts",
  "src/main/tts-worker.ts",
  "src/main/tts-inference.ts",
  "src/main/mcp.ts",
];

export const whisperSource = {
  revision: "d1be6fde11ac6e0407606b4e42fe72d34add8037",
  url: "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/d1be6fde11ac6e0407606b4e42fe72d34add8037",
  sha: "645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4",
  size: 9631456,
};
export const whisperModel = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",
  sha: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  size: 147951465,
};
export const speechNotices = [
  {
    name: "LICENSE",
    url: "https://www.apache.org/licenses/LICENSE-2.0.txt",
    size: 11358,
    sha: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  },
  {
    name: "MODEL_CARD.md",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/README.md",
    size: 10627,
    sha: "b8fd888b4782f4d4ae85e2f1587cafd727037f4f138f72429ef1bd5908c0e9d8",
  },
];

export function assertSupportedPlatform(
  platform = process.platform,
  arch = process.arch,
) {
  if (platform !== "darwin" || arch !== "arm64")
    throw Error(
      "Cutline currently supports Apple Silicon macOS (darwin arm64). Linux, Windows and Intel Mac packages are not implemented.",
    );
}

/** npm can skip package install hooks; these two pinned tools still need executable bits. */
export async function prepareMediaBinaries(root = process.cwd()) {
  const binaries = [
    "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
    "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
  ];
  const repaired = [];
  for (const relative of binaries) {
    const file = path.resolve(root, relative);
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw Error(`Missing ${relative}. Run npm ci before preparing Cutline.`);
    }
    if (!info.isFile())
      throw Error(
        `Expected a file at ${relative}. Run npm ci to restore dependency files.`,
      );
    const mode = info.mode & 0o777;
    if ((mode & 0o111) !== 0o111) {
      await chmod(file, mode | 0o111);
      repaired.push(relative);
    }
  }
  return repaired;
}

/** Validate a complete replacement before moving the previous directory. */
export async function replaceVerifiedDirectory(
  source,
  destination,
  validate,
  copy = cp,
) {
  const staged = `${destination}.partial-${randomUUID()}`;
  const backup = `${destination}.previous-${randomUUID()}`;
  let oldMoved = false;
  try {
    await copy(source, staged, { recursive: true, verbatimSymlinks: true });
    await validate(staged);
    try {
      await rename(destination, backup);
      oldMoved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(staged, destination);
    } catch (error) {
      if (oldMoved) await rename(backup, destination);
      throw error;
    }
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  if (oldMoved) await rm(backup, { recursive: true, force: true });
}

// Generated from the trusted, version-pinned upstream archive, never from an
// installed cache. Keep the complete browser and its third-party notices.
export const chromeDistribution = JSON.parse(
  readFileSync(new URL("./chrome-manifest.json", import.meta.url), "utf8"),
);

export function assertChromeManifestVersion(remotionVersion) {
  if (
    remotionVersion !== chromeDistribution.remotionVersion ||
    chromeDistribution.directory !== browserDirectory ||
    chromeDistribution.executable !== browserExecutable ||
    chromeDistribution.chromeMode !== browserOptions.chromeMode
  )
    throw Error(
      "Remotion and the reviewed Chrome manifest differ. Update the browser manifest from the pinned upstream archive before setup or packaging.",
    );
}

export function chromeFileNames(manifest = chromeDistribution) {
  const names = manifest.files.map((file) => file.name);
  if (
    new Set(names).size !== names.length ||
    manifest.files.some(
      (file) =>
        typeof file.name !== "string" ||
        !file.name ||
        path.posix.isAbsolute(file.name) ||
        file.name.includes("\\") ||
        file.name
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        (file.symlink !== undefined
          ? typeof file.symlink !== "string" ||
            !file.symlink ||
            path.posix.isAbsolute(file.symlink) ||
            file.symlink.includes("\\") ||
            file.symlink
              .split("/")
              .some((part) => !part || part === "." || part === "..")
          : !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            !/^[a-f0-9]{64}$/u.test(file.sha)),
    )
  )
    throw Error("Invalid reviewed Chrome file manifest.");
  return names;
}

export const chromeResourceFiles = chromeFileNames();

export async function validateChromeResources(
  root,
  manifest = chromeDistribution,
) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error(
      "Unexpected Chrome resource directory: symlinks are not allowed.",
    );
  const required = new Set(chromeFileNames(manifest));
  const entries = new Map(manifest.files.map((file) => [file.name, file]));
  const boundary = await realpath(root);
  const directories = new Set();
  for (const file of required) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const found = new Set();
  const inspect = async (relative = "") => {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.has(file)) await inspect(file);
      else if (
        entry.isFile() &&
        required.has(file) &&
        !entries.get(file).symlink
      )
        found.add(file);
      else if (entry.isSymbolicLink() && entries.get(file)?.symlink) {
        const source = path.join(root, file);
        const target = await readlink(source);
        if (target !== entries.get(file).symlink)
          throw Error(`Unexpected Chrome symlink target: ${file}.`);
        const resolved = path.relative(boundary, await realpath(source));
        if (
          !resolved ||
          resolved === ".." ||
          resolved.startsWith(`..${path.sep}`) ||
          path.isAbsolute(resolved)
        )
          throw Error(`Chrome symlink escapes the browser: ${file}.`);
        found.add(file);
      } else
        throw Error(
          `Unexpected Chrome resource: ${file}. Restore the pinned browser; unreviewed links and extra files are not allowed.`,
        );
    }
  };
  await inspect();
  for (const file of manifest.files) {
    if (
      !found.has(file.name) ||
      (!file.symlink && !(await verifiedFile(path.join(root, file.name), file)))
    )
      throw Error(
        `Missing or damaged Chrome resource: ${file.name}. Restore the pinned browser.`,
      );
  }
}

export function vendorResourceFiles(speechFiles, chrome = chromeDistribution) {
  return [
    "whisper-cli",
    "ggml-base.bin",
    "whisper-LICENSE",
    "whisper-NOTICE",
    "whisper-source-revision.txt",
    ...[...speechFiles, ...speechNotices, { name: "NOTICE" }].map(
      (file) => `kokoro/${file.name}`,
    ),
    ...chromeFileNames(chrome).map((file) => `${browserDirectory}/${file}`),
  ];
}

/** extraResource bypasses the app ignore filter: reject unrelated vendor files explicitly. */
export async function validateVendorResources(
  root,
  speechFiles,
  chrome = chromeDistribution,
) {
  const required = new Set(vendorResourceFiles(speechFiles, chrome));
  const allowed = new Set([...required, "whisper-cli.json"]);
  const directories = new Set();
  for (const file of allowed) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const files = [];
  const inspect = async (relative = "") => {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.has(file)) await inspect(file);
      else if (entry.isFile() && allowed.has(file)) files.push(file);
      else if (
        entry.isSymbolicLink() &&
        file.startsWith(`${browserDirectory}/`) &&
        allowed.has(file)
      )
        files.push(file);
      else
        throw Error(
          `Unexpected vendor resource: ${file}. Remove or relocate it before packaging; symlinks and setup leftovers are not allowed.`,
        );
    }
  };
  await inspect();
  const missing = [...required].filter((file) => !files.includes(file));
  if (missing.length)
    throw Error(
      `Missing vendor resources: ${missing.join(", ")}. Run vendor and speech setup before packaging.`,
    );
  await validateChromeResources(path.join(root, browserDirectory), chrome);
  return files.sort();
}

export async function stageVendorResources(
  root,
  destination,
  speechFiles,
  chrome = chromeDistribution,
) {
  const files = await validateVendorResources(root, speechFiles, chrome);
  for (const file of files) {
    const output = path.join(destination, file);
    await mkdir(path.dirname(output), { recursive: true });
    const source = path.join(root, file);
    if ((await lstat(source)).isSymbolicLink())
      await symlink(await readlink(source), output);
    else await copyFile(source, output, constants.COPYFILE_FICLONE);
  }
  // Recheck the copy too: a changed cache cannot race validation into the app.
  await validateChromeResources(
    path.join(destination, browserDirectory),
    chrome,
  );
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function verifiedFile(file, expected) {
  try {
    const info = await stat(file);
    return (
      info.isFile() &&
      (expected.size === undefined || info.size === expected.size) &&
      (await sha256File(file)) === expected.sha
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Validate before replacing a file; interrupted downloads leave the old copy intact. */
export async function downloadVerified(destination, expected, fetcher = fetch) {
  if (await verifiedFile(destination, expected)) return false;
  if (!/^https:\/\//u.test(expected.url))
    throw Error("Setup downloads require HTTPS.");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    const response = await fetcher(expected.url, {
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!response.ok || !response.body)
      throw Error(
        `Cannot download ${path.basename(destination)}: HTTP ${response.status}`,
      );
    const hash = createHash("sha256");
    let size = 0;
    const checked = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > expected.size)
          return callback(
            Error(`Download is too large: ${path.basename(destination)}`),
          );
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      checked,
      createWriteStream(temporary, { flags: "wx", mode: 0o644 }),
    );
    if (size !== expected.size || hash.digest("hex") !== expected.sha)
      throw Error(
        `Checksum or size mismatch for ${path.basename(destination)}. The previous file was kept.`,
      );
    await rename(temporary, destination);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadSpeechManifest() {
  const { build } = await import("esbuild");
  const compiled = await build({
    stdin: {
      contents:
        'export * from "./src/shared/tts-model.ts"; export { speechVoices } from "./src/shared/tts.ts";',
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
  );
}

export function developmentEnvironment(env, url) {
  const clean = { ...env, CUTLINE_DEV_URL: url };
  delete clean.ELECTRON_RUN_AS_NODE;
  return clean;
}

/** Package only runtime files. Developer secrets, fixtures and exports stay local. */
export function packageIgnore(file) {
  const relative = file.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!relative) return false;
  if (relative.split("/").some((segment) => segment.startsWith(".")))
    return true;
  const top = relative.split("/")[0];
  if (
    ![
      "dist",
      "node_modules",
      "assets",
      "docs",
      "licenses",
      "package.json",
      "package-lock.json",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "THIRD_PARTY_NOTICES.md",
    ].includes(top)
  )
    return true;
  // Published help is Markdown only; local media or exports cannot hitch a ride.
  if (top === "docs" && relative !== "docs" && !relative.endsWith(".md"))
    return true;
  return /^(?:node_modules\/(?:\.remotion|electron)(?:\/|$)|node_modules\/onnxruntime-node\/bin\/napi-v3\/(?:linux|win32|darwin\/x64)(?:\/|$))/u.test(
    relative,
  );
}

export function assertRedistributableFfmpeg(version, allowLocal = false) {
  if (!version.includes("--enable-nonfree")) return;
  if (!allowLocal)
    throw Error(
      "The installed FFmpeg was built with --enable-nonfree and cannot be redistributed. Replace it before a public app release. For a private local build only, set CUTLINE_ALLOW_NONFREE_LOCAL_BUILD=1. Do not upload or share that app.",
    );
  return "PRIVATE LOCAL BUILD ONLY: FFmpeg contains --enable-nonfree. Do not upload, publish or share this app.";
}

export async function assertWhisperRevision() {
  const recorded = (
    await readFile("licenses/whisper-source-revision.txt", "utf8")
  ).trim();
  if (recorded !== whisperSource.revision)
    throw Error(
      "Whisper source pin and license revision differ. Update and verify both before setup.",
    );
}

export function assertPortableWhisper(architecture, linkedLibraries) {
  if (!architecture.trim().split(/\s+/u).includes("arm64"))
    throw Error("whisper-cli must contain an Apple Silicon arm64 executable.");
  const external = linkedLibraries
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (", 1)[0])
    .filter(Boolean)
    .filter(
      (file) =>
        !file.startsWith("/usr/lib/") && !file.startsWith("/System/Library/"),
    );
  if (external.length)
    throw Error(
      `whisper-cli depends on external libraries (${external.join(", ")}). Build it with BUILD_SHARED_LIBS=OFF and GGML_METAL_EMBED_LIBRARY=ON before packaging.`,
    );
}
