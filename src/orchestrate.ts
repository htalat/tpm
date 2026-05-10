import { spawn } from "node:child_process";
import { findRoot } from "./root.ts";
import { loadProjects } from "./tree.ts";
import { selectNext } from "./queue.ts";
import { findTask } from "./resolve.ts";
import * as mutate from "./mutate.ts";
import { readConfig, DEFAULT_TIME_BOUND_MINUTES } from "./config.ts";
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
  const projects = loadProjects(root);
  const pick = selectNext(projects, { autonomous: true });
  if (!pick) {
    return { exitCode: 1, message: "No ready or needs-feedback tasks with allow_orchestrator: true." };
  }

  const cfg = readConfig();
  const minutes = opts.minutesOverride ?? resolveTimeBound(
    { task: pick.task, project: pick.project },
    cfg.time_bound_minutes,
  );
  const grace = (opts.graceSeconds ?? 10) * 1000;
  const claudeBin = opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
  const slug = pick.task.parent
    ? `${pick.project.slug}/${pick.task.parent}/${pick.task.slug}`
    : `${pick.project.slug}/${pick.task.slug}`;

  console.error(`tpm orchestrate: ${slug} (time bound: ${minutes}m, claude: ${claudeBin})`);

  return runWithTimeout(claudeBin, ["-p", `/tpm ${slug}`], minutes, grace, () => {
    // Re-resolve the task — its frontmatter may have been mutated mid-run.
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
    // TODO(004-notifications): fire fail notification here once the
    // notification config cascade ships. Until then, the cron log carries
    // the only visible signal.
  });
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
