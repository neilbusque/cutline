import { _electron as electron } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  work = path.resolve("../../work");
const fixture = JSON.parse(
  await readFile("sample-project/Cutline Demo.cutline", "utf8"),
);
fixture.project.assets = [];
fixture.project.clips = [];
fixture.project.motions = [];
fixture.project.name = "Creative tools QA";
fixture.past = [];
fixture.future = [];
const file = path.join(work, "qa-creative.cutline");
await writeFile(file, JSON.stringify(fixture));
const packaged = process.env.CUTLINE_PACKAGED === "1";
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "qa-creative-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: packaged
    ? path.join(
        root,
        "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline",
      )
    : path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
  args: packaged ? [file] : [root, file],
  env,
});
const results = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = async () => (await invoke("state")).snapshot.project;
  const tx = async (commands) => {
    const p = await state();
    return invoke("edit", {
      projectId: p.id,
      revision: p.revision,
      label: "QA creative",
      commands,
    });
  };
  const importError = await invoke("import", {
    paths: [
      path.join(root, "sample-project/source.mp4"),
      path.join(work, "does-not-exist.mp4"),
      path.join(work, "qa-second.mp4"),
      path.join(root, "screenshots/export-frame-90-final.png"),
    ],
  }).catch((e) => e.message);
  assert(importError.includes("3 of 4"));
  assert.equal((await state()).assets.length, 3);
  results.push(
    "Multiple-file import keeps three valid files when one is unsupported/missing",
  );
  await page.getByLabel("Select source.mp4", { exact: true }).check();
  await page.getByLabel("Select qa-second.mp4", { exact: true }).check();
  await page
    .getByRole("button", { name: "Add selected", exact: false })
    .click();
  await page.waitForTimeout(150);
  let p = await state();
  assert.equal(p.clips.length, 2);
  assert.equal(p.clips[1].start, p.clips[0].duration);
  const first = p.clips[0];
  await invoke("undo");
  assert.equal((await state()).clips.length, 0);
  await invoke("redo");
  results.push("Selected videos append as one gap-free, undoable sequence");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.locator(".timeline-clip.video").first().click();
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("button", { name: "Apply cinematic look" }).click();
  await page.waitForTimeout(100);
  assert.equal((await state()).clips[0].look, "cinematic");
  // The timeline toolbar has its own "Zoom in" button, so look in Effects.
  await page
    .locator(".effects-library")
    .getByRole("button", { name: "Zoom in", exact: true })
    .click();
  await page.waitForTimeout(100);
  assert.equal((await state()).clips[0].cameraMotion, "zoom-in");
  await page.getByLabel("Vignette", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  assert((await state()).clips[0].vignette > 0);
  await page
    .getByRole("button", { name: "Apply this look to all video & photos" })
    .click();
  await page.waitForTimeout(100);
  assert((await state()).clips.every((c) => c.look === "cinematic"));
  await invoke("undo");
  assert.equal((await state()).clips[1].look, "none");
  results.push(
    "Looks, camera motion, sliders and batch look matching remain undoable",
  );
  // Scrub to two seconds and trim from the toolbar.
  const el = page.locator(".timeline-clip.video").first(),
    b = await el.boundingBox(),
    r = await page.locator(".ruler").boundingBox();
  const scale = b.width / first.duration;
  await page.mouse.click(r.x + 60 * scale, r.y + 12);
  await page.getByRole("button", { name: "Trim start to playhead" }).click();
  await page.waitForTimeout(100);
  p = await state();
  assert(Math.abs(p.clips[0].sourceIn - 2) < 0.1);
  await invoke("undo");
  results.push("Trim-to-playhead preserves original source timing");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("button", { name: "Expressive", exact: true }).click();
  assert.equal(await page.locator(".motion-tile").count(), 8);
  await page.getByRole("button", { name: "Add blur in title" }).click();
  await page.waitForTimeout(100);
  p = await state();
  let title = p.clips.find((c) => c.kind === "text");
  assert.equal(title.preset, "blur-in");
  await page
    .getByLabel("Exit animation", { exact: true })
    .selectOption("shrink");
  await page.getByLabel("Animation (s)", { exact: true }).fill("0.8");
  await page.getByLabel("Animation (s)", { exact: true }).press("Tab");
  await page.waitForTimeout(100);
  assert.equal(
    (await state()).clips.find((c) => c.id === title.id).animationFrames,
    24,
  );
  results.push(
    "Expressive text animations support editable entrance duration and exit",
  );
  await page.getByRole("button", { name: "B-roll", exact: true }).click();
  await page.getByLabel("Search free videos").fill("ocean");
  await page.getByRole("button", { name: "Search stock videos" }).click();
  await page.locator(".stock-result").first().waitFor({ timeout: 30000 });
  const ocean = page
    .locator(".stock-result")
    .filter({ has: page.getByText("Ocean in Sommaroy", { exact: true }) })
    .first();
  await ocean.waitFor();
  assert((await ocean.locator(".stock-license").textContent()).includes("CC0"));
  await ocean
    .getByRole("button", { name: "Preview Ocean in Sommaroy" })
    .click();
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".stock-preview video")).some(
        (v) => v.readyState >= 2,
      ),
    {},
    { timeout: 30000 },
  );
  await ocean.getByRole("button", { name: "Add B-roll", exact: true }).click();
  await page.waitForFunction(
    () => !!document.querySelector('input[aria-label="Rename B-roll"]'),
    {},
    { timeout: 45000 },
  );
  p = await state();
  const stock = p.assets.find((a) => a.origin);
  assert(stock);
  const broll = p.clips.find((c) => c.assetId === stock.id);
  assert(broll);
  assert.equal(broll.volume, 0);
  assert.equal(broll.duration, 150);
  assert(
    p.tracks.findIndex((t) => t.id === broll.trackId) >
      p.tracks.findIndex((t) => t.id === "captions"),
  );
  assert(
    p.tracks.findIndex((t) => t.id === broll.trackId) <
      p.tracks.findIndex((t) => t.id === "video"),
  );
  results.push(
    "Live Commons search, playable preview, local download, stored CC0 credit, muted five-second B-roll placement",
  );
  await invoke("undo");
  assert(!(await state()).clips.some((c) => c.id === broll.id));
  assert((await state()).assets.some((a) => a.id === stock.id));
  await invoke("redo");
  results.push("B-roll placement undoes without deleting the downloaded asset");
  await page.getByRole("separator", { name: "Resize timeline" }).focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await page
      .locator(".timeline")
      .evaluate((el) => el.getBoundingClientRect().height),
    314,
  );
  results.push("Timeline resizes using keyboard");
  // Build a short real-footage render using the downloaded asset and new effects.
  p = await state();
  await tx([
    ...p.clips
      .filter((c) => c.id !== broll.id && c.id !== title.id)
      .map((c) => ({ type: "clip.delete", id: c.id, ripple: false })),
    {
      type: "clip.update",
      id: broll.id,
      patch: {
        start: 0,
        duration: 120,
        look: "warm",
        cameraMotion: "zoom-in",
        vignette: 0.3,
      },
    },
    {
      type: "clip.update",
      id: title.id,
      patch: {
        start: 0,
        duration: 120,
        text: "A little more cinematic.",
        preset: "blur-in",
        exitAnimation: "shrink",
        fontSize: 74,
        y: 720,
      },
    },
  ]);
  await page.getByRole("button", { name: "Go to start" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(1700);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.locator(".timeline-clip.video").first().click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.screenshot({ path: "screenshots/creative-editor.png" });
  const job = await invoke("test.export", {
    path: path.join(root, "creative-demo.mp4"),
  });
  const started = Date.now();
  let complete;
  while (Date.now() - started < 180000) {
    const jobs = (await invoke("state")).jobs;
    complete = jobs.find((j) => j.id === job.id);
    if (complete?.state === "done") break;
    if (complete?.state === "error") throw Error(complete.message);
    await page.waitForTimeout(1000);
  }
  assert.equal(complete?.state, "done");
  results.push(
    `Real stock footage with video effects and animated title exported at 1080p in ${Math.round((Date.now() - started) / 1000)}s`,
  );
  await writeFile(
    "creative-demo-credits.txt",
    `${stock.origin.title}\n${stock.origin.creator}\n${stock.origin.page}\n${stock.origin.license}\n${stock.origin.licenseUrl}\n`,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  await page.waitForTimeout(250);
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    bottom: document.querySelector(".statusbar").getBoundingClientRect().bottom,
    scroll: document.documentElement.scrollWidth,
  }));
  assert(layout.bottom <= layout.height + 1);
  assert(layout.scroll <= layout.width + 1);
  results.push(
    "Minimum Mac window keeps navigation, timeline and footer in bounds",
  );
  assert.deepEqual(errors, []);
  results.push("No uncaught renderer errors");
  await writeFile(
    "qa-creative-results.json",
    JSON.stringify(
      { date: new Date().toISOString(), packaged, results, errors },
      null,
      2,
    ),
  );
  console.log(results);
} catch (e) {
  const page = await app.firstWindow();
  await page.screenshot({ path: path.join(work, "qa-creative-error.png") });
  throw e;
} finally {
  await app.close();
}
