import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNotifyConfig, shouldNotify, fireNotification, NOTIFY_EVENTS } from "./notify.ts";
import type { Project, Task } from "./tree.ts";

function task(extra: Record<string, unknown> = {}): Task {
  return {
    slug: "001-t",
    path: "/tmp/t.md",
    archived: false,
    data: { slug: "001-t", status: "ready", ...extra },
    body: "",
  };
}

function project(extra: Record<string, unknown> = {}): Project {
  return {
    slug: "p",
    path: "/tmp/p/project.md",
    dir: "/tmp/p",
    data: { slug: "p", status: "active", ...extra },
    body: "",
    tasks: [],
  };
}

test("resolveNotifyConfig: built-in default when nothing set", () => {
  const r = resolveNotifyConfig({ task: task(), project: project() });
  assert.deepEqual(r, { start: false, finish: true, fail: true });
});

test("resolveNotifyConfig: global override wins over default", () => {
  const r = resolveNotifyConfig({
    task: task(),
    project: project(),
    globalConfig: { start: true, finish: false },
  });
  assert.deepEqual(r, { start: true, finish: false, fail: true });
});

test("resolveNotifyConfig: project frontmatter wins over global", () => {
  const r = resolveNotifyConfig({
    task: task(),
    project: project({ notifications: { fail: false } }),
    globalConfig: { fail: true },
  });
  assert.equal(r.fail, false);
});

test("resolveNotifyConfig: task frontmatter wins over project", () => {
  const r = resolveNotifyConfig({
    task: task({ notifications: { start: true } }),
    project: project({ notifications: { start: false } }),
    globalConfig: { start: false },
  });
  assert.equal(r.start, true);
});

test("resolveNotifyConfig: cascade is per-event (task overrides one, inherits others)", () => {
  const r = resolveNotifyConfig({
    task: task({ notifications: { fail: false } }),
    project: project({ notifications: { start: true } }),
    globalConfig: { finish: false },
  });
  assert.deepEqual(r, { start: true, finish: false, fail: false });
});

test("resolveNotifyConfig: ignores non-boolean frontmatter values", () => {
  const r = resolveNotifyConfig({
    task: task({ notifications: { start: "yes", fail: 1 } }),
    project: project({ notifications: { start: true } }),
  });
  // task `start: "yes"` is dropped → falls through to project's `start: true`.
  // task `fail: 1` is dropped → falls through to default `fail: true`.
  assert.deepEqual(r, { start: true, finish: true, fail: true });
});

test("resolveNotifyConfig: ignores non-object frontmatter notifications", () => {
  const r = resolveNotifyConfig({
    task: task({ notifications: "on" }),
    project: project({ notifications: ["start"] }),
  });
  assert.deepEqual(r, { start: false, finish: true, fail: true });
});

test("shouldNotify: returns the resolved event flag", () => {
  const input = { task: task(), project: project() };
  assert.equal(shouldNotify("start",  input), false);
  assert.equal(shouldNotify("finish", input), true);
  assert.equal(shouldNotify("fail",   input), true);
});

test("NOTIFY_EVENTS: covers exactly start, finish, fail", () => {
  assert.deepEqual([...NOTIFY_EVENTS], ["start", "finish", "fail"]);
});

test("fireNotification: invokes injected osascript and survives a thrown error", () => {
  const calls: Array<[string, string]> = [];
  fireNotification("tpm", "001-t: finish", { osascript: (t, m) => calls.push([t, m]) });
  assert.deepEqual(calls, [["tpm", "001-t: finish"]]);

  // Failure inside osascript shouldn't propagate (best-effort contract).
  assert.doesNotThrow(() =>
    fireNotification("tpm", "001-t: fail", { osascript: () => { throw new Error("boom"); } }),
  );
});
