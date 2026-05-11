import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "./frontmatter.ts";
import { now } from "./time.ts";
import { archiveTask, isParent } from "./tree.ts";
import type { Task } from "./tree.ts";

export const VALID_STATUSES = [
  "open",
  "ready",
  "in-progress",
  "needs-feedback",
  "needs-close",
  "needs-review",
  "blocked",
  "done",
  "dropped",
] as const;
export type Status = typeof VALID_STATUSES[number];

export interface MutateResult {
  message: string;
  archivedAt?: string;
}

export interface CompleteOptions {
  outcome?: string;
  archive?: boolean;
}

// ---- public verbs ---------------------------------------------------------

export function start(task: Task): MutateResult {
  return transition(task, "in-progress", "started", {
    refusal: ["done", "dropped"],
  });
}

export function ready(task: Task): MutateResult {
  return transition(task, "ready", "promoted to ready", {
    refusal: ["done", "dropped"],
  });
}

export function block(task: Task, reason: string): MutateResult {
  if (!reason || !reason.trim()) {
    throw new Error("tpm block requires a reason");
  }
  return transition(task, "blocked", `blocked — ${reason.trim()}`, {
    refusal: ["done", "dropped"],
  });
}

export function reopen(task: Task): MutateResult {
  return transition(task, "open", "reopened", {
    refusal: [],
  });
}

// Revert an in-progress task back to ready — used when the orchestrator
// times out a run. No-op (idempotent) if status isn't `in-progress`, so the
// orchestrator wrapper can call it unconditionally on the timeout path.
export function revert(task: Task, reason?: string): MutateResult {
  guardArchived(task);
  const { data } = readParsed(task);
  const current = String(data.status ?? "");
  if (current !== "in-progress") {
    return { message: `${task.slug} not in-progress (status=${current || "?"}); revert is a no-op` };
  }
  const trimmed = reason?.trim();
  const verb = trimmed ? `timed out — reverted to ready (${trimmed})` : "timed out — reverted to ready";
  return transition(task, "ready", verb, { refusal: ["done", "dropped"] });
}

export function setStatus(task: Task, newStatus: string): MutateResult {
  if (!isStatus(newStatus)) {
    throw new Error(`Unknown status: ${newStatus}. Valid: ${VALID_STATUSES.join(", ")}.`);
  }
  // Generic setter: log a neutral message.
  return transition(task, newStatus, `status -> ${newStatus}`, { refusal: [] });
}

