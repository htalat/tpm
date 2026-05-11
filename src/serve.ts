import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

// Whitelisted POST action segments. The CLI verbs they map to are built in
// `buildCliArgs`. Kept narrow so a stray POST can't shell out to any tpm verb.
const MUTATION_ACTIONS = new Set([
  "ready", "block", "reopen", "complete", "log", "pr", "status", "allow-orchestrator",
]);

const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));

// `tpm serve`: localhost dashboard for the queues. POST endpoints shell out to
// the CLI so the web layer never writes files directly (one writer contract,
// lock-aware, no parallel implementation). Mutations only register when bound
// to loopback — see `mutationsEnabled` below.
export async function runServe(opts: ServeOpts = {}): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7777;
  const mutationsEnabled = isLoopback(host);

  const server = createServer((req, res) => handleRequest(req, res, { host, mutationsEnabled }));
  server.listen(port, host, () => {
    const where = host === "127.0.0.1" ? "localhost" : host;
    console.error(`tpm serve: http://${where}:${port}/  (Ctrl-C to stop)`);
    if (!mutationsEnabled) {
      console.error(`tpm serve: WARNING — host ${host} is not loopback; mutation endpoints are DISABLED.`);
    }
  });
  server.on("error", (err) => {
    console.error(`tpm serve: ${(err as Error).message}`);
    process.exit(1);
  });
}

interface ServeContext {
  host: string;
  mutationsEnabled: boolean;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: ServeContext): Promise<void> {
  if (req.method === "POST") {
    if (!ctx.mutationsEnabled) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Mutations disabled: server is not bound to loopback. Restart with --host 127.0.0.1.");
      return;
    }
    if (!isSameOrigin(req.headers)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Refused: same-origin check failed (missing or mismatched Origin/Referer).");
      return;
    }
    const raw = await readBody(req);
    const body = new URLSearchParams(raw);
    const url = new URL(req.url ?? "/", "http://localhost");
    const result = routeMutation(url.pathname, body, runCli);
    if (result.status === 303 && result.location) {
      res.writeHead(303, { location: result.location });
      res.end();
      return;
    }
    res.writeHead(result.status, { "content-type": "text/plain" });
    res.end(result.body ?? "");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const root = findRoot();
  // Always load archived so `/t/<project>/<slug>` resolves an archived task and
  // `/p/<slug>?archived=1` has them available. Filtering happens per-route.
  const projects = loadProjects(root, { archived: true });
  const flash = url.searchParams.get("flash") ?? undefined;
  const result = route(url.pathname, url.searchParams, projects, {
    flash,
    mutationsEnabled: ctx.mutationsEnabled,
  });
  res.writeHead(result.status, { "content-type": result.contentType });
  res.end(result.body);
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Reject cross-origin POSTs. On a loopback-only server with no auth this is
// the only thing keeping a malicious page in another browser tab from issuing
// mutation requests against the tracker.
export function isSameOrigin(headers: { origin?: string | string[]; referer?: string | string[]; host?: string | string[] }): boolean {
  const expectedHost = stringOf(headers.host);
  if (!expectedHost) return false;
  const claim = stringOf(headers.origin) || stringOf(headers.referer);
  if (!claim) return false;
  try {
    const u = new URL(claim);
    return u.host === expectedHost;
  } catch {
    return false;
  }
}

function stringOf(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length) return v[0];
  return "";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 64 * 1024; // 64KB cap; a free-text outcome shouldn't need more.
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface RouteResult {
  status: number;
  contentType: string;
  body: string;
}

export interface RouteOpts {
  flash?: string;
  mutationsEnabled?: boolean;
}

// Pure dispatch — returns the response shape, doesn't touch the network.
// Tests exercise this directly with mocked projects.
export function route(pathname: string, params: URLSearchParams, projects: Project[], opts: RouteOpts = {}): RouteResult {
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
    const showArchived = params.get("archived") === "1";
    return ok("text/html; charset=utf-8", renderProject(project, projects, showArchived));
  }
  const taskMatch = pathname.match(/^\/t\/(.+?)\/?$/);
  if (taskMatch) {
    const query = decodeURIComponent(taskMatch[1]);
    const match = findTask(projects, query);
    if (!match) return notFound(`No task: ${query}`);
    return ok("text/html; charset=utf-8", renderTask(match.project, match.task, opts));
  }
  return notFound(pathname);
}

