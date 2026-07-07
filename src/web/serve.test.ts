import { test } from "node:test";
import assert from "node:assert/strict";
import { route, isSameOrigin, isLoopback } from "./serve.ts";
import type { Project, Task } from "../core/tree.ts";

// serve.ts is the SPA's data plane: run-log endpoints, /api/harness, and the
// permanent redirects from the deleted server-rendered pages. The JSON API
// proper is covered in api.test.ts; verb semantics in commands/mutate tests.

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

// ---- /api/harness -------------------------------------------------------------

test("route: /api/harness reports running:false without a harness, snapshot with one", () => {
  const off = route("/api/harness", new URLSearchParams(), []);
  assert.equal(off.status, 200);
  assert.deepEqual(JSON.parse(off.body), { running: false });

  const snap = { startedAt: "2026-07-07T00:00:00Z", pollIntervalSec: 60, desiredWorkers: 2, stopping: false, lastPoll: null, poolDied: null };
  const on = route("/api/harness", new URLSearchParams(), [], { harness: snap });
  assert.deepEqual(JSON.parse(on.body), { running: true, ...snap });
});

// ---- JSON runs feed (/api/tasks/<path>/runs) ------------------------------------

test("route: /api/tasks/<path>/runs returns run list + rendered latest tail", () => {
  const t = task("001-a", "in-progress");
  const p = project("alpha", [t]);
  const log = '{"type":"system","subtype":"init","session_id":"sess-9"}\n'
    + '{"type":"assistant","message":{"content":[{"type":"text","text":"hi there"}]}}\n';
  const r = route("/api/tasks/alpha%2F001-a/runs", new URLSearchParams(), [p], {
    runLog: () => ({ name: "20260707T000000Z.log", text: log }),
    runLogList: () => ["20260707T000000Z.log", "20260701T000000Z.log"],
  });
  assert.equal(r.status, 200);
  assert.match(r.contentType, /application\/json/);
  const body = JSON.parse(r.body);
  assert.equal(body.runs.length, 2);
  assert.equal(body.runs[0].name, "20260707T000000Z.log");
  assert.match(body.runs[0].timestamp, /2026-07-07/);
  assert.equal(body.latest.running, true);
  assert.equal(body.latest.sessionId, "sess-9");
  assert.match(body.latest.html, /hi there/);
  assert.equal(body.latest.offset, Buffer.byteLength(log));
  assert.match(body.latest.tailPath, /^\/t\/alpha\/001-a\/runs\/20260707T000000Z\.log\/tail$/);
});

test("route: /api/tasks/<path>/runs — no logs yet and unknown task", () => {
  const p = project("alpha", [task("001-a", "ready")]);
  const none = route("/api/tasks/alpha/001-a/runs", new URLSearchParams(), [p], {
    runLog: () => null,
    runLogList: () => [],
  });
  assert.equal(JSON.parse(none.body).latest, null);

  const missing = route("/api/tasks/alpha/nope/runs", new URLSearchParams(), [p], {});
  assert.equal(missing.status, 404);
});

// ---- live transcript tail -------------------------------------------------------

test("route: runs tail returns rendered event fragments + advanced offset + running flag", () => {
  const t = task("001-a", "in-progress");
  const p = project("alpha", [t]);
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}',
  ];
  const r = route("/t/alpha/001-a/runs/20260611T000000Z.log/tail", new URLSearchParams("offset=10&format=claude-stream-json"), [p], {
    runLogTail: (_task, name, offset) => {
      assert.equal(name, "20260611T000000Z.log");
      assert.equal(offset, 10);
      return { lines, offset: 99 };
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.contentType, "application/json");
  const j = JSON.parse(r.body);
  assert.match(j.html, /working on it/);
  assert.match(j.html, /class="ev ev-text"/);
  assert.equal(j.offset, 99);
  assert.equal(j.running, true);
});

test("route: runs tail — garbage offset skips to EOF (-1); missing log 404s; finished task reports running:false", () => {
  const t = task("001-a", "done");
  const p = project("alpha", [t]);
  let seenOffset: number | null = null;
  const r = route("/t/alpha/001-a/runs/x.log/tail", new URLSearchParams("offset=banana"), [p], {
    runLogTail: (_task, _name, offset) => {
      seenOffset = offset;
      return { lines: [], offset: 500 };
    },
  });
  assert.equal(seenOffset, -1);
  assert.equal(JSON.parse(r.body).running, false);
  const missing = route("/t/alpha/001-a/runs/x.log/tail", new URLSearchParams(), [p], {
    runLogTail: () => null,
  });
  assert.equal(missing.status, 404);
});

