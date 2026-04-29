import { mkdirSync, renameSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "./frontmatter.ts";

export interface Project {
  slug: string;
  path: string;
  dir: string;
  data: Record<string, unknown>;
  body: string;
  tasks: Task[];
}

export interface Task {
  slug: string;
  path: string;
  archived: boolean;
  data: Record<string, unknown>;
  body: string;
  parent?: string;
  children?: Task[];
  dir?: string;
}

const RESERVED = new Set(["reports", "node_modules"]);

export interface LoadOptions {
  archived?: boolean;
}

export function loadProjects(root: string, opts: LoadOptions = {}): Project[] {
  if (!isDir(root)) return [];
  const projects: Project[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith(".")) continue;
    if (RESERVED.has(entry)) continue;
    const dir = join(root, entry);
    if (!isDir(dir)) continue;
    const projectFile = join(dir, "project.md");
    if (!isFile(projectFile)) continue;
    const { data, body } = parse(readFileSync(projectFile, "utf8"));
    projects.push({
      slug: entry,
      path: projectFile,
      dir,
      data,
      body,
      tasks: loadTasks(dir, opts),
    });
  }
  return projects;
}

function loadTasks(projectDir: string, opts: LoadOptions): Task[] {
  const tasksDir = join(projectDir, "tasks");
  if (!isDir(tasksDir)) return [];
  const tasks = readTasksFromDir(tasksDir, false);
  if (opts.archived) {
    tasks.push(...readArchivedTasks(join(tasksDir, "archive"), tasks));
  }
  return sortTasks(tasks);
}

function readTasksFromDir(dir: string, archived: boolean): Task[] {
  if (!isDir(dir)) return [];
  const out: Task[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    if (entry === "archive") continue;
    const fullPath = join(dir, entry);
    if (entry.endsWith(".md") && isFile(fullPath)) {
      out.push(loadTaskFile(fullPath, entry.replace(/\.md$/, ""), archived));
    } else if (isDir(fullPath)) {
      const taskMd = join(fullPath, "task.md");
      if (!isFile(taskMd)) continue;
      const parent = loadTaskFile(taskMd, entry, archived);
      parent.dir = fullPath;
      parent.children = sortTasks(readChildTasks(fullPath, entry, archived));
      out.push(parent);
    }
  }
  return out;
}

function readChildTasks(parentDir: string, parentSlug: string, archived: boolean): Task[] {
  const out: Task[] = [];
  for (const f of readdirSync(parentDir)) {
    if (!f.endsWith(".md") || f === "task.md" || f.startsWith(".")) continue;
    const child = loadTaskFile(join(parentDir, f), f.replace(/\.md$/, ""), archived);
    if (child.data.parent !== parentSlug) continue;
    child.parent = parentSlug;
    out.push(child);
  }
  return out;
}

function readArchivedTasks(archiveDir: string, liveTasks: Task[]): Task[] {
  if (!isDir(archiveDir)) return [];
  const out: Task[] = [];
  for (const entry of readdirSync(archiveDir).sort()) {
    if (entry.startsWith(".")) continue;
    const fullPath = join(archiveDir, entry);
    if (entry.endsWith(".md") && isFile(fullPath)) {
      out.push(loadTaskFile(fullPath, entry.replace(/\.md$/, ""), true));
      continue;
    }
    if (!isDir(fullPath)) continue;
    const taskMd = join(fullPath, "task.md");
    if (isFile(taskMd)) {
      const parent = loadTaskFile(taskMd, entry, true);
      parent.dir = fullPath;
      parent.children = sortTasks(readChildTasks(fullPath, entry, true));
      out.push(parent);
    } else {
      const children = readChildTasks(fullPath, entry, true);
      const liveParent = liveTasks.find(t => t.slug === entry);
      if (liveParent) {
        liveParent.children = sortTasks([...(liveParent.children ?? []), ...children]);
      } else {
        out.push(...children);
      }
    }
  }
  return out;
}

function loadTaskFile(path: string, slug: string, archived: boolean): Task {
  const { data, body } = parse(readFileSync(path, "utf8"));
  return { slug, path, archived, data, body };
}

function sortTasks(tasks: Task[]): Task[] {
  return tasks.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function isParent(task: Task): boolean {
  return !!(task.children && task.children.length > 0);
}

export function flatTasks(tasks: Task[]): Task[] {
  const out: Task[] = [];
  for (const t of tasks) {
    out.push(t);
    if (t.children?.length) out.push(...t.children);
  }
  return out;
}

export function rollupStatus(task: Task): string {
  const declared = typeof task.data.status === "string" && task.data.status ? task.data.status : "?";
  if (!task.children?.length) return declared;
  const live = task.children.filter(c => !c.archived);
  if (live.length === 0) return declared;
  if (live.every(c => c.data.status === "done")) return "done";
  if (live.some(c => c.data.status === "in-progress")) return "in-progress";
  return declared;
}

export function archiveTask(task: Task): string {
  const status = String(task.data.status ?? "");
  if (status !== "done" && status !== "dropped") {
    throw new Error(`Only done or dropped tasks can be archived: ${task.slug}`);
  }
  if (task.archived) return task.path;
  if (isParent(task) && task.children!.some(c => !c.archived)) {
    throw new Error(`Cannot archive parent ${task.slug}: it has live children. Archive or close them first.`);
  }

  // Folder-form parent (with no live children): move the whole folder.
  if (task.dir) {
    const tasksDir = dirname(task.dir);
    const archiveDir = join(tasksDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const dest = join(archiveDir, task.slug);
    if (isDir(dest) || isFile(dest)) {
      throw new Error(`Archived task already exists: ${dest}`);
    }
    renameSync(task.dir, dest);
    return join(dest, "task.md");
  }

  // Child of a folder-form parent: move the single file to archive/<parent>/<child>.md.
  if (task.parent) {
    const parentDir = dirname(task.path);
    const tasksDir = dirname(parentDir);
    const archiveParentDir = join(tasksDir, "archive", task.parent);
    mkdirSync(archiveParentDir, { recursive: true });
    const dest = join(archiveParentDir, `${task.slug}.md`);
    if (isFile(dest)) throw new Error(`Archived task already exists: ${dest}`);
    renameSync(task.path, dest);
    return dest;
  }

  // File-form top-level task.
  const archiveDir = join(dirname(task.path), "archive");
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `${task.slug}.md`);
  if (isFile(archivePath)) throw new Error(`Archived task already exists: ${archivePath}`);
  renameSync(task.path, archivePath);
  return archivePath;
}

export function foldTask(task: Task): string {
  if (task.archived) throw new Error(`Cannot fold archived task: ${task.slug}`);
  if (task.parent) throw new Error(`Cannot fold a child task: ${task.slug}`);
  if (task.dir) return task.path;
  const tasksDir = dirname(task.path);
  const folderPath = join(tasksDir, task.slug);
  if (isDir(folderPath) || isFile(folderPath)) {
    throw new Error(`Cannot fold ${task.slug}: ${folderPath} already exists`);
  }
  mkdirSync(folderPath, { recursive: true });
  const newPath = join(folderPath, "task.md");
  renameSync(task.path, newPath);
  return newPath;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
