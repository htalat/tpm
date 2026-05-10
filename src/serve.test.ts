import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "./serve.ts";
import type { Project, Task } from "./tree.ts";

function task(slug: string, status: string, extra: Record<string, unknown> = {}): Task {
  return {
    slug,
    path: `/tmp/${slug}.md`,
    archived: false,
    data: { slug, status, title: `Task ${slug}`, type: "pr", created: "2026-01-01 00:00 PDT", prs: [], ...extra },
    body: "## Context\nbody.\n\n## Plan\n- step 1\n",
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

test("route: / renders index with queue sections", () => {
  const p = project("alpha", [
    task("001-r", "ready"),
    task("002-nf", "needs-feedback"),
    task("003-ip", "in-progress"),
    task("004-nr", "needs-review"),
  ]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
  // All three queue headings render.
  assert.match(r.body, /Your inbox/);
  assert.match(r.body, /Agent queue/);
  assert.match(r.body, /In flight/);
  // Each task's slug appears.
  for (const slug of ["001-r", "002-nf", "003-ip", "004-nr"]) {
    assert.match(r.body, new RegExp(slug));
  }
});

test("route: / supports ?project= filter", () => {
  const a = project("alpha", [task("001", "open")]);
  const b = project("beta",  [task("002", "open")]);
  const r = route("/", new URLSearchParams("project=beta"), [a, b]);
  assert.match(r.body, /002/);
  assert.doesNotMatch(r.body, /alpha\/001/);
});

test("route: /api/refresh returns JSON with counts and timestamp", () => {
  const p = project("alpha", [
    task("001", "ready"),
    task("002", "ready"),
    task("003", "in-progress"),
  ]);
  const r = route("/api/refresh", new URLSearchParams(), [p]);
  assert.equal(r.status, 200);
  assert.equal(r.contentType, "application/json");
  const json = JSON.parse(r.body);
  assert.ok(typeof json.generated === "string");
  assert.deepEqual(json.counts, { ready: 2, "in-progress": 1 });
});

test("route: /p/<project> renders project view with tasks grouped by status", () => {
  const p = project("alpha", [
    task("001-ready",   "ready"),
    task("002-needs",   "needs-feedback"),
    task("003-blocked", "blocked"),
  ]);
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  assert.equal(r.status, 200);
  assert.match(r.body, /alpha/);
  assert.match(r.body, /needs-feedback/);
  assert.match(r.body, /blocked/);
  for (const slug of ["001-ready", "002-needs", "003-blocked"]) {
    assert.match(r.body, new RegExp(slug));
  }
});

test("route: /p/<unknown> returns 404", () => {
  const r = route("/p/nope", new URLSearchParams(), []);
  assert.equal(r.status, 404);
});

test("route: /t/<project>/<slug> renders task view (sidebar + body)", () => {
  const t = task("001-foo", "in-progress", { prs: ["https://github.com/x/y/pull/1"] });
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-foo", new URLSearchParams(), [p]);
  assert.equal(r.status, 200);
  assert.match(r.body, /Task 001-foo/);
  assert.match(r.body, /in-progress/);
  // Body markdown rendered to HTML (Plan section becomes <h2>).
  assert.match(r.body, /<h2>Plan<\/h2>/);
  // PR link surfaces.
  assert.match(r.body, /github\.com\/x\/y\/pull\/1/);
});

test("route: /t/<project>/<parent>/<child> resolves child task", () => {
  const child = task("003-child", "ready", { parent: "002-parent" });
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/t/alpha/002-parent/003-child", new URLSearchParams(), [p]);
  assert.equal(r.status, 200);
  assert.match(r.body, /Task 003-child/);
});

test("route: /t/<unknown> returns 404", () => {
  const r = route("/t/alpha/no-such", new URLSearchParams(), [project("alpha", [])]);
  assert.equal(r.status, 404);
});

test("route: unknown path returns 404", () => {
  const r = route("/foo/bar", new URLSearchParams(), []);
  assert.equal(r.status, 404);
});

test("route: index escapes task titles (no HTML injection)", () => {
  const p = project("alpha", [task("001", "ready", { title: "<script>x</script>" })]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.match(r.body, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(r.body, /<script>x<\/script>/);
});

test("route: archived and parent tasks are excluded from index queue lists", () => {
  const child = task("003-child", "ready", { parent: "002-parent" });
  child.parent = "002-parent";
  const parentReady = task("002-parent", "ready");
  parentReady.children = [child];
  const archived = task("001-old", "ready");
  archived.archived = true;
  const p = project("alpha", [archived, parentReady]);
  const r = route("/", new URLSearchParams(), [p]);
  // Only the live, non-parent leaf (003-child) shows in agent queue.
  assert.match(r.body, /003-child/);
  assert.doesNotMatch(r.body, /001-old/);
});

test("route: / renders a project chips nav with all projects", () => {
  const a = project("alpha", [task("001", "ready")]);
  const b = project("beta",  [task("002", "open")]);
  const r = route("/", new URLSearchParams(), [a, b]);
  assert.match(r.body, /project-chips/);
  assert.match(r.body, /href="\/p\/alpha"/);
  assert.match(r.body, /href="\/p\/beta"/);
});

test("route: /p/<slug> hides archived tasks by default", () => {
  const live = task("001-live", "ready");
  const old = task("099-old", "done", { closed: "2026-01-01 12:00 PDT" });
  old.archived = true;
  const p = project("alpha", [live, old]);
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  assert.match(r.body, /001-live/);
  assert.doesNotMatch(r.body, /099-old/);
  // Toggle link offers to show archived.
  assert.match(r.body, /Show archived/);
  assert.match(r.body, /href="\/p\/alpha\?archived=1"/);
});

test("route: /p/<slug>?archived=1 includes archived tasks deemphasized", () => {
  const live = task("001-live", "ready");
  const old = task("099-old", "done", { closed: "2026-01-01 12:00 PDT" });
  old.archived = true;
  const p = project("alpha", [live, old]);
  const r = route("/p/alpha", new URLSearchParams("archived=1"), [p]);
  assert.match(r.body, /099-old/);
  // Row carries the archived class so CSS can deemphasize it.
  assert.match(r.body, /task-row[^"]*\barchived\b/);
  // Toggle link offers to hide archived.
  assert.match(r.body, /Hide archived/);
});

test("route: /p/<slug> sidebar shows project status, repo, host", () => {
  const p = project("alpha", [task("001", "ready")], {
    status: "active",
    repo: { remote: "https://github.com/x/alpha.git" },
    host: "github",
  });
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  // Sidebar element present with project meta.
  assert.match(r.body, /<aside class="sidebar">/);
  assert.match(r.body, /github\.com\/x\/alpha/);
  assert.match(r.body, /github/);
});

test("route: /p/<slug> archived done tasks sort by closed desc", () => {
  const older = task("001-older", "done", { closed: "2026-01-01 12:00 PDT" });
  older.archived = true;
  const newer = task("002-newer", "done", { closed: "2026-03-01 12:00 PDT" });
  newer.archived = true;
  const p = project("alpha", [older, newer]);
  const r = route("/p/alpha", new URLSearchParams("archived=1"), [p]);
  // Newer (002) appears before older (001) in the rendered HTML.
  const idxNewer = r.body.indexOf("002-newer");
  const idxOlder = r.body.indexOf("001-older");
  assert.ok(idxNewer >= 0 && idxOlder >= 0);
  assert.ok(idxNewer < idxOlder, "archived done tasks should sort by closed desc");
});

test("route: /t/<project>/<slug> resolves an archived task", () => {
  const old = task("099-old", "done");
  old.archived = true;
  const p = project("alpha", [old]);
  const r = route("/t/alpha/099-old", new URLSearchParams(), [p]);
  assert.equal(r.status, 200);
  assert.match(r.body, /Task 099-old/);
});
