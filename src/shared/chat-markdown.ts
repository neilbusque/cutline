/**
 * The small markdown subset assistant replies use: paragraphs, headings,
 * bullet and numbered lists, fenced code, bold, italic, inline code and link
 * text. It produces plain data; the UI renders it as React elements, so no
 * reply can inject HTML.
 */
export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string };
export type Block =
  | { type: "paragraph"; lines: Inline[][] }
  | { type: "heading"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][][] }
  | { type: "code"; text: string };

const pairs: [RegExp, "strong" | "em" | "code" | "link"][] = [
  [/`([^`\n]+)`/, "code"],
  [/\*\*(?=\S)([\s\S]*?\S)\*\*/, "strong"],
  [/__(?=\S)([\s\S]*?\S)__/, "strong"],
  [/\[([^\]\n]+)\]\([^)\s]+\)/, "link"],
  [/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/, "em"],
  [/(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/, "em"],
];

export function parseInline(text: string): Inline[] {
  let best:
    { index: number; length: number; inner: string; kind: string } | undefined;
  for (const [pattern, kind] of pairs) {
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.index))
      best = {
        index: match.index,
        length: match[0].length,
        inner: match[1],
        kind,
      };
  }
  if (!best) return text ? [{ type: "text", text }] : [];
  const before = text.slice(0, best.index),
    after = text.slice(best.index + best.length);
  const middle: Inline[] =
    best.kind === "code"
      ? [{ type: "code", text: best.inner }]
      : best.kind === "link"
        ? parseInline(best.inner)
        : [
            {
              type: best.kind as "strong" | "em",
              children: parseInline(best.inner),
            },
          ];
  return [
    ...(before ? [{ type: "text" as const, text: before }] : []),
    ...middle,
    ...parseInline(after),
  ];
}

const bullet = /^\s*[-*•+]\s+(.*)$/;
const numbered = /^\s*(\d{1,9})[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({ type: "paragraph", lines: paragraph.map(parseInline) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^\s*```/);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++index < lines.length && !/^\s*```/.test(lines[index]))
        code.push(lines[index]);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({
        type: "heading",
        children: parseInline(heading[1].trim()),
      });
      continue;
    }
    const item = line.match(bullet) ?? line.match(numbered);
    if (item) {
      flush();
      const ordered = !line.match(bullet);
      const items: string[] = [];
      const start = ordered ? Number(item[1]) : 1;
      let current = ordered ? item[2] : item[1];
      while (++index < lines.length) {
        const next = lines[index];
        const more = ordered ? next.match(numbered) : next.match(bullet);
        if (more) {
          items.push(current);
          current = ordered ? more[2] : more[1];
        } else if (
          next.trim() &&
          /^\s+/.test(next) &&
          !next.match(bullet) &&
          !next.match(numbered)
        )
          current += " " + next.trim();
        else break;
      }
      items.push(current);
      index--;
      blocks.push({
        type: "list",
        ordered,
        start,
        items: items.map((text) => [parseInline(text.trim())]),
      });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
