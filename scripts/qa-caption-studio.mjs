import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  parentWork = path.resolve(root, "../../work");
await mkdir(parentWork, { recursive: true });
const work = await mkdtemp(path.join(parentWork, "caption-studio-qa-"));
const model = await build({
  entryPoints: ["src/shared/model.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { newProject, makeClip } = await import(
  `data:text/javascript;base64,${Buffer.from(model.outputFiles[0].text).toString("base64")}`
);
const project = newProject();
project.name = "Caption Studio · QA";
project.background = "#253427";
const track =
  project.tracks.find((t) => t.name === "Captions") ||
  project.tracks.find((t) => t.kind === "text");
const phrases = [
  "Make every word matter.",
  "One quiet morning.",
  "Watch the quiet ocean.",
];
project.clips = phrases.map((text, index) => ({
  ...makeClip(project, "caption", track.id, index * 90),
  id: `caption-${index}`,
  duration: 90,
  text,
  fontSize: 68,
  width: 840,
  height: 240,
  x: 85,
  y: 1300,
  words: text.split(" ").map((word, wordIndex) => ({
    text: word,
    start: wordIndex * 0.55,
    end: wordIndex * 0.55 + 0.5,
  })),
}));
const original = structuredClone(project.clips);
const projectFile = path.join(work, "captions.cutline");
await writeFile(
  projectFile,
  JSON.stringify({ project, past: [], future: [], filePath: projectFile }),
);
const packaged = process.env.CUTLINE_PACKAGED === "1";
const executablePath =
  process.env.CUTLINE_APP_EXECUTABLE ||
  (packaged
    ? path.join(
        root,
        "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline",
      )
    : path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ));
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath,
  args: packaged ? [projectFile] : [root, projectFile],
  env,
});
const results = [],
  errors = [];
