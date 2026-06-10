#!/usr/bin/env node
// tpm loop — the long-running drain harness, in TypeScript.
//
// Faithful port of the bash one-liner that used to live in the README:
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
// a poll tick. Ctrl-C (SIGINT) / SIGTERM kills any in-flight child and exits,
// the equivalent of bash's `trap 'kill 0' EXIT`.
//
// Run it with `npm run loop` or `node scripts/loop.ts`. Intervals and the
// orchestrate worker count are configurable; everything else is faithful to the
// bash original.
//
// Usage:
//   node scripts/loop.ts [--poll-interval <sec>] [--orchestrate-interval <sec>]
//                        [--workers <N>] [--once]
//
//   --poll-interval <sec>          seconds between poll ticks        (default 60)
//   --orchestrate-interval <sec>   seconds between orchestrate ticks (default 60)
//   --workers <N>                  passed through as `tpm orchestrate --workers N`
//   --once                         run each command exactly once, then exit
//
// The `tpm` binary is resolved the same way the rest of the codebase resolves
// it: $TPM_BIN override → this install's bin/tpm → bare `tpm` on PATH.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Options {
  pollInterval: number;
  orchestrateInterval: number;
  workers?: number;
  once: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { pollInterval: 60, orchestrateInterval: 60, once: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const num = (label: string): number => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) die(`${label} must be a positive number`);
      return v;
    };
    switch (arg) {
      case "--poll-interval": opts.pollInterval = num("--poll-interval"); break;
      case "--orchestrate-interval": opts.orchestrateInterval = num("--orchestrate-interval"); break;
      case "--workers": opts.workers = num("--workers"); break;
      case "--once": opts.once = true; break;
      case "-h":
      case "--help": printHelp(); process.exit(0);
      default: die(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function die(message: string): never {
  console.error(`tpm loop: ${message}`);
  process.exit(2);
}

function printHelp(): void {
  console.log(`tpm loop — long-running poll + orchestrate drain

Usage:
  node scripts/loop.ts [options]

Options:
  --poll-interval <sec>          seconds between poll ticks        (default 60)
  --orchestrate-interval <sec>   seconds between orchestrate ticks (default 60)
  --workers <N>                  tpm orchestrate --workers N
  --once                         run each command once, then exit
  -h, --help                     show this help`);
}

// $TPM_BIN override → this install's bin/tpm → bare `tpm` on PATH. Mirrors
// resolveTpmBin() in src/core/cli.ts so the loop runs the same binary the
// scheduler would.
function resolveTpmBin(): string {
  const override = process.env.TPM_BIN;
  if (override && isAbsolute(override) && existsSync(override)) return override;
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = resolve(dirname(here), "..", "bin", "tpm");
    if (existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }
  return "tpm";
}

const TPM = resolveTpmBin();
const children = new Set<ChildProcess>();
let shuttingDown = false;

// Sleep `seconds`, but resolve early if a shutdown signal arrives mid-sleep so
// the loop can unwind cleanly (vs. hanging on a cleared timer). Each pending
// sleep registers its resolver; shutdown() fires them all.
const wakers = new Set<() => void>();
function sleep(seconds: number): Promise<void> {
  return new Promise(res => {
    if (shuttingDown) return res();
    const wake = () => { clearTimeout(t); wakers.delete(wake); res(); };
    const t = setTimeout(wake, seconds * 1000);
    wakers.add(wake);
  });
}

// Run `tpm <args>` to completion, inheriting stdio so its structured log lines
// flow straight to our stdout/stderr. Resolves regardless of exit code — a
// single failed tick shouldn't kill the loop (bash's version ignored exit codes
// too).
function runOnce(label: string, args: string[]): Promise<void> {
  return new Promise(res => {
    const child = spawn(TPM, args, { stdio: "inherit" });
    children.add(child);
    const done = () => { children.delete(child); res(); };
    child.on("exit", done);
    child.on("error", err => {
      console.error(`[${label}] failed to spawn: ${(err as Error).message}`);
      done();
    });
  });
}

async function loop(label: string, args: string[], intervalSec: number, once: boolean): Promise<void> {
  while (!shuttingDown) {
    await runOnce(label, args);
    if (once || shuttingDown) return;
    console.log(`[${label}] sleeping ${intervalSec}s`);
    await sleep(intervalSec);
  }
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\ntpm loop: ${signal} — stopping`);
  for (const wake of [...wakers]) wake();
  for (const child of children) child.kill(signal);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const orchestrateArgs = ["orchestrate"];
  if (opts.workers !== undefined) orchestrateArgs.push("--workers", String(opts.workers));

  console.log(
    `tpm loop: poll every ${opts.pollInterval}s, orchestrate every ` +
    `${opts.orchestrateInterval}s${opts.workers ? ` (workers=${opts.workers})` : ""}` +
    `${opts.once ? " — single pass" : ""} — Ctrl-C to stop`
  );

  await Promise.all([
    loop("poll", ["poll"], opts.pollInterval, opts.once),
    loop("orchestrate", orchestrateArgs, opts.orchestrateInterval, opts.once),
  ]);
}

main();
