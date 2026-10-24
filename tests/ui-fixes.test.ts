import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newProject } from "../src/shared/model";
import { errorText } from "../src/renderer/controls";
import { createValueStore } from "../src/renderer/playhead";

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

describe("graphics are generated in Generate > Graphic", () => {
  const h = React.createElement;
  const noop = () => {};
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@remotion/player", () => ({
      Player: () => h("i", { "data-player": "" }),
      Thumbnail: () => h("i", { "data-thumbnail": "" }),
    }));
    vi.stubGlobal("window", {
      matchMedia: () => ({
        matches: false,
        addEventListener: noop,
        removeEventListener: noop,
      }),
      addEventListener: noop,
      removeEventListener: noop,
    });
  });
  afterEach(() => {
    vi.doUnmock("@remotion/player");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("draws from a sentence in the Graphic mode", async () => {
    const { GraphicStudio } = await import("../src/renderer/GraphicStudio");
    const html = renderToStaticMarkup(
      h(GraphicStudio, {
        p: newProject(),
        playhead: createValueStore(0),
        edit: async () => true,
        select: noop,
        mediaBase: "",
      }),
    );
    expect(html).toContain('aria-label="Describe the graphic"');
    expect(html).toContain("Drawn by");
    expect(html).toContain("Generate a graphic");
  });

  it("leaves Motion > Vectors one row that opens the generator", async () => {
    const { MotionLibrary } = await import("../src/renderer/MotionLibrary");
    const html = renderToStaticMarkup(
      h(MotionLibrary, {
        p: newProject(),
        playhead: createValueStore(0),
        edit: async () => true,
        select: noop,
        addText: noop,
        openGraphic: noop,
      }),
    );
    expect(html).toContain("Generate a graphic from a sentence");
    expect(html).not.toContain('aria-label="Describe the graphic"');
    expect(html).toContain("Brand logos");
    expect(html).toContain("Page screenshot");
  });
});
