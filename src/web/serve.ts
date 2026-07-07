import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flatTasks, loadProjects, rollupStatus } from "../core/tree.ts";
import type { Project, Task } from "../core/tree.ts";
import { findRoot } from "../core/root.ts";
import { execCommand } from "../core/commands.ts";
import { onStatusChange } from "../core/mutate.ts";
import { routeApi, routeApiMutation } from "./api.ts";
export type { CliRunner } from "./api.ts";
import { findTask, findTasksByNumericId } from "../core/resolve.ts";
import { readPrCache } from "../core/orchestrate/pr_cache.ts";
import {
  allRunLogs,
  encodeLegacySlug,
  isLegacyRunLogName,
  isValidRunLogName,
  latestRunLog,
  parseRunLog,
} from "../core/orchestrate/run_log.ts";
import type { RunEvent } from "../core/orchestrate/run_log.ts";
import type { AgentOutputFormat } from "../core/agent_cli.ts";
import { CONFIG_PATH, DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT } from "../core/config.ts";
import type { HarnessSnapshot } from "../core/orchestrate/supervisor.ts";
import { appendStatusEvent, eventsPath, readJournalLinesFrom, readRecentEvents, setActorOverride } from "../core/events.ts";
import { listTaskLocks } from "../core/orchestrate/lock.ts";
import { defaultHarnessLogReader } from "../core/harness_log.ts";
import { taskPath } from "./serve_url.ts";

// `tpm serve` is the SPA's data plane. The React app (web/, served statically
// at /app) owns every page; this module serves:
//   - the static SPA bundle (+ the / -> /app hop and legacy-path redirects,
//     so pre-SPA bookmarks and notification deep links keep resolving);
//   - the JSON API (routeApi/routeApiMutation in api.ts, plus the run-log
//     endpoints below, which live here because the run-log readers do);
//   - the /events SSE stream tailing the status journal.
// The server-rendered HTML pages ("classic") were deleted once the SPA
// reached parity — task 162. Mutations run through the in-process command
// layer and only register when bound to loopback.

// ---- reader seams (tests inject; production reads disk) ---------------------

export interface RunLogSnapshot {
  name: string;
  text: string;
}
export type RunLogReader = (task: Task) => RunLogSnapshot | null;

// A direct read by basename for the `/t/<proj>/<slug>/runs/<basename>` raw
// route. Returns the raw file contents, or null if the file is missing or
// the name is rejected by the path-traversal guard.
export type RunLogRawReader = (task: Task, name: string) => string | null;

// Lists every run log for a task, newest-first as bare basenames.
export type RunLogListReader = (task: Task) => string[];

// Incremental tail for the live-transcript endpoint.
export type RunLogTailReader = (task: Task, name: string, offset: number) => { lines: string[]; offset: number } | null;

// Snapshot of one held per-task lock (agent id, pid, acquired stamp).
export interface TaskLockSnapshotEntry {
  agentId: string;
  pid: number;
  acquired: string;
}

// A read-only view of `~/.tpm/config.json` for the config page. `missing` is
// distinguished from `error` so the UI can render a "no file yet" hint
// instead of a parse-error block.
export interface ConfigSnapshot {
  path: string;
  raw: string;
  parsed: unknown | null;
  error: string | null;
  missing: boolean;
}

export interface ServeOpts {
  host?: string;
  port?: number;
  // Live harness snapshot getter, wired by `tpm up` when the poll loop and
  // orchestrate pool run in this same process. Plain `tpm serve` leaves it
  // unset and /api/harness reports {running: false}.
  harness?: () => HarnessSnapshot | null;
}

