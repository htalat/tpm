import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StatusChange } from "./mutate.ts";

// Append-only NDJSON journal of status transitions at
// <root>/.tpm/events.ndjson. One line per transition — the machine-readable
// audit trail for "who moved what, when", and the seam a live event feed
// (serve SSE) reads from later. Registered as mutate's status-change listener
// by the CLI entry, not called from mutate directly: mutate is the
// single-task-file layer and has no root context.
//
// Best-effort by design: the mutation has already landed on the task file by
// the time we're called, so a journal failure logs nothing and blocks
// nothing. The journal is derived history, never the source of truth.

export interface StatusEventRecord {
  at: string;     // ISO-8601 UTC
  task: string;   // qualified slug: project/slug or project/parent/slug
  from: string;
  to: string;
  verb: string;   // the Log line the mutation wrote
  actor: string;  // TPM_AGENT_ID (worker-1, agent id, …) or "cli"
}

export function eventsPath(root: string): string {
  return join(root, ".tpm", "events.ndjson");
}

export function appendStatusEvent(root: string, change: StatusChange): void {
  const project = typeof change.task.data.project === "string" && change.task.data.project
    ? change.task.data.project
    : "?";
  const qualified = change.task.parent
    ? `${project}/${change.task.parent}/${change.task.slug}`
    : `${project}/${change.task.slug}`;
  const record: StatusEventRecord = {
    at: new Date().toISOString(),
    task: qualified,
    from: change.from,
    to: change.to,
    verb: change.verb,
    actor: process.env.TPM_AGENT_ID || "cli",
  };
  try {
    mkdirSync(join(root, ".tpm"), { recursive: true });
    appendFileSync(eventsPath(root), `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort: never let journaling break the mutation that already landed
  }
}
