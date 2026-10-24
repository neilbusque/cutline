import { describe, expect, it } from "vitest";
import { chooseBackdrop, liftFromBackdrop } from "../src/shared/cutout";

/** A magenta picture with a soft-edged ring, the kind a model paints. */
function painted() {
  const width = 120,
    height = 100,
    rgba = new Uint8ClampedArray(width * height * 4);
  const magenta = [255, 0, 255],
    teal = [20, 120, 110];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = Math.hypot(x - 60, y - 50);
      // A ring from radius 14 to 30 with a one pixel anti-aliased edge outside.
      const cover = r >= 14 && r <= 30 ? 1 : r > 30 && r < 31 ? 31 - r : 0;
      for (let c = 0; c < 3; c++)
        rgba[i + c] = Math.round(teal[c] * cover + magenta[c] * (1 - cover));
      rgba[i + 3] = 255;
    }
  // A tiny magenta detail inside the ring (an eye highlight) must survive.
  for (let y = 48; y < 51; y++)
    for (let x = 80; x < 83; x++) {
      const i = (y * width + x) * 4;
      rgba.set([255, 0, 255, 255], i);
    }
  return { rgba, width, height };
}

const pixel = (cut: ReturnType<typeof liftFromBackdrop>, x: number, y: number) =>
  Array.from(cut.pixels.subarray((y * cut.width + x) * 4, (y * cut.width + x) * 4 + 4));

describe("lifting a picture off its backdrop", () => {
  it("clears the backdrop and the enclosed gap, keeps small details, and crops", () => {
    const { rgba, width, height } = painted();
    const cut = liftFromBackdrop(rgba, width, height);
    expect(cut.ok).toBe(true);
    expect(cut.backdrop).toEqual([255, 0, 255]);
    // Cropped to the ring (diameter about 62) plus a 2% margin each side.
    expect(cut.width).toBeGreaterThanOrEqual(62);
    expect(cut.width).toBeLessThanOrEqual(70);
    expect(cut.height).toBeLessThanOrEqual(70);
    const ox = 60 - Math.floor(cut.width / 2),
      oy = 50 - Math.floor(cut.height / 2);
    const at = (x: number, y: number) => pixel(cut, x - ox, y - oy);
    // The hole in the middle of the ring is gone; the ring itself is solid.
    expect(at(60, 50)[3]).toBe(0);
    expect(at(60, 28)).toEqual([20, 120, 110, 255]);
    // The magenta highlight inside the ring stays opaque.
    expect(at(81, 49)[3]).toBe(255);
    // Corners are fully clear.
    expect(pixel(cut, 0, 0)[3]).toBe(0);
  });

  it("softens the outline and takes the backdrop's tint out of it", () => {
    const { rgba, width, height } = painted();
    const cut = liftFromBackdrop(rgba, width, height);
    const ox = 60 - Math.floor(cut.width / 2),
      oy = 50 - Math.floor(cut.height / 2);
    // A pixel the ring's anti-aliased edge covers about half way.
    const [x, y] = [81, 72];
    expect(Math.hypot(x - 60, y - 50)).toBeCloseTo(30.4, 1);
    const [r, g, b, a] = pixel(cut, x - ox, y - oy);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
    // Its color is the teal of the ring, not a magenta blend.
    expect(Math.abs(r - 20)).toBeLessThan(30);
    expect(Math.abs(g - 120)).toBeLessThan(30);
    expect(Math.abs(b - 110)).toBeLessThan(30);
  });

  it("leaves a picture without a flat backdrop alone", () => {
    const width = 40,
      height = 30,
      rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4)
      rgba.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255], i);
    const cut = liftFromBackdrop(rgba, width, height);
    expect(cut.ok).toBe(false);
    expect(cut.width).toBe(width);
    expect(cut.pixels).toEqual(rgba);
  });

  it("finds the shade the model actually painted, not the one it was asked for", () => {
    const { rgba, width, height } = painted();
    // The model painted a slightly darker magenta everywhere outside the ring.
    for (let i = 0; i < rgba.length; i += 4)
      if (rgba[i] === 255 && rgba[i + 1] === 0) rgba.set([236, 12, 230], i);
    const cut = liftFromBackdrop(rgba, width, height);
    expect(cut.ok).toBe(true);
    expect(cut.backdrop).toEqual([236, 12, 230]);
    expect(pixel(cut, 0, 0)[3]).toBe(0);
  });
});

describe("choosing a backdrop", () => {
  it("paints on magenta unless the subject uses it", () => {
    expect(chooseBackdrop("a coffee cup").name).toBe("magenta");
    expect(chooseBackdrop("a friendly green monster").name).toBe("magenta");
    expect(chooseBackdrop("a pink flamingo").name).toBe("green");
    expect(chooseBackdrop("a purple and green dragon").name).toBe("blue");
    expect(chooseBackdrop("a logo", ["#ff10f0"]).name).toBe("green");
  });
});
