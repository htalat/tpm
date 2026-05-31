import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { route, routeMutation, isSameOrigin, isLoopback } from "./serve.ts";
import type { CliRunner, ConfigSnapshot, PrCacheReader } from "./serve.ts";
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

// Build a folder-form task on disk with an optional `report.md` inside.
// Used by serve tests that exercise the filesystem-truth report check
// (task 094 — readers look at <task-dir>/report.md, not frontmatter).
// Caller must pass a fresh temp `root` and clean it up at end-of-test.
function folderTask(
  root: string,
  slug: string,
  status: string,
  opts: { hasReport?: boolean; reportBody?: string; extra?: Record<string, unknown> } = {},
): Task {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const taskPath = join(dir, "task.md");
  writeFileSync(taskPath, "---\nstatus: " + status + "\n---\n");
  if (opts.hasReport) {
    writeFileSync(join(dir, "report.md"), opts.reportBody ?? "# Report\n\n## Summary\nbody.\n");
  }
  return {
    slug,
    path: taskPath,
    dir,
    archived: false,
    data: { slug, status, title: `Task ${slug}`, type: "pr", created: "2026-01-01 00:00 PDT", prs: [], ...(opts.extra ?? {}) },
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

test("renderProject: layout opts out of the rail column (no-rail)", () => {
  // Project pages never render a right rail — they should collapse the .layout
  // grid back to 2-col so the main content fills the space the rail reserved.
  const p = project("alpha", [task("001-ready", "ready")]);
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  assert.match(r.body, /class="layout no-rail"/);
  assert.doesNotMatch(r.body, /class="task-rail"/);
});

test("serve CSS: body widens to 1600px and grid columns use minmax(0, 1fr)", () => {
  // Regression guard for task 070: the dashboard pages need a wider body cap
  // than the 980px reading column BASE_CSS sets for `tpm report`, and the
  // grid's middle column needs `minmax(0, 1fr)` so a long <pre> line in a
  // task body can't blow the grid past the body box and shove the right rail
  // toward the viewport edge.
  const p = project("alpha", [task("001-ready", "ready")]);
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  assert.match(r.body, /body\s*\{[^}]*max-width:\s*1600px/);
  assert.match(r.body, /\.layout\s*\{[^}]*grid-template-columns:\s*220px\s+minmax\(0,\s*1fr\)\s+260px/);
  assert.match(r.body, /\.layout\.no-rail\s*\{[^}]*grid-template-columns:\s*220px\s+minmax\(0,\s*1fr\)/);
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

test("route: external links (PR, repo) open in a new tab; internal links stay in-tab", () => {
  const child = task("002-child", "ready", { parent: "001-parent" });
  child.parent = "001-parent";
  const parent = task(
    "001-parent",
    "in-progress",
    { prs: ["https://github.com/x/y/pull/1"], repo: { remote: "https://github.com/x/y.git" } },
  );
  parent.children = [child];
  const p = project("alpha", [parent], { repo: { remote: "https://github.com/x/y.git" } });
  const r = route("/t/alpha/001-parent", new URLSearchParams(), [p]);
  assert.equal(r.status, 200);
  // External: PR link in the task detail list carries target/rel.
  assert.match(
    r.body,
    /<a href="https:\/\/github\.com\/x\/y\/pull\/1" target="_blank" rel="noopener noreferrer">/,
  );
  // External: repo remote in the sidebar carries target/rel.
  assert.match(
    r.body,
    /<a href="https:\/\/github\.com\/x\/y\.git" target="_blank" rel="noopener noreferrer">/,
  );
  // Internal: children link to /t/... has no target="_blank".
  const childAnchor = r.body.match(/<a href="\/t\/alpha\/001-parent\/002-child">[^<]*<\/a>/);
  assert.ok(childAnchor, "expected internal child link to render");
  assert.doesNotMatch(childAnchor![0], /target="_blank"/);
  // Internal: breadcrumb / project link doesn't carry target="_blank".
  const projAnchor = r.body.match(/<a href="\/p\/alpha">[^<]*<\/a>/);
  assert.ok(projAnchor, "expected internal project link to render");
  assert.doesNotMatch(projAnchor![0], /target="_blank"/);
});

test("route: task body markdown external links open in a new tab; anchor links don't", () => {
  const t = task("001-foo", "in-progress");
  t.body = "## Context\nsee [PR](https://github.com/x/y/pull/42) and [log](#log).\n";
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-foo", new URLSearchParams(), [p]);
  assert.match(
    r.body,
    /<a href="https:\/\/github\.com\/x\/y\/pull\/42" target="_blank" rel="noopener noreferrer">PR<\/a>/,
  );
  const anchor = r.body.match(/<a href="#log">[^<]*<\/a>/);
  assert.ok(anchor, "expected anchor link to render");
  assert.doesNotMatch(anchor![0], /target="_blank"/);
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

test("taskRow: child in a status queue shows a parent crumb, not an orphan indent", () => {
  // Parent is `ready` (hidden as a container); its child is `blocked`, so the
  // child surfaces alone in the blocked section with no parent adjacent.
  const child = task("003-child", "blocked", { parent: "002-parent" });
  child.parent = "002-parent";
  const parentReady = task("002-parent", "ready");
  parentReady.children = [child];
  const p = project("alpha", [parentReady]);
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  // Parent context renders inline as a breadcrumb link to the parent task...
  assert.match(r.body, /<a class="parent-crumb" href="\/t\/alpha\/002-parent">002-parent<\/a>/);
  // ...and the old orphan-indent `child` class is gone from the row.
  assert.doesNotMatch(r.body, /class="task-row[^"]*\bchild\b/);
});

test("route: / renders a project chips nav with all projects", () => {
  const a = project("alpha", [task("001", "ready")]);
  const b = project("beta",  [task("002", "open")]);
  const r = route("/", new URLSearchParams(), [a, b]);
  assert.match(r.body, /project-chips/);
  assert.match(r.body, /href="\/p\/alpha"/);
  assert.match(r.body, /href="\/p\/beta"/);
});

test("route: project chips split projects (left) from the logs/config views (right)", () => {
  const a = project("alpha", [task("001", "ready")]);
  const r = route("/", new URLSearchParams(), [a]).body;
  // Project chips live in their own left cluster...
  assert.match(r, /<div class="chip-group chip-group-projects"><a class="chip" href="\/p\/alpha">alpha<\/a><\/div>/);
  // ...and the tracker-wide views are a distinct right cluster, not inline
  // project chips.
  assert.match(r, /<div class="chip-group chip-group-views"><a class="chip chip-logs" href="\/logs">logs<\/a><a class="chip chip-config" href="\/config">config<\/a><\/div>/);
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

// ---- /p/<proj>/artifacts --------------------------------------------------

const noPrCache: PrCacheReader = () => null;

test("renderProject: header links to the artifacts index", () => {
  const p = project("alpha", [task("001-a", "ready")]);
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  assert.match(r.body, /href="\/p\/alpha\/artifacts"/);
});

test("route: /p/<slug>/artifacts renders rows for PRs and reports together", () => {
  const root = mkTempDir();
  try {
    const withPr = task("001-pr", "done", {
      prs: ["https://github.com/x/y/pull/79"],
      closed: "2026-04-01 12:00 PDT",
    });
    withPr.archived = true;
    const withReport = folderTask(root, "002-rep", "done", { hasReport: true });
    const withBoth = folderTask(root, "003-both", "done", {
      hasReport: true,
      extra: { prs: ["https://github.com/x/y/pull/45"] },
    });
    const noArtifact = task("004-bare", "ready");
    const p = project("alpha", [withPr, withReport, withBoth, noArtifact]);
    const r = route("/p/alpha/artifacts", new URLSearchParams(), [p], { prCache: noPrCache });
    assert.equal(r.status, 200);
    assert.match(r.body, /Artifacts —/);
    // Three artifact rows render; the bare task is excluded.
    assert.match(r.body, /001-pr/);
    assert.match(r.body, /002-rep/);
    assert.match(r.body, /003-both/);
    assert.doesNotMatch(r.body, /004-bare/);
    // PR chips link to GitHub and the report chip links in-app.
    assert.match(r.body, /href="https:\/\/github\.com\/x\/y\/pull\/79"/);
    assert.match(r.body, /class="report-chip[^"]*"[^>]*href="\/t\/alpha\/002-rep\/report"/);
    // The task with both gets both chip types.
    assert.match(r.body, /href="https:\/\/github\.com\/x\/y\/pull\/45"/);
    assert.match(r.body, /href="\/t\/alpha\/003-both\/report"/);
  } finally {
    rmTempDir(root);
  }
});

test("route: /p/<slug>/artifacts?type=pr narrows to PR-bearing rows", () => {
  const root = mkTempDir();
  try {
    const withPr = task("001-pr", "done", { prs: ["https://github.com/x/y/pull/79"] });
    const withReport = folderTask(root, "002-rep", "done", { hasReport: true });
    const p = project("alpha", [withPr, withReport]);
    const r = route("/p/alpha/artifacts", new URLSearchParams("type=pr"), [p], { prCache: noPrCache });
    assert.match(r.body, /001-pr/);
    assert.doesNotMatch(r.body, /002-rep/);
  } finally {
    rmTempDir(root);
  }
});

test("route: /p/<slug>/artifacts?type=report narrows to report-bearing rows", () => {
  const root = mkTempDir();
  try {
    const withPr = task("001-pr", "done", { prs: ["https://github.com/x/y/pull/79"] });
    const withReport = folderTask(root, "002-rep", "done", { hasReport: true });
    const p = project("alpha", [withPr, withReport]);
    const r = route("/p/alpha/artifacts", new URLSearchParams("type=report"), [p], { prCache: noPrCache });
    assert.doesNotMatch(r.body, /001-pr/);
    assert.match(r.body, /002-rep/);
  } finally {
    rmTempDir(root);
  }
});

test("route: /p/<slug>/artifacts renders an empty state when no task has artifacts", () => {
  const p = project("alpha", [task("001-a", "ready"), task("002-b", "in-progress")]);
  const r = route("/p/alpha/artifacts", new URLSearchParams(), [p], { prCache: noPrCache });
  assert.equal(r.status, 200);
  assert.match(r.body, /No artifacts yet/);
});

test("route: /p/<slug>/artifacts sorts rows by most recent task-Log activity first", () => {
  const root = mkTempDir();
  try {
    const older = task("001-older", "done", { prs: ["https://github.com/x/y/pull/10"] });
    older.body = "## Log\n- 2026-01-01 12:00 PDT: shipped\n";
    const newer = folderTask(root, "002-newer", "done", { hasReport: true });
    newer.body = "## Log\n- 2026-04-01 12:00 PDT: shipped\n";
    const p = project("alpha", [older, newer]);
    const r = route("/p/alpha/artifacts", new URLSearchParams(), [p], { prCache: noPrCache });
    const idxNewer = r.body.indexOf("002-newer");
    const idxOlder = r.body.indexOf("001-older");
    assert.ok(idxNewer >= 0 && idxOlder >= 0);
    assert.ok(idxNewer < idxOlder, "newer Log activity should sort above older");
  } finally {
    rmTempDir(root);
  }
});

test("route: /p/<slug>/artifacts exposes active-filter chip styling", () => {
  const t = task("001-pr", "done", { prs: ["https://github.com/x/y/pull/79"] });
  const p = project("alpha", [t]);
  const allR = route("/p/alpha/artifacts", new URLSearchParams(), [p], { prCache: noPrCache });
  // The "All" chip is the active span, "PRs"/"Reports" remain links.
  assert.match(allR.body, /<span class="chip active">All<\/span>/);
  assert.match(allR.body, /href="\/p\/alpha\/artifacts\?type=pr"/);
  const prR = route("/p/alpha/artifacts", new URLSearchParams("type=pr"), [p], { prCache: noPrCache });
  assert.match(prR.body, /<span class="chip active">PRs<\/span>/);
});

test("route: /p/<slug>/artifacts on an unknown project returns 404", () => {
  const p = project("alpha", [task("001-a", "ready")]);
  const r = route("/p/missing/artifacts", new URLSearchParams(), [p]);
  assert.equal(r.status, 404);
});

// ---- task action UI (form gating per status) ------------------------------

function captureRunner(): { runner: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CliRunner = (args) => {
    calls.push(args);
    return { ok: true, stdout: `mock: ${args.join(" ")}`, stderr: "" };
  };
  return { runner, calls };
}

test("renderTask: in-progress task shows Block + Complete + Log + Add PR forms", () => {
  const t = task("001-a", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /class="task-actions"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/block"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/complete"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/log"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/pr"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/allow-orchestrator"/);
});

test("renderTask: open task offers Promote + Block + Complete + Drop", () => {
  const t = task("001-a", "open");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /action="\/t\/alpha\/001-a\/ready"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/block"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/status"/);
  // Close affordance even at open: chores/spikes can be closed without a PR.
  assert.match(r.body, /action="\/t\/alpha\/001-a\/complete"/);
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/pr"/);
});

test("renderTask: Complete (Close) form renders for every non-terminal status", () => {
  // Closing is a first-class UI action: no status should force the user to the
  // shell to run `tpm complete`. Terminal states (done/dropped) render no
  // actions at all — covered by the done/dropped test below.
  for (const status of ["open", "ready", "in-progress", "needs-feedback", "needs-close", "needs-review", "blocked"]) {
    const t = task("001-a", status);
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.match(r.body, /action="\/t\/alpha\/001-a\/complete"/, `expected Complete form for status=${status}`);
  }
});

test("renderTask: done/dropped tasks render the Archive button but no transition or settings forms", () => {
  // Terminal tasks are view-only for status transitions, but a non-archived
  // done/dropped task can still be retired off the canonical path — the Archive
  // button is the lone action it offers (task 101).
  for (const status of ["done", "dropped"]) {
    const t = task(`001-${status}`, status);
    const p = project("alpha", [t]);
    const r = route(`/t/alpha/001-${status}`, new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.match(r.body, new RegExp(`action="/t/alpha/001-${status}/archive"`), `expected Archive form for status=${status}`);
    for (const verb of ["complete", "block", "ready", "status", "log", "pr", "reopen"]) {
      assert.doesNotMatch(r.body, new RegExp(`action="/t/alpha/001-${status}/${verb}"`), `expected no ${verb} form for status=${status}`);
    }
    assert.doesNotMatch(r.body, /class="task-settings"/, `expected no settings forms for status=${status}`);
    assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-[^/]+\/allow-orchestrator"/, `expected no allow toggle for status=${status}`);
  }
});

test("renderTask: non-terminal tasks don't offer the Archive button", () => {
  // Archive is only for retiring an already-closed task; live statuses must
  // close first (the button shows up once status is done/dropped).
  for (const status of ["open", "ready", "in-progress", "needs-feedback", "needs-close", "needs-review", "blocked"]) {
    const t = task("001-a", status);
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/archive"/, `expected no Archive form for status=${status}`);
  }
});

test("renderTask: mutationsEnabled=false hides the Archive button on a done task", () => {
  // CLI-only mode surfaces the disabled-actions notice instead of any form.
  const t = task("001-done", "done");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-done", new URLSearchParams(), [p], { mutationsEnabled: false });
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-done\/archive"/);
});

test("renderTask: allow_orchestrator toggle renders for every promoted non-terminal status", () => {
  // Settings live outside the action-verb switch — every promotable,
  // non-parent, non-archived task should expose the toggle. `open` is the lone
  // exception (covered below): its only promotion path already sets the flag.
  for (const status of ["ready", "in-progress", "needs-feedback", "needs-close", "needs-review", "blocked"]) {
    const t = task("001-a", status);
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.match(r.body, /class="task-settings"/, `expected settings section for status=${status}`);
    assert.match(r.body, /action="\/t\/alpha\/001-a\/allow-orchestrator"/, `expected allow toggle for status=${status}`);
  }
});

test("renderTask: open task offers Promote to ready but no separate autonomous toggle", () => {
  // "Promote to ready" now sets allow_orchestrator: true in the same op, so the
  // open-task promotion is one button — no redundant "Enable autonomous" toggle.
  const t = task("001-a", "open");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /action="\/t\/alpha\/001-a\/ready"/, "expected Promote to ready form");
  assert.doesNotMatch(r.body, /class="task-settings"/, "expected no settings section for open task");
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/allow-orchestrator"/, "expected no allow toggle for open task");
});

test("renderTask: archived task renders no settings or Archive forms", () => {
  const t = task("099-old", "done");
  t.archived = true;
  const p = project("alpha", [t]);
  const r = route("/t/alpha/099-old", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.doesNotMatch(r.body, /class="task-settings"/);
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/099-old\/allow-orchestrator"/);
  // Already archived: the Archive button is hidden (re-archiving is a no-op).
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/099-old\/archive"/);
});

test("renderTask: needs-close offers Complete prominently + Log + Block", () => {
  // Merged-PR sweep state: Complete is the dominant action.
  const t = task("001-nc", "needs-close");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-nc", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /action="\/t\/alpha\/001-nc\/complete"/);
  assert.match(r.body, /action="\/t\/alpha\/001-nc\/log"/);
  assert.match(r.body, /action="\/t\/alpha\/001-nc\/block"/);
});

test("route: index agent queue includes needs-close, sorted needs-feedback > needs-close > ready", () => {
  const p = project("alpha", [
    task("001-old-ready",   "ready",          { created: "2026-01-01 00:00 PDT" }),
    task("002-nc",          "needs-close",    { created: "2026-05-01 00:00 PDT" }),
    task("003-nf",          "needs-feedback", { created: "2026-05-09 00:00 PDT" }),
  ]);
  const r = route("/", new URLSearchParams(), [p]);
  for (const slug of ["001-old-ready", "002-nc", "003-nf"]) {
    assert.match(r.body, new RegExp(slug));
  }
  const idxFeedback = r.body.indexOf("003-nf");
  const idxClose    = r.body.indexOf("002-nc");
  const idxReady    = r.body.indexOf("001-old-ready");
  assert.ok(idxFeedback < idxClose, "needs-feedback should render before needs-close");
  assert.ok(idxClose < idxReady, "needs-close should render before ready");
});

test("renderTask: parent container renders no action forms", () => {
  const child = task("003-child", "ready", { parent: "002-parent" });
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/t/alpha/002-parent", new URLSearchParams(), [p], { mutationsEnabled: true });
  // Parent container is non-actionable.
  assert.doesNotMatch(r.body, /class="task-actions"[^"]*"/);
});

test("renderTask: child task forms post to /t/<project>/<parent>/<child>/...", () => {
  const child = task("003-child", "in-progress", { parent: "002-parent" });
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/t/alpha/002-parent/003-child", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /action="\/t\/alpha\/002-parent\/003-child\/log"/);
  assert.match(r.body, /action="\/t\/alpha\/002-parent\/003-child\/complete"/);
});

test("renderTask: shows flash banner when ?flash= present", () => {
  const t = task("001-a", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams("flash=blocked%20%E2%80%94%20waiting"), [p], {
    flash: "blocked — waiting", mutationsEnabled: true,
  });
  assert.match(r.body, /class="flash"/);
  assert.match(r.body, /blocked — waiting/);
});

test("renderTask: mutationsEnabled=false renders a disabled-actions notice", () => {
  const t = task("001-a", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: false });
  assert.match(r.body, /class="task-actions disabled"/);
  assert.doesNotMatch(r.body, /<form method="POST"/);
});

test("renderTask: actionable task wraps View log / View runs / PR / Actions / Settings inside a .task-rail next to the body", () => {
  // Rail sits inside .layout (the grid container), not after it. Order within
  // the rail (task 076): View log → View runs → PR panel → Actions → Settings.
  const t = task("001-a", "in-progress", { prs: ["https://github.com/x/y/pull/1"] });
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], {
    mutationsEnabled: true,
  });
  assert.match(r.body, /class="task-rail"/);
  const idxLayoutOpen  = r.body.indexOf('class="layout');
  const idxRail        = r.body.indexOf('class="task-rail"');
  const idxLayoutClose = r.body.indexOf("</div>", idxRail);
  // Rail must sit inside the layout grid (between its open and its first close).
  assert.ok(idxLayoutOpen >= 0 && idxRail > idxLayoutOpen && idxLayoutClose > idxRail);
  const idxLog      = r.body.indexOf('class="task-log-link"');
  const idxRuns     = r.body.indexOf('class="task-runs-link"');
  const idxPr       = r.body.indexOf('class="pr-panel"');
  const idxActions  = r.body.indexOf('class="task-actions"');
  const idxSettings = r.body.indexOf('class="task-settings"');
  assert.ok(idxRail < idxLog && idxLog < idxRuns && idxRuns < idxPr && idxPr < idxActions && idxActions < idxSettings,
    "expected rail order View log → View runs → PR → Actions → Settings");
  // No embedded Recent log panel — only standalone links live in the rail.
  assert.doesNotMatch(r.body, /class="task-recent-log"/);
  // Layout opts into the rail (no "no-rail" fallback class).
  assert.doesNotMatch(r.body, /class="layout no-rail"/);
});

test("renderTask: terminal task with PR history keeps the rail (PR panel + Archive)", () => {
  const t = task("001-done", "done", { prs: ["https://github.com/x/y/pull/1"] });
  const p = project("alpha", [t]);
  const prCache: PrCacheReader = () => null;
  const r = route("/t/alpha/001-done", new URLSearchParams(), [p], { mutationsEnabled: true, prCache });
  assert.match(r.body, /class="task-rail"/);
  assert.match(r.body, /class="pr-panel"/);
  // Terminal but not archived: the Archive button is the one available action.
  assert.match(r.body, /action="\/t\/alpha\/001-done\/archive"/);
  assert.doesNotMatch(r.body, /class="task-settings"/);
  assert.doesNotMatch(r.body, /class="layout no-rail"/);
});

test("renderTask: terminal task with no PRs keeps the rail open for the View log + View runs links", () => {
  // Pre-073, a done/dropped task with no PRs collapsed to 2-col. Both rail
  // links survive on terminal tasks — the audit trail (envelope + body Log
  // at /log, per-run captures at /runs) is exactly what a visitor wants on
  // a closed task — so the rail stays open.
  const t = task("001-done", "done");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-done", new URLSearchParams(), [p], {
    mutationsEnabled: true,
  });
  assert.match(r.body, /class="task-rail"/);
  assert.match(r.body, /class="task-log-link"/);
  assert.match(r.body, /class="task-runs-link"/);
  assert.doesNotMatch(r.body, /class="layout no-rail"/);
  // No embedded Recent log panel — only standalone links.
  assert.doesNotMatch(r.body, /class="task-recent-log"/);
  // No settings/PRs on a terminal task with no linked PRs; the Archive button
  // is the lone action a non-archived terminal task offers.
  assert.match(r.body, /action="\/t\/alpha\/001-done\/archive"/);
  assert.doesNotMatch(r.body, /class="task-settings"/);
  assert.doesNotMatch(r.body, /class="pr-panel"/);
});

test("renderTask: mutationsEnabled=false still rails the disabled notice + PR panel", () => {
  // CLI-only mode: the Settings section is hidden, but the disabled Actions
  // notice (and the PR panel, if any) still live in the rail.
  const t = task("001-a", "in-progress", { prs: ["https://github.com/x/y/pull/1"] });
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: false });
  assert.match(r.body, /class="task-rail"/);
  assert.match(r.body, /class="pr-panel"/);
  assert.match(r.body, /class="task-actions disabled"/);
  assert.doesNotMatch(r.body, /class="task-settings"/);
});

test("renderTask: allow-orchestrator toggle hidden input flips based on current value", () => {
  const on = task("001-on", "in-progress", { allow_orchestrator: true });
  const off = task("002-off", "in-progress", { allow_orchestrator: false });
  const p = project("alpha", [on, off]);
  const rOn = route("/t/alpha/001-on", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(rOn.body, /name="allow" value="false"/);
  assert.match(rOn.body, /Disable autonomous/);
  const rOff = route("/t/alpha/002-off", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(rOff.body, /name="allow" value="true"/);
  assert.match(rOff.body, /Enable autonomous/);
});

test("renderTask: flash banner is HTML-escaped (no injection)", () => {
  const t = task("001-a", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], {
    flash: '<script>alert("xss")</script>', mutationsEnabled: true,
  });
  assert.doesNotMatch(r.body, /<script>alert/);
  assert.match(r.body, /&lt;script&gt;/);
});

// ---- lock-state decoration (task 109) -------------------------------------

function lockSnapshot(entries: Record<string, { agentId?: string; pid?: number; acquired?: string }>) {
  const m = new Map<string, { agentId: string; pid: number; acquired: string }>();
  for (const [slug, e] of Object.entries(entries)) {
    m.set(slug, {
      agentId: e.agentId ?? "agent-x",
      pid: e.pid ?? 1234,
      acquired: e.acquired ?? "2026-05-26 09:00 PDT",
    });
  }
  return () => m;
}

test("taskRow: ready task with held lock renders a working chip on the index", () => {
  const t = task("001-claimed", "ready");
  const p = project("alpha", [t]);
  const r = route("/", new URLSearchParams(), [p], {
    taskLocks: lockSnapshot({ "alpha/001-claimed": {} }),
  });
  // The row sits in the Agent queue and now carries the lock chip next to ready.
  assert.match(r.body, /001-claimed/);
  assert.match(r.body, /class="lock-chip lock-chip-working"/);
});

test("taskRow: in-progress task with no lock renders an unclaimed chip", () => {
  const t = task("002-stranded", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/", new URLSearchParams(), [p], { taskLocks: lockSnapshot({}) });
  assert.match(r.body, /002-stranded/);
  assert.match(r.body, /class="lock-chip lock-chip-unclaimed"/);
  assert.doesNotMatch(r.body, /class="lock-chip lock-chip-working"/);
});

test("taskRow: in-progress task with a held lock renders working (not unclaimed)", () => {
  const t = task("003-live", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/", new URLSearchParams(), [p], {
    taskLocks: lockSnapshot({ "alpha/003-live": {} }),
  });
  assert.match(r.body, /class="lock-chip lock-chip-working"/);
  assert.doesNotMatch(r.body, /class="lock-chip lock-chip-unclaimed"/);
});

test("taskRow: terminal tasks never render a lock chip, even with a stale lock present", () => {
  const done = task("001-d", "done", { closed: "2026-04-01 12:00 PDT" });
  const dropped = task("002-x", "dropped", { closed: "2026-04-02 12:00 PDT" });
  const p = project("alpha", [done, dropped]);
  const r = route("/p/alpha", new URLSearchParams(), [p], {
    taskLocks: lockSnapshot({ "alpha/001-d": {}, "alpha/002-x": {} }),
  });
  assert.match(r.body, /001-d/);
  assert.match(r.body, /002-x/);
  assert.doesNotMatch(r.body, /class="lock-chip/);
});

test("taskRow: archived task never renders a lock chip", () => {
  const t = task("001-old", "in-progress");
  t.archived = true;
  const p = project("alpha", [t]);
  const r = route("/p/alpha", new URLSearchParams("archived=1"), [p], {
    taskLocks: lockSnapshot({ "alpha/001-old": {} }),
  });
  assert.match(r.body, /001-old/);
  assert.doesNotMatch(r.body, /class="lock-chip/);
});

test("taskRow: lock snapshot keys child rows by the full qualified slug", () => {
  const child = task("003-child", "ready", { parent: "002-parent" });
  child.parent = "002-parent";
  const parent = task("002-parent", "ready");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/p/alpha", new URLSearchParams(), [p], {
    taskLocks: lockSnapshot({ "alpha/002-parent/003-child": {} }),
  });
  assert.match(r.body, /003-child/);
  assert.match(r.body, /class="lock-chip lock-chip-working"/);
});

test("renderTask: detail page mirrors the working chip and surfaces lock holder metadata", () => {
  const t = task("001-claimed", "ready");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-claimed", new URLSearchParams(), [p], {
    taskLocks: lockSnapshot({
      "alpha/001-claimed": { agentId: "claude-orch", pid: 4242, acquired: "2026-05-26 09:15 PDT" },
    }),
  });
  assert.match(r.body, /class="lock-chip lock-chip-working"/);
  // Holder line includes the agent id, pid, and acquired stamp from the snapshot.
  assert.match(r.body, /Lock held by <code>claude-orch<\/code>/);
  assert.match(r.body, /pid 4242/);
  assert.match(r.body, /2026-05-26 09:15 PDT/);
});

test("renderTask: detail page on a stranded in-progress task shows unclaimed and no holder line", () => {
  const t = task("002-stranded", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/002-stranded", new URLSearchParams(), [p], { taskLocks: lockSnapshot({}) });
  assert.match(r.body, /class="lock-chip lock-chip-unclaimed"/);
  assert.doesNotMatch(r.body, /Lock held by/);
});

test("renderTask: terminal task with a stale lock in the snapshot still renders no chip", () => {
  const t = task("001-d", "done", { closed: "2026-04-01 12:00 PDT" });
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-d", new URLSearchParams(), [p], {
    taskLocks: lockSnapshot({ "alpha/001-d": {} }),
  });
  assert.doesNotMatch(r.body, /class="lock-chip/);
  assert.doesNotMatch(r.body, /Lock held by/);
});

// ---- routeMutation (POST dispatch) ----------------------------------------

test("routeMutation: /t/<slug>/ready dispatches `tpm ready <slug>` and 303-redirects", () => {
  const { runner, calls } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/ready", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.match(r.location ?? "", /^\/t\/alpha\/001-a\?flash=/);
  assert.deepEqual(calls, [["ready", "alpha/001-a"]]);
});

test("routeMutation: /t/<slug>/block requires reason, redirects with bad-request flash when missing", () => {
  const { runner, calls } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/block", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.location ?? ""), /bad request: missing required field for block/);
  assert.deepEqual(calls, []);
});

test("routeMutation: /t/<slug>/block passes the reason to the CLI", () => {
  const { runner, calls } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/block", new URLSearchParams("reason=waiting on API key"), runner);
  assert.equal(r.status, 303);
  assert.deepEqual(calls, [["block", "alpha/001-a", "waiting on API key"]]);
});

test("routeMutation: /t/<slug>/complete passes --outcome only when non-empty", () => {
  const { runner, calls } = captureRunner();
  routeMutation("/t/alpha/001-a/complete", new URLSearchParams("outcome=shipped"), runner);
  routeMutation("/t/alpha/001-a/complete", new URLSearchParams("outcome="), runner);
  assert.deepEqual(calls, [
    ["complete", "alpha/001-a", "--outcome", "shipped"],
    ["complete", "alpha/001-a"],
  ]);
});

test("routeMutation: /t/<slug>/log requires message", () => {
  const { runner, calls } = captureRunner();
  routeMutation("/t/alpha/001-a/log", new URLSearchParams("message=   "), runner);
  assert.equal(calls.length, 0);
});

test("routeMutation: /t/<slug>/pr forwards URL", () => {
  const { runner, calls } = captureRunner();
  routeMutation("/t/alpha/001-a/pr", new URLSearchParams("url=https://github.com/x/y/pull/1"), runner);
  assert.deepEqual(calls, [["pr", "alpha/001-a", "https://github.com/x/y/pull/1"]]);
});

test("routeMutation: /t/<slug>/status forwards new status", () => {
  const { runner, calls } = captureRunner();
  routeMutation("/t/alpha/001-a/status", new URLSearchParams("status=dropped"), runner);
  assert.deepEqual(calls, [["status", "alpha/001-a", "dropped"]]);
});

test("routeMutation: /t/<slug>/allow-orchestrator maps allow=true|false to allow/disallow", () => {
  const { runner, calls } = captureRunner();
  routeMutation("/t/alpha/001-a/allow-orchestrator", new URLSearchParams("allow=true"), runner);
  routeMutation("/t/alpha/001-a/allow-orchestrator", new URLSearchParams("allow=false"), runner);
  routeMutation("/t/alpha/001-a/allow-orchestrator", new URLSearchParams("allow=bogus"), runner);
  assert.deepEqual(calls, [
    ["allow", "alpha/001-a"],
    ["disallow", "alpha/001-a"],
    // bogus value -> no CLI call (bad request)
  ]);
});

test("routeMutation: child path /t/<project>/<parent>/<child>/<action> passes full slug", () => {
  const { runner, calls } = captureRunner();
  routeMutation("/t/alpha/002-parent/003-child/ready", new URLSearchParams(), runner);
  assert.deepEqual(calls, [["ready", "alpha/002-parent/003-child"]]);
});

test("routeMutation: unknown action returns 404", () => {
  const { runner } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/teleport", new URLSearchParams(), runner);
  assert.equal(r.status, 404);
});

test("routeMutation: non-/t path returns 404", () => {
  const { runner } = captureRunner();
  const r = routeMutation("/p/alpha/ready", new URLSearchParams(), runner);
  assert.equal(r.status, 404);
});

test("routeMutation: CLI failure surfaces stderr in flash", () => {
  const runner: CliRunner = () => ({ ok: false, stdout: "", stderr: "tpm: lock held by another agent" });
  const r = routeMutation("/t/alpha/001-a/ready", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.location ?? ""), /lock held by another agent/);
});

