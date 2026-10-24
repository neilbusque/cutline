import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { findClaude } from "./claude";
import {
  editableSvgMarkup,
  parseEditableSvg,
  withViewBox,
} from "../shared/vector-path";

/**
 * Vector generation through the assistants already signed in on this Mac, and
 * references (brand logos, page screenshots) for videos that name real tools.
 */

function cliEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[key];
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  const home = os.homedir();
  env.PATH = [
    env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
  ]
    .filter(Boolean)
    .join(":");
  return env;
}

function run(
  bin: string,
  args: string[],
  input: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) {
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) return reject(Error("Cancelled"));
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: cliEnv(),
      stdio: "pipe",
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        Error(
          "The assistant took too long. Try again or simplify the request.",
        ),
      );
    }, options.timeoutMs);
    const abort = () => {
      child.kill();
      reject(Error("Cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-4000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (code === 0) return resolve(out);
      // Claude Code reports most failures as JSON on stdout, not stderr.
      let reported = "";
      for (const line of out.trim().split("\n").reverse())
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.result === "string") {
            reported = parsed.result;
            break;
          }
        } catch {
          /* not a JSON line */
        }
      reject(
        Error(
          assistantError(
            reported ||
              err.trim().split("\n").at(-1) ||
              `The assistant stopped (exit ${code}).`,
          ),
        ),
      );
    });
    child.stdin.end(input);
  });
}

/** What to do about a failed assistant call, in plain words. */
export function assistantError(text: string) {
  if (/does not support this model|or newer is required|out of date/iu.test(text))
    return "Claude Code is out of date. Run `claude update` in Terminal, then try again.";
  if (/log ?in|sign in|auth|unauthori[sz]ed/iu.test(text))
    return "Claude needs you to sign in. Run `claude auth login` in Terminal.";
  if (/usage limit|limit reached|rate limit|quota/iu.test(text))
    return "The assistant's usage limit is reached. Try again later or choose the other assistant.";
  return text;
}

export function findCodex() {
  return (
    process.env.CUTLINE_CODEX_PATH ||
    [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex",
    ].find(existsSync)
  );
}

/**
 * A one-shot, tool-free question to the signed-in Claude Code or ChatGPT
 * (Codex). An image (PNG) is shown to the model with the prompt.
 */
