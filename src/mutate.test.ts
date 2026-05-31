import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { loadProjects } from "./tree.ts";
import {
  start, ready, block, reopen, revert, logEntry, addPr, setStatus, complete,
  setAllowOrchestrator, reparent, addReport, requestReportChanges,
  pullFromQueue, appendLog, setSection, sectionHasContent, editTaskSection,
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

test("start: custom verb writes that verb to the Log section (orchestrator eager-claim path)", () => {
  // Per task 108: the orchestrator flips ready -> in-progress before spawning
  // the agent so `tpm serve` matches the claim. The custom verb keeps the
  // audit trail distinguishable from the agent's own `tpm start`.
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready");
    const t = loadTask(root, "alpha", "001-a");
    const r = start(t, "claimed by orchestrator (spawning agent)");
    assert.match(r.message, /-> in-progress/);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: in-progress/);
    assert.match(text, /: claimed by orchestrator \(spawning agent\)$/m);
    // The default verb must not bleed through when a custom verb is passed.
    assert.doesNotMatch(text, /: started$/m);
  } finally {
    rmTempDir(root);
  }
});

test("start: custom verb on an already-in-progress task is still a no-op (double-claim is safe)", () => {
  // Rare race: orchestrator picks a stranded in-progress task (admitted by
  // queue.ts via hasTaskLock) and eager-flips. The eager flip is a no-op and
  // must not append a redundant Log line with the orchestrator verb.
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const before = readFileSync(t.path, "utf8");
    const r = start(t, "claimed by orchestrator (spawning agent)");
    assert.match(r.message, /already in-progress/);
    assert.equal(readFileSync(t.path, "utf8"), before);
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

test("ready: blocked -> ready in one call (inbox play-button path)", () => {
  // The inbox play button on a blocked row posts /t/<slug>/ready directly,
  // not a two-step reopen-then-ready. `transition()` doesn't refuse from
  // blocked, so this must land on ready in a single call (task 110).
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "blocked");
    const t = loadTask(root, "alpha", "001-a");
    ready(t);
    const text = readFileSync(t.path, "utf8");
    const { data } = parse(text);
    assert.equal(data.status, "ready");
    assert.equal(data.allow_orchestrator, true);
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

// ---- ready implies allow_orchestrator -------------------------------------

test("ready: sets allow_orchestrator: true on a task missing the field, logs set-on-ready", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    ready(t);
    const text = readFileSync(t.path, "utf8");
    const { data } = parse(text);
    assert.equal(data.status, "ready");
    assert.equal(data.allow_orchestrator, true);
    assert.match(text, /: promoted to ready$/m);
    assert.match(text, /allow_orchestrator: true \(set on ready\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("ready: flips an explicit allow_orchestrator: false to true and logs the change", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const path = writeTask(dir, "001-a.md", "open");
    writeFileSync(path, readFileSync(path, "utf8").replace(/tags: \[\]\n/, "tags: []\nallow_orchestrator: false\n"));
    const t = loadTask(root, "alpha", "001-a");
    ready(t);
    const text = readFileSync(t.path, "utf8");
    const { data } = parse(text);
    assert.equal(data.status, "ready");
    assert.equal(data.allow_orchestrator, true);
    assert.match(text, /allow_orchestrator: true \(set on ready\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("ready: already allow_orchestrator: true is a no-op on the flag (no extra log line)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const path = writeTask(dir, "001-a.md", "open");
    writeFileSync(path, readFileSync(path, "utf8").replace(/tags: \[\]\n/, "tags: []\nallow_orchestrator: true\n"));
    const t = loadTask(root, "alpha", "001-a");
    ready(t);
    const text = readFileSync(t.path, "utf8");
    const { data } = parse(text);
    assert.equal(data.status, "ready");
    assert.equal(data.allow_orchestrator, true);
    // Status flipped, but the flag didn't change → no set-on-ready line.
    assert.match(text, /: promoted to ready$/m);
    assert.doesNotMatch(text, /allow_orchestrator: true \(set on ready\)/);
  } finally {
    rmTempDir(root);
  }
});

test("ready: parent container does NOT get allow_orchestrator (parents aren't claimable)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const parentDir = join(dir, "tasks", "001-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("001-parent", "open"));
    writeFileSync(join(parentDir, "002-child.md"),
      taskMd("002-child", "open").replace("project: alpha", "project: alpha\nparent: 001-parent"));
    const [proj] = loadProjects(root, { archived: true });
    const parent = proj.tasks.find(t => t.slug === "001-parent")!;
    assert.ok(parent.children?.length);
    ready(parent);
    const { data } = parse(readFileSync(parent.path, "utf8"));
    assert.equal(data.status, "ready");
    assert.equal("allow_orchestrator" in data, false);
  } finally {
    rmTempDir(root);
  }
});

test("revert: landing at ready sets allow_orchestrator: true", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    revert(t, "timed out");
    const text = readFileSync(t.path, "utf8");
    const { data } = parse(text);
    assert.equal(data.status, "ready");
    assert.equal(data.allow_orchestrator, true);
    assert.match(text, /allow_orchestrator: true \(set on ready\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("status: generic setter to ready sets allow_orchestrator: true", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    setStatus(t, "ready");
    const text = readFileSync(t.path, "utf8");
    const { data } = parse(text);
    assert.equal(data.status, "ready");
    assert.equal(data.allow_orchestrator, true);
    assert.match(text, /allow_orchestrator: true \(set on ready\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("start: landing at in-progress does NOT touch allow_orchestrator (only ready paths do)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t = loadTask(root, "alpha", "001-a");
    start(t);
    const text = readFileSync(t.path, "utf8");
    const { data } = parse(text);
    assert.equal("allow_orchestrator" in data, false);
    assert.doesNotMatch(text, /set on ready/);
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

test("block: idempotent — already blocked is a no-op (no re-block, no extra log line)", () => {
  // The orchestrator's repo-presence guard relies on this: a task blocked for a
  // missing repo.local on a prior tick must not be re-blocked / re-logged if
  // the guard runs again (pre-claimed re-encounter).
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    block(t, "missing repo.local");
    const after = readFileSync(t.path, "utf8");
    const reloaded = loadTask(root, "alpha", "001-a");
    const r = block(reloaded, "missing repo.local");
    assert.match(r.message, /already blocked/);
    assert.equal(readFileSync(reloaded.path, "utf8"), after);
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

// ---- pullFromQueue --------------------------------------------------------

test("pull: ready -> open, logs pulled-from-queue with src+dst", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready");
    const t = loadTask(root, "alpha", "001-a");
    const r = pullFromQueue(t);
    assert.match(r.message, /-> open/);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: open/);
    assert.match(text, /: pulled from queue \(ready -> open\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("pull: needs-feedback -> needs-review, logs pulled-from-queue", () => {
  // Escalation to the human queue: feedback flow already routes ambiguous
  // signal there, so the demote target stays consistent (task 117 plan, step 2).
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "needs-feedback");
    const t = loadTask(root, "alpha", "001-a");
    pullFromQueue(t);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: needs-review/);
    assert.match(text, /: pulled from queue \(needs-feedback -> needs-review\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("pull: leaves allow_orchestrator: true alone when pulling a ready task back to open", () => {
  // Operators can keep autonomous opt-in across the open/ready bounce without
  // re-toggling — see Plan step 4.
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "open");
    const t0 = loadTask(root, "alpha", "001-a");
    ready(t0); // ready also sets allow_orchestrator: true
    const t1 = loadTask(root, "alpha", "001-a");
    pullFromQueue(t1);
    const text = readFileSync(t1.path, "utf8");
    const { data } = parse(text);
    assert.equal(data.status, "open");
    assert.equal(data.allow_orchestrator, true);
  } finally {
    rmTempDir(root);
  }
});

test("pull: refuses statuses outside ready / needs-feedback", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    for (const s of ["open", "in-progress", "needs-review", "needs-close", "blocked", "done", "dropped"]) {
      writeTask(dir, `001-${s}.md`, s);
      const t = loadTask(root, "alpha", `001-${s}`);
      assert.throws(() => pullFromQueue(t), /pull only applies to ready/, `expected refusal on ${s}`);
    }
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

// ---- addReport ------------------------------------------------------------

test("report: auto-folds file-form task, creates report.md inside task folder, logs, flips status", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const oldPath = writeTask(dir, "001-finding.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-finding");
    const r = addReport(t);
    assert.match(r.message, /created tasks\/001-finding\/report\.md/);
    assert.match(r.message, /folded task/);
    assert.match(r.message, /-> needs-review/);
    // File-form was folded: original path is gone, task.md exists in the folder.
    assert.equal(existsSync(oldPath), false);
    const newTaskPath = join(dir, "tasks", "001-finding", "task.md");
    assert.ok(existsSync(newTaskPath));
    const text = readFileSync(newTaskPath, "utf8");
    const { data } = parse(text);
    // No `report:` frontmatter — presence of report.md IS the report.
    assert.equal("report" in data, false);
    assert.match(text, /status: needs-review/);
    assert.match(text, /opened report tasks\/001-finding\/report\.md$/m);
    assert.match(text, /status -> needs-review \(report attached, awaiting review\)$/m);
    const reportPath = join(dir, "tasks", "001-finding", "report.md");
    assert.ok(existsSync(reportPath));
    const reportText = readFileSync(reportPath, "utf8");
    assert.match(reportText, /^# Task 001-finding$/m);
    assert.match(reportText, /## Summary/);
  } finally {
    rmTempDir(root);
  }
});

test("report: already-folder task creates report.md next to task.md (no extra fold)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const taskDir = join(dir, "tasks", "001-already-folded");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.md"), taskMd("001-already-folded", "in-progress", "investigation"));
    const t = loadTask(root, "alpha", "001-already-folded");
    const r = addReport(t);
    assert.match(r.message, /created tasks\/001-already-folded\/report\.md/);
    assert.doesNotMatch(r.message, /folded task/);
    assert.ok(existsSync(join(taskDir, "report.md")));
    assert.ok(existsSync(join(taskDir, "task.md")));
  } finally {
    rmTempDir(root);
  }
});

test("report: terminus line surfaces on the in-progress flip path", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    const r = addReport(t);
    assert.match(r.message, /Your turn is complete — exit/);
    assert.match(r.message, /LGTMs or requests changes/);
  } finally {
    rmTempDir(root);
  }
});

test("report: idempotent re-attach on already-flipped task — no extra log lines", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    addReport(t);
    const newTaskPath = join(dir, "tasks", "001-a", "task.md");
    const afterFirst = readFileSync(newTaskPath, "utf8");
    const t2 = loadTask(root, "alpha", "001-a");
    addReport(t2);
    assert.equal(readFileSync(newTaskPath, "utf8"), afterFirst);
    const flipCount = (afterFirst.match(/status -> needs-review/g) ?? []).length;
    assert.equal(flipCount, 1);
  } finally {
    rmTempDir(root);
  }
});

test("report: re-attach on needs-feedback (post-feedback round) re-fires the flip", () => {
  // After request-changes flips needs-review -> needs-feedback, the agent
  // re-attaches via `tpm report <slug>`. The folder + file are already
  // there so no creation log lines fire, but the status flip should still
  // happen when status is in-progress. Simulate: agent ran `tpm start`
  // (needs-feedback -> in-progress) before re-running `tpm report`.
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    addReport(t);
    // Reviewer requests changes — re-load and flip.
    const t2 = loadTask(root, "alpha", "001-a");
    requestReportChanges(t2, "needs more context");
    // Agent runs `tpm start` (needs-feedback -> in-progress) and re-attaches.
    const t3 = loadTask(root, "alpha", "001-a");
    start(t3);
    const t4 = loadTask(root, "alpha", "001-a");
    const r = addReport(t4);
    assert.match(r.message, /-> needs-review/);
    const newTaskPath = join(dir, "tasks", "001-a", "task.md");
    const text = readFileSync(newTaskPath, "utf8");
    assert.match(text, /status: needs-review/);
    const flipCount = (text.match(/status -> needs-review/g) ?? []).length;
    assert.equal(flipCount, 2);
  } finally {
    rmTempDir(root);
  }
});

test("report: non-in-progress status leaves status alone (e.g. ready)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    const r = addReport(t);
    assert.doesNotMatch(r.message, /needs-review/);
    const newTaskPath = join(dir, "tasks", "001-a", "task.md");
    const text = readFileSync(newTaskPath, "utf8");
    assert.match(text, /status: ready/);
    assert.doesNotMatch(text, /status -> needs-review/);
  } finally {
    rmTempDir(root);
  }
});

test("report: existing report.md is not overwritten", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    // Pre-create a folded task with an existing report.md.
    const taskDir = join(dir, "tasks", "001-a");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.md"), taskMd("001-a", "in-progress", "investigation"));
    const reportPath = join(taskDir, "report.md");
    writeFileSync(reportPath, "# pre-existing\n\nbody.\n");
    const t = loadTask(root, "alpha", "001-a");
    addReport(t);
    assert.equal(readFileSync(reportPath, "utf8"), "# pre-existing\n\nbody.\n");
  } finally {
    rmTempDir(root);
  }
});

test("report: refuses on child task (no per-task folder for children)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const parentDir = join(dir, "tasks", "001-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("001-parent", "ready", "investigation"));
    const childPath = join(parentDir, "002-child.md");
    writeFileSync(
      childPath,
      taskMd("002-child", "in-progress", "investigation").replace(
        "project: alpha",
        "project: alpha\nparent: 001-parent",
      ),
    );
    const [proj] = loadProjects(root, { archived: true }).filter(p => p.slug === "alpha");
    const parent = proj.tasks.find(t => t.slug === "001-parent")!;
    const child = parent.children!.find(c => c.slug === "002-child")!;
    assert.throws(() => addReport(child), /child tasks can't have own reports/);
    // No reports/ dir created, no fold attempted.
    assert.equal(existsSync(join(dir, "reports")), false);
  } finally {
    rmTempDir(root);
  }
});

test("report: refuses on archived task", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const archivePath = join(dir, "tasks", "archive");
    mkdirSync(archivePath, { recursive: true });
    writeFileSync(join(archivePath, "001-a.md"), taskMd("001-a", "done", "investigation"));
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => addReport(t), /Cannot mutate archived task/);
  } finally {
    rmTempDir(root);
  }
});