export interface MutationResult {
  status: number;
  location?: string;
  body?: string;
}

export type CliRunner = (args: string[]) => { ok: boolean; stdout: string; stderr: string };

// Pure dispatch for POST mutations. Tests pass a stub runner; production passes
// the real `runCli` that shells out to the local tpm binary.
export function routeMutation(pathname: string, body: URLSearchParams, runner: CliRunner): MutationResult {
  // Match /t/<slugPath>/<action>. slugPath is greedy so it captures any
  // intermediate parent segments; action is the last path segment.
  const m = pathname.match(/^\/t\/(.+)\/([a-z][a-z0-9-]*)\/?$/);
  if (!m) return { status: 404, body: "Not Found" };
  const slugPath = m[1];
  const action = m[2];
  if (!MUTATION_ACTIONS.has(action)) return { status: 404, body: `Unknown action: ${action}` };

  const args = buildCliArgs(slugPath, action, body);
  if (!args) {
    return flashRedirect(slugPath, `bad request: missing required field for ${action}`);
  }
  const result = runner(args);
  const flash = result.ok
    ? (result.stdout || `${action}: ok`)
    : (result.stderr || `${action}: failed`);
  return flashRedirect(slugPath, flash);
}

function flashRedirect(slugPath: string, flash: string): MutationResult {
  const segs = slugPath.split("/").map(encodeURIComponent).join("/");
  return {
    status: 303,
    location: `/t/${segs}?flash=${encodeURIComponent(flash)}`,
  };
}

function buildCliArgs(slug: string, action: string, body: URLSearchParams): string[] | null {
  switch (action) {
    case "ready":  return ["ready", slug];
    case "reopen": return ["reopen", slug];
    case "block": {
      const reason = body.get("reason")?.trim();
      if (!reason) return null;
      return ["block", slug, reason];
    }
    case "complete": {
      const outcome = body.get("outcome")?.trim();
      const args = ["complete", slug];
      if (outcome) args.push("--outcome", outcome);
      return args;
    }
    case "log": {
      const message = body.get("message")?.trim();
      if (!message) return null;
      return ["log", slug, message];
    }
    case "pr": {
      const url = body.get("url")?.trim();
      if (!url) return null;
      return ["pr", slug, url];
    }
    case "status": {
      const newStatus = body.get("status")?.trim();
      if (!newStatus) return null;
      return ["status", slug, newStatus];
    }
    case "allow-orchestrator": {
      const allow = body.get("allow");
      if (allow === "true") return ["allow", slug];
      if (allow === "false") return ["disallow", slug];
      return null;
    }
    default: return null;
  }
}

