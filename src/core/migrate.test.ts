import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateTree } from "./migrate.ts";

function taskMd(slug: string, status: string, withLog = true): string {
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
ctx
${withLog ? "\n## Log\n- 2026-01-01 00:00 PDT: created\n" : ""}
## Outcome
<!-- -->
`;
}

function setup(root: string): string {
  const dir = join(root, "alpha", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "alpha", "project.md"), `---
name: alpha
slug: alpha
status: active
created: 2026-01-01 00:00 PDT
tags: []
---

# alpha

## Goal
g
`);
  return dir;
}

test("migrateTree: rewrites old statuses (live + archived), logs, idempotent; dry-run previews", () => {
  const root = mkTempDir();
  try {
    const dir = setup(root);
    writeFileSync(join(dir, "001-a.md"), taskMd("001-a", "needs-feedback"));
    writeFileSync(join(dir, "002-b.md"), taskMd("002-b", "needs-review"));
    writeFileSync(join(dir, "003-c.md"), taskMd("003-c", "ready"));
    mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(join(dir, "archive", "004-d.md"), taskMd("004-d", "needs-close"));

    const dry = migrateTree(root, { dryRun: true });
    assert.equal(dry.changes.length, 3);
    assert.match(readFileSync(join(dir, "001-a.md"), "utf8"), /status: needs-feedback/, "dry-run must not write");

    const real = migrateTree(root);
    assert.equal(real.scanned, 4);
    assert.deepEqual(
      real.changes.map(c => `${c.from}->${c.to}`).sort(),
      ["needs-close->closing", "needs-feedback->rework", "needs-review->review"],
    );
    const a = readFileSync(join(dir, "001-a.md"), "utf8");
    assert.match(a, /status: rework/);
    assert.match(a, /status migrated needs-feedback -> rework \(vocabulary rename\)/);
    assert.match(readFileSync(join(dir, "002-b.md"), "utf8"), /status: review/);
    assert.match(readFileSync(join(dir, "003-c.md"), "utf8"), /status: ready/);
    assert.match(readFileSync(join(dir, "archive", "004-d.md"), "utf8"), /status: closing/);

    const again = migrateTree(root);
    assert.equal(again.changes.length, 0, "second run is a no-op");
  } finally {
    rmTempDir(root);
  }
});

test("migrateTree: a body without ## Log still gets the status rewrite (no throw, no audit line)", () => {
  const root = mkTempDir();
  try {
    const dir = setup(root);
    writeFileSync(join(dir, "001-a.md"), taskMd("001-a", "needs-review", false));
    const r = migrateTree(root);
    assert.equal(r.changes.length, 1);
    const text = readFileSync(join(dir, "001-a.md"), "utf8");
    assert.match(text, /status: review/);
    assert.doesNotMatch(text, /status migrated/);
  } finally {
    rmTempDir(root);
  }
});
