import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { Jobs, Media } from "../src/main/media";
import {
  buildReel,
  generateCaptions,
  removeLongPauses,
  type EditJobDeps,
} from "../src/main/edit-jobs";
import { relinkMedia } from "../src/main/relink";
import { createAgentIO } from "../src/main/agent-io";
import { contentSecurityPolicy } from "../src/main/csp";
import { confirmReplace } from "../src/main/project-guard";
import { manualBeatGrid } from "../src/shared/music-sync";
import {
  makeClip,
  newProject,
  type Asset,
  type Project,
  type Word,
} from "../src/shared/model";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      chmodSync(directory, 0o700);
      for (const entry of readdirSync(directory))
        chmodSync(path.join(directory, entry), 0o700);
    } catch {
      /* Already writable or gone. */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
function folder() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cutline-mainproc-"));
  directories.push(directory);
  return directory;
}
/** A project with a real edit in it, the kind of work that must never be lost. */
function work(store: Store, name: string, captions = 1): Project {
  const p = structuredClone(store.project);
  p.name = name;
  for (let i = 0; i < captions; i++) {
    const clip = makeClip(p, "caption", "captions", i * 30);
    clip.text = `${name} line ${i} with enough words to look like a real caption`;
    p.clips.push(clip);
  }
  store.commit(p, "Edit");
  return store.project;
}
function backups(directory: string) {
  const backupFolder = path.join(directory, "backups");
  if (!existsSync(backupFolder)) return [];
  return readdirSync(backupFolder)
    .filter((file) => file.endsWith(".cutline"))
    .map((file) => path.join(backupFolder, file));
}
function backupNames(directory: string) {
  return backups(directory).map((file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8")).project.name as string;
    } catch {
      return "(unreadable)";
    }
  });
}

describe("unsaved work survives New and Open", () => {
  it("keeps an unsaved project as a backup when another project is opened", () => {
    const directory = folder();
    const other = new Store(path.join(directory, "other-recovery.cutline"));
    work(other, "Other");
    const otherFile = path.join(directory, "other.cutline");
    other.save(otherFile);

    const first = new Store(path.join(directory, "recovery.cutline"));
    work(first, "Unsaved client cut");
    // The next launch opens a project from Finder.
    const second = new Store(path.join(directory, "recovery.cutline"));
    second.load(otherFile);
    expect(second.project.name).toBe("Other");
    expect(backupNames(directory)).toContain("Unsaved client cut");
  });

  it("never overwrites an earlier unsaved project when New is used again", () => {
    const directory = folder();
    const store = new Store(path.join(directory, "recovery.cutline"));
    work(store, "First draft");
    store.fresh();
    store.fresh();
    work(store, "Second draft");
    // An agent saves a variation, then starts another one.
    store.save(path.join(directory, "Variation.cutline"));
    store.fresh();
    work(store, "Third draft");
    store.fresh();
    const names = backupNames(directory);
    expect(names).toEqual(
      expect.arrayContaining(["First draft", "Third draft"]),
    );
    // Blank and already saved projects need no backup.
    expect(names).toHaveLength(2);
  });

  it("keeps undo history in the backup so a restored project can still undo", () => {
    const directory = folder();
    const store = new Store(path.join(directory, "recovery.cutline"));
    work(store, "Draft one");
    work(store, "Draft two");
    store.fresh();
    const [backup] = backups(directory);
    const restored = new Store(path.join(directory, "other-recovery.cutline"));
    restored.restore(backup);
    expect(restored.project.name).toBe("Draft two");
    expect(restored.filePath).toBeNull();
    restored.undo();
    expect(restored.project.name).toBe("Draft one");
  });

  it("sets a damaged autosave aside instead of overwriting it", () => {
    const directory = folder();
    const recovery = path.join(directory, "recovery.cutline");
    const damaged = '{"project": {"name": "Two hours of work", "clips": [';
    writeFileSync(recovery, damaged);
    const store = new Store(recovery);
    expect(store.notices).toHaveLength(1);
    work(store, "New work");
    const kept = backups(directory).map((file) => readFileSync(file, "utf8"));
    expect(kept).toContain(damaged);
  });

  it("drops only an unreadable undo step and keeps the project", () => {
    const directory = folder();
    const recovery = path.join(directory, "recovery.cutline");
    const p = newProject();
    p.name = "Two hours of work";
    p.clips.push(makeClip(p, "text", "titles", 0));
    writeFileSync(
      recovery,
      JSON.stringify({
        project: p,
        past: [{ label: "Old", project: { id: 1, clips: "broken" } }],
        future: [],
        filePath: null,
      }),
    );
    const store = new Store(recovery);
    expect(store.project.name).toBe("Two hours of work");
    expect(() => store.undo()).not.toThrow();
    expect(store.project.name).toBe("Two hours of work");
    expect(store.project.clips).toHaveLength(1);
  });
});