// ---- requestReportChanges -------------------------------------------------

test("requestReportChanges: flips needs-review -> needs-feedback, appends ## Reviewer feedback, logs", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    addReport(t);
    // Status is now needs-review.
    const t2 = loadTask(root, "alpha", "001-a");
    const r = requestReportChanges(t2, "missing context on commit X");
    assert.match(r.message, /review requested.*-> needs-feedback/);
    const newTaskPath = join(dir, "tasks", "001-a", "task.md");
    const text = readFileSync(newTaskPath, "utf8");
    assert.match(text, /status: needs-feedback/);
    assert.match(text, /: review requested — missing context on commit X$/m);
    assert.match(text, /status -> needs-feedback \(review requested\)$/m);
    const reportText = readFileSync(join(dir, "tasks", "001-a", "report.md"), "utf8");
    assert.match(reportText, /## Reviewer feedback/);
    assert.match(reportText, /missing context on commit X/);
  } finally {
    rmTempDir(root);
  }
});

test("requestReportChanges: multiple rounds accumulate under one ## Reviewer feedback heading", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    addReport(t);
    requestReportChanges(loadTask(root, "alpha", "001-a"), "round 1 feedback");
    // Agent re-attaches: needs-feedback -> in-progress (via start) -> needs-review.
    start(loadTask(root, "alpha", "001-a"));
    addReport(loadTask(root, "alpha", "001-a"));
    // Second round of changes.
    requestReportChanges(loadTask(root, "alpha", "001-a"), "round 2 feedback");
    const reportText = readFileSync(join(dir, "tasks", "001-a", "report.md"), "utf8");
    // Exactly one heading; both comments present in chronological order.
    const headings = (reportText.match(/^## Reviewer feedback/gm) ?? []).length;
    assert.equal(headings, 1);
    const idx1 = reportText.indexOf("round 1 feedback");
    const idx2 = reportText.indexOf("round 2 feedback");
    assert.ok(idx1 > 0 && idx2 > idx1);
  } finally {
    rmTempDir(root);
  }
});

