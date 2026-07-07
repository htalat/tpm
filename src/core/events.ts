import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
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

// Forwarded CLI mutations (POST /api/cli) execute inside the daemon but must
// journal as the CALLING process's actor (worker-1, an agent id, …), not the
// daemon's env. The mutation path is fully synchronous, so a module-level
// override set around the execCommand call is race-free.
let actorOverride: string | null = null;
export function setActorOverride(actor: string | null): void {
  actorOverride = actor;
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
    actor: actorOverride ?? (process.env.TPM_AGENT_ID || "cli"),
  };
  try {
    mkdirSync(join(root, ".tpm"), { recursive: true });
    appendFileSync(eventsPath(root), `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort: never let journaling break the mutation that already landed
  }
}

// Incremental tail for streaming consumers (serve's SSE pump): read complete
// lines appended since `offset`, returning the advanced offset. Byte-accurate
// framing — the offset only moves past the last newline, so a partially-
// flushed line (or a multi-byte char split at the read boundary) is re-read
// whole on the next call. `offset: -1` (or a shrunken file: rotation/manual
// truncation) skips to EOF without replaying history.
export function readJournalLinesFrom(
  path: string,
  offset: number,
): { lines: string[]; offset: number } {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    size = 0; // journal not created yet
  }
  if (offset === -1 || size < offset) {
    return { lines: [], offset: size };
  }
  if (size === offset) return { lines: [], offset };
  let bytes: Buffer;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      bytes = buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { lines: [], offset }; // transient read failure — retry from the same offset
  }
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], offset };
  const lines = bytes.subarray(0, lastNewline).toString("utf8").split("\n").filter(l => l.trim());
  return { lines, offset: offset + lastNewline + 1 };
}

// How far back the tail reader looks. 64 KiB ≈ 300+ events — far more than
// any feed renders — while keeping the read O(1) as the journal grows.
const TAIL_READ_BYTES = 64 * 1024;

// Newest-first tail of the journal for the activity feed. Reads only the
// last TAIL_READ_BYTES, drops the leading partial line when the read didn't
// start at offset 0, and skips lines that don't parse (hand-edited or
// torn writes) rather than failing the page.
export function readRecentEvents(root: string, limit: number): StatusEventRecord[] {
  const path = eventsPath(root);
  let chunk: string;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      const read = readSync(fd, buf, 0, buf.length, start);
      chunk = buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
    if (start > 0) {
      const firstNewline = chunk.indexOf("\n");
      chunk = firstNewline === -1 ? "" : chunk.slice(firstNewline + 1);
    }
  } catch {
    return []; // no journal yet
  }
  const out: StatusEventRecord[] = [];
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as StatusEventRecord;
      if (typeof rec.task === "string" && typeof rec.to === "string") out.push(rec);
    } catch {
      // skip unparseable lines
    }
  }
  return out;
}
