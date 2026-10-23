import { randomUUID } from "node:crypto";
import { browserDirectory, browserExecutable } from "./browser-config.mjs";
import { VERSION as remotionVersion } from "remotion/version";
import {
  mkdir,
  mkdtemp,
  cp,
  writeFile,
  readFile,
  access,
  chmod,
  rename,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assertPortableWhisper,
  chromeDistribution,
  assertChromeManifestVersion,
  assertSupportedPlatform,
  assertWhisperRevision,
  downloadVerified,
  prepareMediaBinaries,
  replaceVerifiedDirectory,
  sha256File,
  verifiedFile,
  validateChromeResources,
  whisperModel,
  whisperSource,
} from "./setup-support.mjs";

assertSupportedPlatform();
assertChromeManifestVersion(remotionVersion);
await prepareMediaBinaries();
await assertWhisperRevision();
const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit" });
const validateCli = (file) =>
  assertPortableWhisper(
    execFileSync("lipo", ["-archs", file], { encoding: "utf8" }),
    execFileSync("otool", ["-L", file], { encoding: "utf8" }),
  );
const installCli = async (source) => {
  const staged = `${cli}.partial`;
  try {
    await cp(source, staged);
    await chmod(staged, 0o755);
    validateCli(staged);
    run(staged, ["--help"]);
    await rename(staged, cli);
  } finally {
    await rm(staged, { force: true });
  }
};
await mkdir("vendor", { recursive: true });
await mkdir(".cache", { recursive: true });
const cli = path.resolve("vendor/whisper-cli");
const stampFile = `${cli}.json`;
let ready = false;
try {
  const stamp = JSON.parse(await readFile(stampFile, "utf8"));
  ready =
    stamp.revision === whisperSource.revision &&
    (await verifiedFile(cli, stamp));
} catch (error) {
  if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
}
if (process.env.WHISPER_CLI_PATH) {
  await installCli(path.resolve(process.env.WHISPER_CLI_PATH));
  // User-supplied binaries are not represented as our pinned source build.
  await rm(stampFile, { force: true });
} else if (!ready) {
  try {
    execFileSync("xcrun", ["--find", "clang"], { stdio: "ignore" });
    execFileSync("cmake", ["--version"], { stdio: "ignore" });
  } catch {
    throw Error(
      "Whisper setup needs Xcode Command Line Tools and CMake. Run xcode-select --install, install CMake (for example brew install cmake), then run npm run setup:vendor again. An existing static whisper-cli can instead be supplied with WHISPER_CLI_PATH=/absolute/path/to/whisper-cli.",
    );
  }
  const archive = path.resolve(".cache/whisper-source.tar.gz");
  await downloadVerified(archive, whisperSource);
  const source = path.resolve(`.cache/whisper-${whisperSource.revision}`);
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
  const build = path.join(source, "build");
  run("cmake", [
    "-S",
    source,
    "-B",
    build,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_SERVER=OFF",
    "-DGGML_METAL=ON",
    "-DGGML_METAL_EMBED_LIBRARY=ON",
  ]);
  const jobs = Number(process.env.CUTLINE_BUILD_JOBS ?? 2);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8)
    throw Error("CUTLINE_BUILD_JOBS must be an integer between 1 and 8.");
  run("cmake", [
    "--build",
    build,
    "--config",
    "Release",
    "--target",
    "whisper-cli",
    "--parallel",
    String(jobs),
  ]);
  await installCli(path.join(build, "bin/whisper-cli"));
  await writeFile(
    stampFile,
    JSON.stringify(
      { revision: whisperSource.revision, sha: await sha256File(cli) },
      null,
      2,
    ),
  );
}
await access(cli, constants.X_OK);
validateCli(cli);
await downloadVerified(path.resolve("vendor/ggml-base.bin"), whisperModel);
await cp("licenses/whisper-LICENSE", "vendor/whisper-LICENSE");
await cp(
  "licenses/whisper-source-revision.txt",
  "vendor/whisper-source-revision.txt",
);
await writeFile(
  "vendor/whisper-NOTICE",
  `whisper.cpp: https://github.com/ggml-org/whisper.cpp/tree/${whisperSource.revision}\nModel: ${whisperModel.url}\nModel SHA-256: ${whisperModel.sha}\nWhisper is distributed under the MIT license; see whisper-LICENSE.\n`,
);
const target = path.resolve("vendor", browserDirectory);
const validateBrowser = async (directory) => {
  await access(path.join(directory, browserExecutable), constants.X_OK);
  await validateChromeResources(directory);
};
let browserReady = false;
try {
  await validateBrowser(target);
  browserReady = true;
} catch {
  /* Restore only from the pinned archive below. */
}
if (!browserReady) {
  const archive = path.resolve(
    `.cache/chrome-${chromeDistribution.version}-mac-arm64.zip`,
  );
  await downloadVerified(archive, chromeDistribution.archive);
  const extraction = await mkdtemp(path.resolve(".cache/chrome-extract-"));
  try {
    run("/usr/bin/unzip", ["-q", archive, "-d", extraction]);
    await replaceVerifiedDirectory(
      path.join(extraction, browserDirectory),
      target,
      validateBrowser,
    );
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}
// A developer upgrade may retain the earlier shell. Preserve it outside vendor
// after the replacement passes, so unrelated files cannot enter an app package.
try {
  await rename(
    path.resolve("vendor/chrome-headless-shell-mac-arm64"),
    path.resolve(`.cache/previous-headless-shell-${randomUUID()}`),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(
  "Local rendering and transcription are ready. Run npm run setup:speech to prepare local voiceovers.",
);
