import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { loadProjects } from "./tree.ts";
import {
  start, ready, block, reopen, revert, logEntry, addPr, setStatus, complete,
  setAllowOrchestrator, reparent,
  appendLog, setSection, sectionHasContent,
} from "./mutate.ts";
import { parse } from "./frontmatter.ts";

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

function taskMd(slug: string, status = "open", type = "pr"): string {
  return `---
title: Task ${slug}
slug: ${slug}
project: alpha
status: ${status}
type: ${type}
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
<!-- Filled when closed -->
`;
}

function setupProject(root: string, slug: string): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "project.md"), projectMd(slug));
  return dir;
}

function writeTask(projectDir: string, file: string, status = "open", type = "pr"): string {
  const slug = file.replace(/\.md$/, "");
  const path = join(projectDir, "tasks", file);
  writeFileSync(path, taskMd(slug, status, type));
  return path;
}

function loadTask(root: string, projectSlug: string, slug: string) {
  const [proj] = loadProjects(root, { archived: true }).filter(p => p.slug === projectSlug);
  return proj.tasks.find(t => t.slug === slug)!;
}

// ---- pure body helpers ----------------------------------------------------

test("appendLog: adds line to existing Log section, preserves separator before next section", () => {
  const body = "## Log\n- a\n- b\n\n## Outcome\nnope\n";
  const out = appendLog(body, "2026-01-01 12:00 PDT: did stuff");
  assert.match(out, /- 2026-01-01 12:00 PDT: did stuff\n\n## Outcome/);
  assert.match(out, /- a\n- b\n- 2026-01-01 12:00 PDT/);
});

test("appendLog: works when Log is the last section", () => {
  const body = "## Log\n- a\n";
  const out = appendLog(body, "x: y");
  assert.equal(out, "## Log\n- a\n- x: y\n");
});

test("appendLog: throws when Log section missing", () => {
  assert.throws(() => appendLog("## Plan\n1.\n", "msg"), /missing ## Log section/);
});

test("setSection: replaces content, preserves separator before next section", () => {
  const body = "## Outcome\n<!-- placeholder -->\n\n## Other\nx\n";
  const out = setSection(body, "Outcome", "shipped XYZ via PR #42");
  assert.match(out, /## Outcome\nshipped XYZ via PR #42\n\n## Other/);
});

test("setSection: works when target is last section", () => {
  const body = "## Outcome\n<!-- placeholder -->\n";
  const out = setSection(body, "Outcome", "done");
  assert.equal(out, "## Outcome\ndone\n");
});

test("sectionHasContent: false when only HTML comment placeholder present", () => {
  assert.equal(sectionHasContent("## Outcome\n<!-- Filled when closed -->\n", "Outcome"), false);
});

test("sectionHasContent: true when real prose present", () => {
  assert.equal(sectionHasContent("## Outcome\nshipped via PR #5\n", "Outcome"), true);
});

// ---- start ----------------------------------------------------------------

test("start: open -> in-progress, logs entry", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    const r = start(t);
    assert.match(r.message, /-> in-progress/);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: in-progress/);
    assert.match(text, /: started$/m);
  } finally {
    rmTempDir(root);
  }
});

test("start: idempotent — already in-progress is a no-op (no extra log line)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const before = readFileSync(t.path, "utf8");
    const r = start(t);
    assert.match(r.message, /already in-progress/);
    assert.equal(readFileSync(t.path, "utf8"), before);
  } finally {
    rmTempDir(root);
  }
});

test("start: rejects done", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "done");
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => start(t), /Cannot transition/);
  } finally {
    rmTempDir(root);
  }
});

// ---- ready ----------------------------------------------------------------

test("ready: open -> ready, logs promoted", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    ready(t);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: ready/);
    assert.match(text, /: promoted to ready$/m);
  } finally {
    rmTempDir(root);
  }
});

test("ready: idempotent", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready");
    const t = loadTask(root, "alpha", "001-a");
    const before = readFileSync(t.path, "utf8");
    ready(t);
    assert.equal(readFileSync(t.path, "utf8"), before);
  } finally {
    rmTempDir(root);
  }
});

// ---- block ----------------------------------------------------------------

test("block: requires a reason", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => block(t, ""), /requires a reason/);
  } finally {
    rmTempDir(root);
  }
});

