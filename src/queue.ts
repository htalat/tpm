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

const NEXT_STATUSES = ["needs-feedback", "ready"] as const;

// `tpm next` selection. Picks the next eligible leaf task across projects:
// needs-feedback > ready (in-flight signal is time-sensitive); within each
// bucket, oldest by created. Parents and archived tasks are excluded.
export function selectNext(projects: Project[], opts: SelectNextOpts = {}): QueueItem | null {
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
  if (candidates.length === 0) return null;
  const priority = (s: unknown): number => (s === "needs-feedback" ? 0 : 1);
  candidates.sort((a, b) => {
    const dp = priority(a.task.data.status) - priority(b.task.data.status);
    if (dp !== 0) return dp;
    const ac = String(a.task.data.created ?? "");
    const bc = String(b.task.data.created ?? "");
    return ac.localeCompare(bc);
  });
  return candidates[0];
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
