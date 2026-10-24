import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// Builds the same planned Short in each creator style from a real speaker
// recording and its subtitles, then renders frames (and optionally an MP4)
// the way export does. Needs the network for logos and page screenshots.
//   CUTLINE_STYLE_SPEAKER=<video> CUTLINE_STYLE_SRT=<srt> node scripts/qa-style-reel.mjs
const root = process.cwd();
const packaged = process.env.CUTLINE_PACKAGED !== "0";
const speaker = process.env.CUTLINE_STYLE_SPEAKER;
const srtFile = process.env.CUTLINE_STYLE_SRT;
assert(speaker && srtFile, "Set CUTLINE_STYLE_SPEAKER and CUTLINE_STYLE_SRT.");
const out = path.resolve(
  process.env.CUTLINE_STYLE_QA_RESULTS ?? path.join(root, "../qa-style-reel"),
);
await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(out, "run-"));
const data = path.join(work, "user-data");
const env = { ...process.env, CUTLINE_QA: "1", CUTLINE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const executable = packaged
  ? path.join(
      process.env.CUTLINE_APP ?? "/Applications/Cutline.app",
      "Contents/MacOS/Cutline",
    )
  : path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const styles = (process.env.CUTLINE_STYLES ?? "split,cards,locked-split").split(
  ",",
);
const exportStyle = process.env.CUTLINE_STYLE_EXPORT;

// The Slop Monster script, planned as an assistant would from the transcript.
const beats = [
  { from: 0.07, to: 2.33, kind: "text", show: "Deletes AI slop" },
  {
    from: 2.33,
    to: 4.03,
    layout: "full",
    kind: "text",
    show: "Every trace of AI slop",
  },
  { from: 4.03, to: 5.27, kind: "text", show: "From any text" },
  { from: 5.27, to: 8.33, layout: "full", kind: "logo", show: "GitHub" },
  { from: 8.33, to: 10.33, layout: "face" },
  {
    from: 10.33,
    to: 14.73,
    kind: "page",
    show: "https://en.wikipedia.org/wiki/AI_slop",
  },
  { from: 14.73, to: 17.83, kind: "logo", show: "Gmail" },
  { from: 17.83, to: 20.23, layout: "face" },
  {
    from: 20.23,
    to: 23.53,
    layout: "full",
    kind: "text",
    show: "Flags it, then rewrites it",
  },
  { from: 23.53, to: 29.03, kind: "page", show: "https://github.com/trending" },
  { from: 29.07, to: 31.2, layout: "face" },
  {
    from: 31.2,
    to: 35.37,
    layout: "full",
    kind: "text",
    show: "Marketing and sales copy",
  },
];
// CUTLINE_STYLE_DRAW=1 swaps three text beats for drawn illustrations.
if (process.env.CUTLINE_STYLE_DRAW === "1") {
  beats[0] = {
    ...beats[0],
    kind: "draw",
    show: "A friendly green monster eating buzzword stickers",
  };
  beats[8] = {
    ...beats[8],
    kind: "draw",
    show: "A red pen striking through a sentence and rewriting it",
  };
  beats[11] = {
    ...beats[11],
    kind: "draw",
    show: "A megaphone with a sales chart rising",
  };
}
const frames = [1, 3, 4.6, 6.5, 9, 12, 16, 19, 22, 26, 33, 37].map((s) =>
  Math.round(s * 30),
);

const results = [];
const app = await electron.launch({
  executablePath: executable,
  args: packaged ? ["--use-mock-keychain"] : [root, "--use-mock-keychain"],
  env,
});
let client;
try {
  const page = await app.firstWindow({ timeout: 90000 });
  await page.waitForSelector(".titlebar");
  const settings = (await page.evaluate(() => window.cutline.invoke("state")))
    .settings;
  client = new Client({ name: "cutline-style-qa", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: settings.mcpLauncher,
      args: [],
      env: { ...env, CUTLINE_CONNECTION: path.join(data, "connection.json") },
      stderr: "pipe",
    }),
  );
  let revision = 0,
    projectId;
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    assert(!response.isError, `${name}: ${text}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
    if (typeof json.revision === "number") revision = json.revision;
    return { ...json, _content: response.content };
  };
  const guard = () => ({ projectId, revision });
  const srt = await readFile(srtFile, "utf8");
  for (const style of styles) {
    const current = await call("cutline_inspect");
    const fresh = await call("cutline_new_project", {
      projectId: current.id,
      revision: current.revision,
      name: `Style QA ${style}`,
    });
    projectId = fresh.id;
    revision = fresh.revision;
    await call("cutline_edit", {
      ...guard(),
      label: "Reel canvas",
      actions: [
        { type: "project.update", patch: { width: 1080, height: 1920 } },
      ],
    });
    const imported = await call("cutline_import_media", {
      ...guard(),
      paths: [speaker],
    });
    await call("cutline_edit", {
      ...guard(),
      label: "Speaker",
      actions: [
        {
          type: "clip.add",
          kind: "video",
          assetId: imported.importedAssetIds[0],
          at: { frame: 0 },
        },
      ],
    });
    await call("cutline_caption_srt", { ...guard(), srt });
    const started = Date.now();
    // Long work (drawings, page captures) comes back as a job to wait on.
    let built = await call("cutline_style_reel", { ...guard(), style, beats });
    while (built.state === "running" && built.jobId) {
      const listed = await call("cutline_jobs", {
        id: built.jobId,
        waitSeconds: 30,
      });
      const job = listed[0] ?? (listed.jobs ?? [listed])[0];
      assert(!["error", "cancelled"].includes(job.state), JSON.stringify(job));
      if (job.state === "done") {
        built = job.result;
        revision = built.revision;
      }
    }
    results.push({
      style,
      seconds: Math.round((Date.now() - started) / 1000),
      beats: built.beats,
      warnings: built.warnings,
    });
    console.log(
      `✓ ${style}: ${built.beats} beats, ${built.speakerPieces} speaker cuts`,
      built.warnings.length ? built.warnings : "",
    );
    const sheet = await call("cutline_preview", {
      ...guard(),
      frames,
      width: 1800,
    });
    const image = sheet._content.find((item) => item.type === "image");
    await writeFile(
      path.join(out, `${style}.jpg`),
      Buffer.from(image.data, "base64"),
    );
    if (exportStyle === style) {
      const file = path.join(out, `${style}.mp4`);
      const job = await call("cutline_export", { ...guard(), path: file });
      let state = job;
      for (let i = 0; i < 60 && state.state !== "done"; i++) {
        state = await call("cutline_jobs", {
          id: job.jobId ?? job.id,
          waitSeconds: 30,
        });
        assert(
          state.state !== "error" && state.state !== "cancelled",
          JSON.stringify(state),
        );
      }
      console.log(`✓ exported ${file}`);
    }
  }
} finally {
  await writeFile(
    path.join(out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await client?.close().catch(() => {});
  await app.close().catch(() => {});
}
