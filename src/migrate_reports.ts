// One-shot migration for task 094: relocate per-task reports from the flat
// `<project>/reports/<slug>.md` layout (task 080) to co-located
// `<project>/tasks/<slug>/report.md` inside each task's own folder. Strips
// the legacy `report:` frontmatter field (presence of `report.md` is now
// the source of truth) and removes the empty `reports/` directory.
//
// Safe to re-run: each step checks for existing state before acting, so a
// partial migration interrupted mid-run can be resumed by re-invoking.
// Live and archived top-level tasks are both handled. Child tasks (which
// can't have own per-task folders post-094) are not migrated — if any are
// present, they're reported as warnings and the legacy file is left alone
// for the operator to triage.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "./frontmatter.ts";

export interface MigrationStep {
  project: string;
  slug: string;
  action: "moved" | "frontmatter-stripped" | "already-co-located" | "skipped";
  detail: string;
}

export interface MigrationResult {
  steps: MigrationStep[];
  removedReportsDirs: string[];
  warnings: string[];
}

export function migrateReportsToTaskFolders(root: string): MigrationResult {
  const result: MigrationResult = { steps: [], removedReportsDirs: [], warnings: [] };
  if (!isDir(root)) return result;

  for (const projectSlug of readdirSync(root).sort()) {
    if (projectSlug.startsWith(".")) continue;
    const projectDir = join(root, projectSlug);
    if (!isDir(projectDir)) continue;
    if (!isFile(join(projectDir, "project.md"))) continue;
    migrateProject(projectDir, projectSlug, result);
  }
  return result;
}

