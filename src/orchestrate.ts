import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { findRoot } from "./root.ts";
import { loadProjects, taskHasReport } from "./tree.ts";
import { selectCandidates } from "./queue.ts";
import { findTask } from "./resolve.ts";
import * as mutate from "./mutate.ts";
import * as lock from "./lock.ts";
import { readConfig, DEFAULT_TIME_BOUND_MINUTES } from "./config.ts";
import { logLine as sharedLogLine, type LogLevel } from "./log.ts";
import { shouldNotify, fireNotification } from "./notify.ts";
import { context as buildBriefing, resolveRepo, type Repo } from "./context.ts";
import { hostFor } from "./pr_signal.ts";
import { resolveSameRepoStrategy, worktreePath, worktreeBranch } from "./strategy.ts";
import { prepareRunLogPath, formatRunLogHeader } from "./run_log.ts";
import { resolveAgentCli, type AgentCli } from "./agent_cli.ts";
import type { Project, Task } from "./tree.ts";

export interface ResolveTimeBoundInput {
  task: Task;
  project: Project;
}

// Cascade: task > project > global config > built-in default (30m).
// Frontmatter values that aren't positive integers are silently ignored — the
// strict caller is config.ts (rejects bad global) and the looser callers are
// frontmatter (where we'd rather fall through than fail a long-running cron).
export function resolveTimeBound(input: ResolveTimeBoundInput, globalMinutes?: number): number {
  const t = posInt(input.task.data.time_bound_minutes);
  if (t !== null) return t;
  const p = posInt(input.project.data.time_bound_minutes);
  if (p !== null) return p;
  if (globalMinutes !== undefined && Number.isInteger(globalMinutes) && globalMinutes > 0) {
    return globalMinutes;
  }
  return DEFAULT_TIME_BOUND_MINUTES;
}

function posInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  return null;
}

// Did the spawned agent move the task forward? Classification happens after
// the child exits, against a snapshot of the task taken before the spawn.
//
//   shipped  — the agent delivered: prs grew, status reached a delivery state
//              (needs-review, needs-close, done, dropped, blocked), or the task
//              disappeared from the live tree (archived mid-run by the poller).
//              Credited regardless of exit code — a SIGTERM at the time bound
//              after `tpm pr` is a *timing* signal, not a *delivery* signal.
//   stalled  — exit 0 but the task didn't make meaningful progress. Includes
//              the case where the agent flipped to `in-progress` from `ready`
//              or `needs-feedback` and exited without opening a PR or further
//              advancing — that flip is `tpm start`'s entry, not progress.
//              The case the "ship the smaller change" rule is meant to
//              eliminate; worth counting.
//   timeout  — exit 124 (the runWithTimeout convention) without a shipped flip.
//              Real "the agent ran out the clock without delivering".
//   terminal — task hit a terminal state externally (done/dropped/archived)
//              while the agent was still running; orchestrator SIGTERMed it
//              early so we don't burn the rest of the time bound.
//   failed   — any other non-zero exit.
export type Disposition = "shipped" | "stalled" | "timeout" | "terminal" | "failed";

export interface DispositionSnapshot {
  status: string;
  prs: number;
  // Whether the task has a `report.md` in its task folder (task 094 — was a
  // `report:` frontmatter field before that). Investigation deliverables
  // (task 080) ship as a report artifact, not a PR — the empty→set
  // transition is the same "shipped" signal as a PR count increase. Older
  // snapshots without this field treat it as false; callers should always
  // pass it explicitly post-080.
  report?: boolean;
}

export interface ClassifyDispositionInput {
  exitCode: number;
  before: DispositionSnapshot;
  // null when the task can't be re-resolved after the run (archived/moved).
  after: DispositionSnapshot | null;
  // Set when runWithTimeout killed the child early because the task hit a
  // terminal state mid-run. Distinguishes from a hard time-bound timeout.
  terminationReason?: "timeout" | "early-term";
}

// Statuses that signal the agent delivered something this run. Excludes
// `in-progress` (still mid-work), `ready` (self-revert handing back to the
// queue), `needs-feedback` (round incomplete — more agent work needed), and
// `open` (pre-shaping).
const DELIVERY_STATES = new Set([
  "needs-review",
  "needs-close",
  "done",
  "dropped",
  "blocked",
]);

export function classifyDisposition(input: ClassifyDispositionInput): Disposition {
  if (input.terminationReason === "early-term") return "terminal";
  if (input.exitCode !== 0 && input.exitCode !== 124) return "failed";

  const after = input.after;
  // Task gone from the tree — poller archived it mid-run. Definitively shipped
  // externally, regardless of exit code.
  if (!after) return "shipped";

  const prsGrew = after.prs > input.before.prs;
  const reportAppeared = (after.report ?? false) && !(input.before.report ?? false);
  const statusChanged = after.status !== input.before.status;
  // `tpm start` flips `ready -> in-progress` or `needs-feedback -> in-progress`
  // on entry. Without further progress (no PR, no report, no delivery-state
  // advance), that's claim-not-progress — per task 064.
  const entryFlip =
    after.status === "in-progress" &&
    (input.before.status === "ready" || input.before.status === "needs-feedback") &&
    !prsGrew &&
    !reportAppeared;
  // Did the agent ship? PR opened, report attached, or status reached a
  // delivery state.
  const shippedFlip =
    !entryFlip && (prsGrew || reportAppeared || (statusChanged && DELIVERY_STATES.has(after.status)));

  // Delivery wins over timeout: the 057 trace was `status=ready->needs-review
  // prs=0->1 exit=124` and got reported as `timeout`. Per task 068, that's the
  // symmetric inverse of 064 — the agent shipped, then lingered past the time
  // bound. Headline disposition should track what landed, not the SIGTERM.
  if (shippedFlip) return "shipped";
  if (input.exitCode === 124) return "timeout";
  // Exit 0 with no shipped flip. Entry-flip and no-change collapse to stalled;
  // non-delivery status changes (e.g., `in-progress -> ready` self-revert) keep
  // the prior "any movement counts" behavior.
  if (entryFlip || !statusChanged) return "stalled";
  return "shipped";
}

// Does the task look like it has hit a terminal state externally? Returns the
// reason string ("archived" / "done" / "dropped") or null if the orchestrator
// should keep running. `needs-close` is *not* terminal — it's a transient
// state the poller sets just before its inline auto-close, and killing the
// agent during that window would race the close-out for no benefit.
export type TerminalReason = "archived" | "done" | "dropped";

export function evaluateTerminalState(task: Task | null): TerminalReason | null {
  if (task === null) return "archived";
  const status = String(task.data.status ?? "");
  if (status === "done") return "done";
  if (status === "dropped") return "dropped";
  return null;
}

export function formatDispositionLine(
  slug: string,
  disposition: Disposition,
  exitCode: number,
  before: DispositionSnapshot,
  after: DispositionSnapshot | null,
): string {
  const afterStatus = after?.status ?? "?";
  const afterPrs = after?.prs ?? before.prs;
  const beforeReport = before.report ?? false;
  const afterReport = (after?.report ?? before.report) ?? false;
  // Append a `report=<before>-><after>` field only when at least one side
  // is true — keeps the line schema unchanged for PR-shaped tasks where no
  // report has ever been attached.
  const reportField = beforeReport || afterReport
    ? ` report=${reportFlag(beforeReport)}->${reportFlag(afterReport)}`
    : "";
  return `disposition ${slug} ${disposition} exit=${exitCode} status=${before.status}->${afterStatus} prs=${before.prs}->${afterPrs}${reportField}`;
}

function reportFlag(set: boolean): string {
  return set ? "set" : "empty";
}

export interface AutoRevertInput {
  exitCode: number;
  before: DispositionSnapshot;
  after: DispositionSnapshot | null;
  terminationReason?: "timeout" | "early-term";
}

