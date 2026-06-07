import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir, TEMP_HOME } from "./_test_helpers.ts";
import { migrateRunsToTaskFolders } from "./migrate_runs.ts";

// `legacyRunsDir()` reads from CONFIG_DIR which is anchored at HOME
// (re-pointed at TEMP_HOME by `_test_helpers`). Each test cleans the legacy
// dir at the top so the shared HOME stays isolated.

function legacyDir(): string {
  return join(TEMP_HOME, ".tpm", "runs");
}

function resetLegacyDir(): void {
  rmSync(legacyDir(), { recursive: true, force: true });
}

function projectMd(slug: string): string {
  return `---\nslug: ${slug}\nstatus: active\n---\n\n# ${slug}\n`;
}

function taskMd(slug: string, status = "ready"): string {
  return `---\nslug: ${slug}\nstatus: ${status}\n---\n\n# ${slug}\n`;
}

function childTaskMd(slug: string, parent: string, status = "ready"): string {
  return `---\nslug: ${slug}\nstatus: ${status}\nparent: ${parent}\n---\n\n# ${slug}\n`;
}

function setupTree(root: string, project: string): string {
  const projectDir = join(root, project);
  mkdirSync(join(projectDir, "tasks"), { recursive: true });
  writeFileSync(join(projectDir, "project.md"), projectMd(project));
  return projectDir;
}

function writeLegacyRun(encoded: string, ts: string, contents: string): string {
  mkdirSync(legacyDir(), { recursive: true });
  const p = join(legacyDir(), `${encoded}--${ts}.log`);
  writeFileSync(p, contents);
  return p;
}

test("migrateRunsToTaskFolders: top-level folder-form task — moves <utc>.log into the task folder", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    const projectDir = setupTree(tmp, "alpha");
    const taskDir = join(projectDir, "tasks", "001-foo");
    mkdirSync(taskDir);
    writeFileSync(join(taskDir, "task.md"), taskMd("001-foo"));

    const legacyPath = writeLegacyRun("alpha-001-foo", "20260515T120000Z", "transcript-body");

    const r = migrateRunsToTaskFolders(tmp);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].action, "moved");
    assert.equal(r.warnings.length, 0);
    assert.ok(!existsSync(legacyPath));
    const newPath = join(taskDir, "runs", "20260515T120000Z.log");
    assert.ok(existsSync(newPath));
    assert.equal(readFileSync(newPath, "utf8"), "transcript-body");
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});

test("migrateRunsToTaskFolders: top-level file-form task — auto-folds, then moves <utc>.log into the new folder", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    const projectDir = setupTree(tmp, "alpha");
    writeFileSync(join(projectDir, "tasks", "001-foo.md"), taskMd("001-foo"));

    writeLegacyRun("alpha-001-foo", "20260515T120000Z", "body");

    const r = migrateRunsToTaskFolders(tmp);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].action, "folded-and-moved");
    assert.ok(!existsSync(join(projectDir, "tasks", "001-foo.md")));
    assert.ok(existsSync(join(projectDir, "tasks", "001-foo", "task.md")));
    assert.ok(existsSync(join(projectDir, "tasks", "001-foo", "runs", "20260515T120000Z.log")));
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});

test("migrateRunsToTaskFolders: child task — moves to parent's runs/ with <child-slug>--<utc>.log basename", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    const projectDir = setupTree(tmp, "alpha");
    const parentDir = join(projectDir, "tasks", "002-parent");
    mkdirSync(parentDir);
    writeFileSync(join(parentDir, "task.md"), taskMd("002-parent"));
    writeFileSync(join(parentDir, "003-child.md"), childTaskMd("003-child", "002-parent"));

    writeLegacyRun("alpha-002-parent-003-child", "20260515T120000Z", "body");

    const r = migrateRunsToTaskFolders(tmp);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].action, "moved");
    const newPath = join(parentDir, "runs", "003-child--20260515T120000Z.log");
    assert.ok(existsSync(newPath));
    assert.equal(readFileSync(newPath, "utf8"), "body");
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});

