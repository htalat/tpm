import { test } from "node:test";
import assert from "node:assert/strict";
import { route, routeMutation, isSameOrigin, isLoopback } from "./serve.ts";
import type { CliRunner, PrCacheReader } from "./serve.ts";
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

test("renderTask: open task offers Promote + Block + Drop, not Complete", () => {
  const t = task("001-a", "open");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.match(r.body, /action="\/t\/alpha\/001-a\/ready"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/block"/);
  assert.match(r.body, /action="\/t\/alpha\/001-a\/status"/);
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/complete"/);
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-a\/pr"/);
});

test("renderTask: done/dropped tasks render no action or settings forms", () => {
  for (const status of ["done", "dropped"]) {
    const t = task(`001-${status}`, status);
    const p = project("alpha", [t]);
    const r = route(`/t/alpha/001-${status}`, new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.doesNotMatch(r.body, /class="task-actions"/, `expected no action forms for status=${status}`);
    assert.doesNotMatch(r.body, /class="task-settings"/, `expected no settings forms for status=${status}`);
    assert.doesNotMatch(r.body, /action="\/t\/alpha\/001-[^/]+\/allow-orchestrator"/, `expected no allow toggle for status=${status}`);
  }
});

test("renderTask: allow_orchestrator toggle renders for every non-terminal status", () => {
  // Settings live outside the action-verb switch — every non-terminal,
  // non-parent, non-archived task should expose the toggle.
  for (const status of ["open", "ready", "in-progress", "needs-feedback", "needs-close", "needs-review", "blocked"]) {
    const t = task("001-a", status);
    const p = project("alpha", [t]);
    const r = route("/t/alpha/001-a", new URLSearchParams(), [p], { mutationsEnabled: true });
    assert.match(r.body, /class="task-settings"/, `expected settings section for status=${status}`);
    assert.match(r.body, /action="\/t\/alpha\/001-a\/allow-orchestrator"/, `expected allow toggle for status=${status}`);
  }
});

test("renderTask: archived task renders no settings forms", () => {
  const t = task("099-old", "done");
  t.archived = true;
  const p = project("alpha", [t]);
  const r = route("/t/alpha/099-old", new URLSearchParams(), [p], { mutationsEnabled: true });
  assert.doesNotMatch(r.body, /class="task-settings"/);
  assert.doesNotMatch(r.body, /action="\/t\/alpha\/099-old\/allow-orchestrator"/);
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

function prCacheOf(map: Record<string, { fetchedAt?: string; pr: Record<string, unknown> }>): PrCacheReader {
  return (url) => {
    const e = map[url];
    if (!e) return null;
    return { fetchedAt: e.fetchedAt ?? new Date().toISOString(), pr: e.pr as never };
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
