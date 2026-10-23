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
};
export type ParsedEditableSvg = {
  viewBox: VectorViewBox;
  width: number;
  height: number;
  layers: VectorPathDefinition[];
};
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
  if (typeof path !== "string" || !path.trim() || path.length > 16000)
    fail("Vector path must contain 1–16,000 characters.");
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
    if (segments.length > 4096)
      fail("A vector path supports at most 4,096 segments.");
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

function decodeXml(value: string) {
  return value.replace(/&([^;]*);/gu, (_, entity: string) => {
    const named: Record<string, string> = {
      amp: "&",
      quot: '"',
      apos: "'",
      lt: "<",
      gt: ">",
    };
    if (named[entity]) return named[entity];
    const numeric = /^#(?:x[0-9a-f]+|\d+)$/iu.test(entity)
      ? Number.parseInt(
          entity.slice(entity[1] === "x" ? 2 : 1),
          entity[1] === "x" ? 16 : 10,
        )
      : NaN;
    if (!Number.isInteger(numeric) || numeric < 32 || numeric > 0x10ffff)
      fail("Unsupported SVG entity.");
    return String.fromCodePoint(numeric);
  });
}
function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let rest = text;
  while (rest.trim()) {
    const match = /^\s+([\w:-]+)\s*=\s*(["'])(.*?)\2/su.exec(rest);
    if (!match || attrs[match[1]] !== undefined)
      fail("Malformed or duplicate SVG attribute.");
    attrs[match[1]] = decodeXml(match[3]);
    rest = rest.slice(match[0].length);
  }
  return attrs;
}
function color(value: string) {
  const text = value.trim().toLowerCase();
  if (text === "none" || text === "transparent") return "transparent";
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/u.test(text))
    return text;
  const names: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    gray: "#808080",
    grey: "#808080",
    yellow: "#ffff00",
  };
  if (names[text]) return names[text];
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/u.exec(text);
  if (rgb && rgb.slice(1).every((n) => Number(n) <= 255))
    return `#${rgb
      .slice(1)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")}`;
  return fail(
    "SVG paints must use solid hex/rgb colors or supported named colors; gradients and references are unsupported.",
  );
}
type Paint = {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  opacity: number;
  fillRule: "nonzero" | "evenodd";
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
};
const defaultPaint: Paint = {
  fill: "#000000",
  stroke: "transparent",
  strokeWidth: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
  opacity: 1,
  fillRule: "nonzero",
  lineCap: "butt",
  lineJoin: "miter",
};
const paintFields = [
  "fill",
  "stroke",
  "stroke-width",
  "fill-opacity",
  "stroke-opacity",
  "opacity",
  "fill-rule",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
];
function paint(parent: Paint, attrs: Record<string, string>): Paint {
  const styles = { ...attrs };
  if (attrs.style)
    for (const declaration of attrs.style.split(";")) {
      if (!declaration.trim()) continue;
      const pair = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/u.exec(declaration);
      if (!pair || !paintFields.includes(pair[1]))
        fail(
          "SVG inline styles support only solid fill/stroke/opacity properties.",
        );
      styles[pair[1]] = pair[2];
    }
  const next = { ...parent, opacity: 1 };
  if (styles.fill !== undefined) next.fill = color(styles.fill);
  if (styles.stroke !== undefined) next.stroke = color(styles.stroke);
  for (const [key, field] of [
    ["stroke-width", "strokeWidth"],
    ["fill-opacity", "fillOpacity"],
    ["stroke-opacity", "strokeOpacity"],
    ["opacity", "opacity"],
  ] as const) {
    if (styles[key] === undefined) continue;
    const n = Number(styles[key]);
    if (!bounded(n) || n < 0 || n > (field === "strokeWidth" ? 100 : 1))
      fail(`SVG ${key} is outside editable bounds.`);
    next[field] = n;
  }
  if (styles["fill-rule"] !== undefined) {
    if (!["nonzero", "evenodd"].includes(styles["fill-rule"]))
      fail("Unsupported SVG fill rule.");
    next.fillRule = styles["fill-rule"] as Paint["fillRule"];
  }
  if (styles["stroke-linecap"] !== undefined) {
    if (!["butt", "round", "square"].includes(styles["stroke-linecap"]))
      fail("Unsupported SVG line cap.");
    next.lineCap = styles["stroke-linecap"] as Paint["lineCap"];
  }
  if (styles["stroke-linejoin"] !== undefined) {
    if (!["miter", "round", "bevel"].includes(styles["stroke-linejoin"]))
      fail("Unsupported SVG line join.");
    next.lineJoin = styles["stroke-linejoin"] as Paint["lineJoin"];
  }
  if (
    styles["stroke-miterlimit"] !== undefined &&
    Number(styles["stroke-miterlimit"]) !== 4
  )
    fail("Only the SVG default miter limit is supported.");
  return next;
}
function alphaColor(paint: string, opacity: number) {
  if (paint === "transparent" || opacity === 1) return paint;
  let hex = paint.slice(1);
  if (hex.length <= 4) hex = [...hex].map((n) => n + n).join("");
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  return `#${hex.slice(0, 6)}${Math.round(alpha * opacity * 255)
    .toString(16)
    .padStart(2, "0")}`;
}
function geometry(tag: string, attrs: Record<string, string>) {
  const n = (key: string, fallback = 0) => {
    const value = attrs[key] === undefined ? fallback : Number(attrs[key]);
    if (!bounded(value)) fail(`Invalid SVG ${key}.`);
    return value;
  };
  if (tag === "path") return attrs.d ?? fail("SVG path is missing d.");
  if (tag === "line") return `M${n("x1")} ${n("y1")}L${n("x2")} ${n("y2")}`;
  if (tag === "polygon" || tag === "polyline") {
    const nums = numberList(attrs.points ?? "");
    if (nums.length < 4 || nums.length % 2)
      fail("SVG polygon/polyline needs coordinate pairs.");
    return `M${nums.slice(0, 2).join(" ")}L${nums.slice(2).join(" ")}${tag === "polygon" ? "Z" : ""}`;
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = n("cx"),
      cy = n("cy"),
      rx = n(tag === "circle" ? "r" : "rx"),
      ry = tag === "circle" ? rx : n("ry");
    if (rx <= 0 || ry <= 0) fail("SVG circle/ellipse radii must be positive.");
    return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
  }
  const x = n("x"),
    y = n("y"),
    w = n("width"),
    h = n("height");
  if (w <= 0 || h <= 0) fail("SVG rectangle dimensions must be positive.");
  const rx = Math.min(w / 2, n("rx", n("ry"))),
    ry = Math.min(h / 2, n("ry", n("rx")));
  if (rx < 0 || ry < 0) fail("SVG rectangle radii cannot be negative.");
  if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
}

