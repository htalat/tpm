import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_TEMPLATE, TASK_TEMPLATE } from "./defaults.ts";

function loadTemplate(root: string, kind: "project" | "task"): string {
  const path = join(root, ".tpm", "templates", `${kind}.md`);
  if (existsSync(path)) return readFileSync(path, "utf8");
  return kind === "project" ? PROJECT_TEMPLATE : TASK_TEMPLATE;
}

export interface NewProjectOpts {
  name?: string;
  repoRemote?: string;
  repoLocal?: string;
}

export function newProject(root: string, slug: string, opts: NewProjectOpts = {}): string {
  validateSlug(slug);
  const dir = join(root, "projects", slug);
  if (existsSync(dir)) throw new Error(`Project already exists: ${slug}`);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  mkdirSync(join(dir, "notes"), { recursive: true });

  const tmpl = loadTemplate(root, "project");
  const content = render(tmpl, {
    name: opts.name ?? humanize(slug),
    slug,
    date: today(),
    repo_remote: opts.repoRemote ?? "",
    repo_local: opts.repoLocal ? resolve(opts.repoLocal) : "",
  });
  const path = join(dir, "project.md");
  writeFileSync(path, content);
  return path;
}

export function newTask(root: string, projectSlug: string, taskSlug: string, title?: string): string {
  validateSlug(taskSlug);
  const projectDir = join(root, "projects", projectSlug);
  if (!existsSync(join(projectDir, "project.md"))) {
    throw new Error(`Unknown project: ${projectSlug}`);
  }
  const tasksDir = join(projectDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const existing = readdirSync(tasksDir).filter(f => f.endsWith(".md"));
  let max = 0;
  for (const f of existing) {
    const m = f.match(/^(\d{3,})-/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const next = String(max + 1).padStart(3, "0");
  const filename = `${next}-${taskSlug}.md`;
  const path = join(tasksDir, filename);
  if (existsSync(path)) throw new Error(`Task file exists: ${filename}`);

  const tmpl = loadTemplate(root, "task");
  const content = render(tmpl, {
    title: title ?? humanize(taskSlug),
    slug: taskSlug,
    project: projectSlug,
    date: today(),
  });
  writeFileSync(path, content);
  return path;
}

function render(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function validateSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}". Use lowercase letters, digits, and hyphens (no leading hyphen).`);
  }
}

function humanize(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
