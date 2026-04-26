import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { loadProjects, archiveTask } from "./tree.ts";

function projectMd(slug: string, name = slug): string {
  return `---
name: ${name}
slug: ${slug}
status: active
created: 2026-01-01 00:00 PDT
tags: []
---

# ${name}

## Goal
test
`;
}

function taskMd(slug: string, status = "open"): string {
  return `---
title: Task ${slug}
slug: ${slug}
project: x
status: ${status}
type: pr
created: 2026-01-01 00:00 PDT
closed:
prs: []
tags: []
---

# Task ${slug}

## Context
stuff
`;
}

function setupProject(root: string, slug: string): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "project.md"), projectMd(slug));
  return dir;
}

function writeTask(projectDir: string, file: string, status = "open"): string {
  const slug = file.replace(/\.md$/, "");
  const path = join(projectDir, "tasks", file);
  writeFileSync(path, taskMd(slug, status));
  return path;
}

function writeArchivedTask(projectDir: string, file: string): string {
  const archive = join(projectDir, "tasks", "archive");
  mkdirSync(archive, { recursive: true });
  const slug = file.replace(/\.md$/, "");
  const path = join(archive, file);
  writeFileSync(path, taskMd(slug, "done"));
  return path;
}

test("loadProjects: returns [] for missing root", () => {
  const projects = loadProjects("/no/such/path/here");
  assert.deepEqual(projects, []);
});

test("loadProjects: skips reserved dirs, dotfiles, and dirs without project.md", () => {
  const root = mkTempDir();
  try {
    setupProject(root, "alpha");
    setupProject(root, "beta");
    // reserved
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, "reports", "project.md"), projectMd("reports"));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "project.md"), projectMd("node_modules"));
    // dotfile
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, ".hidden", "project.md"), projectMd("hidden"));
    // dir without project.md
    mkdirSync(join(root, "stray"), { recursive: true });

    const projects = loadProjects(root);
    assert.deepEqual(projects.map(p => p.slug), ["alpha", "beta"]);
  } finally {
    rmTempDir(root);
  }
});

test("loadProjects: parses project frontmatter and body", () => {
  const root = mkTempDir();
  try {
    setupProject(root, "alpha", "Alpha");
    const [proj] = loadProjects(root);
    assert.equal(proj.slug, "alpha");
    assert.equal(proj.data.name, "alpha");
    assert.equal(proj.data.status, "active");
    assert.match(proj.body, /## Goal/);
  } finally {
    rmTempDir(root);
  }
});

test("loadTasks: ignores archive by default", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-one.md");
    writeArchivedTask(dir, "002-two.md");
    const [proj] = loadProjects(root);
    assert.deepEqual(proj.tasks.map(t => t.slug), ["001-one"]);
    assert.equal(proj.tasks[0].archived, false);
  } finally {
    rmTempDir(root);
  }
});

test("loadTasks: with archived=true merges archive and sorts the union", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "003-three.md");
    writeTask(dir, "001-one.md");
    writeArchivedTask(dir, "002-two.md");
    const [proj] = loadProjects(root, { archived: true });
    assert.deepEqual(proj.tasks.map(t => t.slug), ["001-one", "002-two", "003-three"]);
    assert.deepEqual(proj.tasks.map(t => t.archived), [false, true, false]);
  } finally {
    rmTempDir(root);
  }
});

test("loadTasks: skips dotfile .md and non-.md files", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-one.md");
    writeFileSync(join(dir, "tasks", ".hidden.md"), taskMd("hidden"));
    writeFileSync(join(dir, "tasks", "notes.txt"), "not a task");
    const [proj] = loadProjects(root);
    assert.deepEqual(proj.tasks.map(t => t.slug), ["001-one"]);
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: rejects open tasks", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-one.md", "open");
    const [proj] = loadProjects(root);
    assert.throws(() => archiveTask(proj.tasks[0]), /Only done or dropped/);
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: rejects in-progress and blocked tasks", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-a.md", "in-progress");
    writeTask(dir, "002-b.md", "blocked");
    const [proj] = loadProjects(root);
    for (const task of proj.tasks) {
      assert.throws(() => archiveTask(task), /Only done or dropped/);
    }
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: moves done task into archive/ and removes from tasks/", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-one.md", "done");
    const [proj] = loadProjects(root);
    const dest = archiveTask(proj.tasks[0]);
    assert.equal(dest, join(dir, "tasks", "archive", "001-one.md"));
    assert.ok(existsSync(dest));
    assert.ok(!existsSync(join(dir, "tasks", "001-one.md")));
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: archives dropped tasks too", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-d.md", "dropped");
    const [proj] = loadProjects(root);
    const dest = archiveTask(proj.tasks[0]);
    assert.ok(existsSync(dest));
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: refuses to overwrite an existing archive entry", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-one.md", "done");
    writeArchivedTask(dir, "001-one.md");
    const [proj] = loadProjects(root, { archived: true });
    // Pick the live (non-archived) duplicate to attempt the move.
    const live = proj.tasks.find(t => !t.archived)!;
    assert.throws(() => archiveTask(live), /Archived task already exists/);
    // Live file is still there since the move was refused.
    assert.ok(existsSync(join(dir, "tasks", "001-one.md")));
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: idempotent on already-archived input (returns its path)", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeArchivedTask(dir, "001-one.md");
    const [proj] = loadProjects(root, { archived: true });
    const archivedTask = proj.tasks.find(t => t.archived)!;
    const result = archiveTask(archivedTask);
    assert.equal(result, archivedTask.path);
  } finally {
    rmTempDir(root);
  }
});
