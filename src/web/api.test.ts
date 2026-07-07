import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Project, Task } from "../core/tree.ts";
import { routeApi, routeApiMutation, buildCliArgs, MUTATION_ACTIONS } from "./api.ts";
import type { CliRunner } from "./api.ts";

// Pure-dispatch tests, mirroring serve.test.ts's fixtures: in-memory projects,
// stub runners, no tree on disk. The verb semantics behind mutations are
// commands.test.ts / mutate.test.ts territory — here we assert the JSON
// contract (shapes, status codes, argv mapping).

function task(slug: string, status: string, extra: Record<string, unknown> = {}): Task {
  return {
    slug,
    path: `/tmp/${slug}.md`,
    archived: false,
    data: { slug, status, title: `Task ${slug}`, type: "pr", created: "2026-01-01 00:00 PDT", prs: [], ...extra },
    body: "## Context\nbody.\n\n## Plan\n- step 1\n\n## Log\n- 2026-01-01 00:00 PDT: created\n",
  };
}

function project(slug: string, tasks: Task[], extra: Record<string, unknown> = {}): Project {
  return {
    slug,
    path: `/tmp/${slug}/project.md`,
    dir: `/tmp/${slug}`,
    data: { slug, name: slug, status: "active", ...extra },
    body: "## Goal\nbe great.\n",
    tasks,
  };
}

function get(pathname: string, params = "", projects: Project[] = [], opts = {}) {
  const r = routeApi(pathname, new URLSearchParams(params), projects, opts);
  return r ? { status: r.status, json: JSON.parse(r.body) } : null;
}

const okRunner: CliRunner = (args) => ({ ok: true, stdout: `ran: ${args.join(" ")}`, stderr: "" });
const failRunner: CliRunner = () => ({ ok: false, stdout: "", stderr: "refused" });

// ---- reads ------------------------------------------------------------------

test("api: /api/projects returns summaries with nested tasks and counts", () => {
  const p = project("alpha", [
    task("001-a", "ready"),
    task("002-b", "review"),
    { ...task("003-c", "done"), archived: true },
  ]);
  const r = get("/api/projects", "", [p])!;
  assert.equal(r.status, 200);
  assert.equal(r.json.projects.length, 1);
  const alpha = r.json.projects[0];
  assert.equal(alpha.slug, "alpha");
  assert.equal(alpha.tasks.length, 2); // archived excluded by default
  assert.deepEqual(alpha.counts, { ready: 1, review: 1 });
  const first = alpha.tasks[0];
  assert.equal(first.qualifiedSlug, "alpha/001-a");
  assert.deepEqual(first.segments, ["alpha", "001-a"]);
  assert.equal(first.status, "ready");
});

test("api: /api/projects?archived=1 includes archived tasks", () => {
  const p = project("alpha", [{ ...task("001-a", "done"), archived: true }]);
  assert.equal(get("/api/projects", "", [p])!.json.projects[0].tasks.length, 0);
  assert.equal(get("/api/projects", "archived=1", [p])!.json.projects[0].tasks.length, 1);
});

test("api: /api/projects/<slug> returns sections with server-rendered html", () => {
  const p = project("alpha", []);
  const r = get("/api/projects/alpha", "", [p])!;
  assert.equal(r.status, 200);
  const goal = r.json.sections.find((s: { heading: string | null }) => s.heading === "Goal");
  assert.ok(goal);
  assert.equal(goal.raw.trim(), "be great.");
  assert.match(goal.html, /be great\./);
  assert.equal(get("/api/projects/nope", "", [p])!.status, 404);
});