// ---- raw run-log viewer ---------------------------------------------------------

test("route: raw run log serves text/plain; bad names and missing files 404", () => {
  const t = task("001-a", "done");
  const p = project("alpha", [t]);
  const r = route("/t/alpha/001-a/runs/20260611T000000Z.log", new URLSearchParams(), [p], {
    runLogRaw: (_task, name) => (name === "20260611T000000Z.log" ? "raw bytes here" : null),
  });
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/plain/);
  assert.equal(r.body, "raw bytes here");

  // Traversal-shaped name is rejected by isValidRunLogName before the reader.
  const bad = route("/t/alpha/001-a/runs/..%2F..%2Ftask.md", new URLSearchParams(), [p], {
    runLogRaw: () => "should never be read",
  });
  assert.equal(bad.status, 404);

  const missing = route("/t/alpha/001-a/runs/20260611T000001Z.log", new URLSearchParams(), [p], {
    runLogRaw: () => null,
  });
  assert.equal(missing.status, 404);
});

// ---- redirects from the deleted server-rendered pages ----------------------------

function redirectOf(pathname: string, params: string, projects: Project[]): { status: number; location?: string } {
  const r = route(pathname, new URLSearchParams(params), projects);
  return { status: r.status, location: r.location };
}

test("route: page paths redirect to their SPA equivalents, query preserved", () => {
  const p = project("alpha", [task("001-a", "ready")]);
  assert.deepEqual(redirectOf("/search", "q=widget&archived=1", [p]), { status: 302, location: "/app/search?q=widget&archived=1" });
  assert.deepEqual(redirectOf("/config", "", [p]), { status: 302, location: "/app/config" });
  assert.deepEqual(redirectOf("/logs", "", [p]), { status: 302, location: "/app/logs" });
  assert.deepEqual(redirectOf("/logs/orchestrate", "", [p]), { status: 302, location: "/app/logs" });
  assert.deepEqual(redirectOf("/p/alpha", "archived=1", [p]), { status: 302, location: "/app/p/alpha?archived=1" });
  assert.deepEqual(redirectOf("/p/alpha/artifacts", "", [p]), { status: 302, location: "/app/p/alpha" });
  assert.deepEqual(redirectOf("/t/alpha/001-a", "", [p]), { status: 302, location: "/app/t/alpha/001-a" });
  assert.deepEqual(redirectOf("/t/alpha/001-a/runs", "", [p]), { status: 302, location: "/app/t/alpha/001-a/runs" });
  assert.deepEqual(redirectOf("/t/alpha/001-a/log", "", [p]), { status: 302, location: "/app/t/alpha/001-a" });
});

test("route: numeric permalinks resolve through findTasksByNumericId", () => {
  const p = project("alpha", [task("001-a", "ready"), task("002-b", "ready")]);
  // Unique id -> the task's SPA page, zero-padded or not.
  assert.equal(redirectOf("/t/alpha/1", "", [p]).location, "/app/t/alpha/001-a");
  assert.equal(redirectOf("/t/alpha/001", "", [p]).location, "/app/t/alpha/001-a");
  assert.equal(redirectOf("/p/alpha/2", "", [p]).location, "/app/t/alpha/002-b");
  // No match -> the project page is the place to disambiguate.
  assert.equal(redirectOf("/t/alpha/9", "", [p]).location, "/app/p/alpha");
});

test("route: unknown path 404s", () => {
  const r = route("/definitely/not/a/thing", new URLSearchParams(), []);
  assert.equal(r.status, 404);
});

// ---- request guards ---------------------------------------------------------------

test("isLoopback accepts loopback hosts only", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("localhost"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("0.0.0.0"), false);
  assert.equal(isLoopback("192.168.1.10"), false);
});

test("isSameOrigin matches Origin/Referer host against the Host header", () => {
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" }), true);
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777", referer: "http://127.0.0.1:7777/app" }), true);
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777", origin: "http://evil.example" }), false);
  assert.equal(isSameOrigin({ host: "127.0.0.1:7777" }), false);
  assert.equal(isSameOrigin({ origin: "http://127.0.0.1:7777" }), false);
});
