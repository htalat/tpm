import { readFileSync } from "node:fs";
import { loadProjects, flatTasks } from "./tree.ts";
import { parse, stringify } from "../util/frontmatter.ts";
import { appendLog, atomicWriteFileSync } from "./mutate.ts";
import { now } from "../util/time.ts";

// One-time data migration for the status vocabulary rename. The old names
// conflated "what state is this" with nothing about "whose turn is it";
// the new ones are one word each and actor-implying:
//
//   needs-feedback -> rework    (agent's turn: address the PR signal)
//   needs-review   -> review    (human's turn: review the report / PR)
//   needs-close    -> closing   (human alert: inline auto-close failed)
//
// `tpm migrate` rewrites every task in the tree (live + archived) in place,
// stamping a Log line per rewrite so the audit trail records the rename.
// Idempotent: a second run finds nothing to change. Other trees (synced
// devices) run the same command once after pulling the new CLI.

export const STATUS_RENAMES: Record<string, string> = {
  "needs-feedback": "rework",
  "needs-review": "review",
  "needs-close": "closing",
};

export interface MigrateChange {
  path: string;
  slug: string;
  from: string;
  to: string;
}

export interface MigrateResult {
  scanned: number;
  changes: MigrateChange[];
}

export function migrateTree(root: string, opts: { dryRun?: boolean } = {}): MigrateResult {
  const projects = loadProjects(root, { archived: true });
  const result: MigrateResult = { scanned: 0, changes: [] };
  for (const p of projects) {
    for (const t of flatTasks(p.tasks)) {
      result.scanned++;
      // Read fresh off disk — the loader's snapshot may be stale relative to
      // a concurrent writer, and the rewrite must not clobber anything else.
      let text: string;
      try {
        text = readFileSync(t.path, "utf8");
      } catch {
        continue; // raced with an archive/move — nothing to migrate here
      }
      const { data, body } = parse(text);
      const from = String(data.status ?? "");
      const to = STATUS_RENAMES[from];
      if (!to) continue;
      result.changes.push({ path: t.path, slug: `${p.slug}/${t.slug}`, from, to });
      if (opts.dryRun) continue;
      data.status = to;
      // Hand-rolled bodies may lack a ## Log section (appendLog throws on
      // those) — the status rewrite matters more than the audit line.
      let newBody = body;
      if (/^##\s+Log\s*$/m.test(body)) {
        newBody = appendLog(body, `${now()}: status migrated ${from} -> ${to} (vocabulary rename)`);
      }
      atomicWriteFileSync(t.path, stringify(data, newBody));
    }
  }
  return result;
}