describe("autosave failures", () => {
  it("keeps the editor in sync and never recreates a missing project folder", () => {
    const directory = folder();
    const projects = path.join(directory, "Projects");
    mkdirSync(projects);
    const recovery = path.join(directory, "recovery.cutline");
    const store = new Store(recovery);
    store.save(path.join(projects, "Reel.cutline"));
    // The drive is ejected, or the folder is moved in Finder.
    rmSync(projects, { recursive: true });
    const events: any[] = [];
    store.on("change", (snapshot) => events.push(snapshot));
    expect(() =>
      store.commit({ ...store.project, name: "Edited" }, "Rename"),
    ).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0].project.revision).toBe(store.project.revision);
    expect(existsSync(projects)).toBe(false);
    expect(store.saveError).toContain("Reel.cutline");
    expect(events[0].saveError).toContain("Reel.cutline");
    expect(JSON.parse(readFileSync(recovery, "utf8")).project.name).toBe(
      "Edited",
    );
    store.undo();
    expect(events).toHaveLength(2);
    store.save(path.join(directory, "Reel moved.cutline"));
    expect(store.saveError).toBeNull();
    expect(
      JSON.parse(
        readFileSync(path.join(directory, "Reel moved.cutline"), "utf8"),
      ).project.name,
    ).toBe(store.project.name);
  });

  it("does not throw or desync when the project file cannot be written", () => {
    const directory = folder();
    const projects = path.join(directory, "Read only");
    mkdirSync(projects);
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.save(path.join(projects, "Reel.cutline"));
    chmodSync(projects, 0o500);
    const events: any[] = [];
    store.on("change", (snapshot) => events.push(snapshot));
    expect(() => work(store, "Edited")).not.toThrow();
    expect(events).toHaveLength(1);
    expect(store.saveError).toContain("Reel.cutline");
    expect(readdirSync(projects).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    chmodSync(projects, 0o700);
    work(store, "Edited again");
    expect(store.saveError).toBeNull();
  });

  it("still treats work that never reached its file as unsaved after a relaunch", () => {
    const directory = folder();
    const drive = path.join(directory, "Drive");
    mkdirSync(drive);
    const recovery = path.join(directory, "recovery.cutline");
    const store = new Store(recovery);
    work(store, "Client cut");
    store.save(path.join(drive, "Client cut.cutline"));
    // The drive is ejected, an edit lands only in recovery, and Cutline quits.
    rmSync(drive, { recursive: true });
    work(store, "Client cut, edited while the drive was gone", 2);
    store.flush();
    const relaunched = new Store(recovery);
    expect(relaunched.saveError).toContain("Client cut.cutline");
    expect(relaunched.hasUnsavedWork()).toBe(true);
    // New (or Open, or a Finder double-click) keeps it as a backup.
    relaunched.fresh();
    expect(backupNames(directory)).toContain(
      "Client cut, edited while the drive was gone",
    );
  });

  it("forgets a save problem once the project file is written again", () => {
    const directory = folder();
    const drive = path.join(directory, "Drive");
    mkdirSync(drive);
    const recovery = path.join(directory, "recovery.cutline");
    const store = new Store(recovery);
    store.save(path.join(drive, "Client cut.cutline"));
    // The drive is ejected, with the project file on it.
    renameSync(drive, path.join(directory, "Ejected"));
    work(store, "Edited while the drive was gone");
    expect(store.saveError).toBeTruthy();
    // The drive comes back and the next edit reaches the file.
    renameSync(path.join(directory, "Ejected"), drive);
    work(store, "Edited after it came back");
    expect(store.saveError).toBeNull();
    const relaunched = new Store(recovery);
    expect(relaunched.saveError).toBeNull();
    expect(relaunched.hasUnsavedWork()).toBe(false);
  });
});

