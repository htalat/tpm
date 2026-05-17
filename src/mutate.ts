import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parse, stringify } from "./frontmatter.ts";
import { now } from "./time.ts";
import { archiveTask, foldTask, isParent } from "./tree.ts";
import type { Task } from "./tree.ts";
import { REPORT_TEMPLATE } from "./defaults.ts";

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
  const terminus = flipped
    ? "\n✓ PR opened. Your turn is complete — exit. The poller closes the task when the PR merges; do not poll CI from this run."
    : "";
  return { message: `${task.slug}: linked ${trimmed}${suffix}${terminus}` };
}

// Attach a report artifact to a task: the investigation-flow analogue of
// `addPr`. The deliverable for a `type: investigation` task is a written
// report file (not a PR), so the agent's "your turn is over" signal is
// running `tpm report <slug>` once the report is written.
//
// Path semantics:
//   - Stored in frontmatter as a path relative to the project root
//     (`reports/<slug>.md` for top-level tasks, `reports/<parent>/<child>.md`
//     for children).
//   - If `path` is omitted, defaults to the convention above.
//   - If `path` is provided, it's accepted relative to the project root
//     (absolute paths are normalized to relative when under the project root,
//     otherwise stored as-is — the agent knows what it's doing).
//
// Behaviour:
//   - Creates the report file from `.tpm/templates/report.md` (or the
//     built-in) if it doesn't exist yet — agent gets a skeleton to fill in.
//   - Sets `report:` in the task frontmatter, idempotent on equal paths.
//     Refuses to switch an existing `report:` to a different path (would
//     orphan the prior file).
//   - Logs `opened report <path>` on the first attach.
//   - Auto-flips `in-progress -> needs-review` (mirrors `addPr`), re-fires
//     on every call so a re-attach after a feedback round bounces the task
//     back into the human queue.
export function addReport(task: Task, pathArg?: string): MutateResult {
  guardArchived(task);
  const { data, body } = readParsed(task);

  const projectDir = projectDirForTask(task);
  const defaultRelPath = defaultReportRelPath(task);
  const inputRel = pathArg && pathArg.trim().length > 0
    ? normalizeReportPath(pathArg.trim(), projectDir)
    : defaultRelPath;

  const existing = typeof data.report === "string" ? data.report.trim() : "";
  if (existing.length > 0 && existing !== inputRel) {
    throw new Error(
      `${task.slug}: report already set to "${existing}". Edit the file directly or clear the field to re-attach.`,
    );
  }

  const absPath = isAbsolute(inputRel) ? inputRel : join(projectDir, inputRel);
  let createdFile = false;
  if (!existsSync(absPath)) {
    mkdirSync(dirname(absPath), { recursive: true });
    const title = typeof data.title === "string" && data.title.length
      ? data.title
      : task.slug;
    const rendered = REPORT_TEMPLATE.replace(/\{\{title\}\}/g, title);
    writeFileSync(absPath, rendered);
    createdFile = true;
  }

  let newBody = body;
  let registered = false;
  if (existing !== inputRel) {
    data.report = inputRel;
    newBody = appendLog(newBody, `${now()}: opened report ${inputRel}`);
    registered = true;
  }

  const current = String(data.status ?? "");
  let flipped = false;
  if (current === "in-progress") {
    data.status = "needs-review";
    newBody = appendLog(newBody, `${now()}: status -> needs-review (report attached, awaiting review)`);
    flipped = true;
  }

  // Skip the write when nothing changed (already-set path, non-in-progress
  // status, file already on disk): keep `tpm report <slug>` byte-identical
  // idempotent for re-runs that aren't actually advancing state.
  if (registered || flipped) {
    writeFileSync(task.path, stringify(data, newBody));
    syncInMemory(task, data, newBody);
  }

  const parts: string[] = [];
  if (createdFile) parts.push(`created ${inputRel}`);
  if (registered) parts.push(`linked ${inputRel}`);
  else if (!flipped) parts.push(`already linked (${inputRel})`);
  const summary = parts.length ? parts.join(", ") : `report on file (${inputRel})`;
  const suffix = flipped ? " — status -> needs-review" : "";
  const terminus = flipped
    ? "\n✓ Report attached. Your turn is complete — exit. A reviewer LGTMs or requests changes via `tpm serve`."
    : "";
  return { message: `${task.slug}: ${summary}${suffix}${terminus}` };
}

