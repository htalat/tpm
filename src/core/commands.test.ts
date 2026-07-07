import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { execCommand, COMMAND_VERBS } from "./commands.ts";

// The command layer is the web's in-process replacement for spawning the CLI:
// same argv vocabulary in, {ok, stdout, stderr} out. These tests exercise the
// argv grammar edge (arity, flags, root laziness) — the verb semantics behind
// it are mutate.ts's, covered by mutate.test.ts.

function projectMd(slug: string): string {
  return `---
name: ${slug}
slug: ${slug}
status: active
created: 2026-01-01 00:00 PDT
tags: []
---

# ${slug}

## Goal
test
`;
}

function taskMd(slug: string, status = "open"): string {
  return `---
title: Task ${slug}
slug: ${slug}
project: alpha
status: ${status}
type: pr
created: 2026-01-01 00:00 PDT
closed:
prs: []
tags: []
---

# Task ${slug}

## Context
some context

## Plan
1. do the thing

## Log
- 2026-01-01 00:00 PDT: created

## Outcome
`;
}

function makeTree(tasks: Record<string, string>): string {
  const root = mkTempDir("tpm-commands-");
  mkdirSync(join(root, ".tpm"), { recursive: true });
  const tasksDir = join(root, "alpha", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(root, "alpha", "project.md"), projectMd("alpha"));
  for (const [file, content] of Object.entries(tasks)) {
    writeFileSync(join(tasksDir, file), content);
  }
  return root;
}

function taskText(root: string, file: string): string {
  return readFileSync(join(root, "alpha", "tasks", file), "utf8");
}

test("execCommand: ready flips open -> ready and reports the flip", () => {
  const root = makeTree({ "001-a.md": taskMd("a", "open") });
  try {
    const r = execCommand(root, ["ready", "a"]);
    assert.equal(r.ok, true, r.stderr);
    assert.match(r.stdout, /-> ready/);
    assert.match(taskText(root, "001-a.md"), /status: ready/);
  } finally {
    rmTempDir(root);
  }
});

test("execCommand: pr links the URL and flips in-progress -> review", () => {
  const root = makeTree({ "001-a.md": taskMd("a", "in-progress") });
  try {
    const r = execCommand(root, ["pr", "a", "https://github.com/x/y/pull/1"]);
    assert.equal(r.ok, true, r.stderr);
    assert.match(r.stdout, /linked https:\/\/github.com\/x\/y\/pull\/1/);
    assert.match(r.stdout, /-> review/);
    assert.match(taskText(root, "001-a.md"), /status: review/);
  } finally {
    rmTempDir(root);
  }
});

test("execCommand: complete honors --outcome and --no-archive, multi-line archive note otherwise", () => {
  const root = makeTree({ "001-a.md": taskMd("a", "review"), "002-b.md": taskMd("b", "review") });
  try {
    const kept = execCommand(root, ["complete", "a", "--outcome", "shipped it", "--no-archive"]);
    assert.equal(kept.ok, true, kept.stderr);
    assert.doesNotMatch(kept.stdout, /Archived ->/);
    assert.match(taskText(root, "001-a.md"), /status: done/);
    assert.match(taskText(root, "001-a.md"), /shipped it/);

    // Default for type=pr archives; the archive path lands on stdout's 2nd line.
    const archived = execCommand(root, ["done", "b"]);
    assert.equal(archived.ok, true, archived.stderr);
    assert.match(archived.stdout, /\nArchived -> .*archive/);
  } finally {
    rmTempDir(root);
  }
});

test("execCommand: status --force bypasses the transition table", () => {
  const root = makeTree({ "001-a.md": taskMd("a", "done") });
  try {
    const refused = execCommand(root, ["status", "a", "in-progress"]);
    assert.equal(refused.ok, false);
    assert.match(refused.stderr, /illegal transition|done/);

    const forced = execCommand(root, ["status", "a", "in-progress", "--force"]);
    assert.equal(forced.ok, true, forced.stderr);
    assert.match(taskText(root, "001-a.md"), /status: in-progress/);
  } finally {
    rmTempDir(root);
  }
});