describe("project files changed or moved outside Cutline", () => {
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  /** One session's data folder, the way each Cutline session has its own. */
  const session = (directory: string, name: string) => {
    mkdirSync(path.join(directory, name));
    return path.join(directory, name, "recovery.cutline");
  };

  it("keeps autosaving to the same file after a relaunch when nothing else touched it", () => {
    const directory = folder();
    const recovery = session(directory, "video-2");
    const file = path.join(directory, "Reel.cutline");
    const store = new Store(recovery);
    store.save(file);
    work(store, "Reel");
    work(store, "Reel, second pass", 2);
    const relaunched = new Store(recovery);
    expect(relaunched.notices).toEqual([]);
    expect(relaunched.filePath).toBe(file);
    expect(relaunched.saveError).toBeNull();
    expect(relaunched.hasUnsavedWork()).toBe(false);
    work(relaunched, "Reel, after the relaunch");
    expect(relaunched.saveError).toBeNull();
    expect(read(file).project.name).toBe("Reel, after the relaunch");
  });

  it("trusts an autosave from an older version when the file still holds the same project", () => {
    const directory = folder();
    const file = path.join(directory, "Reel.cutline");
    const writer = new Store(session(directory, "main"));
    writer.save(file);
    work(writer, "Reel");
    // Another session opens it without editing, and both quit.
    const recovery = session(directory, "video-2");
    new Store(recovery).load(file);
    // Autosaves from before this version carry no file stamp.
    const older = read(recovery);
    delete older.fileStamp;
    writeFileSync(recovery, JSON.stringify(older));
    const relaunched = new Store(recovery);
    expect(relaunched.notices).toEqual([]);
    expect(relaunched.filePath).toBe(file);
    work(relaunched, "Reel, edited later");
    expect(read(file).project.name).toBe("Reel, edited later");
  });

  it("opens the newer file when another session changed it while this one was closed, keeping this copy as a backup", () => {
    const directory = folder();
    const file = path.join(directory, "Launch.cutline");
    const recovery = session(directory, "video-2");
    const video2 = new Store(recovery);
    video2.save(file);
    work(video2, "Launch, first cut");
    video2.close();
    // While Video 2 is closed, the main session opens Launch and edits it.
    const main = new Store(session(directory, "main"));
    main.load(file);
    work(main, "Launch, final cut", 3);
    main.close();
    const relaunched = new Store(recovery);
    expect(relaunched.project.name).toBe("Launch, final cut");
    expect(relaunched.project.clips).toHaveLength(4);
    expect(relaunched.filePath).toBe(file);
    expect(relaunched.notices).toHaveLength(1);
    expect(relaunched.notices[0]).toContain("opened the newer file");
    expect(backupNames(path.join(directory, "video-2"))).toEqual([
      "Launch, first cut",
    ]);
    // The next edit builds on the newer file instead of writing the old copy over it.
    work(relaunched, "Launch, final cut, trimmed");
    expect(read(file).project.clips).toHaveLength(5);
    // The earlier copy opens from the backup as an unsaved project.
    const [backup] = backups(path.join(directory, "video-2"));
    const restored = new Store(session(directory, "restore"));
    restored.restore(backup);
    expect(restored.project.name).toBe("Launch, first cut");
    expect(restored.filePath).toBeNull();
  });

  it("keeps both copies when the file changed elsewhere and this session has edits that never reached it", () => {
    const directory = folder();
    const drive = path.join(directory, "Drive");
    mkdirSync(drive);
    const file = path.join(drive, "Launch.cutline");
    const recovery = session(directory, "video-2");
    const video2 = new Store(recovery);
    video2.save(file);
    work(video2, "Launch");
    // The drive goes away, so this edit reaches only recovery.
    renameSync(drive, path.join(directory, "Away"));
    work(video2, "Launch, edited while the drive was away", 2);
    expect(video2.saveError).toBeTruthy();
    video2.close();
    renameSync(path.join(directory, "Away"), drive);
    // Another session edits the file meanwhile.
    const main = new Store(session(directory, "main"));
    main.load(file);
    work(main, "Launch, edited in main");
    main.close();
    const relaunched = new Store(recovery);
    expect(relaunched.project.name).toBe(
      "Launch, edited while the drive was away",
    );
    expect(relaunched.filePath).toBeNull();
    expect(relaunched.hasUnsavedWork()).toBe(true);
    expect(relaunched.notices[0]).toContain("left it as it is");
    work(relaunched, "Launch, edited again");
    expect(read(file).project.name).toBe("Launch, edited in main");
  });

  it("never writes over a project file that something else changed while it is open", () => {
    const directory = folder();
    const file = path.join(directory, "Launch.cutline");
    const store = new Store(session(directory, "main"));
    store.save(file);
    work(store, "Launch");
    // Another copy of Cutline, a sync app or a person changes the file.
    const theirs = read(file);
    theirs.project.name = "Launch, changed elsewhere";
    writeFileSync(file, JSON.stringify(theirs));
    expect(store.hasUnsavedWork()).toBe(true);
    work(store, "Launch, edited here");
    expect(store.saveError).toContain("changed outside this session");
    expect(read(file).project.name).toBe("Launch, changed elsewhere");
    // Saving there, as the person chooses, replaces it and autosave resumes.
    store.save(file);
    work(store, "Launch, saved again");
    expect(store.saveError).toBeNull();
    expect(read(file).project.name).toBe("Launch, saved again");
  });

  it("never recreates a project file renamed in Finder while it is open, before or after a relaunch", () => {
    const directory = folder();
    const file = path.join(directory, "Launch.cutline");
    const renamed = path.join(directory, "Launch FINAL.cutline");
    const recovery = session(directory, "main");
    const store = new Store(recovery);
    store.save(file);
    work(store, "Launch");
    renameSync(file, renamed);
    expect(store.hasUnsavedWork()).toBe(true);
    work(store, "Launch, after the rename", 2);
    expect(existsSync(file)).toBe(false);
    expect(store.saveError).toContain("moved, renamed or deleted");
    expect(read(renamed).project.name).toBe("Launch");
    store.close();
    const relaunched = new Store(recovery);
    expect(relaunched.project.name).toBe("Launch, after the rename");
    expect(relaunched.saveError).toContain("moved, renamed or deleted");
    expect(relaunched.hasUnsavedWork()).toBe(true);
    work(relaunched, "Launch, edited again");
    expect(existsSync(file)).toBe(false);
    // Saving to the renamed file, as the person chooses, continues there.
    relaunched.save(renamed);
    work(relaunched, "Launch FINAL");
    expect(relaunched.saveError).toBeNull();
    expect(read(renamed).project.name).toBe("Launch FINAL");
  });

  it("asks again after a relaunch when the file went missing while Cutline was closed", () => {
    const directory = folder();
    const file = path.join(directory, "Draft (build 1).cutline");
    const recovery = session(directory, "video-3");
    const store = new Store(recovery);
    store.save(file);
    work(store, "Draft");
    store.close();
    rmSync(file);
    const relaunched = new Store(recovery);
    expect(relaunched.filePath).toBe(file);
    expect(relaunched.saveError).toContain("moved, renamed or deleted");
    work(relaunched, "Draft, touched");
    expect(existsSync(file)).toBe(false);
    relaunched.fresh();
    expect(backupNames(path.join(directory, "video-3"))).toEqual([
      "Draft, touched",
    ]);
  });

  it("keeps a backup on New when the open project's file was deleted, even before another edit", () => {
    const directory = folder();
    const file = path.join(directory, "Launch.cutline");
    const store = new Store(session(directory, "main"));
    store.save(file);
    work(store, "Launch");
    rmSync(file);
    expect(store.hasUnsavedWork()).toBe(true);
    store.fresh();
    expect(backupNames(path.join(directory, "main"))).toEqual(["Launch"]);
    expect(existsSync(file)).toBe(false);
  });

  it("lets an agent save only to a new path once the open file was moved or changed", async () => {
    const directory = folder();
    const file = path.join(directory, "Launch.cutline");
    const store = new Store(session(directory, "main"));
    store.save(file);
    work(store, "Launch");
    const jobs = new Jobs(() => {});
    const call = createAgentIO({
      store,
      media: new Media(
        path.join(directory, "cache"),
        { ffmpeg: "", ffprobe: "", whisper: "", model: "" },
        jobs,
      ),
      jobs,
      directory,
      preview: async () => ({}),
      status: () => ({}),
    });
    const guard = () => ({
      projectId: store.project.id,
      revision: store.project.revision,
    });
    renameSync(file, path.join(directory, "Launch FINAL.cutline"));
    await expect(call("cutline_save_project", guard())).rejects.toThrow(
      /moved, renamed or deleted.*new path/,
    );
    expect(existsSync(file)).toBe(false);
    const elsewhere = path.join(directory, "Launch copy.cutline");
    await call("cutline_save_project", { ...guard(), path: elsewhere });
    expect(store.filePath).toBe(elsewhere);
  });
});

