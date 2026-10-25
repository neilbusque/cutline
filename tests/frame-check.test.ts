import { describe, expect, it } from "vitest";
import {
  FRAME_CHECK_SIZE,
  IsolatedFrameFinder,
  isIsolatedFrame,
} from "../src/shared/frame-check";

const frame = (value: number) =>
  new Uint8Array(FRAME_CHECK_SIZE * FRAME_CHECK_SIZE).fill(value);
const find = (values: number[]) => {
  const finder = new IsolatedFrameFinder();
  for (const v of values) finder.push(frame(v));
  return finder.found.map((f) => f.frame);
};

describe("isolated frame finder", () => {
  it("finds a frame that breaks from two matching neighbours", () => {
    expect(find([100, 101, 102, 30, 103, 104])).toEqual([3]);
    expect(isIsolatedFrame(frame(100), frame(160), frame(101))).toBe(true);
  });

  it("leaves cuts, fades and steady footage alone", () => {
    // A hard cut, a gradual fade and noise under the threshold.
    expect(find([100, 100, 100, 20, 20, 20])).toEqual([]);
    expect(find([100, 92, 84, 76, 68, 60, 52])).toEqual([]);
    expect(find([100, 102, 100, 102, 100])).toEqual([]);
  });

  it("does not flag a frame between two different shots", () => {
    expect(find([100, 100, 50, 0, 0])).toEqual([]);
  });

  it("keeps the thumbnail it judged", () => {
    const finder = new IsolatedFrameFinder();
    for (const v of [10, 10, 200, 10]) finder.push(frame(v));
    expect(finder.found).toHaveLength(1);
    expect(finder.found[0].thumbnail[0]).toBe(200);
  });
});
