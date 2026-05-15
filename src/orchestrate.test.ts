import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDisposition,
  formatDispositionLine,
  resolveTimeBound,
} from "./orchestrate.ts";
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

test("classifyDisposition: exit 0 with unchanged status and prs → stalled", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 0 },
    }),
    "stalled",
  );
});

test("classifyDisposition: exit 0 with status flipped → shipped", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "ready", prs: 0 },
      after: { status: "needs-review", prs: 0 },
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 0 with prs gained → shipped", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 1 },
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 0 with task gone (archived mid-run) → shipped", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 1 },
      after: null,
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 124 → timeout regardless of state", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "ready", prs: 0 },
      after: { status: "ready", prs: 0 },
    }),
    "timeout",
  );
});

test("classifyDisposition: non-zero non-124 exit → failed", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 1,
      before: { status: "ready", prs: 0 },
      after: { status: "ready", prs: 0 },
    }),
    "failed",
  );
  assert.equal(
    classifyDisposition({
      exitCode: 127,
      before: { status: "ready", prs: 0 },
      after: null,
    }),
    "failed",
  );
});

test("formatDispositionLine: stable schema for stalled run", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/051-foo",
      "stalled",
      0,
      { status: "in-progress", prs: 0 },
      { status: "in-progress", prs: 0 },
    ),
    "disposition tpm/051-foo stalled exit=0 status=in-progress->in-progress prs=0->0",
  );
});

test("formatDispositionLine: shipped run shows after-state diff", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/051-foo",
      "shipped",
      0,
      { status: "ready", prs: 0 },
      { status: "needs-review", prs: 1 },
    ),
    "disposition tpm/051-foo shipped exit=0 status=ready->needs-review prs=0->1",
  );
});

test("formatDispositionLine: archived-mid-run renders after-status as ?", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/051-foo",
      "shipped",
      0,
      { status: "in-progress", prs: 1 },
      null,
    ),
    "disposition tpm/051-foo shipped exit=0 status=in-progress->? prs=1->1",
  );
});

test("formatDispositionLine: timeout carries exit=124", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/051-foo",
      "timeout",
      124,
      { status: "ready", prs: 0 },
      { status: "ready", prs: 0 },
    ),
    "disposition tpm/051-foo timeout exit=124 status=ready->ready prs=0->0",
  );
});
