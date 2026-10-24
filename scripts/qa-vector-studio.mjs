import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// Live check of the Vectors panel: generate with Claude and ChatGPT, add real
// brand logos and a page screenshot, then render frames the way export does.
// Uses the signed-in assistants and the network; disposable app data.
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED !== "0";
const out = path.resolve(
  process.env.CUTLINE_STUDIO_QA_RESULTS ??
    path.join(root, "../qa-vector-studio"),
);
await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(out, "run-"));
const data = path.join(work, "user-data");
const env = { ...process.env, CUTLINE_QA: "1", CUTLINE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CLAUDECODE;
const executable = packaged
  ? path.join(
      process.env.CUTLINE_APP ?? "/Applications/Cutline.app",
      "Contents/MacOS/Cutline",
    )
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const skipGenerate = process.env.CUTLINE_QA_SKIP_GENERATE === "1";

const results = [];
const consoleErrors = [];
const log = (step, detail = "") => {
  results.push({ step, detail });
  console.log(`✓ ${step}${detail ? ` ${detail}` : ""}`);
};

const app = await electron.launch({
  executablePath: executable,
  args: packaged ? ["--use-mock-keychain"] : [root, "--use-mock-keychain"],
  env,
});
let client;
try {
  const page = await app.firstWindow({ timeout: 90000 });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  const project = async () => (await invoke("state")).snapshot.project;
  const guard = (p) => ({ projectId: p.id, revision: p.revision });
  const settings = (await invoke("state")).settings;
  client = new Client({ name: "cutline-vector-studio-qa", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: settings.mcpLauncher,
      args: [],
      env: { ...env, CUTLINE_CONNECTION: path.join(data, "connection.json") },
      stderr: "pipe",
    }),
  );
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert(!response.isError, `${name}: ${text}`);
    try {
      return { ...JSON.parse(text), _content: response.content };
    } catch {
      return { text, _content: response.content };
    }
  };
  // A vertical reel canvas, like the reels in Downloads.
  await call("cutline_edit", {
    ...guard(await project()),
    label: "Reel canvas",
    actions: [
      {
        type: "project.update",
        patch: { width: 1080, height: 1920, background: "#f1efe9" },
      },
    ],
  });
  const resize = (width, height) =>
    app.evaluate(
      ({ BrowserWindow }, s) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setContentSize(s.width, s.height);
        w.center();
      },
      { width, height },
    );
  await resize(1440, 900);
  await page
    .locator(".library-tabs")
    .getByRole("button", { name: "Motion", exact: true })
    .click();
  await page
    .locator(".mg-tabs [role=tab]")
    .filter({ hasText: "Vectors" })
    .click();
  await page.waitForSelector(".vs-studio");
  await page.screenshot({ path: path.join(out, "1440-vectors.png") });
  log("Vectors panel opens");

  const seekTo = async (seconds) =>
    call("cutline_preview", { seconds, playing: false });

  if (!skipGenerate) {
    for (const [index, run] of [
      {
        provider: "Claude",
        style: "gradient",
        prompt: "A rocket lifting off with a soft flame trail",
      },
      {
        provider: "ChatGPT",
        style: "line",
        prompt: "A coffee cup with three wisps of steam",
      },
    ].entries()) {
      await seekTo(index * 3);
      await page
        .getByLabel("Describe the vector", { exact: true })
        .fill(run.prompt);
      await page
        .getByLabel("Vector style", { exact: true })
        .selectOption(run.style);
      await page
        .locator(".vs-segmented")
        .filter({ hasText: "Drawn by" })
        .getByRole("button", { name: run.provider })
        .click();
      const started = Date.now();
      await page.locator(".vs-section .import-button.primary").click();
      await page.waitForSelector(".vs-result", { timeout: 300000 });
      await page.waitForTimeout(600);
      await page.screenshot({
        path: path.join(
          out,
          `1440-generated-${run.provider.toLowerCase()}.png`,
        ),
      });
      const hint = await page
        .locator(".vs-result .mg-sequence-hint")
        .innerText();
      const before = (await project()).revision;
      await page
        .getByRole("button", { name: "Add to timeline", exact: true })
        .click();
      await page.waitForFunction(
        async (rev) =>
          (await window.cutline.invoke("state")).snapshot.project.revision >
          rev,
        before,
      );
      log(
        `Generated with ${run.provider}`,
        `${Math.round((Date.now() - started) / 1000)}s, ${hint}`,
      );
    }
  }

  const addLogo = async (name, color, at) => {
    await seekTo(at);
    await page
      .locator(".vs-segmented")
      .filter({ hasText: "Color" })
      .getByRole("button", { name: color })
      .click();
    await page.getByLabel("Search brand logos", { exact: true }).fill(name);
    const first = page.locator(".vs-matches button").first();
    await first.waitFor({ timeout: 30000 });
    await page.waitForFunction(
      (n) =>
        document
          .querySelector(".vs-matches button")
          ?.innerText.toLowerCase()
          .includes(n.toLowerCase()),
      name,
      { timeout: 30000 },
    );
    const label = await first.innerText();
    const before = (await project()).revision;
    await first.click();
    await page.waitForFunction(
      async (rev) =>
        (await window.cutline.invoke("state")).snapshot.project.revision > rev,
      before,
      { timeout: 60000 },
    );
    await page.waitForSelector(".vs-matches button:not([disabled])");
    log(`Logo ${name}`, label.replace(/\s+/g, " "));
  };
  await addLogo("Claude", "Brand", 6);
  await addLogo("ChatGPT", "Brand", 9);
  await addLogo("Cursor", "Black", 12);
  await page.screenshot({ path: path.join(out, "1440-logos.png") });

  await seekTo(15);
  await page
    .getByLabel("Page address", { exact: true })
    .fill("github.com/affaan-m/everything-claude-code");
  const before = (await project()).revision;
  await page
    .getByRole("button", { name: "Capture and add", exact: true })
    .click();
  await page.waitForFunction(
    async (rev) =>
      (await window.cutline.invoke("state")).snapshot.project.revision > rev,
    before,
    { timeout: 90000 },
  );
  log("Page screenshot added");

  // The same tool agents use, with a part of the page.
  const readme = await call("cutline_reference", {
    ...guard(await project()),
    kind: "screenshot",
    target: "https://github.com/affaan-m/everything-claude-code",
    selector: "article.markdown-body",
    at: { seconds: 18 },
  });
  log("Agent README capture", readme.title);
  const gemini = await call("cutline_reference", {
    ...guard(await project()),
    kind: "logo",
    target: "Gemini",
    at: { seconds: 21 },
  });
  log("Agent Gemini logo", `${gemini.kind} ${gemini.title}`);

  await resize(1100, 800);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, "1100-vectors.png") });
  const overflow = await page.evaluate(() => {
    const panel = document.querySelector(".vs-studio");
    return panel ? panel.scrollWidth - panel.clientWidth : 0;
  });
  assert(overflow <= 1, `Vector studio overflows by ${overflow}px`);
  log("Narrow window fits");

  // Frames as export renders them.
  const p = await project();
  const frames = [1.5, 4.5, 7.5, 10.5, 13.5, 16.5, 19.5, 22.5].map((s) =>
    Math.round(s * p.fps),
  );
  const sheet = await call("cutline_preview", {
    ...guard(p),
    frames,
    width: 1600,
  });
  for (const [i, item] of sheet._content
    .filter((c) => c.type === "image")
    .entries())
    await writeFile(
      path.join(out, `frames-${i}.jpg`),
      Buffer.from(item.data, "base64"),
    );
  log("Rendered frames", path.join(out, "frames-0.jpg"));
  assert.deepEqual(consoleErrors, [], consoleErrors.join("\n"));
  log("No console errors");
} finally {
  await writeFile(
    path.join(out, "results.json"),
    JSON.stringify({ results, consoleErrors }, null, 2),
  );
  await client?.close().catch(() => {});
  await app.close().catch(() => {});
}
