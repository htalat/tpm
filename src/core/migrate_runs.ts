// One-shot migration for task 095: relocate per-run logs from the flat
// `~/.tpm/runs/<encoded-slug>--<utc>.log` layout (task 057) into each
// task's own folder (`<project>/tasks/<slug>/runs/<utc>.log` for top-level,
// `<project>/tasks/<parent>/runs/<child-slug>--<utc>.log` for children).
//
// Walks the legacy dir, resolves each filename's encoded prefix against the
// loaded project tree (live + archive), folds file-form top-level tasks if
// needed, mkdirs the runs/ target, and renames each file into place.
// Files that can't be resolved (deleted task, ambiguous prefix) move to
// `~/.tpm/runs/orphans/` so the operator can triage without losing transcript.
//
// Safe to re-run: a destination collision skips that file with a warning;
// orphan files in `orphans/` are not re-scanned.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadProjects, flatTasks, foldTask } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import {
  encodeLegacySlug,
  isLegacyRunLogName,
  legacyRunsDir,
  newRunLogName,
  taskRunsDir,
} from "./run_log.ts";

export interface MigrationStep {
  legacyName: string;
  action: "moved" | "folded-and-moved" | "orphaned" | "skipped";
  detail: string;
}

export interface MigrationResult {
  steps: MigrationStep[];
  warnings: string[];
}

export function migrateRunsToTaskFolders(root: string): MigrationResult {
  const result: MigrationResult = { steps: [], warnings: [] };
  const legacyDir = legacyRunsDir();
  if (!existsSync(legacyDir)) return result;

  // Build an index over the loaded tree: encoded qualified slug → matching
  // tasks (with their project). Both live and archived tasks are eligible
  // destinations — runs may have been captured before archive.
  const projects = loadProjects(root, { archived: true });
  const index = buildEncodedIndex(projects);

  for (const entry of readdirSync(legacyDir).sort()) {
    if (entry === "orphans") continue;
    if (entry.startsWith(".")) continue;
    const full = join(legacyDir, entry);
    if (!isFile(full)) continue;
    if (!isLegacyRunLogName(entry)) {
      result.warnings.push(`${entry}: doesn't match the legacy <encoded>--<utc>.log shape; leaving in place`);
      continue;
    }
    migrateOneRun(full, entry, index, legacyDir, result);
  }
  return result;
}

interface IndexEntry {
  project: Project;
  task: Task;
}

function buildEncodedIndex(projects: Project[]): Map<string, IndexEntry[]> {
  const index = new Map<string, IndexEntry[]>();
  for (const p of projects) {
    for (const t of flatTasks(p.tasks)) {
      const qs = t.parent ? `${p.slug}/${t.parent}/${t.slug}` : `${p.slug}/${t.slug}`;
      const enc = encodeLegacySlug(qs);
      const arr = index.get(enc) ?? [];
      arr.push({ project: p, task: t });
      index.set(enc, arr);
    }
  }
  return index;
}

function migrateOneRun(
  legacyPath: string,
  legacyName: string,
  index: Map<string, IndexEntry[]>,
  legacyDir: string,
  result: MigrationResult,
): void {
  const sep = legacyName.indexOf("--");
  const encoded = legacyName.slice(0, sep);
  const tsAndExt = legacyName.slice(sep + 2); // `<utc>.log`

  const matches = index.get(encoded);
  if (!matches || matches.length === 0) {
    orphan(legacyPath, legacyName, legacyDir, result, "no matching task in tree");
    return;
  }
  if (matches.length > 1) {
    // Ambiguous prefix (e.g. `tpm-095-foo` could be top-level `tpm/095-foo`
    // or child `tpm/095/foo` in unrelated trees). Don't guess — orphan and
    // surface a warning.
    orphan(legacyPath, legacyName, legacyDir, result, `ambiguous: ${matches.length} tasks match`);
    return;
  }
  const { task } = matches[0];

  // Resolve destination path. For file-form top-level tasks we fold first
  // (mirrors `prepareRunLogPath`'s pre-spawn behavior); children pass through
  // because the parent is already folder-form by virtue of having children.
  let folded = false;
  let taskRef = task;
  if (!task.parent && !task.dir) {
    if (task.archived) {
      // Folding an archived task isn't supported (foldTask refuses). Treat as
      // an orphan so the operator can decide whether to un-archive or accept
      // the legacy file is dead.
      orphan(legacyPath, legacyName, legacyDir, result, "task is archived and file-form; refuse to fold");
      return;
    }
    try {
      const newPath = foldTask(task);
      // Reflect the fold in our in-memory ref so taskRunsDir() finds the new
      // dir (we don't bother reloading the tree).
      taskRef = { ...task, path: newPath, dir: dirname(newPath) };
      folded = true;
    } catch (e) {
      result.warnings.push(`${legacyName}: foldTask failed for ${task.slug}: ${(e as Error).message}; leaving in place`);
      return;
    }
  }

  const destDir = taskRunsDir(taskRef);
  const destName = newRunLogName(taskRef, parseUtcFromLegacyTail(tsAndExt));
  const destPath = join(destDir, destName);
  if (existsSync(destPath)) {
    result.steps.push({
      legacyName,
      action: "skipped",
      detail: `${destPath} already exists; not overwriting`,
    });
    return;
  }
  mkdirSync(destDir, { recursive: true });
  renameSync(legacyPath, destPath);
  result.steps.push({
    legacyName,
    action: folded ? "folded-and-moved" : "moved",
    detail: `${legacyPath} -> ${destPath}`,
  });
}

// `<utc>.log` → Date. The legacy filename is `<encoded>--YYYYMMDDTHHMMSSZ.log`;
// we recover the Date so `newRunLogName(task, when)` can stamp the exact same
// timestamp on the new file (otherwise the migrated file would carry the
// migration's wall-clock time, which would alphabetize wrongly).
function parseUtcFromLegacyTail(tail: string): Date {
  const m = tail.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.log$/);
  if (!m) return new Date();
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function orphan(
  legacyPath: string,
  legacyName: string,
  legacyDir: string,
  result: MigrationResult,
  reason: string,
): void {
  const orphansDir = join(legacyDir, "orphans");
  mkdirSync(orphansDir, { recursive: true });
  const dest = join(orphansDir, legacyName);
  if (existsSync(dest)) {
    result.warnings.push(`${legacyName}: orphan target ${dest} already exists; leaving in place`);
    return;
  }
  renameSync(legacyPath, dest);
  result.steps.push({ legacyName, action: "orphaned", detail: `${reason} -> ${dest}` });
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
