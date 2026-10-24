import { expect, it } from "vitest";
import type { Job } from "../src/shared/model";
import { workAtRisk } from "../src/main/quit-guard";

const job = (kind: string, state: Job["state"], extra: Partial<Job> = {}) =>
  ({
    id: kind,
    kind,
    state,
    progress: 0,
    message: `${kind} work`,
    ...extra,
  }) as Job;

it("asks before quitting throws away an export, with how far it got", () => {
  expect(
    workAtRisk([job("export", "running", { progress: 0.424 })], true),
  ).toEqual({
    question: "An export is 42% done. Quit anyway?",
    keep: "Keep exporting",
  });
  // Still making reversed copies or waiting for a slot.
  expect(workAtRisk([], true)?.keep).toBe("Keep exporting");
});

it("asks about other running work, never about preview copies", () => {
  expect(
    workAtRisk(
      [
        job("preview", "running"),
        job("agent", "running"),
        job("transcribe", "running", {
          message: "Transcribing interview.mp4 locally",
        }),
      ],
      false,
    ),
  ).toEqual({
    question:
      "“Transcribing interview.mp4 locally” is still running. Quit anyway?",
    keep: "Keep working",
  });
  expect(
    workAtRisk(
      [
        job("preview", "running"),
        job("agent", "running"),
        job("export", "done"),
        job("transcribe", "cancelled"),
      ],
      false,
    ),
  ).toBeUndefined();
});
