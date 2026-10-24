import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommands, type Command } from "../src/shared/commands";
import { makeClip, newProject, type Project } from "../src/shared/model";
import { errorText } from "../src/renderer/controls";
import { timingCommands, trimCommands } from "../src/renderer/edit-gestures";
import { createValueStore } from "../src/renderer/playhead";
import {
  isTextField,
  keyStaysInFocus,
} from "../src/renderer/timeline-focus";

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

describe("keys live in Settings", () => {
  const h = React.createElement;
  const noop = () => {};
  beforeEach(() =>
    vi.stubGlobal("window", {
      cutline: {},
      addEventListener: noop,
      removeEventListener: noop,
    }),
  );
  afterEach(() => vi.unstubAllGlobals());

  it("puts the Pexels key beside Higgsfield under Pictures and video", async () => {
    const { HiggsfieldSettings } = await import(
      "../src/renderer/HiggsfieldSettings"
    );
    const html = renderToStaticMarkup(h(HiggsfieldSettings, { report: noop }));
    expect(html).toContain("Pictures and video");
    expect(html).toContain('aria-label="Higgsfield API key"');
    expect(html).toContain('aria-label="Pexels API key"');
  });

  it("leaves the Stock panel without a key form", async () => {
    const { StockLibrary } = await import("../src/renderer/StockLibrary");
    const html = renderToStaticMarkup(
      h(StockLibrary, {
        addBroll: async () => {},
        report: noop,
        openSettings: noop,
      }),
    );
    expect(html).not.toContain('aria-label="Pexels API key"');
    expect(html).not.toContain("Save key");
  });
});

describe("no always-on filler text", () => {
  const h = React.createElement;
  const noop = () => {};
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@remotion/player", () => ({
      Player: () => h("i"),
      Thumbnail: () => h("i"),
    }));
    vi.stubGlobal("window", {
      cutline: {},
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

  it("keeps the Generate video form to its controls", async () => {
    const { GenerateLibrary } = await import("../src/renderer/GenerateLibrary");
    const html = renderToStaticMarkup(
      h(GenerateLibrary, {
        active: false,
        projectId: "p",
        aspectRatio: "9:16",
        addBroll: async () => {},
        report: noop,
        openSettings: noop,
      }),
    );
    expect(html).not.toContain("Create a clip, then bring it into your edit.");
    expect(html).not.toContain("Describe the subject, movement, and camera.");
    // The cost note before a paid generation stays.
    expect(html).toContain("Uses your Higgsfield API credits");
  });

  it("drops the Motion sequence intro and footer line", async () => {
    const { MotionLibrary } = await import("../src/renderer/MotionLibrary");
    const html = renderToStaticMarkup(
      h(MotionLibrary, {
        p: newProject(),
        playhead: createValueStore(0),
        edit: async () => true,
        select: noop,
        addText: noop,
      }),
    );
    expect(html).not.toContain("A strong opening");
    expect(html).not.toContain("one undo step");
  });
});

describe("Story on a new project", () => {
  const h = React.createElement;
  const noop = () => {};
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@remotion/player", () => ({
      Player: () => h("i"),
      Thumbnail: () => h("i"),
    }));
    vi.stubGlobal("window", {
      cutline: {},
      addEventListener: noop,
      removeEventListener: noop,
    });
  });
  afterEach(() => {
    vi.doUnmock("@remotion/player");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const story = async (project: ReturnType<typeof newProject>) => {
    const { StoryLibrary } = await import("../src/renderer/StoryLibrary");
    return renderToStaticMarkup(
      h(StoryLibrary, {
        project,
        base: "",
        jobs: [],
        active: true,
        importMedia: noop,
        openGenerate: noop,
        openCaptions: noop,
        openSettings: noop,
        onCreated: noop,
        report: noop,
      }),
    );
  };

  it("says nothing about unsaved edits before anything is typed", async () => {
    const html = await story(newProject());
    expect(html).not.toContain("Storyline has unsaved edits");
    expect(html).not.toContain("Save storyline");
  });

  it("still shows a saved storyline as saved", async () => {
    const { StoryPlanSchema } = await import("../src/shared/story-schema");
    const html = await story({
      ...newProject(),
      story: StoryPlanSchema.parse({ brief: "A morning routine" }),
    });
    expect(html).toContain("Storyline saved");
  });
});

