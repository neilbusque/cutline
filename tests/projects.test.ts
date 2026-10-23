import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeClip, type Project } from "../src/shared/model";
import { Store } from "../src/main/store";
import { Jobs, Media } from "../src/main/media";
import { ProjectLibrary } from "../src/main/projects";
import { createAgentIO, agentIoTools } from "../src/main/agent-io";

const directories: string[] = [];
const folder = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cutline-projects-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = folder();
  const store = new Store(path.join(directory, "data", "recovery.cutline"));
  const projects = path.join(directory, "Projects");
  const library = new ProjectLibrary(
    projects,
    path.join(directory, "data", "recent-projects.json"),
  );
  return { directory, store, library, projects };
}
function addTitle(store: Store, text: string, seconds = 4) {
  const p: Project = structuredClone(store.project);
  p.clips.push({
    ...makeClip(p, "text", "titles", 0),
    text,
    duration: Math.round(seconds * p.fps),
  });
  store.commit(p, "Add title");
}
function rename(store: Store, name: string) {
  store.transact({
    projectId: store.project.id,
    revision: store.project.revision,
    label: "Rename",
    commands: [{ type: "project.update", patch: { name } }],
  });
}
const cutlineFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".cutline")) : [];

describe("every project with content is a file", () => {
  it("keeps a blank project out of the folder and files it, by name, on its first content", () => {
    const { store, library, projects } = setup();
    expect(library.fileIfNeeded(store)).toBe(false);
    rename(store, "Spring launch");
    expect(library.fileIfNeeded(store)).toBe(false);
    expect(cutlineFiles(projects)).toEqual([]);
    addTitle(store, "Hello");
    expect(library.fileIfNeeded(store)).toBe(true);
    expect(store.filePath).toBe(path.join(projects, "Spring launch.cutline"));
    // Later edits keep saving into that file.
    addTitle(store, "Second title");
    expect(readFileSync(store.filePath!, "utf8")).toMatch(/Second title/);
    expect(library.fileIfNeeded(store)).toBe(false);
  });
  it("never reuses a name and makes names safe for a file", () => {
    const { library, projects } = setup();
    mkdirSync(projects, { recursive: true });
    writeFileSync(path.join(projects, "Untitled project.cutline"), "{}");
    expect(library.newPath("Untitled project")).toBe(
      path.join(projects, "Untitled project 2.cutline"),
    );
    expect(path.basename(library.newPath('Launch: v2/final "cut"'))).toBe(
      "Launch- v2-final -cut-.cutline",
    );
  });
});

