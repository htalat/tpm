import { flatTasks, isParent } from "./tree.ts";
import type { Project, Task } from "./tree.ts";

export interface SelectNextOpts {
  projectFilter?: string;
  autonomous?: boolean;
}

export interface QueueItem {
  project: Project;
  task: Task;
}

const NEXT_STATUSES = ["needs-feedback", "needs-close", "ready"] as const;

// All eligible leaf candidates in selection order:
//   needs-feedback (in-flight signal, time-sensitive) >
//   needs-close   (PR merged, sweep before piling on new work) >
//   ready         (new work),
// then oldest by created within each bucket. Parents and archived excluded.
// Used by both `selectNext` (head) and `tpm next --claim` (walk until one
// can be locked).
export function selectCandidates(projects: Project[], opts: SelectNextOpts = {}): QueueItem[] {
  const candidates: QueueItem[] = [];
  for (const p of projects) {
    if (opts.projectFilter && p.slug !== opts.projectFilter) continue;
    for (const t of flatTasks(p.tasks)) {
      if (t.archived) continue;
      if (isParent(t)) continue;
      const status = String(t.data.status ?? "");
      if (!(NEXT_STATUSES as readonly string[]).includes(status)) continue;
      if (opts.autonomous && t.data.allow_orchestrator !== true) continue;
      candidates.push({ project: p, task: t });
    }
  }
  const priority = (s: unknown): number => {
    const i = (NEXT_STATUSES as readonly string[]).indexOf(String(s));
    return i < 0 ? NEXT_STATUSES.length : i;
  };
  candidates.sort((a, b) => {
    const dp = priority(a.task.data.status) - priority(b.task.data.status);
    if (dp !== 0) return dp;
    const ac = String(a.task.data.created ?? "");
    const bc = String(b.task.data.created ?? "");
    return ac.localeCompare(bc);
  });
  return candidates;
}

// `tpm next` selection: head of the candidate list, or null if empty.
export function selectNext(projects: Project[], opts: SelectNextOpts = {}): QueueItem | null {
  const candidates = selectCandidates(projects, opts);
  return candidates[0] ?? null;
}

export const INBOX_STATUSES = ["needs-review", "blocked", "open"] as const;

// `tpm inbox` listing. Human-queue tasks across all projects, ordered with
// the most actionable status first (needs-review > blocked > open), then
// oldest by created within each bucket.
export function inboxItems(projects: Project[]): Array<QueueItem & { status: string }> {
  const items: Array<QueueItem & { status: string }> = [];
  for (const p of projects) {
    for (const t of flatTasks(p.tasks)) {
      if (t.archived) continue;
      if (isParent(t)) continue;
      const status = String(t.data.status ?? "");
      if (!(INBOX_STATUSES as readonly string[]).includes(status)) continue;
      items.push({ project: p, task: t, status });
    }
  }
  const rank = (s: string): number => (INBOX_STATUSES as readonly string[]).indexOf(s);
  items.sort((a, b) => {
    const dr = rank(a.status) - rank(b.status);
    if (dr !== 0) return dr;
    const ac = String(a.task.data.created ?? "");
    const bc = String(b.task.data.created ?? "");
    return ac.localeCompare(bc);
  });
  return items;
}
