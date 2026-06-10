import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, unlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "../util/frontmatter.ts";
import { now } from "../util/time.ts";
import { archiveTask, foldTask, isParent, taskHasReport, taskReportPath } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { REPORT_TEMPLATE } from "./defaults.ts";
import { validateType } from "./new.ts";

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

// `verb` overrides the Log line written on the ready -> in-progress flip.
// Default is the agent's self-claim ("started"); the orchestrator passes
// "claimed by orchestrator (spawning agent)" so the audit trail
// differentiates an orchestrator-side eager claim from the agent's own
// `tpm start`. Idempotent: re-calls on an already-in-progress task short-
// circuit before the verb is ever written.
export function start(task: Task, verb: string = "started"): MutateResult {
  return transition(task, "in-progress", verb, {
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

export function reopen(task: Task, reason?: string): MutateResult {
  const trimmed = reason?.trim();
  const verb = trimmed ? `reopened — ${trimmed}` : "reopened";
  return transition(task, "open", verb, {
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

// `verb` overrides the Log line. Default is the generic `status -> <new>`
// used by `tpm status` / `tpm poll`. The orchestrator's spawn-failure path
// passes a custom verb so the rollback log reads as a single coherent line
// ("claim failed: …; reverted to ready") instead of a generic flip.
export function setStatus(task: Task, newStatus: string, verb?: string): MutateResult {
  if (!isStatus(newStatus)) {
    throw new Error(`Unknown status: ${newStatus}. Valid: ${VALID_STATUSES.join(", ")}.`);
  }
  return transition(task, newStatus, verb ?? `status -> ${newStatus}`, { refusal: [] });
}

// Symmetric inverse of the inbox play-button promote: pull a queued — or
// running — task back into the human pile. Status-aware:
//   - ready          -> open          (operator wants to pause / reshape the Plan)
//   - in-progress    -> open          (stop a running task; pull it off the agent)
//   - needs-feedback -> needs-review  (escalate ambiguous agent signal to the human)
// Other statuses are refused — the caller (web or CLI) should hide / gate the
// button so a refusal only fires on a stale form replay.
//
// in-progress -> open vs `revert` (in-progress -> ready): pull yanks the task
// out of the autonomous loop entirely (open isn't claimable), whereas revert
// re-queues it for the next orchestrator tick. Pull is the operator's "stop and
// reshape" — revert is the orchestrator's "timed out, try again".
//
// Lock release (the in-progress case): like `drop`, we don't reach into the
// orchestrator's lock dir from here — mutate is the single-task-file layer with
// no root/agent-id context. The flip to a non-claimable status is enough: the
// queue gate never re-claims an `open` task, and the held lock files are freed
// by the run-completion path (the spawning orchestrator releases on exit) or
// the stale-TTL sweep (`releaseStaleTaskLocks`). The agent's process isn't
// killed — its in-flight work is simply no longer wanted; nothing downstream
// re-picks the task.
export function pullFromQueue(task: Task): MutateResult {
  guardArchived(task);
  const { data } = readParsed(task);
  const current = String(data.status ?? "");
  const target = current === "ready" || current === "in-progress"
    ? "open"
    : current === "needs-feedback"
      ? "needs-review"
      : null;
  if (!target) {
    throw new Error(`${task.slug}: pull only applies to ready / in-progress / needs-feedback (status=${current || "?"})`);
  }
  return transition(task, target, `pulled from queue (${current} -> ${target})`, { refusal: [] });
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
// Path semantics (task 094):
//   - The report is always `<task-folder>/report.md`. Single source of truth
//     on the filesystem — no `report:` frontmatter field. File-form tasks
//     are auto-folded so the folder exists to receive it.
//   - Child tasks can't have own reports (no per-task folder — would orphan
//     them from the parent folder loader). Reparent to top-level first.
//
// Behaviour:
//   - If the task is file-form, fold it (`tasks/<slug>.md` →
//     `tasks/<slug>/task.md`) so the report sits next to the task body.
//   - Creates `report.md` from `.tpm/templates/report.md` (or the built-in)
//     if it doesn't exist yet — agent gets a skeleton to fill in.
//   - Logs `opened report <relpath>` on first creation (or on the fold-then-
//     attach path where the file existed but wasn't co-located yet).
//   - Auto-flips `in-progress -> needs-review` (mirrors `addPr`), re-fires
//     on every call so a re-attach after a feedback round bounces the task
//     back into the human queue.
export function addReport(task: Task): MutateResult {
  guardArchived(task);
  if (task.parent) {
    throw new Error(
      `${task.slug}: child tasks can't have own reports — they live inside parent ${task.parent}'s folder. ` +
      `Reparent to top-level (\`tpm reparent ${task.slug} --top\`) or attach the report to the parent.`,
    );
  }
  const { data, body } = readParsed(task);

  // Legacy safety net: pre-folder-form-default tasks are file-form; fold so the
  // folder exists to receive `report.md`. No-op for new tasks (born folder-form).
  let folded = false;
  if (!task.dir) {
    const newPath = foldTask(task);
    task.path = newPath;
    task.dir = dirname(newPath);
    folded = true;
  }

  const absPath = taskReportPath(task);
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

  const relPath = projectRelativeReportPath(task);
  let newBody = body;
  let registered = false;
  if (createdFile || folded) {
    newBody = appendLog(newBody, `${now()}: opened report ${relPath}`);
    registered = true;
  }

  const current = String(data.status ?? "");
  let flipped = false;
  if (current === "in-progress") {
    data.status = "needs-review";
    newBody = appendLog(newBody, `${now()}: status -> needs-review (report attached, awaiting review)`);
    flipped = true;
  }

  // Skip the write when nothing changed: keep `tpm report <slug>` byte-
  // identical idempotent for re-runs that aren't actually advancing state.
  if (registered || flipped) {
    writeFileSync(task.path, stringify(data, newBody));
    syncInMemory(task, data, newBody);
  }

  const parts: string[] = [];
  if (createdFile) parts.push(`created ${relPath}`);
  else if (!flipped && !folded) parts.push(`report on file (${relPath})`);
  if (folded) parts.push("folded task");
  const summary = parts.length ? parts.join(", ") : `report on file (${relPath})`;
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
  if (!taskHasReport(task)) {
    throw new Error(`${task.slug}: no report attached. Run \`tpm report <slug>\` first.`);
  }
  const current = String(data.status ?? "");
  if (current !== "needs-review") {
    throw new Error(`${task.slug}: request-changes requires status=needs-review (current: ${current || "?"})`);
  }
  const absPath = taskReportPath(task);

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

// Path to the task's report.md relative to the project root — for log lines
// and operator-friendly messages. Mirror of taskReportPath's structure but
// rooted at `tasks/...` instead of an absolute path.
function projectRelativeReportPath(task: Task): string {
  // task.dir is set after the fold step in addReport; the report lives at
  // <task-dir>/report.md, so the project-relative path is tasks/<slug>/report.md.
  return join("tasks", task.slug, "report.md");
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

// Reclassify a task's `type:` (pr / investigation). Type drives
// close-out behavior (pr archives on done; investigation expects a report),
// so it's the kind of field an operator might want to correct after creation —
// hence a verb rather than hand-editing frontmatter. Validated against the same
// KNOWN_TASK_TYPES gate `tpm new` uses; idempotent on a no-op.
export function setType(task: Task, newType: string): MutateResult {
  guardArchived(task);
  validateType(newType);
  const { data, body } = readParsed(task);
  const current = String(data.type ?? "");
  if (current === newType) {
    return { message: `${task.slug}: type already ${newType}` };
  }
  data.type = newType;
  const newBody = appendLog(body, `${now()}: type ${current || "?"} -> ${newType}`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  return { message: `${task.slug}: type ${current || "?"} -> ${newType}` };
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
    : (type === "pr");
  if (!shouldArchive) {
    return { message: `${task.slug} -> done (kept at ${task.path})` };
  }
  const archivedAt = archiveTask(task);
  return { message: `${task.slug} -> done`, archivedAt };
}

// Drop a task: the terminal "abandoned, not finished" counterpart to
// `complete`. Flips status to `dropped`, stamps `closed`, and — when a reason
// is supplied — lands it in `## Outcome` (the drop IS the outcome) plus the
// `dropped — <reason>` Log line. Reasonless drops log a plain `dropped`,
// matching the block/reopen dash convention. Refuses already-terminal statuses
// (done is a different terminus; dropped is idempotent-clean like complete's
// already-done). Outcome is refuse-on-content, mirroring complete --outcome, so
// a drop reason never clobbers prose someone already wrote there.
//
// Lock release (the in-progress case): a human can drop a task while an agent
// holds its per-task + repo lock mid-run. We intentionally don't reach into the
// orchestrator's lock dir from here — mutate is the single-task-file layer and
// has no `root`/agent-id context. The flip to a terminal status is enough: the
// queue gate never re-claims a dropped task, and the held lock files are freed
// by the run-completion path (the spawning orchestrator releases on exit) or
// the stale-TTL sweep (`releaseStaleTaskLocks`). The agent's in-flight work is
// being discarded by design; nothing downstream acts on it.
export function drop(task: Task, reason?: string): MutateResult {
  guardArchived(task);
  const { data, body } = readParsed(task);
  const current = String(data.status ?? "");
  if (current === "dropped") {
    return { message: `${task.slug} is already dropped` };
  }
  if (current === "done") {
    throw new Error(`Cannot drop ${task.slug}: status is done`);
  }
  data.status = "dropped";
  data.closed = now();
  const trimmed = reason?.trim();
  let newBody = body;
  if (trimmed) {
    if (sectionHasContent(newBody, "Outcome")) {
      throw new Error(`${task.slug}: Outcome already has content. Edit the file directly, or drop without a reason.`);
    }
    newBody = setSection(newBody, "Outcome", trimmed);
  }
  newBody = appendLog(newBody, `${now()}: ${trimmed ? `dropped — ${trimmed}` : "dropped"}`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  return { message: `${task.slug} -> dropped` };
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
  // Folder-form source is always a top-level task (children are flat files).
  // Reparenting it to a child unfolds the folder: task.md becomes a flat sibling
  // inside the new parent. Refuse when the folder holds anything beyond task.md
  // (children, runs/, report.md) — unfolding would orphan those. Allow when
  // task.md is the sole occupant (the common case for a fresh folder-form task).
  const sourceDir = task.dir;
  if (sourceDir && newParent) {
    const extras = readdirSync(sourceDir).filter(e => e !== "task.md" && !e.startsWith("."));
    if (extras.length > 0) {
      throw new Error(
        `Cannot reparent folder-form task ${task.slug} to a child: it has supporting files (${extras.join(", ")}). Move manually.`,
      );
    }
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

  // tasksDir is <project>/tasks. Child: parent of the parent dir. Folder-form
  // top-level: parent of the task's own folder. File-form top-level: dirname(path).
  const tasksDir = task.parent
    ? dirname(dirname(task.path))
    : sourceDir
      ? dirname(sourceDir)
      : dirname(task.path);

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
  if (sourceDir) {
    // Unfolded a folder-form source: task.md was the sole occupant, so drop the
    // now-stale source folder wholesale (oldPath lived inside it).
    rmSync(sourceDir, { recursive: true, force: true });
  } else {
    unlinkSync(oldPath);
  }

  task.path = newPath;
  task.slug = newSlug;
  task.parent = parentSlugForFm ?? undefined;
  task.dir = undefined;
  task.data = newData;
  task.body = newBody;

  return {
    message: `${oldSlug} -> ${newSlug} (${newDesc})`,
    newPath,
    newSlug,
  };
}

// Inline-editor write path for `tpm serve` (task 121). Edits the title
// (frontmatter) or one of the prose body sections — Context / Plan /
// Outcome. `## Log` is intentionally not editable: it is append-only via
// `tpm log` so the audit trail can't be rewritten through the UI. Other
// frontmatter fields (status, type, parent, prs, allow_orchestrator, tags)
// stay managed by the existing verbs / buttons; this verb is for human
// prose only, not status mutation.
//
// Concurrency: when `expectMtimeMs` is provided, refuses the write if the
// file's mtime has moved since the operator loaded the editor. The form
// embeds the render-time mtime; a mismatch means a concurrent edit (or an
// orchestrator-spawn log line) landed between view and save — the operator
// reloads, sees the fresh content, re-edits. Skips the write and the Log
// line entirely when the proposed body is byte-identical to the current
// one, so an accidental Save on an unchanged value doesn't churn mtime.
export interface EditOptions {
  expectMtimeMs?: number;
}

const EDIT_SECTION_CANON: Record<string, string> = {
  title: "title",
  context: "Context",
  plan: "Plan",
  outcome: "Outcome",
};

export function editTaskSection(
  task: Task,
  section: string,
  value: string,
  opts: EditOptions = {},
): MutateResult {
  guardArchived(task);
  const canonical = EDIT_SECTION_CANON[section.toLowerCase()];
  if (!canonical) {
    throw new Error(
      `Unknown editable section: "${section}". Choose one of: title, Context, Plan, Outcome.`,
    );
  }
  if (opts.expectMtimeMs !== undefined) {
    const current = statSync(task.path).mtimeMs;
    // Sub-ms epsilon: some filesystems quantize mtime to the second across
    // a stat round-trip, but a real concurrent edit moves it by many ms.
    if (Math.abs(current - opts.expectMtimeMs) > 5) {
      throw new Error(
        `${task.slug}: file changed since the editor was loaded (concurrent edit). Reload and try again.`,
      );
    }
  }
  const { data, body } = readParsed(task);
  if (canonical === "title") {
    const oldTitle = typeof data.title === "string" ? data.title : "";
    if (oldTitle === value) {
      return { message: `${task.slug}: title unchanged` };
    }
    data.title = value;
    const newBody = appendLog(body, `${now()}: edited title (via serve)`);
    writeFileSync(task.path, stringify(data, newBody));
    syncInMemory(task, data, newBody);
    return { message: `${task.slug}: edited title` };
  }
  const proposedBody = setSection(body, canonical, value);
  if (proposedBody === body) {
    return { message: `${task.slug}: ${canonical} unchanged` };
  }
  const newBody = appendLog(proposedBody, `${now()}: edited ${canonical} (via serve)`);
  writeFileSync(task.path, stringify(data, newBody));
  syncInMemory(task, data, newBody);
  return { message: `${task.slug}: edited ${canonical}` };
}

// Project analogue of `editTaskSection` (task 124). Edits the project name
// (frontmatter) or one of the prose body sections — Goal / Context / Notes.
// `## Log` stays append-only (project-level timeline), so it isn't offered as
// an editable section here. Projects aren't archived the way tasks are, so
// there's no guardArchived gate; the mtime optimistic-concurrency check is the
// same as the task editor's (the serve form stamps render-time mtime).
const EDIT_PROJECT_SECTION_CANON: Record<string, string> = {
  name: "name",
  goal: "Goal",
  context: "Context",
  notes: "Notes",
};

export function editProjectSection(
  project: Project,
  section: string,
  value: string,
  opts: EditOptions = {},
): MutateResult {
  const canonical = EDIT_PROJECT_SECTION_CANON[section.toLowerCase()];
  if (!canonical) {
    throw new Error(
      `Unknown editable project section: "${section}". Choose one of: name, Goal, Context, Notes.`,
    );
  }
  if (opts.expectMtimeMs !== undefined) {
    const current = statSync(project.path).mtimeMs;
    if (Math.abs(current - opts.expectMtimeMs) > 5) {
      throw new Error(
        `${project.slug}: file changed since the editor was loaded (concurrent edit). Reload and try again.`,
      );
    }
  }
  const { data, body } = parse(readFileSync(project.path, "utf8"));
  if (canonical === "name") {
    const oldName = typeof data.name === "string" ? data.name : "";
    if (oldName === value) {
      return { message: `${project.slug}: name unchanged` };
    }
    data.name = value;
    const newBody = appendProjectLog(body, `${now()}: edited name (via serve)`);
    writeFileSync(project.path, stringify(data, newBody));
    project.data = data;
    project.body = newBody;
    return { message: `${project.slug}: edited name` };
  }
  const proposedBody = setSection(body, canonical, value);
  if (proposedBody === body) {
    return { message: `${project.slug}: ${canonical} unchanged` };
  }
  const newBody = appendProjectLog(proposedBody, `${now()}: edited ${canonical} (via serve)`);
  writeFileSync(project.path, stringify(data, newBody));
  project.data = data;
  project.body = newBody;
  return { message: `${project.slug}: edited ${canonical}` };
}

// Append a project-level Log line. Projects scaffolded from the template carry
// a `## Log` section, but older or hand-rolled `project.md` files may not — in
// that case appendLog would throw on the missing section, so seed an empty Log
// at the end of the body first. Keeps the edit audit trail intact regardless of
// how the file was created.
function appendProjectLog(body: string, line: string): string {
  if (!/^##\s+Log\s*$/m.test(body)) {
    const trimmed = body.replace(/\s+$/, "");
    body = `${trimmed}\n\n## Log\n`;
  }
  return appendLog(body, line);
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
  let newBody = appendLog(body, `${now()}: ${logVerb}`);
  // Landing at `ready` means "shaped and queued" — default it autonomous-
  // eligible so the common promote-and-walk-away case is one action (the
  // orchestrator gate in queue.ts flips on with the same call). Every path
  // that lands here funnels through transition, so `ready`, `revert`, and
  // `setStatus ready` all inherit it. Supervised-only stays expressible via
  // `tpm disallow` afterward. Parents aren't claimable (mirror
  // setAllowOrchestrator's refusal); log only on a real change so re-promotes
  // and already-eligible tasks stay quiet.
  if (target === "ready" && !isParent(task) && data.allow_orchestrator !== true) {
    data.allow_orchestrator = true;
    newBody = appendLog(newBody, `${now()}: allow_orchestrator: true (set on ready)`);
  }
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
