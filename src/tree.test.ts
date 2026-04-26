import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { loadProjects, archiveTask, foldTask, flatTasks, isParent } from "./tree.ts";

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

function taskMd(slug: string, status = "open", parent?: string): string {
  const parentLine = parent ? `parent: ${parent}\n` : "";
  return `---
title: Task ${slug}
slug: ${slug}
project: x
${parentLine}status: ${status}
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

function writeFolderTask(projectDir: string, slug: string, status = "open"): string {
  const dir = join(projectDir, "tasks", slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "task.md");
  writeFileSync(path, taskMd(slug, status));
  return path;
}

function writeChildTask(projectDir: string, parentSlug: string, file: string, status = "open"): string {
  const parentDir = join(projectDir, "tasks", parentSlug);
  mkdirSync(parentDir, { recursive: true });
  const slug = file.replace(/\.md$/, "");
  const path = join(parentDir, file);
  writeFileSync(path, taskMd(slug, status, parentSlug));
  return path;
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

test("loadTasks: folder-form parent loads task.md and children with parent: set", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFolderTask(dir, "002-parent");
    writeChildTask(dir, "002-parent", "001-first.md");
    writeChildTask(dir, "002-parent", "002-second.md");
    const [proj] = loadProjects(root);
    assert.equal(proj.tasks.length, 1);
    const parent = proj.tasks[0];
    assert.equal(parent.slug, "002-parent");
    assert.equal(parent.dir, join(dir, "tasks", "002-parent"));
    assert.equal(parent.children?.length, 2);
    assert.deepEqual(parent.children!.map(c => c.slug), ["001-first", "002-second"]);
    assert.deepEqual(parent.children!.map(c => c.parent), ["002-parent", "002-parent"]);
  } finally {
    rmTempDir(root);
  }
});

test("loadTasks: folder without task.md is skipped", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    mkdirSync(join(dir, "tasks", "stray"), { recursive: true });
    writeFileSync(join(dir, "tasks", "stray", "notes.md"), "free-form");
    writeTask(dir, "001-one.md");
    const [proj] = loadProjects(root);
    assert.deepEqual(proj.tasks.map(t => t.slug), ["001-one"]);
  } finally {
    rmTempDir(root);
  }
});

test("loadTasks: archived parent (folder under archive/) loads with archived children", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const archived = join(dir, "tasks", "archive", "003-old-parent");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "task.md"), taskMd("003-old-parent", "done"));
    writeFileSync(join(archived, "001-a.md"), taskMd("001-a", "done", "003-old-parent"));
    const [proj] = loadProjects(root, { archived: true });
    assert.equal(proj.tasks.length, 1);
    const parent = proj.tasks[0];
    assert.equal(parent.archived, true);
    assert.equal(parent.children?.length, 1);
    assert.equal(parent.children![0].archived, true);
    assert.equal(parent.children![0].slug, "001-a");
  } finally {
    rmTempDir(root);
  }
});

test("loadTasks: archived child of live parent attaches to live parent's children", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFolderTask(dir, "004-live-parent");
    writeChildTask(dir, "004-live-parent", "001-still-here.md");
    const archChildDir = join(dir, "tasks", "archive", "004-live-parent");
    mkdirSync(archChildDir, { recursive: true });
    writeFileSync(join(archChildDir, "002-shipped.md"), taskMd("002-shipped", "done", "004-live-parent"));
    const [proj] = loadProjects(root, { archived: true });
    assert.equal(proj.tasks.length, 1);
    const parent = proj.tasks[0];
    assert.equal(parent.archived, false);
    assert.equal(parent.children?.length, 2);
    assert.deepEqual(parent.children!.map(c => c.slug), ["001-still-here", "002-shipped"]);
    assert.deepEqual(parent.children!.map(c => c.archived), [false, true]);
  } finally {
    rmTempDir(root);
  }
});

test("flatTasks: includes top-level + children", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-flat.md");
    writeFolderTask(dir, "002-parent");
    writeChildTask(dir, "002-parent", "001-c.md");
    writeChildTask(dir, "002-parent", "002-d.md");
    const [proj] = loadProjects(root);
    const slugs = flatTasks(proj.tasks).map(t => t.slug);
    assert.deepEqual(slugs, ["001-flat", "002-parent", "001-c", "002-d"]);
  } finally {
    rmTempDir(root);
  }
});

test("isParent: true only when children non-empty", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-leaf.md");
    writeFolderTask(dir, "002-parent");
    writeChildTask(dir, "002-parent", "001-c.md");
    writeFolderTask(dir, "003-empty-folder");
    const [proj] = loadProjects(root);
    const byslug = Object.fromEntries(proj.tasks.map(t => [t.slug, t]));
    assert.equal(isParent(byslug["001-leaf"]), false);
    assert.equal(isParent(byslug["002-parent"]), true);
    assert.equal(isParent(byslug["003-empty-folder"]), false);
  } finally {
    rmTempDir(root);
  }
});

test("foldTask: file-form -> folder-form, idempotent on folded", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeTask(dir, "001-flat.md");
    const [proj] = loadProjects(root);
    const newPath = foldTask(proj.tasks[0]);
    assert.equal(newPath, join(dir, "tasks", "001-flat", "task.md"));
    assert.ok(existsSync(newPath));
    assert.ok(!existsSync(join(dir, "tasks", "001-flat.md")));
    assert.ok(statSync(join(dir, "tasks", "001-flat")).isDirectory());

    // Idempotent: loading again and folding returns the existing path.
    const [proj2] = loadProjects(root);
    assert.equal(foldTask(proj2.tasks[0]), newPath);
  } finally {
    rmTempDir(root);
  }
});

test("foldTask: rejects child task", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFolderTask(dir, "002-parent");
    writeChildTask(dir, "002-parent", "001-c.md");
    const [proj] = loadProjects(root);
    const child = proj.tasks[0].children![0];
    assert.throws(() => foldTask(child), /Cannot fold a child task/);
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: folder-form parent (no live children) -> moves whole folder", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFolderTask(dir, "002-parent", "done");
    const [proj] = loadProjects(root);
    const dest = archiveTask(proj.tasks[0]);
    assert.equal(dest, join(dir, "tasks", "archive", "002-parent", "task.md"));
    assert.ok(existsSync(dest));
    assert.ok(!existsSync(join(dir, "tasks", "002-parent")));
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: refuses parent with live children", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFolderTask(dir, "002-parent", "done");
    writeChildTask(dir, "002-parent", "001-still-open.md", "open");
    const [proj] = loadProjects(root);
    assert.throws(() => archiveTask(proj.tasks[0]), /has live children/);
  } finally {
    rmTempDir(root);
  }
});

test("archiveTask: child -> moves to tasks/archive/<parent>/<child>.md", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFolderTask(dir, "002-parent");
    writeChildTask(dir, "002-parent", "001-shipped.md", "done");
    const [proj] = loadProjects(root);
    const child = proj.tasks[0].children![0];
    const dest = archiveTask(child);
    assert.equal(dest, join(dir, "tasks", "archive", "002-parent", "001-shipped.md"));
    assert.ok(existsSync(dest));
    assert.ok(!existsSync(join(dir, "tasks", "002-parent", "001-shipped.md")));
    // Live parent dir is still around.
    assert.ok(statSync(join(dir, "tasks", "002-parent")).isDirectory());
  } finally {
    rmTempDir(root);
  }
});
