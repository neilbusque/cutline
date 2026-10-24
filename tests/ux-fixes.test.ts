import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { animatedValue } from "../src/shared/animation";
import { applyCommands } from "../src/shared/commands";
import {
  MotionSchema,
  makeClip,
  newProject,
  type Clip,
} from "../src/shared/model";
import {
  createDraftCommit,
  createEditQueue,
  createNudge,
  hasUnsavedWork,
  previewTransform,
  transformCommands,
  withDraft,
} from "../src/renderer/edit-gestures";
import { createValueStore } from "../src/renderer/playhead";
import {
  defaultKeyframeProperty,
  easingLabel,
  formatKeyValue,
  keyframeProperties,
  kindLabel,
  propertyLabel,
} from "../src/renderer/labels";
import {
  clipFocusTarget,
  clipKeyMove,
  clipTabStop,
} from "../src/renderer/timeline-focus";

const h = React.createElement;
const noop = () => {};

function captionProject() {
  const p = newProject();
  const caption: Clip = {
    ...makeClip(p, "caption", "captions", 0),
    text: "Hello there",
  };
  p.clips = [caption];
  return { p, caption };
}

describe("rapid edits from one window", () => {
  // A stand-in for the main-process store: it applies an edit only when the
  // edit carries the current revision, like applyCommands does.
  const fakeStore = () => {
    const state = { revision: 1, applied: [] as string[] };
    const send = vi.fn(async (request: { revision: number; label: string }) => {
      await Promise.resolve();
      if (request.revision !== state.revision)
        throw Error(
          "Project changed. Refresh the project and retry this edit.",
        );
      state.revision += 1;
      state.applied.push(request.label);
      return { project: { id: "p", revision: state.revision } };
    });
    return { state, send };
  };

  it("lands every edit sent before the new project rendered", async () => {
    const { state, send } = fakeStore();
    const edit = createEditQueue(send);
    // Three color events in one burst all saw revision 1.
    const results = await Promise.allSettled(
      ["one", "two", "three"].map((label) =>
        edit({
          projectId: "p",
          revision: 1,
          label,
          commands: [
            { type: "clip.update", id: "c", patch: { color: "#ffffff" } },
          ] as any,
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(state.applied).toEqual(["one", "two", "three"]);
  });

  it("still refuses an edit made before someone else's change", async () => {
    const { state, send } = fakeStore();
    const edit = createEditQueue(send);
    state.revision = 2; // An agent edited; this window still shows revision 1.
    await expect(
      edit({ projectId: "p", revision: 1, label: "Adjust clip", commands: [] }),
    ).rejects.toThrow("Project changed");
    expect(state.applied).toEqual([]);
  });

  it("refuses a stale whole-curve replacement instead of erasing the previous queued key edit", async () => {
    let project = newProject();
    const clip = makeClip(project, "text", "titles", 0);
    clip.keyframes = [
      { property: "x", frame: 0, value: 20, easing: "linear" },
      { property: "x", frame: 20, value: 120, easing: "ease-out" },
    ];
    project.clips = [clip];
    const revision = project.revision;
    const edit = createEditQueue(async (request) => {
      await Promise.resolve();
      project = applyCommands(project, request);
      return { project };
    });
    // Both edits saw one rendered snapshot. The first changes a specific key;
    // the second contains a complete old curve (as a move/retime does).
    const results = await Promise.allSettled([
      edit({
        projectId: project.id,
        revision,
        label: "Change selected key",
        commands: [
          {
            type: "clip.keyframe",
            id: clip.id,
            property: "x",
            frame: 0,
            value: 75,
            easing: "linear",
            remove: false,
          },
        ],
      }),
      edit({
        projectId: project.id,
        revision,
        label: "Move a key from stale curve",
        commands: [
          {
            type: "clip.update",
            id: clip.id,
            patch: {
              keyframes: clip.keyframes.map((key) => ({
                ...key,
                frame: key.frame === 20 ? 30 : key.frame,
              })),
            },
          },
        ],
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      results[1].status === "rejected" && results[1].reason.message,
    ).toContain("Project changed");
    expect(project.revision).toBe(revision + 1);
    expect(project.clips[0].keyframes).toEqual([
      { property: "x", frame: 0, value: 75, easing: "linear" },
      { property: "x", frame: 20, value: 120, easing: "ease-out" },
    ]);
    // Reading the new snapshot gives the user a safe, retryable operation.
    const refreshed = project.clips[0];
    await edit({
      projectId: project.id,
      revision: project.revision,
      label: "Move key after refresh",
      commands: [
        {
          type: "clip.update",
          id: clip.id,
          patch: {
            keyframes: refreshed.keyframes.map((key) => ({
              ...key,
              frame: key.frame === 20 ? 30 : key.frame,
            })),
          },
        },
      ],
    });
    expect(
      project.clips[0].keyframes.map((key) => [key.frame, key.value]),
    ).toEqual([
      [0, 75],
      [30, 120],
    ]);
  });
});

describe("draft commits for continuous controls", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("turns a color drag into one edit after the pointer settles", () => {
    const commit = vi.fn();
    const color = createDraftCommit<string>(commit, 250);
    color.sync("#000000");
    for (let i = 0; i < 40; i++)
      color.change(`#0000${String(i).padStart(2, "0")}`);
    vi.advanceTimersByTime(100);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("#000039");
  });

  it("commits at once on blur and skips values that are already stored", () => {
    const commit = vi.fn();
    const color = createDraftCommit<string>(commit, 250);
    color.sync("#112233");
    color.change("#445566");
    color.flush();
    expect(commit).toHaveBeenCalledWith("#445566");
    color.flush();
    vi.advanceTimersByTime(500);
    expect(commit).toHaveBeenCalledTimes(1);
    color.change("#445566");
    color.flush();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("holds an arrow-key nudge until the key is released", () => {
    const commit = vi.fn();
    const nudge = createNudge(commit);
    let shown = 0;
    for (let i = 0; i < 20; i++) shown = nudge.press("clip-a", 30, 1);
    expect(shown).toBe(50);
    expect(commit).not.toHaveBeenCalled();
    nudge.release();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("clip-a", 50);
    nudge.release();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("never nudges a clip before frame zero and skips a no-op", () => {
    const commit = vi.fn();
    const nudge = createNudge(commit);
    expect(nudge.press("clip-a", 3, -10)).toBe(0);
    nudge.release();
    expect(commit).toHaveBeenCalledWith("clip-a", 0);
    nudge.press("clip-a", 0, -1);
    nudge.release();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe("live preview while dragging a layer", () => {
  it("shows the same result the committed edit will produce", () => {
    const p = newProject();
    const title: Clip = {
      ...makeClip(p, "text", "titles", 0),
      keyframes: [
        { property: "x", frame: 0, value: 0, easing: "linear" },
        { property: "x", frame: 20, value: 100, easing: "hold" },
      ],
    };
    p.clips = [title];
    const change = { x: 300, y: 40 };
    const shown = previewTransform(title, change, 10);
    const landed = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Move layer",
      commands: transformCommands(title, change, 10),
    }).clips[0];
    expect(animatedValue(shown, "x", 10)).toBe(300);
    expect(animatedValue(landed, "x", 10)).toBe(300);
    expect(shown.y).toBe(40);
    expect(landed.y).toBe(40);
    expect(shown.keyframes).toEqual(landed.keyframes);
  });

  it("keeps the easing of a key it replaces", () => {
    const p = newProject();
    const title: Clip = {
      ...makeClip(p, "text", "titles", 0),
      keyframes: [{ property: "y", frame: 5, value: 10, easing: "hold" }],
    };
    const [command] = transformCommands(title, { y: 90 }, 5);
    expect(command).toMatchObject({
      type: "clip.keyframe",
      frame: 5,
      value: 90,
      easing: "hold",
    });
  });
});

describe("playhead store", () => {
  it("notifies only when the frame actually changes", () => {
    const playhead = createValueStore(0);
    const listener = vi.fn();
    const off = playhead.subscribe(listener);
    playhead.set(4);
    playhead.set(4);
    expect(playhead.get()).toBe(4);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    playhead.set(5);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("caption style drafts", () => {
  it("survive selection changes and reset only for another canvas", async () => {
    const { captionDraftScope } =
      await import("../src/renderer/CaptionLibrary");
    const { p } = captionProject();
    const scope = captionDraftScope(p);
    // Selecting another clip, Escape and edits elsewhere change none of these.
    const edited = { ...p, revision: p.revision + 3 };
    expect(captionDraftScope(edited)).toBe(scope);
    expect(captionDraftScope({ ...p, width: 1920, height: 1080 })).not.toBe(
      scope,
    );
    expect(captionDraftScope({ ...p, id: "another-project" })).not.toBe(scope);
  });
});

describe("vector path drafts", () => {
  it("come back when the same layer is selected again", async () => {
    const { rememberVectorDraft, restoreVectorDraft, forgetVectorDraft } =
      await import("../src/renderer/VectorEditor");
    const layer = MotionSchema.parse({
      id: "m",
      name: "Mark",
      layers: [
        {
          type: "path",
          vectorPath: "M 0 0 L 10 10",
          vectorViewBox: [0, 0, 100, 100],
        },
      ],
    }).layers[0];
    const draft = {
      path: "M 0 0 L 50 50",
      box: ["0", "0", "100", "100"] as [string, string, string, string],
      fillRule: "nonzero" as const,
    };
    rememberVectorDraft("m:0", layer, draft);
    expect(restoreVectorDraft("m:0", layer)).toEqual(draft);
    // A draft made against a path that has since changed is not restored.
    expect(
      restoreVectorDraft("m:0", { ...layer, vectorPath: "M 1 1 L 2 2" }),
    ).toBeUndefined();
    forgetVectorDraft("m:0");
    expect(restoreVectorDraft("m:0", layer)).toBeUndefined();
  });
});

describe("keyframe properties follow the clip kind", () => {
  it("offers volume only for clips you can hear", () => {
    const audio = { kind: "audio" as const, keyframes: [] };
    const title = { kind: "text" as const, keyframes: [] };
    const video = { kind: "video" as const, keyframes: [] };
    expect(keyframeProperties(audio, true)).toEqual(["volume"]);
    expect(keyframeProperties(title, false)).not.toContain("volume");
    expect(keyframeProperties(title, false)).toContain("opacity");
    expect(keyframeProperties(video, true)).toContain("volume");
    expect(keyframeProperties(video, false)).not.toContain("volume");
    expect(defaultKeyframeProperty(audio, true)).toBe("volume");
    expect(defaultKeyframeProperty(title, false)).toBe("opacity");
    // Existing keys always stay reachable, and open first.
    const keyed = {
      kind: "audio" as const,
      keyframes: [
        {
          property: "scale" as const,
          frame: 0,
          value: 1,
          easing: "linear" as const,
        },
      ],
    };
    expect(keyframeProperties(keyed, true)).toEqual(["scale", "volume"]);
    expect(defaultKeyframeProperty(keyed, true)).toBe("scale");
  });

  it("reads as plain words", () => {
    expect(propertyLabel("x")).toBe("Position X");
    expect(propertyLabel("opacity")).toBe("Opacity");
    expect(easingLabel("ease-in-out")).toBe("Ease in and out");
    expect(easingLabel("cubic-bezier")).toBe("Bezier curve");
    expect(easingLabel("some-new-curve")).toBe("Some new curve");
    expect(kindLabel("image")).toBe("Photo");
    expect(formatKeyValue("opacity", 0.25925925925925924)).toBe("26%");
    expect(formatKeyValue("scale", 1.2345)).toBe("1.23×");
    expect(formatKeyValue("x", 120.4)).toBe("120 px");
  });

  it("renders only the allowed properties with labels", async () => {
    const { KeyframeInspector } =
      await import("../src/renderer/KeyframeInspector");
    const p = newProject();
    const music: Clip = { ...makeClip(p, "text", "titles"), kind: "audio" };
    const html = renderToStaticMarkup(
      h(KeyframeInspector, {
        clip: music,
        frame: 0,
        fps: 30,
        audible: true,
        seek: noop,
        edit: noop,
      }),
    );
    expect(html).toContain(
      '<option value="volume" selected="">Volume</option>',
    );
    expect(html).not.toContain('value="opacity"');
    expect(html).not.toMatch(/<details[^>]*open/);
  });
});

describe("Properties order", () => {
  it("starts with the caption text, then timing and transform, keyframes last", async () => {
    const { Inspector } = await import("../src/renderer/Inspector");
    const { p, caption } = captionProject();
    const html = renderToStaticMarkup(
      h(Inspector, {
        project: p,
        clip: caption,
        playhead: createValueStore(0),
        playing: false,
        seek: noop,
        edit: noop,
        transcribe: noop,
        pauses: async () => undefined,
        report: noop,
        openPanel: noop,
      }),
    );
    const at = (text: string) => {
      const index = html.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    expect(at("Hello there")).toBeLessThan(at("<summary>Timing</summary>"));
    expect(at("<summary>Timing</summary>")).toBeLessThan(
      at("<summary>Transform</summary>"),
    );
    expect(at("<summary>Transform</summary>")).toBeLessThan(
      at("<summary>Keyframes</summary>"),
    );
    expect(html).toContain("Style all captions in Caption studio");
  });

  it("titles the clip-level curves 'Animate whole clip' after the layer editor", async () => {
    const { Inspector } = await import("../src/renderer/Inspector");
    const p = newProject();
    const motion = MotionSchema.parse({
      id: "motion-1",
      name: "Scene",
      layers: [{ type: "rectangle", name: "Panel" }],
    });
    const scene: Clip = {
      ...makeClip(p, "text", "titles"),
      preset: "custom",
      motionId: motion.id,
    };
    p.motions = [motion];
    p.clips = [scene];
    const html = renderToStaticMarkup(
      h(Inspector, {
        project: p,
        clip: scene,
        playhead: createValueStore(0),
        playing: false,
        seek: noop,
        edit: noop,
        transcribe: noop,
        pauses: async () => undefined,
        report: noop,
        openPanel: noop,
      }),
    );
    expect(html.indexOf("Animate layer")).toBeLessThan(
      html.indexOf("<summary>Animate whole clip</summary>"),
    );
    expect(html).not.toContain("<summary>Keyframes</summary>");
  });
});

describe("motion layer list", () => {
  it("lists the top layer first and moves it up with the up arrow", async () => {
    const { MotionInspector } = await import("../src/renderer/MotionInspector");
    const p = newProject();
    const motion = MotionSchema.parse({
      id: "motion-1",
      name: "Scene",
      layers: [
        { type: "rectangle", name: "Backdrop" },
        { type: "ellipse", name: "Badge" },
        { type: "text", name: "Headline" },
      ],
    });
    const clip: Clip = {
      ...makeClip(p, "text", "titles"),
      preset: "custom",
      motionId: motion.id,
    };
    p.motions = [motion];
    p.clips = [clip];
    const html = renderToStaticMarkup(
      h(MotionInspector, {
        project: p,
        motion,
        clip,
        frame: 0,
        seek: noop,
        edit: noop,
      }),
    );
    const list = html.slice(
      html.indexOf('aria-label="Motion layers"'),
      html.indexOf("motion-layer-actions"),
    );
    expect(list.indexOf("Headline")).toBeLessThan(list.indexOf("Badge"));
    expect(list.indexOf("Badge")).toBeLessThan(list.indexOf("Backdrop"));
    // Numbers stay tied to the stored layer so agents and people agree.
    expect(list).toContain('aria-label="Select motion layer 3"');
    const forward = html.match(
      /<button[^>]*aria-label="Move layer forward"[^>]*>.*?<\/button>/,
    )?.[0];
    expect(forward).toContain("chevron-up");
    expect(html).not.toContain("Last layer is on top");
  });
});

describe("timeline keyboard focus", () => {
  const lane = () => {
    const p = newProject();
    const a = { ...makeClip(p, "text", "titles", 0), id: "a" };
    const b = { ...makeClip(p, "text", "titles", 150), id: "b" };
    const c = { ...makeClip(p, "caption", "captions", 140), id: "c" };
    const d = { ...makeClip(p, "caption", "captions", 0), id: "d" };
    p.clips = [b, a, c, d];
    return p;
  };

  it("gives the clip lane one tab stop", () => {
    const p = lane();
    expect(clipTabStop(p.tracks, p.clips, "c")).toBe("c");
    expect(clipTabStop(p.tracks, p.clips, undefined)).toBe("a");
    expect(clipTabStop(p.tracks, p.clips, "missing")).toBe("a");
  });

  it("moves between clips and tracks with the keyboard", () => {
    const p = lane();
    expect(clipFocusTarget(p.tracks, p.clips, "a", "next")).toBe("b");
    expect(clipFocusTarget(p.tracks, p.clips, "b", "next")).toBeUndefined();
    expect(clipFocusTarget(p.tracks, p.clips, "b", "previous")).toBe("a");
    expect(clipFocusTarget(p.tracks, p.clips, "b", "down")).toBe("c");
    expect(clipFocusTarget(p.tracks, p.clips, "a", "down")).toBe("d");
    expect(clipFocusTarget(p.tracks, p.clips, "d", "up")).toBe("a");
    expect(clipFocusTarget(p.tracks, p.clips, "d", "last")).toBe("c");
    expect(clipFocusTarget(p.tracks, p.clips, "c", "first")).toBe("d");
    expect(clipFocusTarget(p.tracks, p.clips, "a", "up")).toBeUndefined();
  });

  it("renders one focusable clip and no focusable beat markers", async () => {
    vi.stubGlobal("window", {
      innerHeight: 1000,
      addEventListener: noop,
      removeEventListener: noop,
    });
    try {
      const { Timeline } = await import("../src/renderer/Timeline");
      const p = lane();
      const html = renderToStaticMarkup(
        h(Timeline, {
          p,
          playhead: createValueStore(0),
          selected: "c",
          select: noop,
          seek: noop,
          edit: async () => true,
          split: noop,
          remove: noop,
          base: "",
          duplicate: noop,
          addMedia: noop,
          playing: false,
          beats: [10, 20, 30],
        }),
      );
      const clips = html.match(/<div[^>]*class="timeline-clip[^"]*"[^>]*>/g)!;
      expect(clips).toHaveLength(4);
      expect(clips.filter((tag) => tag.includes('tabindex="0"'))).toEqual([
        expect.stringContaining('data-clip-id="c"'),
      ]);
      const beats = html.match(/<button[^>]*class="beat-marker[^"]*"[^>]*>/g)!;
      expect(beats.length).toBeGreaterThan(0);
      expect(beats.every((tag) => tag.includes('tabindex="-1"'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("motion library previews", () => {
  afterEach(() => {
    vi.doUnmock("@remotion/player");
    vi.resetModules();
  });

  it("mounts a live player only for the tile being previewed", async () => {
    vi.resetModules();
    vi.doMock("@remotion/player", () => ({
      Player: () => h("i", { "data-player": "" }),
      Thumbnail: (props: { frameToDisplay: number }) =>
        h("i", { "data-thumbnail": props.frameToDisplay }),
    }));
    const { MotionPreviewTile } = await import("../src/renderer/MotionLibrary");
    const tile = (active: boolean) =>
      renderToStaticMarkup(
        h(MotionPreviewTile, {
          id: "rectangle",
          name: "Rectangle",
          description: "Elastic entrance",
          color: "#81b6ff",
          kind: "shape",
          active,
          reduced: false,
          busy: false,
          onPreview: noop,
          onAdd: noop,
        }),
      );
    expect(tile(false)).toContain("data-thumbnail");
    expect(tile(false)).not.toContain("data-player");
    expect(tile(true)).toContain("data-player");
  });
});

describe("dragging a layer in the preview", () => {
  it("draws the dragged layer in place of the stored one", () => {
    const p = newProject();
    const title = { ...makeClip(p, "text", "titles", 0), id: "title" };
    const other = { ...makeClip(p, "text", "titles", 90), id: "other" };
    p.clips = [title, other];
    const shown = withDraft(p, { ...title, x: 400 });
    expect(shown.clips.map((c) => c.x)).toEqual([400, other.x]);
    expect(p.clips[0].x).toBe(title.x);
    // No drag, or a layer that was deleted meanwhile, leaves it untouched.
    expect(withDraft(p, undefined)).toBe(p);
    expect(withDraft(p, { ...title, id: "gone" })).toBe(p);
  });
});

describe("new and open project", () => {
  it("asks first only when work would be lost", () => {
    const empty = { project: { clips: [] as Clip[] } };
    const p = newProject();
    const clip = makeClip(p, "text", "titles", 0);
    expect(hasUnsavedWork({ ...empty, filePath: null, canUndo: false })).toBe(
      false,
    );
    expect(hasUnsavedWork({ ...empty, filePath: null, canUndo: true })).toBe(
      true,
    );
    expect(
      hasUnsavedWork({
        project: { clips: [clip] },
        filePath: null,
        canUndo: false,
      }),
    ).toBe(true);
    // A saved project autosaves to its file.
    expect(
      hasUnsavedWork({
        project: { clips: [clip] },
        filePath: "/tmp/reel.cutline",
        canUndo: true,
      }),
    ).toBe(false);
  });
});

describe("timeline keys on a focused clip", () => {
  it("moves focus with up, down, home, end and option arrows", () => {
    expect(clipKeyMove("ArrowUp", false)).toBe("up");
    expect(clipKeyMove("ArrowDown", false)).toBe("down");
    expect(clipKeyMove("Home", false)).toBe("first");
    expect(clipKeyMove("End", false)).toBe("last");
    expect(clipKeyMove("ArrowLeft", true)).toBe("previous");
    expect(clipKeyMove("ArrowRight", true)).toBe("next");
    // Plain left and right still nudge the clip.
    expect(clipKeyMove("ArrowLeft", false)).toBeUndefined();
    expect(clipKeyMove("ArrowRight", false)).toBeUndefined();
    expect(clipKeyMove("Enter", false)).toBeUndefined();
  });
});

describe("music beat list", () => {
  it("only changes when the playhead reaches another beat", async () => {
    const { beatPosition } = await import("../src/renderer/MusicSync");
    const beats = [10, 25, 40];
    // Between two beats the position holds still, so the list does not redraw.
    expect(beatPosition(beats, 11)).toBe(beatPosition(beats, 24));
    expect(beatPosition(beats, 25)).not.toBe(beatPosition(beats, 24));
    expect(beatPosition(beats, 26)).not.toBe(beatPosition(beats, 25));
    expect(beatPosition(beats, 0)).toBe(0);
    expect(beatPosition(beats, 10)).toBe(1);
    expect(beatPosition(beats, 41)).toBe(6);
  });
});

describe("effects labels", () => {
  it("read in sentence case without CSS capitalising them", async () => {
    const { EffectsPanel } = await import("../src/renderer/EffectsPanel");
    const p = newProject();
    const clip = makeClip(p, "video", "video", 0);
    p.clips = [clip];
    const html = renderToStaticMarkup(
      h(EffectsPanel, { p, clip, edit: noop, base: "" }),
    );
    expect(html).toContain(">Zoom in<");
    expect(html).toContain(">Teal orange<");
    expect(html).not.toContain(">zoom in<");
    expect(html).not.toContain("Choose a look, then fine-tune it.");
  });
});

describe("edit queue rebasing (review follow-up)", () => {
  it("rebases field patches but never whole-motion writes", async () => {
    const { createEditQueue, canRebase } =
      await import("../src/renderer/edit-gestures");
    expect(
      canRebase([{ type: "clip.update", id: "a", patch: {} } as any]),
    ).toBe(true);
    expect(canRebase([{ type: "motion.put", motion: {} } as any])).toBe(false);
    expect(
      canRebase([
        { type: "clip.update", id: "a", patch: {} } as any,
        { type: "motion.put", motion: {} } as any,
      ]),
    ).toBe(false);
    const sent: number[] = [];
    let revision = 1;
    const send = async (request: any) => {
      sent.push(request.revision);
      if (request.revision !== revision) throw new Error("Project changed");
      revision += 1;
      return { project: { id: "p", revision } };
    };
    const queue = createEditQueue(send);
    await queue({
      projectId: "p",
      revision: 1,
      label: "a",
      commands: [{ type: "clip.update", id: "a", patch: {} } as any],
    });
    // A patch made against revision 1 builds on this window's own edit (2).
    await queue({
      projectId: "p",
      revision: 1,
      label: "b",
      commands: [{ type: "clip.update", id: "a", patch: {} } as any],
    });
    // A whole-motion write made against revision 1 must fail instead.
    await expect(
      queue({
        projectId: "p",
        revision: 1,
        label: "c",
        commands: [{ type: "motion.put", motion: {} } as any],
      }),
    ).rejects.toThrow(/Project changed/);
    expect(sent).toEqual([1, 2, 1]);
  });
});