function runCli(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  // Re-invoke the same node binary that's hosting this server, forwarding
  // execArgv so flags like --experimental-strip-types propagate to the child.
  try {
    const stdout = execFileSync(process.execPath, [...process.execArgv, CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = err.stderr ? String(err.stderr).trim() : (e instanceof Error ? e.message : String(e));
    const stdout = err.stdout ? String(err.stdout).trim() : "";
    return { ok: false, stdout, stderr };
  }
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
  // Agent queue = next-eligible (needs-feedback > needs-close > ready). Show
  // all candidates, not just the head, so the page is a useful overview.
  const agentItems: Array<{ project: Project; task: Task; status: string }> = [];
  const agentStatuses: Record<string, number> = {
    "needs-feedback": 0,
    "needs-close": 1,
    "ready": 2,
  };
  for (const p of filtered) {
    for (const t of flatTasks(p.tasks)) {
      if (t.archived || isParent(t)) continue;
      const s = String(t.data.status ?? "");
      if (s in agentStatuses) agentItems.push({ project: p, task: t, status: s });
    }
  }
  agentItems.sort((a, b) => {
    const dp = agentStatuses[a.status] - agentStatuses[b.status];
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
${projectChips(projects, null)}
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
  ${agentItems.length === 0 ? `<p class="queue-empty">Nothing ready, needing feedback, or awaiting close.</p>` : agentItems.map(it => taskRow(it.project, it.task, it.status)).join("")}
</section>
<section class="queue">
  <h2>In flight <span class="meta">(${inFlight.length})</span></h2>
  ${inFlight.length === 0 ? `<p class="queue-empty">No in-progress tasks.</p>` : inFlight.map(it => taskRow(it.project, it.task, "in-progress")).join("")}
</section>
`;
  return layout("tpm", body, { autoRefresh: 30 });
}

function renderProject(project: Project, allProjects: Project[], showArchived: boolean): string {
  const repo = resolveRepo(project);
  const tasks = flatTasks(project.tasks).filter(t => !isParent(t) && (showArchived || !t.archived));
  const byStatus = new Map<string, Task[]>();
  for (const t of tasks) {
    const s = String(t.data.status ?? "?");
    const arr = byStatus.get(s) ?? [];
    arr.push(t);
    byStatus.set(s, arr);
  }
  // Live queues first, archived terminal states last.
  const order = ["needs-review", "needs-feedback", "needs-close", "in-progress", "blocked", "ready", "open", "done", "dropped"];
  const sectionsHtml = order
    .filter(s => byStatus.has(s))
    .map(s => {
      const group = byStatus.get(s)!.slice();
      // Archived rows sort by `closed:` desc; live rows keep slug order from the loader.
      if (s === "done" || s === "dropped") {
        group.sort((a, b) => String(b.data.closed ?? "").localeCompare(String(a.data.closed ?? "")));
      }
      const rows = group.map(t => taskRow(project, t, s)).join("");
      return `<section class="queue"><h2>${esc(s)} <span class="meta">(${group.length})</span></h2>${rows}</section>`;
    })
    .join("");

  const repoLink = repo.remote ? `<a href="${escAttr(repo.remote)}">${esc(repo.remote)}</a>` : "<em>no remote</em>";
  const projectName = strOr(project.data.name, project.slug);
  const status = strOr(project.data.status, "?");
  const host = strOr(project.data.host, "");
  const tagsField = project.data.tags;
  const tags = Array.isArray(tagsField) ? tagsField.map(String) : [];
  const created = strOr(project.data.created, "");

  const toggleHref = showArchived ? `/p/${esc(project.slug)}` : `/p/${esc(project.slug)}?archived=1`;
  const toggleLabel = showArchived ? "Hide archived" : "Show archived";

  const tagsBlock = tags.length
    ? `<dt>Tags</dt><dd>${tags.map(t => `<code>${esc(t)}</code>`).join(" ")}</dd>`
    : "";
  const hostBlock = host ? `<dt>Host</dt><dd>${esc(host)}</dd>` : "";
  const createdBlock = created ? `<dt>Created</dt><dd>${esc(created)}</dd>` : "";

  const body = `
${projectChips(allProjects, project.slug)}
<nav class="crumbs"><a href="/">tpm</a><a href="/p/${esc(project.slug)}">${esc(project.slug)}</a></nav>
<header>
  <h1>${esc(projectName)} <span class="badge s-${cls(status)}">${esc(status)}</span></h1>
  <p class="meta"><code>${esc(project.slug)}</code>  ·  ${repoLink}  ·  ${tasks.length} task${tasks.length === 1 ? "" : "s"}${showArchived ? " (incl. archived)" : ""}</p>
  <p class="archive-toggle"><a href="${toggleHref}">${showArchived ? "[x]" : "[ ]"} ${toggleLabel}</a></p>
</header>
<div class="layout">
  <aside class="sidebar">
    <dl>
      <dt>Status</dt><dd><span class="badge s-${cls(status)}">${esc(status)}</span></dd>
      <dt>Repo</dt><dd>${repoLink}</dd>
      ${hostBlock}
      ${tagsBlock}
      ${createdBlock}
    </dl>
  </aside>
  <main>
    <div class="body">${renderMarkdown(extractProjectBody(project.body))}</div>
    ${sectionsHtml || `<p class="queue-empty">No active tasks.</p>`}
  </main>
</div>
`;
  return layout(`tpm · ${projectName}`, body);
}

function renderTask(project: Project, task: Task, opts: RouteOpts = {}): string {
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
  const allowField = task.data.allow_orchestrator === true ? "true" : "false";
  const allowBlock = isParent(task)
    ? ""
    : `<dt>Autonomous</dt><dd>${esc(allowField)}</dd>`;

  const crumbsTrail = task.parent
    ? `<a href="/p/${esc(project.slug)}">${esc(project.slug)}</a><a href="/t/${esc(project.slug)}/${esc(task.parent)}">${esc(task.parent)}</a><a href="/t/${esc(project.slug)}/${esc(task.parent)}/${esc(task.slug)}">${esc(task.slug)}</a>`
    : `<a href="/p/${esc(project.slug)}">${esc(project.slug)}</a><a href="/t/${esc(project.slug)}/${esc(task.slug)}">${esc(task.slug)}</a>`;

  const flashBanner = opts.flash
    ? `<div class="flash">${esc(opts.flash)} <a class="flash-dismiss" href="${esc(taskHref(project, task))}">dismiss</a></div>`
    : "";

  const actionsSection = renderActions(project, task, status, opts);

  const body = `
<nav class="crumbs"><a href="/">tpm</a>${crumbsTrail}</nav>
${flashBanner}
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
      ${allowBlock}
    </dl>
  </aside>
  <main class="body">${renderMarkdown(task.body)}</main>
</div>
${actionsSection}
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

// ---- task actions UI ------------------------------------------------------

function renderActions(project: Project, task: Task, status: string, opts: RouteOpts): string {
  if (opts.mutationsEnabled === false) {
    return `<section class="task-actions disabled"><h2>Actions</h2><p class="meta">Mutations disabled (server not bound to loopback). Use the CLI instead.</p></section>`;
  }
  if (task.archived) return ""; // archived: not mutable
  if (isParent(task)) return ""; // containers: not actionable
  if (status === "done" || status === "dropped") return ""; // terminal: view-only

  const href = taskHref(project, task);
  const allowOn = task.data.allow_orchestrator === true;
  const forms: string[] = [];

  // Status -> set of action keys.
  switch (status) {
    case "open":
      forms.push(simpleForm(href, "ready", "Promote to ready"));
      forms.push(blockForm(href));
      forms.push(dropForm(href));
      break;
    case "ready":
      forms.push(blockForm(href));
      forms.push(simpleForm(href, "reopen", "Move back to open"));
      forms.push(dropForm(href));
      forms.push(allowForm(href, allowOn));
      break;
    case "in-progress":
      forms.push(blockForm(href));
      forms.push(completeForm(href));
      forms.push(logForm(href));
      forms.push(prForm(href));
      forms.push(allowForm(href, allowOn));
      break;
    case "needs-feedback":
      forms.push(logForm(href));
      forms.push(completeForm(href));
      forms.push(blockForm(href));
      break;
    case "needs-close":
      // Merged-PR sweep: the dominant action is closing out. Keep log/block
      // as escape hatches if the user needs to annotate or pause.
      forms.push(completeForm(href));
      forms.push(logForm(href));
      forms.push(blockForm(href));
      break;
    case "needs-review":
      forms.push(logForm(href));
      forms.push(blockForm(href));
      forms.push(statusForm(href, "ready", "Reopen for agent (→ ready)"));
      break;
    case "blocked":
      forms.push(simpleForm(href, "reopen", "Reopen (→ open)"));
      break;
    default:
      // Unknown status: render a fallback log so the user can at least annotate.
      forms.push(logForm(href));
  }

  return `<section class="task-actions"><h2>Actions</h2>${forms.join("")}</section>`;
}

function taskHref(project: Project, task: Task): string {
  const slug = task.parent
    ? `${project.slug}/${task.parent}/${task.slug}`
    : `${project.slug}/${task.slug}`;
  return `/t/${slug.split("/").map(esc).join("/")}`;
}

function simpleForm(href: string, action: string, label: string): string {
  return `<form method="POST" action="${href}/${action}" class="action-form">
    <button type="submit">${esc(label)}</button>
  </form>`;
}

function blockForm(href: string): string {
  return `<form method="POST" action="${href}/block" class="action-form">
    <label>Block reason
      <textarea name="reason" rows="2" required placeholder="why is this blocked?"></textarea>
    </label>
    <button type="submit">Block</button>
  </form>`;
}

function dropForm(href: string): string {
  return `<form method="POST" action="${href}/status" class="action-form">
    <input type="hidden" name="status" value="dropped">
    <button type="submit">Drop</button>
  </form>`;
}

function completeForm(href: string): string {
  return `<form method="POST" action="${href}/complete" class="action-form">
    <label>Outcome (optional — fills <code>## Outcome</code>)
      <textarea name="outcome" rows="3" placeholder="what shipped, what changed"></textarea>
    </label>
    <button type="submit">Complete</button>
  </form>`;
}

function logForm(href: string): string {
  return `<form method="POST" action="${href}/log" class="action-form">
    <label>Log entry
      <textarea name="message" rows="2" required placeholder="what changed"></textarea>
    </label>
    <button type="submit">Add log</button>
  </form>`;
}

function prForm(href: string): string {
  return `<form method="POST" action="${href}/pr" class="action-form">
    <label>PR URL
      <input type="url" name="url" required placeholder="https://github.com/...">
    </label>
    <button type="submit">Link PR</button>
  </form>`;
}

function statusForm(href: string, value: string, label: string): string {
  return `<form method="POST" action="${href}/status" class="action-form">
    <input type="hidden" name="status" value="${escAttr(value)}">
    <button type="submit">${esc(label)}</button>
  </form>`;
}

function allowForm(href: string, currentlyOn: boolean): string {
  const next = currentlyOn ? "false" : "true";
  const label = currentlyOn ? "Disable autonomous (allow_orchestrator: false)" : "Enable autonomous (allow_orchestrator: true)";
  return `<form method="POST" action="${href}/allow-orchestrator" class="action-form">
    <input type="hidden" name="allow" value="${next}">
    <button type="submit">${esc(label)}</button>
  </form>`;
}

// ---- helpers --------------------------------------------------------------

function taskRow(project: Project, task: Task, status: string): string {
  const slug = task.parent
    ? `${project.slug}/${task.parent}/${task.slug}`
    : `${project.slug}/${task.slug}`;
  const href = `/t/${slug.split("/").map(esc).join("/")}`;
  const title = strOr(task.data.title, task.slug);
  const when = task.archived
    ? strOr(task.data.closed, strOr(task.data.created, ""))
    : strOr(task.data.created, "");
  const classes = ["task-row"];
  if (task.parent) classes.push("child");
  if (task.archived) classes.push("archived");
  const archivedTag = task.archived ? `<span class="archived-tag">archived</span>` : "";
  return `<div class="${classes.join(" ")}">
    <span class="badge s-${cls(status)}${task.archived ? " s-archived" : ""}">${esc(status)}</span>
    <a class="title" href="${href}">${esc(title)}</a>
    <span class="slug">${esc(slug)}</span>
    ${archivedTag}
    <span class="when">${esc(when)}</span>
  </div>`;
}

// Inline list of project links shown above the page header. The current
// project (if any) is rendered as a non-link "active" chip.
function projectChips(projects: Project[], activeSlug: string | null): string {
  if (projects.length === 0) return "";
  const chips = projects.map(p => {
    if (p.slug === activeSlug) {
      return `<span class="chip active">${esc(strOr(p.data.name, p.slug))}</span>`;
    }
    return `<a class="chip" href="/p/${esc(p.slug)}">${esc(strOr(p.data.name, p.slug))}</a>`;
  }).join("");
  return `<nav class="project-chips">${chips}</nav>`;
}

function extractProjectBody(body: string): string {
  const parts: string[] = [];
  for (const heading of ["Goal", "Context", "Notes", "Log"]) {
    const section = extractSection(body, heading);
    if (section) parts.push(`## ${heading}\n\n${section}`);
  }
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
