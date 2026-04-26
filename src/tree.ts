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

export function loadProjects(root: string): Project[] {
  const projectsDir = join(root, "projects");
  if (!isDir(projectsDir)) return [];
  const projects: Project[] = [];
  for (const entry of readdirSync(projectsDir).sort()) {
    if (entry.startsWith(".")) continue;
    const dir = join(projectsDir, entry);
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
