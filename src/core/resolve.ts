import type { Project, Task } from "./tree.ts";
import { flatTasks } from "./tree.ts";

export interface TaskMatch {
  project: Project;
  task: Task;
}

export interface RepoTarget {
  project: Project;
  task?: Task;
}

export function findTask(projects: Project[], query: string): TaskMatch | null {
  const segments = query.split("/").filter(s => s.length);
  if (segments.length === 0) return null;

  if (segments.length === 1) {
    const matches: TaskMatch[] = [];
    for (const project of projects) {
      for (const task of flatTasks(project.tasks)) {
        if (matchTask(task.slug, segments[0])) matches.push({ project, task });
      }
    }
    return pickOne(query, matches);
  }

  if (segments.length === 2) {
    const [first, second] = segments;
    const project = projects.find(pr => pr.slug === first);
    if (project) {
      const matches = flatTasks(project.tasks)
        .filter(t => matchTask(t.slug, second))
        .map(t => ({ project, task: t }));
      return pickOne(query, matches);
    }
    const matches: TaskMatch[] = [];
    for (const p of projects) {
      const parent = p.tasks.find(t => matchTask(t.slug, first));
      if (!parent?.children?.length) continue;
      for (const c of parent.children) {
        if (matchTask(c.slug, second)) matches.push({ project: p, task: c });
      }
    }
    return pickOne(query, matches);
  }

  if (segments.length === 3) {
    const [pSlug, parentQ, childQ] = segments;
    const project = projects.find(pr => pr.slug === pSlug);
    if (!project) return null;
    const parent = project.tasks.find(t => matchTask(t.slug, parentQ));
    if (!parent?.children?.length) return null;
    const child = parent.children.find(c => matchTask(c.slug, childQ));
    return child ? { project, task: child } : null;
  }

  return null;
}

// Resolve every task in a project whose slug carries the given numeric id
// prefix (e.g. id 12 matches "012-foo" and "12-foo"). Returns all matches so the
// caller can distinguish "no such id" from an ambiguous id shared by a top-level
// task and a child (numbering is per-container, so ids aren't project-unique).
export function findTasksByNumericId(project: Project, id: number): TaskMatch[] {
  const matches: TaskMatch[] = [];
  for (const task of flatTasks(project.tasks)) {
    if (taskNumericId(task.slug) === id) matches.push({ project, task });
  }
  return matches;
}

function taskNumericId(slug: string): number | null {
  const m = slug.match(/^(\d+)-/);
  return m ? Number(m[1]) : null;
}

export function findRepoTarget(projects: Project[], query: string): RepoTarget | null {
  if (!query.includes("/")) {
    const project = projects.find(pr => pr.slug === query);
    if (project) return { project };
  }
  const t = findTask(projects, query);
  return t ? { project: t.project, task: t.task } : null;
}

function pickOne(query: string, matches: TaskMatch[]): TaskMatch | null {
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw ambiguous(query, matches);
  return null;
}

function matchTask(slug: string, query: string): boolean {
  return slug === query || slug.endsWith(`-${query}`) || slug.replace(/^\d+-/, "") === query;
}

function ambiguous(query: string, matches: TaskMatch[]): Error {
  const list = matches.map(m => `  ${qualify(m)}`).join("\n");
  return new Error(`Ambiguous task "${query}". Use a fully qualified path. Matches:\n${list}`);
}

function qualify(m: TaskMatch): string {
  if (m.task.parent) return `${m.project.slug}/${m.task.parent}/${m.task.slug}`;
  return `${m.project.slug}/${m.task.slug}`;
}