test("requestReportChanges: refuses when no report attached", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "needs-review", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => requestReportChanges(t, "..."), /no report attached/);
  } finally {
    rmTempDir(root);
  }
});

test("requestReportChanges: refuses when status is not needs-review", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    addReport(t);
    // Manually flip to in-progress to simulate an out-of-band state.
    start(loadTask(root, "alpha", "001-a"));
    const t2 = loadTask(root, "alpha", "001-a");
    assert.throws(() => requestReportChanges(t2, "..."), /requires status=needs-review/);
  } finally {
    rmTempDir(root);
  }
});

test("requestReportChanges: refuses on empty/whitespace comment", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress", "investigation");
    const t = loadTask(root, "alpha", "001-a");
    addReport(t);
    const t2 = loadTask(root, "alpha", "001-a");
    assert.throws(() => requestReportChanges(t2, "   "), /requires a comment/);
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

test("status: custom verb overrides the generic 'status -> X' Log line (orchestrator spawn-failure path)", () => {
  // Per task 108: when the agent binary can't be spawned, the orchestrator
  // rolls the eager flip back via setStatus with a verb that names the failed
  // claim. Without the verb param this would write a useless "status -> ready"
  // line and the actual failure detail would have to go in a separate logEntry
  // write. The verb param folds both into one atomic Log entry.
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    setStatus(t, "ready", "claim failed: agent spawn failed (exit 127, bin=/nope/claude); reverted to ready");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: ready/);
    assert.match(text, /: claim failed: agent spawn failed \(exit 127, bin=\/nope\/claude\); reverted to ready$/m);
    // Without an explicit verb override the generic line would appear; assert
    // it doesn't slip through when the override is set.
    assert.doesNotMatch(text, /: status -> ready$/m);
  } finally {
    rmTempDir(root);
  }
});

