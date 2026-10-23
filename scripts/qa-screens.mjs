import { _electron as electron } from "@playwright/test";
import { cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

// Screenshot every editor panel at the default and minimum window sizes, in
// disposable app data, and report console errors and off-screen overflow.
// It only navigates (tabs, selections, disclosure panels); it never exports,
// imports, generates or edits the project. Without an explicit example, it
// creates a local synthetic fixture so selected-clip screens cannot silently skip.
// External HTTP is blocked in both the main process and renderer.
//
//   node scripts/qa-screens.mjs                      source Electron
//   CUTLINE_PACKAGED=1 node scripts/qa-screens.mjs   staged Mac app
//   CUTLINE_SCREENS_OUT=/abs/dir                     output folder
//   CUTLINE_SCREENS_ONLY=media,text-scenes           subset of screens
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
  process.env.CUTLINE_SCREENS_RESULTS ?? path.join(root, "../qa-screens"),
);
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, "run-"));
const out = path.resolve(process.env.CUTLINE_SCREENS_OUT ?? work);
await mkdir(out, { recursive: true });
const exampleDir = process.env.CUTLINE_SCREENS_PROJECT_DIR
  ? path.resolve(process.env.CUTLINE_SCREENS_PROJECT_DIR)
  : undefined;
const exampleFile =
  process.env.CUTLINE_SCREENS_PROJECT ?? "A better morning.cutline";
// Opening a project writes it back, so always open a copy. Copy the real
// folder: copying a symlinked example would copy the link and open the original.
const projectDir = path.join(work, "project");
if (exampleDir && existsSync(exampleDir))
  await cp(await realpath(exampleDir), projectDir, { recursive: true });
