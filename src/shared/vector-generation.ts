import { z } from "zod";
import { parseEditableSvg, type ParsedEditableSvg } from "./vector-path";

/** Looks a generated vector can ask for. Each adds its own drawing brief. */
export const vectorStyles = [
  {
    id: "flat",
    name: "Flat",
    brief:
      "Flat illustration: solid fills, 3 to 5 harmonious colors, one darker shade per color for depth, no outlines unless they help read the shape.",
  },
  {
    id: "line",
    name: "Line icon",
    brief:
      "Line icon: one consistent stroke width (about 4% of the canvas), round caps and joins, fill none, one or two colors. Every stroke is a separate path in drawing order so it can draw itself on.",
  },
  {
    id: "glyph",
    name: "Logo mark",
    brief:
      "Bold logo mark: one to three colors, strong silhouette that reads at 64 pixels, geometric construction, generous negative space, no fine detail.",
  },
  {
    id: "gradient",
    name: "Soft gradient",
    brief:
      'Modern app-icon look: smooth linear or radial gradients (2 or 3 stops), soft highlight shapes with low opacity, rounded geometry. Gradients go in <defs> and are used with fill="url(#id)".',
  },
  {
    id: "badge",
    name: "Badge",
    brief:
      "Badge or sticker: a filled base shape (circle, shield or rounded square) with a simple symbol on top in a contrasting color, a thin inner ring, balanced margins.",
  },
] as const;
export type VectorStyle = (typeof vectorStyles)[number]["id"];

export const VectorGenerateSchema = z.strictObject({
  prompt: z.string().trim().min(2).max(2000),
  style: z
    .enum(vectorStyles.map((s) => s.id) as [VectorStyle, ...VectorStyle[]])
    .default("flat"),
  provider: z.enum(["claude", "chatgpt"]).default("claude"),
  /** Width / height of the art board. */
  aspect: z.enum(["square", "wide", "tall"]).default("square"),
  /** Colors to keep, such as a brand palette. */
  palette: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
    .max(6)
    .optional(),
  /** What the graphic sits on in the video, such as "near-black video". */
  onto: z.string().trim().min(2).max(80).optional(),
});
export type VectorGenerateInput = z.infer<typeof VectorGenerateSchema>;

const boards = {
  square: [512, 512],
  wide: [800, 450],
  tall: [450, 800],
} as const;

export function vectorSystemPrompt() {
  return [
    "You are a senior vector illustrator creating artwork for animated video. You reply with exactly one complete SVG document and nothing else: no prose, no code fences.",
    "Rules the importer enforces:",
    "- Use only svg, g, defs, path, rect, circle, ellipse, polygon, polyline, line, linearGradient, radialGradient and stop.",
    "- No text, image, filter, mask, clipPath, pattern, foreignObject, script, animation or CSS @import. Words are added later as live titles.",
    "- At most 40 shapes. Fewer, cleaner shapes look better and animate better.",
    "- Colors as hex. Transparent background: no full-canvas background rectangle unless the request asks for one.",
    "Quality:",
    "- Build on a clear grid, keep the subject centered with about 8% padding, and keep proportions true.",
    '- Order shapes back to front in the order they should appear on screen, and give each a short id naming its part (id="cup", id="steam-1").',
    "- Use cubic curves for organic forms and exact geometry for mechanical ones. No jagged hand-drawn noise.",
    "- Every shape must be visible and meaningful; no hidden or zero-size elements.",
  ].join("\n");
}

export function vectorUserPrompt(input: VectorGenerateInput) {
  const style = vectorStyles.find((s) => s.id === input.style)!;
  const [w, h] = boards[input.aspect];
  return [
    `Draw: ${input.prompt}`,
    `Style: ${style.brief}`,
    `Art board: viewBox="0 0 ${w} ${h}" width="${w}" height="${h}".`,
    input.palette?.length
      ? `Use this palette (add tints or shades of it only): ${input.palette.join(", ")}.`
      : "",
    input.onto
      ? `It sits on ${input.onto}: draw no background, tile or frame, and pick colors that stand out on it.`
      : "",
    "Reply with the SVG only.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The first complete svg element in a model reply. */
export function extractSvg(reply: string): string {
  const start = reply.search(/<svg[\s>]/u);
  const end = reply.lastIndexOf("</svg>");
  if (start < 0 || end < start)
    throw Error(
      "The assistant did not return an SVG. Try again or reword the request.",
    );
  return reply.slice(start, end + 6);
}

/**
 * Asks a model for an SVG and checks it with the importer. One repair round
 * sends the importer's complaint back, which fixes most broken replies. With
 * decline, the model may answer that the subject is too detailed instead.
 */
export async function generateVector(
  input: VectorGenerateInput,
  ask: (system: string, prompt: string) => Promise<string>,
  options: { decline?: string } = {},
): Promise<{ svg: string; parsed: ParsedEditableSvg; attempts: number }> {
  const system = [vectorSystemPrompt(), options.decline]
    .filter(Boolean)
    .join("\n");
  let prompt = vectorUserPrompt(input);
  let problem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await ask(system, prompt);
    if (options.decline && /<too-detailed\s*\/>/u.test(reply) && !/<svg[\s>]/u.test(reply))
      throw Error("The subject is too detailed for a vector.");
    let svg = "";
    try {
      svg = extractSvg(reply);
      const parsed = parseEditableSvg(svg);
      const lost = (parsed.warnings ?? []).filter((w) =>
        /left out|combined|replaced|Unknown/u.test(w),
      );
      if (!lost.length || attempt === 2)
        return { svg, parsed, attempts: attempt };
      problem = lost.join(" ");
    } catch (error) {
      problem = (error as Error).message;
      if (attempt === 2)
        throw Error(`The generated vector could not be used: ${problem}`);
    }
    prompt = `${vectorUserPrompt(input)}\n\nYour previous SVG had this problem: ${problem}\nPrevious SVG:\n${svg.slice(0, 20000)}\nReturn a corrected complete SVG only.`;
  }
  throw Error("The generated vector could not be used.");
}

/**
 * Removes a backdrop shape a model draws behind the subject (a rectangle
 * covering nearly the whole art board), so the art sits on Cutline's own
 * background. Anything smaller is part of the drawing and stays.
 */
export function withoutBackdrop(svg: string): string {
  const box = /viewBox\s*=\s*["']([^"']+)["']/iu.exec(svg)?.[1];
  const [, , w, h] = (box ?? "").split(/[\s,]+/u).map(Number);
  if (!(w > 0) || !(h > 0)) return svg;
  const rect = /<rect\b[^>]*>(?:\s*<\/rect>)?/iu.exec(
    svg.slice(svg.search(/<svg[\s>]/u) + 4),
  );
  if (!rect) return svg;
  const attr = (name: string) =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(rect[0])?.[1];
  const size = (value: string | undefined, whole: number) =>
    value === undefined
      ? 0
      : value.trim().endsWith("%")
        ? (Number.parseFloat(value) / 100) * whole
        : Number.parseFloat(value);
  const covers =
    size(attr("width"), w) >= w * 0.9 && size(attr("height"), h) >= h * 0.9;
  return covers ? svg.replace(rect[0], "") : svg;
}