test("routeMutation: CLI success surfaces stdout in flash", () => {
  const runner: CliRunner = () => ({ ok: true, stdout: "alpha/001-a -> ready", stderr: "" });
  const r = routeMutation("/t/alpha/001-a/ready", new URLSearchParams(), runner);
  assert.match(decodeURIComponent(r.location ?? ""), /alpha\/001-a -> ready/);
});

// ---- inbox play button -----------------------------------------------------

test("routeMutation: honors form `redirect=/` so the inbox stays put after promote", () => {
  // Inbox play button posts to /t/<slug>/ready with redirect=/ so the user
  // stays on the dashboard instead of being thrown onto the task page. The
  // promoted row drops out of inbox on the next render.
  const { runner, calls } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/ready", new URLSearchParams("redirect=/"), runner);
  assert.equal(r.status, 303);
  assert.match(r.location ?? "", /^\/\?flash=/);
  assert.deepEqual(calls, [["ready", "alpha/001-a"]]);
});

test("routeMutation: rejects open-redirect attempts in `redirect` field", () => {
  // Defensive against a stray (or hostile) form field bouncing the browser
  // off the dashboard. Each case must fall back to the default task-page
  // redirect, not honor the supplied value.
  const { runner } = captureRunner();
  const cases = [
    "https://evil.example/",       // absolute external URL
    "//evil.example/",             // protocol-relative
    "javascript:alert(1)",          // pseudo-protocol
    "/../../etc/passwd",            // path traversal
    "/path with spaces",            // control-ish char
    "",                             // empty string falls through to default
  ];
  for (const value of cases) {
    const r = routeMutation("/t/alpha/001-a/ready", new URLSearchParams([["redirect", value]]), runner);
    assert.equal(r.status, 303, `case=${JSON.stringify(value)}`);
    assert.match(r.location ?? "", /^\/t\/alpha\/001-a\?flash=/, `case=${JSON.stringify(value)} should fall back to task page`);
  }
});

