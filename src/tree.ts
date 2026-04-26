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
  if (opts.archived) tasks.push(...readTasksFromDir(join(tasksDir, "archive"), true));
  return tasks.sort((a, b) => a.slug.localeCompare(b.slug));
}

function readTasksFromDir(dir: string, archived: boolean): Task[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".md") && !f.startsWith("."))
    .map(f => {
      const path = join(dir, f);
      const { data, body } = parse(readFileSync(path, "utf8"));
      return { slug: f.replace(/\.md$/, ""), path, archived, data, body };
    });
}

export function archiveTask(task: Task): string {
  const status = String(task.data.status ?? "");
  if (status !== "done" && status !== "dropped") {
    throw new Error(`Only done or dropped tasks can be archived: ${task.slug}`);
  }
  if (task.archived) return task.path;
  const archiveDir = join(dirname(task.path), "archive");
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `${task.slug}.md`);
  if (isFile(archivePath)) throw new Error(`Archived task already exists: ${archivePath}`);
  renameSync(task.path, archivePath);
  return archivePath;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