export function assistantAsker(
  provider: "claude" | "chatgpt",
  options: {
    workDir: string;
    signal?: AbortSignal;
    claudeModel?: "opus" | "sonnet";
    /** Thinking effort; drawings need medium, not the slow default. */
    effort?: "low" | "medium" | "high";
  },
) {
  mkdirSync(options.workDir, { recursive: true });
  return async (system: string, prompt: string, image?: Uint8Array) => {
    if (provider === "claude") {
      const bin = findClaude();
      if (!bin)
        throw Error(
          "Claude Code isn't installed. Install it from claude.com/code and sign in once, or choose ChatGPT.",
        );
      // Images travel as a stream-json message; Claude Code reads it only
      // from a pipe, which is how run() feeds stdin.
      const out = await run(
        bin,
        [
          "-p",
          ...(image
            ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
            : ["--output-format", "json"]),
          "--model",
          options.claudeModel ?? "opus",
          ...(options.effort ? ["--effort", options.effort] : []),
          "--tools",
          "",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--system-prompt",
          system,
        ],
        image
          ? JSON.stringify({
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: Buffer.from(image).toString("base64"),
                    },
                  },
                  { type: "text", text: prompt },
                ],
              },
            }) + "\n"
          : prompt,
        { cwd: options.workDir, timeoutMs: 240000, signal: options.signal },
      );
      let parsed: { result?: string; is_error?: boolean };
      try {
        parsed = image
          ? JSON.parse(
              out
                .trim()
                .split("\n")
                .reverse()
                .find((line) => line.includes('"type":"result"')) ?? "",
            )
          : JSON.parse(out);
      } catch {
        throw Error("Claude returned an unreadable reply. Try again.");
      }
      if (parsed.is_error || !parsed.result)
        throw Error(assistantError(parsed.result ?? "Claude could not answer."));
      return parsed.result;
    }
    const bin = findCodex();
    if (!bin)
      throw Error(
        "ChatGPT's Codex isn't installed. Install the ChatGPT app and sign in, or choose Claude.",
      );
    const dir = mkdtempSync(path.join(options.workDir, "codex-"));
    try {
      const answer = path.join(dir, "answer.txt");
      const picture = path.join(dir, "render.png");
      if (image) writeFileSync(picture, image);
      await run(
        bin,
        [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "-s",
          "read-only",
          "-c",
          "mcp_servers={}",
          "-c",
          'web_search="disabled"',
          "-c",
          "features.shell_tool=false",
          ...(options.effort
            ? ["-c", `model_reasoning_effort="${options.effort}"`]
            : []),
          "-o",
          answer,
          // The prompt comes from stdin; --image takes the values after it.
          "-",
          ...(image ? ["--image", picture] : []),
        ],
        `${system}\n\nDo not run commands or create files.\n\n${prompt}`,
        { cwd: dir, timeoutMs: 240000, signal: options.signal },
      );
      if (!existsSync(answer))
        throw Error(
          "ChatGPT did not answer. Check you are signed in to the ChatGPT app.",
        );
      return readFileSync(answer, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Density that rasterizes a board whose longer side is `side` units at `pixels`. */
const densityFor = (side: number, pixels: number) =>
  Math.min(2400, Math.max(8, (72 * pixels) / Math.max(1, side)));

/**
 * A drawing exactly as Cutline will draw it (its imported layers, on the
 * vector preview's neutral board), for the assistant to look at its work.
 */
export async function renderSvg(
  svg: string,
  background = "#f4f3ef",
  size = 768,
) {
  const sharp = (await import("sharp")).default;
  const parsed = parseEditableSvg(svg);
  const [, , w, h] = parsed.viewBox;
  return sharp(Buffer.from(editableSvgMarkup(parsed, background)), {
    density: densityFor(Math.max(w, h), size),
  })
    .resize(size, size, { fit: "inside" })
    .png()
    .toBuffer();
}

/**
 * The drawing's art board shrunk to what is actually drawn plus 8% air, so
 * every drawing places at the same visual size and stays centered however
 * much empty board the model left.
 */
export async function fitSvg(svg: string): Promise<string> {
  const sharp = (await import("sharp")).default;
  const parsed = parseEditableSvg(svg);
  const [x, y, w, h] = parsed.viewBox;
  const scale = 512 / Math.max(w, h);
  const { info } = await sharp(Buffer.from(editableSvgMarkup(parsed)), {
    density: densityFor(Math.max(w, h), 512),
  })
    .trim({ threshold: 1 })
    .toBuffer({ resolveWithObject: true });
  const left = -(info.trimOffsetLeft ?? 0) / scale,
    top = -(info.trimOffsetTop ?? 0) / scale;
  const width = info.width / scale,
    height = info.height / scale;
  // Nothing to gain on a board the drawing already fills.
  if (width >= w * 0.97 && height >= h * 0.97) return svg;
  const pad = Math.max(width, height) * 0.08;
  return withViewBox(svg, [
    x + left - pad,
    y + top - pad,
    width + pad * 2,
    height + pad * 2,
  ]);
}

/* ------------------------------------------------------------------------ */
/* Brand logos                                                               */
/* ------------------------------------------------------------------------ */

// Pinned so a logo looks the same on every run. Simple Icons is CC0; the marks
// stay their owners' trademarks, fine for referring to a product in a video.
const SIMPLE_ICONS = "https://cdn.jsdelivr.net/npm/simple-icons@16.35.0";
type IconRecord = {
  title: string;
  slug?: string;
  hex: string;
  aliases?: {
    aka?: string[];
    dup?: { title: string }[];
    loc?: Record<string, string>;
  };
};
const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/gu, "");
const slugOf = (record: IconRecord) =>
  record.slug ??
  normalize(
    record.title
      .replace(/\+/gu, "plus")
      .replace(/\./gu, "dot")
      .replace(/&/gu, "and"),
  );

/** Products whose marks Simple Icons doesn't carry: use their site's own icon. */
const brandSites: Record<string, string> = {
  chatgpt: "chatgpt.com",
  openai: "openai.com",
  gpt: "chatgpt.com",
  codex: "chatgpt.com",
  sora: "sora.chatgpt.com",
  linkedin: "linkedin.com",
  slack: "slack.com",
  microsoft: "microsoft.com",
  copilot: "copilot.microsoft.com",
  vscode: "code.visualstudio.com",
  visualstudiocode: "code.visualstudio.com",
  lovable: "lovable.dev",
  midjourney: "midjourney.com",
  gohighlevel: "gohighlevel.com",
  highlevel: "gohighlevel.com",
  canva: "canva.com",
  heygen: "heygen.com",
  higgsfield: "higgsfield.ai",
  manus: "manus.im",
  bolt: "bolt.new",
  v0: "v0.app",
  grok: "grok.com",
  kling: "klingai.com",
  gamma: "gamma.app",
  descript: "descript.com",
  opusclip: "opus.pro",
  capcut: "capcut.com",
  runway: "runwayml.com",
  pika: "pika.art",
  notebooklm: "notebooklm.google",
  napkin: "napkin.ai",
  synthesia: "synthesia.io",
  tella: "tella.tv",
};
const iconAliases: Record<string, string> = {
  claudecode: "claude",
  claudeai: "claude",
  gemini: "googlegemini",
  googleai: "googlegemini",
  twitter: "x",
  meta: "meta",
  facebookads: "facebook",
  ig: "instagram",
  yt: "youtube",
};

export type BrandLogo = (
  | {
      kind: "vector";
      svg: string;
      title: string;
      color: string;
      source: string;
    }
  | { kind: "image"; file: string; title: string; source: string }
) & {
  /** Set when an official logo was found by its name alone, not its website. */
  matchedBy?: "name";
};

export class References {
  constructor(
    readonly dir: string,
    readonly fetcher: typeof fetch = fetch,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private async get(url: string, accept = "*/*") {
    const response = await this.fetcher(url, {
      headers: {
        accept,
        "user-agent": /wikidata|wikimedia/u.test(url)
          ? "Cutline/0.30 (local video editor)"
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw Error(`${new URL(url).host} answered ${response.status}.`);
    return response;
  }

  private async icons(): Promise<IconRecord[]> {
    const file = path.join(this.dir, "simple-icons-16.35.0.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const text = await (
      await this.get(`${SIMPLE_ICONS}/data/simple-icons.json`)
    ).text();
    const records = JSON.parse(text) as IconRecord[];
    if (!Array.isArray(records) || !records.length)
      throw Error("The logo library could not be read.");
    writeFileSync(file, text);
    return records;
  }

  /** Library matches for a name, best first, for search-as-you-type. */
  async searchLogos(query: string, limit = 8) {
    const q = normalize(query);
    if (!q) return [];
    const records = await this.icons();
    const target = iconAliases[q] ?? q;
    const scored = records
      .map((record) => {
        const names = [
          record.title,
          slugOf(record),
          ...(record.aliases?.aka ?? []),
          ...(record.aliases?.dup ?? []).map((d) => d.title),
          ...Object.values(record.aliases?.loc ?? {}),
        ].map(normalize);
        const score = names.includes(target)
          ? 0
          : names.some((n) => n.startsWith(target))
            ? 1
            : names.some((n) => n.includes(target))
              ? 2
              : 9;
        return { record, score };
      })
      .filter((item) => item.score < 9)
      .sort(
        (a, b) =>
          a.score - b.score || a.record.title.length - b.record.title.length,
      )
      .slice(0, limit)
      .map(({ record }) => ({
        title: record.title,
        slug: slugOf(record),
        color: `#${record.hex}`,
      }));
    const site = brandSites[q];
    return site && !scored.some((s) => normalize(s.title) === q)
      ? [
          { title: query.trim(), slug: `site:${site}`, color: "" },
          ...scored,
        ].slice(0, limit)
      : scored;
  }

  /**
   * The real mark for a product: an editable vector from Simple Icons when it
   * has one, otherwise the brand site's own icon (SVG when offered, else its
   * largest PNG).
   */
  /**
   * Whether the logo library has this exact product, so "Node.js" or
   * "Next.js" is looked up as a name and never as a web address.
   */
  async inLibrary(name: string) {
    return !!(await this.exactIcon(name).catch(() => undefined));
  }

  /** The library mark whose name or alias is exactly this, never a near miss. */
  private async exactIcon(name: string) {
    const q = normalize(name);
    if (!q) return undefined;
    const target = iconAliases[q] ?? q;
    return (await this.icons()).find((record) =>
      [
        record.title,
        slugOf(record),
        ...(record.aliases?.aka ?? []),
        ...(record.aliases?.dup ?? []).map((d) => d.title),
      ]
        .map(normalize)
        .includes(target),
    );
  }

  /**
   * The real mark for a product: Simple Icons as an editable vector when it has
   * the brand, else the official logo Wikidata records (Wikimedia Commons),
   * else the icon the brand's own site publishes.
   */
  async logo(query: { name?: string; domain?: string }): Promise<BrandLogo> {
    const domain =
      query.domain
        ?.replace(/^https?:\/\//u, "")
        .replace(/\/.*$/u, "")
        .toLowerCase() ?? brandSites[normalize(query.name ?? "")];
    const name =
      query.name?.trim() ||
      (domain ? domain.replace(/^www\./u, "").split(".")[0] : "");
    if (!query.domain) {
      const record = await this.exactIcon(name);
      if (record) {
        const slug = slugOf(record);
        const svg = await (
          await this.get(`${SIMPLE_ICONS}/icons/${slug}.svg`, "image/svg+xml")
        ).text();
        return {
          kind: "vector",
          svg,
          title: record.title,
          color: `#${record.hex}`,
          source: `Simple Icons: ${record.title}`,
        };
      }
    }
    const official = name
      ? await this.wikidataLogo(name, domain).catch(() => undefined)
      : undefined;
    if (official) return official;
    if (domain) return this.siteIcon(domain, query.name);
    throw Error(
      `No logo found for "${query.name}". Try its website instead, for example chatgpt.com.`,
    );
  }

  /** Official logo from Wikidata (property P154), matched by name or website. */
  private async wikidataLogo(
    name: string,
    domain?: string,
  ): Promise<BrandLogo | undefined> {
    // v2: website lookups must match the website, so older matches are redone.
    const cacheFile = path.join(this.dir, "wikidata-logos-2.json");
    let cache: Record<string, string | null> = {};
    try {
      cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    } catch {}
    const key = `${normalize(name)}|${domain ?? ""}`;
    let file = cache[key];
    if (file === undefined) {
      const api = "https://www.wikidata.org/w/api.php?format=json";
      const found = await (
        await this.get(
          `${api}&action=wbsearchentities&type=item&language=en&limit=6&search=${encodeURIComponent(name)}`,
          "application/json",
        )
      ).json();
      const ids: string[] = (found.search ?? []).map((item: any) => item.id);
      file = null;
      if (ids.length) {
        const data = await (
          await this.get(
            `${api}&action=wbgetentities&props=claims|labels&languages=en&ids=${ids.join("|")}`,
            "application/json",
          )
        ).json();
        const base = (host: string) =>
          host.toLowerCase().replace(/^www\./u, "");
        const candidates = ids.flatMap((id) => {
          const entity = data.entities?.[id];
          const logo = entity?.claims?.P154?.[0]?.mainsnak?.datavalue?.value;
          if (typeof logo !== "string") return [];
          const sites: string[] = (entity.claims.P856 ?? [])
            .map((claim: any) => claim.mainsnak?.datavalue?.value)
            .filter((value: unknown) => typeof value === "string");
          const owns =
            !!domain &&
            sites.some((site) => {
              try {
                const host = base(new URL(site).host);
                const wanted = base(domain);
                return (
                  host === wanted ||
                  host.endsWith(`.${wanted}`) ||
                  wanted.endsWith(`.${host}`)
                );
              } catch {
                return false;
              }
            });
          const named = normalize(entity.labels?.en?.value ?? "") === normalize(name);
          return [{ logo, owns, named, sites: sites.length }];
        });
        // The entity owning the website wins. Otherwise the label must match
        // exactly, so "Make" never becomes a song's cover art, and with a
        // known website a same-name entity counts only when it records no
        // website, since a different one means a different company
        // ("gamma.app" never becomes the Gamma hardware chain).
        const owner = candidates.find((c) => c.owns);
        const namesake = candidates.find(
          (c) => c.named && (!domain || !c.sites),
        );
        file = owner ? owner.logo : namesake ? `name:${namesake.logo}` : null;
      }
      cache[key] = file;
      writeFileSync(cacheFile, JSON.stringify(cache));
    }
    if (!file) return undefined;
    // Name-only matches are kept with a "name:" mark so callers can warn.
    const byName = file.startsWith("name:");
    if (byName) file = file.slice(5);
    const title = name;
    const source = `Wikimedia Commons: ${file}`;
    const matchedBy = byName ? { matchedBy: "name" as const } : {};
    const filePath = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`;
    if (/\.svg$/iu.test(file)) {
      try {
        const svg = await (await this.get(filePath, "image/svg+xml")).text();
        const parsed = parseEditableSvg(svg);
        // Keep the editable vector only when nothing would be lost; a logo
        // with filters or text keeps its true look as a sharp bitmap instead.
        if (
          !(parsed.warnings ?? []).some((w) =>
            /left out|replaced|combined/u.test(w),
          )
        )
          return { kind: "vector", svg, title, color: "", source, ...matchedBy };
      } catch {}
    }
    const response = await this.get(`${filePath}?width=640`, "image/*");
    const bytes = Buffer.from(await response.arrayBuffer());
    if ((imageSize(bytes)?.width ?? 0) < 120) return undefined;
    const ext = /jpeg/u.test(response.headers.get("content-type") ?? "")
      ? "jpg"
      : "png";
    const out = path.join(
      this.dir,
      `${normalize(title) || "logo"}-${createHash("sha1").update(file).digest("hex").slice(0, 8)}.${ext}`,
    );
    writeFileSync(out, bytes);
    return { kind: "image", file: out, title, source, ...matchedBy };
  }

  private async siteIcon(domain: string, name?: string): Promise<BrandLogo> {
    const host = domain.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(host))
      throw Error("Give a website domain such as chatgpt.com.");
    const home = `https://${host}/`;
    let reachable = true;
    const html = await this.get(home, "text/html")
      .then((response) => response.text())
      .catch(() => {
        reachable = false;
        return "";
      });
    type Candidate = { url: string; size: number; svg: boolean };
    const candidates: Candidate[] = [];
    for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
      const rel =
        /\brel=["']([^"']+)["']/iu.exec(tag)?.[1]?.toLowerCase() ?? "";
      const href = /\bhref=["']([^"']+)["']/iu.exec(tag)?.[1];
      if (!href || !/icon/u.test(rel)) continue;
      const sizes = /\bsizes=["'](\d+)x\d+["']/iu.exec(tag)?.[1];
      const url = new URL(href.replace(/&amp;/gu, "&"), home).toString();
      const svg = /\.svg(\?|$)/iu.test(url) || /image\/svg/iu.test(tag);
      candidates.push({
        url,
        svg,
        size: sizes
          ? Number(sizes)
          : /apple-touch/u.test(rel)
            ? 180
            : svg
              ? 1000
              : 32,
      });
    }
    const manifest = /<link\b[^>]*rel=["']manifest["'][^>]*>/iu.exec(html)?.[0];
    const manifestHref =
      manifest && /\bhref=["']([^"']+)["']/iu.exec(manifest)?.[1];
    if (manifestHref)
      try {
        const base = new URL(manifestHref, home).toString();
        const data = await (await this.get(base, "application/json")).json();
        for (const icon of data.icons ?? [])
          if (icon.src)
            candidates.push({
              url: new URL(icon.src, base).toString(),
              size: Number(String(icon.sizes ?? "0").split("x")[0]) || 0,
              svg: /svg/u.test(icon.type ?? icon.src),
            });
      } catch {}
    candidates.push(
      { url: `${home}apple-touch-icon.png`, size: 180, svg: false },
      // Google's icon service often has a large copy when the site's own fails.
      {
        url: `https://www.google.com/s2/favicons?domain=${host}&sz=256`,
        size: 1,
        svg: false,
      },
    );
    const title = name?.trim() || host.replace(/^www\./u, "");
    // Vector first when it imports cleanly, then the sharpest bitmap.
    for (const candidate of candidates.filter((c) => c.svg))
      try {
        const svg = await (
          await this.get(candidate.url, "image/svg+xml")
        ).text();
        if (parseEditableSvg(svg).layers.length)
          return {
            kind: "vector",
            svg,
            title,
            color: "",
            source: candidate.url,
          };
      } catch {}
    for (const candidate of candidates
      .filter((c) => !c.svg)
      .sort((a, b) => b.size - a.size))
      try {
        const response = await this.get(candidate.url, "image/*");
        const type = response.headers.get("content-type") ?? "";
        if (!/png|jpeg|webp/u.test(type)) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        // A 32px favicon turns to mush at reel size: keep icons of 120px or more.
        if ((imageSize(bytes)?.width ?? 0) < 120) continue;
        const ext = /jpeg/u.test(type)
          ? "jpg"
          : /webp/u.test(type)
            ? "webp"
            : "png";
        const file = path.join(
          this.dir,
          `${normalize(title) || "logo"}-${createHash("sha1").update(candidate.url).digest("hex").slice(0, 8)}.${ext}`,
        );
        writeFileSync(file, bytes);
        return { kind: "image", file, title, source: candidate.url };
      } catch {}
    if (!reachable && !candidates.some((c) => c.svg))
      throw Error(
        `Couldn't reach ${host}. Check the address and your internet connection.`,
      );
    throw Error(
      `${host} doesn't offer a sharp enough icon. Import a logo file instead.`,
    );
  }

  /** A file name for a page screenshot that is new each time. */
  screenshotPath(url: string) {
    const host = new URL(url).host
      .replace(/^www\./u, "")
      .replace(/[^a-z0-9.-]/giu, "");
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
    return path.join(
      this.dir,
      `${host || "page"}-${stamp}-${randomUUID().slice(0, 6)}.png`,
    );
  }
}

/** Pixel size of a PNG, JPEG or WebP from its header, without decoding it. */
export function imageSize(
  bytes: Buffer,
): { width: number; height: number } | undefined {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47)
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      )
        return {
          height: bytes.readUInt16BE(at + 5),
          width: bytes.readUInt16BE(at + 7),
        };
      at += 2 + bytes.readUInt16BE(at + 2);
    }
    return undefined;
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X")
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    if (chunk === "VP8L") {
      const bits = bytes.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8 ")
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
  }
  return undefined;
}

/** Recolors a single-color library mark: Simple Icons paths carry no fill. */
export function tintLogo(svg: string, color: string) {
  return svg.replace(/<svg\b/u, `<svg fill="${color}"`);
}
