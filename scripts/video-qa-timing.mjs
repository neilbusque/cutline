import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const tolerance = 0.001;
const epsilon = 1e-9;
const rate = (value) => {
  const parts = String(value).split("/");
  assert.equal(parts.length, 2, `Missing rational frame rate: ${value}`);
  const result = Number(parts[0]) / Number(parts[1]);
  assert(Number.isFinite(result) && result > 0, `Invalid frame rate: ${value}`);
  return result;
};

/**
 * Remotion's h264 + PCM intermediate is Matroska, whose timestamps have 1 ms
 * precision. Check the actual frames and cadence instead of requiring an exact
 * average-rate string from the final MP4's rounded duration.
 */
export function assertCfrTiming(probe, { fps, frames }) {
  assert(Number.isFinite(fps) && fps > 0);
  assert(Number.isInteger(frames) && frames > 0);
  const stream = probe.streams?.[0];
  assert(stream, "Export must contain a video stream");
  assert.equal(rate(stream.r_frame_rate), fps, "Nominal frame rate changed");
  assert.equal(
    Number(stream.nb_frames),
    frames,
    "Declared frame count changed",
  );
  assert.equal(probe.frames?.length, frames, "Decoded frame count changed");
  const duration = Number(stream.duration);
  assert(Number.isFinite(duration) && duration > 0, "Missing video duration");
  assert(
    Math.abs(duration - frames / fps) <= tolerance + epsilon,
    `Video duration drift exceeds 1 ms: ${duration}`,
  );
  const averageFps = rate(stream.avg_frame_rate);
  // The average-rate and stream-duration metadata can round independently.
  // Bound both against the intended duration instead of comparing them.
  assert(
    Math.abs(frames / averageFps - frames / fps) <= tolerance + epsilon,
    "Average frame rate implies a duration drift exceeding 1 ms",
  );
  let previous;
  let maxPtsErrorSeconds = 0;
  let maxIntervalErrorSeconds = 0;
  for (const [index, frame] of probe.frames.entries()) {
    const timestamp = Number(frame.best_effort_timestamp_time);
    assert(
      typeof frame.best_effort_timestamp_time === "string" &&
        Number.isFinite(timestamp),
      `Missing decoded timestamp at frame ${index}`,
    );
    maxPtsErrorSeconds = Math.max(
      maxPtsErrorSeconds,
      Math.abs(timestamp - index / fps),
    );
    assert(
      maxPtsErrorSeconds <= tolerance + epsilon,
      `Frame ${index} timestamp drift exceeds 1 ms`,
    );
    if (previous !== undefined) {
      assert(
        timestamp > previous,
        `Non-increasing timestamp at frame ${index}`,
      );
      maxIntervalErrorSeconds = Math.max(
        maxIntervalErrorSeconds,
        Math.abs(timestamp - previous - 1 / fps),
      );
      assert(
        maxIntervalErrorSeconds <= tolerance + epsilon,
        `Frame ${index} cadence error exceeds 1 ms`,
      );
    }
    previous = timestamp;
  }
  return {
    fps,
    frames,
    duration,
    averageFps,
    maxPtsErrorSeconds,
    maxIntervalErrorSeconds,
  };
}

export function assertCfrExport(ffprobe, file, expected) {
  const probe = JSON.parse(
    execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_streams",
        "-show_frames",
        "-show_entries",
        "stream=r_frame_rate,avg_frame_rate,duration,nb_frames:frame=best_effort_timestamp_time",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  return assertCfrTiming(probe, expected);
}
