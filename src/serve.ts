import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
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
import { readPrCache, parsePrUrl } from "./pr_cache.ts";
import type { PrCacheEntry } from "./pr_cache.ts";
import { analyzePr } from "./pr_signal.ts";
import type { RawPrJson, PrDecision } from "./pr_signal.ts";
import {
  isValidRunLogName,
  latestRunLog,
  parseEvents,
  runsDir,
} from "./run_log.ts";
import type { RunEvent } from "./run_log.ts";
import {
  CONFIG_PATH,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_TIMEZONE,
  DEFAULT_TIME_BOUND_MINUTES,
} from "./config.ts";
import type { Config } from "./config.ts";
import { AGENTS_PATH } from "./agents.ts";
import type { AgentEntry } from "./agents.ts";

// A PR-cache lookup. Production passes `readPrCache` (reads ~/.tpm/pr-cache);
// tests pass a stub so `route` stays pure and disk-free.
export type PrCacheReader = (url: string) => PrCacheEntry | null;

// A run-log reader for the task page's "Current/Last run" panel. Returns the
// most recent log for a slug, or null if none exist. Production reads
// `~/.tpm/runs/`; tests inject a stub.
export interface RunLogSnapshot {
  name: string;
  text: string;
}
export type RunLogReader = (slug: string) => RunLogSnapshot | null;

// A direct read by basename for the `/runs/<file>` raw route. Returns the raw
// file contents, or null if the file is missing or the name is rejected by the
// path-traversal guard.
export type RunLogRawReader = (name: string) => string | null;

// A read-only view of a JSON config file (~/.tpm/config.json or
// ~/.tpm/agents.json) for the `/config` page. The renderer wants both the raw
// text (to pretty-print) and the parsed value (to surface interpretive fields),
// plus the file's path and a parse/IO error if either failed. `missing` is
// distinguished from `error` so the UI can render a "no file yet — using
// defaults" hint instead of a scary parse-error block.
export interface ConfigSnapshot {
  path: string;
  raw: string;
  parsed: unknown | null;
  error: string | null;
  missing: boolean;
}
export type ConfigSnapshotReader = () => ConfigSnapshot;

// Older than this, a cached snapshot is treated as no-data: the page renders a
// placeholder rather than implying the state is current.
const PR_CACHE_STALE_MS = 60 * 60 * 1000;

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
  // PR-cache lookup. Defaults to `readPrCache` (reads ~/.tpm/pr-cache) when
  // omitted; tests inject a stub.
  prCache?: PrCacheReader;
  // Run-log lookups. Defaults read `~/.tpm/runs/`; tests inject stubs to keep
  // `route` pure and disk-free.
  runLog?: RunLogReader;
  runLogRaw?: RunLogRawReader;
  // Config-file snapshots for the `/config` page. Default readers hit disk;
  // tests inject in-memory stubs.
  configSnapshot?: ConfigSnapshotReader;
  agentsSnapshot?: ConfigSnapshotReader;
}

// Pure dispatch — returns the response shape, doesn't touch the network.
// Tests exercise this directly with mocked projects.
export function route(pathname: string, params: URLSearchParams, projects: Project[], opts: RouteOpts = {}): RouteResult {
  const prCache: PrCacheReader = opts.prCache ?? ((url) => readPrCache(url));
  const runLog: RunLogReader = opts.runLog ?? defaultRunLogReader;
  const runLogRaw: RunLogRawReader = opts.runLogRaw ?? defaultRunLogRawReader;
  if (pathname === "/" || pathname === "") {
    return ok("text/html; charset=utf-8", renderIndex(projects, params.get("project"), prCache));
  }
  if (pathname === "/api/refresh") {
    return ok("application/json", renderRefresh(projects));
  }
  if (pathname === "/config") {
    const cfg = (opts.configSnapshot ?? defaultConfigSnapshot)();
    const agents = (opts.agentsSnapshot ?? defaultAgentsSnapshot)();
    return ok("text/html; charset=utf-8", renderConfig(projects, cfg, agents));
  }
  const runsMatch = pathname.match(/^\/runs\/([^/]+)\/?$/);
  if (runsMatch) {
    const name = decodeURIComponent(runsMatch[1]);
    // Path-traversal guard: only allow the canonical `<slug>--<utc>.log` shape.
    if (!isValidRunLogName(name)) return notFound(`bad run log name: ${name}`);
    const text = runLogRaw(name);
    if (text === null) return notFound(`No run log: ${name}`);
    return { status: 200, contentType: "text/plain; charset=utf-8", body: text };
  }
  const projectMatch = pathname.match(/^\/p\/([^/]+)\/?$/);
  if (projectMatch) {
    const slug = decodeURIComponent(projectMatch[1]);
    const project = projects.find(p => p.slug === slug);
    if (!project) return notFound(`No project: ${slug}`);
    const showArchived = params.get("archived") === "1";
    return ok("text/html; charset=utf-8", renderProject(project, projects, showArchived, prCache));
  }
  const taskMatch = pathname.match(/^\/t\/(.+?)\/?$/);
  if (taskMatch) {
    const query = decodeURIComponent(taskMatch[1]);
    const match = findTask(projects, query);
    if (!match) return notFound(`No task: ${query}`);
    return ok("text/html; charset=utf-8", renderTask(match.project, match.task, projects, opts, prCache, runLog));
  }
  return notFound(pathname);
}

