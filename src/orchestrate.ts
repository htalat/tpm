import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { findRoot } from "./root.ts";
import { loadProjects } from "./tree.ts";
import { selectCandidates } from "./queue.ts";
import { findTask } from "./resolve.ts";
import * as mutate from "./mutate.ts";
import * as lock from "./lock.ts";
import { readConfig, DEFAULT_TIME_BOUND_MINUTES } from "./config.ts";
import { isoWithOffset } from "./time.ts";
import { shouldNotify, fireNotification } from "./notify.ts";
import { resolveRepo } from "./context.ts";
import { resolveSameRepoStrategy, worktreePath, worktreeBranch } from "./strategy.ts";
import { newRunLogPath } from "./run_log.ts";
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
  const statusChanged = after.status !== input.before.status;
  // `tpm start` flips `ready -> in-progress` or `needs-feedback -> in-progress`
  // on entry. Without further progress (no PR, no delivery-state advance),
  // that's claim-not-progress — per task 064.
  const entryFlip =
    after.status === "in-progress" &&
    (input.before.status === "ready" || input.before.status === "needs-feedback") &&
    !prsGrew;
  // Did the agent ship? PR opened, or status reached a delivery state.
  const shippedFlip =
    !entryFlip && (prsGrew || (statusChanged && DELIVERY_STATES.has(after.status)));

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
  return `disposition ${slug} ${disposition} exit=${exitCode} status=${before.status}->${afterStatus} prs=${before.prs}->${afterPrs}`;
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
//   - `before.status` wasn't `needs-feedback` — a feedback round legitimately
//     ends at `in-progress` with unchanged prs after addressing CI/threads.
export function shouldAutoRevert(input: AutoRevertInput): boolean {
  if (input.exitCode !== 0) return false;
  if (input.terminationReason) return false;
  if (!input.after) return false;
  if (input.after.status !== "in-progress") return false;
  if (input.after.prs !== input.before.prs) return false;
  if (input.before.status === "needs-feedback") return false;
  return true;
}

function snapshotTask(task: Task): DispositionSnapshot {
  return {
    status: String(task.data.status ?? ""),
    prs: Array.isArray(task.data.prs) ? (task.data.prs as unknown[]).length : 0,
  };
}