test("routeMutation: strips query/fragment from `redirect` so the flash param stays trustworthy", () => {
  // A redirect like "/?flash=fake" would let the form override the genuine
  // CLI-result flash. Strip anything past `?` or `#` before reassembling the
  // 303 target.
  const { runner } = captureRunner();
  const r = routeMutation(
    "/t/alpha/001-a/ready",
    new URLSearchParams("redirect=/?flash=spoofed"),
    runner,
  );
  assert.equal(r.status, 303);
  assert.match(r.location ?? "", /^\/\?flash=/);
  assert.doesNotMatch(r.location ?? "", /flash=spoofed/);
});

test("renderIndex: inbox open row renders the play form posting to /ready with redirect=/", () => {
  const p = project("alpha", [task("001-open", "open")]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.equal(r.status, 200);
  assert.match(
    r.body,
    /<form[^>]*method="POST"[^>]*action="\/t\/alpha\/001-open\/ready"[^>]*class="promote-form[^"]*"[\s\S]*?name="redirect"[^>]*value="\/"/,
  );
});

test("renderIndex: inbox blocked row renders the play form too", () => {
  const p = project("alpha", [task("001-b", "blocked")]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.match(
    r.body,
    /<form[^>]*action="\/t\/alpha\/001-b\/ready"[^>]*class="promote-form/,
  );
});

test("renderIndex: open row uses the muted fast-path style; blocked row uses the default", () => {
  // The visual hint distinguishes "skip discuss" (open) from "blocker
  // resolved" (blocked) so users picking the discuss flow on unclear tasks
  // still feel like that's the default for open rows.
  const p = project("alpha", [
    task("001-open", "open"),
    task("002-b", "blocked"),
  ]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.match(
    r.body,
    /<form[^>]*action="\/t\/alpha\/001-open\/ready"[^>]*class="promote-form promote-fast"/,
  );
  // blocked row keeps the plain class — no fast-path modifier.
  const blockedMatch = r.body.match(/<form[^>]*action="\/t\/alpha\/002-b\/ready"[^>]*class="([^"]+)"/);
  assert.ok(blockedMatch, "expected blocked row promote form");
  assert.doesNotMatch(blockedMatch![1], /promote-fast/);
});

test("renderIndex: needs-review row in inbox does NOT render a play button", () => {
  // The "Reopen for agent" affordance on the task page targets needs-feedback
  // (task 088). A one-click promote here would silently mis-route a review
  // bounce through `ready` and skip the feedback flow entirely.
  const p = project("alpha", [task("001-nr", "needs-review")]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.doesNotMatch(
    r.body,
    /<form[^>]*action="\/t\/alpha\/001-nr\/ready"[^>]*class="promote-form/,
  );
});

test("renderIndex: agent queue and in-flight rows do NOT render the play button", () => {
  // Only the inbox section opts in. Ready rows already are ready; needs-
  // feedback / in-progress rows have nothing useful to promote into.
  const p = project("alpha", [
    task("001-r", "ready"),
    task("002-nf", "needs-feedback"),
    task("003-ip", "in-progress"),
  ]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.doesNotMatch(r.body, /class="promote-form/);
});

test("renderProject: project page rows do NOT render the play button", () => {
  // The button is an inbox-only affordance — taskRow opts in via showPromote
  // from renderIndex only. A defensive check, since the per-status grouping
  // on the project page already separates open/blocked into their own
  // sections where a one-click promote could be useful in the future but
  // isn't in scope for task 110.
  const p = project("alpha", [task("001-open", "open"), task("002-b", "blocked")]);
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  assert.doesNotMatch(r.body, /class="promote-form/);
});

test("renderIndex: flash banner renders when opts.flash is present (e.g. after a play-button promote)", () => {
  const p = project("alpha", [task("001-r", "ready")]);
  const r = route("/", new URLSearchParams(), [p], { flash: "alpha/001-open -> ready" });
  assert.match(r.body, /<div class="flash"[^>]*>[\s\S]*alpha\/001-open -&gt; ready/);
  // Dismiss link points back to the dashboard root, not a task page.
  assert.match(r.body, /<a class="flash-dismiss" href="\/">/);
});

test("flash banner: auto-dismiss script + aria-live ship with the banner", () => {
  // After a mutation the page redirects with `?flash=`. The inline script
  // (1) strips `?flash=` via history.replaceState so the 30s auto-refresh
  // doesn't re-render stale confirmations, and (2) removes the banner after
  // ~3s. aria-live="polite" announces to screen readers before removal.
  const p = project("alpha", [task("001-r", "ready")]);
  const r = route("/", new URLSearchParams(), [p], { flash: "alpha/001-r -> in-progress" });
  assert.match(r.body, /class="flash"[^>]*aria-live="polite"/);
  assert.match(r.body, /history\.replaceState/);
  assert.match(r.body, /flash-fade/);
  assert.match(r.body, /setTimeout/);
});

test("flash banner: no banner, no script, when flash is absent", () => {
  const p = project("alpha", [task("001-r", "ready")]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.doesNotMatch(r.body, /class="flash"/);
  assert.doesNotMatch(r.body, /history\.replaceState/);
});

// ---- pull-from-queue button (task 117) ------------------------------------

test("routeMutation: /t/<slug>/pull dispatches `tpm pull <slug>`", () => {
  const { runner, calls } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/pull", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.deepEqual(calls, [["pull", "alpha/001-a"]]);
});

test("routeMutation: /t/<slug>/pull honors form `redirect=/` so the inbox stays put", () => {
  // Inline pull button (agent queue + project page) lets the operator pull a
  // row from the dashboard without bouncing to the task page.
  const { runner } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/pull", new URLSearchParams("redirect=/"), runner);
  assert.equal(r.status, 303);
  assert.match(r.location ?? "", /^\/\?flash=/);
});

test("renderTask: ready task surfaces a Pull-from-queue action (→ open)", () => {
  const t = task("001-r", "ready");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-r", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /action="\/t\/alpha\/001-r\/pull"/);
  assert.match(r.body, /Pull from queue \(→ open\)/);
});

test("renderTask: needs-feedback task surfaces a Pull-from-queue action (→ needs-review)", () => {
  const t = task("001-nf", "needs-feedback");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-nf", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /action="\/t\/alpha\/001-nf\/pull"/);
  assert.match(r.body, /Pull from queue \(→ needs-review\)/);
});

test("renderTask: non-pullable statuses don't surface a Pull-from-queue action", () => {
  // Other statuses: hide the button (Plan step 2). Open/blocked already are in
  // the human pile; in-progress / needs-close / needs-review have their own
  // exit paths (complete, log, request-changes).
  for (const status of ["open", "in-progress", "needs-close", "needs-review", "blocked"]) {
    const t = task("001-a", status);
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/pull"/, `expected no pull form for status=${status}`);
  }
});

test("renderIndex: agent-queue ready and needs-feedback rows render the inline pull button (redirect=/)", () => {
  const p = project("alpha", [
    task("001-r", "ready"),
    task("002-nf", "needs-feedback"),
  ]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.match(
    r.body,
    /<form[^>]*method="POST"[^>]*action="\/t\/alpha\/001-r\/pull"[^>]*class="pull-form"[\s\S]*?name="redirect"[^>]*value="\/"/,
  );
  assert.match(
    r.body,
    /<form[^>]*action="\/t\/alpha\/002-nf\/pull"[^>]*class="pull-form"/,
  );
});

test("renderIndex: in-flight rows (in-progress) do NOT render the pull button", () => {
  // pullButton is self-gating: only ready / needs-feedback. The in-flight
  // section doesn't even pass showPull, so this is a defense-in-depth check.
  const p = project("alpha", [task("003-ip", "in-progress")]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.doesNotMatch(r.body, /class="pull-form"/);
});

test("renderIndex: inbox rows (needs-review / blocked / open) do NOT render the pull button", () => {
  // Inbox status set never overlaps with the pullable set; the showPromote
  // call site doesn't pass showPull either. Defensive double-check.
  const p = project("alpha", [
    task("001-nr", "needs-review"),
    task("002-b", "blocked"),
    task("003-o", "open"),
  ]);
  const r = route("/", new URLSearchParams(), [p]);
  assert.doesNotMatch(r.body, /class="pull-form"/);
});

test("renderProject: project-page ready / needs-feedback rows render the inline pull button (redirect=/p/<slug>)", () => {
  const p = project("alpha", [
    task("001-r", "ready"),
    task("002-nf", "needs-feedback"),
  ]);
  const r = route("/p/alpha", new URLSearchParams(), [p]);
  assert.match(
    r.body,
    /<form[^>]*action="\/t\/alpha\/001-r\/pull"[^>]*class="pull-form"[\s\S]*?name="redirect"[^>]*value="\/p\/alpha"/,
  );
  assert.match(
    r.body,
    /<form[^>]*action="\/t\/alpha\/002-nf\/pull"[^>]*class="pull-form"/,
  );
});

test("renderProject: project-page rows in non-pullable statuses don't render the pull button", () => {
  const p = project("alpha", [
    task("001-o", "open"),
    task("002-ip", "in-progress"),
    task("003-d", "done", { closed: "2026-04-01 12:00 PDT" }),
  ]);
  const r = route("/p/alpha", new URLSearchParams("archived=1"), [p]);
  assert.doesNotMatch(r.body, /class="pull-form"/);
});

// ---- report flow (investigation deliverable) ------------------------------

test("renderTask: rail surfaces a Report panel when report.md exists in the task folder", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress", { hasReport: true, extra: { type: "investigation" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.match(r.body, /class="task-report"/);
    assert.match(r.body, /href="\/t\/alpha\/001-a\/report"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: no Report panel when report.md is absent", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress", { extra: { type: "investigation" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /class="task-report"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: needs-review task rail no longer renders LGTM/request-changes (moved to report page)", () => {
  // Task 083 moved the report-shaped review verbs to the report page itself
  // so the reviewer doesn't switch contexts to act. The rail keeps log/
  // block/reopen for both report-shaped and PR-shaped reviews.
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "needs-review", { hasReport: true, extra: { type: "investigation" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/lgtm"/);
    assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/request-changes"/);
    // The remaining escape-hatch forms still render.
    assert.match(r.body, /action="\/t\/alpha\/001-a\/log"/);
    assert.match(r.body, /action="\/t\/alpha\/001-a\/block"/);
    assert.match(r.body, /action="\/t\/alpha\/001-a\/status"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: needs-review PR-shaped task rail also lacks LGTM/request-changes", () => {
  const t = task("001-a", "needs-review", { type: "pr", prs: ["https://github.com/x/y/pull/1"] });
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/lgtm"/);
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/request-changes"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/log"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/block"/);
});

test("renderTask: needs-review 'Reopen for agent' flips to needs-feedback (not ready)", () => {
  // ready is the wrong target — execute-the-Plan mode doesn't know to read
  // review comments. needs-feedback routes through /tpm feedback, which is
  // built around addressing PR signals.
  const t = task("001-a", "needs-review", { type: "pr", prs: ["https://github.com/x/y/pull/1"] });
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(
    r.body,
    /<form[^>]*action="\/t\/alpha\/001-a\/status"[^>]*>\s*<input[^>]*name="status"[^>]*value="needs-feedback"/,
  );
  assert.doesNotMatch(r.body, /name="status"[^>]*value="ready"/);
});

test("renderTaskReport: needs-review with report attached renders sticky LGTM + Request-changes bar", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "needs-review", { hasReport: true, extra: { type: "investigation" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a/report", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.match(r.body, /class="report-actions-bar"/);
    assert.match(r.body, /action="\/t\/alpha\/001-a\/lgtm"/);
    assert.match(r.body, /action="\/t\/alpha\/001-a\/request-changes"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTaskReport: bar appears for report-attached non-investigation task at needs-review", () => {
  // Same OR gate the rail had previously: report presence is enough.
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "needs-review", { hasReport: true, extra: { type: "spike" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a/report", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.match(r.body, /class="report-actions-bar"/);
    assert.match(r.body, /action="\/t\/alpha\/001-a\/lgtm"/);
    assert.match(r.body, /action="\/t\/alpha\/001-a\/request-changes"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTaskReport: no bar when status is not needs-review", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress", { hasReport: true, extra: { type: "investigation" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a/report", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /class="report-actions-bar"/);
    assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/lgtm"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTaskReport: no bar when report.md is absent (no deliverable to review)", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "needs-review", { extra: { type: "investigation" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a/report", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /class="report-actions-bar"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTaskReport: no bar when mutations are disabled (non-loopback bind)", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "needs-review", { hasReport: true, extra: { type: "investigation" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a/report", new URLSearchParams(), [p], { mutationsEnabled: false });
    assert.doesNotMatch(r.body, /class="report-actions-bar"/);
  } finally {
    rmTempDir(root);
  }
});

test("route: /t/<slug>/report renders a placeholder when report.md is missing, not a 404", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress", { extra: { type: "investigation" } });
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a/report", new URLSearchParams(), [p]);
    assert.equal(r.status, 200);
    assert.match(r.body, /No report attached/);
  } finally {
    rmTempDir(root);
  }
});

test("routeMutation: /t/<slug>/lgtm dispatches `tpm lgtm <slug>`", () => {
  const { runner, calls } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/lgtm", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.deepEqual(calls, [["lgtm", "alpha/001-a"]]);
});

test("routeMutation: /t/<slug>/request-changes requires comment", () => {
  const { runner, calls } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/request-changes", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.location ?? ""), /bad request: missing required field for request-changes/);
  assert.deepEqual(calls, []);
});

test("routeMutation: /t/<slug>/request-changes forwards comment to CLI", () => {
  const { runner, calls } = captureRunner();
  routeMutation("/t/alpha/001-a/request-changes", new URLSearchParams("comment=needs more depth"), runner);
  assert.deepEqual(calls, [["request-changes", "alpha/001-a", "needs more depth"]]);
});

test("routeMutation: /t/<slug>/archive dispatches `tpm archive <slug>` and redirects to the same URL", () => {
  // The slug-based task URL stays resolvable after the move (serve loads
  // archived tasks too), so the post-archive redirect lands on the now-archived
  // task page rather than 404'ing (task 101).
  const { runner, calls } = captureRunner();
  const r = routeMutation("/t/alpha/001-a/archive", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.match(r.location ?? "", /^\/t\/alpha\/001-a\?flash=/);
  assert.deepEqual(calls, [["archive", "alpha/001-a"]]);
});

test("routeMutation: /t/<slug>/archive surfaces a server-side refusal in the flash", () => {
  // archiveTask refuses a parent with live children; that error must reach the
  // operator via the flash banner instead of being swallowed.
  const runner: CliRunner = () => ({ ok: false, stdout: "", stderr: "Cannot archive parent 002-parent: it has live children. Archive or close them first." });
  const r = routeMutation("/t/alpha/002-parent/archive", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.location ?? ""), /it has live children/);
});

// ---- new task form (project page) -----------------------------------------

test("renderProject: renders a New task <details> form with slug/title/parent/type fields", () => {
  const p = project("alpha", [
    task("001-foo", "open"),
    task("002-bar", "in-progress"),
  ]);
  const r = route("/p/alpha", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.equal(r.status, 200);
  assert.match(r.body, /class="new-task-form"/);
  assert.match(r.body, /<form[^>]*method="POST"[^>]*action="\/p\/alpha\/new-task"/);
  // Slug field is required and constrained to the same regex `validateSlug` uses.
  assert.match(r.body, /<input[^>]*name="slug"[^>]*required[^>]*pattern="\[a-z0-9\]\[a-z0-9-\]\*"/);
  // Optional title field.
  assert.match(r.body, /<input[^>]*name="title"/);
  // Parent dropdown lists top-level non-archived tasks and a top-level option.
  assert.match(r.body, /<select[^>]*name="parent">[\s\S]*<option[^>]*value="">\(top-level\)<\/option>[\s\S]*<option[^>]*value="001-foo"/);
  assert.match(r.body, /<option[^>]*value="002-bar"/);
  // Type dropdown has all four known types, with `pr` selected by default.
  for (const t of ["pr", "investigation", "spike", "chore"]) {
    assert.match(r.body, new RegExp(`<option[^>]*value="${t}"`));
  }
  assert.match(r.body, /<option[^>]*value="pr"[^>]*selected/);
});

test("renderProject: New task form omits child tasks from the parent dropdown", () => {
  // Children can't host grandchildren (newTask rejects nesting). The dropdown
  // should mirror that constraint so the operator doesn't pick a dead-end
  // option and then bounce off a CLI error.
  const child = task("002-child", "ready", { parent: "001-parent" });
  child.parent = "001-parent";
  const parent = task("001-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/p/alpha", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /<option[^>]*value="001-parent"/);
  assert.doesNotMatch(r.body, /<option[^>]*value="002-child"/);
});

test("renderProject: New task form is hidden when mutations are disabled (non-loopback)", () => {
  const p = project("alpha", [task("001-foo", "open")]);
  const r = route("/p/alpha", new URLSearchParams(), [p], { mutationsEnabled: false });
  assert.doesNotMatch(r.body, /class="new-task-form"/);
  assert.doesNotMatch(r.body, /action="\/p\/alpha\/new-task"/);
});

// ---- new-task mutation (project-scoped POST) ------------------------------

test("routeMutation: /p/<project>/new-task forwards slug to `tpm new task`", () => {
  const { runner, calls } = captureRunner();
  const r = routeMutation("/p/alpha/new-task", new URLSearchParams("slug=add-thing"), runner);
  assert.equal(r.status, 303);
  // Default redirect: the brand-new task's page.
  assert.match(r.location ?? "", /^\/t\/alpha\/add-thing\?flash=/);
  assert.deepEqual(calls, [["new", "task", "alpha", "add-thing"]]);
});

test("routeMutation: /p/<project>/new-task passes --title and --parent and --type when provided", () => {
  const { runner, calls } = captureRunner();
  const params = new URLSearchParams();
  params.set("slug", "child-thing");
  params.set("title", "Child thing");
  params.set("parent", "001-parent");
  params.set("type", "investigation");
  const r = routeMutation("/p/alpha/new-task", params, runner);
  assert.equal(r.status, 303);
  // Child redirect threads the parent slug into the URL path.
  assert.match(r.location ?? "", /^\/t\/alpha\/001-parent\/child-thing\?flash=/);
  assert.deepEqual(calls, [[
    "new", "task", "alpha", "child-thing",
    "--title", "Child thing",
    "--parent", "001-parent",
    "--type", "investigation",
  ]]);
});

test("routeMutation: /p/<project>/new-task skips empty optional fields", () => {
  // Empty form fields shouldn't materialize as empty `--title ""` etc. on the
  // command line. The CLI would accept them, but rendering would humanize an
  // empty slug to "" which is the silent-misroute the strip avoids.
  const { runner, calls } = captureRunner();
  const params = new URLSearchParams();
  params.set("slug", "do-thing");
  params.set("title", "  ");
  params.set("parent", "");
  params.set("type", "");
  routeMutation("/p/alpha/new-task", params, runner);
  assert.deepEqual(calls, [["new", "task", "alpha", "do-thing"]]);
});

test("routeMutation: /p/<project>/new-task with missing slug redirects to project page with flash", () => {
  const { runner, calls } = captureRunner();
  const r = routeMutation("/p/alpha/new-task", new URLSearchParams(), runner);
  assert.equal(r.status, 303);
  assert.match(r.location ?? "", /^\/p\/alpha\?flash=/);
  assert.match(decodeURIComponent(r.location ?? ""), /slug is required/);
  assert.deepEqual(calls, []);
});

test("routeMutation: /p/<project>/new-task CLI failure flashes back to project page", () => {
  // A slug collision / invalid slug / unknown parent surfaces via CLI stderr.
  // The 303 lands on the project page so the operator can immediately retry,
  // not on a non-existent task URL.
  const runner: CliRunner = () => ({ ok: false, stdout: "", stderr: "Invalid slug \"Bad-Slug\"." });
  const r = routeMutation("/p/alpha/new-task", new URLSearchParams("slug=Bad-Slug"), runner);
  assert.equal(r.status, 303);
  assert.match(r.location ?? "", /^\/p\/alpha\?flash=/);
  assert.match(decodeURIComponent(r.location ?? ""), /Invalid slug/);
});

test("routeMutation: /p/<project>/new-task surfaces CLI stdout in success flash", () => {
  const runner: CliRunner = () => ({ ok: true, stdout: "Created /tree/alpha/tasks/003-add-thing/task.md", stderr: "" });
  const r = routeMutation("/p/alpha/new-task", new URLSearchParams("slug=add-thing"), runner);
  assert.match(decodeURIComponent(r.location ?? ""), /Created \/tree\/alpha\/tasks\/003-add-thing\/task\.md/);
});

// ---- safety guards --------------------------------------------------------

test("isLoopback: accepts 127.0.0.1, localhost, ::1", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("localhost"), true);
  assert.equal(isLoopback("::1"), true);
});

test("isLoopback: rejects 0.0.0.0 and external addresses", () => {
  assert.equal(isLoopback("0.0.0.0"), false);
  assert.equal(isLoopback("10.0.0.5"), false);
  assert.equal(isLoopback("example.com"), false);
});

test("isSameOrigin: accepts matching Origin", () => {
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" }), true);
});

test("isSameOrigin: accepts matching Referer when Origin missing", () => {
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777", referer: "http://127.0.0.1:7777/t/alpha/001-a" }), true);
});

test("isSameOrigin: rejects when neither Origin nor Referer present", () => {
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777" }), false);
});

test("isSameOrigin: rejects mismatched host", () => {
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777", origin: "http://evil.example.com" }), false);
});

test("isSameOrigin: rejects malformed Origin", () => {
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777", origin: "not a url" }), false);
});

// ---- PR panel + chips -----------------------------------------------------

function prCacheOf(map: Record<string, { fetchedAt?: string; host?: string; pr: Record<string, unknown> }>): PrCacheReader {
  return (url) => {
    const e = map[url];
    if (!e) return null;
    return {
      fetchedAt: e.fetchedAt ?? new Date().toISOString(),
      host: e.host ?? "github",
      pr: e.pr as never,
    };
  };
}

const PR1 = "https://github.com/htalat/tpm/pull/1";
const PR2 = "https://github.com/htalat/tpm/pull/2";

test("renderTask: PR panel renders state / CI / review / mergeable badges + GitHub link from cache", () => {
  const t = task("050-pr", "needs-review", { prs: [PR1] });
  const p = project("alpha", [t]);
  const prCache = prCacheOf({
    [PR1]: { pr: {
      url: PR1, state: "OPEN", isDraft: false, title: "Add PR panel",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      mergeStateStatus: "CLEAN",
    } },
  });
  const r = route("/t/alpha/050-pr", new URLSearchParams(), [p], { mutationsEnabled: true, prCache });
  assert.match(r.body, /class="pr-panel"/);
  assert.match(r.body, /PR #1/);
  assert.match(r.body, /Add PR panel/);
  assert.match(r.body, /Open on GitHub/);
  // The four field labels + their resolved values.
  assert.match(r.body, /open/);
  assert.match(r.body, /passing/);
  assert.match(r.body, /approved/);
  assert.match(r.body, /clean/);
  // Freshness hint present.
  assert.match(r.body, /fetched/);
  // Panel sits before the Actions section.
  assert.ok(r.body.indexOf('class="pr-panel"') < r.body.indexOf('class="task-actions"'));
});

test("renderTask: failing CI / changes-requested / merge-conflict states map to the right labels", () => {
  const t = task("051-pr", "needs-feedback", { prs: [PR1] });
  const p = project("alpha", [t]);
  const prCache = prCacheOf({
    [PR1]: { pr: {
      url: PR1, state: "OPEN", isDraft: false,
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
      mergeStateStatus: "DIRTY",
    } },
  });
  const r = route("/t/alpha/051-pr", new URLSearchParams(), [p], { prCache });
  assert.match(r.body, /failing/);
  assert.match(r.body, /changes requested/);
  assert.match(r.body, /conflict/);
});

test("renderTask: PR panel shows a placeholder when the cache is missing", () => {
  const t = task("052-pr", "in-progress", { prs: [PR1] });
  const p = project("alpha", [t]);
  const r = route("/t/alpha/052-pr", new URLSearchParams(), [p], { mutationsEnabled: true, prCache: prCacheOf({}) });
  assert.match(r.body, /class="pr-panel"/);
  assert.match(r.body, /pr-card-empty/);
  assert.match(r.body, /no PR data cached yet/);
  // Still links out to GitHub.
  assert.match(r.body, new RegExp("Open on GitHub"));
  // No badge row when there's no data.
  assert.doesNotMatch(r.body, /class="pr-badges"/);
});

test("renderTask: PR panel treats a >1h-old cache entry as no-data (placeholder + last-polled hint)", () => {
  const t = task("053-pr", "in-progress", { prs: [PR1] });
  const p = project("alpha", [t]);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const prCache = prCacheOf({ [PR1]: { fetchedAt: twoHoursAgo, pr: { url: PR1, state: "OPEN", mergeStateStatus: "CLEAN" } } });
  const r = route("/t/alpha/053-pr", new URLSearchParams(), [p], { prCache });
  assert.match(r.body, /pr-card-empty/);
  assert.match(r.body, /last polled/);
  assert.match(r.body, /hours ago/);
  // Stale entry isn't rendered as if it were current.
  assert.doesNotMatch(r.body, /class="pr-badges"/);
});

test("renderTask: multiple linked PRs render one card each", () => {
  const t = task("054-pr", "needs-review", { prs: [PR1, PR2] });
  const p = project("alpha", [t]);
  const prCache = prCacheOf({
    [PR1]: { pr: { url: PR1, state: "MERGED" } },
    [PR2]: { pr: { url: PR2, state: "OPEN", mergeStateStatus: "BEHIND" } },
  });
  const r = route("/t/alpha/054-pr", new URLSearchParams(), [p], { prCache });
  assert.equal((r.body.match(/class="pr-card"/g) ?? []).length, 2);
  assert.match(r.body, /PR #1/);
  assert.match(r.body, /PR #2/);
  assert.match(r.body, /merged/);
  assert.match(r.body, /behind main/);
});

test("renderTask: no PR panel when the task has no linked PRs", () => {
  const t = task("055-nopr", "in-progress"); // prs: [] by default
  const p = project("alpha", [t]);
  const r = route("/t/alpha/055-nopr", new URLSearchParams(), [p], { mutationsEnabled: true, prCache: prCacheOf({}) });
  assert.doesNotMatch(r.body, /class="pr-panel"/);
});

test("taskRow: queue rows show a [PR #N <state>] chip linking to GitHub when cached", () => {
  const t = task("056-pr", "needs-review", { prs: [PR1] });
  const p = project("alpha", [t]);
  const prCache = prCacheOf({ [PR1]: { pr: { url: PR1, state: "OPEN" } } });
  const r = route("/", new URLSearchParams(), [p], { prCache });
  assert.match(r.body, /class="pr-chip[^"]*"[^>]*href="https:\/\/github\.com\/htalat\/tpm\/pull\/1"/);
  assert.match(r.body, /PR #1 open/);
});

test("taskRow: PR chip renders without a state label on a cache miss (still a link)", () => {
  const t = task("057-pr", "needs-review", { prs: [PR1] });
  const p = project("alpha", [t]);
  const r = route("/", new URLSearchParams(), [p], { prCache: prCacheOf({}) });
  assert.match(r.body, /class="pr-chip[^"]*"[^>]*href="https:\/\/github\.com\/htalat\/tpm\/pull\/1"/);
  // No trailing state word — just "PR #1".
  assert.match(r.body, />PR #1<\/a>/);
});

// ---- run panel + raw run-log route ----------------------------------------

import type { RunLogListReader, RunLogReader, RunLogRawReader } from "./serve.ts";

// Helper: stub the run-log reader with an in-memory NDJSON transcript.
function runLogOf(text: string, name = "20260515T120000Z.log"): RunLogReader {
  return () => ({ name, text });
}

function runLogListOf(...names: string[]): RunLogListReader {
  return () => names;
}

test("route: /t/<proj>/<slug>/runs renders 'Current run' on an in-progress task with parsed events", () => {
  // The inline run panel from task 057 moved out to `/runs` (task 075). The
  // parsed transcript layer is unchanged; only the URL it renders at moved.
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const text = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-7" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the file." }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "/x/y.ts" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "line one\nline two" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "PR opened.", duration_ms: 1500, total_cost_usd: 0.05 }),
  ].join("\n");
  const r = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p], {
    runLog: runLogOf(text),
    runLogList: runLogListOf("20260515T120000Z.log"),
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /class="run-panel"/);
  assert.match(r.body, /Current run/);
  // Events surface in human-readable form.
  assert.match(r.body, /Reading the file\./);
  assert.match(r.body, /→ Read/);
  assert.match(r.body, /\/x\/y\.ts/);
  assert.match(r.body, /line one line two/);
  assert.match(r.body, /result success/);
  assert.match(r.body, /PR opened\./);
  // Raw log link points at the per-task viewer (task 095 — runs are now
  // task-scoped, not a flat `/runs/<file>` URL).
  assert.match(r.body, /href="\/t\/alpha\/001-foo\/runs\/20260515T120000Z\.log"/);
});

test("route: /t/<proj>/<slug>/runs labels 'Last run' on a non-in-progress task", () => {
  const t = task("001-foo", "needs-review");
  const p = project("alpha", [t]);
  const text = JSON.stringify({ type: "system", subtype: "init" });
  const r = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p], {
    runLog: runLogOf(text),
    runLogList: runLogListOf("alpha-001--20260515T120000Z.log"),
  });
  assert.match(r.body, /Last run/);
  assert.doesNotMatch(r.body, /Current run/);
});

test("route: /t/<proj>/<slug>/runs auto-refreshes only when the task is in-progress", () => {
  const inProg = task("001-foo", "in-progress");
  const p1 = project("alpha", [inProg]);
  const r1 = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p1], {
    runLog: runLogOf(""), runLogList: runLogListOf(),
  });
  assert.match(r1.body, /http-equiv="refresh" content="10"/);
  const ready = task("002-bar", "ready");
  const p2 = project("alpha", [ready]);
  const r2 = route("/t/alpha/002-bar/runs", new URLSearchParams(), [p2], {
    runLog: runLogOf(""), runLogList: runLogListOf(),
  });
  assert.doesNotMatch(r2.body, /http-equiv="refresh"/);
});

test("renderTask: task detail page does NOT auto-refresh (rail is links-only; reload would lose scroll/flash)", () => {
  // Task 076 dropped the Recent log panel; without it the task detail page
  // is a static snapshot (markdown body + rail links). The page no longer
  // needs to poll — live updates live at /log and /runs, both of which
  // refresh on their own.
  for (const status of ["in-progress", "ready", "done"] as const) {
    const t = task("001-foo", status);
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-foo", new URLSearchParams(), [p]);
    assert.doesNotMatch(r.body, /http-equiv="refresh"/, `expected no refresh meta for status=${status}`);
  }
});

test("renderTask: task detail page no longer renders the inline 'Last/Current run' panel", () => {
  // Task 075 moved the run panel to /t/.../runs — the task body shouldn't
  // carry that section anymore (the rail-side "View runs →" link replaces it).
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-foo", new URLSearchParams(), [p]);
  assert.doesNotMatch(r.body, /class="run-panel"/);
  assert.doesNotMatch(r.body, /Last run/);
  assert.doesNotMatch(r.body, /Current run/);
  // The rail link to /runs survives.
  assert.match(r.body, /<section class="task-runs-link"><a href="\/t\/alpha\/001-foo\/runs">View runs →<\/a><\/section>/);
});

test("route: /t/<proj>/<slug>/runs shows a placeholder when no log on disk", () => {
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p], {
    runLog: () => null,
    runLogList: runLogListOf(),
  });
  assert.match(r.body, /class="run-panel run-panel-empty"/);
  assert.match(r.body, /Waiting for the agent/);
  // Still labelled 'Current run' so the user knows the run is meant to be live.
  assert.match(r.body, /Current run/);
  // The "All runs" section also renders an empty hint.
  assert.match(r.body, /No run logs on disk yet/);
});

test("route: /t/<proj>/<slug>/runs placeholder text for ready/done tasks is the 'never dispatched' variant", () => {
  const t = task("001-foo", "ready");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p], {
    runLog: () => null,
    runLogList: runLogListOf(),
  });
  assert.match(r.body, /class="run-panel run-panel-empty"/);
  assert.match(r.body, /No run log on disk/);
  // The wording explicitly references the orchestrator (the only writer).
  assert.match(r.body, /tpm orchestrate/);
});

test("route: /t/<proj>/<slug>/runs handles a malformed NDJSON line by degrading to raw (no crash)", () => {
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const text = [
    JSON.stringify({ type: "system", subtype: "init" }),
    "not valid json",
  ].join("\n");
  const r = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p], {
    runLog: runLogOf(text),
    runLogList: runLogListOf("alpha-001--20260515T120000Z.log"),
  });
  assert.equal(r.status, 200);
  // The raw line surfaces but is escaped.
  assert.match(r.body, /class="ev ev-raw/);
  assert.match(r.body, /not valid json/);
});

test("route: /t/<proj>/<slug>/runs truncates long transcripts (shows last 60 events)", () => {
  const lines: string[] = [];
  for (let i = 0; i < 80; i++) {
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `evt ${i}` }] } }));
  }
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p], {
    runLog: runLogOf(lines.join("\n")),
    runLogList: runLogListOf("alpha-001--20260515T120000Z.log"),
  });
  // Truncation note appears.
  assert.match(r.body, /Showing the last 60 of 80 events/);
  // The newest event (evt 79) is visible; the oldest (evt 0) is dropped.
  assert.match(r.body, /evt 79/);
  assert.doesNotMatch(r.body, />evt 0</);
});

test("route: /t/<proj>/<slug>/runs escapes user-controlled text in events (no HTML injection)", () => {
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const text = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "<script>alert(1)</script>" }] },
  });
  const r = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p], {
    runLog: runLogOf(text),
    runLogList: runLogListOf("alpha-001--20260515T120000Z.log"),
  });
  assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(r.body, /<script>alert\(1\)<\/script>/);
});

