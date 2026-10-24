import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  withoutBackdrop,
  extractSvg,
  generateVector,
  VectorGenerateSchema,
  vectorUserPrompt,
} from "../src/shared/vector-generation";
import { References } from "../src/main/vector-studio";
import { newProject } from "../src/shared/model";
import { referenceCard } from "../src/main/agent-media";

const good =
  '<svg viewBox="0 0 512 512"><path id="cup" d="M100 200H400V400H100Z" fill="#c0703a"/></svg>';

describe("generated vectors", () => {
  it("pulls the SVG out of a chatty or fenced reply", () => {
    expect(extractSvg("Here you go:\n```svg\n" + good + "\n```")).toBe(good);
    expect(() => extractSvg("I can't draw that.")).toThrow(
      /did not return an SVG/,
    );
    // Two drawings in one reply: the first, with its nested viewport intact.
    const nested = '<svg viewBox="0 0 10 10"><svg x="1"><rect width="2" height="2"/></svg></svg>';
    expect(extractSvg(`Before:\n${nested}\nAfter:\n${good}`)).toBe(nested);
    expect(() => extractSvg("<svg viewBox='0 0 1 1'><rect/>")).toThrow(
      /did not return an SVG/,
    );
  });

  it("writes the style, art board and palette into the request", () => {
    const prompt = vectorUserPrompt(
      VectorGenerateSchema.parse({
        prompt: "a rocket",
        style: "line",
        aspect: "wide",
        palette: ["#112233"],
      }),
    );
    expect(prompt).toContain('viewBox="0 0 800 450"');
    expect(prompt).toContain("round caps");
    expect(prompt).toContain("#112233");
  });

  it("sends the importer's complaint back once and returns the fixed SVG", async () => {
    const prompts: string[] = [];
    const replies = [
      '<svg viewBox="0 0 10 10"><text>Hi</text><rect width="5" height="5"/></svg>',
      good,
    ];
    const result = await generateVector(
      VectorGenerateSchema.parse({ prompt: "a cup" }),
      async (_system, prompt) => {
        prompts.push(prompt);
        return replies.shift()!;
      },
    );
    expect(result.attempts).toBe(2);
    expect(result.svg).toBe(good);
    expect(prompts[1]).toMatch(/Text was left out/);
  });

  it("explains a reply that never becomes a usable vector", async () => {
    await expect(
      generateVector(
        VectorGenerateSchema.parse({ prompt: "a cup" }),
        async () => "<svg><path d='bad'/></svg>",
      ),
    ).rejects.toThrow(/could not be used/);
  });
});

describe("drawn illustrations", () => {
  it("drop a full-size backdrop the model drew, and keep real shapes", () => {
    const drawn =
      '<svg viewBox="0 0 512 512"><rect width="512" height="512" fill="#f3e8ff"/><circle cx="256" cy="256" r="120" fill="#22c55e"/><rect x="200" y="300" width="100" height="40" fill="#111"/></svg>';
    const clean = withoutBackdrop(drawn);
    expect(clean).not.toContain('width="512"');
    expect(clean).toContain("<circle");
    expect(clean).toContain('width="100"');
    const percent =
      '<svg viewBox="0 0 400 400"><rect x="0" y="0" width="100%" height="100%" rx="40" fill="#fff"/><path d="M0 0H10V10Z"/></svg>';
    expect(withoutBackdrop(percent)).not.toContain("100%");
    const subject =
      '<svg viewBox="0 0 512 512"><rect x="100" y="100" width="300" height="300"/></svg>';
    expect(withoutBackdrop(subject)).toBe(subject);
  });
});

