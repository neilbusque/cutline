/**
 * Lifts a generated picture off the flat color it was painted on, so it sits
 * on video like a sticker. Higgsfield's image models return opaque pictures:
 * Cutline asks for a backdrop color the subject does not use, then removes it
 * here with a soft, color-cleaned edge.
 */

export type Rgb = readonly [number, number, number];

/** Backdrops a picture can be painted on, in order of preference. */
export const backdrops = [
  { name: "magenta", rgb: [255, 0, 255] as Rgb },
  { name: "green", rgb: [0, 255, 0] as Rgb },
  { name: "blue", rgb: [0, 0, 255] as Rgb },
] as const;
export type Backdrop = (typeof backdrops)[number];

// Color words a request can use, mapped to a typical shade of each.
const colorWords: [RegExp, Rgb][] = [
  [/\b(pink|magenta|fuchsia|purple|violet|lilac|lavender|plum)\b/iu, [214, 60, 200]],
  [/\b(green|lime|emerald|mint|olive|jade|forest|leaf|grass)\b/iu, [70, 180, 80]],
  [/\b(blue|navy|cobalt|azure|indigo|sapphire|ocean|sea|sky)\b/iu, [50, 90, 220]],
  [/\b(cyan|teal|turquoise|aqua)\b/iu, [40, 190, 200]],
];

