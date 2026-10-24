export type VectorViewBox = [number, number, number, number];
export type VectorMatrix = [number, number, number, number, number, number];
export type PenPoint = {
  x: number;
  y: number;
  in?: { x: number; y: number };
  out?: { x: number; y: number };
};
export type VectorSegment = { command: string; values: number[] };
export type VectorPathDefinition = {
  type: "path";
  name?: string;
  vectorPath: string;
  vectorViewBox: VectorViewBox;
  vectorTransform?: VectorMatrix;
  vectorFillRule: "nonzero" | "evenodd";
  vectorLineCap: "butt" | "round" | "square";
  vectorLineJoin: "miter" | "round" | "bevel";
  vectorAspectRatio: "meet" | "none";
  background: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  opacity: number;
  vectorGradient?: VectorGradient;
};
export type VectorGradientStop = {
  offset: number;
  color: string;
  opacity: number;
};
/** An SVG gradient fill, kept in the path's own coordinates so it moves with it. */
export type VectorGradient = {
  type: "linear" | "radial";
  units: "objectBoundingBox" | "userSpaceOnUse";
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  r?: number;
  fx?: number;
  fy?: number;
  transform?: VectorMatrix;
  spread: "pad" | "reflect" | "repeat";
  stops: VectorGradientStop[];
};
export type ParsedEditableSvg = {
  viewBox: VectorViewBox;
  width: number;
  height: number;
  layers: VectorPathDefinition[];
  /** What the importer left out or approximated, in plain words. */
  warnings?: string[];
};
/**
 * Imported layers as one SVG, drawn the way Cutline's composition draws them
 * (fill or gradient, outline, transform, opacity), for checks and previews
 * outside the editor. An optional background fills the art board.
 */