describe("the projects list", () => {
  it("shows folder projects and recent files elsewhere, newest first, with name, length and clips", () => {
    const { directory, store, library, projects } = setup();
    rename(store, "Brand film");
    addTitle(store, "One", 12);
    library.fileIfNeeded(store);
    const first = store.filePath!;
    store.fresh();
    rename(store, "Elsewhere");
    addTitle(store, "Two", 3);
    const other = path.join(directory, "client", "Elsewhere.cutline");
    store.save(other);
    library.remember(other);
    utimesSync(first, new Date(2026, 0, 1), new Date(2026, 0, 1));
    const list = library.list(store.filePath);
    expect(list.map((p) => p.name)).toEqual(["Elsewhere", "Brand film"]);
    expect(list[0]).toMatchObject({
      path: other,
      open: true,
      inFolder: false,
      clips: 1,
    });
    expect(list[0].durationSeconds).toBeCloseTo(3, 1);
    expect(list[1]).toMatchObject({ path: first, open: false, inFolder: true });
    expect(list[1].durationSeconds).toBeCloseTo(12, 1);
    expect(path.dirname(first)).toBe(projects);
  });
  it("drops recent files that are gone, and forgetting leaves the file alone", () => {
    const { directory, store, library } = setup();
    addTitle(store, "Kept");
    const file = path.join(directory, "elsewhere", "Kept.cutline");
    store.save(file);
    library.remember(file);
    library.remember(path.join(directory, "gone", "Missing.cutline"));
    expect(library.list().map((p) => p.path)).toEqual([file]);
    library.forget(file);
    expect(library.list()).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
  it("switches between projects without losing either", () => {
    const { store, library } = setup();
    addTitle(store, "First project title");
    library.fileIfNeeded(store);
    const first = store.filePath!;
    store.fresh();
    addTitle(store, "Second project title");
    library.fileIfNeeded(store);
    const second = store.filePath!;
    expect(second).not.toBe(first);
    store.load(first);
    expect(store.project.clips[0].text).toBe("First project title");
    store.load(second);
    expect(store.project.clips[0].text).toBe("Second project title");
    expect(
      library
        .list(store.filePath)
        .map((p) => p.path)
        .sort(),
    ).toEqual([first, second].sort());
  });
  it("finds a project by name or path, and says when a name is ambiguous", () => {
    const { store, library } = setup();
    rename(store, "Teaser");
    addTitle(store, "A");
    library.fileIfNeeded(store);
    const teaser = store.filePath!;
    expect(library.find("teaser").path).toBe(teaser);
    expect(library.find(teaser).path).toBe(teaser);
    store.fresh();
    rename(store, "Teaser");
    addTitle(store, "B");
    library.fileIfNeeded(store);
    expect(() => library.find("Teaser")).toThrow(/more than one/i);
    expect(() => library.find("Nothing like it")).toThrow(/no project/i);
  });
});

describe("assistant project tools", () => {
  function agent() {
    const s = setup();
    const jobs = new Jobs(() => {});
    const media = new Media(
      path.join(s.directory, "media"),
      { ffmpeg: "unused", ffprobe: "unused", whisper: "", model: "" },
      jobs,
    );
    const call = createAgentIO({
      store: s.store,
      media,
      jobs,
      directory: path.join(s.directory, "data"),
      library: s.library,
      preview: async () => ({}),
      status: () => ({}),
    });
    const rev = () => ({
      projectId: s.store.project.id,
      revision: s.store.project.revision,
    });
    return { ...s, call, rev };
  }
  it("lists projects", async () => {
    const { store, library, call } = agent();
    rename(store, "Listed");
    addTitle(store, "x");
    library.fileIfNeeded(store);
    const result: any = await call("cutline_list_projects", {});
    expect(result.projects[0]).toMatchObject({ name: "Listed", open: true });
    expect(agentIoTools.some((t) => t.name === "cutline_list_projects")).toBe(
      true,
    );
  });
  it("names a new project and files it right away", async () => {
    const { store, call, rev, projects } = agent();
    const result: any = await call("cutline_new_project", {
      ...rev(),
      name: "Holiday ad",
    });
    expect(result.path).toBe(path.join(projects, "Holiday ad.cutline"));
    expect(store.filePath).toBe(result.path);
    expect(existsSync(result.path)).toBe(true);
  });
  it("opens a project by name", async () => {
    const { store, library, call, rev } = agent();
    rename(store, "Old cut");
    addTitle(store, "Old title");
    library.fileIfNeeded(store);
    const old = store.filePath!;
    await call("cutline_new_project", { ...rev(), name: "New cut" });
    const opened: any = await call("cutline_open_project", {
      ...rev(),
      name: "old cut",
    });
    expect(store.filePath).toBe(old);
    expect(opened.name).toBe("Old cut");
  });
  it("saves an unfiled project into the projects folder", async () => {
    const { store, call, rev, projects } = agent();
    rename(store, "Saved here");
    const result: any = await call("cutline_save_project", rev());
    expect(result.path).toBe(path.join(projects, "Saved here.cutline"));
  });
});

describe("projects sheet labels", () => {
  it("shows length as minutes and seconds and edits as today, yesterday or a date", async () => {
    const { projectLength, projectEdited } =
      await import("../src/renderer/Projects");
    expect(projectLength(116.6)).toBe("1:57");
    expect(projectLength(7)).toBe("0:07");
    const now = new Date(2026, 9, 12, 15, 0);
    expect(
      projectEdited(new Date(2026, 9, 12, 4, 3).toISOString(), now),
    ).toMatch(/^Today /);
    expect(
      projectEdited(new Date(2026, 9, 11, 21, 10).toISOString(), now),
    ).toMatch(/^Yesterday /);
    expect(projectEdited(new Date(2026, 9, 2, 9).toISOString(), now)).toMatch(
      /Oct 2/,
    );
    expect(projectEdited(new Date(2025, 9, 2, 9).toISOString(), now)).toMatch(
      /2025/,
    );
  });
});
