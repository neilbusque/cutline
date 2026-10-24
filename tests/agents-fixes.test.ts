import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import {
  AssetSchema,
  makeClip,
  newProject,
  publicProject,
  validateProject,
  type Job,
  type Project,
} from "../src/shared/model";
import { replaceGeneratedCaptions } from "../src/shared/caption-generation";
import {
  agentEditingGuide,
  agentEditingSchema,
  agentEditTools,
  applyAgentEdit,
  editingSchemaSection,
  editingSchemaSections,
} from "../src/shared/agent-edit";
import {
  changeSummary,
  conflictMessage,
  editResult,
  inspectProject,
  performAgentEdit,
  readableError,
} from "../src/shared/agent-inspect";
import { readTranscript, searchTranscript } from "../src/shared/transcript";
import { effectsGuideResult } from "../src/shared/agent-guide";
import {
  assistantInstructions,
  cutlineCore,
  cutlineWorkflow,
} from "../src/shared/assistant-instructions";
import { parseMarkdown } from "../src/shared/chat-markdown";
import { cutlineTools } from "../src/main/agent-tools";
import { createAgentIO } from "../src/main/agent-io";
import { AgentTasks } from "../src/main/agent-tasks";
import {
  contactSheet,
  previewContent,
  previewFrames,
  previewSize,
  renderPreview,
  SHEET_MAX_SIDE,
  sheetLayout,
  StillWorker,
} from "../src/main/agent-preview";
import {
  CUTLINE_CLOSED,
  createLauncher,
  openCutlineApp,
  postJson,
} from "../src/main/mcp-launcher";
import { createMcpServer, mcpResult } from "../src/main/mcp-server";
import { sessionTools } from "../src/main/session-routing";
import { startBridge } from "../src/main/bridge";
import { Store } from "../src/main/store";
import { Jobs, Media } from "../src/main/media";
import { MessageText, toolActivity } from "../src/renderer/Assistant";

