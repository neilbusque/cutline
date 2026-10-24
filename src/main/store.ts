import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import {
  newProject,
  validateProject,
  type Project,
  type Snapshot,
} from "../shared/model";
import { applyCommands, TransactionSchema } from "../shared/commands";

type HistoryEntry = { label: string; project: Project };
/** Copies of an asset's media made on this Mac for playback. */
type PreviewFiles = {
  proxy?: string;
  thumbnail?: string;
  reversed?: string;
  reversedPart?: string;
  reversedSpan?: { from: number; to: number };
};
type History = { past: HistoryEntry[]; future: HistoryEntry[] };
export type StoreSnapshot = Snapshot & { saveError: string | null };
/** Identifies one version of a file on disk. */
type FileStamp = { size: number; mtimeMs: number; ino: number };

const historyLimit = 60;
const keptBackups = 20;
const keptHistories = 40;
let temporaryFiles = 0;
const stampOf = (file: string): FileStamp => {
  const info = statSync(file);
  return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
};
const isStamp = (value: any): value is FileStamp =>
  !!value &&
  Number.isFinite(value.size) &&
  Number.isFinite(value.mtimeMs) &&
  Number.isFinite(value.ino);
const sameStamp = (a: FileStamp, b: FileStamp) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
/** A project as its file records it: no revision and no preview copies, which only this Mac has. */
const content = (project: Project) =>
  JSON.stringify({
    ...project,
    revision: 0,
    assets: project.assets.map(
      ({
        proxy: _proxy,
        thumbnail: _thumbnail,
        reversed: _reversed,
        ...asset
      }) => asset,
    ),
  });
const moved = "it was moved, renamed or deleted outside Cutline";
const changedElsewhere = "it was changed outside this session";
const safeInRecovery =
  "Your work is safe in Cutline's recovery copy. Press Save to choose a new location.";
const reason = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT"
    ? "the folder is missing"
    : (error as NodeJS.ErrnoException)?.code === "EACCES" ||
        (error as NodeJS.ErrnoException)?.code === "EPERM" ||
        (error as NodeJS.ErrnoException)?.code === "EROFS"
      ? "Cutline isn't allowed to write there"
      : (error as NodeJS.ErrnoException)?.code === "ENOSPC"
        ? "the disk is full"
        : (error as Error)?.message || String(error);
const temporaryName = (file: string) =>
  `${file}.${process.pid}-${++temporaryFiles}.tmp`;
/** Writes the whole file under another name, then renames it into place. */
function writeWhole(file: string, data: string) {
  const temporary = temporaryName(file);
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Nothing was written. */
    }
    throw error;
  }
}
const isBlank = (p: Project) =>
  !p.assets.length && !p.clips.length && !p.motions.length && !p.story;
const fileName = (name: string) =>
  name
    .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, "-")
    .trim()
    .slice(0, 80) || "Untitled project";
function timestamp(date = new Date()) {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
}
/** Undo steps are checked when they are used, so one damaged step never blocks opening. */
function entries(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry) =>
        entry && typeof entry === "object" && typeof entry.project === "object",
    )
    .slice(-historyLimit)
    .map((entry) => ({
      label: String(entry.label ?? "Edit"),
      project: entry.project,
    }));
}

/**
 * The single source of truth for the open project.
 *
 * Every change writes the current project (small) to the recovery file and to
 * the project file right away. Undo history (up to 60 earlier versions) is
 * written separately, in the background, once edits pause, and again before
 * quitting or switching projects.
 */