test("route: /t/<proj>/<slug>/runs lists every run for the task newest-first with a per-file link", () => {
  const t = task("001-foo", "needs-review");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-foo/runs", new URLSearchParams(), [p], {
    // No inline run panel — focus the test on the list itself.
    runLog: () => null,
    runLogList: runLogListOf(
      "20260601T080000Z.log",
      "20260515T120000Z.log",
      "20260101T000000Z.log",
    ),
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /All runs <span class="meta">\(3\)<\/span>/);
  // Each file is a link to the per-task raw viewer (task 095) with a
  // human-readable timestamp.
  assert.match(r.body, /href="\/t\/alpha\/001-foo\/runs\/20260601T080000Z\.log"/);
  assert.match(r.body, /href="\/t\/alpha\/001-foo\/runs\/20260515T120000Z\.log"/);
  assert.match(r.body, /href="\/t\/alpha\/001-foo\/runs\/20260101T000000Z\.log"/);
  assert.match(r.body, /2026-06-01 08:00 UTC/);
  // Newest first.
  const idxNew = r.body.indexOf("20260601T080000Z");
  const idxMid = r.body.indexOf("20260515T120000Z");
  const idxOld = r.body.indexOf("20260101T000000Z");
  assert.ok(idxNew < idxMid && idxMid < idxOld, "expected newest run first");
});