const root = path.resolve(__dirname, "..");
const ffmpeg = path.join(
  root,
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.join(
  root,
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const size = (value: unknown) => JSON.stringify(value).length;
/** Claude Code refuses tool output over 25,000 tokens; 60,000 characters keeps a wide margin. */
const RESULT_CAP = 60_000;

const directories: string[] = [];
const temporary = (prefix: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const vocabulary =
  "so today we are going to talk about how a better morning routine can change your whole day and honestly it starts the night before".split(
    " ",
  );
/** A ten-minute interview: 1,500 transcript words, a waveform and generated captions. */
function interview() {
  const p = newProject();
  p.name = "Interview";
  const words = Array.from({ length: 1500 }, (_, index) => ({
    text: ` ${vocabulary[index % vocabulary.length]}${index % 37 === 36 ? "." : ""}`,
    start: index * 0.4,
    end: index * 0.4 + 0.32,
  }));
  // A phrase with punctuation and capitals, and one that the timeline cuts out.
  Object.assign(words[700], { text: " Thank" });
  Object.assign(words[701], { text: " you," });
  Object.assign(words[702], { text: " so" });
  Object.assign(words[703], { text: " MUCH!" });
  Object.assign(words[1490], { text: " thank" });
  Object.assign(words[1491], { text: " you" });
  Object.assign(words[1492], { text: " so" });
  Object.assign(words[1493], { text: " much" });
  const asset = AssetSchema.parse({
    id: "interview-asset",
    name: "Interview.mp4",
    kind: "video",
    path: "/Users/someone/Private/Interview.mp4",
    thumbnail: "/Users/someone/Private/thumb.jpg",
    proxy: "/Users/someone/Private/proxy.mp4",
    duration: 600,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    waveform: Array.from({ length: 6000 }, (_, index) =>
      Number(Math.abs(Math.sin(index / 7)).toFixed(4)),
    ),
    words,
  });
  p.assets = [asset];
  // The last 10 seconds are trimmed off.
  p.clips = [
    {
      ...makeClip(p, "video", "video", 0, asset),
      id: "interview-clip",
      duration: 590 * 30,
    },
    {
      ...makeClip(p, "text", "titles", 30),
      id: "title",
      text: "A better morning",
    },
  ];
  const generated = replaceGeneratedCaptions(
    p,
    "interview-clip",
    words.filter((word) => word.end < 590),
  );
  return validateProject({ ...generated.project, revision: 3 });
}

describe("tool definitions stay small, complete and annotated", () => {
  it("lists every tool well under the output cap, with cutline_edit a fraction of its old 66,000 characters", () => {
    const listed = { tools: cutlineTools };
    // Budget for the whole list: under 50,000 characters (about 12,500
    // tokens) so every client loads it comfortably. Trim descriptions or
    // schemas before raising it.
    expect(size(listed)).toBeLessThan(50_000);
    for (const tool of cutlineTools) {
      expect(tool.name).toMatch(/^cutline_/);
      expect(size(tool)).toBeLessThan(25_000);
      // Claude Code cuts descriptions at 2,048 characters.
      expect(tool.description!.length).toBeLessThan(2048);
      expect((tool.inputSchema as any).type).toBe("object");
    }
    expect(new Set(cutlineTools.map((tool) => tool.name)).size).toBe(
      cutlineTools.length,
    );
    const edit = cutlineTools.find((tool) => tool.name === "cutline_edit")!;
    // cutline_edit's budget within it; trim before raising.
    expect(size(edit)).toBeLessThan(24_000);
    const actions = (
      edit.inputSchema as any
    ).properties.actions.items.oneOf.map(
      (action: any) => action.properties.type.const,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "clip.add",
        "clip.trim",
        "motion.keyframe",
        "caption.style",
        "project.update",
      ]),
    );
    expect(actions).not.toContain("command");
    expect((edit.inputSchema as any).properties.detail.enum).toEqual([
      "summary",
      "full",
    ]);
    // The schema no longer repeats the safe-integer bounds or the draft URI.
    expect(JSON.stringify(edit.inputSchema)).not.toContain("9007199254740991");
    expect(JSON.stringify(edit.inputSchema)).not.toContain("$schema");
  });

  it("marks reads as read-only and destructive edits as destructive", () => {
    const hints = Object.fromEntries(
      cutlineTools.map((tool) => [tool.name, tool.annotations]),
    );
    for (const tool of cutlineTools)
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
    const readOnly = cutlineTools
      .filter((tool) => tool.annotations?.readOnlyHint)
      .map((tool) => tool.name)
      .sort();
    expect(readOnly).toEqual([
      "cutline_connection_status",
      "cutline_director_guide",
      "cutline_editing_schema",
      "cutline_effects_guide",
      "cutline_get_srt",
      "cutline_inspect",
      "cutline_jobs",
      "cutline_list_projects",
      "cutline_music_inspect",
      "cutline_quality_check",
      "cutline_search_transcript",
      "cutline_stock_search",
      "cutline_transcript",
    ]);
    for (const name of [
      "cutline_undo",
      "cutline_remove_pauses",
      "cutline_create_reel",
      "cutline_open_project",
      "cutline_new_project",
    ])
      expect(hints[name]?.destructiveHint).toBe(true);
    expect(hints.cutline_stock_search?.openWorldHint).toBe(true);
    expect(hints.cutline_inspect?.openWorldHint).toBe(false);
  });

  it("keeps the old tool names and parameters", () => {
    const names = cutlineTools.map((tool) => tool.name);
    for (const name of [
      "cutline_editing_schema",
      "cutline_edit",
      "cutline_import_media",
      "cutline_vector_import",
      "cutline_save_project",
      "cutline_open_project",
      "cutline_new_project",
      "cutline_redo",
      "cutline_cancel_job",
      "cutline_caption_srt",
      "cutline_get_srt",
      "cutline_preview",
      "cutline_connection_status",
      "cutline_music_analyze",
      "cutline_create_reel",
      "cutline_stock_search",
      "cutline_effects_guide",
      "cutline_inspect",
      "cutline_apply_edits",
      "cutline_transcribe",
      "cutline_remove_pauses",
      "cutline_search_transcript",
      "cutline_export",
      "cutline_jobs",
      "cutline_undo",
    ])
      expect(names).toContain(name);
    const preview = cutlineTools.find(
      (tool) => tool.name === "cutline_preview",
    )!.inputSchema as any;
    for (const field of [
      "frame",
      "seconds",
      "clipId",
      "playing",
      "image",
      "frames",
      "count",
    ])
      expect(preview.properties).toHaveProperty(field);
    expect(preview.required ?? []).not.toContain("revision");
  });
});

describe("cutline_editing_schema fits the output cap and reads in sections", () => {
  it("returns a short guide by default instead of 224,000 characters of schemas", () => {
    const guide = agentEditingSchema() as any;
    expect(size(guide)).toBeLessThan(20_000);
    expect(guide.schemas).toBeUndefined();
    expect(guide.actions["clip.update"]).toBe("clipId, patch");
    expect(guide.actions["clip.trim"]).toBe("clipId, start?, end?");
    expect(guide.values.fonts).toContain("Georgia");
    expect(guide.values.looks).toContain("teal-orange");
    expect(guide.values.presets).toContain("lower-third");
    expect(guide.values.motionScenes.length).toBeGreaterThan(10);
    expect(guide.sections).toContain("action:<type>");
    expect(agentEditingSchema({ section: "guide" })).toEqual(guide);
    expect(agentEditingGuide()).toEqual(guide);
  });

  it("serves every section and every action and command alone, each small", () => {
    const actions = Object.keys(agentEditingGuide().actions);
    const commands = Object.keys(editingSchemaSection("commands") as object);
    const sections = [
      ...editingSchemaSections,
      ...actions.map((type) => `action:${type}`),
      ...commands.map((type) => `command:${type}`),
      "action:command",
    ];
    for (const section of sections) {
      const result = agentEditingSchema({ section });
      expect(size(result), section).toBeLessThan(25_000);
    }
    expect(
      (agentEditingSchema({ section: "clip" }) as any).schema.properties,
    ).toHaveProperty("cameraMotion");
    expect(
      (agentEditingSchema({ section: "action:clip.keyframe" }) as any).schema
        .required,
    ).toEqual(expect.arrayContaining(["clipId", "property", "frame"]));
    expect(() => agentEditingSchema({ section: "clips" })).toThrow(
      /Unknown section "clips".*clipPatch.*action:<type>/s,
    );
  });
});

describe("inspect and edit results are concise by default", () => {
  it("documents the old full-project echo on a ten-minute interview", () => {
    expect(size(publicProject(interview()))).toBeGreaterThan(300_000);
  });

  it("summarizes a ten-minute interview without words, waveform or paths", () => {
    const p = interview();
    const captions = p.clips.filter((clip) => clip.kind === "caption");
    expect(captions.length).toBeGreaterThan(300);
    const summary = inspectProject(p) as any;
    const text = JSON.stringify(summary);
    expect(text.length).toBeLessThan(15_000);
    expect(text).not.toContain("/Users/someone");
    expect(text).not.toContain("waveform");
    expect(summary.revision).toBe(p.revision);
    expect(summary.assets[0].transcriptWords).toBe(1500);
    expect(summary.clips.map((clip: any) => clip.id)).toEqual([
      "interview-clip",
      "title",
    ]);
    expect(summary.clips[1]).toMatchObject({
      kind: "text",
      text: "A better morning",
      preset: "spring",
    });
    expect(summary.captionGroups).toEqual([
      expect.objectContaining({
        sourceClipId: "interview-clip",
        count: captions.length,
      }),
    ]);
  });

  it("pages full detail and filtered captions under the cap", () => {
    const p = interview();
    const seen = new Set<string>();
    let offset: number | undefined = 0,
      pages = 0;
    while (offset !== undefined) {
      const page = inspectProject(p, { detail: "full", offset }) as any;
      expect(size(page)).toBeLessThan(RESULT_CAP);
      expect(JSON.stringify(page)).not.toContain("/Users/someone");
      expect(page.assets[0].words).toBeUndefined();
      for (const clip of page.clips) {
        expect(seen.has(clip.id)).toBe(false);
        seen.add(clip.id);
      }
      offset = page.page?.nextOffset;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(p.clips.length);
    const window = inspectProject(p, {
      kinds: ["caption"],
      fromFrame: 300,
      toFrame: 600,
    }) as any;
    expect(window.clips.length).toBeGreaterThan(2);
    for (const clip of window.clips) {
      expect(clip.kind).toBe("caption");
      expect(clip.start).toBeLessThan(600);
      expect(clip.start + clip.duration).toBeGreaterThan(300);
    }
    const one = inspectProject(p, {
      detail: "full",
      clipIds: ["title"],
    }) as any;
    expect(one.clips).toEqual([p.clips.find((clip) => clip.id === "title")]);
  });

  it("returns complete clips and motions in stored order for a small project", () => {
    const p = newProject();
    const result = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Scene",
      actions: [
        { type: "motion.scene", scene: "studio-title", at: { frame: 0 } },
        { type: "clip.add", kind: "text", at: { frame: 10 } },
      ],
    });
    const full = inspectProject(result.project, { detail: "full" }) as any;
    expect(full.clips).toEqual(result.project.clips);
    expect(full.motions).toEqual(result.project.motions);
    const summary = inspectProject(result.project) as any;
    expect(summary.motions[0].layers[0]).toHaveProperty("index", 0);
    expect(size(summary)).toBeLessThan(size(full));
  });

  it("answers an edit with the revision, created IDs and a short summary", () => {
    const directory = temporary("cutline-edit-result-");
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.commit(interview(), "Interview");
    const before = store.project;
    const prepared = applyAgentEdit(before, {
      projectId: before.id,
      revision: before.revision,
      label: "Title and style",
      actions: [
        { type: "clip.add", kind: "text", at: { seconds: 2 }, ref: "hook" },
        {
          type: "caption.style",
          clipIds: before.clips
            .filter((clip) => clip.kind === "caption")
            .map((clip) => clip.id),
          style: "karaoke",
        },
      ],
    });
    store.commit(prepared.project, prepared.label);
    const result = editResult(prepared, store.project) as any;
    expect(size(result)).toBeLessThan(10_000);
    expect(result.revision).toBe(store.project.revision);
    expect(result.created).toEqual([
      expect.objectContaining({ kind: "clip", ref: "hook" }),
    ]);
    expect(result.references.hook).toBe(result.created[0].id);
    expect(result.summary.changedClipIds).toHaveLength(100);
    expect(result.summary.changedClipCount).toBeGreaterThan(300);
    expect(result.project).toBeUndefined();
    const full = editResult(prepared, store.project, "full") as any;
    expect(size(full)).toBeLessThan(RESULT_CAP);
    expect(full.clips.length).toBeGreaterThan(10);
    expect(full.note).toMatch(/did not fit/);
  });

  it("lets a dry run's revision commit the same edit", () => {
    const directory = temporary("cutline-dry-run-");
    const store = new Store(path.join(directory, "recovery.cutline"));
    const live = store.project;
    const edit = {
      projectId: live.id,
      revision: live.revision,
      label: "Line",
      actions: [{ type: "motion.shape", shape: "line", at: { frame: 0 } }],
    };
    const dry = applyAgentEdit(live, { ...edit, dryRun: true });
    expect(dry.project.revision).toBe(live.revision);
    const reply = editResult(dry, store.project) as any;
    expect(reply.revision).toBe(live.revision);
    expect(reply.note).toContain(`revision ${live.revision}`);
    expect(store.project).toBe(live);
    const committed = applyAgentEdit(store.project, {
      ...edit,
      revision: reply.revision,
    });
    store.commit(committed.project, committed.label);
    expect(store.project.clips).toHaveLength(1);
  });

  it("rejects a bad argument before committing anything", () => {
    const directory = temporary("cutline-edit-args-");
    const store = new Store(path.join(directory, "recovery.cutline"));
    const edit = {
      projectId: store.project.id,
      revision: store.project.revision,
      label: "Title",
      actions: [{ type: "clip.add", kind: "text" }],
    };
    expect(() =>
      performAgentEdit(store, { ...edit, detail: "verbose" }),
    ).toThrow();
    expect(store.past).toHaveLength(0);
    expect(store.project.clips).toHaveLength(0);
    const done = performAgentEdit(store, { ...edit, detail: "full" }) as any;
    expect(done.revision).toBe(store.project.revision);
    expect(done.clips).toHaveLength(1);
    expect(store.past).toHaveLength(1);
  });

  it("summarizes undo-style changes without the project", () => {
    const p = interview();
    const next = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Move title",
      actions: [{ type: "clip.move", clipId: "title", at: { frame: 90 } }],
    }).project;
    const summary = changeSummary(p, next);
    expect(summary.changedClipIds).toEqual(["title"]);
    expect(size(summary)).toBeLessThan(500);
  });
});