test("block: in-progress -> blocked, logs reason", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    block(t, "waiting on API key");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: blocked/);
    assert.match(text, /blocked — waiting on API key$/m);
  } finally {
    rmTempDir(root);
  }
});

// ---- reopen ---------------------------------------------------------------

test("reopen: done -> open, clears closed stamp, logs reopened", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const path = writeTask(dir, "001-a.md", "done");
    // give the task a closed timestamp first
    const orig = readFileSync(path, "utf8");
    writeFileSync(path, orig.replace(/closed:\s*$/m, "closed: 2026-04-28 00:00 PDT"));
    const t = loadTask(root, "alpha", "001-a");
    reopen(t);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: open/);
    assert.match(text, /^closed:\s*$/m);
    assert.match(text, /: reopened$/m);
  } finally {
    rmTempDir(root);
  }
});

// ---- logEntry -------------------------------------------------------------

test("log: appends a single timestamped line", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    logEntry(t, "ran tests, 2 failures");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /: ran tests, 2 failures$/m);
  } finally {
    rmTempDir(root);
  }
});

test("log: rejects empty message", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => logEntry(t, ""), /requires a message/);
    assert.throws(() => logEntry(t, "   "), /requires a message/);
  } finally {
    rmTempDir(root);
  }
});

// ---- addPr ----------------------------------------------------------------

test("pr: adds URL to prs:, logs opened-PR", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    addPr(t, "https://github.com/x/y/pull/1");
    const text = readFileSync(t.path, "utf8");
    const { data } = parse(text);
    assert.deepEqual(data.prs, ["https://github.com/x/y/pull/1"]);
    assert.match(text, /opened PR https:\/\/github\.com\/x\/y\/pull\/1$/m);
  } finally {
    rmTempDir(root);
  }
});

test("pr: dedupes — same URL is a no-op", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    addPr(t, "https://github.com/x/y/pull/1");
    const before = readFileSync(t.path, "utf8");
    // Reload — the first call mutated the task in place (to needs-review).
    const t2 = loadTask(root, "alpha", "001-a");
    const r = addPr(t2, "https://github.com/x/y/pull/1");
    assert.match(r.message, /already linked/);
    assert.equal(readFileSync(t.path, "utf8"), before);
  } finally {
    rmTempDir(root);
  }
});

test("pr: in-progress task flips to needs-review with a status-flip log line", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const r = addPr(t, "https://github.com/x/y/pull/1");
    assert.match(r.message, /-> needs-review/);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: needs-review/);
    assert.match(text, /opened PR https:\/\/github\.com\/x\/y\/pull\/1$/m);
    assert.match(text, /status -> needs-review \(PR opened, awaiting review\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("pr: needs-feedback task — addPr links URL but does NOT flip status", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "needs-feedback");
    const t = loadTask(root, "alpha", "001-a");
    const r = addPr(t, "https://github.com/x/y/pull/2");
    assert.doesNotMatch(r.message, /needs-review/);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: needs-feedback/);
    assert.match(text, /opened PR https:\/\/github\.com\/x\/y\/pull\/2$/m);
    assert.doesNotMatch(text, /status -> needs-review/);
  } finally {
    rmTempDir(root);
  }
});

test("pr: ready task — addPr links URL but does NOT flip status (only in-progress flips)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready");
    const t = loadTask(root, "alpha", "001-a");
    addPr(t, "https://github.com/x/y/pull/3");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: ready/);
    assert.doesNotMatch(text, /status -> needs-review/);
  } finally {
    rmTempDir(root);
  }
});

test("pr: flip branch emits a louder terminus line; non-flip branch does not", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    // Flip branch: in-progress -> needs-review carries the terminus.
    writeTask(dir, "001-a.md", "in-progress");
    const t1 = loadTask(root, "alpha", "001-a");
    const r1 = addPr(t1, "https://github.com/x/y/pull/1");
    assert.match(r1.message, /Your turn is complete — exit/);
    assert.match(r1.message, /do not poll CI/);
    // Non-flip branch: ready stays ready and gets just the linked line.
    writeTask(dir, "002-b.md", "ready");
    const t2 = loadTask(root, "alpha", "002-b");
    const r2 = addPr(t2, "https://github.com/x/y/pull/2");
    assert.doesNotMatch(r2.message, /Your turn is complete/);
    assert.doesNotMatch(r2.message, /do not poll CI/);
  } finally {
    rmTempDir(root);
  }
});