describe("references", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const library = [
    { title: "Claude", slug: "claude", hex: "D97757" },
    { title: "Cursor", hex: "000000" },
    { title: "Google Gemini", slug: "googlegemini", hex: "8E75B2" },
    { title: "Slackware", hex: "000000" },
  ];
  /** A PNG header of the given size, padded like a real file. */
  const png = (size: number) => {
    const bytes = Buffer.alloc(1200, 7);
    bytes.writeUInt32BE(0x89504e47, 0);
    bytes.writeUInt32BE(0x0d0a1a0a, 4);
    bytes.writeUInt32BE(size, 16);
    bytes.writeUInt32BE(size, 20);
    return bytes;
  };
  const fake = (routes: Record<string, () => Response>) =>
    (async (url: string) => {
      const route = routes[String(url)];
      return route ? route() : new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;
  const icons = "https://cdn.jsdelivr.net/npm/simple-icons@16.35.0";

  it("finds library marks by name or alias and returns them as vectors", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cutline-refs-"));
    const refs = new References(
      dir,
      fake({
        [`${icons}/data/simple-icons.json`]: () =>
          new Response(JSON.stringify(library)),
        [`${icons}/icons/claude.svg`]: () =>
          new Response(
            '<svg viewBox="0 0 24 24"><path d="M0 0H24V24Z"/></svg>',
          ),
      }),
    );
    expect((await refs.searchLogos("claude code"))[0]).toMatchObject({
      slug: "claude",
    });
    expect((await refs.searchLogos("Gemini"))[0]).toMatchObject({
      slug: "googlegemini",
    });
    expect((await refs.searchLogos("chatgpt"))[0].slug).toBe(
      "site:chatgpt.com",
    );
    const logo = await refs.logo({ name: "Claude" });
    expect(logo).toMatchObject({
      kind: "vector",
      title: "Claude",
      color: "#D97757",
    });
  });

  it("falls back to the brand site's largest sharp icon, never a tiny favicon", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cutline-refs-"));
    const refs = new References(
      dir,
      fake({
        [`${icons}/data/simple-icons.json`]: () =>
          new Response(JSON.stringify(library)),
        "https://chatgpt.com/": () =>
          new Response(
            '<link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">',
          ),
        "https://chatgpt.com/apple-touch-icon.png": () =>
          new Response(png(180), { headers: { "content-type": "image/png" } }),
        "https://chatgpt.com/favicon-32.png": () =>
          new Response(png(32), { headers: { "content-type": "image/png" } }),
      }),
    );
    const logo = await refs.logo({ name: "ChatGPT" });
    expect(logo.kind).toBe("image");
    if (logo.kind === "image") {
      expect(logo.source).toBe("https://chatgpt.com/apple-touch-icon.png");
      expect(readFileSync(logo.file)).toHaveLength(1200);
    }
    await expect(refs.logo({ name: "zzqq unknown" })).rejects.toThrow(
      /website/,
    );
  });

  it("never swaps a brand for a near miss, prefers the official logo, and rejects tiny icons", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cutline-refs-"));
    const wikidata = "https://www.wikidata.org/w/api.php?format=json";
    const refs = new References(
      dir,
      fake({
        [`${icons}/data/simple-icons.json`]: () =>
          new Response(JSON.stringify(library)),
        [`${wikidata}&action=wbsearchentities&type=item&language=en&limit=6&search=Slack`]:
          () =>
            new Response(
              JSON.stringify({ search: [{ id: "Q1" }, { id: "Q2" }] }),
            ),
        [`${wikidata}&action=wbgetentities&props=claims|labels&languages=en&ids=Q1|Q2`]:
          () =>
            new Response(
              JSON.stringify({
                entities: {
                  Q1: {
                    labels: { en: { value: "Slack (band)" } },
                    claims: {
                      P154: [
                        { mainsnak: { datavalue: { value: "Band.svg" } } },
                      ],
                    },
                  },
                  Q2: {
                    labels: { en: { value: "Slack" } },
                    claims: {
                      P154: [
                        {
                          mainsnak: { datavalue: { value: "Slack logo.svg" } },
                        },
                      ],
                    },
                  },
                },
              }),
            ),
        "https://commons.wikimedia.org/wiki/Special:FilePath/Slack%20logo.svg":
          () =>
            new Response(
              '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#4a154b"/></svg>',
            ),
        "https://tiny.example/": () =>
          new Response('<link rel="icon" href="/f.png" sizes="32x32">'),
        "https://tiny.example/f.png": () =>
          new Response(png(32), { headers: { "content-type": "image/png" } }),
      }),
    );
    const slack = await refs.logo({ name: "Slack" });
    expect(slack).toMatchObject({
      kind: "vector",
      source: "Wikimedia Commons: Slack logo.svg",
    });
    await expect(refs.logo({ domain: "tiny.example" })).rejects.toThrow(
      /sharp enough/,
    );
    await expect(refs.logo({ domain: "unreachable.example" })).rejects.toThrow(
      /Couldn't reach/,
    );
  });

  it("frames a screenshot as a card above the captions on a tall reel", () => {
    const p = { ...newProject(), width: 1080, height: 1920 };
    const asset = {
      id: "shot",
      name: "Repo",
      kind: "image" as const,
      path: "/tmp/shot.png",
      duration: 0,
      width: 2880,
      height: 1800,
      hasAudio: false,
    };
    const card = referenceCard(p, asset, { at: { frame: 30 } }, "screenshot");
    expect(card.clip).toMatchObject({
      mask: "rounded",
      start: 30,
      duration: 90,
    });
    expect(card.clip.width).toBeCloseTo(1080 * 0.86);
    expect(card.clip.height).toBeCloseTo((1080 * 0.86) / 1.6);
    expect(card.clip.y + card.clip.height).toBeLessThan(1920 * 0.7);
  });
});