export async function runServe(opts: ServeOpts = {}): Promise<void> {
  // Mutations run in-process, so this process must journal them the way a
  // spawned CLI child used to journal its own. The CLI entry registers the
  // same listener at module load; re-registering here (identical behavior)
  // covers programmatic embedders that import runServe directly.
  onStatusChange(change => appendStatusEvent(findRoot(), change));
  const host = opts.host ?? DEFAULT_SERVE_HOST;
  const port = opts.port ?? DEFAULT_SERVE_PORT;
  const mutationsEnabled = isLoopback(host);

  // handleRequest is async: without this catch, any throw inside it (a tree
  // parse error, a missing config) becomes an unhandled rejection and kills
  // the daemon. Surface it as a 500 instead — found by the e2e suite's very
  // first run, whose readiness probe hit the server before its tree existed.
  const server = createServer((req, res) => {
    handleRequest(req, res, { host, mutationsEnabled, harness: opts.harness }).catch((e: unknown) => {
      try {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`500: ${e instanceof Error ? e.message : String(e)}`);
      } catch {
        // headers already sent — nothing more to do
      }
    });
  });
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
  harness?: () => HarnessSnapshot | null;
}

// ── Server-sent events (`/events`) ──────────────────────────────────────────
// One stream per browser tab. Two sources fan into it:
//   - the status-transition journal (<root>/.tpm/events.ndjson) — tailed by
//     offset, so a flip made by ANY process (cron orchestrate, a manual
//     `tpm done`, an agent's `tpm pr`) reaches the UI within a second;
//   - in-process harness pulses (`broadcastSse` from `tpm up`'s supervisor).
// Tail-by-polling (1s stat) rather than fs.watch: the tree may live in
// Dropbox/iCloud where watch events are unreliable, and one stat per second
// is free. Only whole lines are forwarded; a partially-flushed last line
// stays buffered until its newline lands.
const SSE_TAIL_INTERVAL_MS = 1_000;
const SSE_HEARTBEAT_MS = 25_000;
const sseClients = new Set<ServerResponse>();
let sseTailTimer: ReturnType<typeof setInterval> | null = null;
let sseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sseOffset = -1; // -1 = first pump: start at EOF, don't replay history

export function broadcastSse(event: string, data: string): void {
  const payload = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function pumpSseTail(journalPath: string): void {
  if (sseClients.size === 0) return;
  const { lines, offset } = readJournalLinesFrom(journalPath, sseOffset);
  sseOffset = offset;
  for (const line of lines) broadcastSse("status", line);
}

function stopSseTimers(): void {
  if (sseTailTimer) clearInterval(sseTailTimer);
  if (sseHeartbeatTimer) clearInterval(sseHeartbeatTimer);
  sseTailTimer = null;
  sseHeartbeatTimer = null;
  // Next client starts at EOF again — no replay of what happened in between.
  sseOffset = -1;
}

function handleSse(req: IncomingMessage, res: ServerResponse, root: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
    // Last tab closed: stop polling the journal until someone reconnects.
    if (sseClients.size === 0) stopSseTimers();
  });
  if (!sseTailTimer) {
    const journal = eventsPath(root);
    sseTailTimer = setInterval(() => pumpSseTail(journal), SSE_TAIL_INTERVAL_MS);
    sseTailTimer.unref?.();
    sseHeartbeatTimer = setInterval(() => broadcastSse("ping", "{}"), SSE_HEARTBEAT_MS);
    sseHeartbeatTimer.unref?.();
  }
}

// ---- SPA static serving -----------------------------------------------------

// The React app (web/) builds into web/dist and mounts at /app. `tpm serve`
// ships it statically when the build exists; without a build, /app explains
// how to produce one. Hashed assets get immutable caching; index.html is
// no-cache so a rebuild lands on refresh.
export const SPA_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

const SPA_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveSpa(pathname: string, res: ServerResponse): boolean {
  const index = join(SPA_DIST, "index.html");
  if (!existsSync(index)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("SPA build not found. Run: npm --prefix web install && npm --prefix web run build");
    return true;
  }
  const rel = pathname.replace(/^\/app\/?/, "");
  // Resolve inside dist only — a crafted ../ path falls through to the SPA
  // fallback rather than escaping the directory.
  const candidate = resolve(SPA_DIST, rel);
  const isAsset = rel !== "" && candidate.startsWith(SPA_DIST + "/") && existsSync(candidate) && statSync(candidate).isFile();
  const filePath = isAsset ? candidate : index;
  const type = SPA_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    // Vite emits content-hashed asset names; index.html must revalidate.
    "cache-control": filePath === index ? "no-cache" : "public, max-age=31536000, immutable",
  });
  res.end(readFileSync(filePath));
  return true;
}