test("pr: duplicate URL on already-flipped task — no extra status flip, no extra log lines", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    addPr(t, "https://github.com/x/y/pull/1");
    const afterFirst = readFileSync(t.path, "utf8");
    // Re-attach the same URL — must be a byte-identical no-op.
    const t2 = loadTask(root, "alpha", "001-a");
    addPr(t2, "https://github.com/x/y/pull/1");
    assert.equal(readFileSync(t.path, "utf8"), afterFirst);
    // Exactly one status-flip log line — re-flipping would append another.
    const flipCount = (afterFirst.match(/status -> needs-review/g) ?? []).length;
    assert.equal(flipCount, 1);
  } finally {
    rmTempDir(root);
  }
});

// ---- complete -------------------------------------------------------------

test("complete: type=pr archives by default", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const livePath = writeTask(dir, "001-a.md", "in-progress", "pr");
    const t = loadTask(root, "alpha", "001-a");
    const r = complete(t, {});
    assert.match(r.message, /-> done/);
    assert.ok(r.archivedAt);
    assert.ok(!existsSync(livePath));
    assert.ok(existsSync(join(dir, "tasks", "archive", "001-a.md")));
  } finally {
    rmTempDir(root);
  }
});

test("complete: type=investigation does NOT archive by default", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const livePath = writeTask(dir, "001-finding.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-finding");
    const r = complete(t, {});
    assert.match(r.message, /-> done/);
    assert.equal(r.archivedAt, undefined);
    assert.ok(existsSync(livePath));
    const text = readFileSync(livePath, "utf8");
    assert.match(text, /status: done/);
  } finally {
    rmTempDir(root);
  }
});

test("complete: --no-archive overrides default-archive for type=pr", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const livePath = writeTask(dir, "001-a.md", "in-progress", "pr");
    const t = loadTask(root, "alpha", "001-a");
    const r = complete(t, { archive: false });
    assert.equal(r.archivedAt, undefined);
    assert.ok(existsSync(livePath));
  } finally {
    rmTempDir(root);
  }
});

test("complete: --archive overrides default-skip for type=investigation", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const livePath = writeTask(dir, "001-finding.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-finding");
    const r = complete(t, { archive: true });
    assert.ok(r.archivedAt);
    assert.ok(!existsSync(livePath));
  } finally {
    rmTempDir(root);
  }
});

test("complete: --outcome fills Outcome when empty (placeholder counts as empty)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    complete(t, { outcome: "shipped via PR #99" });
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /## Outcome\nshipped via PR #99/);
  } finally {
    rmTempDir(root);
  }
});

test("complete: refuses --outcome when Outcome already has prose", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const livePath = writeTask(dir, "001-a.md", "in-progress", "investigation");
    // Pre-fill Outcome
    const orig = readFileSync(livePath, "utf8");
    writeFileSync(livePath, orig.replace("<!-- Filled when closed -->", "preliminary findings"));
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => complete(t, { outcome: "new prose" }), /already has content/);
  } finally {
    rmTempDir(root);
  }
});

test("complete: idempotent — already-done returns a clean message and doesn't duplicate logs", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    complete(t, {});
    // Reload; already-done path
    const t2 = loadTask(root, "alpha", "001-a");
    const before = readFileSync(t2.path, "utf8");
    const r = complete(t2, {});
    assert.match(r.message, /already done/);
    assert.equal(readFileSync(t2.path, "utf8"), before);
  } finally {
    rmTempDir(root);
  }
});

test("complete: rejects dropped", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "dropped", "pr");
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => complete(t, {}), /status is dropped/);
  } finally {
    rmTempDir(root);
  }
});

// ---- setStatus (generic) --------------------------------------------------

test("status: rejects unknown status", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => setStatus(t, "rotten"), /Unknown status/);
  } finally {
    rmTempDir(root);
  }
});

test("revert: in-progress -> ready, logs timeout reason", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    revert(t, "time bound 30m exceeded");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: ready/);
    assert.match(text, /timed out — reverted to ready \(time bound 30m exceeded\)/);
  } finally {
    rmTempDir(root);
  }
});

test("revert: no reason still logs the verb", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    revert(t);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: ready/);
    assert.match(text, /timed out — reverted to ready/);
    assert.doesNotMatch(text, /reverted to ready \(/);
  } finally {
    rmTempDir(root);
  }
});