test("api: /api/tasks/<path> returns detail with sections, lock, session id", () => {
  const t = task("001-a", "in-progress", { session_id: "sess-fm-1", tags: ["x"] });
  const p = project("alpha", [t]);
  const locks = new Map([["alpha/001-a", { agentId: "agent-7", pid: 123, acquired: "2026-07-01 00:00 PDT" }]]);
  const r = get("/api/tasks/alpha/001-a", "", [p], { taskLocks: () => locks })!;
  assert.equal(r.status, 200);
  assert.equal(r.json.qualifiedSlug, "alpha/001-a");
  assert.equal(r.json.project.slug, "alpha");
  assert.equal(r.json.lock.agentId, "agent-7");
  assert.equal(r.json.sessionId, "sess-fm-1"); // frontmatter fallback (no reader injected)
  const headings = r.json.sections.map((s: { heading: string | null }) => s.heading);
  assert.deepEqual(headings, ["Context", "Plan", "Log"]);
  assert.equal(get("/api/tasks/alpha/nope", "", [p])!.status, 404);
});

test("api: /api/inbox and /api/queue mirror the queue module", () => {
  const p = project("alpha", [
    task("001-r", "ready", { allow_orchestrator: true }),
    task("002-rw", "rework", { allow_orchestrator: true }),
    task("003-rv", "review"),
    task("004-bl", "blocked"),
  ]);
  const inbox = get("/api/inbox", "", [p])!;
  const inboxSlugs = inbox.json.items.map((i: { slug: string }) => i.slug);
  assert.ok(inboxSlugs.includes("003-rv"));
  assert.ok(inboxSlugs.includes("004-bl"));

  const queue = get("/api/queue", "", [p])!;
  const queueSlugs = queue.json.items.map((i: { slug: string }) => i.slug);
  assert.ok(queueSlugs.includes("001-r"));
  assert.ok(queueSlugs.includes("002-rw"));
  assert.ok(!queueSlugs.includes("003-rv"));
});

test("api: /api/search matches slug/title/meta/body with snippets", () => {
  const p = project("alpha", [
    task("001-alpha-widget", "ready"),
    task("002-b", "ready", { title: "Widget factory" }),
    { ...task("003-c", "ready"), body: "## Context\nthe widget lives here.\n" },
  ]);
  const r = get("/api/search", "q=widget", [p])!;
  assert.equal(r.json.hits.length, 3);
  const bodyHit = r.json.hits.find((h: { slug: string }) => h.slug === "003-c");
  assert.match(bodyHit.snippet, /widget lives here/);
  assert.equal(get("/api/search", "", [p])!.json.hits.length, 0);
});

test("api: /api/vocab exposes statuses, types, and action allowlists", () => {
  const r = get("/api/vocab")!;
  assert.ok(r.json.statuses.some((s: { status: string }) => s.status === "review"));
  assert.deepEqual(r.json.types, ["pr", "investigation"]);
  assert.ok(r.json.mutationActions.includes("pr"));
  assert.ok(r.json.bulkActions.promote);
});

test("api: /api/events/recent returns injected journal events", () => {
  const events = [{ at: "2026-07-01", slug: "alpha/001", from: "ready", to: "in-progress", verb: "started" }];
  const r = get("/api/events/recent", "", [], { recentEvents: () => events })!;
  assert.deepEqual(r.json.events, events);
});

test("api: unowned paths return null (fall through to the HTML route)", () => {
  assert.equal(get("/api/harness"), null);
  assert.equal(get("/api/refresh"), null);
  assert.equal(get("/t/alpha/001"), null);
});

// ---- mutations ----------------------------------------------------------------

test("api mutation: POST /api/tasks/<path>/<action> maps fields to argv", () => {
  const calls: string[][] = [];
  const runner: CliRunner = (args) => { calls.push(args); return { ok: true, stdout: "done", stderr: "" }; };
  const r = routeApiMutation("/api/tasks/alpha%2F001-a/pr", { url: "https://x/pull/1" }, runner)!;
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, message: "done" });
  assert.deepEqual(calls, [["pr", "alpha/001-a", "https://x/pull/1"]]);
});

