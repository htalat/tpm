import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import type { Scheduler, SchedulerJob, SchedulerStatus } from "./types.ts";
import { validateJobName } from "./types.ts";

// Adapter for Windows. Backed by `schtasks.exe` so it works on any Windows
// install without extra modules. Task names are flat (`tpm-<name>`, no
// backslash) so they sit at the root of the Task Scheduler library — easy
// to spot in taskschd.msc and trivial to enumerate via `/Query`.

const TASK_PREFIX = "tpm-";

// Pure string/argv generators — kept separate so tests don't need to mock
// child_process just to verify the rendered schtasks invocation.

export function taskName(name: string): string {
  return `${TASK_PREFIX}${name}`;
}

// schtasks /SC MINUTE accepts whole minutes only; clamp to >=1.
export function intervalMinutes(intervalSeconds: number): number {
  return Math.max(1, Math.round(intervalSeconds / 60));
}

// `/TR` takes the entire command as one string. cmd.exe will tokenize it
// the same way as a typed command line: bare path-safe args pass through;
// anything else gets wrapped in double-quotes with embedded `"` doubled.
export function trCommand(args: string[]): string {
  return args.map(quoteForTr).join(" ");
}

function quoteForTr(s: string): string {
  if (/^[A-Za-z0-9_\/\\\-\.:=]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildCreateArgs(job: SchedulerJob, runAs: string): string[] {
  return [
    "/Create",
    "/TN", taskName(job.name),
    "/SC", "MINUTE",
    "/MO", String(intervalMinutes(job.intervalSeconds)),
    "/TR", trCommand(job.args),
    "/RU", runAs,
    "/IT",
    "/F",
  ];
}

export function buildDeleteArgs(name: string): string[] {
  return ["/Delete", "/TN", taskName(name), "/F"];
}

export function buildQueryArgs(name?: string): string[] {
  if (name) return ["/Query", "/TN", taskName(name)];
  return ["/Query", "/FO", "CSV", "/NH"];
}

// `schtasks /Query /FO CSV /NH` emits one CSV row per task:
//   "\Microsoft\Windows\Foo\Bar","N/A","Ready"
// or for a root-level task:
//   "\tpm-poll","12/31/2026 12:00:00 AM","Ready"
// We only need the task name (first column); strip any folder path and
// keep just the tpm-prefixed leaves.
export function parseListOutput(csv: string): string[] {
  const names = new Set<string>();
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^"([^"]+)"/);
    if (!m) continue;
    const full = m[1];
    const leaf = full.split("\\").pop() ?? "";
    if (leaf.startsWith(TASK_PREFIX)) {
      names.add(leaf.slice(TASK_PREFIX.length));
    }
  }
  return Array.from(names).sort();
}

// I/O surface — injectable so tests can drive the orchestration without
// spawning real schtasks.exe.

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface WinEnv {
  exec: (cmd: string, args: string[]) => ExecResult;
  currentUser: string;
}

export function defaultEnv(): WinEnv {
  return {
    exec: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      return {
        status: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
    currentUser: userInfo().username,
  };
}

export function windowsScheduler(env: WinEnv = defaultEnv()): Scheduler {
  return {
    install(job) {
      validateJobName(job.name);
      if (!Number.isFinite(job.intervalSeconds) || job.intervalSeconds <= 0) {
        throw new Error(`tpm schedule: intervalSeconds must be positive (got ${job.intervalSeconds}).`);
      }
      if (job.args.length === 0) {
        throw new Error("tpm schedule: job command is empty.");
      }
      const r = env.exec("schtasks", buildCreateArgs(job, env.currentUser));
      if (r.status !== 0) {
        throw new Error(`schtasks /Create failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
      }
    },
    uninstall(name) {
      validateJobName(name);
      const r = env.exec("schtasks", buildDeleteArgs(name));
      // Already absent → treat as success so uninstall stays idempotent.
      if (r.status !== 0 && !/cannot find|does not exist/i.test(r.stderr + r.stdout)) {
        throw new Error(`schtasks /Delete failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
      }
    },
    status(name): SchedulerStatus {
      validateJobName(name);
      const r = env.exec("schtasks", buildQueryArgs(name));
      return r.status === 0 ? "installed" : "missing";
    },
    list() {
      const r = env.exec("schtasks", buildQueryArgs());
      if (r.status !== 0) {
        // Empty library: schtasks may return non-zero with "no tasks". Treat
        // as empty rather than failing the list verb.
        if (/no tasks|no scheduled tasks/i.test(r.stderr + r.stdout)) return [];
        throw new Error(`schtasks /Query failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
      }
      return parseListOutput(r.stdout);
    },
  };
}
