import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { runPoll } from "./poll.ts";
import { parse } from "./frontmatter.ts";
import type { FetchedSignal } from "./pr_signal.ts";
import type { LogLevel } from "./log.ts";

// ---- fixtures ------------------------------------------------------------

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

function taskMd(slug: string, status: string, prs: string[] = []): string {
  const prsField = prs.length === 0 ? "[]" : `[${prs.join(", ")}]`;
  return `---
title: Task ${slug}
slug: ${slug}
project: alpha
status: ${status}
type: pr
created: 2026-01-01 00:00 PDT
closed:
prs: ${prsField}
tags: []
---

# Task ${slug}

## Context
ctx

## Plan
1. step

## Log
- 2026-01-01 00:00 PDT: created

## Outcome
<!-- Filled when closed -->
`;
}

function setupTree(): string {
  const root = mkTempDir("tpm-poll-");
  const projectDir = join(root, "alpha");
  mkdirSync(join(projectDir, "tasks"), { recursive: true });
  writeFileSync(join(projectDir, "project.md"), projectMd("alpha"));
  return root;
}

function writeTask(root: string, slug: string, status: string, prs: string[] = []): string {
  const path = join(root, "alpha", "tasks", `${slug}.md`);
  writeFileSync(path, taskMd(slug, status, prs));
  return path;
}

function captureLog(): {
  sink: (level: LogLevel, message: string) => void;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    sink: (level, message) => { lines.push(`${level} ${message}`); },
    lines,
  };
}

function mergedFetch(url: string): FetchedSignal {
  return {
    signal: {
      kind: "merged",
      url,
      title: "Ship the thing",
      body: "## Summary\n- did it\n",
      mergedAt: "2026-05-10T19:00:00Z",
    },
    raw: { url, state: "MERGED" },
  };
}

// ---- tests ---------------------------------------------------------------

test("runPoll: empty queue -> 'no tasks to watch', summary all zero", async () => {
  const root = setupTree();
  const { sink, lines } = captureLog();
  try {
    const summary = await runPoll({
      root,
      log: sink,
      fetchSignal: async () => { throw new Error("should not fetch"); },
    });
    assert.deepEqual(summary, { checked: 0, flipped: 0, noSignal: 0, fetchFailed: 0 });
    assert.ok(
      lines.some((l) => l.includes("no tasks to watch")),
      `expected 'no tasks to watch' in log; got:\n${lines.join("\n")}`,
    );
  } finally {
    rmTempDir(root);
  }
});

test("runPoll: in-progress task with merged PR -> needs-close + inline auto-close", async () => {
  const root = setupTree();
  writeTask(root, "001-foo", "in-progress", ["https://github.com/o/r/pull/1"]);
  const { sink, lines } = captureLog();
  try {
    const summary = await runPoll({
      root,
      log: sink,
      fetchSignal: async (url) => mergedFetch(url),
    });
    assert.equal(summary.checked, 1);
    assert.equal(summary.flipped, 1);
    assert.equal(summary.noSignal, 0);
    assert.equal(summary.fetchFailed, 0);

    // type: pr archives on complete — final resting place is tasks/archive/.
    const archivedPath = join(root, "alpha", "tasks", "archive", "001-foo.md");
    const { data, body } = parse(readFileSync(archivedPath, "utf8"));
    assert.equal(data.status, "done");
    assert.match(body, /Ship the thing\./);
    assert.match(body, /Merged via https:\/\/github\.com\/o\/r\/pull\/1/);
    assert.ok(
      lines.some((l) => l.includes("auto-closed alpha/001-foo")),
      `expected auto-closed log line; got:\n${lines.join("\n")}`,
    );
  } finally {
    rmTempDir(root);
  }
});