test("execCommand: status with no new-status prints the vocabulary without touching the tree", () => {
  // Root thunk that throws — proves the listing never resolves the tree.
  const r = execCommand(() => { throw new Error("no tree"); }, ["status"]);
  assert.equal(r.ok, true, r.stderr);
  assert.match(r.stdout, /Valid task statuses/);
  assert.match(r.stdout, /\breview\b/);
  assert.match(r.stdout, /\brework\b/);
});

test("execCommand: arity errors surface as usage strings without resolving root", () => {
  const noRoot = () => { throw new Error("no tpm tree"); };
  for (const [argv, usage] of [
    [["drop"], 'tpm drop <task> ["<reason>"]'],
    [["block", "a"], 'tpm block <task> "<reason>"'],
    [["pr", "a"], "tpm pr <task> <url>"],
    [["edit", "a", "plan"], "tpm edit <task>"],
  ] as [string[], string][]) {
    const r = execCommand(noRoot, argv);
    assert.equal(r.ok, false, argv.join(" "));
    assert.ok(r.stderr.includes(usage), `${argv.join(" ")} -> ${r.stderr}`);
  }
});

test("execCommand: unknown verb and unmatched slug both fail with a message", () => {
  const root = makeTree({ "001-a.md": taskMd("a") });
  try {
    const unknown = execCommand(root, ["frobnicate", "a"]);
    assert.equal(unknown.ok, false);
    assert.match(unknown.stderr, /Unknown command: frobnicate/);

    const missing = execCommand(root, ["ready", "nope"]);
    assert.equal(missing.ok, false);
    assert.match(missing.stderr, /No task matched "nope"/);
  } finally {
    rmTempDir(root);
  }
});

test("execCommand: new task scaffolds under the project (web new-task form argv)", () => {
  const root = makeTree({});
  try {
    const r = execCommand(root, ["new", "task", "alpha", "shiny-thing", "--title", "Shiny Thing", "--type", "investigation"]);
    assert.equal(r.ok, true, r.stderr);
    assert.match(r.stdout, /^Created /);
    const created = r.stdout.slice("Created ".length);
    const text = readFileSync(created, "utf8");
    assert.match(text, /title: Shiny Thing/);
    assert.match(text, /type: investigation/);
  } finally {
    rmTempDir(root);
  }
});

test("execCommand: edit honors --expect-mtime CAS and rejects non-numeric values", () => {
  const root = makeTree({ "001-a.md": taskMd("a") });
  try {
    const stale = execCommand(root, ["edit", "a", "plan", "new plan", "--expect-mtime", "123"]);
    assert.equal(stale.ok, false);
    assert.match(stale.stderr, /file changed since the editor was loaded/);

    const bad = execCommand(root, ["edit", "a", "plan", "new plan", "--expect-mtime", "soon"]);
    assert.equal(bad.ok, false);
    assert.match(bad.stderr, /--expect-mtime must be a number/);

    const ok = execCommand(root, ["edit", "a", "plan", "new plan"]);
    assert.equal(ok.ok, true, ok.stderr);
    assert.match(taskText(root, "001-a.md"), /new plan/);
  } finally {
    rmTempDir(root);
  }
});

test("execCommand: archive resolves archived-aware and moves the task", () => {
  const root = makeTree({ "001-a.md": taskMd("a", "done") });
  try {
    const r = execCommand(root, ["archive", "a"]);
    assert.equal(r.ok, true, r.stderr);
    assert.match(r.stdout, /^Archived alpha\/001-a -> /);
  } finally {
    rmTempDir(root);
  }
});

test("COMMAND_VERBS matches the CLI's delegated surface (no orphan verbs)", () => {
  // Every delegated verb must be executable; a verb in the set that dispatch
  // doesn't know would turn a CLI command into "Unknown command".
  for (const verb of COMMAND_VERBS) {
    const r = execCommand(() => { throw new Error("no tree"); }, [verb]);
    assert.ok(!r.stderr.startsWith("Unknown command"), `${verb} not handled by dispatch`);
  }
});
