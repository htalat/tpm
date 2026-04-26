import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  data: Record<string, unknown>;
  body: string;
}

const RESERVED = new Set(["reports", "node_modules"]);

export function loadProjects(root: string): Project[] {
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
      tasks: loadTasks(dir),
    });
  }
  return projects;
}

function loadTasks(projectDir: string): Task[] {
  const tasksDir = join(projectDir, "tasks");
  if (!isDir(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter(f => f.endsWith(".md") && !f.startsWith("."))
    .sort()
    .map(f => {
      const path = join(tasksDir, f);
      const { data, body } = parse(readFileSync(path, "utf8"));
      return { slug: f.replace(/\.md$/, ""), path, data, body };
    });
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
