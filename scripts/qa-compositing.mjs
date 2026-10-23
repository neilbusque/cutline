import { _electron as electron } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const root = process.cwd(),
  work = path.resolve("../../work");
const fixture = JSON.parse(
  await readFile(path.join(work, "qa-transitions.cutline"), "utf8"),
);
fixture.project.clips = fixture.project.clips.map((c) => ({
  ...c,
  start: 0,
  duration: 60,
  transition: undefined,
  keyframes: [],
  animationOffset: 0,
}));
const blue = fixture.project.clips[1];
Object.assign(blue, {
  x: 160,
  y: 90,
  width: 320,
  height: 180,
  mask: "ellipse",
  scale: 1,
  shadowBlur: 12,
  keyframes: [
    { property: "scale", frame: 0, value: 0.5, easing: "linear" },
    { property: "scale", frame: 30, value: 1, easing: "linear" },
  ],
});
fixture.past = [];
fixture.future = [];
const file = path.join(work, "compositing.cutline");
await writeFile(file, JSON.stringify(fixture));
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "qa-compositing-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.join(
    root,
    "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline",
  ),
  args: ["--force-color-profile=srgb", file],
  env,
});
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
function raw(args, input) {
  const r = spawnSync(ffmpeg, ["-v", "error", ...args], {
    input,
    maxBuffer: 5000000,
  });
  assert.equal(r.status, 0, r.stderr.toString());
  return r.stdout;
}
const pixel = (b, x, y) => [
  ...b.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3),
];
const results = [];
try {
  const page = await app.firstWindow();
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  await page
    .getByRole("button", { name: "video clip blue.mp4", exact: true })
    .click();
  await page.getByText("Compositing", { exact: true }).click();
  assert.equal(
    await page.getByLabel("Mask", { exact: true }).inputValue(),
    "ellipse",
  );
  for (const mode of ["normal", "multiply"]) {
    if (!(await page.getByLabel("Blend mode", { exact: true }).isVisible()))
      await page.getByText("Compositing", { exact: true }).click();
    await page.getByLabel("Blend mode", { exact: true }).selectOption(mode);
    await page
      .getByRole("button", { name: "Go to start", exact: true })
      .click();
    await page.keyboard.press("Escape");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+ArrowRight");
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(500);
    const preview = raw(
      [
        "-i",
        "pipe:0",
        "-vf",
        "scale=320:180",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      await page.locator(".canvas").screenshot(),
    );
    const out = path.join(work, `compositing-${mode}.mp4`),
      job = await invoke("test.export", { path: out });
    let done = false;
    for (let i = 0; i < 120; i++) {
      const j = (await invoke("state")).jobs.find((j) => j.id === job.id);
      if (j.state === "error") throw Error(j.message);
      if (j.state === "done") {
        done = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    assert(done);
    const rendered = raw([
      "-i",
      out,
      "-vf",
      "select=eq(n\\,30),scale=320:180",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const coordinates = [
      [160, 90],
      [85, 48],
      [10, 90],
    ];
    const samples = coordinates.map(([x, y]) => ({
      preview: pixel(preview, x, y),
      export: pixel(rendered, x, y),
    }));
    for (const s of samples)
      for (let i = 0; i < 3; i++)
        assert(
          Math.abs(s.preview[i] - s.export[i]) < 15,
          JSON.stringify(samples),
        );
    assert(
      samples[1].export[0] > 220 && samples[2].export[0] > 220,
      "Ellipse preserves corners/background",
    );
    if (mode === "normal") assert(samples[0].export[2] > 220, "Center blue");
    else
      assert(
        Math.max(...samples[0].export) < 12,
        "Multiply blends with lower red layer",
      );
    results.push({ mode, samples });
    await page
      .getByRole("button", { name: "video clip blue.mp4", exact: true })
      .click();
  }
  await writeFile(
    "qa-compositing-results.json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  await app.close();
}
