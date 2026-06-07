import type { Project, Task } from "../core/tree.ts";

// Route path for a task's detail page in `tpm serve`: `/t/<project>/<slug>` (or
// `/t/<project>/<parent>/<slug>` for a child). This is the single source for the
// route shape — `serve.ts` renders the page at it and the orchestrator builds
// notification deep links from it. Segments are URL-encoded; for the `[a-z0-9-]`
// slugs tpm generates that's a no-op, but it keeps the link correct if a slug
// ever carries a reserved character.
export function taskPath(project: Project, task: Task): string {
  const segs = task.parent
    ? [project.slug, task.parent, task.slug]
    : [project.slug, task.slug];
  return "/t/" + segs.map(encodeURIComponent).join("/");
}

// Full clickable deep link: `<baseUrl>/t/<project>/<slug>`. The base URL comes
// from `serveBaseUrl(cfg)` (config.ts); a trailing slash on it is dropped so we
// don't emit `//t/...`.
export function taskDeepLink(baseUrl: string, project: Project, task: Task): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return base + taskPath(project, task);
}
