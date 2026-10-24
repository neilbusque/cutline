import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import {
  AgentEditSchema,
  agentEditTools,
  agentEditingGuide,
  agentEditingSchemas,
  applyAgentEdit,
} from "../src/shared/agent-edit";
import {
  AssetSchema,
  ClipSchema,
  MotionSchema,
  makeClip,
  newProject,
  type Project,
} from "../src/shared/model";
import { motionValue } from "../src/shared/motion";

function fixture() {
  const p = newProject();
  const asset = AssetSchema.parse({
    id: "asset",
    name: "Interview",
    kind: "video",
    path: "/local/interview.mp4",
    duration: 20,
  });
  p.assets = [asset];
  p.clips = [
    { ...makeClip(p, "video", "video", 0, asset), id: "source", duration: 180 },
    ClipSchema.parse({
      id: "caption",
      kind: "caption",
      trackId: "captions",
      start: 60,
      duration: 90,
      captionSourceId: "source",
      text: "one two three",
      words: [
        { text: "one", start: 0, end: 1 },
        { text: "two", start: 1, end: 2 },
        { text: "three", start: 2, end: 3 },
      ],
    }),
  ];
  return p;
}
const edit = (p: Project, actions: unknown[], patch = {}) =>
  applyAgentEdit(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Assistant edit",
    actions,
    ...patch,
  });
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("structured assistant editing", () => {
  it("makes sequential cut/trim/move references and preserves source and caption animation phase", () => {
    const p = fixture(),
      before = JSON.stringify(p);
    const result = edit(p, [
      {
        type: "clip.split",
        clipId: "source",
        at: { seconds: 3 },
        rightRef: "right",
      },
      {
        type: "clip.trim",
        clipId: "$right",
        start: { frame: 120 },
        end: { seconds: 6 },
      },
      { type: "clip.move", clipId: "$right", at: { seconds: 7 } },
      {
        type: "clip.keyframe",
        clipId: "$right",
        property: "scale",
        frame: 0,
        value: 1.1,
        easing: "linear",
      },
    ]);
    const right = result.project.clips.find(
      (c) => c.id === result.references.right,
    )!;
    expect(right).toMatchObject({
      start: 210,
      duration: 60,
      sourceIn: 4,
      animationOffset: 120,
    });
    expect(right.keyframes).toEqual([
      { property: "scale", frame: 120, value: 1.1, easing: "linear" },
    ]);
    const caption = result.project.clips.find(
      (c) => c.captionSourceId === right.id,
    )!;
    expect(caption).toMatchObject({
      start: 210,
      duration: 30,
      text: "three",
      animationOffset: 60,
    });
    expect(caption.words[0]).toMatchObject({ text: "three", start: 0, end: 1 });
    expect(result.project.clips.find((c) => c.id === "source")?.duration).toBe(
      90,
    );
    expect(result.summary.actionCount).toBe(4);
    expect(JSON.stringify(p)).toBe(before);
    expect(result.project.revision).toBe(p.revision + 1);
  });

  it("applies many actions on one private copy and still names the action that broke the project", () => {
    const p = fixture(),
      before = JSON.stringify(p);
    const actions = Array.from({ length: 20 }, (_, i) => ({
      type: "clip.update",
      clipId: "source",
      patch: { opacity: 0.5 + i / 50 },
    }));
    const result = edit(p, actions);
    expect(result.project.clips.find((c) => c.id === "source")?.opacity).toBeCloseTo(0.88);
    expect(JSON.stringify(p)).toBe(before);
    // Trimming past the end of the source only fails the finished project's
    // check; the error still points at the action.
    expect(() =>
      edit(p, [
        { type: "clip.update", clipId: "source", patch: { opacity: 0.9 } },
        { type: "clip.update", clipId: "source", patch: { sourceIn: 19.5 } },
      ]),
    ).toThrow(/^Action 2 \(clip\.update\): .*Trim exceeds source media/u);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("reaches every layer of a large vector, not just the first 24", () => {
    const p = newProject();
    const rects = Array.from(
      { length: 30 },
      (_, i) =>
        `<rect id="r${i}" x="${(i % 6) * 80}" y="${Math.floor(i / 6) * 80}" width="60" height="60" fill="#${(0x203040 + i * 0x050301).toString(16)}"/>`,
    ).join("");
    const result = edit(p, [
      {
        type: "motion.svg",
        svg: `<svg viewBox="0 0 480 400">${rects}</svg>`,
        at: { frame: 0 },
        ref: "art",
      },
      {
        type: "motion.keyframe",
        motionId: "$art.motion",
        layer: 29,
        property: "opacity",
        frame: 10,
        value: 0.5,
      },
      {
        type: "motion.layer.update",
        motionId: "$art.motion",
        layer: 28,
        patch: { hidden: true },
      },
    ]);
    const art = result.project.motions.find(
      (m) => m.id === result.references["art.motion"],
    )!;
    expect(art.layers).toHaveLength(30);
    expect(art.layers[29].keyframes.some((k) => k.frame === 10)).toBe(true);
    expect(art.layers[28].hidden).toBe(true);
  });

  it("creates motion scenes/shapes, styles layers and independently edits loop endpoint keys", () => {
    const p = newProject();
    const result = edit(p, [
      {
        type: "motion.scene",
        scene: "orbit-logo",
        at: { frame: 0 },
        ref: "logo",
      },
      {
        type: "motion.layer.update",
        motionId: "$logo.motion",
        layer: 1,
        patch: { glow: 18, anchorX: 0 },
      },
      {
        type: "motion.keyframe",
        motionId: "$logo.motion",
        layer: 1,
        property: "rotate",
        frame: 120,
        value: 720,
        easing: "linear",
      },
      { type: "motion.shape", shape: "star", at: { seconds: 4 }, ref: "star" },
      { type: "clip.update", clipId: "$star", patch: { opacity: 0.8 } },
    ]);
    const logo = result.project.motions.find(
      (m) => m.id === result.references["logo.motion"],
    )!;
    expect(logo.layers[1]).toMatchObject({
      glow: 18,
      anchorX: 0,
      loop: "cycle",
      loopFrames: 120,
    });
    expect(logo.layers[1].keyframes.find((k) => k.frame === 120)?.rotate).toBe(
      720,
    );
    expect(
      result.project.clips.find((c) => c.id === result.references.star)
        ?.opacity,
    ).toBe(0.8);
    expect(
      result.created.filter((item) => item.kind === "motion"),
    ).toHaveLength(2);
    expect(result.references.logo).toBeTruthy();
  });

  it("preserves unrelated sparse curve values and easing when agent keys are updated", () => {
    const p = newProject();
    p.motions = [
      MotionSchema.parse({
        id: "motion",
        name: "Independent curves",
        layers: [
          {
            type: "rectangle",
            keyframes: [
              { frame: 0, x: 0, easing: "hold" },
              { frame: 0, opacity: 0, easing: "linear" },
              { frame: 20, x: 100, opacity: 1 },
            ],
          },
        ],
      }),
    ];
    const result = edit(p, [
      {
        type: "motion.keyframe",
        motionId: "motion",
        layer: 0,
        property: "x",
        frame: 0,
        value: -20,
        easing: "back",
      },
      {
        type: "motion.layer.add",
        motionId: "motion",
        definition: { type: "triangle", background: "#ffcc00" },
      },
      { type: "motion.layer.move", motionId: "motion", layer: 1, to: 0 },
    ]);
    expect(result.project.motions[0].layers[0].type).toBe("triangle");
    const layer = result.project.motions[0].layers[1];
    expect(motionValue(layer, "opacity", 10)).toBe(0.5);
    expect(
      layer.keyframes.find((k) => k.frame === 0 && k.x !== undefined)?.easing,
    ).toBe("back");
    expect(
      edit(result.project, [
        {
          type: "motion.keyframe",
          motionId: "motion",
          layer: 1,
          property: "x",
          frame: 0,
          remove: true,
        },
      ]).project.motions[0].layers[1].keyframes.some(
        (k) => k.frame === 0 && k.x !== undefined,
      ),
    ).toBe(false);
  });

  it("names and hides layers and moves one custom property key in a single undoable transaction", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "cutline-layer-edit-"),
    );
    directories.push(directory);
    const store = new Store(path.join(directory, "recovery.cutline"));
    const p = store.project;
    p.motions = [
      MotionSchema.parse({
        id: "motion",
        name: "Editorial scene",
        layers: [
          {
            type: "rectangle",
            keyframes: [
              {
                frame: 0,
                x: -10,
                opacity: 0.2,
                easing: "cubic-bezier",
                bezier: [0.16, 1, 0.3, 1],
              },
              { frame: 20, x: 100, opacity: 0.9 },
            ],
          },
        ],
      }),
    ];
    const source = structuredClone(p);
    const actions = [
      {
        type: "motion.layer.update",
        motionId: "motion",
        layer: 0,
        patch: { name: "Accent circle", hidden: true },
      },
      {
        type: "motion.keyframe.move",
        motionId: "motion",
        layer: 0,
        property: "x",
        fromFrame: 0,
        toFrame: 5,
      },
    ];
    const dryRun = edit(p, actions, { dryRun: true });
    expect(dryRun.project.motions[0].layers[0]).toMatchObject({
      name: "Accent circle",
      hidden: true,
    });
    expect(store.project).toEqual(source);
    expect(store.past).toHaveLength(0);
    const prepared = edit(p, actions);
    store.commit(prepared.project, prepared.label);
    const moved = store.project.motions[0].layers[0];
    expect(moved.keyframes.find((key) => key.frame === 5)).toMatchObject({
      x: -10,
      easing: "cubic-bezier",
      bezier: [0.16, 1, 0.3, 1],
    });
    expect(moved.keyframes.find((key) => key.frame === 0)).toMatchObject({
      opacity: 0.2,
      easing: "cubic-bezier",
      bezier: [0.16, 1, 0.3, 1],
    });
    expect(
      moved.keyframes.some((key) => key.frame === 0 && key.x !== undefined),
    ).toBe(false);
    expect(motionValue(moved, "opacity", 10)).toBe(
      motionValue(source.motions[0].layers[0], "opacity", 10),
    );
    expect(store.past).toHaveLength(1);
    const recovered = new Store(store.recovery);
    expect(recovered.project.motions).toEqual(store.project.motions);
    store.undo();
    expect(store.project.motions).toEqual(source.motions);
    store.redo();
    expect(store.project.motions[0].layers[0]).toEqual(moved);
  });

  it("rejects motion key move conflicts and missing sources without changing revision or history", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "cutline-key-conflict-"),
    );
    directories.push(directory);
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.project.motions = [
      MotionSchema.parse({
        id: "motion",
        name: "Conflict scene",
        layers: [
          {
            type: "text",
            text: "UNCHANGED",
            keyframes: [
              { frame: 0, opacity: 0 },
              { frame: 20, opacity: 1 },
            ],
          },
        ],
      }),
    ];
    const original = structuredClone(store.project);
    for (const action of [
      { property: "opacity", fromFrame: 0, toFrame: 20 },
      { property: "opacity", fromFrame: 5, toFrame: 10 },
      { property: "opacity", fromFrame: 0, toFrame: -1 },
    ])
      expect(() =>
        edit(store.project, [
          {
            type: "motion.layer.update",
            motionId: "motion",
            layer: 0,
            patch: { name: "Attempt", hidden: true },
          },
          {
            type: "motion.keyframe.move",
            motionId: "motion",
            layer: 0,
            ...action,
          },
        ]),
      ).toThrow();
    expect(store.project).toEqual(original);
    expect(store.project.revision).toBe(original.revision);
    expect(store.past).toHaveLength(0);
    expect(store.future).toHaveLength(0);
  });

  it("corrects/stylizes captions while preserving actual aligned word timing", () => {
    const p = fixture();
    const result = edit(p, [
      { type: "caption.update", clipId: "caption", text: "ONE TWO THREE" },
      {
        type: "caption.style",
        clipIds: ["caption"],
        style: "pop",
        patch: { accent: "#ffcc00" },
      },
    ]);
    const caption = result.project.clips.find((c) => c.id === "caption")!;
    expect(caption.words.map((w) => ({ start: w.start, end: w.end }))).toEqual(
      p.clips[1].words.map((w) => ({ start: w.start, end: w.end })),
    );
    expect(caption.words.map((w) => w.text)).toEqual(["ONE", "TWO", "THREE"]);
    expect(caption).toMatchObject({
      start: 60,
      duration: 90,
      captionLayout: "balanced",
      captionStyle: "pop",
      accent: "#ffcc00",
    });
    const corrected = edit(result.project, [
      {
        type: "caption.update",
        clipId: "caption",
        text: "A different sentence now",
      },
    ]);
    expect(
      corrected.project.clips.find((c) => c.id === "caption")?.words,
    ).toEqual([]);
    expect(corrected.summary.warnings[0]).toContain("word timing was cleared");
  });

  it("imports subtitle timing into an explicit track and supports track/clip creation references", () => {
    const p = newProject();
    const result = edit(p, [
      { type: "track.add", kind: "text", name: "My captions", ref: "captions" },
      {
        type: "caption.import",
        srt: "1\n00:00:00,000 --> 00:00:01,000\nHello there\n",
        at: { seconds: 2 },
        trackId: "$captions",
      },
      {
        type: "clip.add",
        kind: "text",
        at: { seconds: 4 },
        duration: { seconds: 2 },
        trackId: "$captions",
        patch: { text: "HELLO", preset: "spring" },
        ref: "title",
      },
      { type: "track.move", trackId: "$captions", index: 1 },
    ]);
    const caption = result.project.clips.find((c) => c.kind === "caption")!;
    expect(caption).toMatchObject({
      start: 60,
      text: "Hello there",
      trackId: result.references.captions,
    });
    expect(result.project.tracks[1].id).toBe(result.references.captions);
    expect(
      result.project.clips.find((c) => c.id === result.references.title),
    ).toMatchObject({
      start: 120,
      duration: 60,
      text: "HELLO",
      preset: "spring",
    });
    const empty = newProject();
    empty.tracks = [];
    expect(
      edit(empty, [
        { type: "clip.add", kind: "text", patch: { text: "Auto track" } },
      ]).project.tracks,
    ).toHaveLength(1);
  });

  it("duplicates/moves linked captions and deletes them with their source", () => {
    const p = fixture();
    const result = edit(p, [
      {
        type: "clip.duplicate",
        clipId: "source",
        at: { seconds: 8 },
        ref: "copy",
      },
      { type: "clip.delete", clipId: "source" },
    ]);
    const copied = result.project.clips.find(
      (c) => c.id === result.references.copy,
    )!;
    expect(copied.start).toBe(240);
    expect(
      result.project.clips.filter((c) => c.captionSourceId === copied.id),
    ).toHaveLength(1);
    expect(
      result.project.clips.find((c) => c.captionSourceId === copied.id)?.start,
    ).toBe(300);
    expect(
      result.project.clips.some(
        (c) => c.id === "source" || c.captionSourceId === "source",
      ),
    ).toBe(false);
  });

  it("keeps patches sparse and returns source-bound trim warnings", () => {
    const p = fixture();
    const result = edit(p, [
      { type: "clip.update", clipId: "source", patch: { volume: 0.5 } },
      { type: "clip.trim", clipId: "source", end: { seconds: 99 } },
    ]);
    const clip = result.project.clips.find((c) => c.id === "source")!;
    expect(clip).toMatchObject({
      volume: 0.5,
      x: p.clips[0].x,
      y: p.clips[0].y,
      width: p.width,
      height: p.height,
      duration: 600,
    });
    expect(result.summary.warnings[0]).toContain(
      "bounded to available source frames",
    );
  });

  it("rejects a stale revision, bad references, invalid keys and failed later actions without mutation", () => {
    const p = fixture(),
      before = JSON.stringify(p);
    expect(() =>
      edit(p, [{ type: "project.update", patch: { name: "Changed" } }], {
        revision: 99,
      }),
    ).toThrow("Project changed");
    expect(() =>
      edit(p, [
        { type: "clip.update", clipId: "$missing", patch: { opacity: 0.4 } },
      ]),
    ).toThrow("Unknown edit reference");
    expect(() =>
      edit(p, [
        { type: "project.update", patch: { name: "Changed" } },
        {
          type: "clip.move",
          clipId: "source",
          at: { frame: 30 },
          trackId: "audio",
        },
      ]),
    ).toThrow("Action 2");
    expect(() =>
      edit(p, [
        {
          type: "clip.keyframe",
          clipId: "source",
          property: "opacity",
          frame: 0,
          value: 10,
        },
      ]),
    ).toThrow();
    expect(() => edit(p, [{ type: "track.delete", trackId: "video" }])).toThrow(
      "contains clips",
    );
    expect(() =>
      edit(p, [
        { type: "caption.update", clipId: "source", text: "Wrong kind" },
      ]),
    ).toThrow("caption clip");
    expect(JSON.stringify(p)).toBe(before);
  });

  it("resolves earlier creations in complete commands and rejects incompatible media patches", () => {
    const p = fixture();
    const result = edit(p, [
      {
        type: "clip.add",
        kind: "text",
        patch: { text: "COMMAND" },
        ref: "title",
      },
      {
        type: "command",
        command: { type: "clip.update", id: "$title", patch: { opacity: 0.4 } },
      },
    ]);
    expect(
      result.project.clips.find((c) => c.id === result.references.title)
        ?.opacity,
    ).toBe(0.4);
    p.assets.push(
      AssetSchema.parse({
        id: "photo",
        kind: "image",
        name: "Photo",
        path: "/local/photo.png",
        duration: 4,
      }),
    );
    expect(() =>
      edit(p, [
        { type: "clip.update", clipId: "source", patch: { assetId: "photo" } },
      ]),
    ).toThrow("does not support this clip kind");
    expect(() =>
      edit(p, [
        {
          type: "clip.add",
          kind: "video",
          assetId: "asset",
          patch: { assetId: "photo" },
        },
      ]),
    ).toThrow("does not support this clip kind");
  });

  it("commits a prepared multi-action edit as one undo entry and dry-run leaves the store untouched", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "cutline-agent-edit-"),
    );
    directories.push(directory);
    const store = new Store(path.join(directory, "recovery.cutline"));
    const before = store.project;
    const actions = [
      { type: "motion.shape", shape: "star", at: { frame: 0 }, ref: "star" },
      { type: "clip.update", clipId: "$star", patch: { opacity: 0.7 } },
      { type: "project.update", patch: { name: "Agent scene" } },
    ];
    const dry = edit(store.project, actions, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(store.project).toBe(before);
    expect(store.past).toHaveLength(0);
    const prepared = edit(store.project, actions);
    store.commit(prepared.project, prepared.label);
    expect(store.past).toHaveLength(1);
    expect(store.project.clips).toHaveLength(1);
    store.undo();
    expect(store.project.clips).toHaveLength(0);
    expect(store.project.name).toBe(before.name);
    store.redo();
    expect(store.project.clips[0].opacity).toBe(0.7);
  });

  it("publishes complete serializable schemas, bounds and tools for machine discovery", () => {
    const schema = { ...agentEditingGuide(), schemas: agentEditingSchemas() };
    expect(() => JSON.stringify(schema)).not.toThrow();
    expect(schema.schemas.clip).toHaveProperty("properties.cameraMotion");
    expect(schema.schemas.motionLayer).toHaveProperty(
      "properties.textAnimation",
    );
    expect(schema.schemas.motionLayer).toHaveProperty("properties.loopFrames");
    expect(schema.schemas.motionLayer).toHaveProperty(
      "properties.name.maxLength",
      80,
    );
    expect(schema.schemas.motionLayer).toHaveProperty(
      "properties.hidden.default",
      false,
    );
    expect(schema.schemas.motionLayerPatch).toHaveProperty(
      "properties.name.maxLength",
      80,
    );
    expect(JSON.stringify(schema.schemas.action)).toContain(
      "motion.keyframe.move",
    );
    expect(schema.schemas.command).toHaveProperty("oneOf");
    expect(schema.motionProperties.trim).toEqual([0, 1]);
    expect(schema.timing.references).toContain("$name.motion");
    expect(agentEditTools.map((tool) => tool.name)).toEqual([
      "cutline_editing_schema",
      "cutline_edit",
    ]);
    expect(() =>
      AgentEditSchema.parse({
        projectId: "project",
        revision: 0,
        label: "Unknown field",
        actions: [
          {
            type: "clip.move",
            clipId: "clip",
            at: { frame: 0 },
            code: "execute()",
          },
        ],
      }),
    ).toThrow();
  });
});
