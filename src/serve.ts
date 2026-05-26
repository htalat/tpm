import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjects, flatTasks, isParent, rollupStatus, taskHasReport, taskReportPath } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { findRoot } from "./root.ts";
import { findTask } from "./resolve.ts";
import { resolveRepo } from "./context.ts";
import { now } from "./time.ts";
import { inboxItems } from "./queue.ts";
import { listTaskLocks } from "./lock.ts";
import { BASE_CSS, SERVE_CSS } from "./css.ts";
import { renderMarkdown } from "./markdown.ts";
import { readPrCache, parsePrUrl } from "./pr_cache.ts";
import type { PrCacheEntry } from "./pr_cache.ts";
import { analyzePr } from "./pr_signal.ts";
import type { RawPrJson, PrDecision } from "./pr_signal.ts";
import {
  allRunLogs,
  encodeLegacySlug,
  isLegacyRunLogName,
  isValidRunLogName,
  latestRunLog,
  parseRunLog,
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
import { defaultHarnessLogReader, parseTaskLogEntries } from "./harness_log.ts";
import type { HarnessLogReader, HarnessLogSource, HarnessLogLine } from "./harness_log.ts";

// A PR-cache lookup. Production passes `readPrCache` (reads ~/.tpm/pr-cache);
// tests pass a stub so `route` stays pure and disk-free.
export type PrCacheReader = (url: string) => PrCacheEntry | null;

// A run-log reader for the task page's "Current/Last run" panel. Returns the
// most recent log for a task, or null if none exist. Production reads from
// the task folder (`<task>/runs/`, task 095); tests inject a stub.
export interface RunLogSnapshot {
  name: string;
  text: string;
}
export type RunLogReader = (task: Task) => RunLogSnapshot | null;

// A direct read by basename for the `/t/<proj>/<slug>/runs/<basename>` raw
// route. Returns the raw file contents, or null if the file is missing or
// the name is rejected by the path-traversal guard.
export type RunLogRawReader = (task: Task, name: string) => string | null;

// Lists every run log for a task, newest-first as bare basenames (no path —
// the per-task raw route consumes basenames). Production reads the task
// folder's `runs/` (filtered by `<child-slug>--` prefix for children);
// tests inject in-memory stubs to keep the `/runs` index pure and disk-free.
export type RunLogListReader = (task: Task) => string[];

// Snapshot of one held per-task lock. Mirrors the fields the lock file
// stores (agent id, pid, acquired stamp) — serve renders them in the task
// detail header. We don't surface heartbeat / age here: the row chip is a
// boolean (held or not), and `tpm lock release-stale` is the place for TTL
// logic, not the UI.
export interface TaskLockSnapshotEntry {
  agentId: string;
  pid: number;
  acquired: string;
}

// Snapshot reader for the per-task lock dir. Returns a map keyed by
// qualified slug so renderers can probe membership without re-walking disk
// per row. Production builds it from `listTaskLocks(root)`; tests inject a
// pre-baked Map. Called once per `route()` invocation (one readdir per
// render); cheap enough not to deserve memoization.
export type TaskLockReader = () => Map<string, TaskLockSnapshotEntry>;

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
  "lgtm", "request-changes", "archive",
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
    taskLocks: () => snapshotTaskLocks(root),
  });
  if (result.location && result.status >= 300 && result.status < 400) {
    res.writeHead(result.status, { location: result.location });
    res.end();
    return;
  }
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
  // Set when the response is a redirect (status 3xx). `handleRequest` writes
  // this as the `Location` header and skips the body.
  location?: string;
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
  // Lists every run log basename for a slug, newest-first. Used by the
  // `/t/<proj>/<slug>/runs` index. Defaults read `~/.tpm/runs/`; tests stub.
  runLogList?: RunLogListReader;
  // Config-file snapshots for the `/config` page. Default readers hit disk;
  // tests inject in-memory stubs.
  configSnapshot?: ConfigSnapshotReader;
  agentsSnapshot?: ConfigSnapshotReader;
  // Harness-log reader for the `/logs` page. Default reads `~/.tpm/`; tests
  // inject in-memory stubs.
  harnessLog?: HarnessLogReader;
  // Per-task lock snapshot reader. Defaults to an empty map (route() is
  // pure / disk-free); `handleRequest` wires it to `listTaskLocks(root)` for
  // the live server. The snapshot decorates task rows and the detail page
  // with a "🔒 working" / "unclaimed" chip so the UI never disagrees with
  // lock truth (task 109).
  taskLocks?: TaskLockReader;
}

// Default tail size for the `/logs` page. Big enough that the operator can
// reconstruct an incident without paging; small enough that the page renders
// fast even when poller summaries have been accumulating for weeks.
const LOGS_DEFAULT_TAIL = 200;
const LOGS_MAX_TAIL = 2000;