test("route: /t/<proj>/<slug>/runs resolves folder-form children", () => {
  const child = task("003-child", "in-progress", { parent: "002-parent" });
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/t/alpha/002-parent/003-child/runs", new URLSearchParams(), [p], {
    runLog: () => null,
    runLogList: runLogListOf(),
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /Runs — Task 003-child/);
});

test("route: /t/<unknown>/runs returns 404", () => {
  const r = route("/t/alpha/no-such/runs", new URLSearchParams(), [project("alpha", [])]);
  assert.equal(r.status, 404);
});

test("route: /t/<proj>/<slug>/runs/<basename> serves raw log contents as text/plain (task 095)", () => {
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const raw: RunLogRawReader = (_task, name) =>
    name === "20260515T120000Z.log" ? '{"type":"system","subtype":"init"}\n' : null;
  const r = route("/t/alpha/001-foo/runs/20260515T120000Z.log", new URLSearchParams(), [p], { runLogRaw: raw });
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/plain/);
  assert.match(r.body, /"subtype":"init"/);
});

test("route: /t/<proj>/<slug>/runs/<unknown> returns 404", () => {
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const raw: RunLogRawReader = () => null;
  const r = route("/t/alpha/001-foo/runs/20260101T000000Z.log", new URLSearchParams(), [p], { runLogRaw: raw });
  assert.equal(r.status, 404);
});

test("route: /t/<proj>/<slug>/runs/<bad-name> rejects names that don't match the task's pattern", () => {
  // The reader stub should never be called for an invalid name.
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  let calls = 0;
  const raw: RunLogRawReader = () => { calls++; return "leaked"; };
  // Slug-prefixed name (the pre-095 shape) is not the canonical on-disk name
  // for a top-level task post-095 — must be rejected.
  const r1 = route("/t/alpha/001-foo/runs/001-foo--20260101T000000Z.log", new URLSearchParams(), [p], { runLogRaw: raw });
  assert.equal(r1.status, 404);
  // Path-traversal attempt — the route regex matches a single segment, but
  // double-check with an encoded slash too.
  const r2 = route("/t/alpha/001-foo/runs/..%2Fetc%2Fpasswd", new URLSearchParams(), [p], { runLogRaw: raw });
  assert.equal(r2.status, 404);
  assert.equal(calls, 0);
});

test("route: /t/<proj>/<parent>/<child>/runs/<basename> accepts <child-slug>--<utc>.log (child shares parent's runs/)", () => {
  // Children write to <parent-dir>/runs/<child-slug>--<utc>.log; the raw
  // viewer URL carries that disambiguator in the filename.
  const child = task("003-child", "in-progress");
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  let captured: string | null = null;
  const raw: RunLogRawReader = (_task, name) => {
    captured = name;
    return name === "003-child--20260515T120000Z.log" ? "ok" : null;
  };
  const r = route("/t/alpha/002-parent/003-child/runs/003-child--20260515T120000Z.log", new URLSearchParams(), [p], { runLogRaw: raw });
  assert.equal(r.status, 200);
  assert.equal(captured, "003-child--20260515T120000Z.log");
  assert.equal(r.body, "ok");
});

test("route: /runs/<legacy-file> 302-redirects to the new per-task URL (task 095 back-compat)", () => {
  // Pre-095 bookmarks pointed at `/runs/<encoded-slug>--<utc>.log` in the
  // flat dir. After task 095 the file moved into the task's own folder; the
  // old URL redirects to the new viewer for one release window.
  const t = task("001-foo", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/runs/alpha-001-foo--20260515T120000Z.log", new URLSearchParams(), [p]);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/t/alpha/001-foo/runs/20260515T120000Z.log");
});