test("api mutation: unknown action 404s, missing field 400s, runner failure 422s", () => {
  const unknown = routeApiMutation("/api/tasks/alpha/001/frobnicate", {}, okRunner)!;
  assert.equal(unknown.status, 404);

  const missing = routeApiMutation("/api/tasks/alpha/001/pr", {}, okRunner)!;
  assert.equal(missing.status, 400);
  assert.match(JSON.parse(missing.body).error, /missing required field/);

  const refused = routeApiMutation("/api/tasks/alpha/001/ready", {}, failRunner)!;
  assert.equal(refused.status, 422);
  assert.equal(JSON.parse(refused.body).error, "refused");
});

test("api mutation: new-task derives slug from title and honors ready+context", () => {
  const calls: string[][] = [];
  const runner: CliRunner = (args) => { calls.push(args); return { ok: true, stdout: "Created /x", stderr: "" }; };
  const r = routeApiMutation(
    "/api/projects/alpha/new-task",
    { title: "Shiny Thing!", type: "investigation", context: "some context", ready: true },
    runner,
  )!;
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.slug, "shiny-thing");
  assert.deepEqual(body.segments, ["alpha", "shiny-thing"]);
  assert.deepEqual(calls[0], ["new", "task", "alpha", "shiny-thing", "--title", "Shiny Thing!", "--type", "investigation"]);
  assert.deepEqual(calls[1], ["edit", "shiny-thing", "context", "some context"]);
  assert.deepEqual(calls[2], ["ready", "shiny-thing"]);
});

test("api mutation: bulk fans out per slug and reports per-row results", () => {
  const seen: string[][] = [];
  const runner: CliRunner = (args) => {
    seen.push(args);
    return args[1] === "alpha/bad"
      ? { ok: false, stdout: "", stderr: "illegal transition" }
      : { ok: true, stdout: `${args[1]} -> ready`, stderr: "" };
  };
  const r = routeApiMutation("/api/bulk/promote", { slugs: ["alpha/one", "alpha/bad"] }, runner)!;
  const body = JSON.parse(r.body);
  assert.equal(body.succeeded, 1);
  assert.equal(body.failed, 1);
  assert.equal(body.results[1].message, "illegal transition");
  assert.deepEqual(seen, [["ready", "alpha/one"], ["ready", "alpha/bad"]]);

  const noReason = routeApiMutation("/api/bulk/block", { slugs: ["alpha/one"] }, okRunner)!;
  assert.equal(noReason.status, 400);
});

test("api mutation: harness workers validates 0-16", () => {
  const ok = routeApiMutation("/api/harness/workers", { value: 3 }, okRunner)!;
  assert.equal(ok.status, 200);
  const over = routeApiMutation("/api/harness/workers", { value: 99 }, okRunner)!;
  assert.equal(over.status, 400);
  const junk = routeApiMutation("/api/harness/workers", { value: "-2" }, okRunner)!;
  assert.equal(junk.status, 400);
});

test("api mutation: edit passes empty value through and stamps mtime CAS", () => {
  // Clearing a section is a valid edit — empty string must survive the trip.
  const params = buildCliArgs("alpha/001", "edit", new URLSearchParams([["section", "outcome"], ["value", ""], ["mtime", "42"]]));
  assert.deepEqual(params, ["edit", "alpha/001", "outcome", "", "--expect-mtime", "42"]);
});

test("api: every MUTATION_ACTIONS entry is buildable with the right fields", () => {
  const fields: Record<string, Record<string, string>> = {
    block: { reason: "r" }, log: { message: "m" }, pr: { url: "u" },
    status: { status: "ready" }, "set-type": { type: "pr" },
    "allow-orchestrator": { allow: "true" }, "request-changes": { comment: "c" },
    edit: { section: "plan", value: "v" },
  };
  for (const action of MUTATION_ACTIONS) {
    const args = buildCliArgs("alpha/001", action, new URLSearchParams(fields[action] ?? {}));
    assert.ok(args, `buildCliArgs returned null for ${action}`);
  }
});

