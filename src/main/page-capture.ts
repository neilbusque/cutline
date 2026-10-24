import { writeFileSync } from "node:fs";
import { BrowserWindow, session } from "electron";

export type PageCaptureOptions = {
  device: "desktop" | "phone";
  /** CSS selector of the part to capture, such as a README or a chart. */
  selector?: string;
  /** Pixels to scroll down before capturing. */
  scroll?: number;
  /** Stops the capture and closes its window. */
  signal?: AbortSignal;
};
/** How long a page may take to load, and the whole capture. */
export const captureLimits = { loadMs: 30_000, totalMs: 60_000 };

const guarded = new WeakSet<Electron.Session>();
const devices = {
  desktop: { width: 1440, height: 900, mobile: false },
  phone: { width: 430, height: 932, mobile: true },
} as const;

/**
 * Screenshots a public web page at 2x in a hidden, sandboxed window with its
 * own empty cookie jar. Cookie banners and sign-in prompts pinned over the
 * page are removed so the product itself shows.
 */
export async function capturePage(
  url: string,
  file: string,
  options: PageCaptureOptions,
): Promise<{ width: number; height: number; title: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw Error("Enter a web address such as github.com/owner/repo.");
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw Error("Screenshots need a web address starting with https://");
  const device = devices[options.device];
  const partition = "reference-capture";
  const jar = session.fromPartition(partition, { cache: false });
  if (!guarded.has(jar)) {
    guarded.add(jar);
    jar.setPermissionRequestHandler((_, __, callback) => callback(false));
    jar.on("will-download", (event) => event.preventDefault());
  }
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: device.width,
    height: device.height,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.setAudioMuted(true);
  // Phones get the mobile layout from their width and a phone browser name.
  // (DevTools emulation crashes Electron on a page that has not loaded yet.)
  if (device.mobile)
    win.webContents.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    );
  let parsedPage = false;
  win.webContents.once("dom-ready", () => (parsedPage = true));
  // A page that blocks its main thread or opens a dialog never answers, so
  // the whole capture has one deadline; closing the window settles whatever
  // was still waiting on it.
  let stop: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => {});
  const deadline = setTimeout(
    () =>
      stop(
        Error(
          `${parsed.host} didn't finish rendering. Try again, or capture another page.`,
        ),
      ),
    captureLimits.totalMs,
  );
  const cancel = () => stop(Error("Cancelled"));
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const work = capture(win, parsed, file, options, () => parsedPage);
  work.catch(() => {});
  try {
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    win.destroy();
    void jar.clearStorageData();
  }
}

async function capture(
  win: BrowserWindow,
  parsed: URL,
  file: string,
  options: PageCaptureOptions,
  parsedPage: () => boolean,
): Promise<{ width: number; height: number; title: string }> {
  let timer: NodeJS.Timeout | undefined;
  const loading = win.loadURL(parsed.toString()).catch((error: Error) => {
    // Chromium's codes (ERR_NAME_NOT_RESOLVED…) mean nothing to people.
    throw Error(
      /NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION|ADDRESS_UNREACHABLE|TIMED_OUT/u.test(
        error.message,
      )
        ? `Couldn't open ${parsed.host}. Check the address and your internet connection.`
        : `${parsed.host} didn't load that page. Check the address, or try the site's home page.`,
    );
  });
  // A load that fails after the timeout already answered is not an error.
  loading.catch(() => {});
  const loaded = await Promise.race([
    loading.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), captureLimits.loadMs);
    }),
  ]).finally(() => clearTimeout(timer));
  // Pages that never finish loading (ads, live updates) are captured as
  // they are once their content is there.
  if (!loaded) {
    if (!parsedPage()) throw Error("The page took too long to load.");
    win.webContents.stop();
  }
  // Late images and web fonts.
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const rect = (await win.webContents.executeJavaScript(
    `(() => {
      const vh = innerHeight;
      for (const el of document.querySelectorAll("body *")) {
        const style = getComputedStyle(el);
        if (!["fixed", "sticky"].includes(style.position)) continue;
        const box = el.getBoundingClientRect();
        const text = (el.innerText || "").slice(0, 400);
        if (box.height < vh * 0.9 && /cookie|consent|privacy|accept all|sign up to|log in to|get the app|open in app/i.test(text))
          el.remove();
      }
      // Fundraising and site notices that sit in the page, not over it.
      for (const el of document.querySelectorAll("#siteNotice, #centralNotice, .frb, .cn-fundraising, [id^=frb-], .mw-dismissable-notice"))
        el.remove();
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, ${Math.max(0, Math.round(options.scroll ?? 0))});
      const target = ${JSON.stringify(options.selector ?? "")};
      if (!target) return null;
      const el = document.querySelector(target);
      if (!el) return { missing: true };
      el.scrollIntoView({ block: "start" });
      const box = el.getBoundingClientRect();
      const top = Math.max(0, box.top);
      return { x: Math.max(0, box.left), y: top, width: Math.min(box.width, innerWidth), height: Math.min(box.bottom, vh) - top };
    })()`,
    true,
  )) as
    | null
    | { missing: true }
    | { x: number; y: number; width: number; height: number };
  if (rect && "missing" in rect)
    throw Error(`Nothing on the page matches ${options.selector}.`);
  // Let the hidden window paint the scrolled page before it is captured.
  await win.webContents.executeJavaScript(
    "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const area =
    rect && rect.width > 10 && rect.height > 10
      ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : undefined;
  const image = await win.webContents.capturePage(area);
  const bytes = image.toPNG();
  if (image.isEmpty() || bytes.length < 2000)
    throw Error("The page came out blank. Try again or use the phone view.");
  writeFileSync(file, bytes);
  const title = (await win.webContents.executeJavaScript(
    "document.title",
    true,
  )) as string;
  const size = image.getSize();
  return {
    width: size.width,
    height: size.height,
    title: String(title || parsed.host).slice(0, 100),
  };
}