test("route: /runs/<legacy-file> for a child task redirects to the parent-scoped URL with <child-slug>--<utc>.log basename", () => {
  // Children's legacy filename: `<project>-<parent>-<child>--<utc>.log`. The
  // new layout shares the parent's runs/ with the slug prefix, so the new
  // basename keeps the `<child-slug>--<utc>.log` shape.
  const child = task("003-child", "in-progress");
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/runs/alpha-002-parent-003-child--20260515T120000Z.log", new URLSearchParams(), [p]);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/t/alpha/002-parent/003-child/runs/003-child--20260515T120000Z.log");
});

test("route: /runs/<legacy-file> for an unknown encoded slug returns 404", () => {
  const r = route("/runs/orphan-001--20260515T120000Z.log", new URLSearchParams(), [project("alpha", [])]);
  assert.equal(r.status, 404);
});

test("route: /runs/<bad-name> rejects traversal attempts before resolving", () => {
  // The legacy redirect helper should never be reached for an invalid name.
  const r = route("/runs/..%2Fetc%2Fpasswd", new URLSearchParams(), [project("alpha", [])]);
  assert.equal(r.status, 404);
});

// ---- /config page ---------------------------------------------------------

function snapshotOf(path: string, parsed: unknown): ConfigSnapshot {
  return { path, raw: JSON.stringify(parsed, null, 2), parsed, error: null, missing: false };
}

