import { flatTasks, isParent } from "./tree.ts";
import type { Project, Task } from "./tree.ts";

export interface SelectNextOpts {
  projectFilter?: string;
  autonomous?: boolean;
  // Injected so callers (CLI, orchestrator) can let the queue admit stranded
  // in-progress tasks as recoverable candidates without the queue itself
  // touching the filesystem. The predicate gets a task's fully-qualified slug
  // and returns true when a per-task lock file exists.
  //
  // When omitted (unit tests, callers that want strict legacy behavior), no
  // in-progress task is admitted — same as before task 065.
  hasTaskLock?: (qualifiedSlug: string) => boolean;
}

export interface QueueItem {
  project: Project;
  task: Task;
}

// Priority order for `tpm next` (lower rank = higher priority):
//   rework        — in-flight PR signal, time-sensitive.
//   stranded in-progress  — status is `in-progress` but no per-task lock is
//                           held. The lock is the source of truth for "is
//                           someone working on this"; if it's free the task is
//                           reclaimable. Safety net for agents that exit
//                           without flipping out of `in-progress` (task 063's
//                           bug; this admission rule is task 065).
//   ready                 — fresh queue.
// Within each bucket, oldest by `created` first. Parents and archived excluded.
//
// `closing` is intentionally absent: task 045 made the poller auto-close
// inline (`mutate.complete` from `tpm poll`) right after the
// `closing` flip, so under normal operation the status is transient and
// already gone by the next tick. Stragglers (auto-close failed — body empty,
// lock contention, Outcome pre-filled) stay at `closing` for the manual
// `/tpm done <slug>` escape hatch; surface them with `tpm ls --status
// closing` if you want a sweep.
const RANK_NEEDS_FEEDBACK = 0;
const RANK_STRANDED       = 1;
const RANK_READY          = 2;
const RANK_INELIGIBLE     = 99;

function rankFor(task: Task, qualifiedSlug: string, opts: SelectNextOpts): number {
  const status = String(task.data.status ?? "");
  if (status === "rework") return RANK_NEEDS_FEEDBACK;
  if (status === "ready") return RANK_READY;
  if (status === "in-progress" && opts.hasTaskLock && !opts.hasTaskLock(qualifiedSlug)) {
    return RANK_STRANDED;
  }
  return RANK_INELIGIBLE;
}

export function qualifyTaskSlug(projectSlug: string, task: Task): string {
  return task.parent ? `${projectSlug}/${task.parent}/${task.slug}` : `${projectSlug}/${task.slug}`;
}

// All eligible leaf candidates in selection order. Used by both `selectNext`
// (head) and `tpm next --claim` / orchestrate (walk until one can be locked).
export function selectCandidates(projects: Project[], opts: SelectNextOpts = {}): QueueItem[] {
  const ranked: Array<QueueItem & { rank: number }> = [];
  for (const p of projects) {
    if (opts.projectFilter && p.slug !== opts.projectFilter) continue;
    for (const t of flatTasks(p.tasks)) {
      if (t.archived) continue;
      if (isParent(t)) continue;
      if (opts.autonomous && t.data.allow_orchestrator !== true) continue;
      const slug = qualifyTaskSlug(p.slug, t);
      const rank = rankFor(t, slug, opts);
      if (rank === RANK_INELIGIBLE) continue;
      ranked.push({ project: p, task: t, rank });
    }
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const ac = String(a.task.data.created ?? "");
    const bc = String(b.task.data.created ?? "");
    return ac.localeCompare(bc);
  });
  return ranked.map(({ project, task }) => ({ project, task }));
}

// `tpm next` selection: head of the candidate list, or null if empty.
export function selectNext(projects: Project[], opts: SelectNextOpts = {}): QueueItem | null {
  const candidates = selectCandidates(projects, opts);
  return candidates[0] ?? null;
}

// `closing` is in the human inbox because a task only *stays* there when
// the poller's inline auto-close failed (PR body empty, Outcome already
// filled, lock contention) — i.e. it's an alert needing a human `tpm done`,
// not a queue state. Under normal operation the status is transient and never
// renders here.
export const INBOX_STATUSES = ["closing", "review", "blocked", "open"] as const;

// `tpm inbox` listing. Human-queue tasks across all projects, ordered with
// the most actionable status first (closing > review > blocked >
// open), then oldest by created within each bucket.
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
