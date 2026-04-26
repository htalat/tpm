import { loadProjects } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { findTask, findRepoTarget } from "./resolve.ts";

export interface Repo {
  remote: string | null;
  local: string | null;
}

export function resolveRepo(project: Project, task?: Task): Repo {
  const t = readRepo(task?.data.repo);
  const p = readRepo(project.data.repo);
  return {
    remote: t.remote ?? p.remote,
    local: t.local ?? p.local,
  };
}

function readRepo(v: unknown): Repo {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { remote: null, local: null };
  const o = v as Record<string, unknown>;
  return { remote: str(o.remote) ?? null, local: str(o.local) ?? null };
}

export function context(root: string, query: string): string {
  const projects = loadProjects(root, { archived: true });
  const match = findTask(projects, query);
  if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls\`.`);
  const { project, task } = match;
  const repo = resolveRepo(project, task);

  const lines: string[] = [];
  lines.push(`# Task briefing: ${str(task.data.title) ?? task.slug}`);
  lines.push("");
  lines.push(`- File: ${task.path}`);
  lines.push(`- Project: ${str(project.data.name) ?? project.slug} (${project.slug})`);
  if (repo.remote) lines.push(`- Repo: ${repo.remote}`);
  if (repo.local) lines.push(`- Local: ${repo.local}`);
  lines.push(`- Status: ${str(task.data.status) ?? "?"}  ·  Type: ${str(task.data.type) ?? "?"}`);
  if (Array.isArray(task.data.prs) && task.data.prs.length) {
    lines.push(`- PRs: ${task.data.prs.join(", ")}`);
  }
  if (str(task.data.created)) lines.push(`- Created: ${str(task.data.created)}`);

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Project context");
  lines.push("");
  lines.push(extractSection(project.body, "Goal") ?? project.body.trim() ?? "_(no project body)_");

  const projectContext = extractSection(project.body, "Context");
  if (projectContext) {
    lines.push("");
    lines.push("### Project background");
    lines.push("");
    lines.push(projectContext);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Task");
  lines.push("");
  lines.push(task.body.trim());

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Working agreement");
  if (repo.local) lines.push(`- Work happens in ${repo.local}. cd there before editing code.`);
  lines.push(`- Append progress to the "Log" section in ${task.path}.`);
  lines.push(`- When done, fill "Outcome", set status: done in the frontmatter, and stamp closed: <YYYY-MM-DD>.`);
  lines.push(`- If you open a PR, append its URL to the prs: list in the frontmatter.`);
  lines.push(`- Surface blockers explicitly rather than guessing.`);

  return lines.join("\n");
}

export function repoPath(root: string, query: string): string {
  const projects = loadProjects(root, { archived: true });
  const target = findRepoTarget(projects, query);
  if (!target) throw new Error(`No project or task matched "${query}". Try \`tpm ls\`.`);
  const repo = resolveRepo(target.project, target.task);
  if (!repo.local) {
    const where = target.task ? `${target.project.slug}/${target.task.slug}` : target.project.slug;
    throw new Error(`No local path set for ${where}. Set repo.local in ${target.task?.path ?? target.project.path}.`);
  }
  return repo.local;
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`(?:^|\\n)##\\s+${escapeRe(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const m = body.match(re);
  if (!m) return null;
  const content = m[1].trim();
  return content.length ? content : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}