describe("generated captions follow every trim and timing edit", () => {
  const captioned = () => {
    const p = newProject();
    const asset = {
      id: "talk",
      name: "Talk",
      kind: "video" as const,
      path: "/local/talk.mp4",
      duration: 20,
      hasAudio: true,
    };
    p.assets = [asset];
    const video = {
      ...makeClip(p, "video", "video", 0, asset),
      id: "talk-clip",
      duration: 300,
    };
    const caption = (id: string, start: number) => ({
      ...makeClip(p, "caption", "captions", start),
      id,
      duration: 60,
      text: "Hello there",
      captionSourceId: video.id,
    });
    p.clips = [video, caption("a", 0), caption("b", 120), caption("c", 240)];
    return { p, video };
  };
  const apply = (p: Project, commands: Command[]) =>
    applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Edit",
      commands,
    });
  const inside = (p: Project) => {
    const video = p.clips.find((c) => c.id === "talk-clip")!;
    return p.clips
      .filter((c) => c.captionSourceId === video.id)
      .every(
        (c) =>
          c.start >= video.start &&
          c.start + c.duration <= video.start + video.duration,
      );
  };

  it("Trim end cuts the captions to the new end", () => {
    const { p, video } = captioned();
    const next = apply(p, trimCommands(p, video, "right", 150));
    expect(inside(next)).toBe(true);
    expect(next.clips.map((c) => c.id)).not.toContain("c");
  });

  it("Trim start cuts the captions to the new start", () => {
    const { p, video } = captioned();
    const next = apply(p, trimCommands(p, video, "left", 30));
    expect(inside(next)).toBe(true);
    expect(next.clips.find((c) => c.id === "a")!.start).toBe(30);
  });

  it("a typed Start moves the captions with the clip", () => {
    const { p, video } = captioned();
    const next = apply(p, timingCommands(p, video, { start: 90 }));
    expect(inside(next)).toBe(true);
    expect(next.clips.find((c) => c.id === "b")!.start).toBe(210);
  });

  it("a typed Duration trims the captions", () => {
    const { p, video } = captioned();
    const next = apply(p, timingCommands(p, video, { duration: 100 }));
    expect(inside(next)).toBe(true);
  });
});

describe("keys pressed in a panel act on what is focused there", () => {
  const at = (tagName: string, inPanel: boolean) => ({
    tagName,
    closest: (selector: string) =>
      inPanel && selector.includes(".right-panel") ? {} : null,
  }) as unknown as Element;

  it("Delete on a path point, key or layer row never reaches the clip", () => {
    for (const key of ["Delete", "Backspace"]) {
      expect(keyStaysInFocus(at("circle", true), key)).toBe(true);
      expect(keyStaysInFocus(at("BUTTON", true), key)).toBe(true);
    }
    // Outside the panels, Delete still removes the selected clip.
    expect(keyStaysInFocus(at("DIV", false), "Delete")).toBe(false);
  });

  it("arrows in a panel leave the playhead alone", () => {
    expect(keyStaysInFocus(at("circle", true), "ArrowLeft")).toBe(true);
    expect(keyStaysInFocus(at("DIV", false), "ArrowRight")).toBe(false);
  });

  it("Space opens a focused section instead of playing", () => {
    expect(keyStaysInFocus(at("SUMMARY", true), " ")).toBe(true);
    expect(keyStaysInFocus(at("BUTTON", true), " ")).toBe(false);
  });
});

describe("Cmd+Z in a text field", () => {
  const el = (tagName: string, type?: string, isContentEditable = false) =>
    ({ tagName, type, isContentEditable }) as unknown as HTMLElement;

  it("undoes the typing in fields where you type", () => {
    expect(isTextField(el("TEXTAREA"))).toBe(true);
    expect(isTextField(el("INPUT", "text"))).toBe(true);
    expect(isTextField(el("INPUT", "number"))).toBe(true);
    expect(isTextField(el("DIV", undefined, true))).toBe(true);
  });

  it("undoes the project edit everywhere else", () => {
    expect(isTextField(el("INPUT", "range"))).toBe(false);
    expect(isTextField(el("INPUT", "checkbox"))).toBe(false);
    expect(isTextField(el("SELECT"))).toBe(false);
    expect(isTextField(el("BUTTON"))).toBe(false);
  });
});