// ---- request handling --------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: ServeContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "POST") {
    if (!ctx.mutationsEnabled) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Mutations disabled: server is not bound to loopback. Restart with --host 127.0.0.1.");
      return;
    }
    // /api/cli is the forwarded-CLI channel: those requests carry no Origin
    // (browsers ALWAYS attach one to cross-origin POSTs, so origin-less means
    // a non-browser local client). Everything else keeps the same-origin gate.
    const isCliForward = url.pathname === "/api/cli";
    const originless = !req.headers.origin && !req.headers.referer;
    if (!(isCliForward && originless) && !isSameOrigin(req.headers)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Refused: same-origin check failed (missing or mismatched Origin/Referer).");
      return;
    }
    const raw = await readBody(req);
    let fields: unknown = {};
    if (raw.trim()) {
      try {
        fields = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        return;
      }
    }
    // Per-task "poll now": one forced poller tick scoped to this task. Lives
    // here rather than routeApiMutation because runPoll is async.
    const pollNow = url.pathname.match(/^\/api\/tasks\/(.+)\/poll-pr$/);
    if (pollNow) {
      const slugPath = decodeURIComponent(pollNow[1]);
      try {
        const summary = await runPoll({ only: slugPath, force: true });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, summary }));
      } catch (e) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (isCliForward) {
      // Two trees can share the default port (throwaway trees, tests). The
      // daemon only writes ITS tree — a root mismatch tells the caller to
      // execute locally instead.
      const callerRoot = (fields as Record<string, unknown> | null)?.root;
      if (typeof callerRoot !== "string" || callerRoot !== findRoot()) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "daemon serves a different tree" }));
        return;
      }
      // Journal the CALLER's identity, not the daemon's env. The mutation
      // path is synchronous, so the override can't leak across requests.
      const actor = (fields as Record<string, unknown>).actor;
      const argv = (fields as Record<string, unknown>).argv;
      console.error(`tpm serve: cli-forward ${Array.isArray(argv) ? argv.join(" ") : "?"} (actor: ${typeof actor === "string" ? actor : "cli"})`);
      setActorOverride(typeof actor === "string" && actor ? actor : null);
    }
    let apiResult;
    try {
      apiResult = routeApiMutation(url.pathname, fields, runCli);
    } finally {
      if (isCliForward) setActorOverride(null);
    }
    if (apiResult) {
      res.writeHead(apiResult.status, { "content-type": "application/json" });
      res.end(apiResult.body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `no such endpoint: ${url.pathname}` }));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
    serveSpa(url.pathname, res);
    return;
  }
  if (url.pathname === "/" || url.pathname === "") {
    res.writeHead(302, { location: "/app" });
    res.end();
    return;
  }

  const root = findRoot();
  if (url.pathname === "/events") {
    // SSE stream: held open, never goes through route()'s request/response shape.
    handleSse(req, res, root);
    return;
  }

  // Always load archived so `/api/tasks/<path>` resolves archived tasks and
  // `?archived=1` has them available. Filtering happens per-endpoint.
  const projects = loadProjects(root, { archived: true });

  if (url.pathname.startsWith("/api/")) {
    const apiResult = routeApi(url.pathname, url.searchParams, projects, {
      taskLocks: () => snapshotTaskLocks(root),
      recentEvents: () => readRecentEvents(root, 50),
      harnessLog: defaultHarnessLogReader,
      sessionId: (task) => {
        const snapshot = defaultRunLogReader(task);
        const fromRun = snapshot ? parseRunLog(snapshot.text).sessionId ?? null : null;
        return fromRun ?? (typeof task.data.session_id === "string" && task.data.session_id ? task.data.session_id : null);
      },
      prCache: (u) => readPrCache(u),
      configSnapshot: defaultConfigSnapshot,
      mutationsEnabled: ctx.mutationsEnabled,
    });
    if (apiResult) {
      res.writeHead(apiResult.status, { "content-type": "application/json" });
      res.end(apiResult.body);
      return;
    }
  }

  const result = route(url.pathname, url.searchParams, projects, {
    harness: ctx.harness?.() ?? null,
  });
  if (result.location && result.status >= 300 && result.status < 400) {
    res.writeHead(result.status, { location: result.location });
    res.end();
    return;
  }
  res.writeHead(result.status, { "content-type": result.contentType });
  res.end(req.method === "HEAD" ? undefined : result.body);
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
    return new URL(claim).host === expectedHost;
  } catch {
    return false;
  }
}

