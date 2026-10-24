import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommands, type Command } from "../src/shared/commands";
import {
  AssetSchema,
  makeClip,
  newProject,
  type Project,
} from "../src/shared/model";
import { Jobs, Media } from "../src/main/media";
import { errorText } from "../src/renderer/controls";
import { exampleReplacesTyping } from "../src/renderer/ExplainerStory";
import {
  dragStarted,
  duplicateCommands,
  timingCommands,
  trimCommands,
} from "../src/renderer/edit-gestures";
import { createValueStore } from "../src/renderer/playhead";
import {
  acceptsAssetDrag,
  ASSET_DRAG,
  assetKindDrag,
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

describe("examples never silently replace a typed script", () => {
  const empty = {
    style: "kinetic" as const,
    topic: "",
    script: "",
    audience: "",
    cta: "",
  };

  it("asks first when there are typed words", () => {
    expect(
      exampleReplacesTyping({ ...empty, script: "My long narration" }),
    ).toBe(true);
    expect(exampleReplacesTyping({ ...empty, topic: "My topic" })).toBe(true);
    expect(exampleReplacesTyping({ ...empty, cta: "Book a call" })).toBe(true);
  });

  it("fills an empty form at once", () => {
    expect(exampleReplacesTyping(empty)).toBe(false);
    expect(exampleReplacesTyping({ ...empty, script: "   " })).toBe(false);
  });
});

describe("Cmd+D duplicates like the agent", () => {
  const sequence = () => {
    const p = newProject();
    const asset = {
      id: "shot",
      name: "Shot",
      kind: "video" as const,
      path: "/local/shot.mp4",
      duration: 20,
      hasAudio: true,
    };
    p.assets = [asset];
    const first = {
      ...makeClip(p, "video", "video", 0, asset),
      id: "first",
      duration: 90,
    };
    const second = {
      ...makeClip(p, "video", "video", 90, asset),
      id: "second",
      duration: 90,
      transition: { kind: "crossfade" as const, frames: 10, fromId: "first" },
    };
    const caption = (id: string, source: string, start: number) => ({
      ...makeClip(p, "caption", "captions", start),
      id,
      duration: 45,
      text: "Hello",
      captionSourceId: source,
    });
    p.clips = [
      first,
      second,
      caption("a", "first", 0),
      caption("b", "first", 45),
      caption("c", "second", 90),
    ];
    return p;
  };
  const run = (p: Project, id: string) => {
    const made = duplicateCommands(p, p.clips.find((c) => c.id === id)!);
    const next = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Duplicate clip",
      commands: made.commands,
    });
    return { next, copy: next.clips.find((c) => c.id === made.id)! };
  };
  const overlaps = (p: Project) =>
    p.clips.some((a) =>
      p.clips.some(
        (b) =>
          a !== b &&
          a.trackId === b.trackId &&
          a.start < b.start + b.duration &&
          b.start < a.start + a.duration,
      ),
    );

  it("never stacks the copy on the next shot in one row", () => {
    const { next, copy } = run(sequence(), "first");
    expect(copy.start).toBe(90);
    expect(copy.trackId).not.toBe("video");
    expect(overlaps(next)).toBe(false);
  });

  it("brings the clip's captions and drops its transition", () => {
    const { next, copy } = run(sequence(), "second");
    expect(copy.trackId).toBe("video");
    expect(copy.start).toBe(180);
    expect(copy.transition).toBeUndefined();
    const captions = next.clips.filter((c) => c.captionSourceId === copy.id);
    expect(captions.map((c) => c.start)).toEqual([180]);
    expect(overlaps(next)).toBe(false);
  });

  it("puts captions that would collide on their own text track", () => {
    const { next, copy } = run(sequence(), "first");
    const captions = next.clips.filter((c) => c.captionSourceId === copy.id);
    expect(captions).toHaveLength(2);
    expect(captions.every((c) => c.trackId !== "captions")).toBe(true);
    expect(overlaps(next)).toBe(false);
  });
});

describe("clicking a clip never nudges it", () => {
  it("ignores a 1 or 2 px wobble", () => {
    expect(dragStarted(1, 0)).toBe(false);
    expect(dragStarted(-2, 3)).toBe(false);
  });

  it("starts a drag once the pointer really moves", () => {
    expect(dragStarted(3, 0)).toBe(true);
    expect(dragStarted(0, -4)).toBe(true);
  });
});