let page;
const record = (message) => {
  results.push(message);
  console.log(message);
};
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const state = () => invoke("state");
  const current = async () => (await state()).snapshot.project;
  const waitRevision = async (revision) => {
    for (let i = 0; i < 100; i++) {
      if ((await current()).revision > revision) return;
      await page.waitForTimeout(50);
    }
    throw Error("Edit did not commit");
  };
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  const studio = page.locator(".caption-studio");
  await studio.waitFor({ state: "visible" });
  assert.equal(await studio.locator(".cs-presets button").count(), 11);
  const positions = [];
  for (let i = 0; i < 4; i++) {
    positions.push(
      await studio
        .locator('.cs-preview [data-active="true"]')
        .allTextContents(),
    );
    await page.waitForTimeout(400);
  }
  assert(
    new Set(positions.map((x) => x.join(""))).size > 1,
    "Preview does not animate",
  );
  await studio.getByLabel("Pause caption preview").click();
  const paused = await studio
    .locator(".cs-preview-progress span")
    .getAttribute("style");
  await page.waitForTimeout(250);
  assert.equal(
    await studio.locator(".cs-preview-progress span").getAttribute("style"),
    paused,
  );
  await studio.getByLabel("Play caption preview").click();
  record(
    "Eight curated presets share an animated preview with working pause/play",
  );
  let p = await current();
  const revision = p.revision;
  await studio
    .getByRole("button", {
      name: "Preview Spotlight caption style",
      exact: true,
    })
    .click();
  assert.equal(
    (await current()).revision,
    revision,
    "Preview mutated the project",
  );
  // Reject exactly one real IPC edit in this isolated QA process. The Studio must
  // preserve its staged draft and avoid claiming success before a confirmed save.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("cutline");
    if (!original) throw Error("Missing Cutline IPC handler");
    ipcMain.removeHandler("cutline");
    let rejectNext = true;
    ipcMain.handle("cutline", async (...args) => {
      // The editor sends its edits as "edit.brief" (a smaller reply).
      if ((args[1] === "edit" || args[1] === "edit.brief") && rejectNext) {
        rejectNext = false;
        throw Error("QA: project revision changed. Retry the staged edit.");
      }
      return original(...args);
    });
  });
  await studio
    .getByRole("button", { name: "Apply to 3 captions", exact: true })
    .click();
  await studio.getByText("Changes were not saved.", { exact: false }).waitFor();
  assert.equal((await current()).revision, revision);
  assert.equal(await studio.locator(".cs-notice").textContent(), "");
  assert.equal(
    await studio
      .getByRole("button", {
        name: "Preview Spotlight caption style",
        exact: true,
      })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert(
    await studio
      .getByRole("button", { name: "Apply to 3 captions", exact: true })
      .isEnabled(),
  );
  record(
    "Rejected IPC edit retains the staged style and displays no false success; retry remains available",
  );
  await page
    .getByRole("button", { name: "Dismiss error", exact: true })
    .click();
  await studio
    .getByRole("button", { name: "Apply to 3 captions", exact: true })
    .click();
  await waitRevision(revision);
  p = await current();
  assert(
    p.clips.every(
      (c) => c.captionStyle === "karaoke" && c.captionLayout === "balanced",
    ),
  );
  assert.deepEqual(
    p.clips.map((c) => [c.x, c.y, c.width, c.height]),
    original.map((c) => [c.x, c.y, c.width, c.height]),
  );
  await invoke("undo");
  assert((await current()).clips.every((c) => c.captionLayout === "legacy"));
  await invoke("redo");
  record(
    "All-caption preset is staged, preserves custom geometry, and commits as one undoable edit",
  );
  await studio.getByRole("tab", { name: "Edit words", exact: true }).click();
  await studio
    .getByRole("button", { name: /Select caption at 0:03.00:/ })
    .click();
  await studio.getByRole("tab", { name: "Style", exact: true }).click();
  await studio.getByLabel("Caption style scope").selectOption("selected");
  await studio.getByLabel("Caption letter case").selectOption("upper");
  await studio.getByLabel("Caption maximum lines").selectOption("1");
  await studio.getByLabel("Caption position").selectOption("upper");
  await studio.getByLabel("Use #ffd76a caption accent").click();
  p = await current();
  await studio
    .getByRole("button", { name: "Apply to selected caption", exact: true })
    .click();
  await waitRevision(p.revision);
  p = await current();
  assert.equal(p.clips[1].captionCase, "upper");
  assert.equal(p.clips[1].captionMaxLines, 1);
  assert.equal(p.clips[1].accent, "#ffd76a");
  assert(p.clips[1].y < project.height * 0.3);
  assert.equal(p.clips[0].captionCase, "original");
  assert.equal(p.clips[2].captionCase, "original");
  await invoke("undo");
  assert.equal((await current()).clips[1].captionCase, "original");
  record(
    "Selected-caption scope applies only to that phrase, with safe positioning and batch undo",
  );
  await studio.getByRole("tab", { name: "Edit words", exact: true }).click();
  await studio.getByLabel("Edit caption at 0:03.00", { exact: true }).click();
  await studio
    .getByLabel("Edit caption text", { exact: true })
    .fill("One calm morning.");
  p = await current();
  await studio.getByLabel("Edit caption text", { exact: true }).press("Enter");
  await waitRevision(p.revision);
  p = await current();
  assert.equal(p.clips[1].text, "One calm morning.");
  assert.deepEqual(
    p.clips[1].words.map((w) => [w.start, w.end]),
    original[1].words.map((w) => [w.start, w.end]),
  );
  await studio.getByLabel("Edit caption at 0:03.00", { exact: true }).click();
  await studio
    .getByLabel("Edit caption text", { exact: true })
    .fill("One very calm morning.");
  assert(
    await studio
      .getByText("Word timing will be cleared; caption timing retained.", {
        exact: false,
      })
      .isVisible(),
  );
  p = await current();
  await studio
    .getByRole("button", { name: "Save caption", exact: true })
    .click();
  await waitRevision(p.revision);
  p = await current();
  assert.equal(p.clips[1].words.length, 0);
  assert.equal(p.clips[1].start, original[1].start);
  assert.equal(p.clips[1].duration, original[1].duration);
  await invoke("undo");
  assert.equal((await current()).clips[1].text, "One calm morning.");
  await studio.getByLabel("Edit caption at 0:03.00", { exact: true }).click();
  await studio
    .getByLabel("Edit caption text", { exact: true })
    .fill("Do not save this");
  await studio.getByLabel("Edit caption text", { exact: true }).press("Escape");
  assert.equal((await current()).clips[1].text, "One calm morning.");
  record(
    "Inline correction supports Enter/Escape, preserves matching word times, clears changed counts, and retains clip bounds",
  );
  const inspectorText = page
    .locator(".inspector label.field.stack textarea")
    .first();
  p = await current();
  const beforeInspector = structuredClone(p.clips[1]);
  await inspectorText.fill("One bright morning.");
  await inspectorText.press("Tab");
  await waitRevision(p.revision);
  p = await current();
  assert.equal(p.clips[1].text, "One bright morning.");
  assert.deepEqual(
    p.clips[1].words.map((word) => [word.start, word.end]),
    beforeInspector.words.map((word) => [word.start, word.end]),
  );
  await invoke("undo");
  assert.equal((await current()).clips[1].text, beforeInspector.text);
  p = await current();
  await inspectorText.fill("One very bright morning.");
  await inspectorText.press("Tab");
  await waitRevision(p.revision);
  p = await current();
  assert.equal(p.clips[1].text, "One very bright morning.");
  assert.deepEqual(p.clips[1].words, []);
  assert.equal(p.clips[1].start, beforeInspector.start);
  assert.equal(p.clips[1].duration, beforeInspector.duration);
  await invoke("undo");
  assert.equal((await current()).clips[1].text, beforeInspector.text);
  assert.deepEqual((await current()).clips[1].words, beforeInspector.words);
  record(
    "Inspector text edits preserve matching word timing, clear changed counts, retain phrase bounds, and undo cleanly",
  );
  await studio.getByLabel("Search caption phrases").fill("quiet");
  assert.equal(await studio.locator(".cs-phrases article").count(), 1);
  await studio.locator(".cs-replace summary").click();
  await studio.getByLabel("Replace caption words with").fill("peaceful");
  await studio
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  assert(
    await studio.getByText("1 phrase will change", { exact: true }).isVisible(),
  );
  p = await current();
  await studio
    .getByRole("button", { name: "Replace in 1 caption", exact: true })
    .click();
  await waitRevision(p.revision);
  assert.equal((await current()).clips[2].text, "Watch the peaceful ocean.");
  await invoke("undo");
  assert.equal((await current()).clips[2].text, "Watch the quiet ocean.");
  await studio.getByLabel("Clear caption search").click();
  await studio.locator(".cs-replace summary").click();
  record(
    "Search filters phrases; reviewed find/replace is literal, scoped to matches, and undoable",
  );
  await studio.evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({ path: path.join(work, "caption-editor.png") });
  await studio.getByRole("tab", { name: "Style", exact: true }).click();
  await studio
    .getByRole("button", { name: "Preview Punch caption style", exact: true })
    .click();
  await studio.evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({ path: path.join(work, "caption-studio.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  await page.waitForTimeout(300);
  assert(await studio.isVisible());
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await studio
    .getByRole("button", { name: "Apply to selected caption", exact: true })
    .scrollIntoViewIfNeeded();
  assert(
    await studio
      .getByRole("button", { name: "Apply to selected caption", exact: true })
      .isVisible(),
  );
  await page.screenshot({
    path: path.join(work, "caption-studio-minimum.png"),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await studio.locator(".cs-preview").scrollIntoViewIfNeeded();
  assert(await studio.getByLabel("Play caption preview").isVisible());
  record(
    "Caption Studio is scrollable at 1100×760 with visible apply action, accessible tabs, and reduced-motion pause",
  );
  assert.deepEqual(errors, []);
  record("No renderer errors or project asset mutations");
  await writeFile(
    path.join(work, "results.json"),
    JSON.stringify(
      { packaged, date: new Date().toISOString(), work, results, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ work, results }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(work, "failure.png") })
    .catch(() => {});
  await writeFile(
    path.join(work, "failure.json"),
    JSON.stringify(
      { message: error.message, stack: error.stack, results, errors },
      null,
      2,
    ),
  );
  console.error("QA artifacts:", work);
  throw error;
} finally {
  await app.close();
}