// Append a reviewer-feedback block to the report artifact and log the
// request on the task body. Powers `tpm serve`'s "Request changes" button:
//   - Flips needs-review -> needs-feedback so the agent re-picks the task.
//   - Appends `## Reviewer feedback` to the report file with a timestamped
//     entry (single artifact = full round-trip history).
//   - Logs a one-line pointer on the task body Log section.
// The report file must already exist (set by a prior `tpm report` call) —
// requesting changes on a task with no report is a user error.
export function requestReportChanges(task: Task, comment: string): MutateResult {
  guardArchived(task);
  if (!comment || !comment.trim()) {
    throw new Error("tpm: request-changes requires a comment");
  }
  const { data, body } = readParsed(task);
  const reportRel = typeof data.report === "string" ? data.report.trim() : "";
  if (!reportRel) {
    throw new Error(`${task.slug}: no report attached. Run \`tpm report <slug>\` first.`);
  }
  const current = String(data.status ?? "");
  if (current !== "needs-review") {
    throw new Error(`${task.slug}: request-changes requires status=needs-review (current: ${current || "?"})`);
  }
  const projectDir = projectDirForTask(task);
  const absPath = isAbsolute(reportRel) ? reportRel : join(projectDir, reportRel);
  if (!existsSync(absPath)) {
    throw new Error(`${task.slug}: report file missing at ${absPath}`);
  }

  const trimmedComment = comment.trim();
  const stamp = now();
  const block = `\n- ${stamp}: ${trimmedComment}\n`;
  const reportText = readFileSync(absPath, "utf8");
  const updatedReport = reportText.includes("## Reviewer feedback")
    ? appendUnderReviewerFeedback(reportText, block)
    : `${reportText.replace(/\s+$/, "")}\n\n## Reviewer feedback\n${block}`;
  writeFileSync(absPath, updatedReport);

  data.status = "needs-feedback";
  const firstLine = trimmedComment.split(/\r?\n/, 1)[0];
  let newBody = appendLog(body, `${stamp}: review requested — ${firstLine}`);
  newBody = appendLog(newBody, `${stamp}: status -> needs-feedback (review requested)`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  return { message: `${task.slug}: review requested — status -> needs-feedback` };
}

// Project root for a task. `task.dir` is set on folder-form parents;
// otherwise the path layout tells us how many directories to walk up:
//   - top-level file: <root>/<project>/tasks/NNN-slug.md
//   - child of parent: <root>/<project>/tasks/NNN-parent/NNN-child.md
//   - folder-form parent: <root>/<project>/tasks/NNN-slug/task.md (task.dir set)
function projectDirForTask(task: Task): string {
  if (task.dir) return dirname(dirname(task.dir));
  if (task.parent) return dirname(dirname(dirname(task.path)));
  return dirname(dirname(task.path));
}

// Default `reports/...` path under the project root. Children of folder-form
// parents land at `reports/<parent>/<child>.md` to mirror the task tree
// layout; everything else (top-level file, top-level folder-form parent)
// lands at `reports/<slug>.md`.
function defaultReportRelPath(task: Task): string {
  if (task.parent) return join("reports", task.parent, `${task.slug}.md`);
  return join("reports", `${task.slug}.md`);
}

function normalizeReportPath(input: string, projectDir: string): string {
  if (!isAbsolute(input)) return input;
  const rel = relative(projectDir, input);
  // Inside the project tree → store relative; outside → keep absolute (caller
  // knows where they want the file). `relative` returns `..` segments for
  // out-of-tree paths, which is the cue.
  if (rel.startsWith("..")) return input;
  return rel;
}

// Derive an Outcome line from a report's contents: the first heading (sans
// `#`) + the first non-empty paragraph beneath it, with HTML comments and
// the auto-appended `## Reviewer feedback` round-trip section stripped.
// Mirrors task 045's PR auto-Outcome shape (title + first body line) so the
// LGTM close-out looks the same in `## Outcome` whether the deliverable was
// a PR or a report.
export function deriveReportOutcome(reportText: string): string {
  // Drop the reviewer-feedback section before scanning — that's review
  // round-trip, not part of the headline finding.
  const trimmedReport = reportText.replace(/\n##\s+Reviewer feedback[\s\S]*$/i, "");
  const lines = trimmedReport.split(/\r?\n/);
  let title = "";
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.+?)\s*$/);
    if (m) { title = m[1].trim(); i++; break; }
  }
  const paragraph: string[] = [];
  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith("##")) break;
    // Skip lines that are nothing but an HTML comment.
    const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!stripped.length) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(stripped);
  }
  const body = paragraph.join(" ").trim();
  if (title && body) return `${title} — ${body}`;
  if (title) return title;
  if (body) return body;
  return "Report attached.";
}

function appendUnderReviewerFeedback(text: string, block: string): string {
  // Find `## Reviewer feedback` and insert the new block at the end of that
  // section (just before the next `## ` heading, or at EOF).
  const re = /(##\s+Reviewer feedback\s*\n)([\s\S]*?)(?=\n##\s+|$)/;
  return text.replace(re, (_, heading: string, content: string) => {
    const trimmed = content.replace(/\s+$/, "");
    const sep = trimmed.length > 0 ? "\n" : "";
    return `${heading}${trimmed}${sep}${block}`;
  });
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