export function logEntry(task: Task, message: string): MutateResult {
  if (!message || !message.trim()) {
    throw new Error("tpm log requires a message");
  }
  guardArchived(task);
  const { data, body } = readParsed(task);
  const newBody = appendLog(body, `${now()}: ${message.trim()}`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  return { message: `logged on ${task.slug}` };
}

export function addPr(task: Task, url: string): MutateResult {
  if (!url || !url.trim()) {
    throw new Error("tpm pr requires a URL");
  }
  guardArchived(task);
  const trimmed = url.trim();
  const { data, body } = readParsed(task);
  const existing = Array.isArray(data.prs) ? (data.prs as unknown[]).map(String) : [];
  if (existing.includes(trimmed)) {
    return { message: `${task.slug}: PR already linked (${trimmed})` };
  }
  data.prs = [...existing, trimmed];
  const newBody = appendLog(body, `${now()}: opened PR ${trimmed}`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  return { message: `${task.slug}: linked ${trimmed}` };
}

// Toggle the autonomous-orchestrator gate on a task. Parents aren't claimable
// by the orchestrator, so toggling on a container is meaningless — refuse.
export function setAllowOrchestrator(task: Task, allow: boolean): MutateResult {
  guardArchived(task);
  if (isParent(task)) {
    throw new Error(`Cannot toggle allow_orchestrator on parent ${task.slug}: parents aren't claimable.`);
  }
  const { data, body } = readParsed(task);
  const current = data.allow_orchestrator === true;
  if (current === allow) {
    return { message: `${task.slug}: allow_orchestrator already ${allow}` };
  }
  data.allow_orchestrator = allow;
  const verb = allow
    ? "allow_orchestrator: true (safe for autonomous runs)"
    : "allow_orchestrator: false";
  const newBody = appendLog(body, `${now()}: ${verb}`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  return { message: `${task.slug}: allow_orchestrator -> ${allow}` };
}

export function complete(task: Task, opts: CompleteOptions = {}): MutateResult {
  guardArchived(task);
  const { data, body } = readParsed(task);
  const current = String(data.status ?? "");
  if (current === "done") {
    return { message: `${task.slug} is already done` };
  }
  if (current === "dropped") {
    throw new Error(`Cannot complete ${task.slug}: status is dropped`);
  }
  data.status = "done";
  data.closed = now();
  let newBody = body;
  if (opts.outcome !== undefined) {
    if (sectionHasContent(newBody, "Outcome")) {
      throw new Error(`${task.slug}: Outcome already has content. Edit the file directly, or omit --outcome.`);
    }
    newBody = setSection(newBody, "Outcome", opts.outcome);
  }
  newBody = appendLog(newBody, `${now()}: closed`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);

  const type = String(data.type ?? "");
  const shouldArchive = opts.archive !== undefined
    ? opts.archive
    : (type === "pr" || type === "chore");
  if (!shouldArchive) {
    return { message: `${task.slug} -> done (kept at ${task.path})` };
  }
  const archivedAt = archiveTask(task);
  return { message: `${task.slug} -> done`, archivedAt };
}

// ---- internals ------------------------------------------------------------

interface TransitionOpts {
  refusal: readonly string[]; // current statuses from which the transition is invalid
}

function transition(task: Task, target: Status, logVerb: string, opts: TransitionOpts): MutateResult {
  guardArchived(task);
  const { data, body } = readParsed(task);
  const current = String(data.status ?? "");
  if (current === target) {
    return { message: `${task.slug} is already ${target}` };
  }
  if (opts.refusal.includes(current)) {
    throw new Error(`Cannot transition ${task.slug} from "${current}" to "${target}".`);
  }
  data.status = target;
  if (target !== "done" && data.closed) {
    // Reopening an in-place task: clear the closed stamp.
    data.closed = null;
  }
  const newBody = appendLog(body, `${now()}: ${logVerb}`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  return { message: `${task.slug} -> ${target}` };
}

function guardArchived(task: Task): void {
  if (task.archived) {
    throw new Error(`Cannot mutate archived task: ${task.slug}. Use the file directly if you really need to.`);
  }
}

function readParsed(task: Task): { data: Record<string, unknown>; body: string } {
  const text = readFileSync(task.path, "utf8");
  return parse(text);
}

function syncInMemory(task: Task, data: Record<string, unknown>, body: string): void {
  // Keep the in-memory Task in step so chained operations (e.g. archive after complete)
  // see the new state.
  task.data = data;
  task.body = body;
}

function isStatus(s: string): s is Status {
  return (VALID_STATUSES as readonly string[]).includes(s);
}

// ---- body section helpers -------------------------------------------------

interface Header { name: string; start: number; end: number }

function findHeaders(body: string): Header[] {
  const re = /^## (.+?)\s*$/gm;
  const out: Header[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function sectionBounds(body: string, name: string): { contentStart: number; contentEnd: number } {
  const headers = findHeaders(body);
  const idx = headers.findIndex(h => h.name === name);
  if (idx < 0) throw new Error(`Task body missing ## ${name} section`);
  let contentStart = headers[idx].end;
  if (body[contentStart] === "\n") contentStart++;
  const next = headers[idx + 1];
  const contentEnd = next ? next.start : body.length;
  return { contentStart, contentEnd };
}

export function appendLog(body: string, line: string): string {
  const { contentStart, contentEnd } = sectionBounds(body, "Log");
  const content = body.slice(contentStart, contentEnd);
  // Strip trailing whitespace from content, preserve everything before the next section.
  const trimmed = content.replace(/\s+$/, "");
  const tail = body.slice(contentEnd); // either "" or "\n## NextSection..." etc.
  // Reassemble: trimmed + new line + a blank-line separator before next section (if any).
  const separator = tail.length > 0 ? "\n\n" : "\n";
  const newContent = (trimmed ? trimmed + "\n" : "") + `- ${line}` + separator;
  return body.slice(0, contentStart) + newContent + tail;
}

export function setSection(body: string, name: string, text: string): string {
  const { contentStart, contentEnd } = sectionBounds(body, name);
  const tail = body.slice(contentEnd);
  const trimmed = text.replace(/\s+$/, "");
  const separator = tail.length > 0 ? "\n\n" : "\n";
  const newContent = (trimmed.length > 0 ? trimmed : "") + separator;
  return body.slice(0, contentStart) + newContent + tail;
}

export function sectionHasContent(body: string, name: string): boolean {
  const { contentStart, contentEnd } = sectionBounds(body, name);
  const content = body.slice(contentStart, contentEnd);
  // Strip whitespace, HTML comments (the placeholder), and check for any remaining text.
  const stripped = content.replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped.length > 0;
}