test("api: task detail digests cached PRs (github badge set, stale fallback)", () => {
  const url = "https://github.com/o/r/pull/7";
  const t = task("001-a", "review", { prs: [url] });
  const p = project("alpha", [t]);
  const fresh = {
    fetchedAt: new Date().toISOString(),
    host: "github",
    pr: { url, state: "OPEN", title: "Fix things", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", statusCheckRollup: [{ conclusion: "SUCCESS" }] },
  };
  const r = get("/api/tasks/alpha/001-a", "", [p], { prCache: () => fresh })!;
  const d = r.json.prDetails[0];
  assert.equal(d.displayId, "#7");
  assert.equal(d.fresh, true);
  assert.equal(d.state, "OPEN");
  assert.equal(d.ci, "PASS");
  assert.equal(d.review, "APPROVED");

  const stale = { ...fresh, fetchedAt: "2020-01-01T00:00:00Z" };
  const r2 = get("/api/tasks/alpha/001-a", "", [p], { prCache: () => stale })!;
  assert.equal(r2.json.prDetails[0].fresh, false);
  assert.equal(r2.json.prDetails[0].state, undefined);

  const r3 = get("/api/tasks/alpha/001-a", "", [p])!;
  assert.equal(r3.json.prDetails[0].fresh, false);
});

test("api: /api/config returns the injected snapshot; /runs falls through", () => {
  const snapshot = { path: "/x/config.json", raw: "{}", parsed: {}, error: null, missing: false };
  const r = get("/api/config", "", [], { configSnapshot: () => snapshot })!;
  assert.deepEqual(r.json.config, snapshot);

  // The runs sub-resource belongs to route() — routeApi must not claim it.
  assert.equal(get("/api/tasks/alpha/001-a/runs", "", [project("alpha", [task("001-a", "ready")])]), null);
});

test("api: task detail carries the report artifact when report.md exists on disk", () => {
  // Folder-form task with a real report file — taskHasReport/taskReportPath
  // read the filesystem, so this fixture touches disk.
  const dir = join(tmpdir(), `tpm-api-report-${process.pid}`);
  mkdirSync(join(dir, "001-a"), { recursive: true });
  writeFileSync(join(dir, "001-a", "report.md"), "# Report\n\n## Summary\nall good.\n");
  const t: Task = {
    ...task("001-a", "review", { type: "investigation" }),
    path: join(dir, "001-a", "task.md"),
    dir: join(dir, "001-a"),
  };
  try {
    const r = get("/api/tasks/alpha/001-a", "", [project("alpha", [t])])!;
    assert.equal(r.json.hasReport, true);
    assert.match(r.json.report.raw, /all good/);
    assert.match(r.json.report.html, /Summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("api: /api/vocab ships bulk caps keyed by status", () => {
  const r = get("/api/vocab")!;
  assert.deepEqual(r.json.bulkCaps.done, ["archive"]);
  assert.ok(r.json.bulkCaps.ready.includes("pull"));
  // Every cap references a real bulk action.
  for (const caps of Object.values(r.json.bulkCaps) as string[][]) {
    for (const c of caps) assert.ok(r.json.bulkActions[c], `unknown bulk action ${c}`);
  }
});

test("api: /api/vocab carries the wire-surface version for skew detection", () => {
  const r = get("/api/vocab")!;
  assert.equal(typeof r.json.apiVersion, "number");
  assert.ok(r.json.apiVersion >= 3);
});

test("api mutation: /api/cli executes the forwarded argv through the runner verbatim", () => {
  const calls: string[][] = [];
  const runner: CliRunner = (args) => { calls.push(args); return { ok: true, stdout: "did it", stderr: "" }; };
  const r = routeApiMutation("/api/cli", { argv: ["pr", "alpha/001", "https://x/1"], root: "/x", actor: "worker-1" }, runner)!;
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, stdout: "did it", stderr: "" });
  assert.deepEqual(calls, [["pr", "alpha/001", "https://x/1"]]);

  const missing = routeApiMutation("/api/cli", {}, runner)!;
  assert.equal(missing.status, 400);
});