// Pure dispatch — returns the response shape, doesn't touch the network.
// Tests exercise this directly with mocked projects.
export function route(pathname: string, params: URLSearchParams, projects: Project[], opts: RouteOpts = {}): RouteResult {
  const prCache: PrCacheReader = opts.prCache ?? ((url) => readPrCache(url));
  const runLog: RunLogReader = opts.runLog ?? defaultRunLogReader;
  const runLogRaw: RunLogRawReader = opts.runLogRaw ?? defaultRunLogRawReader;
  const runLogList: RunLogListReader = opts.runLogList ?? defaultRunLogListReader;
  // One snapshot per render — propagated to taskRow / renderTask so every row
  // and the detail page see a consistent view of who's holding what.
  const taskLocks: Map<string, TaskLockSnapshotEntry> =
    (opts.taskLocks ?? (() => new Map<string, TaskLockSnapshotEntry>()))();
  if (pathname === "/" || pathname === "") {
    return ok("text/html; charset=utf-8", renderIndex(projects, params.get("project"), prCache, taskLocks, opts.flash));
  }
  if (pathname === "/api/refresh") {
    return ok("application/json", renderRefresh(projects));
  }
  if (pathname === "/config") {
    const cfg = (opts.configSnapshot ?? defaultConfigSnapshot)();
    const agents = (opts.agentsSnapshot ?? defaultAgentsSnapshot)();
    return ok("text/html; charset=utf-8", renderConfig(projects, cfg, agents));
  }
  if (pathname === "/logs") {
    const taskFilter = params.get("task")?.trim() || undefined;
    if (taskFilter) {
      // Per-task scope moved to `/t/<proj>/<slug>/log` (a sub-resource of the
      // task). Redirect old bookmarks for one release window; the redirect
      // goes away in a follow-up task once it's clear nothing's hitting it.
      let match: { project: Project; task: Task } | null = null;
      try { match = findTask(projects, taskFilter); } catch { match = null; }
      if (match) {
        const slugPath = match.task.parent
          ? `${match.project.slug}/${match.task.parent}/${match.task.slug}`
          : `${match.project.slug}/${match.task.slug}`;
        const encoded = slugPath.split("/").map(encodeURIComponent).join("/");
        const linesParam = params.get("lines");
        const query = linesParam ? `?lines=${encodeURIComponent(linesParam)}` : "";
        return redirect(302, `/t/${encoded}/log${query}`);
      }
      // Slug doesn't resolve — drop the broken param and send to the landing.
      return redirect(302, "/logs");
    }
    const reader = opts.harnessLog ?? defaultHarnessLogReader;
    // Landing page: one summary card per source category. Pull the last
    // structured line per source for the "Last entry" hint — totalLines on
    // each source still reflects the full file (or the filtered subset, but
    // there's no filter here).
    const sources = reader({ lines: 1 });
    return ok("text/html; charset=utf-8", renderLogsLanding(projects, sources));
  }
  if (pathname === "/logs/orchestrate") {
    return renderCategoryPage(projects, params, opts, "orchestrate");
  }
  if (pathname === "/logs/poller") {
    return renderCategoryPage(projects, params, opts, "poller");
  }
  const legacyRunsMatch = pathname.match(/^\/runs\/([^/]+)\/?$/);
  if (legacyRunsMatch) {
    // Pre-095 flat URL: `/runs/<encoded-slug>--<utc>.log`. Per-run logs moved
    // into each task's folder (task 095); redirect old bookmarks to the new
    // per-task viewer for one release window. We resolve the encoded prefix
    // against the loaded project tree to find the owning task.
    const name = decodeURIComponent(legacyRunsMatch[1]);
    if (!isLegacyRunLogName(name)) return notFound(`bad run log name: ${name}`);
    const redirect = resolveLegacyRunLog(projects, name);
    if (!redirect) return notFound(`No run log: ${name}`);
    return { status: 302, contentType: "text/plain; charset=utf-8", body: "", location: redirect };
  }
  const artifactsMatch = pathname.match(/^\/p\/([^/]+)\/artifacts\/?$/);
  if (artifactsMatch) {
    const slug = decodeURIComponent(artifactsMatch[1]);
    const project = projects.find(p => p.slug === slug);
    if (!project) return notFound(`No project: ${slug}`);
    const typeParam = params.get("type");
    const filter: ArtifactFilter = typeParam === "pr" || typeParam === "report" ? typeParam : "all";
    return ok("text/html; charset=utf-8", renderArtifacts(project, projects, filter, prCache));
  }
  const projectMatch = pathname.match(/^\/p\/([^/]+)\/?$/);
  if (projectMatch) {
    const slug = decodeURIComponent(projectMatch[1]);
    const project = projects.find(p => p.slug === slug);
    if (!project) return notFound(`No project: ${slug}`);
    const showArchived = params.get("archived") === "1";
    return ok("text/html; charset=utf-8", renderProject(project, projects, showArchived, prCache, taskLocks));
  }
  const taskLogMatch = pathname.match(/^\/t\/(.+)\/log\/?$/);
  if (taskLogMatch) {
    const query = decodeURIComponent(taskLogMatch[1]);
    let match: { project: Project; task: Task } | null = null;
    try { match = findTask(projects, query); } catch { match = null; }
    if (!match) return notFound(`No task: ${query}`);
    const reader = opts.harnessLog ?? defaultHarnessLogReader;
    const slugPath = match.task.parent
      ? `${match.project.slug}/${match.task.parent}/${match.task.slug}`
      : `${match.project.slug}/${match.task.slug}`;
    const tail = parseTailParam(params.get("lines"));
    const sources = reader({ lines: tail.value, filter: slugPath });
    const taskLog = parseTaskLogEntries(match.task.body);
    return ok("text/html; charset=utf-8", renderTaskLog(projects, match.project, match.task, sources, {
      taskFilter: slugPath,
      tail: tail.value,
      tailMode: tail.mode,
      taskLog,
    }));
  }
  const taskReportMatch = pathname.match(/^\/t\/(.+)\/report\/?$/);
  if (taskReportMatch) {
    const query = decodeURIComponent(taskReportMatch[1]);
    let match: { project: Project; task: Task } | null = null;
    try { match = findTask(projects, query); } catch { match = null; }
    if (!match) return notFound(`No task: ${query}`);
    return ok("text/html; charset=utf-8", renderTaskReport(projects, match.project, match.task, opts));
  }
  // Per-task raw run-log viewer: `/t/<proj>/<slug>/runs/<basename>`. The
  // basename pattern depends on the task: top-level uses `<utc>.log`, child
  // uses `<child-slug>--<utc>.log` (children share the parent's runs/ on
  // disk). Matched before the index route so the bare-`/runs` URL still
  // renders the list page.
  const taskRunRawMatch = pathname.match(/^\/t\/(.+)\/runs\/([^/]+)\/?$/);
  if (taskRunRawMatch) {
    const query = decodeURIComponent(taskRunRawMatch[1]);
    const name = decodeURIComponent(taskRunRawMatch[2]);
    let match: { project: Project; task: Task } | null = null;
    try { match = findTask(projects, query); } catch { match = null; }
    if (!match) return notFound(`No task: ${query}`);
    if (!isValidRunLogName(name, match.task)) return notFound(`bad run log name: ${name}`);
    const text = runLogRaw(match.task, name);
    if (text === null) return notFound(`No run log: ${name}`);
    return { status: 200, contentType: "text/plain; charset=utf-8", body: text };
  }
  const taskRunsMatch = pathname.match(/^\/t\/(.+)\/runs\/?$/);
  if (taskRunsMatch) {
    const query = decodeURIComponent(taskRunsMatch[1]);
    let match: { project: Project; task: Task } | null = null;
    try { match = findTask(projects, query); } catch { match = null; }
    if (!match) return notFound(`No task: ${query}`);
    const slugPath = match.task.parent
      ? `${match.project.slug}/${match.task.parent}/${match.task.slug}`
      : `${match.project.slug}/${match.task.slug}`;
    const runs = runLogList(match.task);
    return ok("text/html; charset=utf-8", renderTaskRuns(projects, match.project, match.task, runs, runLog, slugPath));
  }
  const taskMatch = pathname.match(/^\/t\/(.+?)\/?$/);
  if (taskMatch) {
    const query = decodeURIComponent(taskMatch[1]);
    const match = findTask(projects, query);
    if (!match) return notFound(`No task: ${query}`);
    return ok("text/html; charset=utf-8", renderTask(match.project, match.task, projects, opts, prCache, taskLocks));
  }
  return notFound(pathname);
}

function redirect(status: number, location: string): RouteResult {
  return { status, contentType: "text/plain; charset=utf-8", body: "", location };
}