describe("autosave cost", () => {
  it("writes only the current project on each edit and the undo history later", () => {
    const directory = folder();
    const recovery = path.join(directory, "recovery.cutline");
    const file = path.join(directory, "Interview.cutline");
    const store = new Store(recovery);
    store.historyDelay = 60_000;
    store.save(file);
    work(store, "Interview", 120);
    for (let i = 0; i < 70; i++)
      store.commit({ ...store.project, name: `Edit ${i}` }, "Rename");
    const size = JSON.stringify(store.project).length;
    expect(statSync(recovery).size).toBeLessThan(size * 2);
    expect(statSync(file).size).toBeLessThan(size * 2);
    store.flush();
    const restarted = new Store(recovery);
    expect(restarted.project.name).toBe("Edit 69");
    expect(restarted.snapshot().canUndo).toBe(true);
    restarted.undo();
    expect(restarted.project.name).toBe("Edit 68");
  });

  it("recovers the latest project after a crash before history was written", () => {
    const directory = folder();
    const recovery = path.join(directory, "recovery.cutline");
    const store = new Store(recovery);
    store.historyDelay = 60_000;
    work(store, "A");
    work(store, "B");
    const restarted = new Store(recovery);
    expect(restarted.project.name).toBe("B");
    expect(restarted.project.clips).toHaveLength(2);
  });

  it("writes history in the background after edits pause", async () => {
    const directory = folder();
    const recovery = path.join(directory, "recovery.cutline");
    const store = new Store(recovery);
    store.historyDelay = 5;
    work(store, "A");
    work(store, "B");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await store.idle();
    const restarted = new Store(recovery);
    expect(restarted.snapshot().canUndo).toBe(true);
    restarted.undo();
    expect(restarted.project.name).toBe("A");
  });

  it("still opens older project files that carry their own undo history", () => {
    const directory = folder();
    const file = path.join(directory, "Old.cutline");
    const before = newProject();
    before.name = "Before";
    const after = { ...structuredClone(before), name: "After" };
    writeFileSync(
      file,
      JSON.stringify({
        project: after,
        past: [{ label: "Rename", project: before }],
        future: [],
        filePath: file,
      }),
    );
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.load(file);
    expect(store.project.name).toBe("After");
    store.undo();
    expect(store.project.name).toBe("Before");
  });

  it("keeps the latest undo steps when the open project is opened again", () => {
    const directory = folder();
    const file = path.join(directory, "Reel.cutline");
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.historyDelay = 60_000;
    store.save(file);
    work(store, "One");
    work(store, "Two");
    // Finder opens the same file again before the history was written.
    store.load(file);
    expect(store.project.name).toBe("Two");
    store.undo();
    expect(store.project.name).toBe("One");
  });

  it("does not rewrite a project file just because it was opened", () => {
    const directory = folder();
    const file = path.join(directory, "Shared.cutline");
    const p = newProject();
    p.name = "Shared";
    const original = JSON.stringify({ project: p, futureField: "kept" });
    writeFileSync(file, original);
    const store = new Store(path.join(directory, "recovery.cutline"));
    store.load(file);
    expect(readFileSync(file, "utf8")).toBe(original);
  });
});

describe("moved projects", () => {
  it("finds media that moved together with the project folder", () => {
    const directory = folder();
    const original = path.join(directory, "Client A");
    const clip = path.join(original, "media", "interview.mp4");
    mkdirSync(path.dirname(clip), { recursive: true });
    writeFileSync(clip, "fixture");
    const store = new Store(path.join(directory, "recovery.cutline"));
    const p = structuredClone(store.project);
    p.assets.push({
      id: "interview",
      name: "interview.mp4",
      kind: "video",
      path: clip,
      duration: 10,
      hasAudio: true,
    });
    store.commit(p, "Import");
    store.save(path.join(original, "Client A.cutline"));
    const moved = path.join(directory, "Archive SSD", "Client A");
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(original, moved);
    const reopened = new Store(path.join(directory, "second.cutline"));
    reopened.load(path.join(moved, "Client A.cutline"));
    expect(reopened.project.assets[0].path).toBe(
      path.join(moved, "media", "interview.mp4"),
    );
    expect(reopened.snapshot().missing).toEqual([]);
  });
});

