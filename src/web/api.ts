import { readFileSync, statSync } from "node:fs";
import type { Project, Task } from "../core/tree.ts";
import { flatTasks, isParent, rollupStatus, taskHasReport, taskReportPath } from "../core/tree.ts";
import { inboxItems, selectCandidates, qualifyTaskSlug } from "../core/queue.ts";
import { findTask } from "../core/resolve.ts";
import { resolveRepo } from "../core/context.ts";
import { renderMarkdown } from "../util/markdown.ts";
import { STATUS_VOCAB } from "../core/mutate.ts";
import { KNOWN_TASK_TYPES } from "../core/new.ts";
import type { HarnessLogReader } from "../core/harness_log.ts";
import type { StatusEventRecord } from "../core/events.ts";
import { parsePrUrl } from "../core/orchestrate/pr_cache.ts";
import type { PrCacheEntry } from "../core/orchestrate/pr_cache.ts";
import { analyzePr } from "../core/orchestrate/pr_signal.ts";
import type { RawPrJson } from "../core/orchestrate/pr_signal.ts";

// JSON API v1 — the read/mutation surface the React SPA talks to. Everything
// here is additive beside the server-rendered pages: handleRequest dispatches
// `/api/*` through routeApi/routeApiMutation first and falls back to the HTML
// route() for anything unclaimed (which still owns the two pre-v1 endpoints,
// /api/harness and /api/refresh).
//
// Design rules:
// - Same argv vocabulary as everything else. Mutations map (path, action,
//   fields) to the exact CLI argv the HTML forms build — buildCliArgs below is
//   THE mapping, shared by both dispatchers — and run through the in-process
//   command layer. The transition table stays the only status authority.
// - Pure dispatch, injected readers. Like route(), these functions take
//   `projects` and reader thunks so tests exercise them without a tree on
//   disk.
// - Markdown renders server-side. Section payloads carry {raw, html} so the
//   SPA needs no markdown dependency and renders exactly what the SSR pages
//   rendered.

export type CliRunner = (args: string[]) => { ok: boolean; stdout: string; stderr: string };

export interface ApiResult {
  status: number;
  body: string; // JSON, always
}

// ---- shared vocabulary (moved from serve.ts; serve imports these) ----------

// Actions reachable from the web, both the HTML forms and the JSON API. Kept
// as an allowlist so a stray POST can't reach an arbitrary tpm verb.
export const MUTATION_ACTIONS = new Set([
  "ready", "block", "reopen", "complete", "drop", "log", "pr", "status", "allow-orchestrator",
  "lgtm", "request-changes", "archive", "pull", "edit", "set-type",
]);

// Bulk-action whitelist for multi-select. Each key is a `/bulk/<action>`
// segment; the caller fans the selected slugs out to the named CLI verb, one
// invocation per slug (independent semantics — one row's refusal never aborts
// the batch). `block` is the lone reason-carrying entry and shares a single
// reason across the whole selection.
export const BULK_ACTIONS: Record<string, { verb: string; label: string; needsReason?: boolean }> = {
  promote: { verb: "ready", label: "Promote" },
  pull: { verb: "pull", label: "Pull from queue" },
  close: { verb: "complete", label: "Close" },
  reopen: { verb: "reopen", label: "Reopen" },
  drop: { verb: "drop", label: "Drop" },
  block: { verb: "block", label: "Block", needsReason: true },
  archive: { verb: "archive", label: "Archive" },
};

// Which bulk actions each status can plausibly accept. Drives UI affordance
// only — the per-row CLI call is the real enforcer, so a stale selection just
// surfaces as a per-row refusal in the summary rather than corrupting state.
// Every non-terminal status can be closed, dropped, or blocked; ready /
// in-progress / rework can be pulled; open / blocked promoted; blocked
// reopened; terminal (done/dropped) only archived. A row is selectable iff
// its status appears here.
export const BULK_CAPS: Record<string, string[]> = {
  open: ["promote", "close", "drop", "block"],
  ready: ["pull", "close", "drop", "block"],
  blocked: ["promote", "reopen", "close", "drop"],
  "in-progress": ["pull", "close", "drop", "block"],
  rework: ["pull", "close", "drop", "block"],
  closing: ["close", "drop", "block"],
  review: ["close", "drop", "block"],
  done: ["archive"],
  dropped: ["archive"],
};

