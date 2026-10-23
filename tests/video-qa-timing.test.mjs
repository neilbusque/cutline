import { describe, expect, it } from "vitest";
import { assertCfrTiming } from "../scripts/video-qa-timing.mjs";

const fixture = () => ({
  streams: [
    {
      r_frame_rate: "30/1",
      avg_frame_rate: "720000/24001",
      duration: "8.000333",
      nb_frames: "240",
    },
  ],
  frames: Array.from({ length: 240 }, (_, index) => ({
    best_effort_timestamp_time: (
      Math.round((index / 30) * 1000) / 1000
    ).toFixed(6),
  })),
});
const expected = { fps: 30, frames: 240 };

describe("Export cadence verification", () => {
  it("accepts the actual millisecond-quantized Matroska cadence and rounded MP4 average", () => {
    expect(
      assertCfrTiming(fixture(), expected).maxPtsErrorSeconds,
    ).toBeLessThan(0.000334);
  });
  it("accepts independently rounded average and stream duration from the 554-frame Studio export", () => {
    const probe = fixture();
    probe.streams[0] = {
      r_frame_rate: "30/1",
      avg_frame_rate: "831000/27701",
      duration: "18.466333",
      nb_frames: "554",
    };
    probe.frames = Array.from({ length: 554 }, (_, index) => ({
      best_effort_timestamp_time: (
        Math.round((index / 30) * 1000) / 1000
      ).toFixed(6),
    }));
    expect(
      assertCfrTiming(probe, { fps: 30, frames: 554 }).maxPtsErrorSeconds,
    ).toBeLessThan(0.000334);
  });
  it.each([
    [
      "wrong nominal rate",
      (p) => {
        p.streams[0].r_frame_rate = "29/1";
      },
    ],
    [
      "wrong average rate",
      (p) => {
        p.streams[0].avg_frame_rate = "29/1";
      },
    ],
    [
      "average duration drift beyond quantization",
      (p) => {
        p.streams[0].avg_frame_rate = "240000/8002";
      },
    ],
    [
      "missing average rate",
      (p) => {
        p.streams[0].avg_frame_rate = "0/0";
      },
    ],
    [
      "wrong declared count",
      (p) => {
        p.streams[0].nb_frames = "239";
      },
    ],
    [
      "dropped decoded frame",
      (p) => {
        p.frames.splice(100, 1);
      },
    ],
    [
      "duplicate decoded frame",
      (p) => {
        p.frames[100] = { ...p.frames[99] };
      },
    ],
    [
      "timestamp drift",
      (p) => {
        p.frames[100].best_effort_timestamp_time = String(100 / 30 + 0.0011);
      },
    ],
    [
      "missing timestamp",
      (p) => {
        delete p.frames[100].best_effort_timestamp_time;
      },
    ],
    [
      "duration drift",
      (p) => {
        p.streams[0].duration = "8.0011";
      },
    ],
    [
      "cadence jitter inside pointwise bounds",
      (p) => {
        p.frames[100].best_effort_timestamp_time = String(100 / 30 - 0.0008);
        p.frames[101].best_effort_timestamp_time = String(101 / 30 + 0.0008);
      },
    ],
  ])("rejects %s", (_label, change) => {
    const probe = fixture();
    change(probe);
    expect(() => assertCfrTiming(probe, expected)).toThrow();
  });
});
