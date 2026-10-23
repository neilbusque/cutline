import { expect, it } from "vitest";

// Transformers pins the preceding sharp minor. Exercise the actual native path
// when updating its security override, including the channel layout it expects.
it("loads the speech dependency and preserves image pixels through patched sharp", async () => {
  const { RawImage } = await import("@huggingface/transformers");
  const { KokoroTTS } = await import("kokoro-js");
  expect(typeof KokoroTTS.from_pretrained).toBe("function");
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const original = new RawImage(pixels, 2, 2, 4);
  const png = await original.toSharp().png().toBuffer();
  const decoded = await RawImage.fromBlob(
    new Blob([png], { type: "image/png" }),
  );
  expect(decoded.width).toBe(2);
  expect(decoded.height).toBe(2);
  expect(decoded.channels).toBe(4);
  expect(Array.from(decoded.data)).toEqual(Array.from(pixels));
  const resized = await decoded.resize(4, 4, { resample: "nearest" });
  expect([resized.width, resized.height, resized.channels]).toEqual([4, 4, 4]);
  expect(Array.from(resized.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
});