test("status: omitted verb still writes the generic 'status -> X' Log line (default path)", () => {
  // The verb param is optional and back-compat — `tpm status` and `tpm poll`
  // both call setStatus without a verb and expect the generic line.
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "ready");
    const t = loadTask(root, "alpha", "001-a");
    setStatus(t, "in-progress");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /status: in-progress/);
    assert.match(text, /: status -> in-progress$/m);
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

test("reparent: folder-form top-level -> child unfolds when task.md is the sole occupant", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const folder = join(dir, "tasks", "001-foldy");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "task.md"), taskMd("001-foldy"));
    writeTask(dir, "002-target.md");
    const foldy = loadTask(root, "alpha", "001-foldy");
    const target = loadTask(root, "alpha", "002-target");
    const r = reparent(foldy, target);
    // Unfolded: task.md became a flat child file inside target's (now folded) folder.
    assert.equal(r.newSlug, "001-foldy");
    assert.equal(r.newPath, join(dir, "tasks", "002-target", "001-foldy.md"));
    assert.ok(existsSync(r.newPath));
    // The source folder is gone wholesale.
    assert.ok(!existsSync(folder));
    const { data } = parse(readFileSync(r.newPath, "utf8"));
    assert.equal(data.parent, "002-target");
  } finally {
    rmTempDir(root);
  }
});

