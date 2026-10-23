import path from "node:path";
import os from "node:os";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import {
  chromeDistribution,
  stageVendorResources,
  validateVendorResources,
} from "./setup-support.mjs";

export async function assertSelfContainedDirectory(root) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error(`Expected a real package directory: ${root}`);
  const boundary = await realpath(root);
  const inspect = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await realpath(file);
        } catch (cause) {
          throw Error(`Packaged symlink is dangling: ${file}`, { cause });
        }
        const relative = path.relative(boundary, target);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          throw Error(`Packaged symlink escapes the app: ${file}`);
      } else if (entry.isDirectory()) await inspect(file);
    }
  };
  await inspect(root);
}

/** Packager's extraResource copy rewrites relative symlinks to staging paths. */
export async function packageWithVendorResources({
  vendorRoot,
  speechFiles,
  createPackages,
  chrome = chromeDistribution,
  temporaryRoot = os.tmpdir(),
}) {
  const staging = await mkdtemp(path.join(temporaryRoot, "cutline-package-"));
  let outputs;
  try {
    const stagedVendor = path.join(staging, "vendor");
    await stageVendorResources(vendorRoot, stagedVendor, speechFiles, chrome);
    outputs = await createPackages();
    for (const output of outputs) {
      const vendor = path.join(output, "Cutline.app/Contents/Resources/vendor");
      // The app allowlist excludes vendor. Copy only reviewed files directly
      // into the completed bundle, preserving exact relative framework links.
      try {
        await lstat(vendor);
        throw Error(`Unexpected vendor directory in packaged app: ${vendor}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await stageVendorResources(stagedVendor, vendor, speechFiles, chrome);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  // Check after deleting staging: no link may rely on an existing temp cache.
  for (const output of outputs) {
    const app = path.join(output, "Cutline.app");
    await assertSelfContainedDirectory(app);
    await validateVendorResources(
      path.join(app, "Contents/Resources/vendor"),
      speechFiles,
      chrome,
    );
  }
  return outputs;
}
