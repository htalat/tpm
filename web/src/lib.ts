import type { TaskSummary } from "./types";

// Pure helpers shared across pages — split from components.tsx so they're
// testable without a DOM.

// SPA task pages arrive in part 4; until then rows deep-link into the SSR
// detail page (same origin, full navigation).
export function taskHref(t: Pick<TaskSummary, "segments">): string {
  return "/t/" + t.segments.map(encodeURIComponent).join("/");
}

export function flatTasks(tasks: TaskSummary[]): TaskSummary[] {
  return tasks.flatMap(t => [t, ...flatTasks(t.children)]);
}

// "2026-07-06T21:12:38.123Z" -> "2026-07-06 21:12" — journal stamps are ISO
// UTC; the feed wants them short.
export function shortStamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

// Intersection of the selected statuses' bulk capabilities, in a stable
// render order — only actions valid for every selected task are offered.
export const BULK_ACTION_ORDER = ["promote", "pull", "close", "reopen", "drop", "block", "archive"];

export function intersectCaps(statuses: string[], caps: Record<string, string[]>): string[] {
  if (statuses.length === 0) return [];
  let common = new Set<string>(caps[statuses[0]] ?? []);
  for (const s of statuses.slice(1)) {
    const own = new Set<string>(caps[s] ?? []);
    common = new Set<string>([...common].filter(a => own.has(a)));
  }
  return BULK_ACTION_ORDER.filter(a => common.has(a));
}

// The wire-surface version this bundle was built against (api.ts mirrors it
// server-side). A long-running tpm serve keeps its backend in memory while
// /app ships the rebuilt bundle from disk — on mismatch the UI shows a
// restart banner instead of degrading silently.
export const EXPECTED_API_VERSION = 2;

export function backendIsStale(vocab: { apiVersion?: number } | null): boolean {
  if (!vocab) return false; // still loading / unreachable — not a skew signal
  return (vocab.apiVersion ?? 0) < EXPECTED_API_VERSION;
}