test("route: /config renders interpretive labels for harness config", () => {
  const cfg = snapshotOf("/h/.tpm/config.json", {
    root: "/Users/test/tpm",
    timezone: "America/Los_Angeles",
    time_bound_minutes: 45,
    notifications: { start: false, finish: true, fail: true },
  });
  const r = route("/config", new URLSearchParams(), [], {
    configSnapshot: () => cfg,
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /Harness config/);
  assert.match(r.body, /Tree root/);
  assert.match(r.body, /Timezone/);
  assert.match(r.body, /Time bound/);
  assert.match(r.body, /Notifications/);
  // Interpretive values surfaced.
  assert.match(r.body, /\/Users\/test\/tpm/);
  assert.match(r.body, /America\/Los_Angeles/);
  assert.match(r.body, /45 min/);
});

test("route: /config pretty-prints the JSON for the config file", () => {
  const cfg = snapshotOf("/h/.tpm/config.json", { root: "/tmp", timezone: "UTC" });
  const r = route("/config", new URLSearchParams(), [], {
    configSnapshot: () => cfg,
  });
  // Pretty-printed JSON wrapped in the config-json block (quotes are HTML-escaped).
  assert.match(r.body, /class="config-json"/);
  assert.match(r.body, /&quot;root&quot;: &quot;\/tmp&quot;/);
  assert.match(r.body, /&quot;timezone&quot;: &quot;UTC&quot;/);
});

test("route: /config shows the file path", () => {
  const cfg: ConfigSnapshot = { path: "/h/.tpm/config.json", raw: "{}", parsed: {}, error: null, missing: false };
  const r = route("/config", new URLSearchParams(), [], {
    configSnapshot: () => cfg,
  });
  assert.match(r.body, /\.tpm\/config\.json/);
});

test("route: /config renders an error block when the file is invalid JSON", () => {
  const cfg: ConfigSnapshot = {
    path: "/h/.tpm/config.json",
    raw: "not json",
    parsed: null,
    error: "Unexpected token o in JSON at position 1",
    missing: false,
  };
  const r = route("/config", new URLSearchParams(), [], {
    configSnapshot: () => cfg,
  });
  assert.match(r.body, /class="config-error"/);
  assert.match(r.body, /Failed to parse/);
  assert.match(r.body, /Unexpected token/);
  // Raw contents available in <details> for debugging.
  assert.match(r.body, /Raw contents/);
  assert.match(r.body, /not json/);
});

test("route: /config indicates a missing file with a placeholder + still shows defaults", () => {
  const missing: ConfigSnapshot = { path: "/h/.tpm/config.json", raw: "", parsed: null, error: null, missing: true };
  const r = route("/config", new URLSearchParams(), [], {
    configSnapshot: () => missing,
  });
  assert.match(r.body, /class="config-missing"/);
  assert.match(r.body, /No file at this path yet/);
  // Defaults surface in the interpretive dl even with no file present.
  assert.match(r.body, /America\/Los_Angeles/);
  assert.match(r.body, /\(default\)/);
});

test("route: /config escapes user-controlled JSON content (no HTML injection)", () => {
  const cfg = snapshotOf("/h/.tpm/config.json", { root: "<script>alert(1)</script>" });
  const r = route("/config", new URLSearchParams(), [], {
    configSnapshot: () => cfg,
  });
  assert.doesNotMatch(r.body, /<script>alert\(1\)<\/script>/);
  assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("route: every page renders a Config link in the top nav", () => {
  const t = task("001-a", "ready");
  const p = project("alpha", [t]);
  // Index.
  assert.match(route("/", new URLSearchParams(), [p]).body, /href="\/config"/);
  // Project page.
  assert.match(route("/p/alpha", new URLSearchParams(), [p]).body, /href="\/config"/);
  // Task page (top nav now appears here too).
  assert.match(route("/t/alpha/001-a", new URLSearchParams(), [p]).body, /href="\/config"/);
});

test("route: /config marks the config chip as active (no href)", () => {
  const cfg = snapshotOf("/h/.tpm/config.json", {});
  const r = route("/config", new URLSearchParams(), [], {
    configSnapshot: () => cfg,
  });
  // The active chip is a span, not a link.
  assert.match(r.body, /<span class="chip chip-config active">config<\/span>/);
});

// ---- /logs page -----------------------------------------------------------

import type { HarnessLogReader, HarnessLogSource } from "./serve.ts";
import { parseLine } from "./harness_log.ts";

function harnessSource(name: string, lines: string[]): HarnessLogSource {
  return {
    name,
    path: `/h/.tpm/${name}.log`,
    exists: true,
    lines: lines.map(parseLine),
    totalLines: lines.length,
  };
}

test("harness_log.parseLine: structured line splits into ts/level/script/message", () => {
  const ln = parseLine("2026-05-15T18:42:25-07:00  INFO   orchestrate      disposition tpm/061 shipped");
  assert.equal(ln.timestamp, "2026-05-15T18:42:25-07:00");
  assert.equal(ln.level, "INFO");
  assert.equal(ln.script, "orchestrate");
  assert.equal(ln.message, "disposition tpm/061 shipped");
});

test("harness_log.parseLine: non-structured line keeps raw text only (no level)", () => {
  const ln = parseLine("Some free-form claude output that landed in the log");
  assert.equal(ln.level, undefined);
  assert.equal(ln.timestamp, undefined);
  assert.equal(ln.raw, "Some free-form claude output that landed in the log");
});

test("harness_log.parseLine: WARN and ERROR levels parse", () => {
  assert.equal(parseLine("2026-05-15T18:42:25Z WARN check-pr-signal flaky api").level, "WARN");
  assert.equal(parseLine("2026-05-15T18:42:25Z ERROR orchestrate boom").level, "ERROR");
});

test("route: /logs landing page renders a summary card per category linking to the per-source pages", () => {
  const reader: HarnessLogReader = () => [
    harnessSource("orchestrator-laptop", [
      "2026-05-16T14:30:00-07:00  INFO   orchestrate      disposition tpm/061 shipped",
    ]),
    harnessSource("recurring-check-pr-signal", [
      "2026-05-16T14:27:01-07:00  INFO   check-pr-signal  summary checked=2 flipped=1",
    ]),
  ];
  const r = route("/logs", new URLSearchParams(), [], { harnessLog: reader });
  assert.equal(r.status, 200);
  // One card per category with a link to the per-source page.
  assert.match(r.body, /href="\/logs\/orchestrate">Orchestrator</);
  assert.match(r.body, /href="\/logs\/poller">Poller</);
  // The "Last entry" line surfaces the most recent timestamp + message per
  // category so the operator can glance and decide which stream to open.
  assert.match(r.body, /Last entry: <code>2026-05-16T14:30:00-07:00<\/code>.*disposition tpm\/061 shipped/);
  assert.match(r.body, /Last entry: <code>2026-05-16T14:27:01-07:00<\/code>.*summary checked=2 flipped=1/);
  // Per-task pointer hint surfaces the new `/t/<proj>/<slug>/log` shape so
  // operators don't keep using the old `?task=` query route.
  assert.match(r.body, /Per-task logs live at.*\/t\/&lt;proj&gt;\/&lt;slug&gt;\/log/);
  assert.doesNotMatch(r.body, /\/logs\?task=/);
  // Landing page is not a per-source panel layout — no log-panel sections.
  assert.doesNotMatch(r.body, /class="log-panel"/);
});

test("route: /logs landing page shows a placeholder card when a category has no sources", () => {
  // Only an orchestrator source — the poller card should still render with
  // an empty hint rather than disappearing.
  const reader: HarnessLogReader = () => [
    harnessSource("orchestrator-laptop", [
      "2026-05-16T14:30:00-07:00  INFO   orchestrate      ok",
    ]),
  ];
  const r = route("/logs", new URLSearchParams(), [], { harnessLog: reader });
  assert.match(r.body, /href="\/logs\/orchestrate">Orchestrator</);
  assert.match(r.body, /href="\/logs\/poller">Poller</);
  assert.match(r.body, /No log files discovered yet/);
});

test("route: /logs landing page aggregates total line count and most-recent entry across multiple files per category", () => {
  // Two orchestrator agents writing in parallel: landing surfaces the newer
  // entry and the summed line count so the operator sees the aggregate.
  const older = harnessSource("orchestrator-laptop", [
    "2026-05-16T10:00:00-07:00  INFO   orchestrate      old",
  ]);
  older.totalLines = 50;
  const newer = harnessSource("orchestrator-rpi", [
    "2026-05-16T14:30:00-07:00  INFO   orchestrate      newer",
  ]);
  newer.totalLines = 100;
  const reader: HarnessLogReader = () => [older, newer];
  const r = route("/logs", new URLSearchParams(), [], { harnessLog: reader });
  assert.match(r.body, /150 lines across 2 files/);
  assert.match(r.body, /Last entry: <code>2026-05-16T14:30:00-07:00<\/code>.*newer/);
});

test("route: /logs landing page only asks the reader for one line per source (cheap discovery pass)", () => {
  let receivedOpts: { lines: number; filter?: string } | null = null;
  const reader: HarnessLogReader = (opts) => {
    receivedOpts = opts;
    return [];
  };
  route("/logs", new URLSearchParams(), [], { harnessLog: reader });
  assert.ok(receivedOpts);
  assert.equal(receivedOpts!.lines, 1);
  // No substring filter on the landing page — that's only for the per-task
  // merged view (which lives on /t/<proj>/<slug>/log).
  assert.equal(receivedOpts!.filter, undefined);
});

test("route: /logs/orchestrate renders only orchestrator-prefixed sources", () => {
  const reader: HarnessLogReader = () => [
    harnessSource("orchestrator-laptop", [
      "2026-05-15T18:42:25-07:00  INFO   orchestrate      disposition tpm/061 shipped",
      "2026-05-15T19:00:00-07:00  WARN   orchestrate      time-bound exceeded",
    ]),
    harnessSource("recurring-check-pr-signal", [
      "2026-05-15T19:01:00Z  INFO   check-pr-signal  noise",
    ]),
  ];
  const r = route("/logs/orchestrate", new URLSearchParams(), [], { harnessLog: reader });
  assert.equal(r.status, 200);
  // Orchestrator panel renders.
  assert.match(r.body, /orchestrator-laptop/);
  // Structured columns render.
  assert.match(r.body, /2026-05-15T18:42:25-07:00/);
  assert.match(r.body, /<span class="log-level log-level-info">INFO<\/span>/);
  assert.match(r.body, /<span class="log-level log-level-warn">WARN<\/span>/);
  assert.match(r.body, /disposition tpm\/061 shipped/);
  // Recurring (poller) sources are excluded — this is the split's whole point.
  assert.doesNotMatch(r.body, /recurring-check-pr-signal/);
  assert.doesNotMatch(r.body, /check-pr-signal  noise/);
});

test("route: /logs/poller renders only recurring-prefixed sources", () => {
  const reader: HarnessLogReader = () => [
    harnessSource("orchestrator-laptop", [
      "2026-05-15T18:42:25-07:00  INFO   orchestrate      noise",
    ]),
    harnessSource("recurring-check-pr-signal", [
      "2026-05-15T19:01:00Z  INFO   check-pr-signal  summary checked=2 flipped=1",
      "2026-05-15T19:02:00Z  ERROR  check-pr-signal  gh fetch failed",
    ]),
  ];
  const r = route("/logs/poller", new URLSearchParams(), [], { harnessLog: reader });
  assert.equal(r.status, 200);
  assert.match(r.body, /recurring-check-pr-signal/);
  assert.match(r.body, /<span class="log-level log-level-info">INFO<\/span>/);
  assert.match(r.body, /<span class="log-level log-level-error">ERROR<\/span>/);
  assert.match(r.body, /summary checked=2 flipped=1/);
  assert.doesNotMatch(r.body, /orchestrator-laptop/);
  assert.doesNotMatch(r.body, /orchestrate      noise/);
});

test("route: /logs/orchestrate shows a category-scoped empty hint when no sources match", () => {
  // Only a recurring source — the orchestrate page filters it out and falls
  // back to the empty-state copy rather than rendering an empty panel grid.
  const reader: HarnessLogReader = () => [
    harnessSource("recurring-check-pr-signal", [
      "2026-05-15T19:01:00Z  INFO   check-pr-signal  ok",
    ]),
  ];
  const r = route("/logs/orchestrate", new URLSearchParams(), [], { harnessLog: reader });
  assert.match(r.body, /No orchestrator log files found/);
});

test("route: /logs/orchestrate ?lines=N clamps and forwards the tail size", () => {
  let receivedLines = -1;
  const reader: HarnessLogReader = (opts) => {
    receivedLines = opts.lines;
    return [harnessSource("orchestrator-laptop", [])];
  };
  route("/logs/orchestrate", new URLSearchParams("lines=42"), [], { harnessLog: reader });
  assert.equal(receivedLines, 42);
  route("/logs/orchestrate", new URLSearchParams("lines=99999"), [], { harnessLog: reader });
  assert.equal(receivedLines, 2000);
  route("/logs/orchestrate", new URLSearchParams("lines=garbage"), [], { harnessLog: reader });
  assert.equal(receivedLines, 200);
});

test("route: /logs/orchestrate ?lines=all bypasses the tail cap (sentinel 0 to the reader)", () => {
  // `all` is the chip-row sentinel for "no cap" — `tailFile` interprets a
  // non-positive `lines` as unlimited, so the reader receives 0.
  let receivedLines = -1;
  const reader: HarnessLogReader = (opts) => {
    receivedLines = opts.lines;
    return [harnessSource("orchestrator-laptop", [])];
  };
  route("/logs/orchestrate", new URLSearchParams("lines=all"), [], { harnessLog: reader });
  assert.equal(receivedLines, 0);
});

test("route: /logs/orchestrate renders a tail-chip row with the active chip reflecting ?lines=", () => {
  const reader: HarnessLogReader = () => [harnessSource("orchestrator-laptop", [
    "2026-05-15T18:42:25Z  INFO   orchestrate      ok",
  ])];
  // Default (no param) — 200 is active.
  const def = route("/logs/orchestrate", new URLSearchParams(), [], { harnessLog: reader });
  assert.match(def.body, /<span class="log-tail-chip active">200<\/span>/);
  assert.match(def.body, /<a class="log-tail-chip" href="\/logs\/orchestrate\?lines=1000">1000<\/a>/);
  assert.match(def.body, /<a class="log-tail-chip" href="\/logs\/orchestrate\?lines=all">all<\/a>/);
  // ?lines=1000 — 1000 active, 200 and all are links.
  const oneK = route("/logs/orchestrate", new URLSearchParams("lines=1000"), [], { harnessLog: reader });
  assert.match(oneK.body, /<span class="log-tail-chip active">1000<\/span>/);
  assert.match(oneK.body, /<a class="log-tail-chip" href="\/logs\/orchestrate\?lines=200">200<\/a>/);
  // ?lines=all — all active.
  const all = route("/logs/orchestrate", new URLSearchParams("lines=all"), [], { harnessLog: reader });
  assert.match(all.body, /<span class="log-tail-chip active">all<\/span>/);
});

test("route: /logs/orchestrate structured row uses a two-row block (meta row + full-width msg)", () => {
  // The redesigned row puts ts/level/script on a dim meta row and the message
  // on its own line so a long message can wrap without crowding the columns.
  const reader: HarnessLogReader = () => [harnessSource("orchestrator-laptop", [
    "2026-05-15T18:42:25Z  INFO   orchestrate      " + "x".repeat(400),
  ])];
  const r = route("/logs/orchestrate", new URLSearchParams(), [], { harnessLog: reader });
  // Meta row wraps timestamp + level chip + script together.
  assert.match(r.body, /<div class="log-meta-row">[\s\S]*?<span class="log-ts">2026-05-15T18:42:25Z<\/span>[\s\S]*?<span class="log-level log-level-info">INFO<\/span>[\s\S]*?<span class="log-script">orchestrate<\/span>[\s\S]*?<\/div>/);
  // Message hangs below the meta row as a block-display span, full-width.
  assert.match(r.body, /<span class="log-msg">x{400}<\/span>/);
});

test("route: /t/<proj>/<slug>/log carries the same tail chips with hrefs pointing back at the task log path", () => {
  const t = task("064-foo", "ready");
  t.body = "## Log\n- 2026-05-15 13:56 PDT: started\n";
  const p = project("tpm", [t]);
  const reader: HarnessLogReader = () => [];
  const r = route("/t/tpm/064-foo/log", new URLSearchParams("lines=1000"), [p], { harnessLog: reader });
  assert.match(r.body, /<span class="log-tail-chip active">1000<\/span>/);
  assert.match(r.body, /<a class="log-tail-chip" href="\/t\/tpm\/064-foo\/log\?lines=200">200<\/a>/);
  assert.match(r.body, /<a class="log-tail-chip" href="\/t\/tpm\/064-foo\/log\?lines=all">all<\/a>/);
});

test("route: /logs/orchestrate renders a placeholder when a log file is missing", () => {
  const reader: HarnessLogReader = () => [
    {
      name: "orchestrator-laptop",
      path: "/h/.tpm/orchestrator-laptop.log",
      exists: false,
      lines: [],
      totalLines: 0,
    },
  ];
  const r = route("/logs/orchestrate", new URLSearchParams(), [], { harnessLog: reader });
  assert.match(r.body, /No log file at/);
  assert.match(r.body, /orchestrator-laptop\.log/);
});

test("route: /logs/orchestrate surfaces non-structured lines verbatim (raw row)", () => {
  const reader: HarnessLogReader = () => [
    harnessSource("orchestrator-laptop", [
      "Some pre-task-042 free-form output",
      "2026-05-15T18:42:25Z  INFO   orchestrate      structured",
    ]),
  ];
  const r = route("/logs/orchestrate", new URLSearchParams(), [], { harnessLog: reader });
  assert.match(r.body, /class="log-line log-line-raw"/);
  assert.match(r.body, /Some pre-task-042 free-form output/);
});

test("route: /logs/orchestrate escapes log content (no HTML injection)", () => {
  const reader: HarnessLogReader = () => [
    harnessSource("orchestrator-laptop", [
      "2026-05-15T18:42:25Z  INFO   orchestrate      <script>alert(1)</script>",
    ]),
  ];
  const r = route("/logs/orchestrate", new URLSearchParams(), [], { harnessLog: reader });
  assert.doesNotMatch(r.body, /<script>alert\(1\)<\/script>/);
  assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("route: /logs/orchestrate reports truncation honestly when more lines exist than rendered", () => {
  const reader: HarnessLogReader = () => [{
    name: "orchestrator-laptop",
    path: "/h/.tpm/orchestrator-laptop.log",
    exists: true,
    lines: [parseLine("2026-05-15T18:42:25Z INFO orchestrate one")],
    totalLines: 200,
  }];
  const r = route("/logs/orchestrate", new URLSearchParams(), [], { harnessLog: reader });
  assert.match(r.body, /Showing the last 1 of 200 lines/);
});

test("route: /logs and the per-source pages all auto-refresh every 5s for live tailing", () => {
  const reader: HarnessLogReader = () => [];
  for (const path of ["/logs", "/logs/orchestrate", "/logs/poller"]) {
    const r = route(path, new URLSearchParams(), [], { harnessLog: reader });
    assert.match(r.body, /http-equiv="refresh" content="5"/, `expected ${path} to auto-refresh`);
  }
});

test("route: /logs?task=<slug> 302-redirects to /t/<proj>/<slug>/log", () => {
  // Per-task logs moved from a query-param branch of /logs to a sub-resource
  // of the task. Old bookmarks redirect for one release window before the
  // redirect itself is dropped.
  const t = task("064-foo", "ready");
  const p = project("tpm", [t]);
  const r = route("/logs", new URLSearchParams("task=tpm/064-foo"), [p]);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/t/tpm/064-foo/log");
});

test("route: /logs?task=<slug> redirect preserves ?lines=N", () => {
  const t = task("064-foo", "ready");
  const p = project("tpm", [t]);
  const r = route("/logs", new URLSearchParams("task=tpm/064-foo&lines=500"), [p]);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/t/tpm/064-foo/log?lines=500");
});

test("route: /logs?task=<slug> redirect qualifies child tasks with the parent segment", () => {
  const child = task("003-child", "ready", { parent: "002-parent" });
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/logs", new URLSearchParams("task=alpha/003-child"), [p]);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/t/alpha/002-parent/003-child/log");
});

test("route: /logs?task=<unresolved> redirects to /logs (drop the broken param)", () => {
  // External bookmark for a deleted/renamed task: drop the param so the user
  // lands on the landing page rather than a broken merged view.
  const r = route("/logs", new URLSearchParams("task=tpm/999-ghost"), []);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/logs");
});

test("route: every page renders a Logs link in the top nav", () => {
  const t = task("001-a", "ready");
  const p = project("alpha", [t]);
  assert.match(route("/", new URLSearchParams(), [p]).body, /href="\/logs"/);
  assert.match(route("/p/alpha", new URLSearchParams(), [p]).body, /href="\/logs"/);
  assert.match(route("/t/alpha/001-a", new URLSearchParams(), [p]).body, /href="\/logs"/);
});

test("route: /logs and per-source pages mark the logs chip as active (no href)", () => {
  const reader: HarnessLogReader = () => [];
  for (const path of ["/logs", "/logs/orchestrate", "/logs/poller"]) {
    const r = route(path, new URLSearchParams(), [], { harnessLog: reader });
    assert.match(r.body, /<span class="chip chip-logs active">logs<\/span>/, `expected ${path} to mark logs chip active`);
  }
});

test("route: /t/<proj>/<slug>/log merges task body Log entries with envelope lines chronologically", () => {
  // Per-task subpage (with a resolved slug + body Log entries) collapses to a
  // single chronological stream. Each entry surfaces with the right source:
  // `task-log` for body entries, INFO/WARN/ERROR + script for envelope.
  const body = [
    "## Context\nfoo\n",
    "## Plan\n- step 1\n",
    "## Log",
    "- 2026-05-15 13:56 PDT: started",
    "- 2026-05-15 13:58 PDT: opened PR https://github.com/x/y/pull/66",
    "- 2026-05-15 14:13 PDT: closed",
    "",
    "## Outcome\n",
  ].join("\n");
  const t = task("064-foo", "done");
  t.body = body;
  const p = project("tpm", [t]);
  const reader: HarnessLogReader = () => [
    harnessSource("orchestrator-laptop", [
      "2026-05-15T13:56:11-07:00  INFO   orchestrate      start tpm/064-foo as laptop time-bound=30m claude=claude",
      "2026-05-15T13:59:00-07:00  INFO   orchestrate      disposition tpm/064-foo shipped exit=0",
    ]),
    harnessSource("recurring-check-pr-signal", [
      "2026-05-15T14:13:00-07:00  INFO   check-pr-signal  flipped tpm/064-foo -> needs-close",
    ]),
  ];
  const r = route("/t/tpm/064-foo/log", new URLSearchParams(), [p], { harnessLog: reader });
  assert.equal(r.status, 200);
  // Page heading carries the task title for orientation.
  assert.match(r.body, /<h1>Log — Task 064-foo<\/h1>/);
  // Merged panel heading shows the scope.
  assert.match(r.body, /All events for/);
  // Each task-log entry renders with the task-log source class.
  assert.match(r.body, /class="log-script log-source-task-log"/);
  // Body messages present.
  assert.match(r.body, /started/);
  assert.match(r.body, /opened PR https:\/\/github\.com\/x\/y\/pull\/66/);
  assert.match(r.body, /closed/);
  // Envelope messages present.
  assert.match(r.body, /start tpm\/064-foo as laptop/);
  // `->` is HTML-escaped in the rendered body, so match the escaped form.
  assert.match(r.body, /flipped tpm\/064-foo -&gt; needs-close/);
  // Chronological order: started (13:56) < start envelope (13:56:11) <
  // opened PR (13:58) < disposition (13:59) < flipped (14:13) < closed (14:13).
  const ord = ["started", "start tpm\\/064-foo as laptop", "opened PR", "disposition tpm\\/064-foo shipped", "flipped tpm\\/064-foo", ">closed<"];
  let prev = -1;
  for (const needle of ord) {
    const idx = r.body.search(new RegExp(needle));
    assert.ok(idx > prev, `expected "${needle}" after the previous entry`);
    prev = idx;
  }
  // The per-source panel layout is suppressed in the merged view (one panel,
  // not three).
  assert.equal((r.body.match(/class="log-panel"/g) ?? []).length, 1);
  // Breadcrumb has a back-to-task link.
  assert.match(r.body, /<a href="\/t\/tpm\/064-foo">Back to task →<\/a>/);
});

test("route: /t/<proj>/<parent>/<child>/log resolves folder-form children", () => {
  // The 4-segment shape (`/t/proj/parent/child/log`) peels `log` off the end
  // and resolves the remaining segments as a folder-form child task.
  const child = task("003-child", "in-progress", { parent: "002-parent" });
  child.parent = "002-parent";
  child.body = "## Log\n- 2026-05-16 09:00 PDT: child started\n";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const reader: HarnessLogReader = (opts) => {
    // Filter should be the parent-qualified slug so envelope rows like
    // `disposition alpha/002-parent/003-child shipped` match.
    assert.equal(opts.filter, "alpha/002-parent/003-child");
    return [harnessSource("orchestrator-laptop", [
      "2026-05-16T09:05:00-07:00  INFO   orchestrate      start alpha/002-parent/003-child",
    ])];
  };
  const r = route("/t/alpha/002-parent/003-child/log", new URLSearchParams(), [p], { harnessLog: reader });
  assert.equal(r.status, 200);
  assert.match(r.body, /All events for/);
  assert.match(r.body, /child started/);
  assert.match(r.body, /start alpha\/002-parent\/003-child/);
});

test("route: /t/<unknown>/log returns 404", () => {
  const r = route("/t/alpha/no-such/log", new URLSearchParams(), [project("alpha", [])]);
  assert.equal(r.status, 404);
});

test("route: /t/<proj>/<slug>/log with resolved task but no body Log entries falls back to per-source panels (envelope-only)", () => {
  const t = task("055-foo", "ready");
  t.body = "## Context\nfoo\n\n## Plan\n- a\n\n## Log\n\n## Outcome\n";
  const p = project("tpm", [t]);
  const reader: HarnessLogReader = () => [
    harnessSource("orchestrator-laptop", [
      "2026-05-15T13:56:11-07:00  INFO   orchestrate      start tpm/055-foo",
    ]),
  ];
  const r = route("/t/tpm/055-foo/log", new URLSearchParams(), [p], { harnessLog: reader });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /All events for/);
  assert.match(r.body, /orchestrator-laptop/);
});

test("route: /t/<proj>/<slug>/log with no body Log and no envelope shows an empty hint", () => {
  // Both data streams empty: render an explicit "no log entries yet" message
  // rather than the generic per-source-panel placeholder, since this page is
  // specifically scoped to one task.
  const t = task("055-foo", "ready");
  t.body = "## Context\nfoo\n\n## Log\n\n## Outcome\n";
  const p = project("tpm", [t]);
  const reader: HarnessLogReader = () => [];
  const r = route("/t/tpm/055-foo/log", new URLSearchParams(), [p], { harnessLog: reader });
  assert.equal(r.status, 200);
  assert.match(r.body, /No log entries for this task yet/);
});

test("route: /t/<proj>/<slug>/log escapes task-log messages (no HTML injection)", () => {
  const t = task("064-foo", "ready");
  t.body = "## Log\n- 2026-05-15 13:56 PDT: <script>alert(1)</script>\n";
  const p = project("tpm", [t]);
  const reader: HarnessLogReader = () => [];
  const r = route("/t/tpm/064-foo/log", new URLSearchParams(), [p], { harnessLog: reader });
  assert.doesNotMatch(r.body, /<script>alert\(1\)<\/script>/);
  assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("route: /t/<proj>/<slug>/log resolves archived tasks (close-out audit trail still readable)", () => {
  // Per the task body's archived-tasks decision: the file is readable from
  // the archive path, so the subpage should still resolve.
  const t = task("064-old", "done", { closed: "2026-05-15 14:13 PDT" });
  t.archived = true;
  t.body = "## Log\n- 2026-05-15 14:13 PDT: closed\n";
  const p = project("tpm", [t]);
  const reader: HarnessLogReader = () => [];
  const r = route("/t/tpm/064-old/log", new URLSearchParams(), [p], { harnessLog: reader });
  assert.equal(r.status, 200);
  assert.match(r.body, /All events for/);
  assert.match(r.body, />closed</);
});

test("route: /t/<proj>/<slug>/log clamps ?lines=N like the per-source pages", () => {
  let received = -1;
  const reader: HarnessLogReader = (opts) => {
    received = opts.lines;
    return [];
  };
  const t = task("001-a", "ready");
  const p = project("alpha", [t]);
  route("/t/alpha/001-a/log", new URLSearchParams("lines=42"), [p], { harnessLog: reader });
  assert.equal(received, 42);
  route("/t/alpha/001-a/log", new URLSearchParams("lines=99999"), [p], { harnessLog: reader });
  assert.equal(received, 2000);
});

test("renderTask: rail surfaces 'View log →' link as a standalone section pointing at /t/<proj>/<slug>/log", () => {
  // Task 076: rail is links-only — no embedded Recent log panel, just a
  // plain `View log →` section pointing at the /log subroute.
  const t = task("001-a", "in-progress");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p]);
  assert.match(r.body, /<section class="task-log-link"><a href="\/t\/alpha\/001-a\/log">View log →<\/a><\/section>/);
  // No embedded Recent log panel.
  assert.doesNotMatch(r.body, /class="task-recent-log"/);
  // Old URL is gone (no `/logs?task=` link anywhere on the task page).
  assert.doesNotMatch(r.body, /\/logs\?task=/);
});

test("renderTask: child task rail link points to parent-qualified /log path", () => {
  const child = task("003-child", "in-progress", { parent: "002-parent" });
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("alpha", [parent]);
  const r = route("/t/alpha/002-parent/003-child", new URLSearchParams(), [p]);
  assert.match(r.body, /href="\/t\/alpha\/002-parent\/003-child\/log"/);
});

// ---- masthead home button + breadcrumb shape (task 105) -------------------

// Mirror of the persistent masthead in serve.ts: a `tpm` wordmark linking home,
// emitted by `layout()` so it rides every page. The tests lock the exact markup,
// so changing the home affordance is a deliberate edit here.
const SITE_HOME = '<header class="site-header"><a class="home" href="/">tpm</a></header>';
// Home now lives in the masthead, so breadcrumbs open on the project (or
// sub-resource) segment — no leading home crumb (task 105 dropped it).
const crumbs = (...inner: string[]) => `<nav class="crumbs">${inner.join("")}</nav>`;

test("layout: every page carries a masthead home link to /", () => {
  // The masthead is the single persistent home affordance — one insertion point
  // in layout(), so index, task, config, and logs pages all get it.
  const p = project("tpm", [task("001-a", "ready")]);
  const cfg = snapshotOf("/h/.tpm/config.json", { root: "/Users/test/tpm" });
  const index = route("/", new URLSearchParams(), [p]);
  const taskPage = route("/t/tpm/001-a", new URLSearchParams(), [p]);
  const config = route("/config", new URLSearchParams(), [p], {
    configSnapshot: () => cfg,
  });
  const logs = route("/logs", new URLSearchParams(), [p], { harnessLog: () => [] });
  for (const r of [index, taskPage, config, logs]) {
    assert.ok(r.body.includes(SITE_HOME), "expected masthead home link on every page");
  }
});

test("renderTask: breadcrumb walks project → task; home is no longer a crumb", () => {
  // Task 105: the project segment opens the breadcrumb (the home link moved to
  // the masthead). On a multi-project tree the project crumb still shows where
  // the task lives.
  const t = task("002-foo", "in-progress");
  const p = project("react-router-tutorial", [t]);
  const r = route("/t/react-router-tutorial/002-foo", new URLSearchParams(), [p]);
  assert.ok(r.body.includes(crumbs(
    '<a href="/p/react-router-tutorial">react-router-tutorial</a>',
    '<a href="/t/react-router-tutorial/002-foo">002-foo</a>',
  )), "expected project → task crumb");
  // No home crumb survives inside the breadcrumb nav.
  assert.doesNotMatch(r.body, /<nav class="crumbs"><a href="\/"/);
});

test("renderTask: single-project tpm tree renders one tpm crumb, not a doubled label", () => {
  // The originating bug for task 075: a home label `tpm` + project slug `tpm`
  // read as two identical links. With home in the masthead (task 105), the only
  // `tpm` text in the breadcrumb is the project segment.
  const t = task("075-foo", "in-progress");
  const p = project("tpm", [t]);
  const r = route("/t/tpm/075-foo", new URLSearchParams(), [p]);
  assert.ok(r.body.includes(crumbs(
    '<a href="/p/tpm">tpm</a>',
    '<a href="/t/tpm/075-foo">075-foo</a>',
  )));
  // No `tpm` text home link survives in the breadcrumb to double the project segment.
  assert.doesNotMatch(r.body, /<nav class="crumbs"><a href="\/">tpm<\/a>/);
});

test("renderTask: folder-form child breadcrumb walks project → parent → child", () => {
  const child = task("003-child", "in-progress", { parent: "002-parent" });
  child.parent = "002-parent";
  const parent = task("002-parent", "in-progress");
  parent.children = [child];
  const p = project("tpm", [parent]);
  const r = route("/t/tpm/002-parent/003-child", new URLSearchParams(), [p]);
  assert.ok(r.body.includes(crumbs(
    '<a href="/p/tpm">tpm</a>',
    '<a href="/t/tpm/002-parent">002-parent</a>',
    '<a href="/t/tpm/002-parent/003-child">003-child</a>',
  )));
});

test("renderTaskLog: /log breadcrumb walks project → task → log", () => {
  // Single source of truth — `breadcrumbFor(task, {suffix: 'log'})` builds the
  // crumb on /log the same way the task page does, plus a `log` suffix.
  const t = task("075-foo", "ready");
  t.body = "## Log\n- 2026-05-16 09:00 PDT: started\n";
  const p = project("tpm", [t]);
  const r = route("/t/tpm/075-foo/log", new URLSearchParams(), [p], { harnessLog: () => [] });
  assert.ok(r.body.includes(crumbs(
    '<a href="/p/tpm">tpm</a>',
    '<a href="/t/tpm/075-foo">075-foo</a>',
    '<a href="/t/tpm/075-foo/log">log</a>',
  )));
});

test("renderTaskRuns: /runs breadcrumb walks project → task → runs", () => {
  const t = task("075-foo", "ready");
  const p = project("tpm", [t]);
  const r = route("/t/tpm/075-foo/runs", new URLSearchParams(), [p], {
    runLog: () => null, runLogList: runLogListOf(),
  });
  assert.ok(r.body.includes(crumbs(
    '<a href="/p/tpm">tpm</a>',
    '<a href="/t/tpm/075-foo">075-foo</a>',
    '<a href="/t/tpm/075-foo/runs">runs</a>',
  )));
});

test("renderTaskReport: /report breadcrumb walks project → task → report", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "075-foo", "needs-review", { hasReport: true, extra: { type: "investigation" } });
    const p = project("tpm", [t]);
    const r = route("/t/tpm/075-foo/report", new URLSearchParams(), [p]);
    assert.ok(r.body.includes(crumbs(
      '<a href="/p/tpm">tpm</a>',
      '<a href="/t/tpm/075-foo">075-foo</a>',
      '<a href="/t/tpm/075-foo/report">report</a>',
    )));
  } finally {
    rmTempDir(root);
  }
});

