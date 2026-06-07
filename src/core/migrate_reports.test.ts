import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { migrateReportsToTaskFolders } from "./migrate_reports.ts";
import { parse } from "../util/frontmatter.ts";

function projectMd(slug: string): string {
  return `---\nname: ${slug}\nslug: ${slug}\nstatus: active\ncreated: 2026-01-01 00:00 PDT\ntags: []\n---\n\n# ${slug}\n\n## Goal\nx\n`;
}

function taskMd(slug: string, opts: { withReportField?: string; archived?: boolean } = {}): string {
  const reportLine = opts.withReportField ? `report: ${opts.withReportField}\n` : "";
  const status = opts.archived ? "done" : "in-progress";
  const closed = opts.archived ? "closed: 2026-04-01 00:00 PDT\n" : "closed:\n";
  return `---\ntitle: Task ${slug}\nslug: ${slug}\nproject: alpha\nstatus: ${status}\ntype: investigation\ncreated: 2026-01-01 00:00 PDT\n${closed}prs: []\ntags: []\n${reportLine}---\n\n# Task ${slug}\n\n## Context\nx\n\n## Log\n- 2026-01-01 00:00 PDT: created\n`;
}

function setupProject(root: string, slug: string): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "project.md"), projectMd(slug));
  return dir;
}

test("migrate reports: folds file-form live task, moves report into task folder, strips frontmatter field", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    // Live file-form task with legacy report.
    writeFileSync(join(dir, "tasks", "001-finding.md"), taskMd("001-finding", { withReportField: "reports/001-finding.md" }));
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports", "001-finding.md"), "# Finding\n\nbody.\n");

    const result = migrateReportsToTaskFolders(root);

    // Old file-form path gone; folder-form task.md present.
    assert.equal(existsSync(join(dir, "tasks", "001-finding.md")), false);
    const newTaskMd = join(dir, "tasks", "001-finding", "task.md");
    assert.ok(existsSync(newTaskMd));
    // Report moved to task folder.
    const newReport = join(dir, "tasks", "001-finding", "report.md");
    assert.ok(existsSync(newReport));
    assert.equal(readFileSync(newReport, "utf8"), "# Finding\n\nbody.\n");
    // Legacy reports dir removed.
    assert.equal(existsSync(join(dir, "reports")), false);
    // Frontmatter field stripped.
    const { data } = parse(readFileSync(newTaskMd, "utf8"));
    assert.equal("report" in data, false);
    // Step log includes a move + frontmatter strip.
    assert.ok(result.steps.some(s => s.action === "moved"));
    assert.ok(result.steps.some(s => s.action === "frontmatter-stripped"));
    assert.deepEqual(result.warnings, []);
    assert.equal(result.removedReportsDirs.length, 1);
  } finally {
    rmTempDir(root);
  }
});

test("migrate reports: already-folder live task gets report.md co-located without re-folding", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const taskDir = join(dir, "tasks", "001-folded");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.md"), taskMd("001-folded", { withReportField: "reports/001-folded.md" }));
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports", "001-folded.md"), "# F\n");

    migrateReportsToTaskFolders(root);

    assert.ok(existsSync(join(taskDir, "task.md")));
    assert.ok(existsSync(join(taskDir, "report.md")));
    assert.equal(existsSync(join(dir, "reports")), false);
    const { data } = parse(readFileSync(join(taskDir, "task.md"), "utf8"));
    assert.equal("report" in data, false);
  } finally {
    rmTempDir(root);
  }
});

test("migrate reports: re-running is a no-op", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFileSync(join(dir, "tasks", "001-finding.md"), taskMd("001-finding", { withReportField: "reports/001-finding.md" }));
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports", "001-finding.md"), "# F\n");
    migrateReportsToTaskFolders(root);
    const result2 = migrateReportsToTaskFolders(root);
    assert.deepEqual(result2.steps, []);
    assert.deepEqual(result2.removedReportsDirs, []);
    assert.deepEqual(result2.warnings, []);
  } finally {
    rmTempDir(root);
  }
});

test("migrate reports: warns and leaves legacy file when no matching task exists", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports", "999-orphan.md"), "# orphan\n");

    const result = migrateReportsToTaskFolders(root);

    // File untouched.
    assert.ok(existsSync(join(dir, "reports", "999-orphan.md")));
    // Warning emitted, reports dir NOT removed (still has the orphan).
    assert.ok(result.warnings.some(w => w.includes("999-orphan")));
    assert.equal(result.removedReportsDirs.length, 0);
  } finally {
    rmTempDir(root);
  }
});

test("migrate reports: handles archived file-form task by folding into archive folder", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    const archiveDir = join(dir, "tasks", "archive");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "001-old.md"), taskMd("001-old", { withReportField: "reports/001-old.md", archived: true }));
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports", "001-old.md"), "# O\n");

    migrateReportsToTaskFolders(root);

    // Archived task was folded inside archive/, report co-located.
    assert.equal(existsSync(join(archiveDir, "001-old.md")), false);
    const newTaskMd = join(archiveDir, "001-old", "task.md");
    assert.ok(existsSync(newTaskMd));
    assert.ok(existsSync(join(archiveDir, "001-old", "report.md")));
    const { data } = parse(readFileSync(newTaskMd, "utf8"));
    assert.equal("report" in data, false);
  } finally {
    rmTempDir(root);
  }
});

test("migrate reports: strips stale frontmatter even when legacy file is already gone", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    // Folder-form task that still carries a stale report: field but no
    // legacy file (e.g. operator deleted it manually pre-migration).
    const taskDir = join(dir, "tasks", "001-stale");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.md"), taskMd("001-stale", { withReportField: "reports/gone.md" }));

    migrateReportsToTaskFolders(root);

    const { data } = parse(readFileSync(join(taskDir, "task.md"), "utf8"));
    assert.equal("report" in data, false);
  } finally {
    rmTempDir(root);
  }
});

test("migrate reports: refuses to delete reports dir when unmigrated entries remain", () => {
  const root = mkTempDir();
  try {
    const dir = setupProject(root, "alpha");
    writeFileSync(join(dir, "tasks", "001-finding.md"), taskMd("001-finding", { withReportField: "reports/001-finding.md" }));
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(join(dir, "reports", "001-finding.md"), "# F\n");
    // Unmigratable cruft (subdir or non-md file).
    mkdirSync(join(dir, "reports", "subdir"), { recursive: true });

    const result = migrateReportsToTaskFolders(root);

    assert.ok(existsSync(join(dir, "reports")));
    assert.ok(result.warnings.some(w => w.includes("entries remain")));
  } finally {
    rmTempDir(root);
  }
});