// Read the most recent run log for a slug from `~/.tpm/runs/`. Returns null
// if the file doesn't exist or can't be read — the panel renders a placeholder.
function defaultRunLogReader(slug: string): RunLogSnapshot | null {
  const path = latestRunLog(slug);
  if (!path) return null;
  try {
    return { name: basename(path), text: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

// Read the raw bytes of a run log by basename. The route layer already ran the
// `isValidRunLogName` guard, so the join below can't escape the runs dir.
function defaultRunLogRawReader(name: string): string | null {
  if (!isValidRunLogName(name)) return null;
  const path = resolve(runsDir(), name);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultConfigSnapshot(): ConfigSnapshot {
  return readConfigSnapshot(CONFIG_PATH);
}

function defaultAgentsSnapshot(): ConfigSnapshot {
  return readConfigSnapshot(AGENTS_PATH);
}

// Non-throwing snapshot reader for the /config page. Distinguishes
// missing-file (return defaults) from invalid-JSON (show parse error + raw).
// Doesn't run the stricter validators in `readConfig` / `readAgentsRegistry` —
// the UI should surface what the file says, even when fields are off-spec.
function readConfigSnapshot(path: string): ConfigSnapshot {
  if (!existsSync(path)) {
    return { path, raw: "", parsed: null, error: null, missing: true };
  }
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { path, raw: "", parsed: null, error: (e as Error).message, missing: false };
  }
  try {
    const parsed = JSON.parse(raw);
    return { path, raw, parsed, error: null, missing: false };
  } catch (e) {
    return { path, raw, parsed: null, error: (e as Error).message, missing: false };
  }
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

function renderIndex(projects: Project[], projectFilter: string | null, prCache: PrCacheReader): string {
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
  ${inbox.length === 0 ? `<p class="queue-empty">Inbox empty.</p>` : inbox.map(it => taskRow(it.project, it.task, it.status, prCache)).join("")}
</section>
<section class="queue">
  <h2>Agent queue <span class="meta">(${agentItems.length})</span></h2>
  ${agentItems.length === 0 ? `<p class="queue-empty">Nothing ready, needing feedback, or awaiting close.</p>` : agentItems.map(it => taskRow(it.project, it.task, it.status, prCache)).join("")}
</section>
<section class="queue">
  <h2>In flight <span class="meta">(${inFlight.length})</span></h2>
  ${inFlight.length === 0 ? `<p class="queue-empty">No in-progress tasks.</p>` : inFlight.map(it => taskRow(it.project, it.task, "in-progress", prCache)).join("")}
</section>
`;
  return layout("tpm", body, { autoRefresh: 30 });
}

function renderProject(project: Project, allProjects: Project[], showArchived: boolean, prCache: PrCacheReader): string {
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
      const rows = group.map(t => taskRow(project, t, s, prCache)).join("");
      return `<section class="queue"><h2>${esc(s)} <span class="meta">(${group.length})</span></h2>${rows}</section>`;
    })
    .join("");

  const repoLink = repo.remote ? extLink(repo.remote, esc(repo.remote)) : "<em>no remote</em>";
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
<div class="layout no-rail">
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

function renderTask(
  project: Project,
  task: Task,
  allProjects: Project[],
  opts: RouteOpts = {},
  prCache: PrCacheReader = (url) => readPrCache(url),
  runLog: RunLogReader = defaultRunLogReader,
): string {
  const repo = resolveRepo(project, task);
  const status = rollupStatus(task);
  const title = strOr(task.data.title, task.slug);
  const prs = (Array.isArray(task.data.prs) ? task.data.prs : []).map(String);
  const prList = prs.length
    ? `<ul>${prs.map(u => `<li>${extLink(u, esc(u))}</li>`).join("")}</ul>`
    : "<em>none</em>";
  const childrenList = task.children?.length
    ? `<ul>${task.children.map(c => `<li><a href="/t/${esc(project.slug)}/${esc(task.slug)}/${esc(c.slug)}">${esc(strOr(c.data.title, c.slug))}</a> <span class="badge s-${cls(rollupStatus(c))}">${esc(rollupStatus(c))}</span></li>`).join("")}</ul>`
    : "";

  const repoBlock = repo.remote ? `<dt>Repo</dt><dd>${extLink(repo.remote, esc(repo.remote))}</dd>` : "";
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

  const prPanel = renderPrPanel(prs, prCache);
  const actionsSection = renderActions(project, task, status, opts);
  const settingsSection = renderSettings(project, task, status, opts);
  const railContent = `${prPanel}${actionsSection}${settingsSection}`;
  const hasRail = railContent.length > 0;

  const slug = task.parent
    ? `${project.slug}/${task.parent}/${task.slug}`
    : `${project.slug}/${task.slug}`;
  const runPanel = renderRunPanel(slug, status, runLog);
  // Auto-refresh the page while the agent is running so the run panel stays
  // current. Costs page flicker; SSE would be smoother but task 057's v0 ships
  // poll-refresh. 10s matches the lower bound in the task body's suggestion.
  const autoRefresh = status === "in-progress" ? 10 : undefined;

  const body = `
${projectChips(allProjects, project.slug)}
<nav class="crumbs"><a href="/">tpm</a>${crumbsTrail}</nav>
${flashBanner}
<header>
  <h1>${esc(title)} <span class="badge s-${cls(status)}">${esc(status)}</span></h1>
  <p class="meta"><code>${esc(task.slug)}</code>  ·  type: ${esc(strOr(task.data.type, "?"))}  ·  project: <a href="/p/${esc(project.slug)}">${esc(project.slug)}</a></p>
</header>
<div class="layout${hasRail ? "" : " no-rail"}">
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
  <main>
    <div class="body">${renderMarkdown(task.body)}</div>
    ${runPanel}
  </main>
  ${hasRail ? `<div class="task-rail">${railContent}</div>` : ""}
</div>
`;
  return layout(`tpm · ${title}`, body, { autoRefresh });
}

// ---- /config page ---------------------------------------------------------

// Read-only view of the two ~/.tpm JSON files driving harness behavior. Pairs
// an interpretive `dl` (the fields people actually care about, with defaults
// from `src/defaults` / `src/config.ts` filled in) with the raw pretty-printed
// JSON for everything else.
function renderConfig(projects: Project[], cfg: ConfigSnapshot, agents: ConfigSnapshot): string {
  const body = `
${projectChips(projects, null, "config")}
<nav class="crumbs"><a href="/">tpm</a><a href="/config">config</a></nav>
<header>
  <h1>Configuration</h1>
  <p class="meta">Harness config + agent registry. Read-only — edit the files to change them.</p>
</header>
<section class="config-section">
  <h2>Harness config</h2>
  <p class="meta">File: <code>${esc(displayPath(cfg.path))}</code></p>
  ${renderHarnessInterp(cfg)}
  ${renderConfigJson(cfg)}
</section>
<section class="config-section">
  <h2>Agents</h2>
  <p class="meta">File: <code>${esc(displayPath(agents.path))}</code></p>
  ${renderAgentsInterp(agents)}
  ${renderConfigJson(agents)}
</section>
`;
  return layout("tpm · config", body);
}

// Render the `~/...` short form when the path lives under $HOME so the page
// matches the canonical names operators use in docs and CLI output.
function displayPath(path: string): string {
  const home = homedir();
  if (home && (path === home || path.startsWith(home + "/"))) {
    return "~" + path.slice(home.length);
  }
  return path;
}

function renderHarnessInterp(snap: ConfigSnapshot): string {
  const cfg = isPlainObject(snap.parsed) ? (snap.parsed as Config) : ({} as Config);
  const root = typeof cfg.root === "string" && cfg.root.length
    ? `<code>${esc(cfg.root)}</code>`
    : `<em>not set (default — see <code>tpm root</code>)</em>`;
  const tz = typeof cfg.timezone === "string" && cfg.timezone.length
    ? esc(cfg.timezone)
    : `${esc(DEFAULT_TIMEZONE)} <span class="config-default">(default)</span>`;
  const tb = typeof cfg.time_bound_minutes === "number"
    ? `${esc(String(cfg.time_bound_minutes))} min`
    : `${esc(String(DEFAULT_TIME_BOUND_MINUTES))} min <span class="config-default">(default)</span>`;
  const notif = { ...DEFAULT_NOTIFICATIONS, ...(cfg.notifications ?? {}) };
  const notifBody = ["start", "finish", "fail"].map(k => {
    const v = (notif as Record<string, boolean>)[k];
    return `${esc(k)}: <code>${esc(String(v))}</code>`;
  }).join("  ·  ");
  return `<dl class="config-interp">
  <dt>Tree root</dt><dd>${root}</dd>
  <dt>Timezone</dt><dd>${tz}</dd>
  <dt>Time bound</dt><dd>${tb}</dd>
  <dt>Notifications</dt><dd>${notifBody}</dd>
</dl>`;
}

function renderAgentsInterp(snap: ConfigSnapshot): string {
  const parsed = isPlainObject(snap.parsed) ? (snap.parsed as { agents?: unknown }) : {};
  const agentsRaw = parsed.agents;
  if (!isPlainObject(agentsRaw)) {
    return `<p class="config-empty">No agents configured. Run <code>tpm agents add &lt;id&gt; --repo &lt;slug&gt;</code> to register one.</p>`;
  }
  const entries = Object.entries(agentsRaw as Record<string, unknown>);
  if (entries.length === 0) {
    return `<p class="config-empty">No agents configured. Run <code>tpm agents add &lt;id&gt; --repo &lt;slug&gt;</code> to register one.</p>`;
  }
  const rows = entries.map(([id, entryRaw]) => {
    const entry = isPlainObject(entryRaw) ? (entryRaw as AgentEntry & Record<string, unknown>) : ({} as AgentEntry);
    const repos = Array.isArray(entry.prefer_repos) && entry.prefer_repos.length
      ? entry.prefer_repos.map(r => `<code>${esc(String(r))}</code>`).join(", ")
      : `<em>none</em>`;
    const comment = typeof entry.comment === "string" && entry.comment.length
      ? `  ·  <span class="config-comment">${esc(entry.comment)}</span>`
      : "";
    return `<dt>${esc(id)}</dt><dd>prefer: ${repos}${comment}</dd>`;
  }).join("");
  return `<dl class="config-interp">${rows}</dl>`;
}

function renderConfigJson(snap: ConfigSnapshot): string {
  if (snap.missing) {
    return `<p class="config-missing">No file at this path yet — defaults are used.</p>`;
  }
  if (snap.error) {
    const rawBlock = snap.raw.length
      ? `<details class="config-raw"><summary>Raw contents</summary><pre><code>${esc(snap.raw)}</code></pre></details>`
      : "";
    return `<div class="config-error">
  <p><strong>Failed to parse this file.</strong></p>
  <pre><code>${esc(snap.error)}</code></pre>
  ${rawBlock}
</div>`;
  }
  const pretty = JSON.stringify(snap.parsed, null, 2);
  return `<pre class="config-json"><code>${esc(pretty)}</code></pre>`;
}

function isPlainObject(v: unknown): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---- run panel ------------------------------------------------------------

// How many events of the parsed transcript to render. The file itself can be
// huge for a long run, but the panel is a tail — older events fall off. The
// raw file is one click away via the "View raw log" link.
const RUN_PANEL_EVENTS = 60;

function renderRunPanel(slug: string, status: string, runLog: RunLogReader): string {
  const snapshot = runLog(slug);
  const label = status === "in-progress" ? "Current run" : "Last run";
  if (!snapshot) {
    // No run on disk yet. For an in-progress task this is a transient state
    // (orchestrator just spawned, no events yet); for any other status it
    // means the task has never been orchestrator-dispatched.
    const note = status === "in-progress"
      ? "Waiting for the agent to emit its first event…"
      : "No run log on disk yet — this task hasn't been dispatched by `tpm orchestrate`.";
    return `<section class="run-panel run-panel-empty">
  <h2>${esc(label)}</h2>
  <p class="run-empty">${esc(note)}</p>
</section>`;
  }
  const events = parseEvents(snapshot.text);
  const tail = events.slice(-RUN_PANEL_EVENTS);
  const rendered = tail.length === 0
    ? `<p class="run-empty">Log file is empty — the agent hasn't written anything yet.</p>`
    : `<ol class="run-events">${tail.map(renderRunEvent).join("")}</ol>`;
  const truncated = events.length > tail.length
    ? `<p class="run-meta">Showing the last ${tail.length} of ${events.length} events.</p>`
    : "";
  const rawLink = `<p class="run-meta"><a href="/runs/${esc(snapshot.name)}">View raw log →</a></p>`;
  return `<section class="run-panel">
  <h2>${esc(label)} <span class="meta">${esc(snapshot.name)}</span></h2>
  ${rendered}
  ${truncated}
  ${rawLink}
</section>`;
}

function renderRunEvent(ev: RunEvent): string {
  switch (ev.kind) {
    case "system":
      return `<li class="ev ev-system"><span class="ev-tag">system</span><span class="ev-body">${esc(ev.subtype)}${ev.model ? ` · ${esc(ev.model)}` : ""}</span></li>`;
    case "text":
      return `<li class="ev ev-text"><span class="ev-tag">say</span><span class="ev-body">${esc(ev.text)}</span></li>`;
    case "tool_use":
      return `<li class="ev ev-tool"><span class="ev-tag">→ ${esc(ev.name)}</span><span class="ev-body">${esc(ev.inputPreview)}</span></li>`;
    case "tool_result": {
      const cls = ev.isError ? "ev ev-result ev-error" : "ev ev-result";
      const tag = ev.isError ? "← error" : "←";
      return `<li class="${cls}"><span class="ev-tag">${esc(tag)}</span><span class="ev-body">${esc(ev.preview)}</span></li>`;
    }
    case "result": {
      const cls = ev.isError ? "ev ev-final ev-error" : "ev ev-final";
      const cost = typeof ev.totalCostUsd === "number" ? ` · $${ev.totalCostUsd.toFixed(3)}` : "";
      const dur = typeof ev.durationMs === "number" ? ` · ${Math.round(ev.durationMs / 1000)}s` : "";
      return `<li class="${cls}"><span class="ev-tag">result ${esc(ev.subtype || "?")}${esc(dur)}${esc(cost)}</span><span class="ev-body">${esc(ev.preview)}</span></li>`;
    }
    case "raw":
      return `<li class="ev ev-raw"><span class="ev-tag">raw</span><span class="ev-body">${esc(ev.line)}</span></li>`;
  }
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
      break;
    case "in-progress":
      forms.push(blockForm(href));
      forms.push(completeForm(href));
      forms.push(logForm(href));
      forms.push(prForm(href));
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

// Per-task config toggles. Lives outside renderActions because settings are
// not transitions: they apply regardless of which queue the task is in, so
// they shouldn't be gated by status the way action verbs are.
function renderSettings(project: Project, task: Task, status: string, opts: RouteOpts): string {
  if (opts.mutationsEnabled === false) return ""; // covered by the disabled-actions notice
  if (task.archived) return "";
  if (isParent(task)) return "";
  if (status === "done" || status === "dropped") return ""; // terminal: toggle has no effect

  const href = taskHref(project, task);
  const allowOn = task.data.allow_orchestrator === true;
  return `<section class="task-settings"><h2>Settings</h2>${allowForm(href, allowOn)}</section>`;
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

function taskRow(project: Project, task: Task, status: string, prCache: PrCacheReader): string {
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
    ${prChipsFor(task, prCache)}
    <span class="slug">${esc(slug)}</span>
    ${archivedTag}
    <span class="when">${esc(when)}</span>
  </div>`;
}

// ---- PR panel + chips -----------------------------------------------------

// Renders one card per linked PR, before the Actions section. Reads the
// poller-written snapshot from `~/.tpm/pr-cache/`; cache-miss or a >1h-old
// snapshot degrades to a placeholder rather than blocking on a live `gh` call.
function renderPrPanel(prs: string[], prCache: PrCacheReader): string {
  const urls = prs.map(String).filter(u => u.length > 0);
  if (urls.length === 0) return "";
  const nowMs = Date.now();
  const cards = urls.map(url => renderPrCard(url, prCache(url), nowMs)).join("");
  return `<section class="pr-panel"><h2>Pull request${urls.length === 1 ? "" : "s"}</h2>${cards}</section>`;
}

function renderPrCard(url: string, entry: PrCacheEntry | null, nowMs: number): string {
  const ref = parsePrUrl(url);
  const headline = ref
    ? extLink(url, `PR ${esc(ref.displayId)}`)
    : extLink(url, esc(url));
  const openLabel = openLinkLabel(ref?.host);
  const openLink = extLink(url, `${esc(openLabel)} →`, "pr-open");

  const ageMs = entry ? nowMs - Date.parse(entry.fetchedAt) : NaN;
  const fresh = entry !== null && Number.isFinite(ageMs) && ageMs <= PR_CACHE_STALE_MS;

  if (!entry || !fresh) {
    const note = entry && Number.isFinite(ageMs)
      ? `no current data — last polled ${relativeAge(ageMs)}; awaiting the next poll`
      : `no PR data cached yet — the PR poller will fill this in`;
    return `<div class="pr-card pr-card-empty">
    <div class="pr-headline">${headline}${openLink}</div>
    <p class="pr-nodata">${esc(note)}</p>
  </div>`;
  }

  // Rich GitHub-shape rendering (CI rollup, mergeable, review decision).
  // Other hosts get a minimal card until they grow their own badge set —
  // wiring up vote scores / pipeline state is out of scope for task 052.
  if (entry.host === "github") {
    const pr = entry.pr as RawPrJson;
    const d = analyzePr(pr);
    const title = strOr(pr.title, "");
    const titleHtml = title ? ` <span class="pr-title">${esc(title)}</span>` : "";
    const badges = [
      prBadge("state", prStateLabel(pr), prStateClass(pr)),
      prBadge("CI", ciLabel(d.ci), ciClass(d.ci)),
      prBadge("review", reviewLabel(d.review), reviewClass(d.review)),
      prBadge("mergeable", mergeLabel(d.mergeable), mergeClass(d.mergeable)),
    ].join("");
    return `<div class="pr-card">
    <div class="pr-headline">${headline}${titleHtml}${openLink}</div>
    <div class="pr-badges">${badges}</div>
    <p class="pr-fetched">fetched ${esc(relativeAge(ageMs))}</p>
  </div>`;
  }

  const hostLabel = entry.host.toUpperCase();
  return `<div class="pr-card">
    <div class="pr-headline">${headline}${openLink}</div>
    <div class="pr-badges">${prBadge("host", hostLabel, "s-in-progress")}</div>
    <p class="pr-fetched">fetched ${esc(relativeAge(ageMs))}</p>
  </div>`;
}

function openLinkLabel(host: string | undefined): string {
  if (host === "ado") return "Open on Azure DevOps";
  return "Open on GitHub";
}

// A `[PR #N <state>]` chip per linked PR, shown after the title in queue rows.
// State comes from the cache; on a miss the chip is still useful as a link
// (`[PR #N]`, no state).
function prChipsFor(task: Task, prCache: PrCacheReader): string {
  const urls = (Array.isArray(task.data.prs) ? task.data.prs : []).map(String).filter(u => u.length > 0);
  if (urls.length === 0) return "";
  return urls.map(url => {
    const ref = parsePrUrl(url);
    const idLabel = ref ? ref.displayId : "";
    const entry = prCache(url);
    // Only GitHub entries have a `state` we know how to label — ADO state
    // lives in a different field. Until ADO chip rendering ships, ADO chips
    // are link-only.
    const stateLabel = entry && entry.host === "github" ? ` ${prStateLabel(entry.pr as RawPrJson)}` : "";
    const stateClass = entry && entry.host === "github" ? prStateClass(entry.pr as RawPrJson) : "s-dropped";
    return extLink(url, `PR ${esc(idLabel)}${esc(stateLabel)}`, `pr-chip badge ${stateClass}`);
  }).join("");
}

function prBadge(label: string, value: string, cssClass: string): string {
  return `<span class="pr-badge"><span class="pr-badge-label">${esc(label)}</span><span class="badge ${cssClass}">${esc(value)}</span></span>`;
}

function prStateLabel(pr: RawPrJson): string {
  const state = (pr.state ?? "").toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed (not merged)";
  if (pr.isDraft === true) return "draft";
  if (state === "OPEN") return "open";
  return state.toLowerCase() || "unknown";
}

function prStateClass(pr: RawPrJson): string {
  const state = (pr.state ?? "").toUpperCase();
  if (state === "MERGED") return "s-done";
  if (state === "CLOSED") return "s-dropped";
  if (pr.isDraft === true) return "s-in-progress";
  if (state === "OPEN") return "s-open";
  return "s-dropped";
}

function ciLabel(ci: PrDecision["ci"]): string {
  return ci === "PASS" ? "passing" : ci === "FAIL" ? "failing" : ci === "PENDING" ? "pending" : "no checks";
}
function ciClass(ci: PrDecision["ci"]): string {
  return ci === "PASS" ? "s-done" : ci === "FAIL" ? "s-blocked" : ci === "PENDING" ? "s-in-progress" : "s-dropped";
}

function reviewLabel(review: string): string {
  switch (review.toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes requested";
    case "COMMENTED": return "commented";
    case "REVIEW_REQUIRED": return "review required";
    case "NONE": return "no review";
    default: return review.toLowerCase() || "no review";
  }
}
function reviewClass(review: string): string {
  switch (review.toUpperCase()) {
    case "APPROVED": return "s-done";
    case "CHANGES_REQUESTED": return "s-blocked";
    case "COMMENTED": return "s-needs-feedback";
    default: return "s-dropped";
  }
}

function mergeLabel(m: string): string {
  switch (m.toUpperCase()) {
    case "CLEAN": return "clean";
    case "BEHIND": return "behind main";
    case "DIRTY": return "conflict";
    case "BLOCKED": return "blocked";
    case "UNSTABLE": return "unstable";
    case "HAS_HOOKS": return "clean (hooks)";
    default: return "unknown";
  }
}
function mergeClass(m: string): string {
  switch (m.toUpperCase()) {
    case "CLEAN": return "s-done";
    case "HAS_HOOKS": return "s-done";
    case "BEHIND": return "s-in-progress";
    case "DIRTY": return "s-blocked";
    case "BLOCKED": return "s-needs-feedback";
    case "UNSTABLE": return "s-needs-feedback";
    default: return "s-dropped";
  }
}

// "just now" / "5 min ago" / "3 hours ago" / "2 days ago" from an age in ms.
function relativeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Inline list of project links shown above the page header. The current
// project (if any) is rendered as a non-link "active" chip. Always trailed by
// a site-wide "config" chip so /config is one click from every page.
function projectChips(projects: Project[], activeSlug: string | null, activeView?: "config"): string {
  const chips = projects.map(p => {
    if (p.slug === activeSlug) {
      return `<span class="chip active">${esc(strOr(p.data.name, p.slug))}</span>`;
    }
    return `<a class="chip" href="/p/${esc(p.slug)}">${esc(strOr(p.data.name, p.slug))}</a>`;
  });
  const configChip = activeView === "config"
    ? `<span class="chip chip-config active">config</span>`
    : `<a class="chip chip-config" href="/config">config</a>`;
  return `<nav class="project-chips">${chips.join("")}${configChip}</nav>`;
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
// External (off-host) links: open in a new tab. `noopener` blocks the new tab
// from reaching `window.opener` (security); `noreferrer` strips the Referer
// header (privacy). Standard pair for `target="_blank"`.
function extLink(url: string, label: string, classes = ""): string {
  const cls = classes ? ` class="${escAttr(classes)}"` : "";
  return `<a${cls} href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}
