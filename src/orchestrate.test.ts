import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimeBound } from "./orchestrate.ts";
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

test("resolveTimeBound: built-in default when nothing set", () => {
  assert.equal(resolveTimeBound({ task: task(), project: project() }), 30);
});

test("resolveTimeBound: global config wins over default", () => {
  assert.equal(
    resolveTimeBound({ task: task(), project: project() }, 45),
    45,
  );
});

test("resolveTimeBound: project frontmatter wins over global", () => {
  assert.equal(
    resolveTimeBound({ task: task(), project: project({ time_bound_minutes: 60 }) }, 45),
    60,
  );
});

test("resolveTimeBound: task frontmatter wins over project", () => {
  assert.equal(
    resolveTimeBound({
      task: task({ time_bound_minutes: 15 }),
      project: project({ time_bound_minutes: 60 }),
    }, 45),
    15,
  );
});

test("resolveTimeBound: ignores non-positive integers in frontmatter", () => {
  // 0, negative, non-integer, string — all silently fall through.
  assert.equal(
    resolveTimeBound({
      task: task({ time_bound_minutes: 0 }),
      project: project({ time_bound_minutes: -5 }),
    }),
    30,
  );
  assert.equal(
    resolveTimeBound({
      task: task({ time_bound_minutes: 12.5 }),
      project: project({ time_bound_minutes: "60" }),
    }),
    30,
  );
});

test("resolveTimeBound: ignores invalid global, falls back to default", () => {
  assert.equal(
    resolveTimeBound({ task: task(), project: project() }, 0),
    30,
  );
  assert.equal(
    resolveTimeBound({ task: task(), project: project() }, -1),
    30,
  );
});