test("renderProject: ad-hoc crumb opens on the project segment, no home crumb", () => {
  // The crumbs that bypass breadcrumbFor (project, artifacts, config, logs) also
  // dropped their leading home link (task 105) — home is in the masthead.
  const p = project("tpm", [task("001-a", "ready")]);
  const r = route("/p/tpm", new URLSearchParams(), [p]);
  assert.ok(r.body.includes('<nav class="crumbs"><a href="/p/tpm">tpm</a></nav>'));
  assert.doesNotMatch(r.body, /<nav class="crumbs"><a href="\/"/);
});

// ---- inline editor (task 121) ---------------------------------------------

test("renderTask: read view renders an `edit` link in each editable section header", () => {
  // Mutations enabled + non-archived task: Context / Plan / Outcome each carry
  // an inline edit affordance pointing back at the page with ?edit=<section>.
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress");
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.equal(r.status, 200);
    assert.match(r.body, /id="section-context"[\s\S]*?<a class="section-edit-link" href="\/t\/alpha\/001-a\?edit=context/);
    assert.match(r.body, /id="section-plan"[\s\S]*?<a class="section-edit-link" href="\/t\/alpha\/001-a\?edit=plan/);
    // Log is intentionally not editable — append-only via tpm log.
    assert.doesNotMatch(r.body, /href="\/t\/alpha\/001-a\?edit=log"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: title header carries an `edit` link beside the status badge", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress");
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.match(r.body, /<a class="title-edit-link" href="\/t\/alpha\/001-a\?edit=title">edit<\/a>/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: ?edit=context swaps the Context section to a textarea form with mtime stamp", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress");
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams("edit=context"), [p], { mutationsEnabled: true });
    assert.match(r.body, /<form[^>]*method="POST"[^>]*action="\/t\/alpha\/001-a\/edit"[^>]*class="action-form section-edit-form"/);
    assert.match(r.body, /name="section" value="Context"/);
    assert.match(r.body, /name="mtime" value="\d+(?:\.\d+)?"/);
    assert.match(r.body, /<textarea[^>]*name="value"[^>]*>/);
    // Cancel link returns to the task page (no edit param).
    assert.match(r.body, /<a class="action-cancel" href="\/t\/alpha\/001-a">Cancel<\/a>/);
    // Other editable sections stay in read view with edit links.
    assert.match(r.body, /<a class="section-edit-link" href="\/t\/alpha\/001-a\?edit=plan/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: ?edit=title swaps the header h1 to a text input form", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress");
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams("edit=title"), [p], { mutationsEnabled: true });
    assert.match(r.body, /<form[^>]*action="\/t\/alpha\/001-a\/edit"[^>]*class="action-form title-edit-form"/);
    assert.match(r.body, /name="section" value="title"/);
    assert.match(r.body, /<input[^>]*type="text"[^>]*name="value"[^>]*value="Task 001-a"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: ?edit=<unknown> falls back to read view (no form)", () => {
  // Defensive: the route validates `?edit` against the whitelist so a stray
  // query param can't sneak past into the rendered form's hidden section
  // field. Unknown values render the page as if no edit was requested.
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress");
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams("edit=log"), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /class="action-form section-edit-form"/);
    assert.doesNotMatch(r.body, /class="action-form title-edit-form"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: mutations disabled hides every inline edit affordance", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "in-progress");
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: false });
    assert.doesNotMatch(r.body, /class="section-edit-link"/);
    assert.doesNotMatch(r.body, /class="title-edit-link"/);
    // ?edit=context still falls back to read view when mutations are off —
    // can't open the editor without write access.
    const r2 = route("/t/alpha/001-a", new URLSearchParams("edit=context"), [p], { mutationsEnabled: false });
    assert.doesNotMatch(r2.body, /class="action-form section-edit-form"/);
  } finally {
    rmTempDir(root);
  }
});

test("renderTask: archived task hides edit affordances even with mutations enabled", () => {
  const root = mkTempDir();
  try {
    const t = folderTask(root, "001-a", "done");
    t.archived = true;
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /class="section-edit-link"/);
    assert.doesNotMatch(r.body, /class="title-edit-link"/);
  } finally {
    rmTempDir(root);
  }
});

test("routeMutation: /t/<slug>/edit forwards section + value + mtime to `tpm edit`", () => {
  const { runner, calls } = captureRunner();
  const params = new URLSearchParams();
  params.set("section", "Context");
  params.set("value", "New context body.\nSecond line.");
  params.set("mtime", "1700000000000");
  const r = routeMutation("/t/alpha/001-a/edit", params, runner);
  assert.equal(r.status, 303);
  assert.match(r.location ?? "", /^\/t\/alpha\/001-a\?flash=/);
  assert.deepEqual(calls, [
    ["edit", "alpha/001-a", "Context", "New context body.\nSecond line.", "--expect-mtime", "1700000000000"],
  ]);
});

test("routeMutation: /t/<slug>/edit omits --expect-mtime when mtime field is absent", () => {
  // `tpm edit` from the CLI doesn't require a mtime stamp; only the serve
  // form passes one. Missing or empty `mtime` should not produce an empty
  // --expect-mtime arg that would parse to NaN downstream.
  const { runner, calls } = captureRunner();
  const params = new URLSearchParams();
  params.set("section", "Plan");
  params.set("value", "New plan body.");
  routeMutation("/t/alpha/001-a/edit", params, runner);
  assert.deepEqual(calls, [
    ["edit", "alpha/001-a", "Plan", "New plan body."],
  ]);
});

test("routeMutation: /t/<slug>/edit requires section + value (bad-request flash)", () => {
  const { runner, calls } = captureRunner();
  const r1 = routeMutation("/t/alpha/001-a/edit", new URLSearchParams("section=Context"), runner);
  // Missing value -> bad request, no CLI call.
  assert.match(decodeURIComponent(r1.location ?? ""), /bad request: missing required field for edit/);
  const r2 = routeMutation("/t/alpha/001-a/edit", new URLSearchParams("value=foo"), runner);
  assert.match(decodeURIComponent(r2.location ?? ""), /bad request: missing required field for edit/);
  assert.equal(calls.length, 0);
});

test("routeMutation: /t/<slug>/edit allows empty value (clearing a section is valid)", () => {
  // Outcome legitimately starts empty; the editor must allow clearing a
  // section back to empty. Only `section` is strictly required.
  const { runner, calls } = captureRunner();
  const params = new URLSearchParams();
  params.set("section", "Outcome");
  params.set("value", "");
  routeMutation("/t/alpha/001-a/edit", params, runner);
  assert.deepEqual(calls, [
    ["edit", "alpha/001-a", "Outcome", ""],
  ]);
});

test("routeMutation: /t/<slug>/edit surfaces a CLI conflict in the flash", () => {
  // mutate.editTaskSection throws on mtime mismatch; the CLI exits non-zero
  // and the message lands in stderr. Serve's flashRedirect should surface
  // it so the operator knows to reload.
  const runner: CliRunner = () => ({
    ok: false,
    stdout: "",
    stderr: "alpha/001-a: file changed since the editor was loaded (concurrent edit). Reload and try again.",
  });
  const r = routeMutation("/t/alpha/001-a/edit", new URLSearchParams("section=Context&value=x&mtime=1"), runner);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.location ?? ""), /file changed since the editor was loaded/);
});

