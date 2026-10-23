import { browserOptions } from "../../scripts/browser-config.mjs";
import {
  openBrowser,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import path from "node:path";
import process from "node:process";

let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
let closing: Promise<void> | undefined;
let disconnected = false;
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
const closeBrowser = () => {
  if (!browser) return Promise.resolve();
  return (closing ??= browser.close({ silent: true }).catch(() => {}));
};
const exitDisconnected = () => {
  clearTimeout(shutdownTimer);
  process.exit(1);
};
process.once("disconnect", () => {
  disconnected = true;
  // renderStills forks this worker detached. Bound shutdown even if Chrome hangs,
  // and stop its process group rather than leaving Chrome after the editor exits.
  shutdownTimer = setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  }, 5000);
  shutdownTimer.unref();
  if (browser) void closeBrowser().then(exitDisconnected);
});

/**
 * Renders preview frames for agents with the export's composition, browser and
 * media, so a preview looks exactly like that moment of the exported video.
 * One request per process; it exits when done.
 */
process.once("message", async (message: any) => {
  let reply: Record<string, unknown>;
  try {
    const { serveUrl, inputProps, browserExecutable, frames, scale } = message;
    browser = await openBrowser("chrome", {
      browserExecutable,
      ...browserOptions,
    });
    if (disconnected) throw Error("Editor disconnected");
    const composition = await selectComposition({
      serveUrl,
      id: "Cutline",
      inputProps,
      browserExecutable,
      ...browserOptions,
      puppeteerInstance: browser,
      timeoutInMilliseconds: 30000,
    });
    const files: string[] = [];
    let next = 0;
    // Two pages at a time keep memory low while overlapping media loads.
    const work = async () => {
      while (next < frames.length) {
        if (disconnected) throw Error("Editor disconnected");
        const index = next++;
        const output = path.join(message.outputDirectory, `frame-${index}.jpg`);
        await renderStill({
          serveUrl,
          composition,
          inputProps,
          frame: Math.min(frames[index], composition.durationInFrames - 1),
          output,
          imageFormat: "jpeg",
          jpegQuality: 82,
          scale,
          overwrite: true,
          browserExecutable,
          ...browserOptions,
          puppeteerInstance: browser,
          timeoutInMilliseconds: 30000,
        });
        files[index] = output;
      }
    };
    await Promise.all([work(), work()]);
    reply = { type: "done", files };
  } catch (error) {
    reply = { type: "error", message: (error as Error).message };
  }
  await closeBrowser();
  if (disconnected || !process.connected) exitDisconnected();
  else if (process.send)
    process.send(reply, (error) => process.exit(error ? 1 : 0));
  else process.exit(0);
});
