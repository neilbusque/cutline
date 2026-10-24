import { describe, expect, it } from "vitest";
import { errorText } from "../src/renderer/controls";

const remote = (message: string) =>
  Error(`Error invoking remote method 'cutline': Error: ${message}`);

describe("error text", () => {
  it("drops Electron's prefix from main-process errors", () => {
    expect(errorText(remote("Choose a Cutline project."))).toBe(
      "Choose a Cutline project.",
    );
    expect(
      errorText(
        Error("Error invoking remote method 'cutline': ZodError: Bad input"),
      ),
    ).toBe("Bad input");
  });

  it("never asks Neil to refresh or inspect the project", () => {
    for (const message of [
      "Project changed. Refresh the project and retry this edit.",
      "Project changed. Inspect the project and retry.",
    ])
      expect(errorText(remote(message))).toBe(
        "Cutline changed while you were editing. Try again.",
      );
  });

  it("keeps project-changed messages that say what was kept", () => {
    const kept =
      "Project changed while downloading. The file remains in your local stock folder.";
    expect(errorText(remote(kept))).toBe(kept);
  });

  it("reads plain strings and local errors as they are", () => {
    expect(errorText("Select a video or audio clip first.")).toBe(
      "Select a video or audio clip first.",
    );
    expect(errorText(Error("Up to 9 reference images fit in one shot."))).toBe(
      "Up to 9 reference images fit in one shot.",
    );
  });
});
