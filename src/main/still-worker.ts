import { browserOptions } from "../../scripts/browser-config.mjs";
import {
  openBrowser,
  RenderInternals,
  selectComposition,
} from "@remotion/renderer";
import { NoReactInternals } from "remotion/no-react";
import path from "node:path";
import process from "node:process";

type Browser = Awaited<ReturnType<typeof openBrowser>>;
export type StillRequest = {
  type: "render";
  id: string;
  serveUrl: string;
  inputProps: Record<string, unknown>;
  browserExecutable: string;
  frames: number[];
  scale: number;
  outputDirectory: string;
};

let browser: Promise<Browser> | undefined;
let stopping = false;

/** Closes the browser, including one that is still starting. */
async function closeBrowser() {
  const current = browser;
  browser = undefined;
  await current?.then((open) => open.close({ silent: true })).catch(() => {});
}
/**
 * Leaves without leaving Chrome behind. Chrome runs in its own process group,
 * so when closing it hangs this exits anyway after 5 seconds and Remotion's
 * exit handler kills that group.
 */
function shutDown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 5000);
  void closeBrowser().then(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}
// The editor quit, closed this worker after a quiet minute, or stopped it.
process.on("disconnect", shutDown);
process.on("SIGTERM", shutDown);

const serialized = (data: Record<string, unknown>) =>
  NoReactInternals.serializeJSONWithSpecialTypes({
    staticBase: null,
    indent: undefined,
    data,
  }).serializedString;

/**
 * Renders one request's frames with the export's composition, browser and
 * media, so a preview looks exactly like that moment of the exported video.
 * All its frames share one media server, so each source is read once.
 */
async function render(request: StillRequest) {
  const { serveUrl, inputProps, browserExecutable, frames, scale } = request;
  if (stopping) throw Error("Editor disconnected");
  browser ??= openBrowser("chrome", { browserExecutable, ...browserOptions });
  const instance = await browser;
  if (stopping) throw Error("Editor disconnected");
  const composition = await selectComposition({
    serveUrl,
    id: "Cutline",
    inputProps,
    browserExecutable,
    ...browserOptions,
    puppeteerInstance: instance,
    timeoutInMilliseconds: 30000,
  });
  const server = await RenderInternals.prepareServer({
    webpackConfigOrServeUrl: serveUrl,
    port: null,
    remotionRoot: RenderInternals.findRemotionRoot(),
    offthreadVideoThreads: 2,
    logLevel: "info",
    indent: false,
    offthreadVideoCacheSizeInBytes: 256 * 1024 ** 2,
    binariesDirectory: null,
    forceIPv4: false,
    sampleRate: 48000,
  });
  try {
    const props = serialized(inputProps),
      resolved = serialized(composition.props ?? {});
    const files: string[] = [];
    let next = 0;
    // Two pages at a time keep memory low while overlapping media loads.
    const work = async () => {
      while (next < frames.length) {
        if (stopping) throw Error("Editor disconnected");
        const index = next++;
        const output = path.join(request.outputDirectory, `frame-${index}.jpg`);
        await RenderInternals.internalRenderStill({
          composition,
          output,
          frame: Math.min(frames[index], composition.durationInFrames - 1),
          serializedInputPropsWithCustomSchema: props,
          serializedResolvedPropsWithCustomSchema: resolved,
          imageFormat: "jpeg",
          jpegQuality: 82,
          scale,
          overwrite: true,
          puppeteerInstance: instance,
          server,
          serveUrl,
          browserExecutable,
          chromeMode: browserOptions.chromeMode,
          timeoutInMilliseconds: 30000,
          envVariables: {},
          chromiumOptions: {},
          onBrowserLog: null,
          onDownload: null,
          onArtifact: null,
          onBrowserDownload: () => ({ onProgress: () => {}, version: null }),
          onLog: RenderInternals.defaultOnLog,
          cancelSignal: null,
          indent: false,
          port: null,
          logLevel: "info",
          offthreadVideoCacheSizeInBytes: null,
          offthreadVideoThreads: null,
          mediaCacheSizeInBytes: null,
          binariesDirectory: null,
          licenseKey: null,
          isProduction: null,
        });
        files[index] = output;
      }
    };
    await Promise.all([work(), work()]);
    return files;
  } finally {
    await server.closeServer(false).catch(() => {});
  }
}

/**
 * Agent previews, one request at a time. The worker and its browser stay
 * open between requests, so a preview costs no process or Chrome start; the
 * editor closes it after a quiet minute.
 */
let queue = Promise.resolve();
process.on("message", (message: StillRequest) => {
  if (message?.type !== "render") return queue;
  return (queue = queue.then(async () => {
    let reply: Record<string, unknown>;
    try {
      reply = { type: "done", id: message.id, files: await render(message) };
    } catch (error) {
      reply = {
        type: "error",
        id: message.id,
        message: (error as Error).message,
      };
      // A failed browser is not trusted with the next request.
      await closeBrowser();
    }
    if (!stopping && process.connected) process.send?.(reply);
  }));
});