test("revert: idempotent on non-in-progress (does not flip or log)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready");
    const t = loadTask(root, "alpha", "001-a");
    const r = revert(t);
    assert.match(r.message, /not in-progress/);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: ready/);
    assert.doesNotMatch(text, /timed out/);
  } finally {
    rmTempDir(root);
  }
});

test("revert: refuses done and dropped (terminal states)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "done");
    const t1 = loadTask(root, "alpha", "001-a");
    const r1 = revert(t1);
    assert.match(r1.message, /not in-progress/);

    writeTask(dir, "002-b.md", "dropped");
    const t2 = loadTask(root, "alpha", "002-b");
    const r2 = revert(t2);
    assert.match(r2.message, /not in-progress/);
  } finally {
    rmTempDir(root);
  }
});

test("status: in-progress -> needs-feedback (poller path) is accepted", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    setStatus(t, "needs-feedback");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: needs-feedback/);
  } finally {
    rmTempDir(root);
  }
});

test("status: in-progress -> needs-close (poller path on merged PR) is accepted", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    setStatus(t, "needs-close");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: needs-close/);
  } finally {
    rmTempDir(root);
  }
});

test("complete: needs-close -> done (close-out from poller-flagged task)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const livePath = writeTask(dir, "001-a.md", "needs-close", "pr");
    const t = loadTask(root, "alpha", "001-a");
    const r = complete(t, { outcome: "shipped via PR #1" });
    assert.match(r.message, /-> done/);
    // type: pr archives by default, so live path no longer exists.
    assert.ok(r.archivedAt);
    assert.ok(!existsSync(livePath));
  } finally {
    rmTempDir(root);
  }
});

test("status: needs-feedback -> needs-review (agent escalation) is accepted", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "needs-feedback");
    const t = loadTask(root, "alpha", "001-a");
    setStatus(t, "needs-review");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: needs-review/);
  } finally {
    rmTempDir(root);
  }
});

test("status: open -> dropped works (escape hatch)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    setStatus(t, "dropped");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: dropped/);
  } finally {
    rmTempDir(root);
  }
});

// ---- round-trip preservation ---------------------------------------------

test("round-trip: frontmatter key order preserved across mutate", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    start(t);
    const text = readFileSync(t.path, "utf8");
    const fmEnd = text.indexOf("\n---", 4);
    const fm = text.slice(4, fmEnd);
    const keys = fm.split("\n").map(l => l.match(/^([A-Za-z_][A-Za-z0-9_-]*):/)?.[1]).filter(Boolean);
    assert.deepEqual(keys, [
      "title", "slug", "project", "status", "type", "created", "closed", "prs", "tags",
    ]);
  } finally {
    rmTempDir(root);
  }
});

test("round-trip: unrelated body sections are not reflowed", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    start(t);
    const text = readFileSync(t.path, "utf8");
    // ## Context and ## Plan should be byte-identical to the template.
    assert.match(text, /## Context\nsome context\n\n## Plan\n1\. do the thing\n\n## Log/);
  } finally {
    rmTempDir(root);
  }
});

// ---- setAllowOrchestrator -------------------------------------------------

test("setAllowOrchestrator: writes allow_orchestrator: true and logs verb", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready");
    const t = loadTask(root, "alpha", "001-a");
    const r = setAllowOrchestrator(t, true);
    assert.match(r.message, /-> true/);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /allow_orchestrator: true/);
    assert.match(text, /allow_orchestrator: true \(safe for autonomous runs\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("setAllowOrchestrator: idempotent — same value is no-op", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready");
    const t = loadTask(root, "alpha", "001-a");
    setAllowOrchestrator(t, true);
    const before = readFileSync(t.path, "utf8");
    // Reload task to pick up the new value
    const t2 = loadTask(root, "alpha", "001-a");
    const r = setAllowOrchestrator(t2, true);
    assert.match(r.message, /already true/);
    assert.equal(readFileSync(t.path, "utf8"), before);
  } finally {
    rmTempDir(root);
  }
});

test("setAllowOrchestrator: refuses parent containers", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    // Make a folder-form parent with a child so it's a container
    const parentDir = join(dir, "tasks", "002-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("002-parent", "ready").replace("project: alpha", "project: alpha"));
    writeFileSync(join(parentDir, "003-child.md"), taskMd("003-child", "ready").replace(/project: alpha/, "project: alpha\nparent: 002-parent"));
    const [proj] = loadProjects(root, { archived: true });
    const parent = proj.tasks.find(t => t.slug === "002-parent")!;
    assert.ok(parent.children?.length);
    assert.throws(() => setAllowOrchestrator(parent, true), /parents aren't claimable/);
  } finally {
    rmTempDir(root);
  }
});

