import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { loadProjects } from "./tree.ts";
import {
  start, ready, block, reopen, logEntry, addPr, setStatus, complete,
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
    const r = addPr(t, "https://github.com/x/y/pull/1");
    assert.match(r.message, /already linked/);
    assert.equal(readFileSync(t.path, "utf8"), before);
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