let projectFile = path.join(projectDir, exampleFile);
if (!existsSync(projectFile)) {
  if (
    process.env.CUTLINE_SCREENS_PROJECT_DIR ||
    process.env.CUTLINE_SCREENS_PROJECT
  )
    throw Error("The explicitly requested screenshot project was not found");
  await mkdir(projectDir, { recursive: true });
  const bundle = await build({
    entryPoints: [path.join(root, "src/shared/model.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const { newProject, makeClip } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const ffmpeg = path.join(
    root,
    "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
  );
  const video = path.join(projectDir, "Synthetic blue source.mp4");
  const audio = path.join(projectDir, "Synthetic tone.wav");
  for (const args of [
    [
      "-f",
      "lavfi",
      "-i",
      "color=c=#284663:s=640x360:r=30:d=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video,
    ],
    [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=3",
      "-c:a",
      "pcm_s16le",
      audio,
    ],
  ]) {
    const result = spawnSync(ffmpeg, ["-v", "error", "-y", ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const project = newProject();
  Object.assign(project, {
    name: "Editor panels QA fixture",
    width: 1080,
    height: 1920,
    fps: 30,
  });
  project.assets = [
    {
      id: "screens-video",
      name: path.basename(video),
      kind: "video",
      path: video,
      proxy: video,
      duration: 3,
      width: 640,
      height: 360,
      fps: 30,
      hasAudio: false,
    },
    {
      id: "screens-audio",
      name: path.basename(audio),
      kind: "audio",
      path: audio,
      duration: 3,
      hasAudio: true,
      waveform: Array.from({ length: 90 }, (_, i) => 0.2 + (i % 6) * 0.1),
    },
  ];
  project.clips = [
    makeClip(project, "video", "video", 0, project.assets[0]),
    makeClip(project, "audio", "audio", 0, project.assets[1]),
    {
      ...makeClip(project, "caption", "captions", 0),
      duration: 90,
      text: "A clear idea starts here.",
      words: [
        { text: "A", start: 0, end: 0.3 },
        { text: "clear", start: 0.3, end: 0.9 },
        { text: "idea", start: 0.9, end: 1.4 },
        { text: "starts", start: 1.4, end: 2 },
        { text: "here.", start: 2, end: 2.8 },
      ],
    },
  ];
  projectFile = path.join(projectDir, "Editor panels QA.cutline");
  await writeFile(
    projectFile,
    JSON.stringify({ project, past: [], future: [] }),
  );
}
const only = (process.env.CUTLINE_SCREENS_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const sizes = (process.env.CUTLINE_SCREENS_SIZES ?? "1440x960,1100x760")
  .split(",")
  .map((s) => s.split("x").map(Number));

const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "user-data"),
};
delete env.ELECTRON_RUN_AS_NODE;

const report = {
  screens: [],
  pageErrors: [],
  consoleErrors: [],
  failed: [],
  blockedNetwork: [],
};
let app;
try {
  app = await electron.launch({
    executablePath: executable,
    args: [
      ...(packaged ? [] : [root]),
      "--force-color-profile=srgb",
      ...(existsSync(projectFile) ? [projectFile] : []),
    ],
    env,
  });
  await app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.__screensBlockedNetwork = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(
        typeof input === "string" ? input : (input.url ?? String(input)),
      );
      if (
        /^https?:$/.test(url.protocol) &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ) {
        globalThis.__screensBlockedNetwork.push(url.origin);
        throw Error("External network access is disabled during screenshot QA");
      }
      return original(input, options);
    };
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return route.continue();
    report.blockedNetwork.push(url.origin);
    await route.abort("blockedbyclient");
  });
  const page = await app.firstWindow({ timeout: 90000 });
  page.on("pageerror", (e) => report.pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") report.consoleErrors.push(m.text());
  });
  await page.waitForSelector(".titlebar", { timeout: 60000 });
  await page.waitForTimeout(1500);

  const state = async () =>
    (await page.evaluate(() => window.cutline.invoke("state"))).snapshot
      .project;
  const libraryTab = (label) =>
    page
      .locator(".library-tabs")
      .getByRole("button", { name: label, exact: true });
  const clickText = async (scope, text) => {
    const target = page.locator(scope).getByText(text, { exact: true }).first();
    await target.click({ timeout: 4000 });
  };
  const selectClip = async (kind) => {
    const clip = page.locator(`.timeline-clip.${kind}`).first();
    assert(
      await clip.count(),
      `Missing ${kind} clip for the requested selected-clip screen`,
    );
    await clip.focus();
    await clip.press("Enter");
    return true;
  };
  const rightTab = async (label) =>
    page
      .locator("button")
      .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
      .first()
      .click({ timeout: 4000 });
  const closeModal = async () => {
    await page.keyboard.press("Escape");
    if (await page.locator(".modal-backdrop").count())
      await page
        .locator(".modal-backdrop")
        .first()
        .click({ position: { x: 5, y: 5 } });
  };

  const screens = [
    ["story", async () => libraryTab("Story").click()],
    ["generate", async () => libraryTab("Generate").click()],
    [
      "reel-auto",
      async () => {
        await libraryTab("Reel").click();
        await clickText(".reel-mode", "Auto edit");
      },
    ],
    [
      "reel-manual",
      async () => {
        await libraryTab("Reel").click();
        await clickText(".reel-mode", "Build manually");
      },
    ],
    ["media", async () => libraryTab("Media").click()],
    ["stock", async () => libraryTab("Stock").click()],
    [
      "audio-music",
      async () => {
        await libraryTab("Audio").click();
        await page
          .locator(".audio-modes button")
          .filter({ hasText: "Music sync" })
          .click();
      },
    ],
    [
      "audio-voice",
      async () => {
        await libraryTab("Audio").click();
        await page
          .locator(".audio-modes button")
          .filter({ hasText: /^Text to speech$/ })
          .click();
      },
    ],
    [
      "audio-library",
      async () => {
        await libraryTab("Audio").click();
        await page
          .locator(".audio-modes button")
          .filter({ hasText: "My audio" })
          .click();
      },
    ],
    ...["Sequence", "Scenes", "Shapes", "Vectors", "Text"].map((tab) => [
      `text-${tab.toLowerCase()}`,
      async () => {
        await libraryTab("Motion").click();
        await page
          .locator(".mg-tabs [role=tab]")
          .filter({ hasText: tab })
          .click();
      },
    ]),
    [
      "effects-video-selected",
      async () => {
        await selectClip("video");
        await libraryTab("Effects").click();
      },
    ],
    [
      "captions-style",
      async () => {
        await libraryTab("Captions").click();
        await page.locator("#caption-style-tab").click();
      },
    ],
    [
      "captions-words",
      async () => {
        await libraryTab("Captions").click();
        await page.locator("#caption-edit-tab").click();
      },
    ],
    [
      "properties-video",
      async () => {
        await rightTab("Properties");
        await selectClip("video");
      },
    ],
    [
      "properties-caption",
      async () => {
        await rightTab("Properties");
        await selectClip("caption");
      },
    ],
    [
      "properties-audio",
      async () => {
        await rightTab("Properties");
        await selectClip("audio");
      },
    ],
    [
      "properties-none",
      async () => {
        await rightTab("Properties");
        await page.keyboard.press("Escape");
        await page.locator(".stage").click({ position: { x: 4, y: 4 } });
        await page
          .getByText("Select a clip to edit it", { exact: true })
          .waitFor({ state: "visible" });
      },
    ],
    ["assistant", async () => rightTab("Assistant")],
    [
      "settings",
      async () => {
        await page.getByTitle("Settings & connections").click();
        await page.waitForSelector(".modal-backdrop", { timeout: 4000 });
      },
    ],
    [
      "projects",
      async () => {
        await page.getByTitle("Projects (⌘O)").click();
        await page.waitForSelector(".projects-modal", { timeout: 4000 });
        await page.waitForSelector(
          ".projects-row:not(.projects-head), .projects-empty:not(:has-text('Loading'))",
          { timeout: 4000 },
        );
      },
    ],
  ];

  for (const requested of only)
    assert(
      screens.some(([name]) => name === requested),
      `Unknown screenshot screen: ${requested}`,
    );
  for (const size of sizes)
    assert(
      size.length === 2 && size.every((v) => Number.isFinite(v) && v > 0),
      "Invalid screenshot size",
    );

  const overflow = () =>
    page.evaluate(() => {
      const vw = window.innerWidth;
      const found = [];
      if (document.documentElement.scrollWidth > vw + 1)
        found.push(
          `page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`,
        );
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (r.right > vw + 1 && r.left < vw) {
          const name =
            el.tagName.toLowerCase() +
            (el.className && typeof el.className === "string"
              ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
              : "");
          found.push(`${name} right=${Math.round(r.right)}`);
          if (found.length > 8) break;
        }
      }
      return found;
    });

  for (const [width, height] of sizes) {
    await app.evaluate(
      ({ BrowserWindow }, s) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setContentSize(s.width, s.height);
        w.center();
      },
      { width, height },
    );
    await page.waitForTimeout(500);
    for (const [name, go] of screens) {
      if (only.length && !only.includes(name)) continue;
      const file = path.join(out, `${width}-${name}.png`);
      try {
        await go();
        await page.waitForTimeout(650);
        await page.screenshot({ path: file });
        report.screens.push({
          name,
          width,
          file,
          viewport: await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          })),
          overflow: await overflow(),
        });
      } catch (error) {
        report.failed.push({
          name,
          width,
          error: String(error.message ?? error).split("\n")[0],
        });
      } finally {
        if (name === "settings" || name === "projects")
          await closeModal().catch(() => {});
      }
    }
  }

  const p = await state().catch(() => undefined);
  report.project = p
    ? { name: p.name, clips: p.clips.length, tracks: p.tracks.length }
    : null;
} catch (error) {
  report.failed.push({
    name: "setup-or-capture",
    error: String(error.message ?? error),
  });
} finally {
  if (app) {
    try {
      report.blockedNetwork.push(
        ...(await app.evaluate(() => globalThis.__screensBlockedNetwork ?? [])),
      );
    } catch {}
    await app.close().catch((error) =>
      report.failed.push({
        name: "cleanup",
        error: String(error.message ?? error),
      }),
    );
  }
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
if (
  report.failed.length ||
  report.pageErrors.length ||
  report.consoleErrors.length ||
  report.blockedNetwork.length ||
  report.screens.some((s) => s.overflow.length)
)
  process.exitCode = 1;
console.log(
  JSON.stringify(
    {
      out,
      screens: report.screens.length,
      failed: report.failed,
      blockedNetwork: [...new Set(report.blockedNetwork)],
      pageErrors: report.pageErrors.length,
      consoleErrors: [...new Set(report.consoleErrors)].slice(0, 10),
      overflow: report.screens
        .filter((s) => s.overflow.length)
        .map(
          (s) => `${s.width}-${s.name}: ${s.overflow.slice(0, 3).join("; ")}`,
        ),
    },
    null,
    2,
  ),
);
