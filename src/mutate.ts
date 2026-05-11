import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "./frontmatter.ts";
import { now } from "./time.ts";
import { archiveTask, foldTask, isParent } from "./tree.ts";
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

export interface ReparentResult extends MutateResult {
  newPath: string;
  newSlug: string;
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
  let newBody = appendLog(body, `${now()}: opened PR ${trimmed}`);
  // Attaching a PR is the agent's handoff: next move is on the human
  // (review + merge). Flip in-progress -> needs-review so the task lands in
  // `tpm inbox`. Other statuses are left alone — needs-feedback means a
  // round is still in flight, needs-review/blocked are already on the
  // human side, terminal states shouldn't transition.
  const current = String(data.status ?? "");
  let flipped = false;
  if (current === "in-progress") {
    data.status = "needs-review";
    newBody = appendLog(newBody, `${now()}: status -> needs-review (PR opened, awaiting review)`);
    flipped = true;
  }
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  const suffix = flipped ? " — status -> needs-review" : "";
  return { message: `${task.slug}: linked ${trimmed}${suffix}` };
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

// Move a task to a new parent (or to top-level when newParent is null). Renumbers
// the file within its destination container, rewrites the `parent:` frontmatter,
// folds the new parent if it isn't already folder-form, and appends a Log line.
//
// Refusals (v0): can't reparent an archived task, a parent (would make grandchildren),
// or a folder-form task with supporting files (would orphan them — unfold/move manually).
// Can't reparent into a child, into self, into an archived parent, or to the same
// parent (no-op). Cross-project reparenting isn't supported here — the CLI resolves
// `<new-parent>` within the source task's project.
export function reparent(task: Task, newParent: Task | null): ReparentResult {
  guardArchived(task);
  if (isParent(task)) {
    throw new Error(`Cannot reparent ${task.slug}: it has children. Move or close them first.`);
  }
  if (task.dir) {
    throw new Error(`Cannot reparent folder-form task ${task.slug}: would orphan supporting files. Move manually.`);
  }
  if (newParent) {
    if (newParent.archived) {
      throw new Error(`Cannot reparent into archived parent: ${newParent.slug}`);
    }
    if (newParent.parent) {
      throw new Error(`Cannot reparent under "${newParent.slug}": it is itself a child. Only one level of nesting is supported.`);
    }
    if (newParent.path === task.path) {
      throw new Error(`Cannot reparent ${task.slug} into itself`);
    }
  }

  // tasksDir is <project>/tasks. For a top-level file it's dirname(task.path);
  // for a child it's the parent of the parent dir.
  const tasksDir = task.parent ? dirname(dirname(task.path)) : dirname(task.path);

  let destContainer: string;
  let destArchive: string;
  let parentSlugForFm: string | null = null;

  if (newParent) {
    if (!newParent.dir) {
      // Fold so the new parent has a directory to receive children. Update the
      // in-memory shape so subsequent reparents in the same process see it folded.
      foldTask(newParent);
      newParent.dir = join(tasksDir, newParent.slug);
      newParent.path = join(newParent.dir, "task.md");
    }
    destContainer = newParent.dir;
    destArchive = join(tasksDir, "archive", newParent.slug);
    parentSlugForFm = newParent.slug;
  } else {
    destContainer = tasksDir;
    destArchive = join(tasksDir, "archive");
  }

  const currentParent = task.parent ?? null;
  if (currentParent === parentSlugForFm) {
    const where = parentSlugForFm ? `a child of ${parentSlugForFm}` : "top-level";
    throw new Error(`${task.slug} is already ${where}`);
  }

  // Renumber: pick max(NNN) + 1 across the destination container and its archive
  // sibling, so we don't collide with an archived child that could be unarchived later.
  const baseSlug = task.slug.replace(/^\d{3,}-/, "");
  let max = 0;
  for (const dir of [destContainer, destArchive]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^(\d{3,})-/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  const nextNum = String(max + 1).padStart(3, "0");
  const newSlug = `${nextNum}-${baseSlug}`;
  const newPath = join(destContainer, `${newSlug}.md`);
  if (existsSync(newPath)) {
    throw new Error(`Cannot reparent ${task.slug}: destination ${newPath} already exists`);
  }

  const oldSlug = task.slug;
  const oldPath = task.path;
  const oldDesc = currentParent ? `under ${currentParent}` : "top-level";
  const newDesc = parentSlugForFm ? `under ${parentSlugForFm}` : "top-level";

  const { data, body } = readParsed(task);
  const newData = setParentField(data, parentSlugForFm);
  const newBody = appendLog(body, `${now()}: reparented from ${oldDesc} to ${newDesc} (${oldSlug} -> ${newSlug})`);

  mkdirSync(destContainer, { recursive: true });
  writeFileSync(newPath, stringify(newData, newBody));
  unlinkSync(oldPath);

  task.path = newPath;
  task.slug = newSlug;
  task.parent = parentSlugForFm ?? undefined;
  task.data = newData;
  task.body = newBody;

  return {
    message: `${oldSlug} -> ${newSlug} (${newDesc})`,
    newPath,
    newSlug,
  };
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

// Insert/replace/remove `parent:` while preserving the canonical key order
// (right after `project:`, mirroring how `tpm new task --parent` writes it).
function setParentField(
  data: Record<string, unknown>,
  parentSlug: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let inserted = false;
  for (const [k, v] of Object.entries(data)) {
    if (k === "parent") continue;
    out[k] = v;
    if (!inserted && parentSlug && k === "project") {
      out.parent = parentSlug;
      inserted = true;
    }
  }
  if (!inserted && parentSlug) out.parent = parentSlug;
  return out;
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