test("guard: archived tasks reject mutations", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const archive = join(dir, "tasks", "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "001-old.md"), taskMd("001-old", "done"));
    const [proj] = loadProjects(root, { archived: true });
    const t = proj.tasks.find(x => x.slug === "001-old")!;
    assert.equal(t.archived, true);
    assert.throws(() => logEntry(t, "anything"), /Cannot mutate archived task/);
    assert.throws(() => start(t), /Cannot mutate archived task/);
  } finally {
    rmTempDir(root);
  }
});

// ---- reparent -------------------------------------------------------------

function loadByQualifiedSlug(root: string, projectSlug: string, slug: string) {
  const [proj] = loadProjects(root, { archived: true }).filter(p => p.slug === projectSlug);
  for (const t of proj.tasks) {
    if (t.slug === slug) return t;
    for (const c of t.children ?? []) if (c.slug === slug) return c;
  }
  throw new Error(`No task ${slug} in ${projectSlug}`);
}

test("reparent: top-level -> child of an existing parent (auto-folds parent, adds parent: frontmatter)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-parent.md");
    writeTask(dir, "002-loose.md");
    const task = loadTask(root, "alpha", "002-loose");
    const newParent = loadTask(root, "alpha", "001-parent");
    const r = reparent(task, newParent);
    assert.equal(r.newSlug, "001-loose");
    assert.equal(r.newPath, join(dir, "tasks", "001-parent", "001-loose.md"));
    assert.ok(existsSync(r.newPath));
    assert.ok(!existsSync(join(dir, "tasks", "002-loose.md")));
    // Parent got folded.
    assert.ok(existsSync(join(dir, "tasks", "001-parent", "task.md")));
    // Frontmatter has parent: pointing at the parent's NNN-prefixed slug.
    const { data } = parse(readFileSync(r.newPath, "utf8"));
    assert.equal(data.parent, "001-parent");
    // Log line written.
    assert.match(readFileSync(r.newPath, "utf8"), /reparented from top-level to under 001-parent/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: child -> top-level (drops parent: from frontmatter)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    // Folder-form parent with two children.
    const parentDir = join(dir, "tasks", "002-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("002-parent"));
    writeFileSync(join(parentDir, "001-child.md"),
      taskMd("001-child").replace("project: alpha\n", "project: alpha\nparent: 002-parent\n"));
    writeTask(dir, "001-other.md"); // top-level neighbor so renumber must skip 001
    const child = loadByQualifiedSlug(root, "alpha", "001-child");
    const r = reparent(child, null);
    // Top-level now has 001-other.md (and 002-parent/), so next NNN is 003.
    assert.equal(r.newSlug, "003-child");
    assert.equal(r.newPath, join(dir, "tasks", "003-child.md"));
    assert.ok(existsSync(r.newPath));
    assert.ok(!existsSync(join(parentDir, "001-child.md")));
    const { data } = parse(readFileSync(r.newPath, "utf8"));
    assert.equal(data.parent, undefined);
    assert.match(readFileSync(r.newPath, "utf8"), /reparented from under 002-parent to top-level/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: child -> different parent (renumbers in destination)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    // Two folder-form parents.
    for (const p of ["001-old-parent", "002-new-parent"]) {
      const pd = join(dir, "tasks", p);
      mkdirSync(pd, { recursive: true });
      writeFileSync(join(pd, "task.md"), taskMd(p));
    }
    // Source child + an existing destination child to force renumbering.
    writeFileSync(
      join(dir, "tasks", "001-old-parent", "001-mover.md"),
      taskMd("001-mover").replace("project: alpha\n", "project: alpha\nparent: 001-old-parent\n"),
    );
    writeFileSync(
      join(dir, "tasks", "002-new-parent", "001-resident.md"),
      taskMd("001-resident").replace("project: alpha\n", "project: alpha\nparent: 002-new-parent\n"),
    );
    const child = loadByQualifiedSlug(root, "alpha", "001-mover");
    const newParent = loadTask(root, "alpha", "002-new-parent");
    const r = reparent(child, newParent);
    assert.equal(r.newSlug, "002-mover");
    assert.equal(r.newPath, join(dir, "tasks", "002-new-parent", "002-mover.md"));
    assert.ok(existsSync(r.newPath));
    assert.ok(!existsSync(join(dir, "tasks", "001-old-parent", "001-mover.md")));
    const { data } = parse(readFileSync(r.newPath, "utf8"));
    assert.equal(data.parent, "002-new-parent");
  } finally {
    rmTempDir(root);
  }
});

