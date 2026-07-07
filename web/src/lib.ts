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
