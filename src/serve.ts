import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadProjects, flatTasks, isParent, rollupStatus } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { findRoot } from "./root.ts";
import { findTask } from "./resolve.ts";
import { resolveRepo } from "./context.ts";
import { now } from "./time.ts";
import { inboxItems } from "./queue.ts";
import { BASE_CSS, SERVE_CSS } from "./css.ts";
import { renderMarkdown } from "./markdown.ts";

export interface ServeOpts {
  host?: string;
  port?: number;
}

// `tpm serve`: localhost dashboard for the queues. v0 is read-only — the CLI
// is the writer. Auto-refresh via meta tag (no JS framework). Personal tool,
// no auth — never bind to anything but loopback unless the user explicitly
// passes --host.
export async function runServe(opts: ServeOpts = {}): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7777;

  const server = createServer((req, res) => handleRequest(req, res));
  server.listen(port, host, () => {
    const where = host === "127.0.0.1" ? "localhost" : host;
    console.error(`tpm serve: http://${where}:${port}/  (Ctrl-C to stop)`);
  });
  server.on("error", (err) => {
    console.error(`tpm serve: ${(err as Error).message}`);
    process.exit(1);
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const root = findRoot();
  const projects = loadProjects(root);
  const result = route(url.pathname, url.searchParams, projects);
  res.writeHead(result.status, { "content-type": result.contentType });
  res.end(result.body);
}

export interface RouteResult {
  status: number;
  contentType: string;
  body: string;
}

// Pure dispatch — returns the response shape, doesn't touch the network.
// Tests exercise this directly with mocked projects.
export function route(pathname: string, params: URLSearchParams, projects: Project[]): RouteResult {
  if (pathname === "/" || pathname === "") {
    return ok("text/html; charset=utf-8", renderIndex(projects, params.get("project")));
  }
  if (pathname === "/api/refresh") {
    return ok("application/json", renderRefresh(projects));
  }
  const projectMatch = pathname.match(/^\/p\/([^/]+)\/?$/);
  if (projectMatch) {
    const slug = decodeURIComponent(projectMatch[1]);
    const project = projects.find(p => p.slug === slug);
    if (!project) return notFound(`No project: ${slug}`);
    return ok("text/html; charset=utf-8", renderProject(project));
  }
  const taskMatch = pathname.match(/^\/t\/(.+?)\/?$/);
  if (taskMatch) {
    const query = decodeURIComponent(taskMatch[1]);
    const match = findTask(projects, query);
    if (!match) return notFound(`No task: ${query}`);
    return ok("text/html; charset=utf-8", renderTask(match.project, match.task));
  }
  return notFound(pathname);
}

function ok(contentType: string, body: string): RouteResult {
  return { status: 200, contentType, body };
}
function notFound(message: string): RouteResult {
  const body = layout("Not found", `<h1>404</h1><p>${esc(message)}</p><p><a href="/">Home</a></p>`);
  return { status: 404, contentType: "text/html; charset=utf-8", body };
}

// ---- pages ----------------------------------------------------------------

function renderIndex(projects: Project[], projectFilter: string | null): string {
  const filtered = projectFilter ? projects.filter(p => p.slug === projectFilter) : projects;

  // Inbox = needs-review > blocked > open across the filtered set.
  const inbox = inboxItems(filtered);
  // Agent queue = next-eligible (needs-feedback > ready). Show all candidates,
  // not just the head, so the page is a useful overview.
  const agentItems: Array<{ project: Project; task: Task; status: string }> = [];
  for (const p of filtered) {
    for (const t of flatTasks(p.tasks)) {
      if (t.archived || isParent(t)) continue;
      const s = String(t.data.status ?? "");
      if (s === "ready" || s === "needs-feedback") agentItems.push({ project: p, task: t, status: s });
    }
  }
  agentItems.sort((a, b) => {
    const dp = (a.status === "needs-feedback" ? 0 : 1) - (b.status === "needs-feedback" ? 0 : 1);
    if (dp !== 0) return dp;
    return String(a.task.data.created ?? "").localeCompare(String(b.task.data.created ?? ""));
  });
  const inFlight: Array<{ project: Project; task: Task }> = [];
  for (const p of filtered) {
    for (const t of flatTasks(p.tasks)) {
      if (t.archived || isParent(t)) continue;
      if (t.data.status === "in-progress") inFlight.push({ project: p, task: t });
    }
  }

  const filterChip = projectFilter
    ? `<p class="meta">Filtered by project <code>${esc(projectFilter)}</code> · <a href="/">show all</a></p>`
    : "";

  const body = `
<header>
  <h1>tpm</h1>
  <p class="meta">${esc(now())}  ·  ${projects.length} project${projects.length === 1 ? "" : "s"}</p>
  ${filterChip}
</header>
<section class="queue">
  <h2>Your inbox <span class="meta">(${inbox.length})</span></h2>
  ${inbox.length === 0 ? `<p class="queue-empty">Inbox empty.</p>` : inbox.map(it => taskRow(it.project, it.task, it.status)).join("")}
</section>
<section class="queue">
  <h2>Agent queue <span class="meta">(${agentItems.length})</span></h2>
  ${agentItems.length === 0 ? `<p class="queue-empty">Nothing ready or needing feedback.</p>` : agentItems.map(it => taskRow(it.project, it.task, it.status)).join("")}
</section>
<section class="queue">
  <h2>In flight <span class="meta">(${inFlight.length})</span></h2>
  ${inFlight.length === 0 ? `<p class="queue-empty">No in-progress tasks.</p>` : inFlight.map(it => taskRow(it.project, it.task, "in-progress")).join("")}
</section>
`;
  return layout("tpm", body, { autoRefresh: 30 });
}

function renderProject(project: Project): string {
  const repo = resolveRepo(project);
  const liveTasks = flatTasks(project.tasks).filter(t => !t.archived && !isParent(t));
  const byStatus = new Map<string, Task[]>();
  for (const t of liveTasks) {
    const s = String(t.data.status ?? "?");
    const arr = byStatus.get(s) ?? [];
    arr.push(t);
    byStatus.set(s, arr);
  }
  const order = ["needs-review", "needs-feedback", "in-progress", "blocked", "ready", "open", "done", "dropped"];
  const sectionsHtml = order
    .filter(s => byStatus.has(s))
    .map(s => {
      const rows = byStatus.get(s)!.map(t => taskRow(project, t, s)).join("");
      return `<section class="queue"><h2>${esc(s)} <span class="meta">(${byStatus.get(s)!.length})</span></h2>${rows}</section>`;
    })
    .join("");

  const repoLink = repo.remote ? `<a href="${escAttr(repo.remote)}">${esc(repo.remote)}</a>` : "<em>no remote</em>";
  const projectName = strOr(project.data.name, project.slug);
  const status = strOr(project.data.status, "?");

  const body = `
<nav class="crumbs"><a href="/">tpm</a><a href="/p/${esc(project.slug)}">${esc(project.slug)}</a></nav>
<header>
  <h1>${esc(projectName)} <span class="badge s-${cls(status)}">${esc(status)}</span></h1>
  <p class="meta"><code>${esc(project.slug)}</code>  ·  ${repoLink}  ·  ${liveTasks.length} task${liveTasks.length === 1 ? "" : "s"}</p>
</header>
<div class="body">${renderMarkdown(extractGoalAndContext(project.body))}</div>
${sectionsHtml || `<p class="queue-empty">No active tasks.</p>`}
`;
  return layout(`tpm · ${projectName}`, body);
}

function renderTask(project: Project, task: Task): string {
  const repo = resolveRepo(project, task);
  const status = rollupStatus(task);
  const title = strOr(task.data.title, task.slug);
  const prs = (Array.isArray(task.data.prs) ? task.data.prs : []).map(String);
  const prList = prs.length
    ? `<ul>${prs.map(u => `<li><a href="${escAttr(u)}">${esc(u)}</a></li>`).join("")}</ul>`
    : "<em>none</em>";
  const childrenList = task.children?.length
    ? `<ul>${task.children.map(c => `<li><a href="/t/${esc(project.slug)}/${esc(task.slug)}/${esc(c.slug)}">${esc(strOr(c.data.title, c.slug))}</a> <span class="badge s-${cls(rollupStatus(c))}">${esc(rollupStatus(c))}</span></li>`).join("")}</ul>`
    : "";

  const repoBlock = repo.remote ? `<dt>Repo</dt><dd><a href="${escAttr(repo.remote)}">${esc(repo.remote)}</a></dd>` : "";
  const localBlock = repo.local ? `<dt>Local</dt><dd><code>${esc(repo.local)}</code></dd>` : "";
  const parentBlock = task.parent
    ? `<dt>Parent</dt><dd><a href="/t/${esc(project.slug)}/${esc(task.parent)}">${esc(task.parent)}</a></dd>`
    : "";
  const childrenBlock = childrenList ? `<dt>Children</dt><dd>${childrenList}</dd>` : "";

  const crumbsTrail = task.parent
    ? `<a href="/p/${esc(project.slug)}">${esc(project.slug)}</a><a href="/t/${esc(project.slug)}/${esc(task.parent)}">${esc(task.parent)}</a><a href="/t/${esc(project.slug)}/${esc(task.parent)}/${esc(task.slug)}">${esc(task.slug)}</a>`
    : `<a href="/p/${esc(project.slug)}">${esc(project.slug)}</a><a href="/t/${esc(project.slug)}/${esc(task.slug)}">${esc(task.slug)}</a>`;

  const body = `
<nav class="crumbs"><a href="/">tpm</a>${crumbsTrail}</nav>
<header>
  <h1>${esc(title)} <span class="badge s-${cls(status)}">${esc(status)}</span></h1>
  <p class="meta"><code>${esc(task.slug)}</code>  ·  type: ${esc(strOr(task.data.type, "?"))}  ·  project: <a href="/p/${esc(project.slug)}">${esc(project.slug)}</a></p>
</header>
<div class="layout">
  <aside class="sidebar">
    <dl>
      <dt>Status</dt><dd><span class="badge s-${cls(status)}">${esc(status)}</span></dd>
      <dt>Type</dt><dd>${esc(strOr(task.data.type, "?"))}</dd>
      ${repoBlock}
      ${localBlock}
      <dt>Created</dt><dd>${esc(strOr(task.data.created, "?"))}</dd>
      ${strOr(task.data.closed, "") ? `<dt>Closed</dt><dd>${esc(strOr(task.data.closed, ""))}</dd>` : ""}
      <dt>PRs</dt><dd>${prList}</dd>
      ${parentBlock}
      ${childrenBlock}
    </dl>
  </aside>
  <main class="body">${renderMarkdown(task.body)}</main>
</div>
`;
  return layout(`tpm · ${title}`, body);
}

function renderRefresh(projects: Project[]): string {
  const counts: Record<string, number> = {};
  for (const p of projects) {
    for (const t of flatTasks(p.tasks)) {
      if (t.archived || isParent(t)) continue;
      const s = String(t.data.status ?? "unknown");
      counts[s] = (counts[s] ?? 0) + 1;
    }
  }
  return JSON.stringify({ generated: now(), counts });
}

// ---- helpers --------------------------------------------------------------

function taskRow(project: Project, task: Task, status: string): string {
  const slug = task.parent
    ? `${project.slug}/${task.parent}/${task.slug}`
    : `${project.slug}/${task.slug}`;
  const href = `/t/${slug.split("/").map(esc).join("/")}`;
  const title = strOr(task.data.title, task.slug);
  const created = strOr(task.data.created, "");
  return `<div class="task-row">
    <span class="badge s-${cls(status)}">${esc(status)}</span>
    <a class="title" href="${href}">${esc(title)}</a>
    <span class="slug">${esc(slug)}</span>
    <span class="when">${esc(created)}</span>
  </div>`;
}

function extractGoalAndContext(body: string): string {
  const goal = extractSection(body, "Goal");
  const ctx = extractSection(body, "Context");
  const parts: string[] = [];
  if (goal) parts.push(`## Goal\n\n${goal}`);
  if (ctx) parts.push(`## Context\n\n${ctx}`);
  return parts.join("\n\n");
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`(?:^|\\n)##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const m = body.match(re);
  if (!m) return null;
  const content = m[1].trim().replace(/^<!--[\s\S]*?-->\s*/g, "").trim();
  return content.length ? content : null;
}

function layout(title: string, body: string, opts: { autoRefresh?: number } = {}): string {
  const refresh = opts.autoRefresh
    ? `<meta http-equiv="refresh" content="${opts.autoRefresh}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
${refresh}
<style>${BASE_CSS}${SERVE_CSS}</style>
</head>
<body>${body}</body>
</html>`;
}

function cls(s: unknown): string {
  return String(s ?? "unknown").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}
function strOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length ? v : fallback;
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
function escAttr(s: unknown): string {
  return esc(s);
}
