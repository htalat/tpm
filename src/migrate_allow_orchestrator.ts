// One-shot migration for task 100: back-fill `allow_orchestrator: true` on
// every live task already at `status: ready`. Task 100 made `tpm ready` (and
// every other path that lands a task at `ready`) default the task autonomous-
// eligible; this walks the existing tree so tasks promoted before that change
// are consistent with the orchestrator gate (queue.ts) going forward.
//
// Scope:
//   - Live tasks only. Archived tasks are terminal — their gate is moot, and
//     `loadProjects(root)` (no `archived` opt) doesn't load them.
//   - Leaf tasks only. Parents aren't claimable by the orchestrator, so
//     toggling the flag on a container is meaningless (mirrors
//     setAllowOrchestrator's refusal).
//   - Only tasks whose flag actually flips are written + logged. A re-run on
//     an already-migrated tree is a clean no-op ("nothing to migrate").

import { readFileSync, writeFileSync } from "node:fs";
import { loadProjects, flatTasks, isParent } from "./tree.ts";
import type { Task } from "./tree.ts";
import { parse, stringify } from "./frontmatter.ts";
import { appendLog } from "./mutate.ts";
import { now } from "./time.ts";

export interface MigrationStep {
  project: string;
  slug: string;
  detail: string;
}

export interface MigrationResult {
  steps: MigrationStep[];
  warnings: string[];
}

export function migrateAllowOrchestratorOnReady(root: string): MigrationResult {
  const result: MigrationResult = { steps: [], warnings: [] };
  for (const p of loadProjects(root)) {
    for (const t of flatTasks(p.tasks)) {
      if (t.archived) continue; // belt-and-braces; live load already excludes
      if (isParent(t)) continue; // parents aren't claimable
      if (String(t.data.status ?? "") !== "ready") continue;
      if (t.data.allow_orchestrator === true) continue; // already eligible
      migrateOne(p.slug, t, result);
    }
  }
  return result;
}

function migrateOne(projectSlug: string, task: Task, result: MigrationResult): void {
  const { data, body } = parse(readFileSync(task.path, "utf8"));
  // Re-check against the on-disk value — parse-then-write is the source of
  // truth for the rewrite, not the in-memory snapshot.
  if (data.allow_orchestrator === true) return;
  data.allow_orchestrator = true;
  let newBody = body;
  if (/^##\s+Log\s*$/m.test(body)) {
    newBody = appendLog(body, `${now()}: allow_orchestrator: true (migration: set on ready)`);
  } else {
    result.warnings.push(`${projectSlug}/${task.slug}: no ## Log section; set flag without a log line`);
  }
  writeFileSync(task.path, stringify(data, newBody));
  result.steps.push({ project: projectSlug, slug: task.slug, detail: task.path });
}
