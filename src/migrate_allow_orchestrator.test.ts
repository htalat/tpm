import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { migrateAllowOrchestratorOnReady } from "./migrate_allow_orchestrator.ts";
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

// allow: undefined → omit the field entirely; true/false → emit it.
function taskMd(slug: string, status: string, allow?: boolean, parent?: string): string {
  const parentLine = parent ? `parent: ${parent}\n` : "";
  const allowLine = allow === undefined ? "" : `allow_orchestrator: ${allow}\n`;
  return `---
title: Task ${slug}
slug: ${slug}
project: alpha
${parentLine}status: ${status}
type: pr
created: 2026-01-01 00:00 PDT
closed:
prs: []
tags: []
${allowLine}---

# Task ${slug}

## Context
ctx

## Plan
1. do

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

function writeTask(projectDir: string, file: string, status: string, allow?: boolean): string {
  const slug = file.replace(/\.md$/, "");
  const path = join(projectDir, "tasks", file);
  writeFileSync(path, taskMd(slug, status, allow));
  return path;
}

test("migrate: sets allow_orchestrator: true on a live ready task missing the field, logs migration line", () => {
  const root = mkTempDir("tpm-migrate-allow-");
  try {
    const dir = setupProject(root, "alpha");
    const path = writeTask(dir, "001-a.md", "ready");
    const result = migrateAllowOrchestratorOnReady(root);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].slug, "001-a");
    const text = readFileSync(path, "utf8");
    const { data } = parse(text);
    assert.equal(data.allow_orchestrator, true);
    assert.match(text, /allow_orchestrator: true \(migration: set on ready\)$/m);
  } finally {
    rmTempDir(root);
  }
});

test("migrate: flips an explicit allow_orchestrator: false on a ready task to true", () => {
  const root = mkTempDir("tpm-migrate-allow-");
  try {
    const dir = setupProject(root, "alpha");
    const path = writeTask(dir, "001-a.md", "ready", false);
    const result = migrateAllowOrchestratorOnReady(root);
    assert.equal(result.steps.length, 1);
    const { data } = parse(readFileSync(path, "utf8"));
    assert.equal(data.allow_orchestrator, true);
  } finally {
    rmTempDir(root);
  }
});

test("migrate: a ready task already allow_orchestrator: true is untouched (no step, byte-identical)", () => {
  const root = mkTempDir("tpm-migrate-allow-");
  try {
    const dir = setupProject(root, "alpha");
    const path = writeTask(dir, "001-a.md", "ready", true);
    const before = readFileSync(path, "utf8");
    const result = migrateAllowOrchestratorOnReady(root);
    assert.equal(result.steps.length, 0);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmTempDir(root);
  }
});

test("migrate: ignores non-ready statuses (open, in-progress, done)", () => {
  const root = mkTempDir("tpm-migrate-allow-");
  try {
    const dir = setupProject(root, "alpha");
    const open = writeTask(dir, "001-open.md", "open");
    const inProg = writeTask(dir, "002-inprog.md", "in-progress");
    const done = writeTask(dir, "003-done.md", "done");
    const result = migrateAllowOrchestratorOnReady(root);
    assert.equal(result.steps.length, 0);
    for (const p of [open, inProg, done]) {
      assert.equal("allow_orchestrator" in parse(readFileSync(p, "utf8")).data, false);
    }
  } finally {
    rmTempDir(root);
  }
});

test("migrate: skips archived ready tasks (live tree only)", () => {
  const root = mkTempDir("tpm-migrate-allow-");
  try {
    const dir = setupProject(root, "alpha");
    const archive = join(dir, "tasks", "archive");
    mkdirSync(archive, { recursive: true });
    const archivedPath = join(archive, "001-old.md");
    writeFileSync(archivedPath, taskMd("001-old", "ready"));
    const result = migrateAllowOrchestratorOnReady(root);
    assert.equal(result.steps.length, 0);
    assert.equal("allow_orchestrator" in parse(readFileSync(archivedPath, "utf8")).data, false);
  } finally {
    rmTempDir(root);
  }
});

test("migrate: skips a parent container at status ready but migrates its ready child", () => {
  const root = mkTempDir("tpm-migrate-allow-");
  try {
    const dir = setupProject(root, "alpha");
    const parentDir = join(dir, "tasks", "001-parent");
    mkdirSync(parentDir, { recursive: true });
    const parentPath = join(parentDir, "task.md");
    const childPath = join(parentDir, "002-child.md");
    writeFileSync(parentPath, taskMd("001-parent", "ready"));
    writeFileSync(childPath, taskMd("002-child", "ready", undefined, "001-parent"));
    const result = migrateAllowOrchestratorOnReady(root);
    // Only the child is migrated; the parent container is skipped.
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].slug, "002-child");
    assert.equal("allow_orchestrator" in parse(readFileSync(parentPath, "utf8")).data, false);
    assert.equal(parse(readFileSync(childPath, "utf8")).data.allow_orchestrator, true);
  } finally {
    rmTempDir(root);
  }
});

test("migrate: re-running is a clean no-op", () => {
  const root = mkTempDir("tpm-migrate-allow-");
  try {
    const dir = setupProject(root, "alpha");
    const path = writeTask(dir, "001-a.md", "ready");
    migrateAllowOrchestratorOnReady(root);
    const afterFirst = readFileSync(path, "utf8");
    const result2 = migrateAllowOrchestratorOnReady(root);
    assert.equal(result2.steps.length, 0);
    assert.equal(readFileSync(path, "utf8"), afterFirst);
  } finally {
    rmTempDir(root);
  }
});

test("migrate: empty/missing tree is a no-op", () => {
  const root = mkTempDir("tpm-migrate-allow-");
  try {
    const result = migrateAllowOrchestratorOnReady(root);
    assert.equal(result.steps.length, 0);
    assert.equal(result.warnings.length, 0);
  } finally {
    rmTempDir(root);
  }
});