function stringOf(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function runCli(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  // In-process command layer (commands.ts) — same argv vocabulary the CLI
  // speaks, without a child process per click. `findRoot` is resolved per
  // mutation, matching the per-request resolution on the GET path.
  return execCommand(findRoot, args);
}

// ---- route(): run-log endpoints + legacy-path redirects ----------------------

export interface RouteResult {
  status: number;
  contentType: string;
  body: string;
  // Set when the response is a redirect (status 3xx).
  location?: string;
}

export interface RouteOpts {
  harness?: HarnessSnapshot | null;
  runLog?: RunLogReader;
  runLogRaw?: RunLogRawReader;
  runLogList?: RunLogListReader;
  runLogTail?: RunLogTailReader;
}

// How many events of a parsed transcript the runs feed renders. The file can
// be huge for a long run, but the panel is a tail — older events fall off;
// the raw log is one click away.
const RUN_PANEL_EVENTS = 60;

// Pure dispatch for what's left outside api.ts: the run-log endpoints (the
// readers and the transcript fragment renderer live here) and permanent
// redirects from the deleted server-rendered pages to their SPA equivalents.
// Tests exercise this directly with mocked projects and readers.
export function route(pathname: string, params: URLSearchParams, projects: Project[], opts: RouteOpts = {}): RouteResult {
  const runLog: RunLogReader = opts.runLog ?? defaultRunLogReader;
  const runLogRaw: RunLogRawReader = opts.runLogRaw ?? defaultRunLogRawReader;
  const runLogList: RunLogListReader = opts.runLogList ?? defaultRunLogListReader;

  if (pathname === "/api/harness") {
    const h = opts.harness ?? null;
    return ok("application/json", JSON.stringify(h ? { running: true, ...h } : { running: false }));
  }

  // JSON runs feed for the SPA runs page: run-log list + a rendered tail of
  // the latest run (transcript events arrive as HTML fragments; the live
  // tail endpoint below advances them).
  const apiRunsMatch = pathname.match(/^\/api\/tasks\/(.+)\/runs\/?$/);
  if (apiRunsMatch) {
    const slugPath = decodeURIComponent(apiRunsMatch[1]);
    const match = findTask(projects, slugPath);
    if (!match) return { status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: `No task: ${slugPath}` }) };
    const names = runLogList(match.task);
    const snapshot = runLog(match.task);
    const slugSegs = (match.task.parent
      ? [match.project.slug, match.task.parent, match.task.slug]
      : [match.project.slug, match.task.slug]).map(encodeURIComponent).join("/");
    let latest: Record<string, unknown> | null = null;
    if (snapshot) {
      const { events, parsed, skipped, format, sessionId } = parseRunLog(snapshot.text);
      const tail = events.slice(-RUN_PANEL_EVENTS);
      latest = {
        name: snapshot.name,
        running: String(match.task.data.status ?? "") === "in-progress",
        html: tail.map(renderRunEvent).join(""),
        totalEvents: events.length,
        shownEvents: tail.length,
        parsed,
        skipped,
        offset: Buffer.byteLength(snapshot.text),
        format,
        sessionId: sessionId ?? null,
        tailPath: `/t/${slugSegs}/runs/${encodeURIComponent(snapshot.name)}/tail`,
        rawPath: `/t/${slugSegs}/runs/${encodeURIComponent(snapshot.name)}`,
      };
    }
    return ok("application/json", JSON.stringify({
      runs: names.map(n => ({ name: n, timestamp: runLogDisplayTimestamp(n) })),
      latest,
    }));
  }

  // Incremental transcript tail: `/t/<proj>/<slug>/runs/<basename>/tail?offset=N`.
  const taskRunTailMatch = pathname.match(/^\/t\/(.+)\/runs\/([^/]+)\/tail\/?$/);
  if (taskRunTailMatch) {
    const query = decodeURIComponent(taskRunTailMatch[1]);
    const name = decodeURIComponent(taskRunTailMatch[2]);
    let match: { project: Project; task: Task } | null = null;
    try { match = findTask(projects, query); } catch { match = null; }
    if (!match) return notFound(`No task: ${query}`);
    const tailReader = opts.runLogTail ?? defaultRunLogTailReader;
    const offsetRaw = params.get("offset") ?? "";
    // Garbage / missing offset skips to EOF (-1) instead of replaying a
    // potentially huge file from 0.
    const offset = /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : -1;
    const formatRaw = params.get("format") ?? "";
    const format: AgentOutputFormat = formatRaw === "copilot-json" || formatRaw === "text"
      ? formatRaw
      : "claude-stream-json";
    const tail = tailReader(match.task, name, offset);
    if (!tail) return notFound(`No run log: ${name}`);
    const { events } = parseRunLog(tail.lines.join("\n"), { format });
    return ok("application/json", JSON.stringify({
      html: events.map(renderRunEvent).join(""),
      offset: tail.offset,
      running: rollupStatus(match.task) === "in-progress",
    }));
  }

  // Per-task raw run-log viewer: `/t/<proj>/<slug>/runs/<basename>`. Matched
  // before the redirects so the bare-`/t/…/runs` URL still redirects to the
  // SPA runs page below.
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

  // Pre-095 flat run-log URL: `/runs/<encoded-slug>--<utc>.log` — resolve to
  // the per-task raw viewer.
  const legacyRunsMatch = pathname.match(/^\/runs\/([^/]+)\/?$/);
  if (legacyRunsMatch) {
    const name = decodeURIComponent(legacyRunsMatch[1]);
    if (!isLegacyRunLogName(name)) return notFound(`bad run log name: ${name}`);
    const target = resolveLegacyRunLog(projects, name);
    if (!target) return notFound(`No run log: ${name}`);
    return redirect(302, target);
  }

  // ---- redirects from the deleted server-rendered pages ----------------------
  // Old bookmarks, notification deep links (`taskDeepLink` builds /t/<path>),
  // and numeric-id permalinks all land on their SPA equivalents.

  if (pathname === "/search" || pathname === "/config" || pathname === "/logs" || pathname === "/logs/orchestrate" || pathname === "/logs/poller") {
    const target = pathname.startsWith("/logs") ? "/logs" : pathname;
    const query = params.toString();
    return redirect(302, `/app${target}${query ? `?${query}` : ""}`);
  }

  // Numeric task permalink `/t/<project>/<id>` (`3`, `03`, `003` all resolve).
  const taskByIdMatch = pathname.match(/^\/t\/([^/]+)\/(\d+)\/?$/);
  if (taskByIdMatch) {
    const slug = decodeURIComponent(taskByIdMatch[1]);
    const project = projects.find(p => p.slug === slug);
    if (project) {
      const id = Number(taskByIdMatch[2]);
      const matches = findTasksByNumericId(project, id);
      if (matches.length === 1) {
        return redirect(302, `/app${taskPath(project, matches[0].task)}`);
      }
      // Zero or ambiguous: the project page is the place to disambiguate.
      return redirect(302, `/app/p/${encodeURIComponent(project.slug)}`);
    }
  }

  const taskRunsMatch = pathname.match(/^\/t\/(.+)\/runs\/?$/);
  if (taskRunsMatch) {
    return redirect(302, `/app/t/${taskRunsMatch[1]}/runs`);
  }
  // The per-task log page folded into the SPA task view.
  const taskLogMatch = pathname.match(/^\/t\/(.+)\/log\/?$/);
  if (taskLogMatch) {
    return redirect(302, `/app/t/${taskLogMatch[1]}`);
  }
  const taskMatch = pathname.match(/^\/t\/(.+?)\/?$/);
  if (taskMatch) {
    return redirect(302, `/app/t/${taskMatch[1]}`);
  }

  // Numeric project-page permalink `/p/<project>/<id>` → task, like /t/.
  const projectByIdMatch = pathname.match(/^\/p\/([^/]+)\/(\d+)\/?$/);
  if (projectByIdMatch) {
    const slug = decodeURIComponent(projectByIdMatch[1]);
    const project = projects.find(p => p.slug === slug);
    if (project) {
      const id = Number(projectByIdMatch[2]);
      const matches = findTasksByNumericId(project, id);
      if (matches.length === 1) {
        return redirect(302, `/app${taskPath(project, matches[0].task)}`);
      }
      return redirect(302, `/app/p/${encodeURIComponent(project.slug)}`);
    }
  }
  const projectMatch = pathname.match(/^\/p\/([^/]+)(\/artifacts)?\/?$/);
  if (projectMatch) {
    const query = params.toString();
    return redirect(302, `/app/p/${projectMatch[1]}${query ? `?${query}` : ""}`);
  }

  return notFound(pathname);
}

