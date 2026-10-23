import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Project } from "../shared/model";
import type { Store } from "./store";

/** One project as the Projects list shows it. */
export type ProjectSummary = {
  path: string;
  name: string;
  durationSeconds: number;
  clips: number;
  editedAt: string;
  open: boolean;
  inFolder: boolean;
};

const recentLimit = 40;
const isBlank = (p: Project) =>
  !p.assets.length && !p.clips.length && !p.motions.length && !p.story;
/** A project name as a file name: no path separators or characters Finder rejects. */
export function projectFileName(name: string) {
  return (
    name
      .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, "-")
      .trim()
      .slice(0, 80) || "Untitled project"
  );
}
const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);

/**
 * The person's projects: every project with content is a file, saved in the
 * projects folder unless they chose another place, and recently opened files
 * are remembered wherever they are.
 */
export class ProjectLibrary {
  private summaries = new Map<
    string,
    { mtime: number; summary: ProjectSummary }
  >();
  constructor(
    readonly folder: string,
    readonly recentsFile: string,
  ) {}
  /** A new file in the projects folder named after the project, never reusing a name. */
  newPath(name: string) {
    const base = projectFileName(name);
    let file = path.join(this.folder, `${base}.cutline`);
    for (let n = 2; existsSync(file); n++)
      file = path.join(this.folder, `${base} ${n}.cutline`);
    return file;
  }
  /**
   * Gives an unsaved project with content its own file in the projects folder,
   * where it then autosaves. Blank projects stay unsaved, so starting a new
   * project leaves nothing behind. Returns true when it saved.
   */
  fileIfNeeded(store: Store) {
    if (store.filePath || isBlank(store.project)) return false;
    try {
      mkdirSync(this.folder, { recursive: true });
      const file = this.newPath(store.project.name);
      store.save(file);
      this.remember(file);
      return true;
    } catch {
      // The editor keeps showing "Not saved", and Save still asks where.
      return false;
    }
  }
  private recents(): { path: string; openedAt: string }[] {
    try {
      const raw = JSON.parse(readFileSync(this.recentsFile, "utf8"));
      return Array.isArray(raw?.recent)
        ? raw.recent.filter(
            (r: any) =>
              typeof r?.path === "string" && typeof r?.openedAt === "string",
          )
        : [];
    } catch {
      return [];
    }
  }
  private writeRecents(list: { path: string; openedAt: string }[]) {
    try {
      mkdirSync(path.dirname(this.recentsFile), { recursive: true });
      writeFileSync(
        this.recentsFile,
        JSON.stringify({ recent: list.slice(0, recentLimit) }, null, 1),
      );
    } catch {
      /* The list is a convenience; projects themselves are already saved. */
    }
  }
  /** Puts a project file at the top of the recent list. */
  remember(file: string) {
    const full = path.resolve(file);
    this.writeRecents([
      { path: full, openedAt: new Date().toISOString() },
      ...this.recents().filter((r) => !same(r.path, full)),
    ]);
  }
  /** Takes a file off the recent list. The file itself is left alone. */
  forget(file: string) {
    this.writeRecents(this.recents().filter((r) => !same(r.path, file)));
  }
  private summary(
    file: string,
    open: string | null | undefined,
  ): ProjectSummary | null {
    let info;
    try {
      info = statSync(file);
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    const cached = this.summaries.get(file);
    let summary =
      cached && cached.mtime === info.mtimeMs ? cached.summary : null;
    if (!summary) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        const p = raw?.project ?? raw;
        const fps = Number(p?.fps) || 30;
        const clips: any[] = Array.isArray(p?.clips) ? p.clips : [];
        const end = clips.reduce(
          (m, c) =>
            Math.max(m, (Number(c.start) || 0) + (Number(c.duration) || 0)),
          0,
        );
        summary = {
          path: file,
          name:
            typeof p?.name === "string" && p.name
              ? p.name
              : path.basename(file, ".cutline"),
          durationSeconds: Math.round((end / fps) * 100) / 100,
          clips: clips.filter((c) => c?.kind !== "caption").length,
          editedAt: info.mtime.toISOString(),
          open: false,
          inFolder: same(path.dirname(file), this.folder),
        };
        this.summaries.set(file, { mtime: info.mtimeMs, summary });
      } catch {
        // Not a Cutline project, or written by something else: leave it out.
        return null;
      }
    }
    return { ...summary, open: !!open && same(file, open) };
  }
  /** Projects in the folder and recently opened ones elsewhere, most recently edited first. */
  list(open?: string | null): ProjectSummary[] {
    const files = new Map<string, string>();
    for (const r of this.recents())
      files.set(path.resolve(r.path), path.resolve(r.path));
    if (existsSync(this.folder))
      for (const name of readdirSync(this.folder))
        if (name.endsWith(".cutline") && !name.startsWith("."))
          files.set(
            path.resolve(this.folder, name),
            path.resolve(this.folder, name),
          );
    if (open) files.set(path.resolve(open), path.resolve(open));
    return [...files.values()]
      .map((file) => this.summary(file, open))
      .filter((s): s is ProjectSummary => !!s)
      .sort(
        (a, b) =>
          b.editedAt.localeCompare(a.editedAt) || a.name.localeCompare(b.name),
      );
  }
  /** A project by its file path or by its name (ignoring case). */
  find(nameOrPath: string) {
    const list = this.list();
    const byPath = list.find((p) => same(p.path, nameOrPath));
    if (byPath) return byPath;
    const wanted = nameOrPath.trim().toLowerCase();
    const named = list.filter((p) => p.name.trim().toLowerCase() === wanted);
    if (named.length > 1)
      throw Error(
        `There is more than one project called “${nameOrPath}”. Open it by path: ${named.map((p) => p.path).join(", ")}`,
      );
    if (!named.length)
      throw Error(
        `There is no project called “${nameOrPath}”. List them with cutline_list_projects.`,
      );
    return named[0];
  }
}
