import { _electron as electron, expect } from "@playwright/test";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

// Story > Produce > Draw this shot, live: the signed-in Claude (or ChatGPT,
// with CUTLINE_STORY_DRAW_PROVIDER=codex) draws a whole frame for a scene, it
// lands in Media and becomes the scene's visual. No Higgsfield request is
// made: paid hosts are blocked in the main process.
// npm run build && node scripts/qa-story-draw.mjs
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED === "1";
const parent = path.resolve(
  process.env.CUTLINE_STORY_DRAW_RESULTS ?? path.join(root, "../qa-story-draw"),
);
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "run-"));
const data = path.join(work, "user-data");
const projectFile = path.join(work, "drawn.cutline");
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: data,
  CUTLINE_PROJECTS_DIR: path.join(work, "projects"),
};
delete env.ELECTRON_RUN_AS_NODE;
const model = await build({
  entryPoints: [path.join(root, "src/shared/model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { newProject } = await import(
  `data:text/javascript;base64,${Buffer.from(model.outputFiles[0].text).toString("base64")}`
);
const initial = newProject();
initial.name = "Drawn shot QA";
initial.width = 1280;
initial.height = 720;
await writeFile(
  projectFile,
  JSON.stringify({ project: initial, past: [], future: [], filePath: projectFile }),
);
const report = { work, checks: [], pageErrors: [], consoleErrors: [], paid: [] };
const check = (message, detail) => {
  report.checks.push({ message, ...(detail === undefined ? {} : { detail }) });
  console.log("✓", message, detail ?? "");
};
let app;
try {
  app = await electron.launch({
    executablePath: path.join(
      root,
      packaged
        ? "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline"
        : "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [...(packaged ? [] : [root]), projectFile, "--use-mock-keychain"],
    env,
  });
  // Any request to a paid generation host fails the run.
  await app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.__cutlinePaid = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(
        typeof input === "string" ? input : (input.url ?? String(input)),
      );
      if (url.hostname.endsWith("higgsfield.ai")) {
        globalThis.__cutlinePaid.push(url.pathname);
        throw Error("Paid generation is blocked during this QA");
      }
      return original(input, options);
    };
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  if (process.env.CUTLINE_STORY_DRAW_PROVIDER === "codex")
    await invoke("assistant.settings.set", { provider: "codex" });
  const panel = page.locator(".story-library");
  await page
    .locator(".library-tabs button")
    .filter({ hasText: /^Story$/ })
    .click();
  await panel.waitFor({ state: "visible" });
  await panel.locator(".story-script-entry > summary").click();
  await panel
    .getByLabel("Story script")
    .fill("A farmer checks her tomato plants at sunrise.");
  await panel
    .getByRole("button", { name: "Split into scenes", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Save storyline", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Produce scenes", exact: true })
    .click();
  const draw = panel.getByRole("button", { name: "Draw this shot", exact: true });
  await draw.waitFor({ state: "visible" });
  await draw.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(work, "before.png") });
  const started = Date.now();
  await draw.click();
  await expect(
    panel.getByRole("button", { name: "Drawing this shot…", exact: true }),
  ).toBeVisible();
  check("Draw this shot starts and shows its progress");
  await expect(draw).toBeVisible({ timeout: 300000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  const error = await panel.locator(".story-error").allTextContents();
  assert.deepEqual(error, [], `Drawing failed: ${error.join(" ")}`);
  const project = (await invoke("state")).snapshot.project;
  const drawn = project.assets.filter((asset) => asset.kind === "image");
  assert.equal(drawn.length, 1, "One drawn image was added to Media");
  assert.equal(drawn[0].width, 1280, "The drawing fills the frame width");
  assert.equal(drawn[0].height, 720, "The drawing fills the frame height");
  const by = process.env.CUTLINE_STORY_DRAW_PROVIDER === "codex" ? "ChatGPT" : "Claude";
  check(`${by} drew the shot in ${seconds}s as a 1280x720 image in Media`);
  await expect(panel.getByLabel("Scene visual asset")).toHaveValue(drawn[0].id);
  await expect(panel.locator("img.story-shot-preview")).toBeVisible();
  check("The drawing became the scene's visual, with its preview");
  await draw.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(work, "after.png") });
  report.paid = await app.evaluate(() => globalThis.__cutlinePaid);
  assert.deepEqual(report.paid, [], "No paid generation request was made");
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  check("No paid requests and no console errors");
} finally {
  await writeFile(path.join(work, "report.json"), JSON.stringify(report, null, 2));
  await app?.close().catch(() => {});
}
console.log(work);
