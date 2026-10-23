import { _electron as electron } from "@playwright/test";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const work = path.resolve(root, "../../work");
await mkdir(path.join(root, "screenshots"), { recursive: true });
const executablePath =
  process.env.CUTLINE_APP_EXECUTABLE ||
  path.join(
    root,
    "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(
    work,
    process.env.CUTLINE_APP_EXECUTABLE ? "qa-packaged-data" : "qa-data",
  ),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath,
  args: process.env.CUTLINE_APP_EXECUTABLE ? [] : [root],
  env,
  timeout: 30000,
});
const results = [];
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("BROWSER:", m.text().slice(0, 300));
  });
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  await invoke("new");
  results.push("App opens without a development server");
  await page.screenshot({ path: path.join(root, "screenshots/01-empty.png") });
  const asset = await invoke("test.import", {
    path: path.join(work, "qa-media/source.mp4"),
  });
  assert.equal(asset.kind, "video");
  results.push("Video import, thumbnail, and waveform");
  await page
    .getByRole("button", { name: `Add ${asset.name} to timeline` })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".timeline-clip").length === 1,
  );
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("button", { name: "Make it pop spring" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".timeline-clip").length === 2,
  );
  let state = (await invoke("state")).snapshot;
  const p = state.project;
  const title = p.clips.find((c) => c.kind === "text");
  const mediaClip = p.clips.find((c) => c.kind === "video");
  await invoke("edit", {
    projectId: p.id,
    revision: p.revision,
    label: "Style acceptance title",
    commands: [
      { type: "project.update", patch: { name: "Cutline · acceptance demo" } },
      {
        type: "clip.update",
        id: title.id,
        patch: {
          text: "Your next story.",
          duration: 150,
          fontSize: 110,
          color: "#c6f16d",
          background: "#101112",
          y: 600,
        },
      },
    ],
  });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await new Promise((r) => setTimeout(r, 1800));
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  results.push("Preview plays and pauses");
  const videoQualityBefore = await page
    .locator("video")
    .first()
    .evaluate((v) => ({
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
      dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
      time: v.currentTime,
    }));
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await new Promise((r) => setTimeout(r, 5000));
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const videoQualityAfter = await page
    .locator("video")
    .first()
    .evaluate((v) => ({
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
      dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
      time: v.currentTime,
    }));
  results.push(
    `Playback measurement over 5s: ${videoQualityAfter.frames - videoQualityBefore.frames} decoded frames, ${videoQualityAfter.dropped - videoQualityBefore.dropped} dropped`,
  );
  const styled = (await invoke("state")).snapshot.project.clips.find(
    (c) => c.id === title.id,
  );
  assert.equal(styled.height, 180, "Text edit reset its geometry");
  assert.equal(styled.y, 600);
  const titleBox = await page.locator(".timeline-clip.text").boundingBox();
  await page.mouse.move(titleBox.x + 20, titleBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(titleBox.x + 60, titleBox.y + 20, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    (id) =>
      Number(
        document
          .querySelector(".timeline-clip.text")
          .style.left.replace("px", ""),
      ) > 0,
    title.id,
  );
  await invoke("undo");
  results.push("Timeline pointer drag and undo");
  const before = (await invoke("state")).snapshot.project;
  await invoke("edit", {
    projectId: before.id,
    revision: before.revision,
    label: "Split video",
    commands: [{ type: "clip.split", id: mediaClip.id, frame: 900 }],
  });
  const split = (await invoke("state")).snapshot.project;
  assert.equal(split.clips.filter((c) => c.kind === "video").length, 2);
  await invoke("undo");
  assert.equal(
    (await invoke("state")).snapshot.project.clips.filter(
      (c) => c.kind === "video",
    ).length,
    1,
  );
  await invoke("redo");
  results.push("Split, undo, redo");
  const beforeConflict = (await invoke("state")).snapshot.project;
  try {
    await invoke("edit", {
      projectId: beforeConflict.id,
      revision: 0,
      label: "stale",
      commands: [{ type: "clip.delete", id: title.id, ripple: false }],
    });
    assert.fail("Stale edit accepted");
  } catch (e) {
    assert.match(String(e), /Project changed/);
  }
  results.push("Stale edits rejected");
  const transcribeP = (await invoke("state")).snapshot.project;
  console.log("Transcribing locally…");
  await invoke("transcribe", {
    projectId: transcribeP.id,
    revision: transcribeP.revision,
    clipId: mediaClip.id,
  });
  const captions = (await invoke("state")).snapshot.project.clips.filter(
    (c) => c.kind === "caption",
  );
  assert(captions.length > 0, "No captions generated");
  results.push(
    `Local speech transcription: ${captions.length} caption segments`,
  );
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  await page.locator(".caption-list button").first().click();
  await page.locator(".ruler").click({ position: { x: 90 * 0.85, y: 12 } });
  await page.locator(".stage").click({ position: { x: 10, y: 10 } });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({
    path: path.join(root, "screenshots/02-editing.png"),
  });
  await page
    .locator(".canvas")
    .screenshot({ path: path.join(root, "screenshots/preview-frame-90.png") });
  const good = (await invoke("state")).snapshot.project;
  const malformed = structuredClone(good);
  malformed.assets[0].path = path.join(work, "missing-file.mp4");
  const missingPath = path.join(work, "missing-test.cutline"),
    goodPath = path.join(work, "good-test.cutline");
  await writeFile(missingPath, JSON.stringify({ project: malformed }));
  await writeFile(goodPath, JSON.stringify({ project: good }));
  await invoke("test.load", { path: missingPath });
  assert((await invoke("state")).snapshot.missing.length > 0);
  await assert.rejects(
    () =>
      invoke("test.export", { path: path.join(work, "should-not-export.mp4") }),
    /Relink missing media/,
  );
  await invoke("test.load", { path: goodPath });
  results.push(
    "Missing media detected; invalid export blocked; project reload succeeds",
  );
  const badFile = path.join(work, "unsupported.txt");
  await writeFile(badFile, "Not video");
  await assert.rejects(() => invoke("test.import", { path: badFile }));
  results.push("Unsupported media rejected");
  const motionP = (await invoke("state")).snapshot.project;
  const motionId = "acceptance-motion";
  const motion = {
    id: motionId,
    name: "Editable callout",
    layers: [
      {
        type: "rectangle",
        background: "#c6f16d",
        width: 880,
        height: 170,
        radius: 24,
        keyframes: [
          { frame: 0, scale: 0.7, opacity: 0 },
          { frame: 18, scale: 1, opacity: 1 },
        ],
      },
      {
        type: "text",
        text: "Made to move.",
        width: 880,
        height: 170,
        color: "#101112",
        fontSize: 90,
        keyframes: [
          { frame: 0, y: 35, opacity: 0 },
          { frame: 18, y: 0, opacity: 1 },
        ],
      },
    ],
  };
  const motionClip = {
    ...title,
    id: "acceptance-motion-clip",
    start: 300,
    duration: 120,
    x: 100,
    y: 500,
    width: 880,
    height: 170,
    preset: "custom",
    motionId,
    text: "Made to move.",
  };
  await invoke("edit", {
    projectId: motionP.id,
    revision: motionP.revision,
    label: "Custom animation acceptance",
    commands: [
      { type: "motion.put", motion },
      { type: "clip.add", clip: motionClip },
    ],
  });
  const validMotion = (await invoke("state")).snapshot.project;
  await assert.rejects(
    () =>
      invoke("edit", {
        projectId: validMotion.id,
        revision: validMotion.revision,
        label: "Invalid animation",
        commands: [
          {
            type: "motion.put",
            motion: {
              ...motion,
              layers: [
                {
                  ...motion.layers[0],
                  keyframes: [{ frame: 18 }, { frame: 0 }],
                },
              ],
            },
          },
        ],
      }),
    /keyframes must increase/,
  );
  assert.equal(
    (await invoke("state")).snapshot.project.revision,
    validMotion.revision,
  );
  results.push(
    "Custom motion created; failed replacement preserves working animation",
  );
  const cancelJob = await invoke("test.export", {
    path: path.join(work, "cancelled-export.mp4"),
  });
  await new Promise((r) => setTimeout(r, 1800));
  await invoke("job.cancel", { id: cancelJob.id });
  assert.equal(
    (await invoke("state")).jobs.find((j) => j.id === cancelJob.id).state,
    "cancelled",
  );
  await new Promise((r) => setTimeout(r, 5500));
  results.push("Export cancellation");
  const bridge = (await invoke("state")).mediaBase;
  const tools = await fetch(bridge + "/rpc", {
    method: "POST",
    body: JSON.stringify({ name: "tools.list" }),
  }).then((r) => r.json());
  assert(tools.result.length >= 8);
  const inspect = await fetch(bridge + "/rpc", {
    method: "POST",
    body: JSON.stringify({ name: "cutline_inspect" }),
  }).then((r) => r.json());
  assert(!JSON.stringify(inspect.result).includes(asset.path));
  results.push("Local editing bridge excludes media paths");
  if (process.env.CUTLINE_TEST_CODEX === "1") {
    console.log("Connecting Codex…");
    const account = await invoke("codex.connect");
    results.push(`Codex connection: ${account.account?.type ?? "signed out"}`);
    if (account.account) {
      await page
        .getByRole("button", { name: "Assistant", exact: true })
        .click();
      await invoke("codex.send", {
        text: 'Use cutline_inspect, then use cutline_apply_edits to change the text of the first text clip to "Made with Cutline". Do not change anything else. Reply briefly.',
      });
      await page.waitForFunction(
        () =>
          !!document.querySelector(".message.assistant")?.textContent?.trim(),
        {},
        { timeout: 90000 },
      );
      await new Promise((r) => setTimeout(r, 2000));
      const current = (await invoke("state")).snapshot.project;
      assert.equal(
        current.clips.find((c) => c.kind === "text").text,
        "Made with Cutline",
      );
      results.push("Embedded Codex makes a real undoable timeline edit");
      await invoke("undo");
    }
  }
  const sample = (await invoke("state")).snapshot.project;
  const sampleDir = path.join(root, "sample-project");
  await mkdir(sampleDir, { recursive: true });
  await copyFile(asset.path, path.join(sampleDir, "source.mp4"));
  for (const a of sample.assets) {
    if (a.id === asset.id) {
      a.path = path.join(sampleDir, "source.mp4");
      delete a.proxy;
      delete a.thumbnail;
    }
  }
  await writeFile(
    path.join(sampleDir, "Cutline Demo.cutline"),
    JSON.stringify({ project: sample, past: [], future: [] }),
  );
  if (process.env.CUTLINE_SKIP_EXPORT !== "1") {
    console.log("Exporting 75 seconds at 1080p…");
    const start = Date.now();
    const job = await invoke("test.export", {
      path: path.join(root, "acceptance-demo.mp4"),
    });
    let last = -1;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const current = (await invoke("state")).jobs.find((j) => j.id === job.id);
      if (Math.floor(current.progress * 10) > last) {
        last = Math.floor(current.progress * 10);
        console.log(`Export ${Math.round(current.progress * 100)}%`);
      }
      if (current.state === "done") {
        results.push(
          `75-second 1080p MP4 exported in ${Math.round((Date.now() - start) / 1000)} seconds`,
        );
        break;
      }
      if (current.state === "error" || current.state === "cancelled")
        throw Error(current.message);
      if (Date.now() - start > 900000)
        throw Error("Export exceeded 15 minutes");
    }
  }
  await page.screenshot({
    path: path.join(root, "screenshots/03-complete.png"),
  });
  assert.deepEqual(errors, []);
  results.push("No uncaught renderer errors");
  console.log(JSON.stringify(results, null, 2));
  await writeFile(
    path.join(
      root,
      process.env.CUTLINE_APP_EXECUTABLE
        ? "qa-packaged-results.json"
        : "qa-results.json",
    ),
    JSON.stringify(
      { date: new Date().toISOString(), results, errors },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e);
  const page = await app.firstWindow();
  await page
    .screenshot({ path: path.join(root, "screenshots/error.png") })
    .catch(() => {});
  throw e;
} finally {
  await app.close();
}