// ---- transcript fragment rendering -------------------------------------------

// Run-log events render server-side into <li> fragments (the SPA injects them
// verbatim) so the NDJSON-dialect knowledge stays in one place.
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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

// ---- default disk readers ------------------------------------------------------

// Read the most recent run log for a task. Returns null if the file doesn't
// exist or can't be read. Per task 095 the reader walks the task's own folder
// (`<task>/runs/`) instead of the pre-095 global flat dir.
function defaultRunLogReader(task: Task): RunLogSnapshot | null {
  const path = latestRunLog(task);
  if (!path) return null;
  try {
    return { name: basename(path), text: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

function defaultRunLogListReader(task: Task): string[] {
  return allRunLogs(task).map(p => basename(p));
}

// Read the raw bytes of a run log by basename, scoped to a specific task.
// The route layer ran `isValidRunLogName(name, task)` already, so the join
// below can't escape the task's runs/ dir.
function defaultRunLogRawReader(task: Task, name: string): string | null {
  if (!isValidRunLogName(name, task)) return null;
  const path = allRunLogs(task).find(p => basename(p) === name);
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// On-disk incremental tail for the live-transcript endpoint: validate the
// name (same gate as the raw viewer, so the join can't escape runs/), find
// the file, and read complete lines from the byte offset.
function defaultRunLogTailReader(task: Task, name: string, offset: number): { lines: string[]; offset: number } | null {
  if (!isValidRunLogName(name, task)) return null;
  const path = allRunLogs(task).find(p => basename(p) === name);
  if (!path || !existsSync(path)) return null;
  return readJournalLinesFrom(path, offset);
}

// Map a pre-095 flat-dir filename back to the per-task viewer URL. The
// legacy filename is `<encoded-slug>--<utc>.log`; we walk the project tree
// once and look up the task whose encoded qualified slug matches the
// prefix. Returns null when no task matches.
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
// acquired }` map for the API serializers. Repo-level locks (`repo--<project>`)
// are skipped — they don't decorate task rows.
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

// Non-throwing snapshot reader for the config page. Distinguishes
// missing-file (render "no file yet — using defaults") from invalid-JSON
// (show parse error + raw). Doesn't run the stricter validator in
// `readConfig` — the UI should surface what the file says, even when fields
// are off-spec.
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

// ---- small response helpers -----------------------------------------------------

function ok(contentType: string, body: string): RouteResult {
  return { status: 200, contentType, body };
}

function redirect(status: number, location: string): RouteResult {
  return { status, contentType: "text/plain; charset=utf-8", body: "", location };
}

function notFound(message: string): RouteResult {
  return { status: 404, contentType: "text/plain; charset=utf-8", body: `404: ${message}` };
}
