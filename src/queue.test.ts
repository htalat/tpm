import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project, Task } from "./tree.ts";
import { selectNext, selectCandidates, inboxItems } from "./queue.ts";

function task(slug: string, status: string, created: string, extra: Record<string, unknown> = {}): Task {
  return {
    slug,
    path: `/tmp/${slug}.md`,
    archived: false,
    data: { slug, status, created, ...extra },
    body: "",
  };
}

function project(slug: string, tasks: Task[]): Project {
  return {
    slug,
    path: `/tmp/${slug}/project.md`,
    dir: `/tmp/${slug}`,
    data: { slug, status: "active" },
    body: "",
    tasks,
  };
}

test("selectNext: returns null when no eligible tasks", () => {
  const p = project("a", [
    task("001", "open",     "2026-01-01 10:00 PDT"),
    task("002", "blocked",  "2026-01-02 10:00 PDT"),
  ]);
  assert.equal(selectNext([p]), null);
});

test("selectNext: returns ready when only ready exists", () => {
  const p = project("a", [task("001-r", "ready", "2026-01-01 10:00 PDT")]);
  const pick = selectNext([p]);
  assert.equal(pick?.task.slug, "001-r");
});

test("selectNext: needs-feedback wins over ready (priority)", () => {
  const p = project("a", [
    task("001-old-ready",   "ready",          "2026-01-01 10:00 PDT"),
    task("002-new-feedback", "needs-feedback", "2026-05-01 10:00 PDT"),
  ]);
  const pick = selectNext([p]);
  assert.equal(pick?.task.slug, "002-new-feedback");
});

test("selectNext: within needs-feedback bucket, oldest first", () => {
  const p = project("a", [
    task("001-newer", "needs-feedback", "2026-05-09 10:00 PDT"),
    task("002-older", "needs-feedback", "2026-05-01 10:00 PDT"),
  ]);
  const pick = selectNext([p]);
  assert.equal(pick?.task.slug, "002-older");
});

test("selectNext: within ready bucket, oldest first (when no needs-feedback)", () => {
  const p = project("a", [
    task("001-newer", "ready", "2026-05-09 10:00 PDT"),
    task("002-older", "ready", "2026-05-01 10:00 PDT"),
  ]);
  const pick = selectNext([p]);
  assert.equal(pick?.task.slug, "002-older");
});

test("selectNext: skips in-progress, blocked, done, dropped, open", () => {
  const p = project("a", [
    task("001-ip",      "in-progress",  "2026-01-01 10:00 PDT"),
    task("002-blocked", "blocked",      "2026-01-02 10:00 PDT"),
    task("003-done",    "done",         "2026-01-03 10:00 PDT"),
    task("004-drop",    "dropped",      "2026-01-04 10:00 PDT"),
    task("005-open",    "open",         "2026-01-05 10:00 PDT"),
    task("006-ready",   "ready",        "2026-01-06 10:00 PDT"),
  ]);
  const pick = selectNext([p]);
  assert.equal(pick?.task.slug, "006-ready");
});

test("selectNext: respects --autonomous (allow_orchestrator: true gate)", () => {
  const p = project("a", [
    task("001-no-flag",  "ready", "2026-01-01 10:00 PDT"),
    task("002-with-flag","ready", "2026-01-02 10:00 PDT", { allow_orchestrator: true }),
  ]);
  const pick = selectNext([p], { autonomous: true });
  assert.equal(pick?.task.slug, "002-with-flag");
});

test("selectNext: --autonomous returns null when no flagged tasks", () => {
  const p = project("a", [task("001", "ready", "2026-01-01 10:00 PDT")]);
  assert.equal(selectNext([p], { autonomous: true }), null);
});

test("selectNext: respects projectFilter", () => {
  const a = project("a", [task("001", "ready", "2026-01-01 10:00 PDT")]);
  const b = project("b", [task("002", "ready", "2026-01-02 10:00 PDT")]);
  const pick = selectNext([a, b], { projectFilter: "b" });
  assert.equal(pick?.project.slug, "b");
  assert.equal(pick?.task.slug, "002");
});

test("selectNext: skips parents (containers) and archived", () => {
  const archived = task("001-old", "ready", "2026-01-01 10:00 PDT");
  archived.archived = true;
  const parent = task("002-parent", "ready", "2026-01-02 10:00 PDT");
  parent.children = [task("003-child", "ready", "2026-01-03 10:00 PDT")];
  const p = project("a", [archived, parent]);
  const pick = selectNext([p]);
  // parent is skipped (container), archived is skipped, only the child remains
  assert.equal(pick?.task.slug, "003-child");
});

test("selectCandidates: returns full sorted list (used by tpm next --claim fall-through)", () => {
  const p = project("a", [
    task("001-newer-ready",   "ready",          "2026-05-01 10:00 PDT"),
    task("002-older-ready",   "ready",          "2026-04-01 10:00 PDT"),
    task("003-feedback",      "needs-feedback", "2026-05-09 10:00 PDT"),
    task("004-skipped",       "in-progress",    "2026-05-09 10:00 PDT"),
  ]);
  const list = selectCandidates([p]);
  assert.deepEqual(list.map(c => c.task.slug), [
    "003-feedback",        // needs-feedback bucket first
    "002-older-ready",     // then ready, oldest first
    "001-newer-ready",
  ]);
});

test("selectCandidates: empty when no eligible tasks", () => {
  const p = project("a", [task("001", "in-progress", "2026-01-01 10:00 PDT")]);
  assert.deepEqual(selectCandidates([p]), []);
});

test("inboxItems: empty when nothing in human queue", () => {
  const p = project("a", [
    task("001", "ready", "2026-01-01 10:00 PDT"),
    task("002", "in-progress", "2026-01-02 10:00 PDT"),
    task("003", "done", "2026-01-03 10:00 PDT"),
  ]);
  assert.deepEqual(inboxItems([p]), []);
});

test("inboxItems: needs-review > blocked > open ordering", () => {
  const p = project("a", [
    task("001-open",   "open",         "2026-01-01 10:00 PDT"),
    task("002-block",  "blocked",      "2026-01-02 10:00 PDT"),
    task("003-review", "needs-review", "2026-01-03 10:00 PDT"),
  ]);
  const items = inboxItems([p]);
  assert.deepEqual(items.map(i => i.status), ["needs-review", "blocked", "open"]);
});

test("inboxItems: within bucket oldest first", () => {
  const p = project("a", [
    task("001-newer", "needs-review", "2026-05-09 10:00 PDT"),
    task("002-older", "needs-review", "2026-05-01 10:00 PDT"),
  ]);
  const items = inboxItems([p]);
  assert.deepEqual(items.map(i => i.task.slug), ["002-older", "001-newer"]);
});

test("inboxItems: cross-project, no filter", () => {
  const a = project("a", [task("001", "open", "2026-01-01 10:00 PDT")]);
  const b = project("b", [task("002", "blocked", "2026-01-02 10:00 PDT")]);
  const items = inboxItems([a, b]);
  assert.equal(items.length, 2);
});
