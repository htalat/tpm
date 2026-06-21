// `tpm loop` — the long-running drain harness.
//
// Faithful port of the bash one-liner this used to be:
//
//   #!/bin/bash
//   trap 'kill 0' EXIT
//   (while true; do tpm poll;        echo "[poll] sleeping";        sleep 60; done) &
//   (while true; do tpm orchestrate; echo "[orchestrate] sleeping"; sleep 60; done) &
//   wait
//
// Two independent loops run forever: the PR-signal poller (`tpm poll`) and the
// agent-queue drain (`tpm orchestrate`). Each runs its command to completion,
// logs, sleeps its interval, repeats — so a slow orchestrate tick never blocks
// a poll tick. SIGINT/SIGTERM kills any in-flight child and exits, the
// equivalent of bash's `trap 'kill 0' EXIT`.
//
// The ticks run as child processes (not in-process) so a crash or hang in one
// tick can't take the loop down with it — the bash original forked too. Each
// child is `node <this install's cli.ts> <args>` (the same mechanism `tpm
// serve` uses for its mutations): no dependency on a runnable bin shim, so it
// works identically on Windows — where the .cmd shim can't be spawned directly
// and the bash shim doesn't exist — as on macOS/Linux.

import { spawn, type ChildProcess } from "node:child_process";

export interface LoopOptions {
  pollInterval: number; // seconds
  orchestrateInterval: number; // seconds
  workers?: number;
  once: boolean;
}

// Parse the `tpm loop` flag tail. `bail` is the caller's usage/error sink
// (cli.ts's `usage`) so parse failures exit with the same code as every other
// verb instead of this module deciding the process's fate.
export function parseLoopArgs(argv: string[], bail: (msg: string) => never): LoopOptions {
  const opts: LoopOptions = { pollInterval: 60, orchestrateInterval: 60, once: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const num = (label: string): number => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) bail(`${label} must be a positive number`);
      return v;
    };
    switch (arg) {
      case "--poll-interval": opts.pollInterval = num("--poll-interval"); break;
      case "--orchestrate-interval": opts.orchestrateInterval = num("--orchestrate-interval"); break;
      case "--workers": opts.workers = num("--workers"); break;
      case "--once": opts.once = true; break;
      default: bail(`tpm loop: unknown argument: ${arg}`);
    }
  }
  return opts;
}

// Run both loops forever (or once, with --once). `cliEntry` is the absolute
// path to this install's cli.ts; ticks run as `node <cliEntry> <args>` so they
// execute the same install the loop itself is running, on any platform.
export async function runLoop(cliEntry: string, opts: LoopOptions): Promise<void> {
  const children = new Set<ChildProcess>();
  const wakers = new Set<() => void>();
  let shuttingDown = false;

  // Sleep `seconds`, but resolve early if a shutdown signal arrives mid-sleep so
  // the loop can unwind cleanly (vs. hanging on a cleared timer). Each pending
  // sleep registers its resolver; shutdown() fires them all.
  const sleep = (seconds: number): Promise<void> =>
    new Promise(res => {
      if (shuttingDown) return res();
      const wake = () => { clearTimeout(t); wakers.delete(wake); res(); };
      const t = setTimeout(wake, seconds * 1000);
      wakers.add(wake);
    });

  // Run `node <cliEntry> <args>` to completion, inheriting stdio so its
  // structured log lines flow straight to our stdout/stderr. Resolves
  // regardless of exit code — a single failed tick shouldn't kill the loop
  // (bash's version ignored exit codes too). process.execArgv is forwarded so
  // any node flags that launched the parent (e.g. TS-strip) reach the child.
  const runOnce = (label: string, args: string[]): Promise<void> =>
    new Promise(res => {
      const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...args], { stdio: "inherit" });
      children.add(child);
      const done = () => { children.delete(child); res(); };
      child.on("exit", done);
      child.on("error", err => {
        console.error(`[${label}] failed to spawn: ${(err as Error).message}`);
        done();
      });
    });

  const loop = async (label: string, args: string[], intervalSec: number): Promise<void> => {
    while (!shuttingDown) {
      await runOnce(label, args);
      if (opts.once || shuttingDown) return;
      console.log(`[${label}] sleeping ${intervalSec}s`);
      await sleep(intervalSec);
    }
  };

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\ntpm loop: ${signal} — stopping`);
    for (const wake of [...wakers]) wake();
    for (const child of children) child.kill(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const orchestrateArgs = ["orchestrate"];
  if (opts.workers !== undefined) orchestrateArgs.push("--workers", String(opts.workers));

  console.log(
    `tpm loop: poll every ${opts.pollInterval}s, orchestrate every ` +
    `${opts.orchestrateInterval}s${opts.workers ? ` (workers=${opts.workers})` : ""}` +
    `${opts.once ? " — single pass" : ""} — Ctrl-C to stop`,
  );

  await Promise.all([
    loop("poll", ["poll"], opts.pollInterval),
    loop("orchestrate", orchestrateArgs, opts.orchestrateInterval),
  ]);
}
