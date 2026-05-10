import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { findRoot } from "./root.ts";
import { loadProjects } from "./tree.ts";
import { selectCandidates } from "./queue.ts";
import { findTask } from "./resolve.ts";
import * as mutate from "./mutate.ts";
import * as lock from "./lock.ts";
import { readConfig, DEFAULT_TIME_BOUND_MINUTES } from "./config.ts";
import { shouldNotify, fireNotification } from "./notify.ts";
import { resolveRepo } from "./context.ts";
import { resolveSameRepoStrategy, worktreePath, worktreeBranch } from "./strategy.ts";
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
  message?: string;
}

// Run one orchestrator turn:
//   1. tpm next --autonomous (filters to allow_orchestrator: true)
//   2. spawn `<claudeBin> -p "/tpm <slug>"` with a hard time bound
//   3. on timeout, SIGTERM (then SIGKILL after grace), then `tpm revert <slug>`
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
      return { exitCode: 1, message: `pre-claimed task not found: ${slug}` };
    }
    pick = match;
    // Sanity-check the lock is ours; refuse to run a task we don't own.
    const status = lock.statusTask(root, slug);
    if (!status.includes(`agent-id=${agentId}`)) {
      return {
        exitCode: 1,
        message: `pre-claimed task ${slug} is not held by ${agentId} (status: ${status})`,
      };
    }
  } else {
    // Atomic pick + claim: walk candidates, lock the first one we can.
    // Strategy `serialize` also requires the repo lock — falls through to
    // the next candidate if a sibling task is already running in this repo.
    const candidates = selectCandidates(projects, { autonomous: true });
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
        return {
          exitCode: 1,
          message: `${candSlug}: same_repo_strategy: worktree is declared but not yet implemented in tpm orchestrate. Switch to serialize or run the task manually.`,
        };
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
      return {
        exitCode: 1,
        message: candidates.length === 0
          ? "No ready or needs-feedback tasks with allow_orchestrator: true."
          : "All eligible tasks are claimable but their repos are busy or already locked.",
      };
    }
  }

  const minutes = opts.minutesOverride ?? resolveTimeBound(
    { task: pick.task, project: pick.project },
    cfg.time_bound_minutes,
  );
  const grace = (opts.graceSeconds ?? 10) * 1000;
  const claudeBin = opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";

  console.error(`tpm orchestrate: ${slug} as ${agentId} (time bound: ${minutes}m, claude: ${claudeBin})`);

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
    result = await runWithTimeout(claudeBin, ["-p", `/tpm ${slug}`], minutes, grace, () => {
      const projectsAfter = loadProjects(root);
      const match = findTask(projectsAfter, slug);
      if (!match) {
        console.error(`tpm orchestrate: task ${slug} not found after timeout (was it archived mid-run?)`);
        return;
      }
      try {
        const r = mutate.revert(match.task, `time bound ${minutes}m exceeded`);
        console.error(`tpm orchestrate: ${r.message}`);
      } catch (e) {
        console.error(`tpm orchestrate: revert failed: ${(e as Error).message}`);
      }
    });
  } finally {
    clearInterval(heartbeatTimer);
    // Always release locks on exit (success, timeout, or thrown error).
    try {
      lock.releaseTask(root, slug, agentId);
    } catch (e) {
      console.error(`tpm orchestrate: lock release failed: ${(e as Error).message}`);
    }
    if (resolveSameRepoStrategy(pick.project) === "serialize") {
      try {
        lock.releaseRepo(root, pick.project.slug, agentId);
      } catch (e) {
        console.error(`tpm orchestrate: repo lock release failed: ${(e as Error).message}`);
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

  return result;
}

function runWithTimeout(
  bin: string,
  args: string[],
  minutes: number,
  graceMs: number,
  onTimeout: () => void,
): Promise<OrchestrateResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    let timedOut = false;
    let exited = false;

    const termTimer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      console.error(`tpm orchestrate: time bound ${minutes}m reached, sending SIGTERM`);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => {
        if (!exited) {
          console.error(`tpm orchestrate: grace expired, sending SIGKILL`);
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, graceMs);
    }, minutes * 60_000);

    child.on("error", (err) => {
      exited = true;
      clearTimeout(termTimer);
      resolve({ exitCode: 127, message: `failed to spawn ${bin}: ${err.message}` });
    });
    child.on("exit", (code, signal) => {
      exited = true;
      clearTimeout(termTimer);
      if (timedOut) {
        onTimeout();
        resolve({ exitCode: 124, message: `timed out after ${minutes}m (signal=${signal ?? "?"})` });
      } else {
        resolve({ exitCode: code ?? 0 });
      }
    });
  });
}