// Should the orchestrator auto-revert a task that the agent stranded at
// `in-progress`? The skill rule (per task 063) says agents must never exit
// while a task is in-progress — they should ship (`tpm pr` / `tpm complete`),
// revert (`tpm revert`), or block (`tpm block`). This predicate is the safety
// net for agents that don't follow the rule.
//
// Only true when:
//   - the child exited cleanly (exit 0, no orchestrator-initiated SIGTERM)
//   - the task still exists in the tree (wasn't archived)
//   - status is `in-progress` after the run
//   - prs count didn't grow (a PR opened would have flipped to needs-review)
//   - report.md didn't appear (a report attach would have flipped to needs-review)
//   - `before.status` wasn't `needs-feedback` — a feedback round legitimately
//     ends at `in-progress` with unchanged prs after addressing CI/threads.
export function shouldAutoRevert(input: AutoRevertInput): boolean {
  if (input.exitCode !== 0) return false;
  if (input.terminationReason) return false;
  if (!input.after) return false;
  if (input.after.status !== "in-progress") return false;
  if (input.after.prs !== input.before.prs) return false;
  if ((input.after.report ?? false) && !(input.before.report ?? false)) return false;
  if (input.before.status === "needs-feedback") return false;
  return true;
}

// Compose the agent prompt: a non-interactive preamble, the full task briefing,
// then the execution rules that used to live in the tpm skill's "Start a task"
// section. Inlining them here means the agent doesn't have to discover the
// skill, load ~3000 tokens of SKILL.md, or run `tpm context` itself before
// starting work — the orchestrator path only needs the "execute a ready task"
// mode.
//
// The preamble (task 085) leads because a non-interactive run has no human on
// the other end — every "which should I do?" question in the agent's output is
// structurally a halt. Placing the rule above the briefing means it's the
// first thing the agent reads, not the last.
//
// `<slug>` / `<url>` / `<reason>` are left as placeholders; the briefing names
// the qualified slug, and SKILL.md uses the same placeholder convention.
export interface ExecutionPromptOpts {
  // Set when the orchestrator's fresh-main precondition ran successfully
  // (task 118): tells the agent it's already on a fresh `main`, so it can
  // skip the habitual `git checkout main && git pull --ff-only` and branch
  // directly. Omitted (the common manual-CLI test path) leaves the prompt
  // unchanged.
  freshMain?: boolean;
}

export function buildExecutionPrompt(briefing: string, opts: ExecutionPromptOpts = {}): string {
  const freshMainNote = opts.freshMain
    ? `\n\nThe orchestrator put you on a fresh \`main\` (fetched + fast-forwarded) before this dispatch. Cut your feature branch off the current \`main\` rather than re-pulling.`
    : "";
  return `You're running in non-interactive mode. No one will see or respond to questions in your output. If you face a choice between asking and acting, always act — take the smaller / safer path (\`tpm block\`, \`tpm revert\`, log a Log line) and exit. The user reads the per-run log and the task state, not your final message.

${briefing}${freshMainNote}

You are executing this task. Rules:
- If \`prs:\` is non-empty and any linked PR is OPEN, fetch its comments and reviews via the host CLI (dispatch on \`Host:\` in the briefing) before any other discovery. Unaddressed comments are almost certainly why you're seeing this task — address them first.
- Follow the Plan above.
- If type=pr: after opening a PR, run \`tpm pr <slug> <url>\` (CLI auto-flips to needs-review). Stop.
- If type=investigation: your deliverable is a **report**, not a PR. Run \`tpm report <slug>\` to fold the task into a folder and scaffold \`<project>/tasks/<slug>/report.md\` from the template. Write findings into that file. When done, re-run \`tpm report <slug>\` — the CLI auto-flips to needs-review. Don't run \`tpm pr\`.
- Can't proceed? \`tpm revert <slug> "<reason>"\` (back to ready) or \`tpm block <slug> "<reason>"\` (human queue). Never exit at in-progress.
- Unanticipated decision? Ship the smaller / more local change, file follow-ups, don't halt.`;
}

// Feedback-mode prompt for tasks that re-enter the orchestrator at
// `needs-feedback` (the poller flagged a signal, or a human bounced a
// needs-review task via serve's "Reopen for agent" — post-087 those land at
// needs-feedback). The prompt embeds the PR JSON inline so the agent's first
// action can be a code Edit instead of a `gh pr view` round-trip.
//
// 089 is the structural follow-up to 088's instruction-only rule: if the
// comments are already in context, the agent can't ignore them. The fetched
// payload is host-formatted (`hosts/<host>.fetchFeedbackContext`) so multi-PR
// concatenation reads cleanly even across GitHub and ADO.
export function buildFeedbackPrompt(briefing: string, prContext: string): string {
  return `You're running in non-interactive mode. No one will see or respond to questions in your output. If you face a choice between asking and acting, always act — take the smaller / safer path (\`tpm block\`, \`tpm revert\`, log a Log line) and exit. The user reads the per-run log and the task state, not your final message.

${briefing}

---

## PR feedback context

${prContext}

---

You are addressing feedback on the PR(s) above. Rules:
- The PR state (title, state, comments, reviews, statusCheckRollup, plus review threads with resolution state) is already in this prompt. Read the JSON above; don't re-fetch with \`gh pr view\` / \`gh api graphql\` / \`az repos pr show\`.
- For concrete code-suggestion threads: apply the fix, commit, push. Resolve the thread if the fix matches the suggestion exactly.
- For CI failures: fetch the failed run log (\`gh run view <id> --log-failed\` for github), fix, commit, push.
- For rebase needs (BEHIND / DIRTY): rebase against the default branch; on a conflict you can't resolve cleanly, escalate (don't commit a resolution you can't verify with the workflow doc's tests).
- For ambiguous / design-level threads: flip to \`needs-review\` with a Log entry naming what's unclear, or \`tpm block <slug> "<reason>"\` for a hard blocker.
- The PR is already open; don't run \`tpm pr\` again. After pushing, the poller re-flags on the next signal.
- When the round is done: \`tpm log <slug> "addressed feedback — <one-line summary>"\` then \`tpm status <slug> in-progress\`. Never exit at in-progress without that explicit flip, a delivery state, or \`tpm revert\` / \`tpm block\`.
- Never ask questions in your output. Take the smaller / safer action and log what you did.`;
}

// Read the `prs:` frontmatter as a list of URLs, filtering out empties /
// non-strings so a stray bad entry doesn't crash the feedback fetch.
export function parsePrUrls(task: Task): string[] {
  const prs = task.data.prs;
  if (!Array.isArray(prs)) return [];
  return prs.filter((p): p is string => typeof p === "string" && p.length > 0);
}

// Fetch each linked PR's feedback context via the host registry and
// concatenate. Per-PR failures don't abort the run — we splice a stub
// `_fetch failed: ...` block so the agent sees the gap and can decide
// whether to skip that PR or escalate. Routed through hostFor so adding a
// new host is just a `src/hosts/<name>.ts` entry, not an orchestrator branch.
export async function fetchFeedbackContexts(urls: string[]): Promise<string> {
  const blocks: string[] = [];
  for (const url of urls) {
    const host = hostFor(url);
    if (!host) {
      blocks.push(`## PR ${url}\n\n_no host adapter matched this URL_`);
      continue;
    }
    try {
      const ctx = await host.fetchFeedbackContext(url);
      blocks.push(ctx);
    } catch (e) {
      blocks.push(`## PR ${url}\n\n_fetch failed via ${host.name}: ${(e as Error).message}_`);
    }
  }
  return blocks.join("\n\n");
}

// Verb written to the task body Log section when the orchestrator eager-flips
// `ready` (or `needs-feedback`) to `in-progress` *before* spawning the agent.
// Distinct from the agent's own `tpm start` verb ("started") so the audit
// trail differentiates the orchestrator-side claim from the agent's self-
// claim. Exported so the spawn-failure-revert message can name the same
// concept ("claim failed") without drifting from this string.
export const ORCHESTRATOR_CLAIM_VERB = "claimed by orchestrator (spawning agent)";

function snapshotTask(task: Task): DispositionSnapshot {
  return {
    status: String(task.data.status ?? ""),
    prs: Array.isArray(task.data.prs) ? (task.data.prs as unknown[]).length : 0,
    report: taskHasReport(task),
  };
}

// Thin wrapper around src/log.ts's shared structured emitter — the orchestrator
// always logs as `orchestrate`, so callers don't repeat the script name. The
// envelope shape (timestamp + level + script + message) is defined once in
// src/log.ts and shared with src/poll.ts.
function logLine(level: LogLevel, message: string): void {
  sharedLogLine(level, "orchestrate", message);
}

