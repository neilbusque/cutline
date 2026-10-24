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
import { parseEditableSvg } from "../shared/vector-path";

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
      if (code === 0) resolve(out);
      else
        reject(
          Error(
            err.trim().split("\n").at(-1) ||
              `The assistant stopped (exit ${code}).`,
          ),
        );
    });
    child.stdin.end(input);
  });
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

/** A one-shot, tool-free question to the signed-in Claude Code or ChatGPT (Codex). */
export function assistantAsker(
  provider: "claude" | "chatgpt",
  options: {
    workDir: string;
    signal?: AbortSignal;
    claudeModel?: "opus" | "sonnet";
  },
) {
  mkdirSync(options.workDir, { recursive: true });
  return async (system: string, prompt: string) => {
    if (provider === "claude") {
      const bin = findClaude();
      if (!bin)
        throw Error(
          "Claude Code isn't installed. Install it from claude.com/code and sign in once, or choose ChatGPT.",
        );
      const out = await run(
        bin,
        [
          "-p",
          "--output-format",
          "json",
          "--model",
          options.claudeModel ?? "opus",
          "--tools",
          "",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--system-prompt",
          system,
        ],
        prompt,
        { cwd: options.workDir, timeoutMs: 240000, signal: options.signal },
      );
      let parsed: { result?: string; is_error?: boolean };
      try {
        parsed = JSON.parse(out);
      } catch {
        throw Error("Claude returned an unreadable reply. Try again.");
      }
      if (parsed.is_error || !parsed.result)
        throw Error(
          /log ?in|auth/i.test(parsed.result ?? "")
            ? "Claude needs you to sign in. Run `claude auth login` in Terminal."
            : (parsed.result ?? "Claude could not answer."),
        );
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
          "-o",
          answer,
          "-",
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

export type BrandLogo =
  | {
      kind: "vector";
      svg: string;
      title: string;
      color: string;
      source: string;
    }
  | { kind: "image"; file: string; title: string; source: string };

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
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
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
  async logo(query: {
    name?: string;
    domain?: string;
    slug?: string;
  }): Promise<BrandLogo> {
    const slug =
      query.slug ??
      (query.domain
        ? `site:${query.domain}`
        : (await this.searchLogos(query.name ?? "", 1))[0]?.slug);
    const fallbackSite = brandSites[normalize(query.name ?? "")];
    if (slug && !slug.startsWith("site:")) {
      const record = (await this.icons()).find((r) => slugOf(r) === slug);
      if (record) {
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
    const site = slug?.startsWith("site:")
      ? slug.slice(5)
      : (query.domain ?? fallbackSite);
    if (!site)
      throw Error(
        `No logo found for "${query.name}". Give the product's website domain (for example chatgpt.com) to use its own icon.`,
      );
    return this.siteIcon(site, query.name);
  }

  private async siteIcon(domain: string, name?: string): Promise<BrandLogo> {
    const host = domain.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(host))
      throw Error("Give a website domain such as chatgpt.com.");
    const home = `https://${host}/`;
    const html = await (
      await this.get(home, "text/html")
    )
      .text()
      .catch(() => "");
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
    candidates.push({
      url: `${home}apple-touch-icon.png`,
      size: 180,
      svg: false,
    });
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
        if (bytes.length < 400) continue;
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
    throw Error(
      `${host} doesn't offer an icon Cutline can use. Import a logo file instead.`,
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

/** Recolors a single-color library mark: Simple Icons paths carry no fill. */
export function tintLogo(svg: string, color: string) {
  return svg.replace(/<svg\b/u, `<svg fill="${color}"`);
}
