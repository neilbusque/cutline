import { _electron as electron } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  work = path.resolve("../../work");
const fixture = JSON.parse(
  await readFile("sample-project/Cutline Demo.cutline", "utf8"),
);
const projectFile = path.join(work, "improvement-qa.cutline");
await writeFile(projectFile, JSON.stringify(fixture));
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "qa-improvements"),
};
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.CUTLINE_PACKAGED === "1";
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
  args: packaged ? [projectFile] : [root, projectFile],
  env,
});
const errors = [],
  results = [];
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
      label: "QA edit",
      commands,
    });
  };
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  const dimensions = await page
    .locator(".timeline-scroll")
    .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert(dimensions.scroll <= dimensions.width + 2);
  results.push("Fit shows the entire 75-second project");
  await page.getByLabel("Search media").fill("no matching file");
  assert.equal(await page.locator(".asset").count(), 0);
  await page.getByLabel("Search media").fill("source");
  assert.equal(await page.locator(".asset").count(), 1);
  await page.getByLabel("Search media").fill("");
  results.push("Media search filters imported assets");
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  const p = await state();
  const captions = p.clips.filter((c) => c.kind === "caption");
  assert(captions.length);
  await page.getByLabel("Search captions").fill(captions[0].text);
  assert.equal(await page.locator(".caption-list button").count(), 1);
  await page.getByLabel("Search captions").fill("");
  await page.getByRole("button", { name: "Apply Bold caption style" }).click();
  await page.waitForTimeout(100);
  assert(
    (await state()).clips
      .filter((c) => c.kind === "caption")
      .every((c) => c.fontSize === 82),
  );
  await invoke("undo");
  assert.equal(
    (await state()).clips.find((c) => c.id === captions[0].id).fontSize,
    captions[0].fontSize,
  );
  results.push("Caption search and batch styling with one undo");
  const title = p.clips.find((c) => c.kind === "text");
  await page.locator(".timeline-clip.text").first().click();
  await page
    .getByRole("button", { name: "Duplicate clip", exact: true })
    .click();
  await page.waitForTimeout(100);
  const duplicated = await state();
  assert.equal(duplicated.clips.length, p.clips.length + 1);
  const copy = duplicated.clips.find(
    (c) => !p.clips.some((x) => x.id === c.id),
  );
  assert.equal(copy.start, title.start + title.duration);
  await invoke("undo");
  results.push("Duplicate adds a separately editable clip and undo removes it");
  await tx([
    {
      type: "track.add",
      track: {
        id: "qa-overlay",
        name: "Overlay",
        kind: "video",
        muted: false,
        hidden: false,
      },
    },
  ]);
  const video = (await state()).clips.find((c) => c.kind === "video");
  const beforeMove = await state();
  const clipEl = page.locator(".timeline-clip.video").first();
  await clipEl.scrollIntoViewIfNeeded();
  const box = await clipEl.boundingBox();
  const dest = page.locator('[data-track-id="qa-overlay"]');
  await dest.scrollIntoViewIfNeeded();
  // Restore scroll so both source and destination are visible in a taller timeline.
  await page.locator(".timeline").evaluate((el) => (el.style.height = "390px"));
  await clipEl.scrollIntoViewIfNeeded();
  const b = await clipEl.boundingBox(),
    d = await dest.boundingBox();
  await page.mouse.move(b.x + Math.min(30, b.width / 2), b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + Math.min(30, b.width / 2), d.y + 25, {
    steps: 8,
  });
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.equal(
    (await state()).clips.find((c) => c.id === video.id).trackId,
    "qa-overlay",
  );
  await invoke("undo");
  results.push("Pointer drag moves video across compatible tracks");
  // Simulate an assistant transaction while a manual drag is still active.
  await clipEl.scrollIntoViewIfNeeded();
  const s = await clipEl.boundingBox();
  await page.mouse.move(s.x + 20, s.y + 20);
  await page.mouse.down();
  await page.mouse.move(s.x + 90, s.y + 20, { steps: 4 });
  await tx([{ type: "clip.update", id: video.id, patch: { volume: 0.42 } }]);
  await page.mouse.up();
  await page.getByRole("alert").waitFor();
  const conflict = await state();
  assert.equal(conflict.clips.find((c) => c.id === video.id).volume, 0.42);
  assert.equal(
    conflict.clips.find((c) => c.id === video.id).start,
    video.start,
  );
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await invoke("undo");
  results.push(
    "Concurrent edit rejects stale drag and preserves the newer change",
  );
  await page.getByRole("button", { name: "Media", exact: true }).click();
  const asset = (await state()).assets[0];
  const drag = await page.evaluateHandle((id) => {
    const dt = new DataTransfer();
    dt.setData("application/x-cutline-asset", id);
    return dt;
  }, asset.id);
  const oldCount = (await state()).clips.length;
  const dr = await dest.boundingBox();
  await dest.dispatchEvent("dragover", { dataTransfer: drag });
  await dest.dispatchEvent("drop", {
    dataTransfer: drag,
    clientX: dr.x + 30,
    clientY: dr.y + 20,
  });
  await page.waitForTimeout(100);
  assert.equal((await state()).clips.length, oldCount + 1);
  await invoke("undo");
  results.push("Media drop places a new clip on the destination track");
  await page.locator(".timeline-clip.text").first().focus();
  const oldStart = (await state()).clips.find((c) => c.id === title.id).start;
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(100);
  assert.equal(
    (await state()).clips.find((c) => c.id === title.id).start,
    oldStart + 10,
  );
  await invoke("undo");
  results.push("Keyboard clip nudge supports one or ten frames");
  await page.locator(".timeline").evaluate((el) => (el.style.height = ""));
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  await page.locator(".caption-list button").first().click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .getByRole("button", { name: "Add spring title", exact: true })
    .hover();
  await page.waitForTimeout(350);
  assert(
    (await page
      .getByRole("button", { name: "Add spring title", exact: true })
      .locator(".motion-demo div")
      .count()) > 1,
  );
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  results.push(
    "Motion presets preview their actual Remotion animation on hover",
  );
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/improved-editor.png" });
  assert.deepEqual(errors, []);
  results.push("No uncaught renderer errors");
  await writeFile(
    "qa-improvements-results.json",
    JSON.stringify(
      { date: new Date().toISOString(), packaged, results, errors },
      null,
      2,
    ),
  );
  console.log(results);
} finally {
  await app.close();
}