test("reparent: numbering picks max(NNN)+1 across destination + its archive sibling", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-parent.md");
    writeTask(dir, "002-mover.md");
    // Pre-existing archived child of 001-parent at 005 — new file must skip past it.
    const archiveParent = join(dir, "tasks", "archive", "001-parent");
    mkdirSync(archiveParent, { recursive: true });
    writeFileSync(join(archiveParent, "005-old.md"),
      taskMd("005-old", "done").replace("project: alpha\n", "project: alpha\nparent: 001-parent\n"));
    const task = loadTask(root, "alpha", "002-mover");
    const newParent = loadTask(root, "alpha", "001-parent");
    const r = reparent(task, newParent);
    assert.equal(r.newSlug, "006-mover");
  } finally {
    rmTempDir(root);
  }
});

test("reparent: refuses parent task (would create grandchildren)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const parentDir = join(dir, "tasks", "001-big");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("001-big"));
    writeFileSync(join(parentDir, "001-kid.md"),
      taskMd("001-kid").replace("project: alpha\n", "project: alpha\nparent: 001-big\n"));
    writeTask(dir, "002-target.md");
    const big = loadTask(root, "alpha", "001-big");
    const target = loadTask(root, "alpha", "002-target");
    assert.throws(() => reparent(big, target), /has children/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: refuses folder-form task (even with no children — would orphan supporting files)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const folder = join(dir, "tasks", "001-foldy");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "task.md"), taskMd("001-foldy"));
    writeTask(dir, "002-target.md");
    const foldy = loadTask(root, "alpha", "001-foldy");
    const target = loadTask(root, "alpha", "002-target");
    assert.throws(() => reparent(foldy, target), /folder-form/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: refuses moving a child under another child (one level of nesting)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const parentDir = join(dir, "tasks", "001-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("001-parent"));
    writeFileSync(join(parentDir, "001-a.md"),
      taskMd("001-a").replace("project: alpha\n", "project: alpha\nparent: 001-parent\n"));
    writeFileSync(join(parentDir, "002-b.md"),
      taskMd("002-b").replace("project: alpha\n", "project: alpha\nparent: 001-parent\n"));
    const a = loadByQualifiedSlug(root, "alpha", "001-a");
    const b = loadByQualifiedSlug(root, "alpha", "002-b");
    assert.throws(() => reparent(a, b), /Only one level of nesting/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: refuses no-op (already a child of the same parent)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const parentDir = join(dir, "tasks", "001-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("001-parent"));
    writeFileSync(join(parentDir, "001-c.md"),
      taskMd("001-c").replace("project: alpha\n", "project: alpha\nparent: 001-parent\n"));
    const child = loadByQualifiedSlug(root, "alpha", "001-c");
    const parent = loadTask(root, "alpha", "001-parent");
    assert.throws(() => reparent(child, parent), /already a child of 001-parent/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: refuses no-op (already top-level)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-loose.md");
    const t = loadTask(root, "alpha", "001-loose");
    assert.throws(() => reparent(t, null), /already top-level/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: refuses archived task", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-target.md");
    const archive = join(dir, "tasks", "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "002-old.md"), taskMd("002-old", "done"));
    const old = loadByQualifiedSlug(root, "alpha", "002-old");
    const target = loadTask(root, "alpha", "001-target");
    assert.throws(() => reparent(old, target), /Cannot mutate archived/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: refuses moving into self", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-self.md");
    const t = loadTask(root, "alpha", "001-self");
    assert.throws(() => reparent(t, t), /into itself/);
  } finally {
    rmTempDir(root);
  }
});

test("reparent: parent: field is inserted right after project: (preserves key order)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-parent.md");
    writeTask(dir, "002-loose.md");
    const task = loadTask(root, "alpha", "002-loose");
    const newParent = loadTask(root, "alpha", "001-parent");
    const r = reparent(task, newParent);
    const text = readFileSync(r.newPath, "utf8");
    // project: ... newline, then parent: ...
    assert.match(text, /project: alpha\nparent: 001-parent\n/);
  } finally {
    rmTempDir(root);
  }
});