// Structured log line — matches scripts/recurring/_log.sh format so a tail of
// any tpm log file (recurring scripts, orchestrator runs) sorts/greps cleanly.
//
//   2026-05-15T09:14:23-07:00  INFO   orchestrate      <message>
//
// Timestamp is ISO-8601 second precision in the configured TZ with explicit
// offset (task 061 — readable when live-tailing; unambiguous if ever shipped
// cross-host). INFO/WARN go to stdout, ERROR to stderr — same split as the
// bash helper. Cron entries redirect both to the same log file in practice;
// the split lets an interactive run filter warnings without losing errors.
function logLine(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const ts = isoWithOffset();
  const padded = level.padEnd(5);
  const line = `${ts}  ${padded}  ${"orchestrate".padEnd(16)} ${message}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

export interface OrchestrateOpts {
  claudeBin?: string;
  minutesOverride?: number;
  graceSeconds?: number;
  // Pre-claimed task slug. Caller (e.g. cron line that ran `tpm next --claim`
  // and then `tpm drift-check`) has already locked the task; orchestrate uses
  // it directly. Lock release on exit still happens.
  preClaimedTask?: string;
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

// Run one orchestrator turn:
//   1. tpm next --autonomous (filters to allow_orchestrator: true)
//   2. spawn `<claudeBin> -p "/tpm <slug>"` with a hard time bound
//   3. on timeout, SIGTERM (then SIGKILL after grace), then `tpm revert <slug>`
//   4. additionally, poll the task every ~5s; if it goes terminal externally
//      (done/dropped/archived) SIGTERM the child early — disposition: terminal.
// Exit code mirrors the child's; 124 on timeout (per timeout(1) convention),
// 127 if the binary couldn't be spawned, 1 if no eligible task.
export async function runOrchestrate(opts: OrchestrateOpts = {}): Promise<OrchestrateResult> {
  const root = findRoot();
  const cfg = readConfig();
  const agentId = process.env.TPM_AGENT_ID ?? `${hostname()}-${process.pid}`;

  // Hygiene: clear stale per-task locks before claiming. TTL = global time
  // bound + 5m buffer (per-task overrides apply on acquire, not on cleanup).
  const ttl = (cfg.time_bound_minutes ?? DEFAULT_TIME_BOUND_MINUTES) + 5;
  lock.releaseStaleTaskLocks(root, ttl);

  const projects = loadProjects(root);
  let pick: { project: Project; task: Task } | null = null;
  let slug = "";

  if (opts.preClaimedTask) {
    // Caller already claimed the task (e.g. `tpm next --claim`); we just run.
    slug = opts.preClaimedTask;
    const match = findTask(projects, slug);
    if (!match) {
      logLine("ERROR", `pre-claimed task not found: ${slug}`);
      return { exitCode: 1 };
    }
    pick = match;
    // Sanity-check the lock is ours; refuse to run a task we don't own.
    const status = lock.statusTask(root, slug);
    if (!status.includes(`agent-id=${agentId}`)) {
      logLine("ERROR", `pre-claimed task ${slug} is not held by ${agentId} (status: ${status})`);
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
        logLine(
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
      logLine(entry.level, entry.message);
      return { exitCode: 1 };
    }
  }

  const minutes = opts.minutesOverride ?? resolveTimeBound(
    { task: pick.task, project: pick.project },
    cfg.time_bound_minutes,
  );
  const grace = (opts.graceSeconds ?? 10) * 1000;
  const claudeBin = opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";

  // Per-run log: capture the claude session output so `tpm serve` can show
  // what the agent is doing live, and so a post-mortem after a failed run has
  // more than just the start/finish envelope to work from. The orchestrator's
  // own log stays clean — start/finish/disposition lines only.
  const logFile = newRunLogPath(slug);
  logLine("INFO", `start ${slug} as ${agentId} time-bound=${minutes}m claude=${claudeBin}`);
  logLine("INFO", `run log: ${logFile}`);

  // Heartbeat the lock every 60s so a long-running agent doesn't get
  // reclaimed by a sibling's stale-lock sweep.
  const heartbeatTimer = setInterval(() => {
    try { lock.heartbeatTask(root, slug, agentId); } catch { /* best-effort */ }
  }, 60_000);

  if (shouldNotify("start", { task: pick.task, project: pick.project, globalConfig: cfg.notifications })) {
    fireNotification("tpm", `${agentId} starting ${pick.task.slug}`);
  }

  let result: OrchestrateResult;
  try {
    result = await runWithTimeout(
      claudeBin,
      // --output-format stream-json --verbose emits NDJSON events as they
      // happen (tool calls, text deltas, results) — that's what makes the
      // per-run log a live transcript instead of just the final message.
      ["-p", "--output-format", "stream-json", "--verbose", `/tpm ${slug}`],
      minutes,
      grace,
      () => {
        const projectsAfter = loadProjects(root);
        const match = findTask(projectsAfter, slug);
        if (!match) {
          logLine("WARN", `task ${slug} not found after timeout (was it archived mid-run?)`);
          return;
        }
        try {
          const r = mutate.revert(match.task, `time bound ${minutes}m exceeded`);
          logLine("INFO", `revert ${slug}: ${r.message}`);
        } catch (e) {
          logLine("ERROR", `revert ${slug} failed: ${(e as Error).message}`);
        }
      },
      () => {
        const projectsNow = loadProjects(root);
        const match = findTask(projectsNow, slug);
        return evaluateTerminalState(match?.task ?? null);
      },
      undefined,
      logFile,
    );
  } finally {
    clearInterval(heartbeatTimer);
    // Always release locks on exit (success, timeout, or thrown error).
    try {
      lock.releaseTask(root, slug, agentId);
    } catch (e) {
      logLine("ERROR", `lock release failed for ${slug}: ${(e as Error).message}`);
    }
    if (resolveSameRepoStrategy(pick.project) === "serialize") {
      try {
        lock.releaseRepo(root, pick.project.slug, agentId);
      } catch (e) {
        logLine("ERROR", `repo lock release failed for ${pick.project.slug}: ${(e as Error).message}`);
      }
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

  const before = snapshotTask(pick.task);
  const after = matchAfter ? snapshotTask(matchAfter.task) : null;
  const disposition = classifyDisposition({
    exitCode: result.exitCode,
    before,
    after,
    terminationReason: result.terminationReason,
  });
  const level = disposition === "stalled" ? "WARN" : "INFO";
  logLine(level, formatDispositionLine(slug, disposition, result.exitCode, before, after));

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
    logLine(
      "WARN",
      `${slug}: agent exited cleanly with task still in-progress and no PR; auto-reverting to ready`,
    );
    try {
      const r = mutate.revert(matchAfter.task, "agent exited with no progress (auto-revert)");
      logLine("INFO", `revert ${slug}: ${r.message}`);
    } catch (e) {
      logLine("ERROR", `auto-revert ${slug} failed: ${(e as Error).message}`);
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
): Promise<OrchestrateResult> {
  return new Promise((resolve) => {
    let logStream: ReturnType<typeof createWriteStream> | null = null;
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        logStream = createWriteStream(logFile);
      } catch (e) {
        // Logging is a nice-to-have — don't block the run if the FS is hostile.
        logLine("WARN", `run log unavailable (${(e as Error).message}); continuing without capture`);
        logStream = null;
      }
    }
    const child = logStream
      ? spawn(bin, args, { stdio: ["inherit", "pipe", "pipe"] })
      : spawn(bin, args, { stdio: "inherit" });
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
