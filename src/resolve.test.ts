import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { loadProjects } from "./tree.ts";
import { findTask } from "./resolve.ts";

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

function taskMd(slug: string, parent?: string): string {
  const p = parent ? `parent: ${parent}\n` : "";
  return `---
title: Task ${slug}
slug: ${slug}
project: x
${p}status: open
type: pr
created: 2026-01-01 00:00 PDT
closed:
prs: []
tags: []
---

# Task ${slug}
`;
}

function setupProject(root: string, slug: string): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "project.md"), projectMd(slug));
  return dir;
}

test("findTask: bare slug resolves uniquely", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFileSync(join(dir, "tasks", "001-foo.md"), taskMd("001-foo"));
    const projects = loadProjects(root);
    const m = findTask(projects, "foo");
    assert.ok(m);
    assert.equal(m!.task.slug, "001-foo");
  } finally {
    rmTempDir(root);
  }
});

test("findTask: bare slug ambiguous across projects throws", () => {
  const root = mkTempDir();
  try {
    const a = setupProject(root, "alpha");
    const b = setupProject(root, "beta");
    writeFileSync(join(a, "tasks", "001-foo.md"), taskMd("001-foo"));
    writeFileSync(join(b, "tasks", "001-foo.md"), taskMd("001-foo"));
    const projects = loadProjects(root);
    assert.throws(() => findTask(projects, "foo"), /Ambiguous task/);
  } finally {
    rmTempDir(root);
  }
});

test("findTask: <parent>/<child> resolves a child", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const parentDir = join(dir, "tasks", "002-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("002-parent"));
    writeFileSync(join(parentDir, "001-child.md"), taskMd("001-child", "002-parent"));
    const projects = loadProjects(root);
    const m = findTask(projects, "parent/child");
    assert.ok(m);
    assert.equal(m!.task.slug, "001-child");
    assert.equal(m!.task.parent, "002-parent");
  } finally {
    rmTempDir(root);
  }
});

test("findTask: <project>/<parent>/<child> resolves a child", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const parentDir = join(dir, "tasks", "002-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), taskMd("002-parent"));
    writeFileSync(join(parentDir, "001-child.md"), taskMd("001-child", "002-parent"));
    const projects = loadProjects(root);
    const m = findTask(projects, "alpha/parent/child");
    assert.ok(m);
    assert.equal(m!.task.slug, "001-child");
  } finally {
    rmTempDir(root);
  }
});

test("findTask: bare child slug clashing across two parents throws", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    for (const parentName of ["002-a", "003-b"]) {
      const pdir = join(dir, "tasks", parentName);
      mkdirSync(pdir, { recursive: true });
      writeFileSync(join(pdir, "task.md"), taskMd(parentName));
      writeFileSync(join(pdir, "001-discuss.md"), taskMd("001-discuss", parentName));
    }
    const projects = loadProjects(root);
    assert.throws(() => findTask(projects, "discuss"), /Ambiguous task/);
  } finally {
    rmTempDir(root);
  }
});

test("findTask: <project>/<task> still resolves a top-level task", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFileSync(join(dir, "tasks", "001-foo.md"), taskMd("001-foo"));
    const projects = loadProjects(root);
    const m = findTask(projects, "alpha/foo");
    assert.ok(m);
    assert.equal(m!.task.slug, "001-foo");
  } finally {
    rmTempDir(root);
  }
});
