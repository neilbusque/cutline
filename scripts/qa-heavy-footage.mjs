import { _electron as electron } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// Footage Chrome cannot decode (an MPEG-4 Part 2 AVI here) must import at
// once, show a quiet "Preparing preview" card instead of a playback error
// whenever the browser reports it cannot decode it, then play its smooth
// preview copy. Uses disposable app data and generated footage.
//
//   node scripts/qa-heavy-footage.mjs                      source Electron
//   CUTLINE_PACKAGED=1 node scripts/qa-heavy-footage.mjs   staged Mac app
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const appRoot =
  process.env.CUTLINE_APP ??
  path.join(root, "release/Cutline-darwin-arm64/Cutline.app");
const executable = packaged
  ? path.join(appRoot, "Contents/MacOS/Cutline")
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const outputParent = path.resolve(
  process.env.CUTLINE_HEAVY_RESULTS ?? path.join(root, "../qa-heavy-footage"),
);
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, "run-"));
const footage = path.join(work, "Studio interview.avi");
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const made = spawnSync(ffmpeg, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=1920x1080:rate=30:duration=20",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=330:duration=20",
  "-c:v",
  "mpeg4",
  "-q:v",
  "3",
  "-c:a",
  "pcm_s16le",
  footage,
]);
assert.equal(made.status, 0, String(made.stderr));

const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "user-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: executable,
  args: [...(packaged ? [] : [root]), "--force-color-profile=srgb"],
  env,
});
const errors = [];
try {
  const page = await app.firstWindow({ timeout: 90000 });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = async () => (await invoke("state")).snapshot.project;

  const started = Date.now();
  await invoke("import", { paths: [footage] });
  const asset = (await state()).assets.find((a) =>
    a.name.startsWith("Studio interview"),
  );
  assert(asset, "The AVI file did not import");
  console.log(
    `Imported in ${Date.now() - started} ms, preview copy ${asset.proxy ? "ready" : "pending"}`,
  );
  await page.getByRole("button", { name: "Media", exact: true }).click();
  // Record whether the card ever shows, however briefly: when the preview
  // copy is ready before the browser reports the decode failure, it never
  // needs to.
  await page.evaluate(() => {
    window.__cardSeen = false;
    const check = () => {
      if (
        document
          .querySelector(".canvas")
          ?.textContent?.includes("Preparing preview…")
      )
        window.__cardSeen = true;
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.getByLabel(`Add ${asset.name} to timeline`).click();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    if (await page.getByText("Preparing preview…").count()) {
      await page.screenshot({ path: path.join(work, "pending.png") });
      console.log("Preview shows the preparing card while the copy builds");
      break;
    }
  }
  // The preview copy arrives and plays in the editor.
  const deadline = Date.now() + 120000;
  while (!(await state()).assets.find((a) => a.id === asset.id)?.proxy) {
    assert(Date.now() < deadline, "The preview copy never finished");
    await page.waitForTimeout(500);
  }
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".canvas video")].some(
        (v) => v.currentSrc.includes("/proxy") && v.readyState >= 2,
      ),
    null,
    { timeout: 30000 },
  );
  assert.equal(await page.getByText("Preparing preview…").count(), 0);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Space");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Space");
  const moved = await page.evaluate(() => {
    const v = [...document.querySelectorAll(".canvas video")].find((x) =>
      x.currentSrc.includes("/proxy"),
    );
    return v ? v.currentTime : 0;
  });
  assert(moved > 0.3, `The preview copy did not play (currentTime ${moved})`);
  await page.screenshot({ path: path.join(work, "playing.png") });
  console.log(
    `Preview copy ready after ${Math.round((Date.now() - started) / 1000)} s and plays`,
  );
  const playback = errors.filter((e) =>
    /MediaPlaybackError|error while playing/i.test(e),
  );
  assert.deepEqual(playback, [], "Playback errors reached the page");
  // Remotion logs the decode failure itself before handing it to the card.
  assert.deepEqual(
    errors.filter((e) => !/^Error occurred in video/.test(e)),
    [],
    "Console errors",
  );
  const decodeFailed = errors.some((e) => /^Error occurred in video/.test(e));
  const cardSeen = await page.evaluate(() => window.__cardSeen);
  assert(
    !decodeFailed || cardSeen,
    "The decode failed but the preparing card never showed",
  );
  console.log(
    decodeFailed
      ? "Decode failure handled by the preparing card"
      : "Preview copy was ready before any decode failure",
  );
  console.log("QA heavy footage passed", work);
} finally {
  await app.close();
}