export function editableSvgMarkup(parsed: ParsedEditableSvg, background?: string) {
  const [x, y, w, h] = parsed.viewBox;
  const defs: string[] = [];
  const paths = parsed.layers.map((layer, index) => {
    let fill = layer.background === "transparent" ? "none" : layer.background;
    const g = layer.vectorGradient;
    if (g && fill !== "none") {
      const attrs = [
        `id="g${index}"`,
        `gradientUnits="${g.units}"`,
        `spreadMethod="${g.spread}"`,
        g.transform ? `gradientTransform="matrix(${g.transform.join(" ")})"` : "",
        ...(g.type === "linear"
          ? (["x1", "y1", "x2", "y2"] as const)
          : (["cx", "cy", "r", "fx", "fy"] as const)
        ).map((key) => (g[key] === undefined ? "" : `${key}="${g[key]}"`)),
      ].filter(Boolean);
      const stops = g.stops
        .map(
          (stop) =>
            `<stop offset="${stop.offset}" stop-color="${stop.color}" stop-opacity="${stop.opacity}"/>`,
        )
        .join("");
      const tag = g.type === "linear" ? "linearGradient" : "radialGradient";
      defs.push(`<${tag} ${attrs.join(" ")}>${stops}</${tag}>`);
      fill = `url(#g${index})`;
    }
    return `<path d="${layer.vectorPath}" fill="${fill}" fill-opacity="${layer.fillOpacity}" fill-rule="${layer.vectorFillRule}" stroke="${layer.stroke === "transparent" ? "none" : layer.stroke}" stroke-width="${layer.strokeWidth}" stroke-linecap="${layer.vectorLineCap}" stroke-linejoin="${layer.vectorLineJoin}" opacity="${layer.opacity}"${layer.vectorTransform ? ` transform="matrix(${layer.vectorTransform.join(" ")})"` : ""}/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`,
    background
      ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>`
      : "",
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    ...paths,
    "</svg>",
  ].join("");
}

/** The root element's art board moved to a new viewBox, everything inside kept. */
export function withViewBox(svg: string, viewBox: VectorViewBox) {
  const root = /<svg\b[^>]*>/u.exec(svg);
  if (!root) return svg;
  const box = viewBox.map((n) => Math.round(n * 100) / 100);
  let tag = root[0].replace(/\s(viewBox|width|height)\s*=\s*("[^"]*"|'[^']*')/giu, "");
  tag = tag.replace(
    /^<svg\b/u,
    `<svg viewBox="${box.join(" ")}" width="${box[2]}" height="${box[3]}"`,
  );
  return svg.slice(0, root.index) + tag + svg.slice(root.index + root[0].length);
}

/** Paths and layers an imported vector may use. */
export const MAX_VECTOR_PATH_LENGTH = 65536;
export const MAX_VECTOR_LAYERS = 64;
const numberPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const counts: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};
const bounded = (n: number) => Number.isFinite(n) && Math.abs(n) <= 1e7;
function fail(message: string): never {
  throw Error(message);
}

/** Strict SVG path syntax, bounded before it reaches a browser or renderer. */
export function parseVectorPath(path: string): VectorSegment[] {
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path.length > MAX_VECTOR_PATH_LENGTH
  )
    fail("Vector path must contain 1–65,536 characters.");
  let offset = 0,
    previousNumber = false;
  const gap = () => {
    const gap = /^[\s,]*/u.exec(path.slice(offset))![0];
    const commas = [...gap].filter((c) => c === ",").length;
    offset += gap.length;
    if (commas > 1 || (commas && (!previousNumber || offset === path.length)))
      fail("Invalid comma in vector path.");
    return commas;
  };
  const segments: VectorSegment[] = [];
  let command: string | undefined;
  while (offset < path.length) {
    const commas = gap();
    if (offset === path.length) break;
    const char = path[offset];
    if (/[a-z]/iu.test(char)) {
      if (commas || counts[char.toUpperCase()] === undefined)
        fail(`Unsupported vector command ${char}.`);
      command = char;
      previousNumber = false;
      offset++;
    }
    if (!segments.length && command?.toUpperCase() !== "M")
      fail("A vector path must begin with M or m.");
    if (!command)
      fail("Numbers cannot follow a closed path without a new command.");
    const upper = command.toUpperCase(),
      count = counts[upper];
    if (count === 0) {
      segments.push({ command, values: [] });
      command = undefined;
    } else {
      const numbers: number[] = [];
      for (let i = 0; i < count; i++) {
        gap();
        if (offset === path.length || /[a-z]/iu.test(path[offset]))
          fail(`Vector command ${command} has incomplete coordinates.`);
        // SVG arc flags are one character each. Optimized SVGs may join the
        // flags and endpoint (for example 0110 means flags 0/1 then x=10).
        const flag = upper === "A" && (i === 3 || i === 4);
        const match = flag
          ? /^[01]/u.exec(path.slice(offset))
          : numberPattern.exec(path.slice(offset));
        if (!match)
          fail(
            flag
              ? "Arc flags must be 0 or 1."
              : "Invalid number in vector path.",
          );
        const value = Number(match[0]);
        if (!bounded(value))
          fail("Vector coordinates must be finite and within ±10,000,000.");
        numbers.push(value);
        previousNumber = true;
        offset += match[0].length;
      }
      if (
        upper === "A" &&
        (numbers[0] < 0 ||
          numbers[1] < 0 ||
          ![0, 1].includes(numbers[3]) ||
          ![0, 1].includes(numbers[4]))
      )
        fail("Arc radii must be nonnegative and arc flags must be 0 or 1.");
      segments.push({ command, values: numbers });
      if (upper === "M") command = command === "M" ? "L" : "l";
    }
    if (segments.length > 16384)
      fail("A vector path supports at most 16,384 segments.");
  }
  return segments;
}
export function validateVectorPath(path: string): void {
  parseVectorPath(path);
}
export function validateVectorViewBox(viewBox: VectorViewBox): void {
  if (
    viewBox.length !== 4 ||
    !viewBox.every(bounded) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0
  )
    fail("Vector viewBox needs four finite numbers and positive width/height.");
}
const pointText = (p: { x: number; y: number }) => `${p.x} ${p.y}`;
export function pointsToVectorPath(
  points: PenPoint[],
  { closed = false }: { closed?: boolean } = {},
): string {
  if (points.length < 2 || points.length > 2000)
    fail("A pen path needs 2–2,000 points.");
  for (const point of points)
    for (const p of [point, point.in, point.out])
      if (p && (!bounded(p.x) || !bounded(p.y)))
        fail("Pen points and handles must have finite bounded coordinates.");
  let path = `M${pointText(points[0])}`;
  const segment = (a: PenPoint, b: PenPoint) =>
    a.out || b.in
      ? `C${pointText(a.out ?? a)} ${pointText(b.in ?? b)} ${pointText(b)}`
      : `L${pointText(b)}`;
  for (let i = 1; i < points.length; i++)
    path += segment(points[i - 1], points[i]);
  if (closed) {
    if (points.at(-1)!.out || points[0].in)
      path += segment(points.at(-1)!, points[0]);
    path += "Z";
  }
  validateVectorPath(path);
  return path;
}
/** Single M/L/H/V/C contour for a staged node editor. Other valid SVG commands stay in path-text mode. */
export function vectorPathToPoints(
  path: string,
): { points: PenPoint[]; closed: boolean } | null {
  const points: PenPoint[] = [];
  let x = 0,
    y = 0,
    closed = false;
  for (const segment of parseVectorPath(path)) {
    const command = segment.command.toUpperCase(),
      relative = segment.command !== command,
      v = segment.values;
    if (closed || (command === "M" && points.length)) return null;
    const px = (n: number) => n + (relative ? x : 0),
      py = (n: number) => n + (relative ? y : 0);
    if (command === "Z") {
      closed = true;
      continue;
    }
    if (command === "C") {
      points.at(-1)!.out = { x: px(v[0]), y: py(v[1]) };
      points.push({
        x: px(v[4]),
        y: py(v[5]),
        in: { x: px(v[2]), y: py(v[3]) },
      });
    } else if (["M", "L", "H", "V"].includes(command)) {
      points.push({
        x: command === "V" ? x : px(v[0]),
        y: command === "H" ? y : py(v[command === "V" ? 0 : 1]),
      });
    } else return null;
    x = points.at(-1)!.x;
    y = points.at(-1)!.y;
  }
  if (
    closed &&
    points.length > 2 &&
    points.at(-1)!.x === points[0].x &&
    points.at(-1)!.y === points[0].y
  ) {
    points[0].in = points.pop()!.in;
  }
  return points.length >= 2 ? { points, closed } : null;
}

const identity: VectorMatrix = [1, 0, 0, 1, 0, 0];
export function multiplyVectorMatrices(
  a: VectorMatrix,
  b: VectorMatrix,
): VectorMatrix {
  const result: VectorMatrix = [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  if (!result.every(bounded))
    fail("SVG transform exceeds safe coordinate bounds.");
  return result;
}
function numberList(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  let at = 0;
  const numbers: number[] = [];
  while (at < trimmed.length) {
    if (numbers.length) {
      const separator = /^[\s,]*/u.exec(trimmed.slice(at))![0];
      if ([...separator].filter((c) => c === ",").length > 1)
        fail("Invalid SVG number list.");
      at += separator.length;
      if (at === trimmed.length) fail("Trailing separator in SVG number list.");
    }
    const match = numberPattern.exec(trimmed.slice(at));
    if (!match) fail("Invalid SVG number list.");
    const n = Number(match[0]);
    if (!bounded(n)) fail("SVG number exceeds safe coordinate bounds.");
    numbers.push(n);
    at += match[0].length;
  }
  return numbers;
}
export function parseVectorTransform(value: string): VectorMatrix {
  let matrix = [...identity] as VectorMatrix,
    rest = value.trim(),
    count = 0;
  while (rest) {
    const match =
      /^(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*,?\s*/u.exec(
        rest,
      );
    if (!match || ++count > 100)
      fail("Unsupported or malformed SVG transform.");
    const n = numberList(match[2]),
      kind = match[1];
    let next: VectorMatrix;
    if (kind === "matrix" && n.length === 6) next = n as VectorMatrix;
    else if (kind === "translate" && [1, 2].includes(n.length))
      next = [1, 0, 0, 1, n[0], n[1] ?? 0];
    else if (kind === "scale" && [1, 2].includes(n.length))
      next = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    else if (kind === "rotate" && [1, 3].includes(n.length)) {
      const angle = (n[0] * Math.PI) / 180,
        rotation: VectorMatrix = [
          Math.cos(angle),
          Math.sin(angle),
          -Math.sin(angle),
          Math.cos(angle),
          0,
          0,
        ];
      next =
        n.length === 1
          ? rotation
          : multiplyVectorMatrices(
              multiplyVectorMatrices([1, 0, 0, 1, n[1], n[2]], rotation),
              [1, 0, 0, 1, -n[1], -n[2]],
            );
    } else if (["skewX", "skewY"].includes(kind) && n.length === 1) {
      const skew = Math.tan((n[0] * Math.PI) / 180);
      next = kind === "skewX" ? [1, 0, skew, 1, 0, 0] : [1, skew, 0, 1, 0, 0];
    } else fail("Wrong argument count in SVG transform.");
    matrix = multiplyVectorMatrices(matrix, next);
    rest = rest.slice(match[0].length);
  }
  return matrix;
}

/* ------------------------------------------------------------------------ */
/* Editable SVG import                                                       */
/* ------------------------------------------------------------------------ */

type SvgNode = {
  tag: string;
  attrs: Record<string, string>;
  children: SvgNode[];
  text: string;
};

function decodeXml(value: string) {
  return value.replace(/&([^;\s&]*);/gu, (_, entity: string) => {
    const named: Record<string, string> = {
      amp: "&",
      quot: '"',
      apos: "'",
      lt: "<",
      gt: ">",
      nbsp: " ",
    };
    if (named[entity]) return named[entity];
    const numeric = /^#(?:x[0-9a-f]+|\d+)$/iu.test(entity)
      ? Number.parseInt(
          entity.slice(entity[1] === "x" ? 2 : 1),
          entity[1] === "x" ? 16 : 10,
        )
      : NaN;
    if (!Number.isInteger(numeric) || numeric < 9 || numeric > 0x10ffff)
      fail("Unsupported SVG entity.");
    return String.fromCodePoint(numeric);
  });
}
function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let rest = text;
  while (rest.trim()) {
    const match = /^\s+([\w:.-]+)\s*=\s*(["'])(.*?)\2/su.exec(rest);
    if (!match) fail("Malformed SVG attribute.");
    // Later duplicates are ignored, as browsers do.
    if (attrs[match[1]] === undefined) attrs[match[1]] = decodeXml(match[3]);
    rest = rest.slice(match[0].length);
  }
  return attrs;
}

/** A bounded XML reader. Builds a plain tree; never evaluates markup. */
function readSvgTree(svg: string): SvgNode {
  const source = svg
    .replace(/^﻿/u, "")
    .replace(/<\?[\s\S]*?\?>/gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!DOCTYPE[^>[]*>/iu, "");
  if (/<!DOCTYPE|<!ENTITY/iu.test(source))
    fail("SVG entity declarations are unsupported.");
  const root: SvgNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let at = 0,
    count = 0;
  while (at < source.length) {
    const open = source.indexOf("<", at);
    const text = source.slice(at, open < 0 ? source.length : open);
    if (text.trim()) stack.at(-1)!.text += decodeXml(text);
    if (open < 0) break;
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      if (end < 0) fail("Unclosed SVG CDATA section.");
      stack.at(-1)!.text += source.slice(open + 9, end);
      at = end + 3;
      continue;
    }
    let end = open + 1,
      quote = "";
    for (; end < source.length; end++) {
      const c = source[end];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (end === source.length) fail("Unclosed SVG tag.");
    const tagText = source.slice(open + 1, end);
    at = end + 1;
    const closing = /^\/([a-zA-Z][\w:.-]*)\s*$/u.exec(tagText);
    if (closing) {
      if (stack.length < 2 || stack.pop()!.tag !== closing[1])
        fail("Mismatched SVG closing tag.");
      continue;
    }
    const match = /^([a-zA-Z][\w:.-]*)([\s\S]*?)(\/?)\s*$/u.exec(tagText);
    if (!match) fail("Malformed SVG structure.");
    if (++count > 20000) fail("This SVG has too many elements to import.");
    const node: SvgNode = {
      tag: match[1],
      attrs: attributes(match[2]),
      children: [],
      text: "",
    };
    stack.at(-1)!.children.push(node);
    if (!match[3]) {
      if (stack.length > 64) fail("SVG nesting is limited to 64 levels.");
      stack.push(node);
    }
  }
  if (stack.length !== 1) fail("SVG must be complete: a tag is never closed.");
  const svgRoot = root.children.find((n) => n.tag === "svg");
  if (!svgRoot || root.children.some((n) => n !== svgRoot && n.tag !== "svg"))
    fail("SVG import needs an svg root.");
  return svgRoot;
}

const cssColors: Record<string, string> = Object.fromEntries(
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32"
    .split(" ")
    .reduce<string[][]>(
      (pairs, word, i, all) => (i % 2 ? pairs : [...pairs, [word, all[i + 1]]]),
      [],
    )
    .map(([name, hex]) => [name, `#${hex}`]),
);
const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");
function channel(value: string, max: number) {
  const text = value.trim();
  const n = text.endsWith("%")
    ? (Number(text.slice(0, -1)) / 100) * max
    : Number(text);
  if (!Number.isFinite(n)) fail("Invalid SVG color.");
  return n;
}
/** CSS color text as #rrggbb or #rrggbbaa, or undefined when it is not a color. */
export function svgColor(value: string): string | undefined {
  const text = value.trim().toLowerCase();
  if (text === "none" || text === "transparent") return "transparent";
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/u.test(text)) {
    let hex = text.slice(1);
    if (hex.length <= 4) hex = [...hex].map((n) => n + n).join("");
    return `#${hex.endsWith("ff") && hex.length === 8 ? hex.slice(0, 6) : hex}`;
  }
  if (cssColors[text]) return cssColors[text];
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/u.exec(text);
  if (!fn) return undefined;
  const parts = fn[2]
    .replace(/\s*\/\s*/u, ",")
    .split(/\s*,\s*|\s+/u)
    .filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const alpha = parts[3] === undefined ? 1 : channel(parts[3], 1);
  let rgb: number[];
  if (fn[1].startsWith("rgb"))
    rgb = parts.slice(0, 3).map((p) => channel(p, 255));
  else {
    const h =
        (((Number(parts[0].replace(/deg$/u, "")) % 360) + 360) % 360) / 360,
      s = channel(parts[1], 1),
      l = channel(parts[2], 1);
    if (!Number.isFinite(h)) return undefined;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
      p = 2 * l - q;
    const hue = (t: number) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    rgb = [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((n) => n * 255);
  }
  const a = Math.min(1, Math.max(0, alpha));
  return `#${rgb.map(hex2).join("")}${a < 1 ? hex2(a * 255) : ""}`;
}
function withAlpha(paint: string, opacity: number) {
  if (paint === "transparent" || opacity >= 1) return paint;
  const hex = paint.slice(1);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  return `#${hex.slice(0, 6)}${hex2(alpha * opacity * 255)}`;
}
function splitAlpha(paint: string): [string, number] {
  if (paint.length !== 9) return [paint, 1];
  return [paint.slice(0, 7), Number.parseInt(paint.slice(7), 16) / 255];
}

type CssRule = {
  selector: { tag?: string; id?: string; classes: string[] };
  specificity: number;
  order: number;
  declarations: Record<string, string>;
};
function declarations(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const declaration of text.split(";")) {
    const pair = /^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*(?:!important)?\s*$/u.exec(
      declaration,
    );
    if (pair) result[pair[1].toLowerCase()] = pair[2];
  }
  return result;
}
/** Simple selectors only (tag, .class, #id and combinations); others are skipped. */
function stylesheet(text: string, warnings: Set<string>): CssRule[] {
  const rules: CssRule[] = [];
  let rest = text.replace(/\/\*[\s\S]*?\*\//gu, "");
  let order = 0;
  while (rest.trim()) {
    const open = rest.indexOf("{");
    if (open < 0) break;
    const prelude = rest.slice(0, open).trim();
    let depth = 1,
      at = open + 1;
    for (; at < rest.length && depth; at++)
      depth += rest[at] === "{" ? 1 : rest[at] === "}" ? -1 : 0;
    const body = rest.slice(open + 1, at - 1);
    rest = rest.slice(at);
    if (prelude.startsWith("@")) continue;
    const decls = declarations(body);
    for (const raw of prelude.split(",")) {
      const selector = raw.trim();
      const match = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/u.exec(selector);
      if (!match || !selector) {
        warnings.add("Some advanced CSS rules in the SVG were skipped.");
        continue;
      }
      const parts = match[2].match(/[.#][\w-]+/gu) ?? [];
      const id = parts.find((p) => p[0] === "#")?.slice(1);
      const classes = parts.filter((p) => p[0] === ".").map((p) => p.slice(1));
      rules.push({
        selector: {
          tag: match[1] && match[1] !== "*" ? match[1] : undefined,
          id,
          classes,
        },
        specificity:
          (id ? 100 : 0) +
          classes.length * 10 +
          (match[1] && match[1] !== "*" ? 1 : 0),
        order: order++,
        declarations: decls,
      });
    }
  }
  return rules.sort(
    (a, b) => a.specificity - b.specificity || a.order - b.order,
  );
}

const inherited = [
  "fill",
  "stroke",
  "stroke-width",
  "fill-opacity",
  "stroke-opacity",
  "fill-rule",
  "stroke-linecap",
  "stroke-linejoin",
  "color",
  "visibility",
];
const styleProperties = [
  ...inherited,
  "opacity",
  "display",
  "filter",
  "mask",
  "clip-path",
  "stroke-dasharray",
  "stop-color",
  "stop-opacity",
  "mix-blend-mode",
];
type Style = Record<string, string>;

type Paint =
  | { kind: "none" }
  | { kind: "color"; color: string }
  | { kind: "gradient"; gradient: VectorGradient; fallback: string };

const lengthUnits: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
  em: 16,
  rem: 16,
  ex: 8,
};

/** Parses an SVG into editable path layers: the subset Cutline can draw and animate. */
export function parseEditableSvg(svg: string): ParsedEditableSvg {
  if (typeof svg !== "string" || svg.length > 1048576)
    fail("SVG import supports at most 1 MiB of text.");
  const root = readSvgTree(svg);
  const warnings = new Set<string>();
  const ids = new Map<string, SvgNode>();
  const css: string[] = [];
  const walkAll = (node: SvgNode) => {
    if (node.attrs.id && !ids.has(node.attrs.id)) ids.set(node.attrs.id, node);
    if (node.tag === "style") css.push(node.text);
    node.children.forEach(walkAll);
  };
  walkAll(root);
  const rules = stylesheet(css.join("\n"), warnings);

  // Root viewport.
  const length = (value: string | undefined, basis: number, fallback = 0) => {
    if (value === undefined || value.trim() === "") return fallback;
    const match =
      /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(%|[a-z]*)\s*$/u.exec(
        value,
      );
    if (!match) fail(`Invalid SVG length ${value.slice(0, 40)}.`);
    const n = Number(match[1]);
    const unit = match[2];
    const result =
      unit === "%" ? (n / 100) * basis : n * (lengthUnits[unit] ?? NaN);
    if (!bounded(result)) fail(`Unsupported SVG length ${value.slice(0, 40)}.`);
    return result;
  };
  let viewBox: VectorViewBox;
  const rootBox = root.attrs.viewBox ?? root.attrs.viewbox;
  if (rootBox !== undefined) {
    viewBox = numberList(rootBox) as VectorViewBox;
    validateVectorViewBox(viewBox);
  } else viewBox = [0, 0, 0, 0];
  const size = (key: "width" | "height", index: 2 | 3, fallback: number) => {
    const value = root.attrs[key];
    if (value === undefined || /%\s*$/u.test(value))
      return viewBox[index] || fallback;
    const n = length(value, 0);
    if (!(n > 0)) fail("SVG dimensions must be positive.");
    return n;
  };
  const width = size("width", 2, 300),
    height = size("height", 3, 150);
  if (rootBox === undefined) viewBox = [0, 0, width, height];
  const aspectRatio: "meet" | "none" =
    root.attrs.preserveAspectRatio?.trim() === "none" ? "none" : "meet";
  const [, , vbw, vbh] = viewBox;
  const diagonal = Math.hypot(vbw, vbh) / Math.SQRT2;
  const basisFor = (key: string) =>
    /^(x|x1|x2|cx|fx|rx|width|dx)$/u.test(key)
      ? vbw
      : /^(y|y1|y2|cy|fy|ry|height|dy)$/u.test(key)
        ? vbh
        : diagonal;

  const styleOf = (node: SvgNode, parent: Style): Style => {
    const own: Style = {};
    for (const key of styleProperties)
      if (node.attrs[key] !== undefined) own[key] = node.attrs[key].trim();
    const classes = (node.attrs.class ?? "").split(/\s+/u).filter(Boolean);
    for (const rule of rules) {
      const s = rule.selector;
      if (s.tag && s.tag !== node.tag) continue;
      if (s.id && s.id !== node.attrs.id) continue;
      if (!s.classes.every((c) => classes.includes(c))) continue;
      Object.assign(own, rule.declarations);
    }
    if (node.attrs.style) Object.assign(own, declarations(node.attrs.style));
    const style: Style = {};
    for (const key of inherited)
      if (parent[key] !== undefined) style[key] = parent[key];
    for (const [key, value] of Object.entries(own))
      if (value !== "inherit") style[key] = value;
    return style;
  };
  const number = (value: string | undefined, fallback: number, max = 1) => {
    if (value === undefined) return fallback;
    const text = value.trim();
    const n = text.endsWith("%")
      ? Number(text.slice(0, -1)) / 100
      : Number(text);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : fallback;
  };

  // Gradients, with href inheritance (Illustrator and Inkscape chain them).
  const gradientCache = new Map<string, VectorGradient | null>();
  const gradient = (
    id: string,
    seen = new Set<string>(),
  ): VectorGradient | null => {
    if (gradientCache.has(id)) return gradientCache.get(id)!;
    const node = ids.get(id);
    if (!node || !/^(linear|radial)Gradient$/u.test(node.tag) || seen.has(id))
      return null;
    seen.add(id);
    const href = (node.attrs.href ?? node.attrs["xlink:href"])?.trim();
    const base = href?.startsWith("#") ? gradient(href.slice(1), seen) : null;
    const type = node.tag === "linearGradient" ? "linear" : "radial";
    const units =
      node.attrs.gradientUnits === "userSpaceOnUse"
        ? "userSpaceOnUse"
        : node.attrs.gradientUnits === "objectBoundingBox"
          ? "objectBoundingBox"
          : (base?.units ?? "objectBoundingBox");
    const coordinate = (
      key: keyof VectorGradient & string,
      fallback: number,
    ) => {
      const value = node.attrs[key];
      if (value === undefined)
        return (
          (base?.type === type
            ? (base[key] as number | undefined)
            : undefined) ?? fallback
        );
      if (units === "objectBoundingBox") {
        const text = value.trim();
        return text.endsWith("%")
          ? Number(text.slice(0, -1)) / 100
          : Number(text);
      }
      return length(value, basisFor(key));
    };
    const stops: VectorGradientStop[] = [];
    for (const child of node.children) {
      if (child.tag !== "stop") continue;
      const style = styleOf(child, {});
      const color = svgColor(style["stop-color"] ?? "black") ?? "#000000";
      const [solid, alpha] = splitAlpha(
        color === "transparent" ? "#00000000" : color,
      );
      stops.push({
        offset: Math.max(
          stops.at(-1)?.offset ?? 0,
          number(child.attrs.offset, 0),
        ),
        color: solid,
        opacity: alpha * number(style["stop-opacity"], 1),
      });
      if (stops.length >= 16) break;
    }
    const result: VectorGradient = {
      type,
      units,
      spread:
        (node.attrs.spreadMethod as VectorGradient["spread"]) ??
        base?.spread ??
        "pad",
      stops: stops.length ? stops : (base?.stops ?? []),
      ...(type === "linear"
        ? {
            x1: coordinate("x1", 0),
            y1: coordinate("y1", 0),
            x2: coordinate("x2", units === "objectBoundingBox" ? 1 : vbw),
            y2: coordinate("y2", 0),
          }
        : (() => {
            const cx = coordinate(
                "cx",
                units === "objectBoundingBox" ? 0.5 : vbw / 2,
              ),
              cy = coordinate(
                "cy",
                units === "objectBoundingBox" ? 0.5 : vbh / 2,
              );
            return {
              cx,
              cy,
              r: coordinate(
                "r",
                units === "objectBoundingBox" ? 0.5 : diagonal / 2,
              ),
              fx: coordinate("fx", cx),
              fy: coordinate("fy", cy),
            };
          })()),
    };
    if (!["pad", "reflect", "repeat"].includes(result.spread))
      result.spread = "pad";
    const transform = node.attrs.gradientTransform
      ? parseVectorTransform(node.attrs.gradientTransform)
      : base?.transform;
    if (transform) result.transform = transform;
    const values = [
      result.x1,
      result.y1,
      result.x2,
      result.y2,
      result.cx,
      result.cy,
      result.r,
      result.fx,
      result.fy,
    ];
    const valid =
      values.every((n) => n === undefined || bounded(n)) &&
      result.stops.length > 0;
    gradientCache.set(id, valid ? result : null);
    return valid ? result : null;
  };
  const mixStops = (stops: VectorGradientStop[]) => {
    const middle = stops[Math.floor((stops.length - 1) / 2)];
    return withAlpha(middle.color, middle.opacity);
  };
  const paint = (value: string | undefined, style: Style): Paint => {
    if (value === undefined) return { kind: "color", color: "#000000" };
    const text = value.trim();
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)\s*(.*)$/u.exec(text);
    if (url) {
      const found = gradient(url[1]);
      const fallback = url[2] ? svgColor(url[2]) : undefined;
      if (found) {
        if (found.stops.length === 1)
          return {
            kind: "color",
            color: withAlpha(found.stops[0].color, found.stops[0].opacity),
          };
        return {
          kind: "gradient",
          gradient: found,
          fallback: mixStops(found.stops),
        };
      }
      warnings.add("Pattern fills were replaced with a solid color.");
      return { kind: "color", color: fallback ?? "#808080" };
    }
    if (/^currentcolor$/iu.test(text)) return paint(style.color ?? "black", {});
    const color = svgColor(text);
    if (color === undefined) {
      warnings.add(`Unknown SVG color ${text.slice(0, 30)} was drawn black.`);
      return { kind: "color", color: "#000000" };
    }
    return color === "transparent"
      ? { kind: "none" }
      : { kind: "color", color };
  };

  const layers: VectorPathDefinition[] = [];
  const geometryTags = [
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polygon",
    "polyline",
  ];
  const skipped: Record<string, string> = {
    text: "Text was left out. Add words as Cutline titles so they stay sharp and editable.",
    image: "Embedded images were left out.",
    foreignObject: "Embedded HTML was left out.",
    video: "Embedded video was left out.",
    script: "",
    style: "",
    defs: "",
    title: "",
    desc: "",
    metadata: "",
    linearGradient: "",
    radialGradient: "",
    clipPath: "",
    mask: "",
    filter: "",
    pattern: "",
    marker: "",
    symbol: "",
  };
  const viewportMatrix = (
    box: number[] | undefined,
    x: number,
    y: number,
    w: number,
    h: number,
    preserve: string | undefined,
  ): VectorMatrix => {
    if (
      !box ||
      box.length !== 4 ||
      box[2] <= 0 ||
      box[3] <= 0 ||
      !(w > 0) ||
      !(h > 0)
    )
      return [1, 0, 0, 1, x, y];
    let sx = w / box[2],
      sy = h / box[3],
      tx = x,
      ty = y;
    if (preserve?.trim() !== "none") {
      const s = Math.min(sx, sy);
      tx += (w - box[2] * s) / 2;
      ty += (h - box[3] * s) / 2;
      sx = sy = s;
    }
    return [sx, 0, 0, sy, tx - box[0] * sx, ty - box[1] * sy];
  };
  let expanded = 0;
  const visit = (
    node: SvgNode,
    parentStyle: Style,
    parentMatrix: VectorMatrix,
    parentOpacity: number,
    using: Set<string>,
  ) => {
    if (++expanded > 40000) fail("This SVG expands to too many elements.");
    const tag = node.tag;
    if (tag.includes(":")) return; // Editor metadata such as sodipodi:namedview.
    if (tag in skipped) {
      if (skipped[tag]) warnings.add(skipped[tag]);
      return;
    }
    const style = styleOf(node, parentStyle);
    if (style.display?.trim() === "none") return;
    let matrix = multiplyVectorMatrices(
      parentMatrix,
      node.attrs.transform
        ? parseVectorTransform(node.attrs.transform)
        : identity,
    );
    const opacity = parentOpacity * number(style.opacity, 1);
    if (opacity <= 0) return;
    if (style.filter && style.filter !== "none")
      warnings.add(
        "Filters such as blur and drop shadow were left out. Use Cutline's layer blur and glow instead.",
      );
    if (style.mask && style.mask !== "none")
      warnings.add("Masks were left out.");
    if (style["clip-path"] && style["clip-path"] !== "none")
      warnings.add(
        "Clipping paths were left out, so shapes may extend past their frame.",
      );
    if (style["mix-blend-mode"] && style["mix-blend-mode"] !== "normal")
      warnings.add("Blend modes were drawn as normal.");

    if (tag === "use") {
      const href = (node.attrs.href ?? node.attrs["xlink:href"])?.trim();
      const target = href?.startsWith("#") ? ids.get(href.slice(1)) : undefined;
      if (!target || using.has(href!) || using.size > 16) {
        warnings.add("A reused element could not be found and was left out.");
        return;
      }
      matrix = multiplyVectorMatrices(matrix, [
        1,
        0,
        0,
        1,
        length(node.attrs.x, vbw),
        length(node.attrs.y, vbh),
      ]);
      const next = new Set(using).add(href!);
      if (target.tag === "symbol" || target.tag === "svg") {
        const box =
          (target.attrs.viewBox ?? target.attrs.viewbox)
            ? numberList(target.attrs.viewBox ?? target.attrs.viewbox)
            : undefined;
        const inner = multiplyVectorMatrices(
          matrix,
          viewportMatrix(
            box,
            0,
            0,
            length(node.attrs.width ?? target.attrs.width, vbw, box?.[2] ?? 0),
            length(
              node.attrs.height ?? target.attrs.height,
              vbh,
              box?.[3] ?? 0,
            ),
            target.attrs.preserveAspectRatio,
          ),
        );
        const targetStyle = styleOf(target, style);
        for (const child of target.children)
          visit(child, targetStyle, inner, opacity, next);
      } else visit(target, style, matrix, opacity, next);
      return;
    }
    if (tag === "svg" && node !== root) {
      const box =
        (node.attrs.viewBox ?? node.attrs.viewbox)
          ? numberList(node.attrs.viewBox ?? node.attrs.viewbox)
          : undefined;
      matrix = multiplyVectorMatrices(
        matrix,
        viewportMatrix(
          box,
          length(node.attrs.x, vbw),
          length(node.attrs.y, vbh),
          length(node.attrs.width, vbw, box?.[2] ?? vbw),
          length(node.attrs.height, vbh, box?.[3] ?? vbh),
          node.attrs.preserveAspectRatio,
        ),
      );
    }
    if (!geometryTags.includes(tag)) {
      if (!["svg", "g", "a", "switch"].includes(tag)) {
        warnings.add(`Unsupported SVG element ${tag} was left out.`);
        return;
      }
      for (const child of node.children)
        visit(child, style, matrix, opacity, using);
      return;
    }
    if (style.visibility === "hidden" || style.visibility === "collapse")
      return;
    if (style["stroke-dasharray"] && style["stroke-dasharray"] !== "none")
      warnings.add("Dashed outlines were drawn solid.");
    const d = geometry(tag, node.attrs, length, basisFor);
    if (!d) return;
    validateVectorPath(d);
    // A line encloses nothing, so only its outline can show.
    const fill: Paint =
      tag === "line" ? { kind: "none" } : paint(style.fill, style);
    const stroke = paint(style.stroke ?? "none", style);
    const strokeWidth = length(style["stroke-width"], diagonal, 1);
    const fillOpacity = number(style["fill-opacity"], 1);
    const strokeOpacity = number(style["stroke-opacity"], 1);
    if (fill.kind === "none" && (stroke.kind === "none" || strokeWidth <= 0))
      return;
    const fillRule = style["fill-rule"] === "evenodd" ? "evenodd" : "nonzero";
    const lineCap = (
      ["butt", "round", "square"].includes(style["stroke-linecap"])
        ? style["stroke-linecap"]
        : "butt"
    ) as VectorPathDefinition["vectorLineCap"];
    const lineJoin = (
      ["miter", "round", "bevel"].includes(style["stroke-linejoin"])
        ? style["stroke-linejoin"]
        : "miter"
    ) as VectorPathDefinition["vectorLineJoin"];
    const strokeColor =
      stroke.kind === "none"
        ? "transparent"
        : stroke.kind === "gradient"
          ? stroke.fallback
          : stroke.color;
    if (stroke.kind === "gradient")
      warnings.add("Gradient outlines were drawn in a solid color.");
    layers.push({
      type: "path",
      name: (
        node.attrs["data-name"] ??
        node.attrs["inkscape:label"] ??
        node.attrs["aria-label"] ??
        node.attrs.id ??
        `${tag === "path" ? "Path" : tag[0].toUpperCase() + tag.slice(1)} ${layers.length + 1}`
      ).slice(0, 80),
      vectorPath: d,
      vectorViewBox: [...viewBox],
      ...(matrix.some((v, i) => v !== identity[i])
        ? { vectorTransform: matrix }
        : {}),
      vectorFillRule: fillRule,
      vectorLineCap: lineCap,
      vectorLineJoin: lineJoin,
      vectorAspectRatio: aspectRatio,
      background:
        fill.kind === "none"
          ? "transparent"
          : fill.kind === "gradient"
            ? splitAlpha(fill.fallback)[0]
            : fill.color,
      ...(fill.kind === "gradient" ? { vectorGradient: fill.gradient } : {}),
      stroke: withAlpha(strokeColor, strokeOpacity),
      strokeWidth: stroke.kind === "none" ? 0 : strokeWidth,
      fillOpacity,
      opacity: Math.min(1, opacity),
    });
  };
  const rootStyle = styleOf(root, {});
  if (number(rootStyle.opacity, 1) <= 0)
    fail("SVG must contain at least one visible shape.");
  for (const child of root.children)
    visit(child, rootStyle, identity, number(rootStyle.opacity, 1), new Set());
  if (!layers.length)
    fail(
      "SVG must contain at least one visible shape (paths, rectangles, circles, polygons or lines).",
    );
  const fitted = mergeToFit(layers);
  if (fitted.length < layers.length)
    warnings.add(
      `Shapes that share a color were combined so the vector fits ${MAX_VECTOR_LAYERS} layers.`,
    );
  if (fitted.length > MAX_VECTOR_LAYERS)
    fail(
      `This SVG has ${fitted.length} separately styled shapes. Cutline keeps up to ${MAX_VECTOR_LAYERS}; simplify it (fewer colors or merged shapes) and import again.`,
    );
  return {
    viewBox,
    width,
    height,
    layers: fitted,
    ...(warnings.size ? { warnings: [...warnings] } : {}),
  };
}

function geometry(
  tag: string,
  attrs: Record<string, string>,
  length: (
    value: string | undefined,
    basis: number,
    fallback?: number,
  ) => number,
  basisFor: (key: string) => number,
): string | undefined {
  const n = (key: string, fallback = 0) =>
    length(attrs[key], basisFor(key), fallback);
  if (tag === "path") return attrs.d?.trim() ? attrs.d : undefined;
  if (tag === "line") return `M${n("x1")} ${n("y1")}L${n("x2")} ${n("y2")}`;
  if (tag === "polygon" || tag === "polyline") {
    const nums = numberList(attrs.points ?? "");
    if (nums.length < 4) return undefined;
    const pairs = nums.slice(0, nums.length - (nums.length % 2));
    return `M${pairs.slice(0, 2).join(" ")}L${pairs.slice(2).join(" ")}${tag === "polygon" ? "Z" : ""}`;
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = n("cx"),
      cy = n("cy");
    let rx = tag === "circle" ? n("r") : n("rx", NaN),
      ry = tag === "circle" ? rx : n("ry", NaN);
    if (tag === "ellipse") {
      if (Number.isNaN(rx)) rx = ry;
      if (Number.isNaN(ry)) ry = rx;
    }
    if (!(rx > 0) || !(ry > 0)) return undefined;
    return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
  }
  const x = n("x"),
    y = n("y"),
    w = n("width"),
    h = n("height");
  if (!(w > 0) || !(h > 0)) return undefined;
  const rxRaw =
      attrs.rx !== undefined ? n("rx") : attrs.ry !== undefined ? n("ry") : 0,
    ryRaw = attrs.ry !== undefined ? n("ry") : rxRaw;
  const rx = Math.min(w / 2, Math.max(0, rxRaw)),
    ry = Math.min(h / 2, Math.max(0, ryRaw));
  if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
}

/** A path whose first move is absolute, so it can follow another path's text. */
function absoluteStart(path: string) {
  const segments = parseVectorPath(path);
  if (segments[0].command === "M") return path;
  return segments
    .map((s, i) => `${i === 0 ? "M" : s.command}${s.values.join(" ")}`)
    .join("");
}
/**
 * Too many layers: join neighbours that draw identically into one compound path,
 * which renders the same and keeps stacking order. Even-odd fills never merge,
 * since joining them would punch holes where the shapes overlap.
 */
function mergeToFit(layers: VectorPathDefinition[]) {
  if (layers.length <= MAX_VECTOR_LAYERS) return layers;
  const key = (l: VectorPathDefinition) =>
    JSON.stringify({ ...l, name: undefined, vectorPath: undefined });
  const result: VectorPathDefinition[] = [];
  for (const layer of layers) {
    const last = result.at(-1);
    if (
      last &&
      layer.vectorFillRule === "nonzero" &&
      key(last) === key(layer) &&
      last.vectorPath.length + layer.vectorPath.length + 1 <=
        MAX_VECTOR_PATH_LENGTH
    ) {
      result[result.length - 1] = {
        ...last,
        vectorPath: `${last.vectorPath} ${absoluteStart(layer.vectorPath)}`,
      };
    } else result.push(layer);
  }
  return result;
}
