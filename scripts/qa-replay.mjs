import { _electron as electron } from "@playwright/test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
const root = process.cwd(),
  work = path.resolve("../../work");
const env = {
  ...process.env,
  CUTLINE_QA: "1",
  CUTLINE_DATA_DIR: path.join(work, "qa-replay-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.join(
    root,
    "release/Cutline-darwin-arm64/Cutline.app/Contents/MacOS/Cutline",
  ),
  args: [path.join(work, "final-project.cutline")],
  env,
});
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.stack));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text());
  });
  await page.waitForSelector(".titlebar");
  const invoke = (name, args) =>
    page.evaluate(({ name, args }) => window.cutline.invoke(name, args), {
      name,
      args,
    });
  let p = (await invoke("state")).snapshot.project;
  console.log("OPEN", p.clips.length, p.revision);
  const title = p.clips.find((c) => c.kind === "text");
  await page.locator(".timeline-clip.text").first().click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  for (let i = 0; i < 3; i++) {
    p = (await invoke("state")).snapshot.project;
    await invoke("edit", {
      projectId: p.id,
      revision: p.revision,
      label: "replay",
      commands: [
        {
          type: "clip.update",
          id: title.id,
          patch: { text: "Edited while rendering" },
        },
      ],
    });
    await invoke("undo");
    await new Promise((r) => setTimeout(r, 100));
    console.log("DOM", i, await page.locator(".ruler").count());
  }
  await page.locator(".ruler").click({ position: { x: 90 * 0.85, y: 12 } });
  await new Promise((r) => setTimeout(r, 500));
  await page
    .locator(".canvas")
    .screenshot({ path: "screenshots/preview-frame-90.png" });
  await page.screenshot({ path: "screenshots/05-final.png" });
  console.log("Replay passed");
} finally {
  await app.close();
}
