import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_TEMPLATE, TASK_TEMPLATE } from "./defaults.ts";
import { now } from "./time.ts";
import { loadProjects, foldTask } from "./tree.ts";
import type { Task } from "./tree.ts";
import { findTask } from "./resolve.ts";
import { parse, stringify } from "./frontmatter.ts";

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
  const dir = join(root, slug);
  if (existsSync(dir)) throw new Error(`Project already exists: ${slug}`);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  mkdirSync(join(dir, "notes"), { recursive: true });

  const tmpl = loadTemplate(root, "project");
  const content = render(tmpl, {
    name: opts.name ?? humanize(slug),
    slug,
    date: now(),
    repo_remote: opts.repoRemote ?? "",
    repo_local: opts.repoLocal ? resolve(opts.repoLocal) : "",
  });
  const path = join(dir, "project.md");
  writeFileSync(path, content);
  return path;
}

export interface NewTaskOpts {
  title?: string;
  parent?: string;
}

export function newTask(root: string, projectSlug: string, taskSlug: string, opts: NewTaskOpts = {}): string {
  validateSlug(taskSlug);
  const projectDir = join(root, projectSlug);
  if (!existsSync(join(projectDir, "project.md"))) {
    throw new Error(`Unknown project: ${projectSlug}`);
  }
  const tasksDir = join(projectDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  let containerDir = tasksDir;
  let archiveContainer = join(tasksDir, "archive");
  let parentSlug: string | null = null;

  if (opts.parent) {
    const parent = resolveParent(root, projectSlug, opts.parent);
    parentSlug = parent.slug;
    if (!parent.dir) foldTask(parent);
    containerDir = join(tasksDir, parentSlug);
    archiveContainer = join(tasksDir, "archive", parentSlug);
  }

  const existing = [
    ...taskFiles(containerDir).filter(f => f !== "task.md"),
    ...taskFiles(archiveContainer),
  ];
  let max = 0;
  for (const f of existing) {
    const m = f.match(/^(\d{3,})-/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const next = String(max + 1).padStart(3, "0");
  const filename = `${next}-${taskSlug}.md`;
  const path = join(containerDir, filename);
  if (existsSync(path)) throw new Error(`Task file exists: ${filename}`);

  const tmpl = loadTemplate(root, "task");
  const rendered = render(tmpl, {
    title: opts.title ?? humanize(taskSlug),
    slug: taskSlug,
    project: projectSlug,
    date: now(),
  });
  const content = parentSlug ? injectParent(rendered, parentSlug) : rendered;
  writeFileSync(path, content);
  return path;
}

function resolveParent(root: string, projectSlug: string, parentQuery: string): Task {
  const projects = loadProjects(root);
  const project = projects.find(p => p.slug === projectSlug);
  if (!project) throw new Error(`Unknown project: ${projectSlug}`);
  const match = findTask([project], parentQuery);
  if (!match) throw new Error(`No task matched --parent "${parentQuery}" in project ${projectSlug}.`);
  const parent = match.task;
  if (parent.parent) {
    throw new Error(`Cannot nest under "${parent.slug}" — it is itself a child. Only one level of nesting is supported.`);
  }
  if (parent.archived) throw new Error(`Cannot add child to archived parent: ${parent.slug}`);
  return parent;
}

function injectParent(rendered: string, parentSlug: string): string {
  const { data, body } = parse(rendered);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v;
    if (k === "project" && !("parent" in out)) out.parent = parentSlug;
  }
  if (!("parent" in out)) out.parent = parentSlug;
  return stringify(out, body);
}

function taskFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")) : [];
}

function render(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function validateSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}". Use lowercase letters, digits, and hyphens (no leading hyphen).`);
  }
}

function humanize(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