export class Store extends EventEmitter {
  project: Project = newProject();
  /** Identifies this opening, even if the same project file is opened again. */
  openSession: string = randomUUID();
  filePath: string | null = null;
  /**
   * The project file as this store last wrote or read it. Autosave never
   * writes over a file that no longer matches, so a file that was renamed,
   * deleted or changed by something else is never recreated or overwritten.
   */
  private fileStamp: FileStamp | null = null;
  past: HistoryEntry[] = [];
  future: HistoryEntry[] = [];
  /** Why the latest autosave failed. The editor keeps working either way. */
  saveError: string | null = null;
  /** Messages for the person from startup, such as an unreadable autosave set aside. */
  notices: string[] = [];
  /** How long to wait after the last edit before writing undo history. */
  historyDelay = 1500;
  /** Runs before every edit; throws to refuse it, as for cancelled work. */
  beforeCommit?: () => void;
  readonly backupDirectory: string;
  readonly historyDirectory: string;
  private revision = 0;
  private session = randomUUID();
  private historyTimer?: ReturnType<typeof setTimeout>;
  private historyDirty = false;
  private historyWrite?: Promise<void>;
  private historyGeneration = 0;
  private checked = new WeakSet<object>();
  private releaseFile?: () => void;
  private previews = new Map<string, PreviewFiles & { path: string }>();
  constructor(
    readonly recovery: string,
    private claimFile?: (file: string) => () => void,
  ) {
    super();
    const folder = path.dirname(recovery);
    this.backupDirectory = path.join(folder, "backups");
    this.historyDirectory = path.join(folder, "history");
    if (existsSync(recovery)) {
      try {
        this.load(recovery, true);
      } catch {
        // Move the unreadable file out of the way so the next autosave
        // cannot overwrite it.
        const kept = this.setAside(recovery);
        this.notices.push(
          kept
            ? `Cutline couldn't read its last autosave, so it opened a new project. The old file was kept in ${kept}.`
            : "Cutline couldn't read its last autosave, so it opened a new project.",
        );
      }
    }
  }
  snapshot(): StoreSnapshot {
    return {
      project: this.project,
      canUndo: !!this.past.length,
      canRedo: !!this.future.length,
      filePath: this.filePath,
      missing: this.project.assets
        .filter((a) => !existsSync(a.path))
        .map((a) => a.id),
      saveError: this.saveError,
    };
  }
  /** Saves the change and tells the editor. Never throws: a failed write is reported in saveError. */
  notify() {
    this.writeCurrent();
    this.scheduleHistory();
    this.emit("change", this.snapshot());
  }
  /**
   * Records an edit. Pass validated when the project just came out of
   * applyCommands or applyAgentEdit, which check it already: a second full
   * check costs about 40 ms of main-process time per edit.
   */
  commit(next: Project, label: string, options: { validated?: boolean } = {}) {
    this.beforeCommit?.();
    const validated = options.validated ? next : validateProject(next);
    const entry = { label, project: this.project };
    this.checked.add(entry);
    this.past.push(entry);
    this.past = this.past.slice(-historyLimit);
    this.future = [];
    this.project = this.adopt({ ...validated, revision: ++this.revision });
    this.notify();
    return this.snapshot();
  }
  transact(raw: unknown) {
    const tx = TransactionSchema.parse(raw);
    return this.commit(applyCommands(this.project, tx), tx.label, {
      validated: true,
    });
  }
  undo() {
    return this.step(this.past, this.future);
  }
  redo() {
    return this.step(this.future, this.past);
  }
  private step(from: HistoryEntry[], to: HistoryEntry[]) {
    const count = from.length;
    const target = this.take(from);
    if (target) {
      const entry = { label: target.label, project: this.project };
      this.checked.add(entry);
      to.push(entry);
      this.project = this.adopt({
        ...target.project,
        revision: ++this.revision,
      });
      this.notify();
    } else if (from.length !== count) {
      // Only damaged steps were left; let the editor update its Undo state.
      this.scheduleHistory();
      this.emit("change", this.snapshot());
    }
    return this.snapshot();
  }
  /** Starts a blank project. Unsaved work is kept as a dated backup first. */
  fresh() {
    this.flush();
    this.keepUnsaved();
    this.releaseFile?.();
    this.releaseFile = undefined;
    this.project = { ...newProject(), revision: ++this.revision };
    this.openSession = randomUUID();
    this.past = [];
    this.future = [];
    this.filePath = null;
    this.fileStamp = null;
    this.setSaveError(null);
    this.notify();
    return this.snapshot();
  }
  /**
   * Whether replacing the open project would lose work that exists only in
   * recovery: it has no file, its file can't be written, or its file was
   * moved, deleted or changed outside this session.
   */
  hasUnsavedWork() {
    return (
      (!this.filePath || !!this.saveError || !!this.fileProblem()) &&
      !isBlank(this.project)
    );
  }
  /**
   * Why autosave must leave the project file alone, or null when it still
   * holds what this store last wrote or read.
   */
  fileProblem(): string | null {
    if (!this.filePath || this.filePath === this.recovery) return null;
    let now: FileStamp;
    try {
      now = stampOf(this.filePath);
    } catch (error) {
      // Other errors are reported by the write itself.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? moved : null;
    }
    return this.fileStamp && sameStamp(this.fileStamp, now)
      ? null
      : changedElsewhere;
  }
  /** Writes a complete copy, undo history included, to file. */
  persist(file: string) {
    const release = this.claimTarget(file);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeWhole(file, this.fullDocument());
    } finally {
      release?.();
    }
  }
  /** Saves to file and keeps autosaving there. Throws, changing nothing, if the file can't be written. */
  save(file: string) {
    const project = JSON.stringify(this.project);
    const release = this.claimTarget(file);
    let stamp: FileStamp;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeWhole(file, this.projectDocument(project, file));
      stamp = stampOf(file);
    } catch (error) {
      release?.();
      throw error;
    }
    if (release) {
      this.releaseFile?.();
      this.releaseFile = release;
    }
    const previousHistory = this.historyFile();
    const unsaved = !this.filePath;
    this.filePath = file;
    this.fileStamp = stamp;
    this.setSaveError(null);
    this.writeRecovery(project);
    if (this.historyFile() !== previousHistory) {
      this.historyDirty = true;
      this.flush();
      if (unsaved && existsSync(this.historyFile()))
        try {
          unlinkSync(previousHistory);
        } catch {
          /* There was no history yet. */
        }
    }
    this.emit("change", this.snapshot());
    return this.snapshot();
  }
  /** Opens a backup as a new unsaved project, so its edits never write into the backups folder. */
  restore(file: string) {
    return this.load(file, false, { unsaved: true });
  }
  load(
    file: string,
    recover = false,
    options: { unsaved?: boolean } = {},
  ): StoreSnapshot {
    const openingLease =
      !recover && !options.unsaved ? this.claimTarget(file) : undefined;
    let accepted = false;
    try {
      // Stamped before reading, so a write that lands meanwhile counts as a change.
      let fileStamp = recover || options.unsaved ? null : stampOf(file);
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const project = validateProject(raw.project ?? raw);
      let filePath = options.unsaved
        ? null
        : recover
          ? typeof raw.filePath === "string"
            ? raw.filePath
            : null
          : file;
      const inline: History = {
        past: entries(raw.past),
        future: entries(raw.future),
      };
      const legacy = !!(inline.past.length || inline.future.length);
      // Pending undo steps go to disk first, in case this is the open project.
      if (!recover) this.flush();
      const history = legacy
        ? inline
        : this.readHistory(project.id, filePath, raw.session, raw.revision);
      // Edits that never reached the project file before Cutline closed still
      // exist only in recovery, so New and Open must keep asking about them.
      let saveError =
        recover && typeof raw.saveError === "string" ? raw.saveError : null;
      if (recover && filePath) {
        // The file may have been moved, or changed by another session,
        // Dropbox or Time Machine, while this session was closed.
        const found = this.recoveredFile(filePath, raw, project);
        if (found.state === "same") fileStamp = found.stamp;
        else if (found.state === "missing") {
          // Never recreated; autosave resumes only if it comes back unchanged.
          fileStamp = isStamp(raw.fileStamp) ? raw.fileStamp : null;
          saveError ??= `Couldn't save to ${filePath} because ${moved}. ${safeInRecovery}`;
        } else {
          const opened =
            found.state === "newer" && saveError === null
              ? this.openNewer(filePath, project, history)
              : null;
          if (opened) return opened;
          // Both copies may hold work, or the file can't be read: leave it
          // as it is and keep this session's copy apart.
          this.notices.push(
            `“${path.basename(filePath, path.extname(filePath))}” was changed outside this session, so Cutline left it as it is and kept this session's copy as a separate project.`,
          );
          filePath = null;
        }
      }
      if (!recover) {
        this.relocate(project, history, raw.media, path.dirname(file));
        this.keepUnsaved();
      }
      let release: (() => void) | undefined = openingLease;
      try {
        if (filePath && !openingLease) release = this.claimTarget(filePath);
      } catch (error) {
        if (!recover) throw error;
        // Keep the recovery contents without autosaving over another session.
        this.notices.push(
          "The recovered file is open in another session. This session kept its recovery as a separate unsaved project.",
        );
        filePath = null;
      }
      if (release || !filePath) {
        this.releaseFile?.();
        this.releaseFile = release;
      }
      accepted = true;
      this.project = this.adopt({ ...project, revision: ++this.revision });
      this.openSession = randomUUID();
      this.past = history.past;
      this.future = history.future;
      this.filePath = filePath;
      this.fileStamp = filePath ? fileStamp : null;
      this.setSaveError(filePath ? saveError : null);
      // Older files carry their undo history inline; move it to the history file.
      if (legacy) this.scheduleHistory();
      if (!recover) {
        // The opened file is only rewritten after an edit.
        this.writeRecovery(JSON.stringify(this.project));
        this.emit("change", this.snapshot());
      }
      return this.snapshot();
    } finally {
      if (!accepted) openingLease?.();
    }
  }
  private claimTarget(file: string) {
    if (
      this.filePath &&
      path.resolve(file) === path.resolve(this.filePath) &&
      this.releaseFile
    )
      return undefined;
    return this.claimFile?.(file);
  }
  /**
   * Whether a relaunch may keep autosaving to the recovered project's file.
   * Recovery is written just before each autosave of the file, so an
   * untouched file has either the stamp recovery recorded or the session and
   * revision recovery describes. A file with the same content also counts.
   */
  private recoveredFile(
    file: string,
    raw: any,
    project: Project,
  ):
    | { state: "same"; stamp: FileStamp }
    | { state: "missing" | "newer" | "unreadable" } {
    let stamp: FileStamp;
    try {
      stamp = stampOf(file);
    } catch (error) {
      return {
        state:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unreadable",
      };
    }
    if (isStamp(raw.fileStamp) && sameStamp(raw.fileStamp, stamp))
      return { state: "same", stamp };
    let theirs: any;
    try {
      theirs = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { state: "unreadable" };
    }
    if (
      typeof raw.session === "string" &&
      theirs?.session === raw.session &&
      theirs?.revision === raw.revision
    )
      return { state: "same", stamp };
    try {
      if (
        content(validateProject(theirs?.project ?? theirs)) === content(project)
      )
        return { state: "same", stamp };
    } catch {
      return { state: "unreadable" };
    }
    return { state: "newer" };
  }
  /**
   * The recovered project's file was changed elsewhere while this session was
   * closed, and this session has nothing the file lacks: keep this session's
   * copy as a dated backup and open the file. Returns null, changing nothing,
   * when no backup can be kept.
   */
  private openNewer(
    file: string,
    project: Project,
    history: History,
  ): StoreSnapshot | null {
    const name = `“${path.basename(file, path.extname(file))}”`;
    try {
      this.keepCopy(
        JSON.stringify({
          project,
          past: history.past,
          future: history.future,
          filePath: null,
        }),
        project.name,
      );
    } catch {
      return null;
    }
    try {
      const opened = this.load(file);
      this.notices.push(
        `${name} was changed outside this session while Cutline was closed, so Cutline opened the newer file. This session's earlier copy is in File > Open backup.`,
      );
      return opened;
    } catch {
      // Open in another session, most likely. Start blank rather than
      // keeping a second copy of the same project.
      this.writeRecovery(JSON.stringify(this.project));
      this.notices.push(
        `${name} was changed outside this session and couldn't be opened here, so Cutline started a new project. This session's earlier copy is in File > Open backup.`,
      );
      return this.snapshot();
    }
  }
  close() {
    this.flush();
    this.releaseFile?.();
    this.releaseFile = undefined;
  }
  /** Writes pending undo history now. Call before quitting. */
  flush() {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    if (!this.historyDirty && !this.historyWrite) return;
    // A background write still in progress is now out of date.
    this.historyGeneration++;
    this.historyDirty = false;
    try {
      if (this.historyFolderReady())
        writeWhole(this.historyFile(), this.historyDocument());
    } catch {
      /* The project itself is saved; only older undo steps are at risk. */
    }
  }
  /** Resolves once no background history write is running. */
  async idle() {
    while (this.historyWrite) await this.historyWrite;
  }
  /**
   * Points an asset at rebuilt preview files (proxy or thumbnail) without
   * adding an undo step. Later edits, undo and redo keep the new files too,
   * including when the asset is out of the project for now (after an Undo):
   * pass its source path for that.
   */
  setPreview(assetId: string, files: PreviewFiles, sourcePath?: string) {
    const asset = this.project.assets.find((a) => a.id === assetId);
    const source = sourcePath ?? asset?.path;
    if (!source) return false;
    const previous = this.previews.get(assetId);
    this.previews.set(assetId, {
      ...(previous?.path === source ? previous : {}),
      path: source,
      ...(files.proxy ? { proxy: files.proxy } : {}),
      ...(files.thumbnail ? { thumbnail: files.thumbnail } : {}),
      ...(files.reversed ? { reversed: files.reversed } : {}),
      ...(files.reversedPart && files.reversedSpan
        ? { reversedPart: files.reversedPart, reversedSpan: files.reversedSpan }
        : {}),
    });
    const next = this.adopt(this.project);
    if (next !== this.project) {
      this.project = next;
      // Preview files are this Mac's cache, so opening a project never
      // rewrites its file; the next edit records them there.
      this.writeRecovery(JSON.stringify(this.project));
      this.emit("change", this.snapshot());
    }
    return asset?.path === source;
  }
  /**
   * Applies rebuilt preview files, and drops preview files that are gone
   * (media cache cleared, project opened on another Mac) so the editor plays
   * the original until a new preview is ready.
   */
  private adopt(project: Project): Project {
    let changed = false;
    const assets = project.assets.map((asset) => {
      const preview = this.previews.get(asset.id);
      const current = preview?.path === asset.path ? preview : undefined;
      let proxy = current?.proxy ?? asset.proxy,
        thumbnail = current?.thumbnail ?? asset.thumbnail,
        reversed = current?.reversed ?? asset.reversed;
      // A partial copy and the part it holds travel together.
      let part = current?.reversedPart
        ? { file: current.reversedPart, span: current.reversedSpan }
        : { file: asset.reversedPart, span: asset.reversedSpan };
      if (proxy && !existsSync(proxy)) proxy = undefined;
      if (thumbnail && !existsSync(thumbnail)) thumbnail = undefined;
      if (reversed && !existsSync(reversed)) reversed = undefined;
      if (!part.file || !part.span || !existsSync(part.file))
        part = { file: undefined, span: undefined };
      if (
        proxy === asset.proxy &&
        thumbnail === asset.thumbnail &&
        reversed === asset.reversed &&
        part.file === asset.reversedPart &&
        part.span === asset.reversedSpan
      )
        return asset;
      changed = true;
      const {
        proxy: _proxy,
        thumbnail: _thumbnail,
        reversed: _reversed,
        reversedPart: _reversedPart,
        reversedSpan: _reversedSpan,
        ...rest
      } = asset;
      return {
        ...rest,
        ...(proxy ? { proxy } : {}),
        ...(thumbnail ? { thumbnail } : {}),
        ...(reversed ? { reversed } : {}),
        ...(part.file && part.span
          ? { reversedPart: part.file, reversedSpan: part.span }
          : {}),
      };
    });
    return changed ? { ...project, assets } : project;
  }
  /** Takes the newest undo step that is still a valid project, skipping damaged ones. */
  private take(list: HistoryEntry[]) {
    while (list.length) {
      const entry = list.pop()!;
      if (this.checked.has(entry)) return entry;
      try {
        const valid = {
          label: entry.label,
          project: validateProject(entry.project),
        };
        this.checked.add(valid);
        return valid;
      } catch {
        /* Skip an undo step that can no longer be read. */
      }
    }
    return undefined;
  }
  private writeRecovery(project: string) {
    try {
      mkdirSync(path.dirname(this.recovery), { recursive: true });
      writeWhole(
        this.recovery,
        `{"project":${project},"filePath":${JSON.stringify(this.filePath)},"fileStamp":${JSON.stringify(this.fileStamp)},"saveError":${JSON.stringify(this.saveError)},"session":${JSON.stringify(this.session)},"revision":${this.project.revision}}`,
      );
      return null;
    } catch (error) {
      return reason(error);
    }
  }
  /** Autosaves the current project (without undo history) to recovery and the project file. */
  private writeCurrent() {
    const project = JSON.stringify(this.project);
    const recoveryError = this.writeRecovery(project);
    let saveError: string | null = null;
    if (this.filePath && this.filePath !== this.recovery) {
      try {
        // Never recreate a folder or a file that was moved, renamed, deleted
        // or ejected, and never write over a file something else changed.
        if (!existsSync(path.dirname(this.filePath)))
          throw Object.assign(Error("missing folder"), { code: "ENOENT" });
        const problem = this.fileProblem();
        if (problem) throw Error(problem);
        writeWhole(this.filePath, this.projectDocument(project, this.filePath));
        this.fileStamp = stampOf(this.filePath);
      } catch (error) {
        saveError = `Couldn't save to ${this.filePath} because ${reason(error)}. ${recoveryError ? "Save the project somewhere else now to keep your work." : safeInRecovery}`;
      }
    } else if (recoveryError)
      saveError = `Couldn't autosave this project because ${recoveryError}. Save it to a file to keep your work.`;
    const changed = saveError !== this.saveError;
    this.setSaveError(saveError);
    // Recovery records whether the project file kept up, so a relaunch still
    // knows which work exists nowhere else.
    if (changed && !recoveryError) this.writeRecovery(project);
  }
  private setSaveError(saveError: string | null) {
    if (saveError === this.saveError) return;
    this.saveError = saveError;
    this.emit("save-status", saveError);
  }
  /** Background writes never recreate a data folder that was deleted. */
  private historyFolderReady() {
    if (!existsSync(path.dirname(this.recovery))) return false;
    try {
      mkdirSync(this.historyDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    return true;
  }
  private projectDocument(project: string, file: string) {
    // Paths relative to the project file let a moved project folder find its media.
    const folder = path.dirname(file);
    const media = Object.fromEntries(
      this.project.assets
        .filter((asset) => path.isAbsolute(asset.path))
        .map((asset) => [asset.id, path.relative(folder, asset.path)]),
    );
    return `{"project":${project},"media":${JSON.stringify(media)},"session":${JSON.stringify(this.session)},"revision":${this.project.revision}}`;
  }
  private fullDocument() {
    return JSON.stringify({
      project: this.project,
      past: this.past,
      future: this.future,
      filePath: this.filePath,
    });
  }
  private historyHeader() {
    return `{"projectId":${JSON.stringify(this.project.id)},"filePath":${JSON.stringify(this.filePath)},"session":${JSON.stringify(this.session)},"revision":${this.project.revision},`;
  }
  private historyDocument() {
    return `${this.historyHeader()}"past":${JSON.stringify(this.past)},"future":${JSON.stringify(this.future)}}`;
  }
  private historyFile(
    projectId = this.project.id,
    filePath: string | null = this.filePath,
  ) {
    const key = createHash("sha256")
      .update(`${projectId}\n${filePath ?? ""}`)
      .digest("hex")
      .slice(0, 32);
    return path.join(this.historyDirectory, `${key}.json`);
  }
  private readHistory(
    projectId: string,
    filePath: string | null,
    session: unknown,
    revision: unknown,
  ): History {
    try {
      const raw = JSON.parse(
        readFileSync(this.historyFile(projectId, filePath), "utf8"),
      );
      if (raw.projectId !== projectId) return { past: [], future: [] };
      // History written before a crash can be a few edits behind. Its earlier
      // versions are still real, but its redo steps may no longer fit.
      const current = raw.session === session && raw.revision === revision;
      return {
        past: entries(raw.past),
        future: current ? entries(raw.future) : [],
      };
    } catch {
      return { past: [], future: [] };
    }
  }
  private scheduleHistory() {
    this.historyDirty = true;
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => {
      this.historyTimer = undefined;
      this.writeHistoryLater();
    }, this.historyDelay);
    this.historyTimer.unref?.();
  }
  /** Serializes one version per tick so a long history never blocks the editor. */
  private writeHistoryLater() {
    // A running write reschedules itself when it finishes.
    if (this.historyWrite) return;
    this.historyDirty = false;
    const generation = ++this.historyGeneration;
    const file = this.historyFile();
    const header = this.historyHeader();
    const past = this.past.slice(),
      future = this.future.slice();
    const stale = () => generation !== this.historyGeneration;
    const run = async () => {
      const serialize = async (list: HistoryEntry[]) => {
        const parts: string[] = [];
        for (const entry of list) {
          parts.push(JSON.stringify(entry));
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (stale()) return undefined;
        }
        return parts;
      };
      const pastParts = await serialize(past);
      const futureParts = pastParts && (await serialize(future));
      if (!pastParts || !futureParts || !this.historyFolderReady()) return;
      const temporary = temporaryName(file);
      try {
        const handle = await open(temporary, "w");
        try {
          await handle.write(header + '"past":[');
          for (let i = 0; i < pastParts.length; i++)
            await handle.write((i ? "," : "") + pastParts[i]);
          await handle.write('],"future":[');
          for (let i = 0; i < futureParts.length; i++)
            await handle.write((i ? "," : "") + futureParts[i]);
          await handle.write("]}");
        } finally {
          await handle.close();
        }
        // The check and the rename run together, so a newer flush always wins.
        if (stale()) await unlink(temporary);
        else renameSync(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      this.pruneHistories();
    };
    this.historyWrite = run()
      .catch(() => {
        /* The project itself is saved; the next edit writes history again. */
      })
      .finally(() => {
        this.historyWrite = undefined;
        if (this.historyDirty) this.scheduleHistory();
      });
  }
  /** Copies a project that exists only in recovery to a dated backup before it is replaced. */
  private keepUnsaved() {
    if (!this.hasUnsavedWork()) return null;
    try {
      return this.keepCopy(this.fullDocument(), this.project.name);
    } catch (error) {
      throw Error(
        `Couldn't keep a backup of “${this.project.name}”, so it was not replaced. Save it first. (${reason(error)})`,
      );
    }
  }
  /** Writes a dated backup that File > Open backup lists. Throws when it can't. */
  private keepCopy(document: string, name: string) {
    mkdirSync(this.backupDirectory, { recursive: true });
    const base = `${timestamp()} ${fileName(name)}`;
    let file = path.join(this.backupDirectory, `${base}.cutline`);
    for (let n = 2; existsSync(file); n++)
      file = path.join(this.backupDirectory, `${base} ${n}.cutline`);
    writeWhole(file, document);
    this.prune(this.backupDirectory, ".cutline", keptBackups);
    this.emit("backup", { file, name });
    return file;
  }
  private setAside(file: string) {
    try {
      mkdirSync(this.backupDirectory, { recursive: true });
      const kept = path.join(
        this.backupDirectory,
        `${timestamp()} unreadable autosave.cutline`,
      );
      try {
        renameSync(file, kept);
      } catch {
        copyFileSync(file, kept);
        unlinkSync(file);
      }
      return kept;
    } catch {
      return null;
    }
  }
  /** Re-points assets whose media moved together with the project folder. */
  private relocate(
    project: Project,
    history: History,
    media: unknown,
    folder: string,
  ) {
    if (!media || typeof media !== "object") return;
    const moved = new Map<string, string>();
    project.assets = project.assets.map((asset) => {
      const relative = (media as Record<string, unknown>)[asset.id];
      if (
        existsSync(asset.path) ||
        typeof relative !== "string" ||
        path.isAbsolute(relative)
      )
        return asset;
      const found = path.resolve(folder, relative);
      if (!existsSync(found)) return asset;
      moved.set(asset.path, found);
      return { ...asset, path: found };
    });
    if (!moved.size) return;
    const update = (entry: HistoryEntry) => {
      const assets = (entry.project as any)?.assets;
      if (!Array.isArray(assets)) return entry;
      return {
        ...entry,
        project: {
          ...entry.project,
          assets: assets.map((asset: any) =>
            moved.has(asset?.path)
              ? { ...asset, path: moved.get(asset.path) }
              : asset,
          ),
        },
      };
    };
    history.past = history.past.map(update);
    history.future = history.future.map(update);
  }
  private pruneHistories() {
    this.prune(this.historyDirectory, ".json", keptHistories);
  }
  private prune(folder: string, extension: string, keep: number) {
    try {
      const files = readdirSync(folder)
        // An autosave that could not be read is kept until someone deletes it.
        .filter(
          (name) =>
            name.endsWith(extension) && !name.includes("unreadable autosave"),
        )
        .map((name) => {
          const file = path.join(folder, name);
          return { file, time: statSync(file).mtimeMs };
        })
        .sort((a, b) => b.time - a.time);
      for (const { file } of files.slice(keep)) unlinkSync(file);
    } catch {
      /* Pruning is best effort. */
    }
  }
}
