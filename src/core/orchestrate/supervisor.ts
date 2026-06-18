import { readConfig, DEFAULT_TIME_BOUND_MINUTES } from "../config.ts";
import { runOrchestrate } from "./orchestrate.ts";
import { runPoll } from "./poll.ts";
import type { PollSummary } from "./poll.ts";
import * as lock from "./lock.ts";
import { logLine as sharedLogLine, type LogLevel } from "../log.ts";

function logLine(level: LogLevel, message: string): void {
  sharedLogLine(level, "up", message);
}

// The in-process harness behind `tpm up`: one long-lived process that owns
// the PR-signal poll loop and a daemon-mode orchestrate pool, alongside the
// web UI (wired by the CLI entry). Replaces the `tpm loop` pattern of
// independent child processes coordinating through the filesystem — here a
// single supervisor knows the harness state and can report it to the UI.
//
// Deliberately thin: worker scaling stays config-driven (`workers` in
// ~/.tpm/config.json, hot-reloaded by the pool's reconcile tick), stopping a
// run stays status-driven (`tpm pull` flips the task; the run's 5s terminal
// poll SIGTERMs the agent). The supervisor adds no second control channel —
// it only owns process lifecycle and observability.

export interface HarnessOpts {
  root: string;
  // Bootstrap worker count when config.json has no `workers` field. The pool
  // hot-reloads config every reconcile tick, so `tpm config set workers N`
  // (or the UI's stepper) rescales without restart.
  workers?: number;
  pollIntervalSec?: number;
  agentName?: string;
  graceSeconds?: number;
  // Observability hook: fired after every poll tick and on lifecycle edges.
  // `tpm up` wires this to the serve SSE broadcaster so the UI refreshes the
  // moment harness state moves.
  onEvent?: (event: HarnessEvent) => void;
}

export interface HarnessEvent {
  type: "poll" | "started" | "stopping" | "stopped";
  at: string; // ISO-8601 UTC
  summary?: PollSummary;
  error?: string;
}

export interface HarnessSnapshot {
  startedAt: string;
  pollIntervalSec: number;
  desiredWorkers: number; // config `workers` (or the bootstrap value)
  stopping: boolean;
  lastPoll: { at: string; summary?: PollSummary; error?: string } | null;
  // Set when the orchestrate pool exited while the harness wasn't stopping —
  // a crash (bad config, unexpected throw), not a drain. The UI renders it as
  // a dead chip so the operator isn't staring at a panel that says "running"
  // over a pool that died at bootstrap.
  poolDied: string | null;
}

export interface Harness {
  snapshot(): HarnessSnapshot;
  // Graceful: stops picking new work, lets in-flight iterations finish,
  // resolves when the pool has drained. The caller decides how impatient to
  // be (tpm up force-exits on a second SIGINT).
  stop(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_SEC = 60;

export function startHarness(opts: HarnessOpts): Harness {
  const pollIntervalSec = opts.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC;
  const startedAt = new Date().toISOString();
  let stopping = false;
  let lastPoll: HarnessSnapshot["lastPoll"] = null;

  const emit = (event: HarnessEvent) => {
    try {
      opts.onEvent?.(event);
    } catch {
      // observability must never take the harness down
    }
  };

  // ---- poll loop -----------------------------------------------------------
  // One tick = stale-lock hygiene + a PR-signal poll. The sweep lives here
  // (not only at orchestrate startup) because a daemon's pool starts once and
  // then runs for days — without a periodic sweep, a crashed external agent's
  // lock would pin its task until the daemon restarts.
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollInFlight: Promise<void> = Promise.resolve();

  const pollTick = async () => {
    try {
      const cfg = readConfig();
      const ttl = (cfg.time_bound_minutes ?? DEFAULT_TIME_BOUND_MINUTES) + 5;
      for (const e of lock.releaseStaleTaskLocks(opts.root, ttl)) {
        if (e.reverted) {
          logLine("WARN", `${e.qualifiedSlug}: stale lock (was ${e.data.agentId}); reverted in-progress -> ready`);
        }
      }
      const summary = await runPoll({ root: opts.root });
      lastPoll = { at: new Date().toISOString(), summary };
      emit({ type: "poll", at: lastPoll.at, summary });
    } catch (e) {
      lastPoll = { at: new Date().toISOString(), error: (e as Error).message };
      logLine("ERROR", `poll tick failed: ${(e as Error).message}`);
      emit({ type: "poll", at: lastPoll.at, error: (e as Error).message });
    }
  };

  const schedulePoll = () => {
    if (stopping) return;
    pollTimer = setTimeout(() => {
      pollInFlight = pollTick().finally(schedulePoll);
    }, pollIntervalSec * 1_000);
  };
  // First tick immediately so the UI has a poll line within seconds of `up`.
  pollInFlight = pollTick().finally(schedulePoll);

  // ---- orchestrate pool (daemon mode) --------------------------------------
  let poolDied: string | null = null;
  const poolDone = runOrchestrate({
    workers: opts.workers,
    agentName: opts.agentName,
    graceSeconds: opts.graceSeconds,
    daemon: true,
    stopRequested: () => stopping,
  }).catch(e => {
    logLine("ERROR", `orchestrate pool crashed: ${(e as Error).message}`);
    return { exitCode: 1, error: (e as Error).message };
  }).then(r => {
    // A daemon pool only returns when asked to stop. Returning earlier (or
    // with an error) means it died — surface that in the snapshot instead of
    // letting the panel claim "running" over a dead pool.
    if (!stopping) {
      poolDied = ("error" in r && typeof r.error === "string" ? r.error : null)
        ?? `pool exited unexpectedly (exit ${r.exitCode})`;
      logLine("ERROR", `orchestrate pool exited while harness still running: ${poolDied}`);
      emit({ type: "poll", at: new Date().toISOString(), error: poolDied });
    }
    return r;
  });

  emit({ type: "started", at: startedAt });

  return {
    snapshot(): HarnessSnapshot {
      let desiredWorkers = opts.workers ?? 1;
      try {
        const w = readConfig().workers;
        if (typeof w === "number") desiredWorkers = w;
      } catch {
        // unreadable config: report the bootstrap value
      }
      return { startedAt, pollIntervalSec, desiredWorkers, stopping, lastPoll, poolDied };
    },
    async stop(): Promise<void> {
      if (!stopping) {
        stopping = true;
        emit({ type: "stopping", at: new Date().toISOString() });
        if (pollTimer) clearTimeout(pollTimer);
      }
      await pollInFlight;
      await poolDone;
      emit({ type: "stopped", at: new Date().toISOString() });
    },
  };
}