test("runPoll: ready task + PR with CI red -> flip-to-needs-feedback", async () => {
  const root = setupTree();
  writeTask(root, "002-bar", "ready", ["https://github.com/o/r/pull/2"]);
  const { sink, lines } = captureLog();
  try {
    const summary = await runPoll({
      root,
      log: sink,
      fetchSignal: async () => ({
        signal: { kind: "needs-agent", reason: "CI FAIL on https://github.com/o/r/pull/2" },
        raw: { state: "OPEN" },
      }),
    });
    assert.equal(summary.checked, 1);
    assert.equal(summary.flipped, 1);
    assert.equal(summary.noSignal, 0);
    assert.equal(summary.fetchFailed, 0);

    const { data, body } = parse(
      readFileSync(join(root, "alpha", "tasks", "002-bar.md"), "utf8"),
    );
    assert.equal(data.status, "needs-feedback");
    assert.match(body, /poller — CI FAIL on https:\/\/github\.com\/o\/r\/pull\/2/);
    assert.ok(
      lines.some((l) => l.includes("flipped alpha/002-bar -> needs-feedback")),
      `expected flip log line; got:\n${lines.join("\n")}`,
    );
  } finally {
    rmTempDir(root);
  }
});

test("runPoll: mixed queue (no-signal + flipped + fetch-failed) — counters add up to checked", async () => {
  const root = setupTree();
  // A: ready with PR returning no-action -> no-signal after fetch
  writeTask(root, "001-noop", "ready", ["https://github.com/o/r/pull/1"]);
  // B: in-progress with PR that merges -> flipped (auto-close)
  writeTask(root, "002-merged", "in-progress", ["https://github.com/o/r/pull/2"]);
  // C: ready with PR whose fetch throws -> fetch-failed
  writeTask(root, "003-broken", "ready", ["https://github.com/o/r/pull/3"]);
  // D: ready WITHOUT a PR -> watched-but-no-PR -> no-signal (the bash branch
  //    that hit `prs_line` empty after the watch-check). Confirms a non-fetch
  //    no-signal path doesn't accidentally land in fetch-failed.
  writeTask(root, "004-empty", "ready", []);

  const { sink } = captureLog();
  try {
    const summary = await runPoll({
      root,
      log: sink,
      fetchSignal: async (url) => {
        if (url.endsWith("/1")) return { signal: { kind: "no-action" }, raw: {} };
        if (url.endsWith("/2")) return mergedFetch(url);
        throw new Error("synthetic fetch failure");
      },
    });
    assert.equal(summary.checked, 4);
    assert.equal(summary.flipped, 1);
    assert.equal(summary.noSignal, 2);
    assert.equal(summary.fetchFailed, 1);
    assert.equal(
      summary.flipped + summary.noSignal + summary.fetchFailed,
      summary.checked,
      "counters must sum to checked",
    );
  } finally {
    rmTempDir(root);
  }
});

test("runPoll: --dry-run logs decisions but does not mutate", async () => {
  const root = setupTree();
  const taskPath = writeTask(root, "001-foo", "in-progress", ["https://github.com/o/r/pull/1"]);
  const before = readFileSync(taskPath, "utf8");
  const { sink, lines } = captureLog();
  try {
    const summary = await runPoll({
      root,
      dryRun: true,
      log: sink,
      fetchSignal: async (url) => mergedFetch(url),
    });
    assert.equal(summary.flipped, 1);
    const after = readFileSync(taskPath, "utf8");
    assert.equal(after, before, "task file must be byte-identical in dry-run");
    assert.ok(
      lines.some((l) => l.includes("would auto-close alpha/001-foo")),
      `expected 'would auto-close' log; got:\n${lines.join("\n")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("(dry-run)")),
      `expected dry-run suffix on summary; got:\n${lines.join("\n")}`,
    );
  } finally {
    rmTempDir(root);
  }
});

test("runPoll: tasks in non-watched statuses are not enumerated", async () => {
  // open / blocked / done / dropped never enter the candidate list — neither
  // their `checked` count nor their PRs are touched. The bash version enforced
  // this at enumeration via the `tpm ls --status <S>` list; the TS version
  // enforces it via WATCHED_STATUSES on the in-memory tree.
  const root = setupTree();
  writeTask(root, "001-open", "open", ["https://github.com/o/r/pull/1"]);
  writeTask(root, "002-blocked", "blocked", ["https://github.com/o/r/pull/2"]);
  writeTask(root, "003-done", "done", ["https://github.com/o/r/pull/3"]);
  const { sink } = captureLog();
  try {
    const summary = await runPoll({
      root,
      log: sink,
      fetchSignal: async () => { throw new Error("should not fetch"); },
    });
    assert.deepEqual(summary, { checked: 0, flipped: 0, noSignal: 0, fetchFailed: 0 });
  } finally {
    rmTempDir(root);
  }
});
