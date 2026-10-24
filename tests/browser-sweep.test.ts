import { afterEach, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  orphanedBrowsers,
  sweepOrphanedBrowsers,
} from "../src/main/browser-sweep";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
const chrome = (folder: string) =>
  `${folder}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless=new --no-sandbox`;

it("finds only Chrome from Cutline's own browser folder that launchd adopted", () => {
  const folder =
    "/Applications/Cutline.app/Contents/Resources/vendor/chrome-mac-arm64";
  const listing = [
    // Left behind by a worker that died.
    `  101     1 ${chrome(folder)}`,
    `  102   101 ${folder}/Google Chrome for Testing.app/Contents/Frameworks/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer) --type=renderer`,
    `  103     1 ${folder}/Google Chrome for Testing.app/Contents/Frameworks/Helpers/Google Chrome for Testing Helper (GPU).app/Contents/MacOS/Google Chrome for Testing Helper (GPU) --type=gpu-process`,
    // A preview or export that is still working.
    `  104   555 ${chrome(folder)}`,
    // The person's own Chrome, and another app's folder with a similar name.
    `  105     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    `  106     1 ${chrome(folder + "-copy")}`,
    "",
  ].join("\n");
  expect(orphanedBrowsers(listing, [folder])).toEqual([101, 103]);
});

it("matches the browser folder through a linked vendor folder and leaves everything alone when ps fails", async () => {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cutline-sweep-")),
  );
  folders.push(root);
  const real = path.join(root, "release", "vendor", "chrome-mac-arm64");
  mkdirSync(real, { recursive: true });
  symlinkSync(path.join(root, "release", "vendor"), path.join(root, "vendor"));
  const linked = path.join(root, "vendor", "chrome-mac-arm64");
  const killed: number[] = [];
  const listing = `  7 1 ${chrome(real)}\n  8 1 ${chrome(linked)}\n  9 40 ${chrome(real)}\n`;
  expect(
    await sweepOrphanedBrowsers(
      linked,
      (callback) => callback(null, listing),
      (pid) => killed.push(pid),
    ),
  ).toEqual([7, 8]);
  expect(killed).toEqual([7, 8]);
  expect(
    await sweepOrphanedBrowsers(
      linked,
      (callback) => callback(Error("ps failed"), ""),
      (pid) => killed.push(pid),
    ),
  ).toEqual([]);
  // No browser installed: nothing to look for.
  expect(
    await sweepOrphanedBrowsers(path.join(root, "missing"), () => {
      throw Error("not called");
    }),
  ).toEqual([]);
  expect(killed).toEqual([7, 8]);
});