describe("errors say how to recover", () => {
  it("names the current revision, the edits since and what they touched", () => {
    const directory = temporary("cutline-conflict-");
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.commit(interview(), "Interview");
    const seen = store.project;
    const moved = applyAgentEdit(seen, {
      projectId: seen.id,
      revision: seen.revision,
      label: "Nudge title",
      actions: [{ type: "clip.move", clipId: "title", at: { frame: 45 } }],
    });
    store.commit(moved.project, moved.label);
    let message = "";
    try {
      applyAgentEdit(store.project, {
        projectId: seen.id,
        revision: seen.revision,
        label: "Late edit",
        actions: [{ type: "project.update", patch: { name: "Late" } }],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Project changed/);
    expect(message).toContain(`revision ${seen.revision}`);
    expect(message).toContain(`revision ${store.project.revision}`);
    const recovered = conflictMessage(
      message,
      { projectId: seen.id, revision: seen.revision },
      store.project,
      store.past,
    );
    expect(recovered).toContain(
      `Retry with revision ${store.project.revision}`,
    );
    expect(recovered).toContain("Nudge title");
    expect(recovered).toContain("clip title");
    expect(
      conflictMessage(
        "Project changed. Inspect the project and retry.",
        { projectId: "other", revision: 0 },
        store.project,
        store.past,
      ),
    ).toContain("a different project is open now");
    expect(conflictMessage("Clip x is missing.", {}, store.project, [])).toBe(
      "Clip x is missing.",
    );
    // Saved undo steps are checked only when used; a damaged one must not
    // turn every conflict into a TypeError.
    const damaged = [
      { label: "Damaged", project: null as unknown as Project },
      {
        label: "Half read",
        project: { id: seen.id, revision: seen.revision } as Project,
      },
      ...store.past.slice(-1),
    ];
    const tolerant = conflictMessage(
      message,
      { projectId: seen.id, revision: seen.revision },
      store.project,
      damaged,
    );
    expect(tolerant).toContain("Edits since then: Half read, Nudge title.");
    expect(tolerant).toContain(`Retry with revision ${store.project.revision}`);
  });

  it("turns validation dumps into one line with where to look", () => {
    const p = newProject();
    let error: unknown;
    try {
      applyAgentEdit(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Wrong field",
        actions: [
          {
            type: "clip.add",
            kind: "text",
            ref: "t",
          },
          {
            type: "clip.keyframe",
            clipId: "$t",
            property: "opacity",
            frame: 0,
            value: 1,
            id: "x",
          },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    const message = readableError(error, {
      actions: [{ type: "clip.add" }, { type: "clip.keyframe" }],
    });
    expect(message).toBe(
      'Invalid input: actions.1: Unrecognized key: "id". Read cutline_editing_schema with section action:clip.keyframe for its fields.',
    );
  });
});

describe("transcript search finds phrases on the timeline", () => {
  it("matches a multi-word phrase ignoring case and punctuation, with clip and frames", () => {
    const p = interview();
    const hits = searchTranscript(p, { query: "thank you so much" }) as any[];
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      clipId: "interview-clip",
      assetId: "interview-asset",
      text: "Thank you, so MUCH!",
      start: 280,
      startFrame: 8400,
    });
    expect(hits[0].endFrame).toBeGreaterThan(hits[0].startFrame);
    expect(hits[0].context).toContain("Thank you, so MUCH!");
    // The second one is in the trimmed-off end of the source.
    expect(hits[1]).toMatchObject({ clipId: null, start: 596 });
    expect(
      searchTranscript(p, { query: "better morning" }).length,
    ).toBeGreaterThan(5);
    expect(
      searchTranscript(p, { query: "better morning", limit: 3 }),
    ).toHaveLength(3);
    expect(searchTranscript(p, { query: "morn" }).length).toBeGreaterThan(5);
    expect(
      size(searchTranscript(p, { query: "the", limit: 150 })),
    ).toBeLessThan(RESULT_CAP);
  });

  it("finds a phrase in a clip trimmed into its first word and in both halves of a split", () => {
    const p = newProject();
    // Word times run edge to edge, as whisper writes them, so "Thank" starts
    // in the pause after "coffee."
    const words = [
      { text: " coffee.", start: 0, end: 1 },
      { text: " Thank", start: 1, end: 2.4 },
      { text: " you", start: 2.4, end: 2.6 },
      { text: " so", start: 2.6, end: 2.8 },
      { text: " much.", start: 2.8, end: 3.2 },
      { text: " See", start: 3.2, end: 3.5 },
      { text: " you", start: 3.5, end: 3.7 },
      { text: " tomorrow.", start: 3.7, end: 4.3 },
    ];
    const asset = AssetSchema.parse({
      id: "talk",
      name: "Talk.mp4",
      kind: "video",
      path: "/Users/someone/Talk.mp4",
      duration: 5,
      words,
    });
    p.assets = [asset];
    p.clips = [
      // Trimmed to the speech: plays source 2.0 to 3.2 s.
      {
        ...makeClip(p, "video", "video", 0, asset),
        id: "trimmed",
        sourceIn: 2,
        duration: 36,
      },
      // "See you tomorrow" split at 3.6 s into two clips placed apart.
      {
        ...makeClip(p, "video", "video", 100, asset),
        id: "left",
        sourceIn: 3.2,
        duration: 12,
      },
      {
        ...makeClip(p, "video", "video", 200, asset),
        id: "right",
        sourceIn: 3.6,
        duration: 21,
      },
    ];
    const project = validateProject(p);
    expect(searchTranscript(project, { query: "thank you so much" })).toEqual([
      expect.objectContaining({
        clipId: "trimmed",
        startFrame: 0,
        endFrame: 36,
        partial: true,
      }),
    ]);
    const later = searchTranscript(project, {
      query: "see you tomorrow",
    }) as any[];
    expect(later.map((hit) => hit.clipId)).toEqual(["left", "right"]);
    expect(later[0]).toMatchObject({
      startFrame: 100,
      endFrame: 112,
      partial: true,
    });
    expect(later[1]).toMatchObject({
      startFrame: 200,
      endFrame: 221,
      partial: true,
    });
  });

  it("reads a clip's transcript as lines with frames, paged", () => {
    const p = interview();
    const first = readTranscript(p, {
      clipId: "interview-clip",
      limit: 20,
    }) as any;
    expect(first.lines).toHaveLength(20);
    expect(first.lines[0]).toMatchObject({ startFrame: 0, start: 0 });
    expect(first.nextOffset).toBe(20);
    const all = readTranscript(p, { assetId: "interview-asset", limit: 250 });
    expect(size(all)).toBeLessThan(RESULT_CAP);
    expect(() => readTranscript(p, { clipId: "title" })).toThrow(
      /no source media/,
    );
  });
});

describe("media import reports each failed file and keeps the rest", () => {
  it("imports good files, lists bad ones with the reason, as one undo step", async () => {
    const directory = temporary("cutline-import-");
    const store = new Store(path.join(directory, "recovery.cutline"));
    const jobs = new Jobs(() => {});
    const media = new Media(
      path.join(directory, "cache"),
      { ffmpeg: "", ffprobe: "", whisper: "", model: "" },
      jobs,
    );
    const good = path.join(directory, "good.mp4"),
      broken = path.join(directory, "broken.mp4");
    writeFileSync(good, "x");
    writeFileSync(broken, "x");
    vi.spyOn(media, "import").mockImplementation(async (file: string) => {
      if (file === broken)
        throw Error("This file has no supported video, image, or audio stream");
      return AssetSchema.parse({
        id: "imported",
        name: path.basename(file),
        kind: "video",
        path: file,
        duration: 3,
        words: [{ text: "hi", start: 0, end: 1 }],
      });
    });
    const call = createAgentIO({
      store,
      media,
      jobs,
      directory,
      preview: async () => ({}),
      status: () => ({}),
    });
    const missing = path.join(directory, "missing.mp4");
    const result = (await call("cutline_import_media", {
      projectId: store.project.id,
      revision: store.project.revision,
      paths: [good, missing, "relative.mp4", broken],
    })) as any;
    expect(result.importedAssetIds).toEqual(["imported"]);
    expect(result.revision).toBe(store.project.revision);
    expect(result.assets[0]).not.toHaveProperty("path");
    expect(result.failures).toEqual([
      { path: missing, error: "No file exists at this path." },
      { path: "relative.mp4", error: "Use an absolute path." },
      {
        path: broken,
        error: "This file has no supported video, image, or audio stream",
      },
    ]);
    expect(store.past).toHaveLength(1);
    expect(store.project.assets).toHaveLength(1);
    await expect(
      call("cutline_import_media", {
        projectId: store.project.id,
        revision: store.project.revision,
        paths: [missing],
      }),
    ).rejects.toThrow(
      `Nothing was imported. ${missing}: No file exists at this path.`,
    );
  });

  it("keeps every agent-io result small", async () => {
    const directory = temporary("cutline-io-results-");
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.commit(interview(), "Interview");
    const jobs = new Jobs(() => {});
    const media = new Media(
      path.join(directory, "cache"),
      { ffmpeg: "", ffprobe: "", whisper: "", model: "" },
      jobs,
    );
    const call = createAgentIO({
      store,
      media,
      jobs,
      directory,
      preview: async () => ({}),
      status: () => ({}),
    });
    const guard = () => ({
      projectId: store.project.id,
      revision: store.project.revision,
    });
    const srt = Array.from({ length: 1200 }, (_, index) => {
      const stamp = (seconds: number) =>
        `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")},000`;
      return `${index + 1}\n${stamp(index % 3000)} --> ${stamp((index % 3000) + 1)}\nCaption number ${index}\n`;
    }).join("\n");
    const captions = (await call("cutline_caption_srt", {
      ...guard(),
      srt,
    })) as any;
    expect(captions.captionCount).toBe(1200);
    expect(size(captions)).toBeLessThan(10_000);
    const first = (await call("cutline_get_srt", {})) as any;
    expect(size(first)).toBeLessThan(RESULT_CAP);
    expect(first.nextOffset).toBeGreaterThan(0);
    const second = (await call("cutline_get_srt", {
      offset: first.nextOffset,
    })) as any;
    expect(second.srt.startsWith(`${first.nextOffset + 1}\n`)).toBe(true);
    for (const name of ["cutline_redo"]) {
      const result = await call(name, guard());
      expect(size(result)).toBeLessThan(5_000);
    }
    const fresh = (await call("cutline_new_project", {
      ...guard(),
      name: "Fresh",
    })) as any;
    expect(fresh).toMatchObject({ name: "Fresh", detail: "summary" });
    expect(size(fresh)).toBeLessThan(5_000);
  });
});

describe("long work answers before client timeouts", () => {
  /** Jobs with an export of the person's already running. */
  const jobsWithExport = () => {
    const jobs = new Jobs(() => {});
    jobs.jobs.set("export-1", {
      id: "export-1",
      kind: "export",
      state: "running",
      progress: 0.5,
      message: "Exporting",
      output: "/Users/someone/out.mp4",
    });
    return jobs;
  };
  const states = (jobs: Jobs) =>
    Object.fromEntries([...jobs.jobs.values()].map((j) => [j.kind, j.state]));

  it("returns quick results directly and slow ones as a job to wait on", async () => {
    const tasks = new AgentTasks(jobsWithExport(), 40, 10);
    expect(
      await tasks.run("cutline_transcribe", async () => ({ captions: 3 })),
    ).toEqual({ captions: 3 });
    await expect(
      tasks.run("cutline_transcribe", async () => {
        throw Error("Select a media clip");
      }),
    ).rejects.toThrow("Select a media clip");
    let finish!: (value: unknown) => void;
    const slow = new Promise((resolve) => (finish = resolve));
    const pending = (await tasks.run("cutline_transcribe", () => slow)) as any;
    expect(pending).toMatchObject({ state: "running" });
    expect(pending.message).toContain(`"id": "${pending.jobId}"`);
    setTimeout(() => finish({ captions: 120, revision: 9 }), 60);
    const [done] = (await tasks.list({
      id: pending.jobId,
      waitSeconds: 2,
    })) as any[];
    expect(done).toMatchObject({
      id: pending.jobId,
      state: "done",
      result: { captions: 120, revision: 9 },
    });
    let fail!: (error: Error) => void;
    const failing = new Promise((_, reject) => (fail = reject));
    const failed = (await tasks.run(
      "cutline_remove_pauses",
      () => failing,
    )) as any;
    fail(Error("Project changed. Inspect the project and retry."));
    const [error] = (await tasks.list({
      id: failed.jobId,
      waitSeconds: 1,
    })) as any[];
    expect(error).toMatchObject({
      state: "error",
      message: "Project changed. Inspect the project and retry.",
    });
  });

  it("waits as long as the caller allows before answering with a job", async () => {
    const tasks = new AgentTasks(jobsWithExport(), 20, 5);
    const slow = () =>
      new Promise((resolve) => setTimeout(() => resolve("transcribed"), 80));
    expect(await tasks.run("cutline_transcribe", slow)).toMatchObject({
      state: "running",
    });
    // The built-in assistants allow minutes instead of polling.
    expect(
      await tasks.run("cutline_transcribe", slow, undefined, {
        deadlineMs: 1000,
      }),
    ).toBe("transcribed");
  });

  it("lists recent jobs without output paths and rejects unknown IDs", async () => {
    const tasks = new AgentTasks(jobsWithExport(), 40, 10);
    const list = (await tasks.list({})) as any[];
    expect(list[0]).toMatchObject({ id: "export-1", state: "running" });
    expect(list[0]).not.toHaveProperty("output");
    const started = Date.now();
    await tasks.list({ id: "export-1", waitSeconds: 0.2 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await expect(tasks.list({ id: "missing" })).rejects.toThrow(/missing/);
  });

  it("cancelling a task stops only the work its own tool started", async () => {
    const jobs = jobsWithExport();
    const tasks = new AgentTasks(jobs, 40, 10);
    // The person imports footage meanwhile; it belongs to no agent call.
    let imported!: () => void;
    const importing = jobs.run(
      "import",
      "Importing interview.mp4",
      () => new Promise<void>((resolve) => (imported = resolve)),
    );
    let transcribed!: () => void;
    const pending = (await tasks.run("cutline_transcribe", async () => {
      await jobs.run(
        "transcribe",
        "Transcribing",
        () => new Promise<void>((resolve) => (transcribed = resolve)),
      );
      // Work the tool would start after the cancel never starts.
      await jobs.run("analyze", "Finding pauses", async () => {});
      return { captions: 1 };
    })) as { id: string };
    expect(tasks.cancel(pending.id)).toMatchObject({ state: "cancelled" });
    expect(states(jobs)).toMatchObject({
      export: "running",
      import: "running",
      transcribe: "cancelled",
    });
    transcribed();
    imported();
    await importing;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states(jobs)).toMatchObject({ export: "running", import: "done" });
    expect(states(jobs)).not.toHaveProperty("analyze");
    expect(await tasks.list({ id: pending.id })).toMatchObject([
      { state: "cancelled" },
    ]);
    // cutline_jobs reports the task, not the call's own job.
    expect(
      ((await tasks.list({})) as any[]).some((job) => job.kind === "agent"),
    ).toBe(false);
    expect(tasks.cancel("export-1")).toBeNull();
  });

  it("Stop before the answer cancels the tool's work, never an export", async () => {
    const jobs = jobsWithExport();
    const tasks = new AgentTasks(jobs, 1000, 10);
    const caller = new AbortController();
    let signal: AbortSignal | undefined;
    const call = tasks.run(
      "cutline_graphic",
      async (stop) => {
        signal = stop;
        await jobs.run(
          "drawing",
          "Drawing",
          () =>
            new Promise((_, reject) =>
              stop.addEventListener("abort", () => reject(Error("Cancelled"))),
            ),
        );
      },
      undefined,
      { signal: caller.signal },
    );
    caller.abort();
    await expect(call).rejects.toThrow("Cancelled");
    expect(signal?.aborted).toBe(true);
    expect(states(jobs)).toMatchObject({
      drawing: "cancelled",
      export: "running",
    });
  });

  it("keeps a task going once its call has answered, even when that request then closes", async () => {
    const tasks = new AgentTasks(jobsWithExport(), 20, 5);
    const caller = new AbortController();
    let finish!: (value: unknown) => void;
    const pending = (await tasks.run(
      "cutline_transcribe",
      () => new Promise((resolve) => (finish = resolve)),
      undefined,
      { signal: caller.signal },
    )) as any;
    caller.abort();
    finish({ captions: 2 });
    const [done] = (await tasks.list({
      id: pending.id,
      waitSeconds: 1,
    })) as any[];
    expect(done).toMatchObject({ state: "done", result: { captions: 2 } });
  });

  it("never lands an edit from a cancelled call, and never marks it done", async () => {
    const directory = temporary("cutline-cancelled-edit-");
    const store = new Store(path.join(directory, "recovery.cutline"));
    const jobs = new Jobs(() => {});
    store.beforeCommit = () => jobs.assertActive();
    const tasks = new AgentTasks(jobs, 20, 5);
    let finish!: () => void;
    const pending = (await tasks.run("cutline_remove_pauses", async () => {
      // A slow step that is not a job of its own, such as a download.
      await new Promise<void>((resolve) => (finish = resolve));
      store.commit({ ...store.project, name: "Pauses removed" }, "Cut");
      return { removed: true };
    })) as any;
    tasks.cancel(pending.id);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.project.name).not.toBe("Pauses removed");
    expect(store.past).toHaveLength(0);
    expect(await tasks.list({ id: pending.id })).toMatchObject([
      { state: "cancelled" },
    ]);
    // Edits outside any agent call are never refused.
    store.commit({ ...store.project, name: "Edited by hand" }, "Rename");
    expect(store.project.name).toBe("Edited by hand");
  });

  it("passes a client's cancel through MCP to the tool call", async () => {
    let seen: AbortSignal | undefined;
    const server = createMcpServer(
      async () => cutlineTools,
      async (_name, _args, signal) => {
        seen = signal;
        await new Promise((resolve) =>
          signal?.addEventListener("abort", resolve),
        );
        return {};
      },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0" });
    await client.connect(clientSide);
    try {
      const stop = new AbortController();
      const call = client.callTool(
        { name: "cutline_transcribe", arguments: {} },
        undefined,
        { signal: stop.signal },
      );
      await vi.waitFor(() => expect(seen).toBeDefined());
      expect(seen!.aborted).toBe(false);
      stop.abort();
      await expect(call).rejects.toThrow();
      await vi.waitFor(() => expect(seen!.aborted).toBe(true));
    } finally {
      await client.close();
    }
  });
});

describe("previews render frames like the export and can come as a contact sheet", () => {
  const project = () => {
    const p = newProject();
    p.clips = [
      { ...makeClip(p, "text", "titles", 30), id: "title", duration: 60 },
      { ...makeClip(p, "text", "titles", 120), id: "outro", duration: 90 },
    ];
    return p;
  };

  it("chooses frames: listed, sampled across a clip or range, or one", () => {
    const p = project();
    expect(previewFrames(p, { frames: [0, 15, 15, 9999] })).toEqual([
      0, 15, 209,
    ]);
    expect(previewFrames(p, { clipId: "title", count: 3 })).toEqual([
      30, 60, 89,
    ]);
    expect(previewFrames(p, { fromFrame: 0, toFrame: 10, count: 2 })).toEqual([
      0, 9,
    ]);
    expect(previewFrames(p, { count: 1 })).toEqual([105]);
    expect(previewFrames(p, { frame: 40 })).toEqual([40]);
    expect(previewFrames(p, { seconds: 2 })).toEqual([60]);
    expect(previewFrames(p, {}, 77)).toEqual([77]);
    // A clip outside the playhead previews its middle.
    expect(previewFrames(p, { clipId: "outro" }, 10)).toEqual([165]);
    expect(previewFrames(p, { clipId: "outro" }, 130)).toEqual([130]);
    expect(() => previewFrames(p, { clipId: "missing" })).toThrow(/missing/);
  });

  it("sizes one frame at 1280 on the long edge and shares a sheet's pixels between tiles", () => {
    const p = project();
    expect(previewSize(p, 1)).toMatchObject({ width: 720, height: 1280 });
    const tile = previewSize(p, 6);
    expect(tile.width).toBeGreaterThan(280);
    expect(tile.width * tile.height * 6).toBeLessThan(1_200_000);
    expect(previewSize(p, 1, 400)).toMatchObject({ width: 400 });
    expect(previewSize({ ...p, width: 1920, height: 1080 }, 1)).toMatchObject({
      width: 1280,
      height: 720,
    });
  });

  it("keeps every contact sheet near square and within 2,000 pixels a side", () => {
    for (const [width, height] of [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
      [1080, 1350],
      [3840, 2160],
    ])
      for (const requested of [undefined, 1280, 1920])
        for (let count = 2; count <= 12; count++) {
          const sheet = sheetLayout(
            { ...project(), width, height },
            count,
            requested,
          );
          const label = `${width}x${height}, ${count} frames, width ${requested}`;
          expect(sheet.columns * sheet.rows, label).toBeGreaterThanOrEqual(
            count,
          );
          expect(
            Math.max(sheet.sheetWidth, sheet.sheetHeight),
            label,
          ).toBeLessThanOrEqual(SHEET_MAX_SIDE);
        }
    // Seven wide frames were one 537 x 2142 column.
    const seven = sheetLayout({ ...project(), width: 1920, height: 1080 }, 7);
    expect(seven).toMatchObject({ columns: 2, rows: 4 });
    // Three 4:5 frames were one 550 x 2058 column.
    expect(
      sheetLayout({ ...project(), width: 1080, height: 1350 }, 3),
    ).toMatchObject({ columns: 2, rows: 2 });
  });

  const tiles = (directory: string, count: number) =>
    Array.from({ length: count }, (_, index) => {
      const file = path.join(directory, `frame-${index}.jpg`);
      const result = spawnSync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x${(index * 40 + 30).toString(16).padStart(2, "0")}3366:s=90x160:d=1`,
        "-frames:v",
        "1",
        file,
      ]);
      expect(result.status, String(result.stderr)).toBe(0);
      return file;
    });
  const dimensions = (file: string) => {
    const result = spawnSync(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ]);
    return String(result.stdout).trim();
  };

  it("tiles frames into one labeled contact sheet with ffmpeg", async () => {
    const directory = temporary("cutline-sheet-");
    const files = tiles(directory, 5);
    const output = path.join(directory, "sheet.jpg");
    const sheet = await contactSheet({
      ffmpeg,
      files,
      labels: files.map(
        (_, index) => `${index + 1}  0:0${index}.00  frame ${index * 30}`,
      ),
      width: 90,
      height: 160,
      output,
    });
    expect(sheet).toMatchObject({ columns: 3, rows: 2 });
    expect(dimensions(output)).toBe(`${sheet.width},${sheet.height}`);
    const plain = await contactSheet({
      ffmpeg,
      files: files.slice(0, 1),
      labels: [],
      width: 90,
      height: 160,
      output: path.join(directory, "one.jpg"),
      font: null,
    });
    expect(plain).toMatchObject({ columns: 1, rows: 1, labelled: false });
  });

  it("returns one sheet, separate images or one frame, as MCP image content", async () => {
    const p = project();
    const render = async (
      frames: number[],
      _scale: number,
      directory: string,
    ) => tiles(directory, frames.length);
    const sheet = await renderPreview({
      project: p,
      frames: [30, 60, 89],
      ffmpeg,
      render,
    });
    expect(sheet.info).toMatchObject({
      layout: "sheet",
      renderer: "export",
      revision: p.revision,
    });
    expect(sheet.info.frames).toEqual([
      { index: 1, frame: 30, time: "0:01.00" },
      { index: 2, frame: 60, time: "0:02.00" },
      { index: 3, frame: 89, time: "0:02.97" },
    ]);
    expect(sheet.images).toHaveLength(1);
    const content = previewContent(sheet.info, sheet.images);
    expect(content.content.map((item) => item.type)).toEqual(["text", "image"]);
    expect(content.structuredContent).toBe(sheet.info);
    expect(size(content.content[0])).toBeLessThan(2_000);
    const separate = await renderPreview({
      project: p,
      frames: [30, 60],
      layout: "separate",
      ffmpeg,
      render,
    });
    expect(
      previewContent(separate.info, separate.images).content.map(
        (item) => item.type,
      ),
    ).toEqual(["text", "text", "image", "text", "image"]);
    const one = await renderPreview({
      project: p,
      frames: [45],
      ffmpeg,
      render,
    });
    expect(one.info.layout).toBe("single");
  });

  it("keeps one preview worker between previews, replaces a stuck one and closes it when idle", async () => {
    const directory = temporary("cutline-still-worker-");
    const worker = path.join(directory, "worker.cjs");
    writeFileSync(
      worker,
      `const fs = require("node:fs"), path = require("node:path");
      process.on("disconnect", () => process.exit(0));
      process.on("message", (m) => {
        if (m.frames[0] === 13) return process.send({ type: "error", id: m.id, message: "Composition failed" });
        if (m.frames[0] === 14) return;
        const files = m.frames.map((frame, index) => { const file = path.join(m.outputDirectory, "frame-" + index + ".jpg"); fs.writeFileSync(file, frame * m.scale + " " + process.pid); return file; });
        process.send({ type: "done", id: m.id, files });
      });`,
    );
    let exited = 0;
    const stills = new StillWorker({
      workerPath: worker,
      timeoutMs: 1500,
      idleMs: 300,
      exited: () => exited++,
    });
    const options = {
      serveUrl: "unused",
      browserExecutable: "unused",
      inputProps: {},
      scale: 0.5,
      directory,
    };
    // Each frame file names the worker that rendered it.
    const preview = async (frames: number[]) => {
      const files = await stills.render({ ...options, frames });
      return { files, pid: readFileSync(files[0], "utf8").split(" ")[1] };
    };
    const first = await preview([10, 20]);
    expect(first.files).toEqual([
      path.join(directory, "frame-0.jpg"),
      path.join(directory, "frame-1.jpg"),
    ]);
    // The next preview reuses the same worker instead of starting one.
    const second = await preview([30]);
    expect(second.pid).toBe(first.pid);
    expect(readFileSync(second.files[0], "utf8")).toBe(`15 ${first.pid}`);
    await expect(stills.render({ ...options, frames: [13] })).rejects.toThrow(
      "Composition failed",
    );
    await expect(stills.render({ ...options, frames: [14] })).rejects.toThrow(
      /took too long/,
    );
    await vi.waitFor(() => expect(exited).toBe(1));
    // A stuck worker is replaced by a new one.
    const third = await preview([40]);
    expect(third.pid).not.toBe(first.pid);
    // A quiet worker closes, and the next preview starts a new one.
    await vi.waitFor(() => expect(exited).toBe(2), { timeout: 3000 });
    const fourth = await preview([50]);
    expect(fourth.pid).not.toBe(third.pid);
    stills.close();
    await vi.waitFor(() => expect(exited).toBe(3), { timeout: 3000 });
  });
});

describe("the launcher works and explains itself when Cutline is closed", () => {
  const closedLauncher = (connection: string, open?: () => Promise<boolean>) =>
    createLauncher({
      connection,
      tools: () => cutlineTools,
      open,
      openWaitMs: 3000,
      pollMs: 50,
    });

  it("lists the bundled tools and answers calls with Open Cutline when no app runs", async () => {
    const directory = temporary("cutline-launcher-");
    const connection = path.join(directory, "connection.json");
    const launcher = closedLauncher(connection);
    expect(await launcher.listTools()).toBe(cutlineTools);
    await expect(launcher.rpc("cutline_inspect", {})).rejects.toThrow(
      CUTLINE_CLOSED,
    );
    // A file left by a Cutline that quit: its process and port are gone.
    const gone = spawnSync(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);
    const deadPid = Number(String(gone.stdout));
    const server = http.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as any).port;
    await new Promise((resolve) => server.close(resolve));
    writeFileSync(
      connection,
      JSON.stringify({ base: `http://127.0.0.1:${port}/token`, pid: deadPid }),
    );
    await expect(launcher.rpc("cutline_inspect", {})).rejects.toThrow(
      CUTLINE_CLOSED,
    );
    writeFileSync(
      connection,
      JSON.stringify({
        base: `http://127.0.0.1:${port}/token`,
        pid: process.pid,
      }),
    );
    await expect(launcher.rpc("cutline_inspect", {})).rejects.toThrow(
      CUTLINE_CLOSED,
    );
    expect(await launcher.listTools()).toBe(cutlineTools);
    writeFileSync(
      connection,
      JSON.stringify({ base: "http://example.com:80/token" }),
    );
    await expect(launcher.rpc("cutline_inspect", {})).rejects.toThrow(
      /this Mac/,
    );
  });

  it("reaches the running app through the bridge and opens Cutline when asked to", async () => {
    const directory = temporary("cutline-launcher-live-");
    const connection = path.join(directory, "connection.json");
    const store = new Store(path.join(directory, "recovery.cutline"));
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    const open = vi.fn(async () => {
      // Cutline starting: its bridge writes a fresh connection file.
      setTimeout(async () => {
        bridge = await startBridge(
          store,
          connection,
          async (name, args) => ({
            name,
            args,
            revision: store.project.revision,
          }),
          cutlineTools,
        );
      }, 100);
      return true;
    });
    const launcher = closedLauncher(connection, open);
    // Status checks report a closed Cutline instead of opening it.
    expect(await launcher.rpc("cutline_connection_status")).toMatchObject({
      ready: false,
    });
    await expect(launcher.rpc("cutline_jobs", {})).rejects.toThrow(
      CUTLINE_CLOSED,
    );
    expect(open).not.toHaveBeenCalled();
    expect(await launcher.rpc("cutline_inspect", { detail: "full" })).toEqual({
      name: "cutline_inspect",
      args: { detail: "full" },
      revision: store.project.revision,
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(await launcher.listTools()).toEqual(
      JSON.parse(JSON.stringify(cutlineTools)),
    );
    bridge!.close();
    // Quitting removes the connection file, so the next call explains itself.
    expect(existsSync(connection)).toBe(false);
    const closed = closedLauncher(connection);
    await expect(closed.rpc("cutline_inspect", {})).rejects.toThrow(
      CUTLINE_CLOSED,
    );
  });

  it("waits as long as a long tool needs and stops after the configured silence", async () => {
    const server = http.createServer((request, response) => {
      const delay = Number(
        new URL(request.url!, "http://x").searchParams.get("delay"),
      );
      setTimeout(
        () => response.end(JSON.stringify({ result: { ok: true } })),
        delay,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as any).port}/rpc`;
    try {
      expect(await postJson(`${base}?delay=1200`, {}, 5000)).toEqual({
        result: { ok: true },
      });
      await expect(postJson(`${base}?delay=1000`, {}, 200)).rejects.toThrow(
        /did not answer in time/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("leaves a newer Cutline's connection file in place", async () => {
    const directory = temporary("cutline-bridge-");
    const connection = path.join(directory, "connection.json");
    const store = new Store(path.join(directory, "recovery.cutline"));
    const older = await startBridge(store, connection, async () => null, []);
    const newer = await startBridge(store, connection, async () => null, []);
    older.close();
    expect(existsSync(connection)).toBe(true);
    newer.close();
    expect(existsSync(connection)).toBe(false);
  });

  it("only opens a packaged Cutline.app", async () => {
    expect(await openCutlineApp("/usr/local/bin/node")).toBe(false);
    expect(
      await openCutlineApp(
        "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    ).toBe(false);
    expect(
      await openCutlineApp("/nowhere/Cutline.app/Contents/MacOS/Cutline"),
    ).toBe(false);
  });

  it("serves workflow instructions and tools over MCP while Cutline is closed", async () => {
    const directory = temporary("cutline-mcp-");
    const launcher = closedLauncher(path.join(directory, "connection.json"));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(launcher.listTools, launcher.rpc);
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0" });
    await client.connect(clientSide);
    try {
      // Claude Code keeps 2,048 characters of server instructions: the core
      // fits and points at the full workflow, which one call returns.
      const instructions = client.getInstructions()!;
      expect(instructions).toBe(cutlineCore);
      expect(instructions.length).toBeLessThan(2_000);
      for (const phrase of [
        "cutline_inspect",
        "revision",
        "image true",
        "cutline_jobs",
        'cutline_editing_schema {section: "workflow"}',
      ])
        expect(instructions).toContain(phrase);
      expect(instructions).not.toContain("Never use a shell");
      expect(editingSchemaSection("workflow")).toEqual({
        workflow: cutlineWorkflow,
      });
      expect(cutlineWorkflow).toContain("cutline_search_transcript");
      const listed = await client.listTools();
      expect(size(listed)).toBeLessThan(50_000);
      expect(
        listed.tools.find((tool) => tool.name === "cutline_inspect")
          ?.annotations?.readOnlyHint,
      ).toBe(true);
      const result = await client.callTool({
        name: "cutline_inspect",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toBe(
        `Cutline: ${CUTLINE_CLOSED}`,
      );
    } finally {
      await client.close();
    }
  });

  it("builds the stdio launcher and lists tools from it with no app running", async () => {
    const directory = temporary("cutline-launcher-build-");
    const outfile = path.join(directory, "mcp.cjs");
    await build({
      entryPoints: [path.join(root, "src/main/mcp.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      packages: "external",
      logLevel: "error",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [outfile],
      env: {
        PATH: process.env.PATH ?? "",
        NODE_PATH: path.join(root, "node_modules"),
        CUTLINE_CONNECTION: path.join(directory, "connection.json"),
        CUTLINE_NO_AUTOSTART: "1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "launcher-test", version: "1.0" });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        sessionTools(cutlineTools).map((tool) => tool.name),
      );
      const result = await client.callTool({
        name: "cutline_jobs",
        arguments: {},
      });
      expect((result.content as any)[0].text).toBe(
        `Cutline: ${CUTLINE_CLOSED}`,
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  it("refuses text results too large for an assistant", () => {
    const huge = mcpResult({ items: "x".repeat(150_000) });
    expect(huge.content[0].text).toMatch(/too large to return/);
    expect(mcpResult({ ok: true }).content[0].text).toBe('{"ok":true}');
  });
});

describe("guides match the tools", () => {
  it("documents cutline_edit action forms and that previews return images", () => {
    const guide = effectsGuideResult();
    const text = JSON.stringify(guide);
    expect(size(guide)).toBeLessThan(10_000);
    expect(guide.keyframes).toContain("clip.keyframe {clipId,");
    expect(text).not.toMatch(/clip\.keyframe: id,/);
    expect(text).not.toMatch(/access to footage\/frames/);
    expect(text).toContain("cutline_preview");
    expect(guide.values.layerTypes).toContain("path");
    expect(guide.values.textAnimations).toContain("line-reveal");
    expect(guide.values.motionEasings).toContain("cubic-bezier");
    expect(guide.values.transitions).toEqual(
      expect.arrayContaining(["none", "crossfade", "wipe"]),
    );
  });

  it("gives the built-in assistant the same workflow plus its limits", () => {
    // Everything but the sessions guide: the built-in is bound to its window.
    expect(assistantInstructions).toContain(
      cutlineWorkflow.slice(cutlineWorkflow.indexOf("How to work")),
    );
    expect(assistantInstructions).not.toContain("cutline_sessions action list");
    expect(cutlineWorkflow).toContain("cutline_sessions action list");
    expect(assistantInstructions).toContain("Never use a shell");
    expect(assistantInstructions).not.toMatch(/\u2014/);
    expect(cutlineWorkflow).not.toMatch(/\u2014/);
  });
});

describe("assistant replies render simple markdown safely", () => {
  it("parses paragraphs, lists, bold and code", () => {
    expect(
      parseMarkdown(
        "Done. I changed **two** things:\n\n- Title at `0:02`\n- Captions now *karaoke*\n\n1. Check it\n2. Export",
      ),
    ).toEqual([
      {
        type: "paragraph",
        lines: [
          [
            { type: "text", text: "Done. I changed " },
            { type: "strong", children: [{ type: "text", text: "two" }] },
            { type: "text", text: " things:" },
          ],
        ],
      },
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          [
            [
              { type: "text", text: "Title at " },
              { type: "code", text: "0:02" },
            ],
          ],
          [
            [
              { type: "text", text: "Captions now " },
              { type: "em", children: [{ type: "text", text: "karaoke" }] },
            ],
          ],
        ],
      },
      {
        type: "list",
        ordered: true,
        start: 1,
        items: [
          [[{ type: "text", text: "Check it" }]],
          [[{ type: "text", text: "Export" }]],
        ],
      },
    ]);
    expect(parseMarkdown("snake_case_name stays 2 * 3 * 4")[0]).toEqual({
      type: "paragraph",
      lines: [[{ type: "text", text: "snake_case_name stays 2 * 3 * 4" }]],
    });
  });

  it("renders elements, never raw HTML", () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageText, {
        text: "## Done\nMoved the **title** to `0:02`.\n\n- one\n- two <img src=x onerror=alert(1)>\n\n```\n<b>code</b>\n```",
      }),
    );
    expect(html).toContain('<p class="message-heading">Done</p>');
    expect(html).toContain("<strong>title</strong>");
    expect(html).toContain("<code>0:02</code>");
    expect(html).toContain(
      "<ul><li>one</li><li>two &lt;img src=x onerror=alert(1)&gt;</li></ul>",
    );
    expect(html).toContain("<pre><code>&lt;b&gt;code&lt;/b&gt;</code></pre>");
    expect(html).not.toContain("<img");
  });

  it("names what the assistant is doing for every tool it calls", () => {
    expect(toolActivity("cutline_preview")).toBe("Reviewing the preview…");
    expect(toolActivity("cutline_transcript")).toBe("Reading the transcript…");
    expect(toolActivity("cutline_jobs")).toBe("Waiting for the job to finish…");
  });
});