// Per-worker variant: prefixes the envelope message with `agent=<worker-id>` so
// merged `/logs` stays readable when multiple workers run in one orchestrate
// invocation (task 111). Falls back to a bare emitter when no id is set so
// pre-pool single-shot callers keep their existing log shape.
function workerLogger(agentId: string | undefined): (level: LogLevel, message: string) => void {
  if (!agentId) return logLine;
  return (level, message) => sharedLogLine(level, "orchestrate", `agent=${agentId} ${message}`);
}

export type RepoCheck =
  | { ok: true; cwd: string }
  | { ok: false; reason: string };

// Claude's permission sandbox locks to the spawn cwd. We must set cwd to the
// project's local repo, or the agent inherits the orchestrator's install dir
// and every file op in the project repo gets blocked (live failure on a
// react-router-tutorial run, 2026-05-17). When the clone is missing (or
// repo.local is unset) the task can't progress until a human acts, so the
// `reason` is phrased as a task blocker — the caller flips the task to
// `blocked` (see repoGuardAction) rather than re-skipping it on every tick.
export function checkProjectRepo(
  slug: string,
  repo: Repo,
  exists: (p: string) => boolean,
): RepoCheck {
  if (!repo.local) {
    return {
      ok: false,
      reason: `project repo.local is unset — set it in the project frontmatter, then \`tpm ready ${slug}\` to re-enter the queue`,
    };
  }
  if (!exists(repo.local)) {
    return {
      ok: false,
      reason: `project repo.local (${repo.local}) is not on disk — clone it, then \`tpm ready ${slug}\` to re-enter the queue`,
    };
  }
  return { ok: true, cwd: repo.local };
}

// Decide what the orchestrator does once checkProjectRepo has answered whether
// the repo is usable. Pure so the spawn / block / skip branches are unit-
// testable without standing up a real tree (mirrors classifyDisposition /
// shouldAutoRevert). Mapping:
//   - repo usable                  → spawn (cwd is the clone)
//   - repo missing, task !blocked  → block: flip to `blocked` so it surfaces in
//                                    `tpm inbox` and drops off the ready /
//                                    needs-feedback queue instead of re-failing
//                                    (and re-logging) on every tick
//   - repo missing, task blocked   → skip: already blocked on a prior tick;
//                                    don't double-block or double-log
// Once blocked, queue.ts excludes the task from selection, so the skip branch
// only fires on a pre-claimed re-encounter — it's the idempotency backstop.
export type RepoGuardAction =
  | { action: "spawn"; cwd: string }
  | { action: "block"; reason: string }
  | { action: "skip" };

export function repoGuardAction(currentStatus: string, check: RepoCheck): RepoGuardAction {
  if (check.ok) return { action: "spawn", cwd: check.cwd };
  if (currentStatus === "blocked") return { action: "skip" };
  return { action: "block", reason: check.reason };
}

// Decide what to do about local `main` before dispatching an agent that will
// cut a feature branch (task 118). The orchestrator's enforcement layer for
// PR #120's "branched off stale local main" failure: a worker inheriting a
// stale checkout silently builds on missing upstream commits, then the PR
// conflicts at merge time and needs a manual rebase.
//
// Pure so the four scenarios — clean, behind, dirty, non-FF — are unit-testable
// without spawning git. The imperative shell (`ensureFreshMain`) gathers
// `git status --porcelain` + `git rev-list --left-right --count origin/main...main`,
// calls this, then runs `git pull --ff-only` on the `pull` branch.
//
//   dirty       — `git status --porcelain` non-empty (any change, any branch)
//   dirtyPaths  — short summary of the first few paths, for the block reason
//   ahead       — local main commits not on origin/main; >0 means pull won't
//                 fast-forward (block — agent shouldn't try to rebase main)
//   behind      — origin/main commits not on local main; >0 means a pull is
//                 needed to bring local main fresh
export interface MainFreshness {
  dirty: boolean;
  dirtyPaths: string;
  ahead: number;
  behind: number;
}

export type FreshMainAction =
  | { action: "proceed" }
  | { action: "pull"; behind: number }
  | { action: "block"; reason: string };

export function freshMainAction(state: MainFreshness, slug: string): FreshMainAction {
  if (state.dirty) {
    return {
      action: "block",
      reason: `dirty checkout: ${state.dirtyPaths} — commit/stash, then \`tpm ready ${slug}\` to re-enter the queue`,
    };
  }
  if (state.ahead > 0) {
    return {
      action: "block",
      reason: `local main has ${state.ahead} commit(s) not on origin/main; pull would not fast-forward — reconcile, then \`tpm ready ${slug}\` to re-enter the queue`,
    };
  }
  if (state.behind > 0) return { action: "pull", behind: state.behind };
  return { action: "proceed" };
}

// Imperative half of the fresh-main precondition. Runs git in `cwd`, threads
// the observed state through `freshMainAction`, and on success leaves the
// working tree checked out on a fast-forwarded `main`. The downstream agent's
// `git checkout -b <feature>` then branches off the correct commit.
//
// Hard-codes `main` as the default branch name — matches what AGENTS.md /
// CONTRIBUTING.md tell agents to branch off. A repo that uses a different
// default (e.g. `master`, `develop`) will fail the rev-list step and block the
// task; the block reason names the git error so the operator can see what to
// fix.
//
// Returns a uniform `{ ok, reason? }`: callers don't care which step failed,
// only that the task should be flipped to `blocked` with the reason.
export interface FreshMainResult {
  ok: boolean;
  reason?: string;
}

interface GitRunResult { code: number; stdout: string; stderr: string; }

function runGit(cwd: string, args: string[]): GitRunResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      status?: number | null;
      stdout?: Buffer | string | null;
      stderr?: Buffer | string | null;
    };
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout == null ? "" : typeof err.stdout === "string" ? err.stdout : err.stdout.toString(),
      stderr: err.stderr == null ? "" : typeof err.stderr === "string" ? err.stderr : err.stderr.toString(),
    };
  }
}

export function summarizeDirtyPaths(porcelain: string, max = 3): string {
  const lines = porcelain.split("\n").map(l => l.trim()).filter(Boolean);
  // `git status --porcelain` lines start with `XY <path>` (two status chars,
  // a space, then the path; rename lines have ` -> ` we keep). Strip the
  // leading status code so the block reason names files, not glyphs.
  const paths = lines.slice(0, max).map(l => l.replace(/^.{1,3}\s+/, ""));
  const overflow = lines.length > max ? ` (+${lines.length - max} more)` : "";
  return paths.join(", ") + overflow;
}