test("migrateRunsToTaskFolders: orphan (no matching task) moves to ~/.tpm/runs/orphans/", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    setupTree(tmp, "alpha"); // no tasks at all
    const legacyPath = writeLegacyRun("alpha-999-ghost", "20260515T120000Z", "ghost");

    const r = migrateRunsToTaskFolders(tmp);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].action, "orphaned");
    assert.ok(!existsSync(legacyPath));
    const orphan = join(legacyDir(), "orphans", "alpha-999-ghost--20260515T120000Z.log");
    assert.ok(existsSync(orphan));
    assert.equal(readFileSync(orphan, "utf8"), "ghost");
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});

test("migrateRunsToTaskFolders: archived folder-form task is matched and migration goes into the archive folder", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    const projectDir = setupTree(tmp, "alpha");
    const archiveDir = join(projectDir, "tasks", "archive", "001-foo");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "task.md"), taskMd("001-foo", "done"));

    writeLegacyRun("alpha-001-foo", "20260515T120000Z", "body");

    const r = migrateRunsToTaskFolders(tmp);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].action, "moved");
    assert.ok(existsSync(join(archiveDir, "runs", "20260515T120000Z.log")));
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});

test("migrateRunsToTaskFolders: archived file-form task refuses to fold; file goes to orphans/", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    const projectDir = setupTree(tmp, "alpha");
    const archiveDir = join(projectDir, "tasks", "archive");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "001-foo.md"), taskMd("001-foo", "done"));

    writeLegacyRun("alpha-001-foo", "20260515T120000Z", "body");

    const r = migrateRunsToTaskFolders(tmp);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].action, "orphaned");
    assert.ok(existsSync(join(legacyDir(), "orphans", "alpha-001-foo--20260515T120000Z.log")));
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});

test("migrateRunsToTaskFolders: destination already exists — skip with a warning, don't overwrite", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    const projectDir = setupTree(tmp, "alpha");
    const taskDir = join(projectDir, "tasks", "001-foo");
    mkdirSync(join(taskDir, "runs"), { recursive: true });
    writeFileSync(join(taskDir, "task.md"), taskMd("001-foo"));
    writeFileSync(join(taskDir, "runs", "20260515T120000Z.log"), "already-here");

    const legacyPath = writeLegacyRun("alpha-001-foo", "20260515T120000Z", "incoming");

    const r = migrateRunsToTaskFolders(tmp);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].action, "skipped");
    assert.ok(existsSync(legacyPath));
    assert.equal(readFileSync(join(taskDir, "runs", "20260515T120000Z.log"), "utf8"), "already-here");
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});

test("migrateRunsToTaskFolders: bad filename in legacy dir is left in place with a warning", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    setupTree(tmp, "alpha");
    mkdirSync(legacyDir(), { recursive: true });
    writeFileSync(join(legacyDir(), "not-a-runlog.txt"), "?");

    const r = migrateRunsToTaskFolders(tmp);
    assert.equal(r.steps.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /doesn't match the legacy/);
    assert.ok(existsSync(join(legacyDir(), "not-a-runlog.txt")));
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});

test("migrateRunsToTaskFolders: missing legacy dir is a no-op", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    setupTree(tmp, "alpha");
    const r = migrateRunsToTaskFolders(tmp);
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.warnings, []);
  } finally { rmTempDir(tmp); }
});

test("migrateRunsToTaskFolders: orphans/ subdir is not re-walked on subsequent runs", () => {
  resetLegacyDir();
  const tmp = mkTempDir("tpm-migrate-runs-");
  try {
    setupTree(tmp, "alpha");
    const orphans = join(legacyDir(), "orphans");
    mkdirSync(orphans, { recursive: true });
    writeFileSync(join(orphans, "old-orphan--20260101T000000Z.log"), "stale");

    const r = migrateRunsToTaskFolders(tmp);
    assert.deepEqual(r.steps, []);
    assert.ok(existsSync(join(orphans, "old-orphan--20260101T000000Z.log")));
  } finally { rmTempDir(tmp); resetLegacyDir(); }
});