export function hexRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const linear = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** CIELAB (D65) of an sRGB color: distances in it follow what people see. */
export function lab(r: number, g: number, b: number): [number, number, number] {
  const R = linear[r],
    G = linear[g],
    B = linear[b];
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const deltaE = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The first backdrop clearly apart from every color the request names or the
 * palette keeps, so removing it never eats part of the subject. When all are
 * close to something, the one furthest away.
 */
export function chooseBackdrop(prompt: string, palette: string[] = []): Backdrop {
  const avoid = [
    ...palette.map(hexRgb),
    ...colorWords.filter(([word]) => word.test(prompt)).map(([, rgb]) => rgb),
  ].map((c) => lab(...c));
  const nearest = (option: Backdrop) =>
    Math.min(Infinity, ...avoid.map((c) => deltaE(c, lab(...option.rgb))));
  return (
    backdrops.find((option) => nearest(option) > 60) ??
    [...backdrops].sort((a, b) => nearest(b) - nearest(a))[0]
  );
}

export type Cutout = {
  /** RGBA, cropped to the subject with a small margin. */
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /** Share of the original picture that stayed visible, 0 to 1. */
  kept: number;
  /** The backdrop color actually found along the edges. */
  backdrop: Rgb;
  /** False when no flat backdrop surrounds the subject; pixels are then unchanged. */
  ok: boolean;
};

// ΔE thresholds: a pixel this close to the backdrop is backdrop.
const HOLE = 9; // enclosed gaps must match tightly to be removed
const FILL = 22; // the outside backdrop, reached from the edges

/**
 * Removes the flat backdrop around a subject. The backdrop is measured on the
 * picture's border (a model may paint a slightly different shade than asked),
 * flooded in from the edges, enclosed gaps of the exact color are cleared too,
 * and the outline is softened with the backdrop's tint taken back out.
 */
export function liftFromBackdrop(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Cutout {
  const n = width * height;
  const unchanged = (backdrop: Rgb): Cutout => ({
    pixels: Uint8ClampedArray.from(rgba),
    width,
    height,
    kept: 1,
    backdrop,
    ok: false,
  });
  if (!(width > 2 && height > 2) || rgba.length < n * 4) return unchanged([0, 0, 0]);

  // 1. The backdrop: the median of the border, if most of the border agrees.
  const border: number[] = [];
  const edge = (x: number, y: number) => border.push((y * width + x) * 4);
  for (let x = 0; x < width; x++) edge(x, 0), edge(x, height - 1);
  for (let y = 1; y < height - 1; y++) edge(0, y), edge(width - 1, y);
  const median = (channel: number) => {
    const values = border.map((i) => rgba[i + channel]).sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  const backdrop: Rgb = [median(0), median(1), median(2)];
  const key = lab(...backdrop);
  const distance = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4)
    distance[p] = deltaE(lab(rgba[i], rgba[i + 1], rgba[i + 2]), key);
  const agreeing = border.filter((i) => distance[i / 4] < FILL).length;
  if (agreeing < border.length * 0.6) return unchanged(backdrop);

  // 2. Flood the outside backdrop in from every edge pixel that matches it.
  const clear = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0,
    tail = 0;
  const visit = (p: number) => {
    if (!clear[p] && distance[p] < FILL) {
      clear[p] = 1;
      queue[tail++] = p;
    }
  };
  for (const i of border) visit(i / 4);
  while (head < tail) {
    const p = queue[head++],
      x = p % width;
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (p >= width) visit(p - width);
    if (p < n - width) visit(p + width);
  }

  // 3. Enclosed gaps (inside a handle, between letters of a shape) count only
  // when they are the backdrop's exact color and big enough to be a gap.
  const seen = new Uint8Array(n);
  const minimum = Math.max(24, Math.round(n * 0.0004));
  for (let start = 0; start < n; start++) {
    if (clear[start] || seen[start] || distance[start] >= HOLE) continue;
    head = tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const p = queue[head++],
        x = p % width;
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        p >= width ? p - width : -1,
        p < n - width ? p + width : -1,
      ])
        if (q >= 0 && !seen[q] && !clear[q] && distance[q] < HOLE) {
          seen[q] = 1;
          queue[tail++] = q;
        }
    }
    if (tail >= minimum) for (let k = 0; k < tail; k++) clear[queue[k]] = 1;
  }

  // 4. Soften the outline: a pixel beside the backdrop is a blend of the
  // subject color next to it and the backdrop, so its opacity is where it sits
  // between the two, and the backdrop's share is taken back out of its color.
  const out = Uint8ClampedArray.from(rgba);
  /** The most subject-like pixel around p, or -1 when p is not on the outline. */
  const outline = (p: number) => {
    const x = p % width,
      y = (p / width) | 0;
    let touches = false,
      subject = -1;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (clear[q]) touches = true;
        else if (subject < 0 || distance[q] > distance[subject]) subject = q;
      }
    return touches ? subject : -1;
  };
  /** How much of the subject color a blended pixel holds, 0 to 1. */
  const coverage = (i: number, s: number) => {
    let along = 0,
      length = 0;
    for (let c = 0; c < 3; c++) {
      const toSubject = rgba[s + c] - backdrop[c];
      along += (rgba[i + c] - backdrop[c]) * toSubject;
      length += toSubject * toSubject;
    }
    return length ? Math.min(1, Math.max(0, along / length)) : 1;
  };
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1,
    visible = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (clear[p]) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      continue;
    }
    let alpha = rgba[i + 3] / 255;
    const subject = outline(p);
    const share =
      subject >= 0 && distance[subject] > distance[p]
        ? coverage(i, subject * 4)
        : 1;
    // Nearly whole pixels stay whole, so a dark outline beside a light fill
    // never turns faintly see-through.
    if (share < 0.92) {
      alpha *= share;
      if (share > 0)
        for (let c = 0; c < 3; c++)
          out[i + c] = backdrop[c] + (rgba[i + c] - backdrop[c]) / share;
    }
    out[i + 3] = Math.round(alpha * 255);
    if (out[i + 3] > 8) {
      visible++;
      const x = p % width,
        y = (p / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const kept = visible / n;
  if (maxX < 0 || kept > 0.97) return unchanged(backdrop);

  // 5. Crop to the subject with a little air, so placing it sizes the subject.
  const margin = Math.round(Math.max(width, height) * 0.02);
  const x0 = Math.max(0, minX - margin),
    y0 = Math.max(0, minY - margin);
  const w = Math.min(width, maxX + margin + 1) - x0,
    h = Math.min(height, maxY + margin + 1) - y0;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    pixels.set(
      out.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4),
      y * w * 4,
    );
  return { pixels, width: w, height: h, kept, backdrop, ok: true };
}