/** Bounded XML subset converted to editable path data. Never returns or executes markup. */
export function parseEditableSvg(svg: string): ParsedEditableSvg {
  if (typeof svg !== "string" || svg.length > 262144)
    fail("SVG import supports at most 256 KiB of text.");
  const source = svg
    .replace(/^\s*<\?xml\s[^?]*\?>/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  if (/<!|<\?/u.test(source))
    fail(
      "SVG declarations, entities and processing instructions are unsupported.",
    );
  const stack: { tag: string; paint: Paint; matrix: VectorMatrix }[] = [];
  const layers: VectorPathDefinition[] = [];
  let rootSeen = false,
    rootClosed = false,
    at = 0;
  let viewBox: VectorViewBox = [0, 0, 300, 150],
    width = 300,
    height = 150,
    aspectRatio: "meet" | "none" = "meet";
  const geometryFields: Record<string, string[]> = {
    path: ["d"],
    rect: ["x", "y", "width", "height", "rx", "ry"],
    circle: ["cx", "cy", "r"],
    ellipse: ["cx", "cy", "rx", "ry"],
    line: ["x1", "y1", "x2", "y2"],
    polygon: ["points"],
    polyline: ["points"],
  };
  while (at < source.length) {
    const open = source.indexOf("<", at);
    const text = source.slice(at, open < 0 ? source.length : open);
    if (text.trim() && !["title", "desc"].includes(stack.at(-1)?.tag ?? ""))
      fail("Unsupported text in SVG. Convert text to outlines first.");
    if (open < 0) break;
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
    const closing = /^\/([a-zA-Z][\w-]*)\s*$/u.exec(tagText);
    if (closing) {
      if (stack.pop()?.tag !== closing[1]) fail("Mismatched SVG closing tag.");
      if (!stack.length) rootClosed = true;
      continue;
    }
    const match = /^([a-zA-Z][\w-]*)([\s\S]*?)(\/?)\s*$/u.exec(tagText);
    if (!match || rootClosed) fail("Malformed SVG structure.");
    const [, tag, attrText, selfClosing] = match,
      attrs = attributes(attrText);
    if (["title", "desc"].includes(stack.at(-1)?.tag ?? ""))
      fail("SVG metadata must contain only text.");
    if (geometryFields[stack.at(-1)?.tag ?? ""])
      fail("SVG geometry cannot contain nested elements.");
    if (!rootSeen) {
      if (tag !== "svg") fail("SVG import needs an svg root.");
      rootSeen = true;
    } else if (tag === "svg") fail("Nested SVG viewports are unsupported.");
    if (
      !["svg", "g", "title", "desc", ...Object.keys(geometryFields)].includes(
        tag,
      )
    )
      fail(
        `Unsupported SVG element ${tag}. Convert it to paths with solid paints.`,
      );
    const allowed = [
      "id",
      "data-name",
      "aria-label",
      "transform",
      "style",
      ...paintFields,
      ...(geometryFields[tag] ?? []),
      ...(tag === "svg"
        ? [
            "xmlns",
            "xmlns:xlink",
            "viewBox",
            "width",
            "height",
            "version",
            "preserveAspectRatio",
          ]
        : []),
    ];
    for (const key of Object.keys(attrs))
      if (!allowed.includes(key))
        fail(
          `Unsupported SVG attribute ${key}. References, scripts and external content are not imported.`,
        );
    if (attrs.xmlns && attrs.xmlns !== "http://www.w3.org/2000/svg")
      fail("Unsupported SVG namespace.");
    if (
      attrs["xmlns:xlink"] &&
      attrs["xmlns:xlink"] !== "http://www.w3.org/1999/xlink"
    )
      fail("Unsupported SVG namespace.");
    if (tag === "svg") {
      const size = (key: string, fallback: number) => {
        if (attrs[key] === undefined) return fallback;
        const match = /^([\d.eE+-]+)(?:px)?$/u.exec(attrs[key].trim());
        const value = match ? Number(match[1]) : NaN;
        if (!bounded(value) || value <= 0)
          fail("SVG dimensions must be positive numbers or px values.");
        return value;
      };
      if (attrs.viewBox !== undefined) {
        const values = numberList(attrs.viewBox);
        viewBox = values as VectorViewBox;
        validateVectorViewBox(viewBox);
      }
      width = size("width", attrs.viewBox ? viewBox[2] : 300);
      height = size("height", attrs.viewBox ? viewBox[3] : 150);
      if (!attrs.viewBox) viewBox = [0, 0, width, height];
      if (
        attrs.preserveAspectRatio &&
        !["xMidYMid", "xMidYMid meet", "none"].includes(
          attrs.preserveAspectRatio.trim(),
        )
      )
        fail("Only centered SVG aspect ratio or none is supported.");
      aspectRatio =
        attrs.preserveAspectRatio?.trim() === "none" ? "none" : "meet";
    }
    const parent = stack.at(-1),
      style = paint(parent?.paint ?? defaultPaint, attrs);
    const matrix = multiplyVectorMatrices(
      parent?.matrix ?? identity,
      attrs.transform ? parseVectorTransform(attrs.transform) : identity,
    );
    if (["svg", "g"].includes(tag) && style.opacity !== 1)
      fail(
        "Group opacity must be flattened into individual paths before import.",
      );
    if (geometryFields[tag]) {
      const d = geometry(tag, attrs);
      validateVectorPath(d);
      if (layers.length >= 24)
        fail("An editable SVG supports at most 24 vector layers.");
      layers.push({
        type: "path",
        name: (
          attrs["data-name"] ??
          attrs["aria-label"] ??
          attrs.id ??
          `Path ${layers.length + 1}`
        ).slice(0, 80),
        vectorPath: d,
        vectorViewBox: [...viewBox],
        ...(matrix.some((v, i) => v !== identity[i])
          ? { vectorTransform: matrix }
          : {}),
        vectorFillRule: style.fillRule,
        vectorLineCap: style.lineCap,
        vectorLineJoin: style.lineJoin,
        vectorAspectRatio: aspectRatio,
        background: style.fill,
        stroke: alphaColor(style.stroke, style.strokeOpacity),
        strokeWidth: style.stroke === "transparent" ? 0 : style.strokeWidth,
        fillOpacity: style.fillOpacity,
        opacity: style.opacity,
      });
    }
    if (!selfClosing) {
      if (stack.length >= 32) fail("SVG nesting is limited to 32 levels.");
      stack.push({ tag, paint: style, matrix });
    } else if (tag === "svg") rootClosed = true;
  }
  if (!rootSeen || !rootClosed || stack.length || !layers.length)
    fail("SVG must be complete and contain at least one editable path.");
  return { viewBox, width, height, layers };
}