describe("Generate subtitles twice runs whisper once", () => {
  it("a second request for the same recording waits for the first", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "cutline-ui-transcribe-"));
    try {
      const whisper = path.join(folder, "whisper"),
        model = path.join(folder, "model.bin"),
        file = path.join(folder, "talk.wav");
      for (const made of [whisper, model, file]) writeFileSync(made, "x");
      const jobs = new Jobs(() => {});
      const media = new Media(
        path.join(folder, "cache"),
        { ffmpeg: "", ffprobe: "", whisper, model },
        jobs,
      );
      let finish!: (words: { text: string; start: number; end: number }[]) => void;
      const run = vi
        .spyOn(jobs, "run")
        .mockImplementation(
          () => new Promise((resolve) => (finish = resolve)) as never,
        );
      const asset = AssetSchema.parse({
        id: "talk",
        name: "Talk",
        kind: "audio",
        path: file,
        duration: 3,
        hasAudio: true,
      });
      const first = media.transcribe(asset),
        second = media.transcribe(asset);
      finish([{ text: "Hello", start: 0, end: 1 }]);
      expect(await first).toEqual([{ text: "Hello", start: 0, end: 1 }]);
      expect(await second).toEqual([{ text: "Hello", start: 0, end: 1 }]);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("Properties shows when subtitles or pauses are running", () => {
  it("disables both buttons and says what is running", async () => {
    const { Inspector } = await import("../src/renderer/Inspector");
    const p = newProject();
    const asset = AssetSchema.parse({
      id: "talk",
      name: "Talk",
      kind: "video",
      path: "/local/talk.mp4",
      duration: 10,
      hasAudio: true,
    });
    p.assets = [asset];
    const clip = makeClip(p, "video", "video", 0, asset);
    p.clips = [clip];
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(Inspector, {
        project: p,
        clip,
        playhead: createValueStore(0),
        playing: false,
        seek: noop,
        edit: noop,
        transcribe: noop,
        pauses: async () => undefined,
        transcribing: true,
        findingPauses: true,
        report: noop,
      }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Transcribing…<\/button>/);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Finding pauses…<\/button>/,
    );
  });
});

describe("dragging media lights up only tracks that take it", () => {
  const p = newProject();
  const track = (kind: "video" | "audio" | "text") =>
    p.tracks.find((t) => t.kind === kind)!;
  const drag = (kind: "video" | "audio" | "image") => [
    ASSET_DRAG,
    assetKindDrag(kind),
  ];

  it("refuses music on a video track and video on an audio track", () => {
    expect(acceptsAssetDrag(drag("audio"), track("video"))).toBe(false);
    expect(acceptsAssetDrag(drag("video"), track("audio"))).toBe(false);
    expect(acceptsAssetDrag(drag("image"), track("text"))).toBe(false);
  });

  it("accepts matching kinds", () => {
    expect(acceptsAssetDrag(drag("audio"), track("audio"))).toBe(true);
    expect(acceptsAssetDrag(drag("image"), track("video"))).toBe(true);
  });

  it("ignores drags that are not library media", () => {
    expect(acceptsAssetDrag(["Files"], track("video"))).toBe(false);
  });
});

describe("left tabs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("each panel has its own icon", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { cutline: {} });
    const { libraryTabs } = await import("../src/renderer/App");
    const icons = libraryTabs.map((tab) => tab.icon);
    expect(new Set(icons).size).toBe(libraryTabs.length);
  });
});

describe("copy points at things that exist", () => {
  it("never sends Neil to a Settings install button", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "cutline-ui-speech-"));
    try {
      const media = new Media(
        path.join(folder, "cache"),
        {
          ffmpeg: "",
          ffprobe: "",
          whisper: path.join(folder, "missing-whisper"),
          model: path.join(folder, "missing-model"),
        },
        new Jobs(() => {}),
      );
      await expect(
        media.transcribe(
          AssetSchema.parse({
            id: "talk",
            name: "Talk",
            kind: "audio",
            path: path.join(folder, "talk.wav"),
            duration: 3,
            hasAudio: true,
          }),
        ),
      ).rejects.toThrow(
        "Speech tools are missing from this install. Reinstall Cutline to transcribe.",
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("Draw vector starts a drawing", () => {
  it("opens the Path designer empty, with Add points on", async () => {
    const { VectorEditor, startVectorDrawing } = await import(
      "../src/renderer/VectorEditor"
    );
    const { parseEditableSvg } = await import("../src/shared/vector-path");
    const { createVectorScene } = await import("../src/shared/vector-scenes");
    const created = createVectorScene(
      newProject(),
      0,
      parseEditableSvg(
        '<svg viewBox="0 0 100 100"><path d="M15 75 L50 15 L85 75" fill="none" stroke="#81b6ff" stroke-width="4"/></svg>',
      ),
      { name: "Custom vector" },
    );
    const layer = created.motion.layers[0];
    const key = `${created.motion.id}:0`;
    const render = () =>
      renderToStaticMarkup(
        React.createElement(VectorEditor, {
          layer,
          draftKey: key,
          onApply: () => {},
        }),
      );
    // Without the seeded draft the starter shape opens in Select.
    const before = render();
    expect(before).toMatch(/aria-pressed="true"[^>]*>.*Select/u);
    expect(before).toContain(layer.vectorPath!);
    startVectorDrawing(key, layer);
    const html = render();
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*Add points/u);
    expect(html).not.toContain(layer.vectorPath!);
  });
});

describe("a failed logo search is not a missing logo", () => {
  it("says the search failed and offers a retry", async () => {
    const { emptyLogoSearch } = await import("../src/renderer/VectorStudio");
    expect(emptyLogoSearch("Claude", true)).toBe("failed");
    expect(emptyLogoSearch("Claude", false)).toBe("missing");
    // A web address can still use the site's own logo either way.
    expect(emptyLogoSearch("gamma.app", true)).toBe("site");
  });
});

describe("job progress lives in a store the status bar follows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("shows the running job first, then how the last one ended", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { cutline: {} });
    const { JobStatus } = await import("../src/renderer/App");
    const jobs = createValueStore<any[]>([
      { id: "p", kind: "preview", state: "running", progress: 0.2, message: "Preview copy" },
      { id: "e", kind: "export", state: "running", progress: 0.5, message: "Exporting 50%" },
    ]);
    const line = () =>
      renderToStaticMarkup(
        React.createElement(JobStatus, {
          jobs,
          run: async () => undefined,
          report: () => {},
        }),
      );
    expect(line()).toContain("Exporting 50%");
    expect(line()).toContain("Cancel");
    jobs.set([
      { id: "e", kind: "export", state: "done", progress: 1, message: "Done", output: "/x.mp4" },
    ]);
    expect(line()).toContain("Export complete");
    jobs.set([
      { id: "t", kind: "transcribe", state: "error", progress: 0, message: "Failed" },
    ]);
    expect(line()).toContain("Job failed");
  });
});