function migrateProject(projectDir: string, projectSlug: string, result: MigrationResult): void {
  const reportsDir = join(projectDir, "reports");
  const tasksDir = join(projectDir, "tasks");
  if (isDir(reportsDir)) {
    for (const entry of readdirSync(reportsDir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const slug = entry.replace(/\.md$/, "");
      migrateOneReport(projectDir, projectSlug, slug, tasksDir, reportsDir, result);
    }
    // Drop the now-empty reports/ dir. Leave it if anything (subdirs,
    // unknown files) was non-migratable so the operator can inspect.
    const remaining = readdirSync(reportsDir).filter(e => !e.startsWith("."));
    if (remaining.length === 0) {
      rmdirSync(reportsDir);
      result.removedReportsDirs.push(reportsDir);
    } else {
      result.warnings.push(`${reportsDir}: ${remaining.length} entries remain after migration; not removing dir`);
    }
  }

  // Also strip stale `report:` frontmatter from any task in this project
  // whose legacy reports/ file is already gone (e.g. file was deleted out
  // of band, or a prior migration moved the file but failed to rewrite
  // frontmatter).
  if (isDir(tasksDir)) {
    stripStaleFrontmatterInTree(tasksDir, projectSlug, result);
  }
}

function migrateOneReport(
  projectDir: string,
  projectSlug: string,
  slug: string,
  tasksDir: string,
  reportsDir: string,
  result: MigrationResult,
): void {
  const reportSrc = join(reportsDir, `${slug}.md`);

  // Resolve the task: live first (file-form or folder-form), then archive.
  const candidates: TaskFile[] = [];
  candidates.push(...findTopLevelTasks(tasksDir, slug, false));
  candidates.push(...findTopLevelTasks(join(tasksDir, "archive"), slug, true));
  if (candidates.length === 0) {
    result.warnings.push(`${projectSlug}/${slug}: no matching task found for ${reportSrc}; leaving in place`);
    return;
  }
  if (candidates.length > 1) {
    result.warnings.push(`${projectSlug}/${slug}: multiple task candidates found (${candidates.map(c => c.path).join(", ")}); leaving ${reportSrc} in place`);
    return;
  }
  const task = candidates[0];

  // Fold file-form → folder-form so the report can be co-located.
  if (!task.dir) {
    const folderPath = join(dirname(task.path), task.slug);
    if (isDir(folderPath) || isFile(folderPath)) {
      result.warnings.push(`${projectSlug}/${slug}: target folder ${folderPath} already exists; cannot fold`);
      return;
    }
    mkdirSync(folderPath, { recursive: true });
    const newPath = join(folderPath, "task.md");
    renameSync(task.path, newPath);
    task.path = newPath;
    task.dir = folderPath;
  }

  const reportDst = join(task.dir, "report.md");
  if (isFile(reportDst)) {
    // Already migrated, just strip frontmatter + delete the legacy source.
    if (stripReportField(task.path)) {
      result.steps.push({ project: projectSlug, slug, action: "frontmatter-stripped", detail: task.path });
    }
    if (isFile(reportSrc)) {
      // Legacy file still exists alongside the co-located one — refuse to
      // overwrite, surface a warning instead. Operator decides which wins.
      result.warnings.push(`${projectSlug}/${slug}: both ${reportSrc} and ${reportDst} exist; leaving legacy file for manual resolution`);
      return;
    }
    result.steps.push({ project: projectSlug, slug, action: "already-co-located", detail: reportDst });
    return;
  }
  renameSync(reportSrc, reportDst);
  result.steps.push({ project: projectSlug, slug, action: "moved", detail: `${reportSrc} -> ${reportDst}` });
  if (stripReportField(task.path)) {
    result.steps.push({ project: projectSlug, slug, action: "frontmatter-stripped", detail: task.path });
  }
}

interface TaskFile {
  slug: string;
  path: string;
  archived: boolean;
  dir?: string;
}

// Find top-level task(s) for a given slug under `dir`. Both file-form
// (`<slug>.md`) and folder-form (`<slug>/task.md`) shapes are supported.
// Returns multiple entries only in pathological cases; callers warn on
// ambiguity.
function findTopLevelTasks(dir: string, slug: string, archived: boolean): TaskFile[] {
  const out: TaskFile[] = [];
  if (!isDir(dir)) return out;
  const filePath = join(dir, `${slug}.md`);
  if (isFile(filePath)) out.push({ slug, path: filePath, archived });
  const folderPath = join(dir, slug);
  const taskMd = join(folderPath, "task.md");
  if (isDir(folderPath) && isFile(taskMd)) out.push({ slug, path: taskMd, archived, dir: folderPath });
  return out;
}

// Walk the tasks tree (live + archive) and remove any lingering `report:`
// frontmatter field. Called after the per-project report-file walk so we
// also catch tasks whose legacy file was deleted out-of-band.
function stripStaleFrontmatterInTree(tasksDir: string, projectSlug: string, result: MigrationResult): void {
  if (!isDir(tasksDir)) return;
  for (const entry of readdirSync(tasksDir).sort()) {
    if (entry.startsWith(".")) continue;
    const full = join(tasksDir, entry);
    if (entry.endsWith(".md") && isFile(full)) {
      if (stripReportField(full)) {
        const slug = entry.replace(/\.md$/, "");
        result.steps.push({ project: projectSlug, slug, action: "frontmatter-stripped", detail: full });
      }
      continue;
    }
    if (isDir(full)) {
      if (entry === "archive") {
        stripStaleFrontmatterInTree(full, projectSlug, result);
        continue;
      }
      const taskMd = join(full, "task.md");
      if (isFile(taskMd)) {
        if (stripReportField(taskMd)) {
          result.steps.push({ project: projectSlug, slug: entry, action: "frontmatter-stripped", detail: taskMd });
        }
      }
      // Walk child files for `report:` field (children can't have own folders
      // post-094, but legacy children may carry the field).
      for (const child of readdirSync(full)) {
        if (!child.endsWith(".md") || child === "task.md" || child.startsWith(".")) continue;
        const childPath = join(full, child);
        if (stripReportField(childPath)) {
          result.steps.push({ project: projectSlug, slug: child.replace(/\.md$/, ""), action: "frontmatter-stripped", detail: childPath });
        }
      }
    }
  }
}

// Read frontmatter, drop `report:` if present, write back. Returns true
// when a write happened (field was present). No-op on tasks without the
// field — safe to call broadly.
function stripReportField(taskPath: string): boolean {
  const text = readFileSync(taskPath, "utf8");
  const { data, body } = parse(text);
  if (!("report" in data)) return false;
  delete data.report;
  writeFileSync(taskPath, stringify(data, body));
  return true;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