export function parseRevListCounts(out: string): { behind: number; ahead: number } {
  // `git rev-list --left-right --count A...B` emits "<left>\t<right>\n".
  // With `origin/main...main`: left = origin/main commits not in main (behind),
  // right = main commits not in origin/main (ahead).
  const m = out.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return { behind: 0, ahead: 0 };
  return { behind: parseInt(m[1], 10), ahead: parseInt(m[2], 10) };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function ensureFreshMain(
  cwd: string,
  slug: string,
  log: (level: LogLevel, message: string) => void,
): FreshMainResult {
  const fetch = runGit(cwd, ["fetch", "origin", "main"]);
  if (fetch.code !== 0) {
    return { ok: false, reason: `git fetch origin main failed: ${oneLine(fetch.stderr || fetch.stdout)}` };
  }
  const status = runGit(cwd, ["status", "--porcelain"]);
  if (status.code !== 0) {
    return { ok: false, reason: `git status failed: ${oneLine(status.stderr || status.stdout)}` };
  }
  const dirty = status.stdout.trim().length > 0;
  const dirtyPaths = dirty ? summarizeDirtyPaths(status.stdout) : "";
  const counts = runGit(cwd, ["rev-list", "--left-right", "--count", "origin/main...main"]);
  if (counts.code !== 0) {
    return {
      ok: false,
      reason: `git rev-list origin/main...main failed: ${oneLine(counts.stderr || counts.stdout)}`,
    };
  }
  const { ahead, behind } = parseRevListCounts(counts.stdout);
  const action = freshMainAction({ dirty, dirtyPaths, ahead, behind }, slug);
  if (action.action === "block") {
    return { ok: false, reason: action.reason };
  }
  // Always end up on main so the agent's branch-off starts from the right ref.
  // A leftover feature branch from a prior run is the canonical PR #120 trap.
  const checkout = runGit(cwd, ["checkout", "main"]);
  if (checkout.code !== 0) {
    return { ok: false, reason: `git checkout main failed: ${oneLine(checkout.stderr || checkout.stdout)}` };
  }
  if (action.action === "pull") {
    const pull = runGit(cwd, ["pull", "--ff-only"]);
    if (pull.code !== 0) {
      return { ok: false, reason: `git pull --ff-only failed: ${oneLine(pull.stderr || pull.stdout)}` };
    }
    log("INFO", `${slug}: pulled main fast-forward (${action.behind} commit(s))`);
  }
  return { ok: true };
}

export interface OrchestrateOpts {
  // Back-compat override for the claude binary path. Honored only when the
  // resolved agent is claude (the only agent the flag knew about pre-092).
  // New callers should use the CLAUDE_BIN env var or `agentName` instead.
  claudeBin?: string;
  // Invocation-time agent override (the `--agent <name>` flag on
  // `tpm orchestrate`). Wins over task/project/config selection. In pool
  // mode, `cliPerWorker` (one entry per slot) wins over this.
  agentName?: string;
  // `--minutes N`. In pool mode, this is the pool-shared deadline; each worker
  // exits its loop when the deadline passes, draining any in-flight task. In
  // single-shot mode (`preClaimedTask` set), no pool runs — the value still
  // bounds the dispatch via the per-task time-bound cascade default.
  minutesOverride?: number;
  graceSeconds?: number;
  // Pre-claimed task slug. Caller (e.g. cron line that ran `tpm next --claim`
  // and then `tpm drift-check`) has already locked the task; orchestrate uses
  // it directly and runs a single iteration (workers/cliPerWorker ignored).
  preClaimedTask?: string;
  // Number of concurrent worker loops in this invocation (task 111). Default 1.
  // Each worker gets an auto id (`worker-1`, `worker-2`, …) used as the
  // `TPM_AGENT_ID` for lock attribution and log tagging.
  workers?: number;
  // Optional comma-separated agent name per worker slot. Length must equal
  // `workers` when provided. Default: every worker uses `agentName` (or the
  // registry default).
  cliPerWorker?: string[];
}

export interface OrchestrateResult {
  exitCode: number;
  // Set when runWithTimeout killed the child. Absent means the child exited
  // on its own (normal completion or its own non-zero exit).
  terminationReason?: "timeout" | "early-term";
}

// Decide what to log when the orchestrator finds nothing to dispatch. INFO for
// the routine empty-queue case (fires whenever the orchestrator wakes up with
// nothing to do); WARN when candidates existed but were all blocked by lock or
// repo contention — rarer and worth the higher level so it's grep-able.
export function noPickLogEntry(candidatesCount: number): { level: "INFO" | "WARN"; message: string } {
  if (candidatesCount === 0) {
    return {
      level: "INFO",
      message: "no eligible tasks (no ready/needs-feedback with allow_orchestrator: true)",
    };
  }
  return {
    level: "WARN",
    message: "all eligible tasks claimable but repos busy or task-locked",
  };
}

// Idle sleep between attempts when a worker can't claim a task. Short enough
// that a worker wakes within seconds of new work appearing; long enough that
// a deadline-bound pool with nothing to do doesn't churn on `loadProjects`.
const WORKER_IDLE_SLEEP_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Validate worker pool inputs (workers, cliPerWorker). Throws with a clear
// message on mismatch so callers (CLI, tests) fail loudly instead of dispatching
// a half-configured pool. Returns the resolved worker count (the bootstrap
// default — the running pool tracks ~/.tpm/config.json's `workers` field after
// the first reconcile tick, see task 113).
export function resolvePoolShape(opts: OrchestrateOpts): { workers: number } {
  const workers = opts.workers ?? 1;
  if (!Number.isInteger(workers) || workers <= 0) {
    throw new Error(`--workers must be a positive integer, got ${workers}`);
  }
  if (opts.cliPerWorker && opts.cliPerWorker.length !== workers) {
    throw new Error(
      `--cli has ${opts.cliPerWorker.length} entries but --workers is ${workers}; lengths must match`,
    );
  }
  return { workers };
}

// Clamp a raw `workers` value from config.json into a usable count. Accepts
// non-negative integers as-is (including 0 — the documented "park the pool"
// value); negatives, non-integers, missing values, and non-numbers all clamp
// to 1 with a warning describing the input. The orchestrator de-dupes the
// warning so a steady-state bad config doesn't spam the log every tick.
export interface ClampedWorkers {
  value: number;
  warning: string | null;
}

export function clampWorkers(raw: unknown): ClampedWorkers {
  if (raw === undefined || raw === null) {
    return { value: 1, warning: null };
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return {
      value: 1,
      warning: `workers must be a non-negative integer, got ${JSON.stringify(raw)}; clamping to 1`,
    };
  }
  if (!Number.isInteger(raw) || raw < 0) {
    return {
      value: 1,
      warning: `workers must be a non-negative integer, got ${raw}; clamping to 1`,
    };
  }
  return { value: raw, warning: null };
}

// Pure planner for pool reconciliation. Given the set of currently-live (not
// already draining) worker ids and a desired total, return:
//   - spawn: ids 1..desired that aren't currently live (ascending — fills the
//     lowest free slot first so worker-1 is stable across scale events)
//   - drain: ids above desired (descending — highest first, so a 3->2 scale
//     drains worker-3 before worker-2)
// Idempotent: planReconcile([1,2,3], 3) → {spawn: [], drain: []}.
export interface PoolReconcilePlan {
  spawn: number[];
  drain: number[];
}

export function planReconcile(currentIds: Iterable<number>, desired: number): PoolReconcilePlan {
  const live = new Set<number>();
  for (const id of currentIds) live.add(id);
  const spawn: number[] = [];
  for (let id = 1; id <= desired; id++) {
    if (!live.has(id)) spawn.push(id);
  }
  const drain = [...live].filter(id => id > desired).sort((a, b) => b - a);
  return { spawn, drain };
}

// Dispatcher entry point. Two modes:
//   - `preClaimedTask` set: single-shot iteration against that task. Used by
//     legacy cron lines that ran `tpm next --claim` then `tpm orchestrate
//     --task <slug>`. Pool flags are ignored.
//   - otherwise: pool mode (task 111). Fans out N worker loops; each worker
//     gets an auto id (`worker-1`, …) used as `TPM_AGENT_ID` for lock
//     attribution. Workers exit the loop when the shared deadline passes,
//     draining any in-flight task first. Idle workers sleep briefly and retry.
//
// A single iteration does:
//   1. tpm next --autonomous (filters to allow_orchestrator: true)
//   2. spawn `<agentBin> <agent.buildArgs(prompt, repoLocal)>` with a hard
//      time bound. The agent CLI (claude, copilot, …) is resolved from the
//      task/project/config registry in src/agent_cli.ts.
//   3. on timeout, SIGTERM (then SIGKILL after grace), then `tpm revert <slug>`
//   4. additionally, poll the task every ~5s; if it goes terminal externally
//      (done/dropped/archived) SIGTERM the child early — disposition: terminal.
// Exit code mirrors the child's; 124 on timeout (per timeout(1) convention),
// 127 if the binary couldn't be spawned, 1 if no eligible task.
export async function runOrchestrate(opts: OrchestrateOpts = {}): Promise<OrchestrateResult> {
  const root = findRoot();
  const cfg = readConfig();

  // Hygiene: clear stale per-task locks before claiming. TTL = global time
  // bound + 5m buffer (per-task overrides apply on acquire, not on cleanup).
  const ttl = (cfg.time_bound_minutes ?? DEFAULT_TIME_BOUND_MINUTES) + 5;
  lock.releaseStaleTaskLocks(root, ttl);

  if (opts.preClaimedTask) {
    const agentId = process.env.TPM_AGENT_ID ?? `${hostname()}-${process.pid}`;
    return runWorkerIteration({
      root,
      cfg,
      agentId,
      preClaimedTask: opts.preClaimedTask,
      agentName: opts.agentName,
      claudeBin: opts.claudeBin,
      graceSeconds: opts.graceSeconds,
      minutesOverride: opts.minutesOverride,
    });
  }

  // Validate flag shape up front (--workers must parse, --cli length must
  // match --workers if both passed). The resolved value is the *bootstrap*
  // default: the running pool tracks `workers` in ~/.tpm/config.json after
  // the first reconcile tick, so this is only consulted when config.workers
  // is unset.
  const { workers: bootstrapWorkers } = resolvePoolShape(opts);
  const deadlineMinutes = opts.minutesOverride ?? cfg.time_bound_minutes ?? DEFAULT_TIME_BOUND_MINUTES;
  const deadlineMs = Date.now() + deadlineMinutes * 60_000;
  logLine(
    "INFO",
    `pool start bootstrap-workers=${bootstrapWorkers} deadline=${deadlineMinutes}m`,
  );

  await runPool({
    initialDesired: bootstrapWorkers,
    deadlineMs,
    reconcileIntervalMs: POOL_RECONCILE_INTERVAL_MS,
    readDesired: () => readDesiredWorkers(bootstrapWorkers),
    log: logLine,
    spawnWorker: (id, shouldDrain) => runWorkerLoop({
      root,
      cfg,
      workerId: `worker-${id}`,
      deadlineMs,
      // Per-worker CLI override: slot N reads cliPerWorker[N-1]. Slots beyond
      // the list (e.g. config bumped workers past --cli length) fall back to
      // the global --agent / registry default. resolvePoolShape rejects a
      // longer --cli than --workers at bootstrap, but config-driven growth
      // can outpace the list; that's documented in the help text.
      agentName: opts.cliPerWorker?.[id - 1] ?? opts.agentName,
      claudeBin: opts.claudeBin,
      graceSeconds: opts.graceSeconds,
      shouldDrain,
    }),
  });

  logLine("INFO", `pool finished`);
  // Pool runs to its natural lifecycle. Per-iteration spawn failures (127)
  // surface inside the worker loop; the outer process exits 0 so cron
  // wrappers don't loop on a misleading non-zero.
  return { exitCode: 0 };
}

// Reconcile cadence. 10s matches WORKER_IDLE_SLEEP_MS so an idle pool reacts
// to a config change on roughly the same beat that a busy pool would pick up
// a newly-queued task. Faster reconciles would just churn loadProjects/
// readConfig with no extra responsiveness for a human operator.
const POOL_RECONCILE_INTERVAL_MS = 10_000;

// Read the desired worker count from ~/.tpm/config.json. Returns the
// `bootstrap` value when the config file is missing the `workers` field
// (flag-as-bootstrap-default semantics). Logs at most one warning per
// distinct error/clamp message so a steady-state bad config doesn't spam
// the log on every tick.
let lastWorkersWarning: string | null = null;
function readDesiredWorkers(bootstrap: number): number {
  let cfg: ReturnType<typeof readConfig>;
  try {
    cfg = readConfig();
  } catch (e) {
    const msg = `config read failed during pool reconcile: ${(e as Error).message}; reusing bootstrap (${bootstrap})`;
    if (lastWorkersWarning !== msg) {
      logLine("WARN", msg);
      lastWorkersWarning = msg;
    }
    return bootstrap;
  }
  if (cfg.workers === undefined) {
    lastWorkersWarning = null;
    return bootstrap;
  }
  const clamped = clampWorkers(cfg.workers);
  if (clamped.warning) {
    if (lastWorkersWarning !== clamped.warning) {
      logLine("WARN", clamped.warning);
      lastWorkersWarning = clamped.warning;
    }
  } else {
    lastWorkersWarning = null;
  }
  return clamped.value;
}

export interface RunPoolOpts {
  initialDesired: number;
  deadlineMs: number;
  reconcileIntervalMs: number;
  // Re-read the desired worker count each tick (typically from config.json).
  readDesired: () => number;
  // Spawn a worker with the given id. The returned promise should resolve
  // when the worker has finished (either because shouldDrain() flipped, or
  // because the worker hit its own internal stopping condition such as the
  // pool deadline). The pool awaits all outstanding worker promises before
  // returning from runPool.
  spawnWorker: (id: number, shouldDrain: () => boolean) => Promise<unknown>;
  log: (level: LogLevel, message: string) => void;
  // Sleep impl, injectable for tests so we don't real-sleep through the
  // reconcile interval. Defaults to `setTimeout`-based sleep.
  sleep?: (ms: number) => Promise<void>;
}

// Pool supervisor. Owns the reconcile loop: every tick, it re-reads the
// desired count, diffs against the live pool, and spawns / marks-for-drain to
// converge. Per task 113:
//   - A scale-up spawns the lowest free ids first (so worker-1 is stable).
//   - A scale-down marks the highest ids for drain; the worker finishes its
//     in-flight iteration before exiting (no SIGKILL).
//   - workers: 0 parks the pool (no workers; runPool keeps ticking so a later
//     `tpm config set workers N` flips it back on without restart).
// Pure-ish: all I/O (config read, child spawn) is injected via callbacks, so
// the supervisor itself is unit-testable without standing up a real tree.
export async function runPool(opts: RunPoolOpts): Promise<void> {
  const sleepFn = opts.sleep ?? sleep;
  // Each entry's `drain` flag is the signal the worker loop polls; the
  // `promise` is held so we can await every worker before returning.
  const handles = new Map<number, { drain: boolean; promise: Promise<unknown> }>();
  let lastDesired = -1; // sentinel so the initial reconcile always logs

  const spawn = (id: number) => {
    const handle: { drain: boolean; promise: Promise<unknown> } = {
      drain: false,
      promise: Promise.resolve(),
    };
    handle.promise = opts.spawnWorker(id, () => handle.drain).finally(() => {
      handles.delete(id);
    });
    handles.set(id, handle);
  };

  const reconcile = () => {
    const desired = opts.readDesired();
    const liveIds = [...handles.entries()]
      .filter(([, h]) => !h.drain)
      .map(([id]) => id);
    const plan = planReconcile(liveIds, desired);
    const changed = desired !== lastDesired;
    if (changed || plan.spawn.length > 0 || plan.drain.length > 0) {
      const parts: string[] = [];
      if (plan.spawn.length > 0) {
        parts.push(`spawning ${plan.spawn.map(i => `worker-${i}`).join(", ")}`);
      }
      if (plan.drain.length > 0) {
        parts.push(`draining ${plan.drain.map(i => `worker-${i}`).join(", ")}`);
      }
      const action = parts.length > 0 ? ` (${parts.join("; ")})` : " (no-op)";
      const fromCount = lastDesired === -1 ? 0 : lastDesired;
      opts.log("INFO", `workers: ${fromCount} -> ${desired}${action}`);
    }
    for (const id of plan.spawn) spawn(id);
    for (const id of plan.drain) {
      const h = handles.get(id);
      if (h) h.drain = true;
    }
    lastDesired = desired;
  };

  // Initial converge before the first sleep — so a `--workers 3` cron line
  // dispatches workers immediately instead of waiting one reconcile interval.
  reconcile();

  while (Date.now() < opts.deadlineMs) {
    const remaining = opts.deadlineMs - Date.now();
    const sleepMs = Math.min(opts.reconcileIntervalMs, remaining);
    if (sleepMs <= 0) break;
    await sleepFn(sleepMs);
    if (Date.now() >= opts.deadlineMs) break;
    reconcile();
  }

  // Deadline reached — every worker loop also checks Date.now() against the
  // shared deadlineMs, so they'll exit on their own. Await to collect.
  await Promise.allSettled([...handles.values()].map(h => h.promise));
}

interface WorkerIterationOpts {
  root: string;
  cfg: ReturnType<typeof readConfig>;
  agentId: string;
  agentName?: string;
  claudeBin?: string;
  graceSeconds?: number;
  preClaimedTask?: string;
  minutesOverride?: number;
}

interface WorkerLoopOpts {
  root: string;
  cfg: ReturnType<typeof readConfig>;
  workerId: string;
  deadlineMs: number;
  agentName?: string;
  claudeBin?: string;
  graceSeconds?: number;
  // Pool supervisor sets this flag (via the callback) when the worker should
  // exit gracefully — typically a scale-down via `tpm config set workers N`.
  // Checked at the top of each loop iteration so any in-flight task finishes
  // before the worker exits (no SIGKILL on the agent). Absent: never drain.
  shouldDrain?: () => boolean;
}

// A worker loop: claim → run → release, repeat until the pool deadline. Sleeps
// briefly when nothing is eligible so a quiet queue doesn't churn on
// `loadProjects`. Per-task locks dedup against sibling workers, so the body
// here is the same as a single-shot orchestrate turn.
async function runWorkerLoop(opts: WorkerLoopOpts): Promise<OrchestrateResult> {
  const log = workerLogger(opts.workerId);
  log("INFO", `worker start`);
  let lastResult: OrchestrateResult = { exitCode: 0 };
  let idleSinceLog = false;
  let stopReason = "deadline reached";
  while (Date.now() < opts.deadlineMs) {
    if (opts.shouldDrain?.()) {
      stopReason = "drained (pool scaled down)";
      break;
    }
    const result = await runWorkerIteration({
      root: opts.root,
      cfg: opts.cfg,
      agentId: opts.workerId,
      agentName: opts.agentName,
      claudeBin: opts.claudeBin,
      graceSeconds: opts.graceSeconds,
    });
    lastResult = result;
    if (opts.shouldDrain?.()) {
      // Drain flipped while the iteration was in flight (the documented
      // scale-down case: "finish any in-flight task, release the lock,
      // exit"). The iteration's finally{} already released the per-task lock.
      stopReason = "drained (pool scaled down)";
      break;
    }
    if (result.exitCode === 1) {
      // No eligible task (or all repos busy). Sleep until either work appears
      // or the deadline passes. Re-log only on the first idle in a streak so
      // the merged /logs view doesn't fill with idle ticks.
      if (!idleSinceLog) {
        log("INFO", `idle; sleeping ${Math.round(WORKER_IDLE_SLEEP_MS / 1000)}s`);
        idleSinceLog = true;
      }
      const remaining = opts.deadlineMs - Date.now();
      if (remaining <= 0) break;
      // Wake early on drain so a scale-down doesn't have to wait out the full
      // idle interval before the worker exits.
      await sleepInterruptible(
        Math.min(WORKER_IDLE_SLEEP_MS, remaining),
        () => opts.shouldDrain?.() === true,
      );
      continue;
    }
    idleSinceLog = false;
  }
  log("INFO", `worker stop (${stopReason})`);
  return lastResult;
}

// Sleep up to `ms`, waking early if `shouldWake()` returns true. Poll cadence
// is 1s (short enough that a drain signal is honored quickly, long enough that
// an idle pool isn't burning CPU on the predicate). Used by the worker loop's
// idle sleep so a scale-down doesn't have to wait out WORKER_IDLE_SLEEP_MS.
async function sleepInterruptible(ms: number, shouldWake: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  const pollMs = 1_000;
  while (Date.now() < deadline) {
    if (shouldWake()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(pollMs, remaining));
  }
}

// One orchestrator iteration. Originally the whole body of `runOrchestrate`;
// extracted so a worker loop can call it repeatedly under one process. All
// state (root, cfg, agentId) is passed in — the iteration owns no globals
// other than the lock files it acquires and releases.
async function runWorkerIteration(opts: WorkerIterationOpts): Promise<OrchestrateResult> {
  const root = opts.root;
  const cfg = opts.cfg;
  const agentId = opts.agentId;
  const log = workerLogger(opts.agentId);

  const projects = loadProjects(root);
  let pick: { project: Project; task: Task } | null = null;
  let slug = "";

  if (opts.preClaimedTask) {
    // Caller already claimed the task (e.g. `tpm next --claim`); we just run.
    slug = opts.preClaimedTask;
    const match = findTask(projects, slug);
    if (!match) {
      log("ERROR", `pre-claimed task not found: ${slug}`);
      return { exitCode: 1 };
    }
    pick = match;
    // Sanity-check the lock is ours; refuse to run a task we don't own.
    const status = lock.statusTask(root, slug);
    if (!status.includes(`agent-id=${agentId}`)) {
      log("ERROR", `pre-claimed task ${slug} is not held by ${agentId} (status: ${status})`);
      return { exitCode: 1 };
    }
  } else {
    // Atomic pick + claim: walk candidates, lock the first one we can.
    // Strategy `serialize` also requires the repo lock — falls through to
    // the next candidate if a sibling task is already running in this repo.
    // Pass `hasTaskLock` so stranded in-progress tasks (status didn't flip out
    // on a prior agent exit; lock since released) get admitted alongside ready
    // / needs-feedback. The stale-lock sweep above guarantees a lock file we
    // see at this point is current, not a leftover from a dead pid.
    const candidates = selectCandidates(projects, {
      autonomous: true,
      hasTaskLock: (slug) => lock.hasTaskLock(root, slug),
    });
    for (const c of candidates) {
      const candSlug = c.task.parent
        ? `${c.project.slug}/${c.task.parent}/${c.task.slug}`
        : `${c.project.slug}/${c.task.slug}`;
      const taskR = lock.acquireTask(root, candSlug, agentId);
      if (!taskR.acquired) continue;
      const strategy = resolveSameRepoStrategy(c.project);
      if (strategy === "worktree") {
        // Worktree strategy is declared but the orchestrator-managed
        // create/cleanup path isn't shipped yet (tracked as a follow-up to
        // 035/003). Refuse to dispatch rather than silently colliding on
        // the working tree.
        lock.releaseTask(root, candSlug, agentId);
        log(
          "ERROR",
          `${candSlug}: same_repo_strategy: worktree is declared but not yet implemented in tpm orchestrate. Switch to serialize or run the task manually.`,
        );
        return { exitCode: 1 };
      }
      if (strategy === "serialize") {
        const repoR = lock.acquireRepo(root, c.project.slug, agentId);
        if (!repoR.acquired) {
          // Repo busy with a sibling task. Release the per-task lock we just
          // grabbed so a future claim can pick it up, then try the next.
          lock.releaseTask(root, candSlug, agentId);
          continue;
        }
      }
      slug = candSlug;
      pick = c;
      break;
    }
    if (!pick) {
      const entry = noPickLogEntry(candidates.length);
      log(entry.level, entry.message);
      return { exitCode: 1 };
    }
  }

  const minutes = opts.minutesOverride ?? resolveTimeBound(
    { task: pick.task, project: pick.project },
    cfg.time_bound_minutes,
  );
  const grace = (opts.graceSeconds ?? 10) * 1000;
  // Resolve agent CLI: task > project > config > registry default. The
  // back-compat `claudeBin` opt is layered on top of the resolved bin only
  // when the resolved agent is claude — preserves the pre-092 `--claude
  // /path/to/claude` flag without letting it override a copilot dispatch.
  const agentCli = resolveAgentCli({
    task: pick.task,
    project: pick.project,
    configAgent: cfg.agent,
    override: opts.agentName,
  });
  const agentBin = opts.claudeBin && agentCli.name === "claude"
    ? opts.claudeBin
    : agentCli.bin;

  // Resolve and verify the project's local clone before spawning. Sandbox
  // requires a usable cwd. A missing clone (or unset repo.local) is human-
  // action-required, not a transient skip: leaving the task at `ready` makes
  // every later tick re-check, re-fail, and re-log the same thing. Flip it to
  // `blocked` so it surfaces in `tpm inbox` and drops off the queue (operator
  // clones, then `tpm ready <task>` to re-enter). repoGuardAction keeps a task
  // already blocked on a prior tick from being re-blocked / re-logged.
  const repo = resolveRepo(pick.project, pick.task);
  const repoCheck = checkProjectRepo(slug, repo, existsSync);
  const guard = repoGuardAction(String(pick.task.data.status ?? ""), repoCheck);
  if (guard.action !== "spawn") {
    if (guard.action === "block") {
      try {
        mutate.block(pick.task, guard.reason);
        log("WARN", `${slug}: blocked — ${guard.reason}`);
      } catch (e) {
        log("ERROR", `block ${slug} failed: ${(e as Error).message}`);
      }
    }
    try { lock.releaseTask(root, slug, agentId); } catch (e) {
      log("ERROR", `lock release failed for ${slug}: ${(e as Error).message}`);
    }
    if (resolveSameRepoStrategy(pick.project) === "serialize") {
      try { lock.releaseRepo(root, pick.project.slug, agentId); } catch (e) {
        log("ERROR", `repo lock release failed for ${pick.project.slug}: ${(e as Error).message}`);
      }
    }
    return { exitCode: 1 };
  }

  // Decide prompt mode now so we can skip the fresh-main precondition on
  // feedback rounds — those re-enter an existing PR branch (the agent runs
  // `gh pr checkout` and rebases against origin/main from there) rather than
  // cutting a fresh branch off main, so the precondition would force a
  // pointless checkout away from the PR branch.
  const beforeStatus = String(pick.task.data.status ?? "");
  const before = snapshotTask(pick.task);
  const prUrls = parsePrUrls(pick.task);
  const useFeedbackPrompt = beforeStatus === "needs-feedback" && prUrls.length > 0;

  // Fresh-main precondition (task 118). PR #120 hit the canonical failure:
  // agent cd'd into a stale checkout, branched off stale main, then conflicted
  // at merge time with upstream commits it never saw. Enforce a fast-forwarded
  // main before any execution-prompt dispatch; block-and-skip on dirty / non-FF
  // so the operator reconciles rather than the agent guessing.
  let freshMainEnforced = false;
  if (!useFeedbackPrompt) {
    const fresh = ensureFreshMain(guard.cwd, slug, log);
    if (!fresh.ok) {
      const reason = fresh.reason ?? "fresh-main precondition failed";
      try {
        mutate.block(pick.task, reason);
        log("WARN", `${slug}: blocked — ${reason}`);
      } catch (e) {
        log("ERROR", `block ${slug} failed: ${(e as Error).message}`);
      }
      try { lock.releaseTask(root, slug, agentId); } catch (e) {
        log("ERROR", `lock release failed for ${slug}: ${(e as Error).message}`);
      }
      if (resolveSameRepoStrategy(pick.project) === "serialize") {
        try { lock.releaseRepo(root, pick.project.slug, agentId); } catch (e) {
          log("ERROR", `repo lock release failed for ${pick.project.slug}: ${(e as Error).message}`);
        }
      }
      return { exitCode: 1 };
    }
    freshMainEnforced = true;
  }

  // Per-run log: capture the agent's session output so `tpm serve` can show
  // what the agent is doing live, and so a post-mortem after a failed run has
  // more than just the start/finish envelope to work from. The orchestrator's
  // own log stays clean — start/finish/disposition lines only. The first line
  // is a `# tpm-run agent=… outputFormat=…` header so the viewer can dispatch
  // on the right interpreter when the run wasn't claude.
  //
  // Runs land inside the task's own folder (`<task>/runs/<utc>.log`, task 095)
  // so `tpm archive` carries them with the rest of the task. File-form
  // top-level tasks auto-fold here; children share their parent's runs/ with
  // a `<child-slug>--` prefix. If the fold or mkdir fails, log a warning and
  // fall back to no-capture (the orchestrator's start/finish envelope still
  // tells the post-mortem story).
  let logFile: string | undefined;
  try {
    logFile = prepareRunLogPath(pick.task).logFile;
  } catch (e) {
    log("WARN", `${slug}: could not prepare run log path (${(e as Error).message}); continuing without capture`);
  }
  const logHeader = formatRunLogHeader(agentCli.name, agentCli.outputFormat);
  log("INFO", `start ${slug} time-bound=${minutes}m agent=${agentCli.name} bin=${agentBin}`);
  if (logFile) log("INFO", `run log: ${logFile}`);

  // Heartbeat the lock every 60s so a long-running agent doesn't get
  // reclaimed by a sibling's stale-lock sweep.
  const heartbeatTimer = setInterval(() => {
    try { lock.heartbeatTask(root, slug, agentId); } catch { /* best-effort */ }
  }, 60_000);

  if (shouldNotify("start", { task: pick.task, project: pick.project, globalConfig: cfg.notifications })) {
    fireNotification("tpm", `${agentId} starting ${pick.task.slug}`);
  }

  // Build the prompt inline: briefing (same shape as `tpm context <slug>`)
  // followed by the execution rules. The agent reads the Plan and starts
  // working — no skill discovery, no `tpm context` round-trip first.
  //
  // For tasks arriving at `needs-feedback` with linked PRs, swap in the
  // feedback-mode prompt (task 089): pre-fetch PR comments + reviews via the
  // host registry and inject the JSON so the agent's first tool call can be a
  // code Edit, not a `gh pr view`. Falls back to the execution prompt if the
  // PR list is empty or the fetch errors out — we'd rather ship a less-rich
  // prompt than skip the dispatch.
  // beforeStatus / before / prUrls were captured earlier (before the fresh-main
  // precondition fired) so the snapshot reflects the task's real entry status,
  // not the post-eager-flip `in-progress`. The disposition log still reads
  // `status=ready->needs-review` etc. even after the orchestrator pre-claims.
  const briefing = buildBriefing(root, slug);
  let prompt: string;
  if (useFeedbackPrompt) {
    const prContext = await fetchFeedbackContexts(prUrls);
    prompt = buildFeedbackPrompt(briefing, prContext);
    log("INFO", `${slug}: feedback-mode prompt with ${prUrls.length} PR(s)`);
  } else {
    prompt = buildExecutionPrompt(briefing, { freshMain: freshMainEnforced });
  }

  // Eager flip: claim the task on-disk *before* the spawn. The agent's own
  // `tpm start` (step 3 of the /tpm skill) runs ~30s+ after spawn — between
  // spawn and that flip, `tpm serve` reads the frontmatter and shows `ready`
  // even though the orchestrator has already claimed. Flipping here matches
  // disk truth to the claim. mutate.start is idempotent (no-op when already
  // in-progress, e.g. stranded-reclaim path), and uses a distinct verb so the
  // Log section distinguishes orchestrator-claim from agent self-start.
  try {
    mutate.start(pick.task, ORCHESTRATOR_CLAIM_VERB);
  } catch (e) {
    log("ERROR", `${slug}: eager claim flip failed: ${(e as Error).message}`);
    try { lock.releaseTask(root, slug, agentId); } catch (le) {
      log("ERROR", `lock release failed for ${slug}: ${(le as Error).message}`);
    }
    if (resolveSameRepoStrategy(pick.project) === "serialize") {
      try { lock.releaseRepo(root, pick.project.slug, agentId); } catch (le) {
        log("ERROR", `repo lock release failed for ${pick.project.slug}: ${(le as Error).message}`);
      }
    }
    return { exitCode: 1 };
  }

  let result: OrchestrateResult;
  try {
    result = await runWithTimeout(
      agentBin,
      // Args come from the agent CLI registry (src/agent_cli.ts). Each entry
      // knows the right flag combination to emit NDJSON events as they
      // happen (tool calls, text deltas, results) — that's what makes the
      // per-run log a live transcript instead of just the final message.
      agentCli.buildArgs(prompt, guard.cwd),
      minutes,
      grace,
      () => {
        const projectsAfter = loadProjects(root);
        const match = findTask(projectsAfter, slug);
        if (!match) {
          log("WARN", `task ${slug} not found after timeout (was it archived mid-run?)`);
          return;
        }
        try {
          const r = mutate.revert(match.task, `time bound ${minutes}m exceeded`);
          log("INFO", `revert ${slug}: ${r.message}`);
        } catch (e) {
          log("ERROR", `revert ${slug} failed: ${(e as Error).message}`);
        }
      },
      () => {
        const projectsNow = loadProjects(root);
        const match = findTask(projectsNow, slug);
        return evaluateTerminalState(match?.task ?? null);
      },
      undefined,
      logFile,
      guard.cwd,
      logHeader,
    );
  } finally {
    clearInterval(heartbeatTimer);
    // Always release locks on exit (success, timeout, or thrown error).
    try {
      lock.releaseTask(root, slug, agentId);
    } catch (e) {
      log("ERROR", `lock release failed for ${slug}: ${(e as Error).message}`);
    }
    if (resolveSameRepoStrategy(pick.project) === "serialize") {
      try {
        lock.releaseRepo(root, pick.project.slug, agentId);
      } catch (e) {
        log("ERROR", `repo lock release failed for ${pick.project.slug}: ${(e as Error).message}`);
      }
    }
  }

  // Spawn-failure rollback: exit 127 means runWithTimeout's child.on("error")
  // fired — the agent binary couldn't be spawned (missing, not executable,
  // wrong arch, etc.). The eager flip already happened, so without rollback
  // the task sits at `in-progress` with no agent ever having run. Revert to
  // the pre-claim status with a Log line naming the failed claim.
  //
  // Skip when the pre-claim status was already `in-progress` (stranded-
  // reclaim path) — the eager flip was a no-op so there's nothing to undo.
  // The harder case (process crashed *after* the eager flip but *before*
  // `tpm start` would have run) is covered by the existing auto-revert /
  // stranded-lock-sweep paths.
  if (result.exitCode === 127 && beforeStatus !== "in-progress") {
    const projectsForRollback = loadProjects(root);
    const matchForRollback = findTask(projectsForRollback, slug);
    if (matchForRollback) {
      try {
        mutate.setStatus(
          matchForRollback.task,
          beforeStatus,
          `claim failed: agent spawn failed (exit 127, bin=${agentBin}); reverted to ${beforeStatus}`,
        );
        log("WARN", `${slug}: spawn failed; reverted status to ${beforeStatus}`);
      } catch (e) {
        log("ERROR", `spawn-failure revert for ${slug} failed: ${(e as Error).message}`);
      }
    } else {
      log("WARN", `${slug}: spawn failed but task not found on disk (was it archived?)`);
    }
  }

  // Notify finish/fail. Re-resolve the task because mid-run frontmatter
  // mutations can flip the cascade (e.g. agent set notifications.fail: false).
  const projectsAfter = loadProjects(root);
  const matchAfter = findTask(projectsAfter, slug);
  const notifyTask = matchAfter?.task ?? pick.task;
  const notifyProject = matchAfter?.project ?? pick.project;
  const event = result.exitCode === 0 ? "finish" : "fail";
  if (shouldNotify(event, { task: notifyTask, project: notifyProject, globalConfig: cfg.notifications })) {
    const verb = event === "finish" ? "finished" : "failed";
    fireNotification("tpm", `${agentId} ${verb} ${pick.task.slug}`);
  }

  const after = matchAfter ? snapshotTask(matchAfter.task) : null;
  const disposition = classifyDisposition({
    exitCode: result.exitCode,
    before,
    after,
    terminationReason: result.terminationReason,
  });
  const level = disposition === "stalled" ? "WARN" : "INFO";
  log(level, formatDispositionLine(slug, disposition, result.exitCode, before, after));

  // Strand-on-exit safety net (task 063). If the agent left the task at
  // in-progress with no shipping signal, revert to ready so the next
  // orchestrator tick (or a human) can re-pick it. mutate.revert is itself
  // idempotent — the predicate is the gate that decides intent.
  if (
    matchAfter &&
    shouldAutoRevert({
      exitCode: result.exitCode,
      before,
      after,
      terminationReason: result.terminationReason,
    })
  ) {
    log(
      "WARN",
      `${slug}: agent exited cleanly with task still in-progress and no PR; auto-reverting to ready`,
    );
    try {
      const r = mutate.revert(matchAfter.task, "agent exited with no progress (auto-revert)");
      log("INFO", `revert ${slug}: ${r.message}`);
    } catch (e) {
      log("ERROR", `auto-revert ${slug} failed: ${(e as Error).message}`);
    }
  }

  return result;
}

// Poll interval for both the time-bound countdown and the terminal-state
// check. 5s is the sweet spot: fast enough that an externally-closed task
// triggers SIGTERM within seconds (the bug 059 is fixing), slow enough that
// the extra loadProjects() per tick is invisible cost.
const POLL_INTERVAL_MS = 5_000;

// Exported for tests; production callers go through runOrchestrate.
//
// When `logFile` is set, the child's stdout and stderr are captured to that
// file (NDJSON if the caller passed claude's stream-json flags). The parent's
// stdout/stderr stay clean — the orchestrator's start/finish/disposition
// envelope is the only thing on the parent stream. Without a log file the
// child inherits stdio, preserving the pre-task-057 behavior for any caller
// that doesn't want a transcript.
export function runWithTimeout(
  bin: string,
  args: string[],
  minutes: number,
  graceMs: number,
  onTimeout: () => void,
  isTaskTerminal: () => TerminalReason | null,
  pollIntervalMs: number = POLL_INTERVAL_MS,
  logFile?: string,
  cwd?: string,
  // Optional first-line preamble written to logFile before the child's output
  // is piped in. The orchestrator uses this for the `# tpm-run agent=…` line
  // (task 092) so the viewer can dispatch on outputFormat without a sidecar.
  logHeader?: string,
): Promise<OrchestrateResult> {
  return new Promise((resolve) => {
    let logStream: ReturnType<typeof createWriteStream> | null = null;
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        logStream = createWriteStream(logFile);
        if (logHeader) logStream.write(logHeader);
      } catch (e) {
        // Logging is a nice-to-have — don't block the run if the FS is hostile.
        logLine("WARN", `run log unavailable (${(e as Error).message}); continuing without capture`);
        logStream = null;
      }
    }
    const child = logStream
      ? spawn(bin, args, { stdio: ["inherit", "pipe", "pipe"], cwd })
      : spawn(bin, args, { stdio: "inherit", cwd });
    if (logStream && child.stdout && child.stderr) {
      // `end: false` so a single stderr or stdout EOF doesn't close the file
      // before the other stream flushes. We close explicitly on child exit.
      child.stdout.pipe(logStream, { end: false });
      child.stderr.pipe(logStream, { end: false });
    }
    let terminationReason: "timeout" | "early-term" | null = null;
    let exited = false;
    const deadline = Date.now() + minutes * 60_000;

    const terminate = (reason: "timeout" | "early-term", message: string) => {
      if (terminationReason !== null || exited) return;
      terminationReason = reason;
      logLine(reason === "timeout" ? "WARN" : "INFO", message);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => {
        if (!exited) {
          logLine("WARN", `grace expired, sending SIGKILL`);
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, graceMs);
    };

    const poll = setInterval(() => {
      if (exited || terminationReason !== null) return;
      if (Date.now() >= deadline) {
        terminate("timeout", `time bound ${minutes}m reached, sending SIGTERM`);
        return;
      }
      let reason: TerminalReason | null = null;
      try {
        reason = isTaskTerminal();
      } catch (e) {
        // Don't let a transient tree-read failure kill the agent — log and
        // try again next tick. The time bound still applies as a backstop.
        logLine("WARN", `terminal-state check failed: ${(e as Error).message}`);
        return;
      }
      if (reason !== null) {
        terminate("early-term", `task terminal mid-run (${reason}), sending SIGTERM`);
      }
    }, pollIntervalMs);

    // Resolve only after the log stream has flushed to disk; otherwise a caller
    // that reads the log file right after `await runWithTimeout(...)` returns
    // can race the kernel-buffer flush and see a partial transcript.
    const finishWithLogClosed = (cb: () => void) => {
      if (logStream) logStream.end(cb);
      else cb();
    };
    child.on("error", (err) => {
      exited = true;
      clearInterval(poll);
      logLine("ERROR", `failed to spawn ${bin}: ${err.message}`);
      finishWithLogClosed(() => resolve({ exitCode: 127 }));
    });
    child.on("exit", (code, signal) => {
      exited = true;
      clearInterval(poll);
      finishWithLogClosed(() => {
        if (terminationReason === "timeout") {
          onTimeout();
          logLine("WARN", `timed out after ${minutes}m (signal=${signal ?? "?"})`);
          resolve({ exitCode: 124, terminationReason: "timeout" });
        } else if (terminationReason === "early-term") {
          logLine("INFO", `terminated early after task closed (signal=${signal ?? "?"})`);
          resolve({ exitCode: 0, terminationReason: "early-term" });
        } else {
          resolve({ exitCode: code ?? 0 });
        }
      });
    });
  });
}