// Read the most recent run log for a task. Returns null if the file doesn't
// exist or can't be read — the panel renders a placeholder. Per task 095 the
// reader walks the task's own folder (`<task>/runs/`) instead of the
// pre-095 global flat dir.
function defaultRunLogReader(task: Task): RunLogSnapshot | null {
  const path = latestRunLog(task);
  if (!path) return null;
  try {
    return { name: basename(path), text: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

// List every run log basename for a task, newest-first. Used by the
// `/t/<proj>/<slug>/runs` index. Empty when the task folder's runs/ dir
// is missing or the task has never been dispatched.
function defaultRunLogListReader(task: Task): string[] {
  return allRunLogs(task).map(p => basename(p));
}

// Read the raw bytes of a run log by basename, scoped to a specific task.
// The route layer ran `isValidRunLogName(name, task)` already, so the join
// below can't escape the task's runs/ dir.
function defaultRunLogRawReader(task: Task, name: string): string | null {
  if (!isValidRunLogName(name, task)) return null;
  // Reuse `allRunLogs(task)` to get the dir and find the file (rather than
  // re-deriving the dir here) — keeps the on-disk layout knowledge in
  // run_log.ts.
  const path = allRunLogs(task).find(p => basename(p) === name);
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Map a pre-095 flat-dir filename back to the per-task viewer URL. The
// legacy filename is `<encoded-slug>--<utc>.log`; we walk the project tree
// once and look up the task whose encoded qualified slug matches the
// prefix. Returns null when no task matches (a legacy file for a deleted
// task — caller surfaces 404). Pointed at by the back-compat `/runs/<file>`
// redirect; goes away once the redirect is removed.
function resolveLegacyRunLog(projects: Project[], legacyName: string): string | null {
  const sep = legacyName.indexOf("--");
  if (sep <= 0) return null;
  const encoded = legacyName.slice(0, sep);
  const tsAndExt = legacyName.slice(sep + 2);
  for (const p of projects) {
    for (const t of flatTasks(p.tasks)) {
      const qs = t.parent ? `${p.slug}/${t.parent}/${t.slug}` : `${p.slug}/${t.slug}`;
      if (encodeLegacySlug(qs) !== encoded) continue;
      const slugSegs = qs.split("/").map(encodeURIComponent).join("/");
      // For top-level tasks the new on-disk filename is just `<utc>.log`; for
      // children it's `<child-slug>--<utc>.log` (parent's runs/ is shared).
      const newBase = t.parent ? `${t.slug}--${tsAndExt}` : tsAndExt;
      return `/t/${slugSegs}/runs/${encodeURIComponent(newBase)}`;
    }
  }
  return null;
}

// Walks the lock dir once and returns a `qualifiedSlug -> { agentId, pid,
// acquired }` map for serve to render. Repo-level locks (`repo--<project>`)
// are skipped — they don't decorate task rows. Stale-lock filtering belongs
// to `tpm lock release-stale`, not here.
function snapshotTaskLocks(root: string): Map<string, TaskLockSnapshotEntry> {
  const m = new Map<string, TaskLockSnapshotEntry>();
  for (const e of listTaskLocks(root)) {
    if (e.qualifiedSlug.startsWith("repo--")) continue;
    m.set(e.qualifiedSlug, { agentId: e.data.agentId, pid: e.data.pid, acquired: e.data.acquired });
  }
  return m;
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

  // Optional `redirect` field: forms (e.g. the inbox play button) can send the
  // user back to a queue view instead of the task page. Validated against an
  // open-redirect allowlist before honoring.
  const override = redirectOverride(body.get("redirect"));

  const args = buildCliArgs(slugPath, action, body);
  if (!args) {
    return flashRedirect(slugPath, `bad request: missing required field for ${action}`, override);
  }
  const result = runner(args);
  const flash = result.ok
    ? (result.stdout || `${action}: ok`)
    : (result.stderr || `${action}: failed`);
  return flashRedirect(slugPath, flash, override);
}

function flashRedirect(slugPath: string, flash: string, override?: string | null): MutationResult {
  const segs = slugPath.split("/").map(encodeURIComponent).join("/");
  const target = override ?? `/t/${segs}`;
  return {
    status: 303,
    location: `${target}?flash=${encodeURIComponent(flash)}`,
  };
}

// Validate a form-supplied redirect target. Same-origin local paths only:
// starts with a single `/`, no `//` (protocol-relative), no `..` segments, no
// control chars. Same-origin POST check already gates the request, but we
// narrow what the form can name so a stray field can't bounce the browser off
// the dashboard.
function redirectOverride(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  if (raw.includes("..")) return null;
  if (/[\s\r\n\\]/.test(raw)) return null;
  // Strip any embedded query/fragment — the flash query param is appended by
  // `flashRedirect`, and accepting a pre-baked query opens the door to
  // overriding it with attacker text.
  const cleaned = raw.split(/[?#]/, 1)[0];
  return cleaned || null;
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
    case "lgtm": return ["lgtm", slug];
    case "archive": return ["archive", slug];
    case "request-changes": {
      const comment = body.get("comment")?.trim();
      if (!comment) return null;
      return ["request-changes", slug, comment];
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

function renderIndex(projects: Project[], projectFilter: string | null, prCache: PrCacheReader, taskLocks: Map<string, TaskLockSnapshotEntry>, flash?: string): string {
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

  const flashBanner = flash
    ? `<div class="flash">${esc(flash)} <a class="flash-dismiss" href="/">dismiss</a></div>`
    : "";

  const body = `
${projectChips(projects, null)}
${flashBanner}
<header>
  <h1>tpm</h1>
  <p class="meta">${esc(now())}  ·  ${projects.length} project${projects.length === 1 ? "" : "s"}</p>
  ${filterChip}
</header>
<section class="queue">
  <h2>Your inbox <span class="meta">(${inbox.length})</span></h2>
  ${inbox.length === 0 ? `<p class="queue-empty">Inbox empty.</p>` : inbox.map(it => taskRow(it.project, it.task, it.status, prCache, taskLocks, { showPromote: true })).join("")}
</section>
<section class="queue">
  <h2>Agent queue <span class="meta">(${agentItems.length})</span></h2>
  ${agentItems.length === 0 ? `<p class="queue-empty">Nothing ready, needing feedback, or awaiting close.</p>` : agentItems.map(it => taskRow(it.project, it.task, it.status, prCache, taskLocks)).join("")}
</section>
<section class="queue">
  <h2>In flight <span class="meta">(${inFlight.length})</span></h2>
  ${inFlight.length === 0 ? `<p class="queue-empty">No in-progress tasks.</p>` : inFlight.map(it => taskRow(it.project, it.task, "in-progress", prCache, taskLocks)).join("")}
</section>
`;
  return layout("tpm", body, { autoRefresh: 30 });
}

function renderProject(project: Project, allProjects: Project[], showArchived: boolean, prCache: PrCacheReader, taskLocks: Map<string, TaskLockSnapshotEntry>): string {
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
      const rows = group.map(t => taskRow(project, t, s, prCache, taskLocks)).join("");
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
<nav class="crumbs"><a href="/p/${esc(project.slug)}">${esc(project.slug)}</a></nav>
<header>
  <h1>${esc(projectName)} <span class="badge s-${cls(status)}">${esc(status)}</span></h1>
  <p class="meta"><code>${esc(project.slug)}</code>  ·  ${repoLink}  ·  ${tasks.length} task${tasks.length === 1 ? "" : "s"}${showArchived ? " (incl. archived)" : ""}</p>
  <p class="archive-toggle"><a href="${toggleHref}">${showArchived ? "[x]" : "[ ]"} ${toggleLabel}</a>  ·  <a href="/p/${esc(project.slug)}/artifacts">Artifacts →</a></p>
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

// ---- /p/<proj>/artifacts --------------------------------------------------

// Filter param for the artifacts index. "all" lists every task with at least
// one artifact; the narrower values show only PR-bearing or report-bearing
// rows. A task with both still renders both chip types — the filter narrows
// rows, not chips.
type ArtifactFilter = "all" | "pr" | "report";

function renderArtifacts(
  project: Project,
  allProjects: Project[],
  filter: ArtifactFilter,
  prCache: PrCacheReader,
): string {
  const projectName = strOr(project.data.name, project.slug);
  const tasks = flatTasks(project.tasks).filter(t => !isParent(t));

  interface ArtifactRow {
    task: Task;
    prs: string[];
    hasReport: boolean;
    lastMs: number;
  }
  const rows: ArtifactRow[] = [];
  for (const t of tasks) {
    const prs = (Array.isArray(t.data.prs) ? t.data.prs : []).map(String).filter(u => u.length > 0);
    const hasPr = prs.length > 0;
    const hasReport = taskHasReport(t);
    if (!hasPr && !hasReport) continue;
    if (filter === "pr" && !hasPr) continue;
    if (filter === "report" && !hasReport) continue;
    rows.push({ task: t, prs, hasReport, lastMs: lastActivityKey(t) });
  }
  rows.sort((a, b) => b.lastMs - a.lastMs);

  const filterNav = renderArtifactFilter(project.slug, filter);
  const main = rows.length === 0
    ? `<p class="config-empty">No artifacts yet. PRs and reports show up here once tasks ship.</p>`
    : rows.map(r => renderArtifactRow(project, r.task, r.hasReport, prCache)).join("");

  const body = `
${projectChips(allProjects, project.slug)}
<nav class="crumbs"><a href="/p/${esc(project.slug)}">${esc(project.slug)}</a><a href="/p/${esc(project.slug)}/artifacts">artifacts</a></nav>
<header>
  <h1>Artifacts — ${esc(projectName)}</h1>
  <p class="meta">PRs and reports per task. <a href="/p/${esc(project.slug)}">Back to project →</a></p>
  ${filterNav}
</header>
${main}
`;
  return layout(`tpm · ${projectName} · artifacts`, body);
}

function renderArtifactFilter(projectSlug: string, active: ArtifactFilter): string {
  const opts: Array<{ key: ArtifactFilter; label: string; query: string }> = [
    { key: "all", label: "All", query: "" },
    { key: "pr", label: "PRs", query: "?type=pr" },
    { key: "report", label: "Reports", query: "?type=report" },
  ];
  const chips = opts.map(o => {
    const href = `/p/${esc(projectSlug)}/artifacts${o.query}`;
    if (o.key === active) {
      return `<span class="chip active">${esc(o.label)}</span>`;
    }
    return `<a class="chip" href="${href}">${esc(o.label)}</a>`;
  }).join("");
  return `<nav class="artifact-filter">${chips}</nav>`;
}

function renderArtifactRow(
  project: Project,
  task: Task,
  hasReport: boolean,
  prCache: PrCacheReader,
): string {
  const slugPath = task.parent
    ? `${project.slug}/${task.parent}/${task.slug}`
    : `${project.slug}/${task.slug}`;
  const href = `/t/${slugPath.split("/").map(esc).join("/")}`;
  const title = strOr(task.data.title, task.slug);
  const status = rollupStatus(task);
  const classes = ["artifact-row"];
  if (task.archived) classes.push("archived");
  const archivedTag = task.archived ? `<span class="archived-tag">archived</span>` : "";
  const prChips = prChipsFor(task, prCache);
  const reportChip = hasReport
    ? `<a class="report-chip badge s-needs-review" href="${href}/report">[report]</a>`
    : "";
  return `<div class="${classes.join(" ")}">
    <span class="badge s-${cls(status)}${task.archived ? " s-archived" : ""}">${esc(status)}</span>
    <a class="title" href="${href}">${esc(title)}</a>
    <span class="slug">${esc(slugPath)}</span>
    ${archivedTag}
    <span class="artifact-chips">${prChips}${reportChip}</span>
  </div>`;
}

// Sort key for the artifacts index: most recent activity first. Prefers the
// latest task-body Log entry timestamp; falls back to Date.parse of `created`
// (best-effort — wall-clock formats like "2026-05-16 22:36 PDT" parse in V8).
// Tasks with neither return 0 and sink to the bottom.
function lastActivityKey(task: Task): number {
  const entries = parseTaskLogEntries(task.body);
  let best = -Infinity;
  for (const e of entries) {
    if (!e.timestamp) continue;
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  if (best > -Infinity) return best;
  const created = String(task.data.created ?? "");
  const ms = created ? Date.parse(created) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function renderTask(
  project: Project,
  task: Task,
  allProjects: Project[],
  opts: RouteOpts = {},
  prCache: PrCacheReader = (url) => readPrCache(url),
  taskLocks: Map<string, TaskLockSnapshotEntry> = new Map(),
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

  const flashBanner = opts.flash
    ? `<div class="flash">${esc(opts.flash)} <a class="flash-dismiss" href="${esc(taskHref(project, task))}">dismiss</a></div>`
    : "";

  const taskUrl = taskHref(project, task);

  const qualifiedSlug = task.parent
    ? `${project.slug}/${task.parent}/${task.slug}`
    : `${project.slug}/${task.slug}`;
  const lockEntry = taskLocks.get(qualifiedSlug) ?? null;
  const headerLockChip = lockChip(task, status, lockEntry !== null);
  // Holder line: surface PID / agent / acquired-stamp inline under the
  // status header so the operator can tell who is holding the lock without
  // pulling up `tpm lock list`. Gated on the same suppression rule as the
  // chip — terminal/archived tasks treat any remaining lock as hygiene,
  // not UI signal — so we skip the line when `headerLockChip` is empty.
  const lockHolderMeta = lockEntry && headerLockChip !== ""
    ? `<p class="meta lock-holder">Lock held by <code>${esc(lockEntry.agentId)}</code> (pid ${esc(String(lockEntry.pid))}, acquired ${esc(lockEntry.acquired)}).</p>`
    : "";

  const hasReport = taskHasReport(task);
  const logLink = renderTaskLogRailLink(taskUrl);
  const runsLink = renderTaskRunsRailLink(taskUrl);
  const reportPanel = hasReport ? renderTaskReportRailPanel(taskUrl) : "";
  const prPanel = renderPrPanel(prs, prCache);
  const actionsSection = renderActions(project, task, status, opts);
  const archiveSection = renderArchiveAction(project, task, status, opts);
  const settingsSection = renderSettings(project, task, status, opts);
  const railContent = `${logLink}${runsLink}${reportPanel}${prPanel}${actionsSection}${archiveSection}${settingsSection}`;
  const hasRail = railContent.length > 0;

  const body = `
${projectChips(allProjects, project.slug)}
${breadcrumbFor(project, task)}
${flashBanner}
<header>
  <h1>${esc(title)} <span class="badge s-${cls(status)}">${esc(status)}</span> ${headerLockChip}</h1>
  <p class="meta"><code>${esc(task.slug)}</code>  ·  type: ${esc(strOr(task.data.type, "?"))}  ·  project: <a href="/p/${esc(project.slug)}">${esc(project.slug)}</a></p>
  ${lockHolderMeta}
</header>
<div class="layout${hasRail ? "" : " no-rail"}">
  <aside class="sidebar">
    <dl>
      <dt>Status</dt><dd><span class="badge s-${cls(status)}">${esc(status)}</span> ${headerLockChip}</dd>
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
  </main>
  ${hasRail ? `<div class="task-rail">${railContent}</div>` : ""}
</div>
`;
  return layout(`tpm · ${title}`, body);
}

// ---- breadcrumbs ----------------------------------------------------------

// Single source of truth for the breadcrumb on every task-scoped page (task
// detail, /log, /runs, /report). Walks project → [parent] → task, mirroring
// the URL hierarchy; `suffix` (e.g. `"log"`, `"runs"`) appends a sub-resource
// crumb after the task. Home lives in the persistent masthead (task 105), so
// the breadcrumb opens on the project segment rather than repeating a home
// link on every page.
function breadcrumbFor(project: Project, task: Task, opts: { suffix?: string } = {}): string {
  const taskUrl = taskHref(project, task);
  const parts: string[] = [`<a href="/p/${esc(project.slug)}">${esc(project.slug)}</a>`];
  if (task.parent) {
    parts.push(`<a href="/t/${esc(project.slug)}/${esc(task.parent)}">${esc(task.parent)}</a>`);
  }
  parts.push(`<a href="${taskUrl}">${esc(task.slug)}</a>`);
  if (opts.suffix) {
    parts.push(`<a href="${taskUrl}/${esc(opts.suffix)}">${esc(opts.suffix)}</a>`);
  }
  return `<nav class="crumbs">${parts.join("")}</nav>`;
}

// ---- rail links: view log + view runs -------------------------------------

// "View log →" rail link pointing at the merged-log subroute (envelope +
// body Log, chronological). The task detail page stays lean — depth lives
// at /log, not inline on the detail page.
function renderTaskLogRailLink(taskUrl: string): string {
  return `<section class="task-log-link"><a href="${taskUrl}/log">View log →</a></section>`;
}

// "View runs →" rail link pointing at the per-task runs index. Replaces the
// inline "Last run" panel from task 057 — per-run logs are a sub-resource
// at /t/.../runs, not embedded on the task detail page.
function renderTaskRunsRailLink(taskUrl: string): string {
  return `<section class="task-runs-link"><a href="${taskUrl}/runs">View runs →</a></section>`;
}

// "Report →" rail panel pointing at `/t/<proj>/<slug>/report`. Mirrors the
// PR panel for investigation-shaped tasks: the deliverable lives off the
// task body, and the rail surfaces a one-click jump.
function renderTaskReportRailPanel(taskUrl: string): string {
  return `<section class="task-report"><h2>Report</h2><p><a href="${taskUrl}/report">View report →</a></p></section>`;
}

// `/t/<proj>/<slug>/report` — render the report markdown file as HTML. Falls
// back to a missing-file message rather than 404'ing so the operator can
// debug a missing report.md.
function renderTaskReport(projects: Project[], project: Project, task: Task, opts: RouteOpts = {}): string {
  const title = strOr(task.data.title, task.slug);
  const taskUrl = taskHref(project, task);
  const hasReport = taskHasReport(task);
  const actionsBar = renderReportActionsBar(project, task, hasReport, opts);

  let main: string;
  if (task.parent) {
    main = `<p class="config-empty">Child tasks don't have their own reports. Reparent to top-level (<code>tpm reparent ${esc(task.slug)} --top</code>) to attach one.</p>`;
  } else if (!hasReport) {
    main = `<p class="config-empty">No report attached. Run <code>tpm report ${esc(task.slug)}</code> to create one.</p>`;
  } else {
    const absPath = taskReportPath(task);
    let text = "";
    try { text = readFileSync(absPath, "utf8"); } catch (e) {
      main = `<p class="config-empty">Failed to read <code>${esc(absPath)}</code>: ${esc((e as Error).message)}</p>`;
      return layout(`tpm · ${title} · report`, wrapReport(projects, project, task, main, taskUrl, actionsBar));
    }
    // Drop HTML-comment placeholders (e.g. the template's `<!-- One paragraph… -->`)
    // so the rendered view shows only what the agent has filled in. Markdown
    // body text stays untouched.
    const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
    main = `<div class="body">${renderMarkdown(stripped)}</div>`;
  }
  return layout(`tpm · ${title} · report`, wrapReport(projects, project, task, main, taskUrl, actionsBar));
}

// Sticky LGTM / Request-changes bar at the top of the report page. The bar is
// where the reviewer's attention is when they decide — task 083 moved these
// verbs off the task rail to remove the back-and-forth context switch. Gated
// on needs-review + a report file: other statuses (in-progress, done, etc.)
// shouldn't surface review verbs at all.
function renderReportActionsBar(project: Project, task: Task, hasReport: boolean, opts: RouteOpts): string {
  if (opts.mutationsEnabled === false) return "";
  if (task.archived) return "";
  if (!hasReport) return "";
  if (rollupStatus(task) !== "needs-review") return "";
  const href = taskHref(project, task);
  return `<div class="report-actions-bar">
  ${lgtmForm(href)}
  ${requestChangesForm(href)}
</div>`;
}

function wrapReport(projects: Project[], project: Project, task: Task, main: string, taskUrl: string, actionsBar: string): string {
  const title = strOr(task.data.title, task.slug);
  return `
${projectChips(projects, project.slug)}
${breadcrumbFor(project, task, { suffix: "report" })}
${actionsBar}
<header>
  <h1>Report — ${esc(title)}</h1>
  <p class="meta">Investigation deliverable.  ·  <a href="${taskUrl}">Back to task →</a></p>
</header>
${main}
`;
}

// ---- /config page ---------------------------------------------------------

// Read-only view of the two ~/.tpm JSON files driving harness behavior. Pairs
// an interpretive `dl` (the fields people actually care about, with defaults
// from `src/defaults` / `src/config.ts` filled in) with the raw pretty-printed
// JSON for everything else.
function renderConfig(projects: Project[], cfg: ConfigSnapshot, agents: ConfigSnapshot): string {
  const body = `
${projectChips(projects, null, "config")}
<nav class="crumbs"><a href="/config">config</a></nav>
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

// ---- /logs page -----------------------------------------------------------

interface LogsViewOpts {
  taskFilter?: string;
  tail: number;
  // Which tail chip is highlighted on the page. Derived alongside `tail` from
  // `?lines=`; "custom" hides the chip selection when the operator passes an
  // arbitrary N that doesn't match one of the canned options.
  tailMode: TailMode;
  // Task body Log entries to merge with envelope output. Non-empty only when
  // `taskFilter` resolved to a real task; otherwise the page renders the
  // legacy per-source panels.
  taskLog?: HarnessLogLine[];
}

type TailMode = "200" | "1000" | "all" | "custom";

// Clamp `?lines=N` to [1, LOGS_MAX_TAIL] and also resolve the chip-row mode.
// `all` is the sentinel for "no cap" (value 0 — `tailFile` treats non-positive
// `lines` as unlimited). Non-numeric / out-of-range values fall back to the
// default — the param is for ad-hoc deeper digs, not a security boundary, but
// unbounded N would let a curl pull arbitrarily much memory.
function parseTailParam(raw: string | null): { value: number; mode: TailMode } {
  if (raw === null) return { value: LOGS_DEFAULT_TAIL, mode: "200" };
  if (raw === "all") return { value: 0, mode: "all" };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return { value: LOGS_DEFAULT_TAIL, mode: "200" };
  const clamped = Math.min(n, LOGS_MAX_TAIL);
  if (clamped === 200) return { value: 200, mode: "200" };
  if (clamped === 1000) return { value: 1000, mode: "1000" };
  return { value: clamped, mode: "custom" };
}

// Categories used to split the harness logs across pages. The prefix matches
// the on-disk file naming established in `discoverLogPaths`.
type LogCategory = "orchestrate" | "poller";

const CATEGORIES: Record<LogCategory, { label: string; prefix: string; route: string }> = {
  orchestrate: { label: "Orchestrator", prefix: "orchestrator-", route: "/logs/orchestrate" },
  poller: { label: "Poller", prefix: "recurring-", route: "/logs/poller" },
};

function filterByCategory(sources: HarnessLogSource[], category: LogCategory): HarnessLogSource[] {
  const prefix = CATEGORIES[category].prefix;
  return sources.filter(s => s.name.startsWith(prefix));
}

function renderCategoryPage(
  projects: Project[],
  params: URLSearchParams,
  opts: RouteOpts,
  category: LogCategory,
): RouteResult {
  const reader = opts.harnessLog ?? defaultHarnessLogReader;
  const tail = parseTailParam(params.get("lines"));
  const sources = filterByCategory(reader({ lines: tail.value }), category);
  return ok("text/html; charset=utf-8", renderLogsCategory(projects, sources, {
    tail: tail.value,
    tailMode: tail.mode,
  }, category));
}

function renderLogsLanding(projects: Project[], sources: HarnessLogSource[]): string {
  const cards = (Object.keys(CATEGORIES) as LogCategory[])
    .map(c => renderCategoryCard(c, filterByCategory(sources, c)))
    .join("");
  const body = `
${projectChips(projects, null, "logs")}
<nav class="crumbs"><a href="/logs">logs</a></nav>
<header>
  <h1>Harness logs</h1>
  <p class="meta">Envelope logs from <code>~/.tpm/</code>, split by source. Pick a stream below. Auto-refreshes every 5s.</p>
</header>
<section class="log-cards">${cards}</section>
<p class="meta">Per-task logs live at <code>/t/&lt;proj&gt;/&lt;slug&gt;/log</code> — open a task and click <em>View log</em> in the rail for the merged chronological view of its envelope + body-Log entries.</p>
`;
  return layout("tpm · logs", body, { autoRefresh: 5 });
}

function renderCategoryCard(category: LogCategory, sources: HarnessLogSource[]): string {
  const { label, route } = CATEGORIES[category];
  if (sources.length === 0) {
    return `<article class="log-card log-card-empty">
  <h2><a href="${route}">${esc(label)}</a></h2>
  <p class="log-empty">No log files discovered yet.</p>
</article>`;
  }
  const totalLines = sources.reduce((sum, s) => sum + s.totalLines, 0);
  const fileCount = sources.length;
  // Pick the most recent timestamp across all files in this category. Each
  // source's `lines` here is the last one only (reader was called with
  // lines: 1), so a single pass suffices.
  let latest: HarnessLogLine | null = null;
  let latestPath = "";
  let latestParsed = -Infinity;
  for (const s of sources) {
    const line = s.lines[s.lines.length - 1];
    if (!line) continue;
    const ts = line.timestamp ? Date.parse(line.timestamp) : NaN;
    // Lines without a parseable timestamp fall back to file order: prefer
    // any earlier match over an unstamped line. Otherwise pick the newest.
    if (Number.isFinite(ts) && ts > latestParsed) {
      latest = line;
      latestPath = s.path;
      latestParsed = ts;
    } else if (!latest) {
      latest = line;
      latestPath = s.path;
    }
  }
  const fileSummary = fileCount === 1
    ? `${totalLines} line${totalLines === 1 ? "" : "s"} in <code>${esc(sources[0].path)}</code>`
    : `${totalLines} lines across ${fileCount} files`;
  const lastEntry = latest
    ? `<p class="log-card-last">Last entry: <code>${esc(latest.timestamp ?? "?")}</code> ${esc(latest.level ?? "")} ${esc(latest.script ?? "")} ${esc(latest.message ?? latest.raw)}</p>`
    : `<p class="log-empty">No entries yet.</p>`;
  const pathHint = fileCount > 1 && latest
    ? `<p class="log-meta">From <code>${esc(latestPath)}</code></p>`
    : "";
  return `<article class="log-card">
  <h2><a href="${route}">${esc(label)}</a></h2>
  <p class="log-meta">${fileSummary}</p>
  ${lastEntry}
  ${pathHint}
</article>`;
}

function renderLogsCategory(
  projects: Project[],
  sources: HarnessLogSource[],
  opts: LogsViewOpts,
  category: LogCategory,
): string {
  const { label, route } = CATEGORIES[category];
  const panels = sources.length === 0
    ? `<p class="config-empty">No ${esc(label.toLowerCase())} log files found under <code>~/.tpm/</code>. Logs appear once <code>tpm orchestrate</code> or a recurring script has run.</p>`
    : sources.map(s => renderLogPanel(s, opts)).join("");
  const body = `
${projectChips(projects, null, "logs")}
<nav class="crumbs"><a href="/logs">logs</a><a href="${route}">${esc(label.toLowerCase())}</a></nav>
<header>
  <h1>${esc(label)} logs</h1>
  <p class="meta">Tail of the ${esc(label.toLowerCase())} envelope logs from <code>~/.tpm/</code>. Auto-refreshes every 5s.</p>
</header>
${renderTailChips(route, opts.tailMode)}
${panels}
`;
  return layout(`tpm · ${label.toLowerCase()} logs`, body, { autoRefresh: 5 });
}

// Per-task log subpage: `/t/<proj>/<slug>/log` (or `.../<parent>/<child>/log`).
// Merges envelope lines filtered by the task's qualified slug with the task
// body's `## Log` entries, sorted chronologically. Falls back to per-source
// panels when the body has no Log entries (envelope-only view is still
// useful), or an empty message when neither has anything yet.
function renderTaskLog(
  projects: Project[],
  project: Project,
  task: Task,
  sources: HarnessLogSource[],
  opts: LogsViewOpts,
): string {
  let panels: string;
  if (opts.taskLog && opts.taskLog.length > 0) {
    panels = renderMergedLogs(sources, opts);
  } else if (sources.length === 0) {
    panels = `<p class="config-empty">No log entries for this task yet. Envelope logs appear under <code>~/.tpm/</code> once <code>tpm orchestrate</code> or the PR poller acts on this slug; body-Log entries appear when a CLI verb (or a manual <code>tpm log</code>) writes one.</p>`;
  } else {
    panels = sources.map(s => renderLogPanel(s, opts)).join("");
  }
  const title = strOr(task.data.title, task.slug);
  const taskUrl = taskHref(project, task);
  const logPath = `${taskUrl}/log`;
  const body = `
${projectChips(projects, project.slug)}
${breadcrumbFor(project, task, { suffix: "log" })}
<header>
  <h1>Log — ${esc(title)}</h1>
  <p class="meta">Merged envelope + task-body Log entries for <code>${esc(opts.taskFilter ?? "")}</code>. <a href="${taskUrl}">Back to task →</a>  ·  Auto-refreshes every 5s.</p>
</header>
${renderTailChips(logPath, opts.tailMode)}
${panels}
`;
  return layout(`tpm · ${title} · log`, body, { autoRefresh: 5 });
}

// Per-task merged panel: every envelope line from every discovered source
// plus the task body's `## Log` entries, sorted chronologically. Date.parse
// is the sort key (not lex order) so pre-task-061 `Z`-suffixed entries land
// in the right place relative to the post-061 offset-bearing entries.
function renderMergedLogs(sources: HarnessLogSource[], opts: LogsViewOpts): string {
  const envelope = sources.flatMap(s => s.lines);
  const merged = [...envelope, ...(opts.taskLog ?? [])]
    .filter(l => l.timestamp)
    .sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!));
  if (merged.length === 0) {
    return `<section class="log-panel">
  <h2>All events for <code>${esc(opts.taskFilter!)}</code></h2>
  <p class="log-empty">No log entries for this task yet.</p>
</section>`;
  }
  return `<section class="log-panel">
  <h2>All events for <code>${esc(opts.taskFilter!)}</code></h2>
  <p class="log-meta">Merged from harness envelope logs and the task body's <code>## Log</code> section.</p>
  <ol class="log-lines">${merged.map(renderLogLine).join("")}</ol>
</section>`;
}

function renderLogPanel(source: HarnessLogSource, opts: LogsViewOpts): string {
  const truncated = source.totalLines > source.lines.length
    ? `<p class="log-meta">Showing the last ${source.lines.length} of ${source.totalLines} line${source.totalLines === 1 ? "" : "s"}${opts.taskFilter ? " matching the filter" : ""}.</p>`
    : "";
  let inner: string;
  if (!source.exists) {
    inner = `<p class="log-empty">No log file at <code>${esc(source.path)}</code>.</p>`;
  } else if (source.lines.length === 0) {
    const note = opts.taskFilter
      ? `No lines match <code>${esc(opts.taskFilter)}</code> in this file.`
      : "Log file is empty.";
    inner = `<p class="log-empty">${note}</p>`;
  } else {
    inner = `<ol class="log-lines">${source.lines.map(renderLogLine).join("")}</ol>`;
  }
  return `<section class="log-panel">
  <h2>${esc(source.name)} <span class="meta">${esc(source.path)}</span></h2>
  ${truncated}
  ${inner}
</section>`;
}

function renderLogLine(line: HarnessLogLine): string {
  if (line.source === "task-log") {
    // Task-body Log entry: no level chip. The meta row carries the timestamp
    // and a `task-log` source badge; the message wraps full-width below it
    // (no fixed column layout, so long messages don't get clipped).
    return `<li class="log-line log-line-task-log">
    <div class="log-meta-row">
      <span class="log-ts">${esc(line.timestamp ?? "")}</span>
      <span class="log-script log-source-task-log">${esc(line.script ?? "task-log")}</span>
    </div>
    <span class="log-msg">${esc(line.message ?? "")}</span>
  </li>`;
  }
  if (!line.level) {
    // Free-form / pre-task-042 output. Surface verbatim, no level chip, no
    // forced indent — the row is just the raw text, wrapping like the
    // structured message column.
    return `<li class="log-line log-line-raw"><span class="log-raw">${esc(line.raw)}</span></li>`;
  }
  const levelClass = `log-level-${line.level.toLowerCase()}`;
  return `<li class="log-line">
    <div class="log-meta-row">
      <span class="log-ts">${esc(line.timestamp ?? "")}</span>
      <span class="log-level ${levelClass}">${esc(line.level)}</span>
      <span class="log-script">${esc(line.script ?? "")}</span>
    </div>
    <span class="log-msg">${esc(line.message ?? "")}</span>
  </li>`;
}

// Tail-size chip row: 200 / 1000 / all. The active mode renders as a span so
// it isn't a no-op link; the others are anchors pointing at the same path with
// the relevant `?lines=` value. `currentPath` is the route the chips live on
// (e.g. `/logs/orchestrate` or `/t/<proj>/<slug>/log`) so the hrefs round-trip.
function renderTailChips(currentPath: string, mode: TailMode): string {
  const chip = (label: string, target: TailMode, hrefValue: string): string => {
    if (mode === target) {
      return `<span class="log-tail-chip active">${esc(label)}</span>`;
    }
    return `<a class="log-tail-chip" href="${esc(currentPath)}?lines=${esc(hrefValue)}">${esc(label)}</a>`;
  };
  return `<div class="log-tail-controls">
    <span class="log-tail-label">Tail:</span>
    ${chip("200", "200", "200")}
    ${chip("1000", "1000", "1000")}
    ${chip("all", "all", "all")}
  </div>`;
}

// ---- per-task /runs subpage -----------------------------------------------

// Index for `/t/<proj>/<slug>/runs`. Lists every run log discovered for the
// task (newest-first) and renders the latest one inline using the same parsed
// transcript view that lived on the task detail page before task 075. Each
// older run is a link to the per-task raw viewer at
// `/t/<proj>/<slug>/runs/<basename>` (task 095 moved this off the flat
// `/runs/<file>` path).
function renderTaskRuns(
  projects: Project[],
  project: Project,
  task: Task,
  runs: string[],
  runLog: RunLogReader,
  slugPath: string,
): string {
  const title = strOr(task.data.title, task.slug);
  const taskUrl = taskHref(project, task);
  const status = rollupStatus(task);
  const slugSegs = slugPath.split("/").map(encodeURIComponent).join("/");
  // The latest run renders inline (the most useful per-task page on a live
  // task is "what did the last run do"). Older runs are link-only — clicking
  // opens the per-task raw viewer.
  const latestPanel = renderRunPanel(task, slugSegs, status, runLog);
  let listSection = "";
  if (runs.length === 0) {
    listSection = `<section class="task-runs-list">
  <h2>All runs</h2>
  <p class="run-empty">No run logs on disk yet — this task hasn't been dispatched by <code>tpm orchestrate</code>.</p>
</section>`;
  } else {
    const items = runs.map(name => {
      const ts = runLogDisplayTimestamp(name);
      return `<li><a href="/t/${slugSegs}/runs/${encodeURIComponent(name)}">${esc(name)}</a> <span class="run-list-ts">${esc(ts)}</span></li>`;
    }).join("");
    listSection = `<section class="task-runs-list">
  <h2>All runs <span class="meta">(${runs.length})</span></h2>
  <ol class="run-list">${items}</ol>
</section>`;
  }
  // Auto-refresh while in-progress so an operator camped on `/runs` sees the
  // live run stream update without manual reload. Cadence matches the task
  // detail page's old refresh from task 057.
  const autoRefresh = status === "in-progress" ? 10 : undefined;
  const body = `
${projectChips(projects, project.slug)}
${breadcrumbFor(project, task, { suffix: "runs" })}
<header>
  <h1>Runs — ${esc(title)}</h1>
  <p class="meta">Per-run transcripts captured by <code>tpm orchestrate</code>. <a href="${taskUrl}">Back to task →</a></p>
</header>
${latestPanel}
${listSection}
`;
  return layout(`tpm · ${title} · runs`, body, { autoRefresh });
}

// On-disk run-log filenames: top-level is `<utc>.log`, child is
// `<child-slug>--<utc>.log`. Either way the UTC suffix is the same shape;
// match against the trailing timestamp so both layouts render the same
// human-readable hint. Best-effort — empty string when the suffix doesn't
// match (a hand-placed file, etc.).
function runLogDisplayTimestamp(name: string): string {
  const m = name.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}Z\.log$/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`;
}

// ---- run panel ------------------------------------------------------------

// How many events of the parsed transcript to render. The file itself can be
// huge for a long run, but the panel is a tail — older events fall off. The
// raw file is one click away via the "View raw log" link.
const RUN_PANEL_EVENTS = 60;

function renderRunPanel(task: Task, slugSegs: string, status: string, runLog: RunLogReader): string {
  const snapshot = runLog(task);
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
  const { events, parsed, skipped } = parseRunLog(snapshot.text);
  const tail = events.slice(-RUN_PANEL_EVENTS);
  const rendered = tail.length === 0
    ? `<p class="run-empty">Log file is empty — the agent hasn't written anything yet.</p>`
    : `<ol class="run-events">${tail.map(renderRunEvent).join("")}</ol>`;
  const truncated = events.length > tail.length
    ? `<p class="run-meta">Showing the last ${tail.length} of ${events.length} events.</p>`
    : "";
  const warning = skipped > 0
    ? `<p class="run-warning">${parsed} events parsed, ${skipped} skipped — file may have been truncated or partially written.</p>`
    : "";
  const rawLink = `<p class="run-meta"><a href="/t/${slugSegs}/runs/${encodeURIComponent(snapshot.name)}">View raw log →</a></p>`;
  return `<section class="run-panel">
  <h2>${esc(label)} <span class="meta">${esc(snapshot.name)}</span></h2>
  ${warning}
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

  // Status -> set of action keys. Every non-terminal status offers `Complete`
  // (terminal/parent already returned above): closing is a first-class UI
  // action so investigations / spikes / chores without a linked PR can be
  // closed without dropping to `tpm complete` in the shell. The Outcome
  // textarea is optional — close-now-edit-later stays possible.
  switch (status) {
    case "open":
      forms.push(simpleForm(href, "ready", "Promote to ready"));
      forms.push(blockForm(href));
      forms.push(completeForm(href));
      forms.push(dropForm(href));
      break;
    case "ready":
      forms.push(blockForm(href));
      forms.push(simpleForm(href, "reopen", "Move back to open"));
      forms.push(completeForm(href));
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
    case "needs-review": {
      // Report-shaped reviews surface LGTM + Request-changes on the report
      // page itself (see `renderReportActionsBar`) — the reviewer's attention
      // is there, not on the task page. The rail keeps log/block/reopen as
      // escape hatches for both report-shaped and PR-shaped reviews, plus a
      // direct Complete for closing a review out without going through LGTM
      // (e.g. a PR-shaped review the poller hasn't swept yet).
      forms.push(logForm(href));
      forms.push(completeForm(href));
      forms.push(blockForm(href));
      forms.push(statusForm(href, "needs-feedback", "Reopen for agent (→ needs-feedback)"));
      break;
    }
    case "blocked":
      forms.push(simpleForm(href, "reopen", "Reopen (→ open)"));
      forms.push(completeForm(href));
      break;
    default:
      // Unknown status (corrupt / future schema): fall back to log + close so
      // the user can at least annotate or retire the task from the UI.
      forms.push(logForm(href));
      forms.push(completeForm(href));
  }

  return `<section class="task-actions"><h2>Actions</h2>${forms.join("")}</section>`;
}

// Archive button for terminal (done/dropped) tasks that aren't already
// archived. Separate from renderActions because archiving isn't a status
// transition — it retires an already-closed task off the canonical path (the
// explicit "ok, I'm done with this investigation, archive it" step). type: pr
// and type: chore already archive on `tpm complete`, so this button is the
// affordance for investigations/spikes that intentionally finish at `done`.
// renderActions returns "" for terminal status; this fills exactly that gap.
// Parents with live children are refused server-side (archiveTask); the error
// surfaces via the flash banner rather than being hidden here.
function renderArchiveAction(project: Project, task: Task, status: string, opts: RouteOpts): string {
  if (opts.mutationsEnabled === false) return ""; // the disabled notice from renderActions already covers it
  if (task.archived) return ""; // already archived: nothing to do
  if (status !== "done" && status !== "dropped") return ""; // only terminal tasks can be archived
  const href = taskHref(project, task);
  return `<section class="task-actions"><h2>Archive</h2>${archiveForm(href)}</section>`;
}

// Per-task config toggles. Lives outside renderActions because settings are
// not transitions: they apply regardless of which queue the task is in, so
// they shouldn't be gated by status the way action verbs are.
function renderSettings(project: Project, task: Task, status: string, opts: RouteOpts): string {
  if (opts.mutationsEnabled === false) return ""; // covered by the disabled-actions notice
  if (task.archived) return "";
  if (isParent(task)) return "";
  if (status === "done" || status === "dropped") return ""; // terminal: toggle has no effect
  // `open` tasks aren't claimable regardless of the flag (the queue gate skips
  // anything not ready/needs-feedback/stranded), and "Promote to ready" already
  // sets allow_orchestrator: true — so a separate "Enable autonomous" toggle
  // here is the exact two-clicks-for-one-intent friction this change removes.
  // The toggle returns once the task is promoted, for the supervised-only
  // override (disable after ready).
  if (status === "open") return "";

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

function lgtmForm(href: string): string {
  return `<form method="POST" action="${href}/lgtm" class="action-form">
    <button type="submit">LGTM (close — derive Outcome from report)</button>
  </form>`;
}

function requestChangesForm(href: string): string {
  return `<form method="POST" action="${href}/request-changes" class="action-form">
    <label>Request changes (appended to <code>## Reviewer feedback</code>)
      <textarea name="comment" rows="3" required placeholder="what needs to change"></textarea>
    </label>
    <button type="submit">Request changes</button>
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

function archiveForm(href: string): string {
  return `<form method="POST" action="${href}/archive" class="action-form">
    <button type="submit">Archive (move to tasks/archive/)</button>
  </form>`;
}

// ---- helpers --------------------------------------------------------------

interface TaskRowOpts {
  // Render an inline "promote to ready" button for open/blocked rows. Only the
  // inbox section opts in — task 110: one-click promote without leaving the
  // landing page. needs-review rows skip the button because the dominant action
  // there is "Reopen for agent (→ needs-feedback)" on the task page (task 088),
  // and a one-click promote-to-ready would silently mis-route a review bounce
  // through the wrong queue.
  showPromote?: boolean;
}

function taskRow(project: Project, task: Task, status: string, prCache: PrCacheReader, taskLocks: Map<string, TaskLockSnapshotEntry>, opts: TaskRowOpts = {}): string {
  const slug = task.parent
    ? `${project.slug}/${task.parent}/${task.slug}`
    : `${project.slug}/${task.slug}`;
  const href = `/t/${slug.split("/").map(esc).join("/")}`;
  const title = strOr(task.data.title, task.slug);
  const when = task.archived
    ? strOr(task.data.closed, strOr(task.data.created, ""))
    : strOr(task.data.created, "");
  const classes = ["task-row"];
  if (task.archived) classes.push("archived");
  const archivedTag = task.archived ? `<span class="archived-tag">archived</span>` : "";
  // Child rows live in status-grouped queues where the parent isn't adjacent,
  // so an indent has nothing to anchor to (task 098). Show the parent slug as a
  // breadcrumb prefix instead — the hierarchy reads without visual adjacency,
  // and the crumb links straight to the parent.
  const titleCell = task.parent
    ? `<span class="title-cell"><a class="parent-crumb" href="/t/${esc(project.slug)}/${esc(task.parent)}">${esc(task.parent)}</a><a class="title" href="${href}">${esc(title)}</a></span>`
    : `<a class="title" href="${href}">${esc(title)}</a>`;
  const promote = promoteButton(href, task, status, opts);
  return `<div class="${classes.join(" ")}">
    ${promote}
    <span class="badge s-${cls(status)}${task.archived ? " s-archived" : ""}">${esc(status)}</span>
    ${lockChip(task, status, taskLocks.has(slug))}
    ${titleCell}
    ${prChipsFor(task, prCache)}
    <span class="slug">${esc(slug)}</span>
    ${archivedTag}
    <span class="when">${esc(when)}</span>
  </div>`;
}

// Inbox "play" affordance — one-click promote-to-ready without leaving the
// landing page (task 110). Only rendered when the caller opts in
// (`showPromote`) and the row is in a status where promote-to-ready makes
// sense. Defensive guards repeat the inbox's own filter (no archived, no
// parents, no terminal) so the button can't escape into unsafe contexts if a
// future caller passes `showPromote: true` without those filters upstream.
function promoteButton(href: string, task: Task, status: string, opts: TaskRowOpts): string {
  if (!opts.showPromote) return "";
  if (task.archived) return "";
  if (isParent(task)) return "";
  // open: deliberate "skip discuss" fast-path. blocked: blocker resolved,
  // bounce back. needs-review: skipped — see TaskRowOpts comment above.
  const fastPath = status === "open";
  if (status !== "open" && status !== "blocked") return "";
  const cls = fastPath ? "promote-form promote-fast" : "promote-form";
  const label = fastPath ? "Promote (skip discuss)" : "Promote to ready";
  return `<form method="POST" action="${href}/ready" class="${cls}">
    <input type="hidden" name="redirect" value="/">
    <button type="submit" title="${esc(label)}" aria-label="${esc(label)}">▶</button>
  </form>`;
}

// Renders the per-task lock indicator next to a status badge. Truth comes
// from the lock dir, not the frontmatter, so the UI catches both stranded
// `in-progress` tasks (status stuck but the lock is gone) and claimed-
// but-not-yet-flipped tasks (orchestrator took the lock before the agent
// ran `tpm start`). Suppressed on terminal/archived rows: a stale lock on a
// done task is hygiene, not a UI signal.
function lockChip(task: Task, status: string, locked: boolean): string {
  if (task.archived) return "";
  if (status === "done" || status === "dropped") return "";
  if (locked) {
    return `<span class="lock-chip lock-chip-working" title="agent holds the per-task lock">working</span>`;
  }
  if (status === "in-progress") {
    return `<span class="lock-chip lock-chip-unclaimed" title="status is in-progress but no agent lock is held — stranded">unclaimed</span>`;
  }
  return "";
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

// Inline list of project links shown above the page header. Split into two
// clusters: project chips on the left (the current project, if any, renders as
// a non-link "active" chip), and the tracker-wide "logs" + "config" views
// pinned to the right. The right cluster is a different category — operator
// views, not projects — so it reads as its own group rather than two more
// project chips inline.
function projectChips(projects: Project[], activeSlug: string | null, activeView?: "config" | "logs"): string {
  const chips = projects.map(p => {
    if (p.slug === activeSlug) {
      return `<span class="chip active">${esc(strOr(p.data.name, p.slug))}</span>`;
    }
    return `<a class="chip" href="/p/${esc(p.slug)}">${esc(strOr(p.data.name, p.slug))}</a>`;
  });
  const logsChip = activeView === "logs"
    ? `<span class="chip chip-logs active">logs</span>`
    : `<a class="chip chip-logs" href="/logs">logs</a>`;
  const configChip = activeView === "config"
    ? `<span class="chip chip-config active">config</span>`
    : `<a class="chip chip-config" href="/config">config</a>`;
  return `<nav class="project-chips">`
    + `<div class="chip-group chip-group-projects">${chips.join("")}</div>`
    + `<div class="chip-group chip-group-views">${logsChip}${configChip}</div>`
    + `</nav>`;
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
<body>
<header class="site-header"><a class="home" href="/">tpm</a></header>
${body}</body>
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