test("reparent: refuses folder-form top-level -> child when the folder has supporting files", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const folder = join(dir, "tasks", "001-foldy");
    mkdirSync(join(folder, "runs"), { recursive: true });
    writeFileSync(join(folder, "task.md"), taskMd("001-foldy"));
    writeFileSync(join(folder, "runs", "20260101T000000Z.log"), "log");
    writeTask(dir, "002-target.md");
    const foldy = loadTask(root, "alpha", "001-foldy");
    const target = loadTask(root, "alpha", "002-target");
    assert.throws(() => reparent(foldy, target), /supporting files/);
    // Nothing moved: task.md and its runs/ are intact, target untouched.
    assert.ok(existsSync(join(folder, "task.md")));
    assert.ok(existsSync(join(folder, "runs", "20260101T000000Z.log")));
    assert.ok(existsSync(join(dir, "tasks", "002-target.md")));
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

// ---- editTaskSection (inline-editor write path for tpm serve) -------------

test("editTaskSection: title rewrites frontmatter title, preserves key order + body", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const r = editTaskSection(t, "title", "New Title — with punctuation");
    assert.match(r.message, /edited title/);
    const text = readFileSync(t.path, "utf8");
    // title still appears as the first frontmatter key.
    assert.match(text, /^---\ntitle: /);
    const { data, body } = parse(text);
    assert.equal(data.title, "New Title — with punctuation");
    // Sibling sections in the body are untouched.
    assert.match(body, /## Context\nsome context/);
    assert.match(body, /## Plan\n1\. do the thing/);
    // Log line written.
    assert.match(body, /: edited title \(via serve\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: title no-op when value unchanged (no write, no Log line)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const before = readFileSync(t.path, "utf8");
    const beforeMtime = statSync(t.path).mtimeMs;
    const r = editTaskSection(t, "title", "Task 001-a");
    assert.match(r.message, /title unchanged/);
    assert.equal(readFileSync(t.path, "utf8"), before);
    assert.equal(statSync(t.path).mtimeMs, beforeMtime);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: Context rewrites named body section, preserves siblings + Log", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const r = editTaskSection(t, "Context", "Reframed context with three lines.\nLine two.\nLine three.");
    assert.match(r.message, /edited Context/);
    const text = readFileSync(t.path, "utf8");
    const { data, body } = parse(text);
    // Frontmatter intact.
    assert.equal(data.title, "Task 001-a");
    assert.equal(data.status, "in-progress");
    // Context replaced.
    assert.match(body, /## Context\nReframed context with three lines\.\nLine two\.\nLine three\.\n\n## Plan/);
    // Plan and Log unchanged.
    assert.match(body, /## Plan\n1\. do the thing\n\n## Log/);
    assert.match(body, /- 2026-01-01 00:00 PDT: created/);
    // Log line for the edit appended.
    assert.match(body, /: edited Context \(via serve\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: lowercase section names canonicalize to the on-disk heading", () => {
  // Serve form passes section=context | plan | outcome (lowercase); helper
  // maps to the canonical heading so log lines and setSection() find the
  // right slot.
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    editTaskSection(t, "plan", "Step A\nStep B");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /## Plan\nStep A\nStep B\n\n## Log/);
    assert.match(text, /: edited Plan \(via serve\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: Outcome rewrites the outcome section without touching Log", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    editTaskSection(t, "Outcome", "Shipped via PR #42.");
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /## Outcome\nShipped via PR #42\./);
    // Log header still intact (no orphaned content, no comment placeholder).
    assert.match(text, /## Log\n- 2026-01-01 00:00 PDT: created\n- .*: edited Outcome \(via serve\)/);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: byte-identical section value is a no-op (no write, no Log line)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const before = readFileSync(t.path, "utf8");
    const beforeMtime = statSync(t.path).mtimeMs;
    const r = editTaskSection(t, "Context", "some context");
    assert.match(r.message, /Context unchanged/);
    assert.equal(readFileSync(t.path, "utf8"), before);
    assert.equal(statSync(t.path).mtimeMs, beforeMtime);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: refuses on archived tasks (guardArchived)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "done");
    const t = loadTask(root, "alpha", "001-a");
    t.archived = true;
    assert.throws(() => editTaskSection(t, "Context", "anything"), /Cannot mutate archived task/);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: refuses on mtime mismatch (concurrent edit detected)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const renderTimeMtime = statSync(t.path).mtimeMs;
    // Simulate a concurrent write between page render and form save: a log
    // line lands, bumping the mtime by ~2s.
    utimesSync(t.path, new Date(), new Date(renderTimeMtime + 2000));
    assert.throws(
      () => editTaskSection(t, "Context", "doesn't matter", { expectMtimeMs: renderTimeMtime }),
      /file changed since the editor was loaded/,
    );
    // File body untouched by the refused save.
    const { body } = parse(readFileSync(t.path, "utf8"));
    assert.match(body, /## Context\nsome context/);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: accepts a matching mtime (no-op concurrency check on a fresh form)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const mtimeMs = statSync(t.path).mtimeMs;
    const r = editTaskSection(t, "Plan", "Step 1\nStep 2", { expectMtimeMs: mtimeMs });
    assert.match(r.message, /edited Plan/);
    const text = readFileSync(t.path, "utf8");
    assert.match(text, /## Plan\nStep 1\nStep 2/);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: refuses an unknown section name", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    assert.throws(() => editTaskSection(t, "Log", "rewritten"), /Unknown editable section/);
    assert.throws(() => editTaskSection(t, "status", "ready"), /Unknown editable section/);
  } finally {
    rmTempDir(root);
  }
});

test("editTaskSection: title with colons / em-dash round-trips through stringify+parse", () => {
  // Real tpm titles commonly carry colons and em-dashes ("tpm serve: inline
  // editor — task body sections"). These chars are inside the formatScalar
  // safe-set and should land in the file unquoted but parse back identically.
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    const t = loadTask(root, "alpha", "001-a");
    const realistic = "tpm serve: inline editor for title and body sections";
    editTaskSection(t, "title", realistic);
    const { data } = parse(readFileSync(t.path, "utf8"));
    assert.equal(data.title, realistic);
  } finally {
    rmTempDir(root);
  }
});