// Map a (slug, action, fields) triple to CLI argv. Returns null when a
// required field is missing. This is the single form→verb mapping for the
// whole web layer — HTML forms pass URLSearchParams, the JSON API wraps its
// object body in URLSearchParams and lands here too.
export function buildCliArgs(slug: string, action: string, body: URLSearchParams): string[] | null {
  switch (action) {
    case "ready":  return ["ready", slug];
    case "reopen": {
      const reason = body.get("reason")?.trim();
      if (!reason) return ["reopen", slug];
      return ["reopen", slug, reason];
    }
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
    case "drop": {
      // Optional reason — detail-page form supplies one (fills ## Outcome);
      // the per-row glyph and bulk path drop reasonless. Mirrors reopen.
      const reason = body.get("reason")?.trim();
      if (!reason) return ["drop", slug];
      return ["drop", slug, reason];
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
    case "set-type": {
      const type = body.get("type")?.trim();
      if (!type) return null;
      return ["set-type", slug, type];
    }
    case "allow-orchestrator": {
      const allow = body.get("allow");
      if (allow === "true") return ["allow", slug];
      if (allow === "false") return ["disallow", slug];
      return null;
    }
    case "lgtm": return ["lgtm", slug];
    case "archive": return ["archive", slug];
    case "pull": return ["pull", slug];
    case "request-changes": {
      const comment = body.get("comment")?.trim();
      if (!comment) return null;
      return ["request-changes", slug, comment];
    }
    case "edit": {
      const section = body.get("section")?.trim();
      // `value` may be intentionally empty (clearing a section is a valid edit
      // — Outcome starts empty); we only require the field be present.
      const value = body.get("value");
      if (!section || value === null) return null;
      const args = ["edit", slug, section, value];
      const mtime = body.get("mtime")?.trim();
      if (mtime) args.push("--expect-mtime", mtime);
      return args;
    }
    default:
      return null;
  }
}

// Server-side mirror of the new-task form's slug script: lowercase, collapse
// non-[a-z0-9] runs to a single hyphen, trim edge hyphens. May return "" for
// all-punctuation titles — caller treats that as "no slug".
export function slugifyTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface SearchHit {
  project: Project;
  task: Task;
  rank: number;
  snippet: string | null; // first matching body line, for body hits
}

export function searchTasks(projects: Project[], q: string, includeArchived: boolean): SearchHit[] {
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  for (const p of projects) {
    for (const t of flatTasks(p.tasks)) {
      if (isParent(t)) continue;
      if (!includeArchived && t.archived) continue;
      const title = String(t.data.title ?? "");
      const tags = Array.isArray(t.data.tags) ? (t.data.tags as unknown[]).map(String) : [];
      const prs = Array.isArray(t.data.prs) ? (t.data.prs as unknown[]).map(String) : [];
      if (t.slug.toLowerCase().includes(needle) || title.toLowerCase().includes(needle)) {
        hits.push({ project: p, task: t, rank: 0, snippet: null });
        continue;
      }
      const meta = [String(t.data.status ?? ""), ...tags, ...prs];
      if (meta.some(v => v.toLowerCase().includes(needle))) {
        hits.push({ project: p, task: t, rank: 1, snippet: null });
        continue;
      }
      const bodyLine = t.body.split("\n").find(l => l.toLowerCase().includes(needle));
      if (bodyLine !== undefined) {
        hits.push({ project: p, task: t, rank: 2, snippet: bodyLine.trim().slice(0, 160) });
      }
    }
  }
  hits.sort((a, b) => a.rank - b.rank);
  return hits;
}

// Splits a task/project body at `## X` headings. The first item may be a
// preamble chunk (heading === null) with the body's leading content (the
// `# Title` h1 line). Shared by the SSR section editors and the API's
// section payloads.
export function splitBodyAtH2(body: string): Array<{ heading: string | null; content: string }> {
  const lines = body.split("\n");
  const sections: Array<{ heading: string | null; content: string }> = [];
  let cur: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (cur.heading !== null || cur.lines.some(l => l.length > 0)) {
        sections.push({ heading: cur.heading, content: cur.lines.join("\n") });
      }
      cur = { heading: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.heading !== null || cur.lines.some(l => l.length > 0)) {
    sections.push({ heading: cur.heading, content: cur.lines.join("\n") });
  }
  return sections;
}

// ---- serializers ------------------------------------------------------------

export interface ApiOpts {
  // Same snapshot shape serve.ts builds from listTaskLocks(root).
  taskLocks?: () => Map<string, { agentId: string; pid: number; acquired: string }>;
  recentEvents?: () => StatusEventRecord[];
  harnessLog?: HarnessLogReader;
  // Injected run-log readers (serve's defaults touch disk).
  sessionId?: (task: Task) => string | null;
  prCache?: (url: string) => PrCacheEntry | null;
  configSnapshot?: () => unknown;
  mutationsEnabled?: boolean;
}

// Mirrors the SSR PR card's freshness rule (serve.ts PR_CACHE_STALE_MS).
const PR_CACHE_STALE_MS = 60 * 60 * 1000;

// Digest a cached PR payload into the badge set the SPA renders. Non-github
// hosts (and stale/absent cache entries) get the minimal shape — same
// degradation the SSR cards have.
function prDigest(url: string, entry: PrCacheEntry | null, nowMs: number): Record<string, unknown> {
  const ref = parsePrUrl(url);
  const base = {
    url,
    displayId: ref?.displayId ?? null,
    host: entry?.host ?? ref?.host ?? null,
    fetchedAt: entry?.fetchedAt ?? null,
    fresh: false,
  };
  if (!entry) return base;
  const age = nowMs - Date.parse(entry.fetchedAt);
  const fresh = Number.isFinite(age) && age <= PR_CACHE_STALE_MS;
  if (!fresh || entry.host !== "github") return { ...base, fresh };
  const pr = entry.pr as RawPrJson;
  const d = analyzePr(pr);
  return {
    ...base,
    fresh,
    title: pr.title ?? null,
    state: d.state,
    ci: d.ci,
    review: d.review,
    mergeable: d.mergeable,
  };
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function taskSummary(
  project: Project,
  task: Task,
  locks: Map<string, { agentId: string; pid: number; acquired: string }>,
): Record<string, unknown> {
  const qualifiedSlug = qualifyTaskSlug(project.slug, task);
  const segments = task.parent ? [project.slug, task.parent, task.slug] : [project.slug, task.slug];
  const lock = locks.get(qualifiedSlug) ?? null;
  return {
    slug: task.slug,
    qualifiedSlug,
    segments,
    title: str(task.data.title) ?? task.slug,
    status: rollupStatus(task),
    ownStatus: String(task.data.status ?? ""),
    type: str(task.data.type),
    parentSlug: task.parent ?? null,
    isParent: isParent(task),
    archived: task.archived,
    created: str(task.data.created),
    closed: str(task.data.closed),
    prs: Array.isArray(task.data.prs) ? (task.data.prs as unknown[]).map(String) : [],
    tags: Array.isArray(task.data.tags) ? (task.data.tags as unknown[]).map(String) : [],
    allowOrchestrator: task.data.allow_orchestrator === true,
    hasReport: taskHasReport(task),
    lock: lock ? { agentId: lock.agentId, pid: lock.pid, acquired: lock.acquired } : null,
    children: (task.children ?? []).map(c => taskSummary(project, c, locks)),
  };
}

function projectSummary(
  project: Project,
  locks: Map<string, { agentId: string; pid: number; acquired: string }>,
  includeArchived: boolean,
): Record<string, unknown> {
  const repo = resolveRepo(project);
  const tasks = project.tasks
    .filter(t => includeArchived || !t.archived)
    .map(t => taskSummary(project, t, locks));
  const all = flatTasks(project.tasks).filter(t => includeArchived || !t.archived);
  const counts: Record<string, number> = {};
  for (const t of all) {
    if (isParent(t)) continue;
    const s = rollupStatus(t);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return {
    slug: project.slug,
    name: str(project.data.name) ?? project.slug,
    status: str(project.data.status),
    repo: { remote: repo.remote ?? null, local: repo.local ?? null },
    counts,
    tasks,
  };
}

// The report artifact (investigation deliverable) rides the detail payload —
// raw + server-rendered html, like body sections. Null when absent/unreadable.
function readReport(task: Task): { raw: string; html: string } | null {
  if (!taskHasReport(task)) return null;
  try {
    const raw = readFileSync(taskReportPath(task), "utf8");
    return { raw, html: renderMarkdown(raw) };
  } catch {
    return null;
  }
}

function sectionsOf(body: string): Array<{ heading: string | null; raw: string; html: string }> {
  return splitBodyAtH2(body).map(s => ({
    heading: s.heading,
    raw: s.content,
    html: renderMarkdown(s.content),
  }));
}

function json(status: number, value: unknown): ApiResult {
  return { status, body: JSON.stringify(value) };
}

function apiError(status: number, message: string): ApiResult {
  return json(status, { ok: false, error: message });
}

// ---- GET dispatch -----------------------------------------------------------

// Returns null for paths this dispatcher doesn't own (handleRequest falls
// back to the HTML route(), which still owns /api/harness + /api/refresh).
export function routeApi(
  pathname: string,
  params: URLSearchParams,
  projects: Project[],
  opts: ApiOpts = {},
): ApiResult | null {
  const locks = (opts.taskLocks ?? (() => new Map()))();
  const includeArchived = params.get("archived") === "1";

  if (pathname === "/api/projects") {
    return json(200, {
      projects: projects.map(p => projectSummary(p, locks, includeArchived)),
    });
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const slug = decodeURIComponent(projectMatch[1]);
    const project = projects.find(p => p.slug === slug);
    if (!project) return apiError(404, `No project: ${slug}`);
    let mtimeMs = 0;
    try { mtimeMs = statSync(project.path).mtimeMs; } catch { mtimeMs = 0; }
    return json(200, {
      ...projectSummary(project, locks, includeArchived),
      sections: sectionsOf(project.body),
      mtimeMs,
    });
  }

  // `/api/tasks/<path>/runs` is served by route() (the run-log readers and
  // transcript renderer live there) — return null so it falls through.
  const taskMatch = pathname.match(/^\/api\/tasks\/(.+)$/);
  if (taskMatch && !pathname.endsWith("/runs")) {
    const slugPath = decodeURIComponent(taskMatch[1]);
    const match = findTask(projects, slugPath);
    if (!match) return apiError(404, `No task: ${slugPath}`);
    const { project, task } = match;
    let mtimeMs = 0;
    try { mtimeMs = statSync(task.path).mtimeMs; } catch { mtimeMs = 0; }
    return json(200, {
      ...taskSummary(project, task, locks),
      project: { slug: project.slug, name: str(project.data.name) ?? project.slug },
      sections: sectionsOf(task.body),
      sessionId: opts.sessionId ? opts.sessionId(task) : (str(task.data.session_id) ?? null),
      report: readReport(task),
      prDetails: (Array.isArray(task.data.prs) ? (task.data.prs as unknown[]).map(String) : [])
        .map(url => prDigest(url, opts.prCache ? opts.prCache(url) : null, Date.now())),
      mtimeMs,
    });
  }

  if (pathname === "/api/inbox") {
    return json(200, {
      items: inboxItems(projects).map(i => ({
        ...taskSummary(i.project, i.task, locks),
        projectSlug: i.project.slug,
      })),
    });
  }

  if (pathname === "/api/queue") {
    return json(200, {
      items: selectCandidates(projects).map(i => ({
        ...taskSummary(i.project, i.task, locks),
        projectSlug: i.project.slug,
      })),
    });
  }

  if (pathname === "/api/search") {
    const q = (params.get("q") ?? "").trim();
    const hits = q ? searchTasks(projects, q, includeArchived) : [];
    return json(200, {
      q,
      hits: hits.map(h => ({
        ...taskSummary(h.project, h.task, locks),
        projectSlug: h.project.slug,
        snippet: h.snippet,
      })),
    });
  }

  if (pathname === "/api/config" && opts.configSnapshot) {
    return json(200, { config: opts.configSnapshot() });
  }

  if (pathname === "/api/vocab") {
    return json(200, {
      statuses: STATUS_VOCAB,
      types: [...KNOWN_TASK_TYPES],
      mutationActions: [...MUTATION_ACTIONS],
      bulkActions: BULK_ACTIONS,
      bulkCaps: BULK_CAPS,
    });
  }

  if (pathname === "/api/events/recent") {
    const events = (opts.recentEvents ?? (() => []))();
    return json(200, { events });
  }

  const logsMatch = pathname.match(/^\/api\/logs(?:\/(orchestrate|poller))?$/);
  if (logsMatch && opts.harnessLog) {
    const lines = clampInt(params.get("lines"), 200, 1, 2000);
    const sources = opts.harnessLog({ lines });
    const category = logsMatch[1];
    const filtered = category
      ? sources.filter(s => s.name.startsWith(category))
      : sources;
    return json(200, { sources: filtered });
  }

  return null;
}

function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ---- POST dispatch ----------------------------------------------------------

function fieldsToParams(fields: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (fields && typeof fields === "object") {
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      params.set(k, String(v));
    }
  }
  return params;
}

// Returns null for paths this dispatcher doesn't own. JSON contract:
// 200 {ok:true, message} on success, 4xx {ok:false, error} otherwise. The
// same-origin + loopback guards run in handleRequest before this is reached,
// exactly as they do for the form path.
export function routeApiMutation(pathname: string, fields: unknown, runner: CliRunner): ApiResult | null {
  const taskAction = pathname.match(/^\/api\/tasks\/(.+)\/([a-z][a-z0-9-]*)$/);
  if (taskAction) {
    const slugPath = decodeURIComponent(taskAction[1]);
    const action = taskAction[2];
    if (!MUTATION_ACTIONS.has(action)) return apiError(404, `Unknown action: ${action}`);
    const args = buildCliArgs(slugPath, action, fieldsToParams(fields));
    if (!args) return apiError(400, `missing required field for ${action}`);
    const result = runner(args);
    if (!result.ok) return apiError(422, result.stderr || `${action}: failed`);
    return json(200, { ok: true, message: result.stdout || `${action}: ok` });
  }

  const newTask = pathname.match(/^\/api\/projects\/([^/]+)\/new-task$/);
  if (newTask) {
    const projectSlug = decodeURIComponent(newTask[1]);
    const params = fieldsToParams(fields);
    const title = params.get("title")?.trim();
    const slug = params.get("slug")?.trim() || (title ? slugifyTitle(title) : "");
    if (!slug) return apiError(400, "new-task: title or slug is required");
    const parent = params.get("parent")?.trim();
    const type = params.get("type")?.trim();
    const context = params.get("context") ?? "";
    const args = ["new", "task", projectSlug, slug];
    if (title) args.push("--title", title);
    if (parent) args.push("--parent", parent);
    if (type) args.push("--type", type);
    const result = runner(args);
    if (!result.ok) return apiError(422, result.stderr || result.stdout || "new-task: failed");
    const notes: string[] = [];
    // Optional Context: a second call against the brand-new slug (the create
    // writes the file the edit mutates). Partial state is harmless — keep the
    // created task and surface the failure.
    if (context.trim()) {
      const editResult = runner(["edit", slug, "context", context]);
      if (!editResult.ok) notes.push(`Context failed: ${editResult.stderr || "edit failed"}`);
    }
    // Optional create-&-ready: promote in the same round trip.
    if (params.get("ready")) {
      const readyResult = runner(["ready", slug]);
      if (!readyResult.ok) notes.push(`ready failed: ${readyResult.stderr || "ready failed"}`);
    }
    const segments = parent ? [projectSlug, parent, slug] : [projectSlug, slug];
    return json(200, {
      ok: true,
      message: [result.stdout, ...notes].filter(Boolean).join(" — "),
      slug,
      segments,
    });
  }

  const projectEdit = pathname.match(/^\/api\/projects\/([^/]+)\/edit$/);
  if (projectEdit) {
    const projectSlug = decodeURIComponent(projectEdit[1]);
    const params = fieldsToParams(fields);
    const section = params.get("section")?.trim();
    const value = params.get("value");
    if (!section || value === null) return apiError(400, "edit-project: section and value are required");
    const args = ["edit-project", projectSlug, section, value];
    const mtime = params.get("mtime")?.trim();
    if (mtime) args.push("--expect-mtime", mtime);
    const result = runner(args);
    if (!result.ok) return apiError(422, result.stderr || "edit-project: failed");
    return json(200, { ok: true, message: result.stdout });
  }

  const bulk = pathname.match(/^\/api\/bulk\/([a-z][a-z0-9-]*)$/);
  if (bulk) {
    const spec = BULK_ACTIONS[bulk[1]];
    if (!spec) return apiError(404, `Unknown bulk action: ${bulk[1]}`);
    const body = (fields ?? {}) as Record<string, unknown>;
    const slugs = Array.isArray(body.slugs) ? body.slugs.map(String) : [];
    if (slugs.length === 0) return apiError(400, "bulk: slugs[] is required");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (spec.needsReason && !reason) return apiError(400, `bulk ${bulk[1]}: reason is required`);
    const results = slugs.map(slug => {
      const args = spec.needsReason ? [spec.verb, slug, reason] : [spec.verb, slug];
      const r = runner(args);
      return { slug, ok: r.ok, message: r.ok ? r.stdout : (r.stderr || `${spec.verb}: failed`) };
    });
    const succeeded = results.filter(r => r.ok).length;
    return json(200, { ok: true, succeeded, failed: results.length - succeeded, results });
  }

  if (pathname === "/api/harness/workers") {
    const params = fieldsToParams(fields);
    const raw = (params.get("value") ?? "").trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n > 16) {
      return apiError(400, "workers must be an integer 0-16");
    }
    const result = runner(["config", "set", "workers", String(n)]);
    if (!result.ok) return apiError(422, result.stderr || "config set workers: failed");
    return json(200, { ok: true, message: result.stdout || `workers -> ${n}` });
  }

  return null;
}