const ffmpeg = path.resolve(
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
const ffprobe = path.resolve(
  "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
);
const hasTools =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  existsSync(ffmpeg) &&
  existsSync(ffprobe);
const make = (...args: string[]) =>
  execFileSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", ...args]);
function mediaFor(directory: string, bin: Partial<Media["bin"]> = {}) {
  const jobs = new Jobs(() => {});
  const media = new Media(
    path.join(directory, "cache"),
    {
      ffmpeg,
      ffprobe,
      whisper: path.join(directory, "whisper"),
      model: path.join(directory, "model.bin"),
      ...bin,
    },
    jobs,
  );
  return { jobs, media, cache: path.join(directory, "cache") };
}
const cached = (cache: string) => (existsSync(cache) ? readdirSync(cache) : []);
/** A stand-in ffmpeg that records its arguments and can fail one step. */
function ffmpegWrapper(directory: string, failWhen?: string) {
  const log = path.join(directory, "ffmpeg.log");
  const script = path.join(directory, "ffmpeg-wrapper");
  writeFileSync(
    script,
    `#!/bin/sh\necho "$*" >> "${log}"\n${
      failWhen
        ? `case "$*" in *${failWhen}*) echo "simulated failure" >&2; exit 1;; esac\n`
        : ""
    }exec "${ffmpeg}" "$@"\n`,
  );
  chmodSync(script, 0o755);
  return {
    script,
    calls: () =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}
/** A stand-in for whisper-cli that writes a fixed transcript. */
function fakeWhisper(directory: string) {
  const log = path.join(directory, "whisper.log");
  const script = path.join(directory, "whisper");
  writeFileSync(
    script,
    `#!/bin/sh\necho run >> "${log}"\nout=""\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-of" ]; then out="$2"; fi\n  shift\ndone\nprintf '%s' '{"transcription":[{"text":" Hello","offsets":{"from":0,"to":400}},{"text":" world","offsets":{"from":400,"to":900}}]}' > "$out.json"\n`,
  );
  chmodSync(script, 0o755);
  writeFileSync(path.join(directory, "model.bin"), "model");
  return () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
}
const audioAsset = (file: string, duration: number): Asset => ({
  id: "speech",
  name: path.basename(file),
  path: file,
  kind: "audio",
  duration,
  hasAudio: true,
});

describe.runIf(hasTools)("media with the bundled ffmpeg", () => {
  it("finds every pause in a long recording, not just the last ones", async () => {
    const directory = folder();
    const file = path.join(directory, "pauses.wav");
    // 1,100 pauses: 0.3 s of tone, then 0.6 s of silence, for 16.5 minutes.
    make(
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(lt(mod(t,0.9),0.3),0.5*sin(2*PI*200*t),0)':s=4000:d=990",
      "-c:a",
      "pcm_s16le",
      file,
    );
    const { media } = mediaFor(directory);
    const silences = await media.silences(audioAsset(file, 990));
    expect(silences).toHaveLength(1100);
    expect(silences[0].start).toBeCloseTo(0.3, 1);
    expect(silences[0].end).toBeCloseTo(0.9, 1);
    expect(silences.at(-1)!.start).toBeCloseTo(989.4, 1);
    expect(silences.every((s) => s.end > s.start && s.start > 0)).toBe(true);
  });

  it("finds pauses without decoding the video", async () => {
    const directory = folder();
    const file = path.join(directory, "talk.mp4");
    make(
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=320x240:d=2",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(lt(t,1),0.5*sin(2*PI*200*t),0)':s=8000:d=2",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      file,
    );
    const wrapper = ffmpegWrapper(directory);
    const { media } = mediaFor(directory, { ffmpeg: wrapper.script });
    const silences = await media.silences({
      ...audioAsset(file, 2),
      kind: "video",
    });
    expect(silences).toHaveLength(1);
    const call = wrapper.calls().find((line) => line.includes("silencedetect"));
    expect(call).toContain("-vn");
    expect(call).toContain("-map 0:a:0");
  });

  it("imports music with album art as audio", async () => {
    const directory = folder();
    const files = ["song.mp3", "song.m4a"].map((name) =>
      path.join(directory, name),
    );
    for (const file of files)
      make(
        "-f",
        "lavfi",
        "-i",
        "sine=f=440:d=2",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=64x64:d=1",
        "-map",
        "0:a",
        "-map",
        "1:v",
        "-frames:v",
        "1",
        "-c:a",
        file.endsWith(".mp3") ? "libmp3lame" : "aac",
        "-c:v",
        "mjpeg",
        "-disposition:v:0",
        "attached_pic",
        file,
      );
    const { media, cache } = mediaFor(directory);
    for (const file of files) {
      const asset = await media.import(file);
      expect(asset.kind).toBe("audio");
      expect(asset.proxy).toBeUndefined();
      expect(asset.waveform?.length).toBe(160);
    }
    expect(cached(cache)).toEqual([]);
  });

  it("leaves no raw waveform or transcription files in the cache", async () => {
    const directory = folder();
    const file = path.join(directory, "voice.wav");
    make("-f", "lavfi", "-i", "sine=f=300:d=3", file);
    const whisperRuns = fakeWhisper(directory);
    const { media, cache } = mediaFor(directory);
    const asset = await media.import(file);
    expect(Math.max(...asset.waveform!)).toBeGreaterThan(0.05);
    const words = await media.transcribe(asset);
    expect(words.map((w) => w.text)).toEqual(["Hello", "world"]);
    expect(cached(cache)).toEqual([]);
    // Trying again after an interrupted edit reuses the transcript.
    expect(await media.transcribe(asset)).toEqual(words);
    expect(whisperRuns()).toBe(1);
  });

  it("removes its cache files when an import fails", async () => {
    const directory = folder();
    const file = path.join(directory, "clip.mp4");
    make(
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=320x240:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=d=1",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      file,
    );
    const wrapper = ffmpegWrapper(directory, "f32le");
    const { media, cache } = mediaFor(directory, { ffmpeg: wrapper.script });
    await expect(media.import(file)).rejects.toThrow("simulated failure");
    expect(cached(cache)).toEqual([]);
  });

  it("adds heavy video right away and makes its preview copy in the background", async () => {
    const directory = folder();
    const file = path.join(directory, "camera.mp4");
    // MPEG-4 Part 2 needs a preview copy, like HEVC, ProRes or 4K footage.
    make(
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=320x240:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=d=1",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      "-shortest",
      file,
    );
    const { media, jobs } = mediaFor(directory);
    const asset = await media.import(file);
    expect(asset.kind).toBe("video");
    expect(asset.thumbnail && existsSync(asset.thumbnail)).toBe(true);
    expect(asset.proxy).toBeUndefined();
    expect([...jobs.jobs.values()].map((j) => j.kind)).toEqual(["import"]);
    const ready: any[] = [];
    media.on("preview", (event) => ready.push(event));
    media.ensurePreviews([asset]);
    await media.previewsIdle();
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ assetId: asset.id, path: file });
    const probe = JSON.parse(
      execFileSync(ffprobe, [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        ready[0].proxy,
      ]).toString(),
    );
    expect(probe.streams[0].codec_name).toBe("h264");
    expect(
      [...jobs.jobs.values()].find((j) => j.kind === "preview")?.state,
    ).toBe("done");
  });

  it("rebuilds preview files that were deleted, playing the original meanwhile", async () => {
    const directory = folder();
    const file = path.join(directory, "camera.mp4");
    make("-f", "lavfi", "-i", "testsrc=s=320x240:d=1", "-c:v", "mpeg4", file);
    const recovery = path.join(directory, "recovery.cutline");
    const p = newProject();
    p.assets.push({
      id: "camera",
      name: "camera.mp4",
      kind: "video",
      path: file,
      duration: 1,
      hasAudio: false,
      // The media cache was cleared, or the project came from another Mac.
      proxy: path.join(directory, "gone", "camera-proxy.mp4"),
      thumbnail: path.join(directory, "gone", "camera.jpg"),
    });
    writeFileSync(recovery, JSON.stringify({ project: p }));
    const store = new Store(recovery);
    expect(store.project.assets[0].proxy).toBeUndefined();
    expect(store.project.assets[0].thumbnail).toBeUndefined();
    const { media } = mediaFor(directory);
    media.on("preview", (ready) =>
      store.setPreview(ready.assetId, ready, ready.path),
    );
    media.ensurePreviews(store.project.assets);
    await media.previewsIdle();
    const [asset] = store.project.assets;
    expect(asset.proxy && existsSync(asset.proxy)).toBe(true);
    expect(asset.thumbnail && existsSync(asset.thumbnail)).toBe(true);
    expect(store.snapshot().missing).toEqual([]);
  });

  it("rebuilds previews without rewriting the opened project file, and reuses them next time", async () => {
    const directory = folder();
    const file = path.join(directory, "camera.mp4");
    make("-f", "lavfi", "-i", "testsrc=s=320x240:d=1", "-c:v", "mpeg4", file);
    const p = newProject();
    p.name = "Shared on another Mac";
    p.assets.push({
      id: "camera",
      name: "camera.mp4",
      kind: "video",
      path: file,
      duration: 1,
      hasAudio: false,
      proxy: "/Users/someone-else/Library/Cutline/media-cache/camera-proxy.mp4",
      thumbnail: "/Users/someone-else/Library/Cutline/media-cache/camera.jpg",
    });
    const projectFile = path.join(directory, "Shared.cutline");
    const original = JSON.stringify({ project: p, futureField: "kept" });
    writeFileSync(projectFile, original);
    const open = async () => {
      const store = new Store(path.join(directory, "recovery.cutline"));
      store.load(projectFile);
      const { media, jobs } = mediaFor(directory);
      media.on("preview", (ready) =>
        store.setPreview(ready.assetId, ready, ready.path),
      );
      media.ensurePreviews(store.project.assets);
      await media.previewsIdle();
      return { store, jobs };
    };
    const first = await open();
    expect(first.store.project.assets[0].proxy).toBeTruthy();
    expect(readFileSync(projectFile, "utf8")).toBe(original);
    // The next session finds the preview copy it already made.
    const second = await open();
    expect(second.store.project.assets[0].proxy).toBe(
      first.store.project.assets[0].proxy,
    );
    expect([...second.jobs.jobs.values()].map((j) => j.kind)).not.toContain(
      "preview",
    );
  });

  it("keeps a background preview for media that comes back with Redo", async () => {
    const directory = folder();
    const file = path.join(directory, "camera.mp4");
    make("-f", "lavfi", "-i", "testsrc=s=320x240:d=1", "-c:v", "mpeg4", file);
    const store = new Store(path.join(directory, "recovery.cutline"));
    const { media } = mediaFor(directory);
    media.on("preview", (ready) =>
      store.setPreview(ready.assetId, ready, ready.path),
    );
    const asset = await media.import(file);
    store.commit({ ...store.project, assets: [asset] }, "Import media");
    media.ensurePreviews(store.project.assets);
    store.undo();
    await media.previewsIdle();
    expect(store.project.assets).toEqual([]);
    store.redo();
    const proxy = store.project.assets[0].proxy;
    expect(proxy && existsSync(proxy)).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const spoken: Word[] = Array.from({ length: 20 }, (_, i) => ({
  text: i % 5 === 4 ? `word${i}.` : `word${i}`,
  start: i,
  end: i + 0.7,
}));
function editFixture() {
  const directory = folder();
  const file = path.join(directory, "interview.mp4");
  writeFileSync(file, "fixture");
  const store = new Store(path.join(directory, "recovery.cutline"));
  const p = structuredClone(store.project);
  p.assets.push({
    id: "interview",
    name: "interview.mp4",
    kind: "video",
    path: file,
    duration: 20,
    hasAudio: true,
  });
  p.clips.push({
    ...makeClip(p, "video", "video", 0, p.assets[0]),
    id: "interview-clip",
    duration: 20 * p.fps,
  });
  store.commit(p, "Import");
  const transcribed = deferred<Word[]>(),
    found = deferred<{ start: number; end: number }[]>();
  const media = {
    transcribe: vi.fn(() => transcribed.promise),
    silences: vi.fn(() => found.promise),
  };
  const deps = {
    store,
    media,
    jobs: new Jobs(() => {}),
    speechReady: () => true,
  } as unknown as EditJobDeps;
  const args = () => ({
    projectId: store.project.id,
    revision: store.project.revision,
    clipId: "interview-clip",
  });
  return { store, media, deps, args, transcribed, found };
}
const captionsOf = (p: Project) => p.clips.filter((c) => c.kind === "caption");

describe("long edits keep their finished work when other edits land meanwhile", () => {
  it("adds captions after an unrelated edit made while transcribing", async () => {
    const f = editFixture();
    const pending = generateCaptions(f.deps, f.args());
    f.store.commit({ ...f.store.project, name: "Renamed meanwhile" }, "Rename");
    f.transcribed.resolve(spoken);
    const result = await pending;
    expect(result.captions).toBeGreaterThan(0);
    expect(f.store.project.name).toBe("Renamed meanwhile");
    expect(f.store.project.assets[0].words).toEqual(spoken);
    expect(captionsOf(f.store.project)).toHaveLength(result.captions);
    // Undo removes only the captions, keeping the rename.
    f.store.undo();
    expect(f.store.project.name).toBe("Renamed meanwhile");
    expect(captionsOf(f.store.project)).toHaveLength(0);
  });

  it("places captions where the clip is now when it moved while transcribing", async () => {
    const f = editFixture();
    const pending = generateCaptions(f.deps, f.args());
    const moved = structuredClone(f.store.project);
    moved.clips[0].start = 90;
    f.store.commit(moved, "Move clip");
    f.transcribed.resolve(spoken);
    await pending;
    const captions = captionsOf(f.store.project);
    expect(captions.length).toBeGreaterThan(0);
    expect(Math.min(...captions.map((c) => c.start))).toBeGreaterThanOrEqual(
      90,
    );
  });

  it("explains when the clip was deleted while transcribing, changing nothing", async () => {
    const f = editFixture();
    const pending = generateCaptions(f.deps, f.args());
    f.store.commit({ ...f.store.project, clips: [] }, "Delete clip");
    const before = f.store.project;
    f.transcribed.resolve(spoken);
    await expect(pending).rejects.toThrow("removed");
    expect(f.store.project).toBe(before);
  });

  it("refuses when another project was opened while transcribing", async () => {
    const f = editFixture();
    const pending = generateCaptions(f.deps, f.args());
    f.store.fresh();
    f.transcribed.resolve(spoken);
    await expect(pending).rejects.toThrow("Another project");
    expect(captionsOf(f.store.project)).toHaveLength(0);
  });

  it("never lands in a Finder duplicate or a backup of the project, which keep its ID", async () => {
    const f = editFixture();
    const directory = folder();
    const file = path.join(directory, "Reel.cutline");
    f.store.save(file);
    const copy = path.join(directory, "Reel copy.cutline");
    writeFileSync(copy, readFileSync(file, "utf8"));
    const captions = generateCaptions(f.deps, f.args());
    f.store.load(copy);
    expect(f.store.project.id).toBe(
      JSON.parse(readFileSync(file, "utf8")).project.id,
    );
    f.transcribed.resolve(spoken);
    await expect(captions).rejects.toThrow("Another project");
    expect(captionsOf(f.store.project)).toHaveLength(0);
    // The same for pauses and a backup opened while they were being found.
    const pauses = removeLongPauses(f.deps, f.args());
    f.store.restore(copy);
    f.found.resolve([{ start: 5, end: 9 }]);
    await expect(pauses).rejects.toThrow("Another project");
    expect(
      f.store.project.clips.filter((c) => c.kind === "video"),
    ).toHaveLength(1);
  });

  it("removes pauses after an unrelated edit made while finding them", async () => {
    const f = editFixture();
    const pending = removeLongPauses(f.deps, f.args());
    f.store.commit({ ...f.store.project, name: "Renamed meanwhile" }, "Rename");
    f.found.resolve([{ start: 5, end: 9 }]);
    const result = await pending;
    expect(result.removed).toBe(true);
    expect(f.store.project.name).toBe("Renamed meanwhile");
    const pieces = f.store.project.clips.filter((c) => c.kind === "video");
    expect(pieces.length).toBe(2);
  });

  it("builds the Reel on top of an edit made while transcribing", async () => {
    const f = editFixture();
    const pending = buildReel(f.deps, {
      projectId: f.store.project.id,
      revision: f.store.project.revision,
      options: {
        sources: [{ assetId: "interview" }],
        targetSeconds: 15,
        mode: "append",
      },
    });
    await vi.waitFor(() => expect(f.media.transcribe).toHaveBeenCalled());
    f.store.commit({ ...f.store.project, name: "Renamed meanwhile" }, "Rename");
    f.transcribed.resolve(spoken);
    const result = await pending;
    expect(result.captionCount).toBeGreaterThan(0);
    expect(f.store.project.name).toBe("Renamed meanwhile");
    expect(f.store.project.assets[0].words).toEqual(spoken);
  });
});

describe("Reel format speech jobs", () => {
  it("transcribes automatic animations even with captions turned off", async () => {
    const f = editFixture();
    const pending = buildReel(f.deps, {
      ...f.args(),
      options: {
        sources: [{ assetId: "interview" }],
        targetSeconds: 15,
        mode: "append",
        format: "explainer",
        captions: false,
      },
    });
    await vi.waitFor(() => expect(f.media.transcribe).toHaveBeenCalled());
    f.transcribed.resolve(spoken);
    const result = await pending;
    expect(result.beatCount).toBeGreaterThan(0);
    expect(captionsOf(f.store.project)).toHaveLength(0);
    expect(f.store.project.assets[0].words).toEqual(spoken);
  });

  it("never replaces a timeline edited while speech timing runs", async () => {
    const f = editFixture();
    const pending = buildReel(f.deps, {
      ...f.args(),
      options: {
        sources: [{ assetId: "interview" }],
        targetSeconds: 15,
        mode: "replace",
        format: "talking-head",
      },
    });
    await vi.waitFor(() => expect(f.media.transcribe).toHaveBeenCalled());
    const changed = structuredClone(f.store.project);
    changed.clips[0].start = 60;
    f.store.commit(changed, "Move during preparation");
    const before = f.store.project;
    f.transcribed.resolve(spoken);
    await expect(pending).rejects.toThrow("Project changed");
    expect(f.store.project).toBe(before);
  });
});

describe("relinking media", () => {
  const credits = {
    provider: "Wikimedia Commons",
    page: "https://commons.wikimedia.org/wiki/File:Coffee.webm",
    creator: "Alex",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    title: "Coffee",
  };
  const grid = (duration: number) => ({
    ...manualBeatGrid({ bpm: 120, duration }),
    envelope: { step: 0.05, values: [0.2, 0.8] },
  });
  const rhythm = grid(30);
  function relinkFixture() {
    const directory = folder();
    const moved = path.join(directory, "Moved media");
    mkdirSync(moved);
    const store = new Store(path.join(directory, "recovery.cutline"));
    const p = structuredClone(store.project);
    p.assets.push(
      {
        id: "interview",
        name: "Client interview",
        kind: "video",
        path: path.join(directory, "Old drive", "interview.mp4"),
        duration: 30,
        hasAudio: true,
        words: spoken,
        origin: credits,
        rhythm,
      },
      {
        id: "music",
        name: "Original music · Bright momentum",
        kind: "audio",
        path: path.join(directory, "Old drive", "music.wav"),
        duration: 60,
        hasAudio: true,
        rhythm: grid(60),
      },
    );
    store.commit(p, "Import");
    for (const name of ["interview.mp4", "music.wav", "other.mp4"])
      writeFileSync(path.join(moved, name), "fixture");
    const durations: Record<string, number> = {
      "interview.mp4": 30,
      "music.wav": 60,
      "other.mp4": 12,
    };
    const fresh = (file: string, id?: string): Asset => ({
      id: id ?? "new-id",
      name: path.basename(file),
      kind: file.endsWith(".wav") ? "audio" : "video",
      path: file,
      duration: durations[path.basename(file)],
      hasAudio: true,
      thumbnail: file + ".jpg",
      waveform: [0.1, 0.4],
    });
    const media = {
      import: vi.fn(async (file: string, options?: { id?: string }) =>
        fresh(file, options?.id),
      ),
      probe: vi.fn(async (file: string) => ({
        kind: fresh(file).kind,
        duration: durations[path.basename(file)],
        hasAudio: true,
        hasPicture: !file.endsWith(".wav"),
        needsProxy: false,
      })),
    };
    const deps = { store, media } as any;
    return { store, media, deps, moved };
  }

  it("keeps the transcript, beats, credits and name of the same media", async () => {
    const f = relinkFixture();
    await relinkMedia(f.deps, "interview", path.join(f.moved, "interview.mp4"));
    const asset = f.store.project.assets.find((a) => a.id === "interview")!;
    expect(asset.path).toBe(path.join(f.moved, "interview.mp4"));
    expect(asset.name).toBe("Client interview");
    expect(asset.words).toEqual(spoken);
    expect(asset.rhythm).toEqual(rhythm);
    expect(asset.origin).toEqual(credits);
    expect(asset.waveform).toEqual([0.1, 0.4]);
  });

  it("clears only the timing data when the new file has a different length", async () => {
    const f = relinkFixture();
    const result = await relinkMedia(
      f.deps,
      "interview",
      path.join(f.moved, "other.mp4"),
    );
    const asset = f.store.project.assets.find((a) => a.id === "interview")!;
    expect(result.cleared).toBe(true);
    expect(asset.duration).toBe(12);
    expect(asset.words).toBeUndefined();
    expect(asset.rhythm).toBeUndefined();
    expect(asset.origin).toEqual(credits);
    expect(asset.name).toBe("Client interview");
  });

  it("finds other missing files that moved to the same folder", async () => {
    const f = relinkFixture();
    const result = await relinkMedia(
      f.deps,
      "interview",
      path.join(f.moved, "interview.mp4"),
    );
    expect(result.relinked).toBe(2);
    const music = f.store.project.assets.find((a) => a.id === "music")!;
    expect(music.path).toBe(path.join(f.moved, "music.wav"));
    expect(music.name).toBe("Original music · Bright momentum");
    expect(music.rhythm?.duration).toBe(60);
    expect(f.store.snapshot().missing).toEqual([]);
    // One Undo puts every file back.
    f.store.undo();
    expect(f.store.snapshot().missing).toHaveLength(2);
  });

  it("refuses a file of another kind", async () => {
    const f = relinkFixture();
    await expect(
      relinkMedia(f.deps, "interview", path.join(f.moved, "music.wav")),
    ).rejects.toThrow("video");
    expect(f.store.snapshot().missing).toHaveLength(2);
  });
});

describe("content security policy", () => {
  it("reaches the packaged app's file:// page, not only the dev server", () => {
    const html = readFileSync(path.resolve("index.html"), "utf8");
    const meta = html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
    );
    expect(meta?.[1]).toBe(contentSecurityPolicy);
    // It comes before any script, so it governs all of them.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("<script"),
    );
  });
});

describe("asking before replacing unsaved work", () => {
  it("asks only when the project exists nowhere but in recovery", async () => {
    const directory = folder();
    const store = new Store(path.join(directory, "recovery.cutline"));
    const ask = vi.fn(async () => "cancel" as const);
    const save = vi.fn(async () => true);
    // A blank project needs no question.
    expect(await confirmReplace(store, ask, save)).toBe(true);
    work(store, "Client cut");
    expect(await confirmReplace(store, ask, save)).toBe(false);
    expect(ask).toHaveBeenCalledWith("Client cut");
    expect(save).not.toHaveBeenCalled();
    ask.mockResolvedValue("save" as any);
    save.mockResolvedValueOnce(false);
    expect(await confirmReplace(store, ask, save)).toBe(false);
    ask.mockResolvedValue("discard" as any);
    expect(await confirmReplace(store, ask, save)).toBe(true);
    // Once saved to a file, autosave keeps it, so there is nothing to ask.
    store.save(path.join(directory, "Client cut.cutline"));
    ask.mockClear();
    expect(await confirmReplace(store, ask, save)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("media cache upkeep", () => {
  it("removes leftovers older versions never deleted, and keeps what projects use", async () => {
    const directory = folder();
    const { media, cache } = mediaFor(directory);
    mkdirSync(cache);
    const files: Record<string, string> = {
      "a1.f32": "raw waveform",
      "b2.wav": "transcription audio",
      "b2.wav.transcript.json": "{}",
      "c3-proxy.mp4": "",
      "d4-proxy.mp4": "finished preview",
      "e5.jpg": "thumbnail",
      "f6-x-proxy.mp4.part": "unfinished preview",
    };
    const hourAgo = new Date(Date.now() - 3600_000);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(cache, name), content);
      utimesSync(path.join(cache, name), hourAgo, hourAgo);
    }
    // Work started by this session is never touched.
    writeFileSync(path.join(cache, "g7.wav"), "transcribing now");
    const removed = await media.cleanCache(Date.now() - 60_000);
    expect(removed).toBe(5);
    expect(cached(cache).sort()).toEqual(["d4-proxy.mp4", "e5.jpg", "g7.wav"]);
  });

  it("keeps preview copies under the cap, oldest first, never the open project's", async () => {
    const directory = folder();
    const { media, cache } = mediaFor(directory);
    mkdirSync(cache);
    const copy = (name: string, hoursAgo: number) => {
      writeFileSync(path.join(cache, name), "x".repeat(100));
      const when = new Date(Date.now() - hoursAgo * 3600_000);
      utimesSync(path.join(cache, name), when, when);
    };
    copy("old-proxy.mp4", 30);
    copy("used-proxy.mp4", 20);
    copy("mid-reversed.mp4", 10);
    copy("new-proxy.mp4", 1);
    copy("thumb.jpg", 40);
    const removed = await media.cleanCache(
      Date.now() - 60_000,
      [path.join(cache, "used-proxy.mp4")],
      200,
    );
    expect(removed).toBe(1);
    expect(cached(cache).sort()).toEqual([
      "mid-reversed.mp4",
      "new-proxy.mp4",
      "thumb.jpg",
      "used-proxy.mp4",
    ]);
  });
});
