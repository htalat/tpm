import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Scheduler, SchedulerJob, SchedulerStatus } from "./types.ts";
import { validateJobName } from "./types.ts";

// Adapter for Linux. Default path writes systemd --user units. On a host
// without a running user manager (no XDG_RUNTIME_DIR / no DBus session,
// e.g. SSH-as-non-login), `systemctl --user` probes fail and we fall back
// to a crontab line tagged with a `# tpm:<name>` sentinel for deterministic
// uninstall.

const UNIT_PREFIX = "tpm-";
const SERVICE_SUFFIX = ".service";
const TIMER_SUFFIX = ".timer";
const CRON_SENTINEL_PREFIX = "# tpm:";

// Pure string generators — kept separate so tests don't need to mock fs/exec
// just to verify the rendered unit/cron text.

export function unitName(name: string): string {
  return `${UNIT_PREFIX}${name}`;
}

export function serviceUnitContent(job: SchedulerJob): string {
  const execStart = job.args.map(quoteForExecStart).join(" ");
  return `[Unit]
Description=tpm scheduled job: ${job.name}

[Service]
Type=oneshot
ExecStart=${execStart}
`;
}

export function timerUnitContent(job: SchedulerJob): string {
  return `[Unit]
Description=tpm scheduled job timer: ${job.name}

[Timer]
OnBootSec=${job.intervalSeconds}
OnUnitActiveSec=${job.intervalSeconds}
Persistent=true
Unit=${unitName(job.name)}${SERVICE_SUFFIX}

[Install]
WantedBy=timers.target
`;
}

export function cronLine(job: SchedulerJob): string {
  const schedule = cronSchedule(job.intervalSeconds);
  const cmd = job.args.map(quoteForCron).join(" ");
  return `${schedule} ${cmd} ${CRON_SENTINEL_PREFIX}${job.name}`;
}

// systemd's OnUnitActiveSec is second-granular; crontab is minute-granular.
// We round to minutes, then pick the coarsest field that still hits the
// target interval. Cron's `*/N` only fires at clock-divisor positions, so an
// awkward N (e.g. 7) is approximate — documented limitation of the fallback.
export function cronSchedule(intervalSeconds: number): string {
  const minutes = Math.max(1, Math.round(intervalSeconds / 60));
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.max(1, Math.round(minutes / 60));
  if (hours < 24) return `0 */${hours} * * *`;
  const days = Math.max(1, Math.round(hours / 24));
  return `0 0 */${days} * *`;
}

// Drop any existing crontab lines tagged with this job's sentinel. Caller
// appends the fresh entry and writes the result via `crontab -`.
export function stripCronEntry(currentCrontab: string, name: string): string {
  const sentinel = `${CRON_SENTINEL_PREFIX}${name}`;
  // Anchor the match so `# tpm:poll` doesn't also strip `# tpm:poll-extra`.
  const sentinelRe = new RegExp(`${escapeRegExp(sentinel)}(?![A-Za-z0-9_\\-])`);
  return currentCrontab
    .split("\n")
    .filter(line => !sentinelRe.test(line))
    .join("\n");
}

export function listCronNames(currentCrontab: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${escapeRegExp(CRON_SENTINEL_PREFIX)}([A-Za-z0-9][A-Za-z0-9_\\-]*)`);
  for (const line of currentCrontab.split("\n")) {
    const m = line.match(re);
    if (m) out.push(m[1]);
  }
  return out;
}

function quoteForExecStart(s: string): string {
  // systemd splits ExecStart on whitespace and honors double-quoted strings.
  if (/^[A-Za-z0-9_\/\-\.=]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteForCron(s: string): string {
  // Cron runs commands through /bin/sh; use single quotes with escape-by-close.
  if (/^[A-Za-z0-9_\/\-\.=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// I/O surface — injectable so tests can drive the orchestration without
// touching the real systemctl/crontab/fs.

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SystemdEnv {
  exec: (cmd: string, args: string[], opts?: { input?: string }) => ExecResult;
  homeDir: string;
  fs: {
    writeFile: (path: string, content: string) => void;
    exists: (path: string) => boolean;
    unlink: (path: string) => void;
    readdir: (path: string) => string[];
    mkdirp: (path: string) => void;
  };
}

export function defaultEnv(): SystemdEnv {
  return {
    exec: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { input: opts?.input, encoding: "utf8" });
      return {
        status: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
    homeDir: homedir(),
    fs: {
      writeFile: (p, c) => writeFileSync(p, c),
      exists: (p) => existsSync(p),
      unlink: (p) => { if (existsSync(p)) unlinkSync(p); },
      readdir: (p) => existsSync(p) ? readdirSync(p) : [],
      mkdirp: (p) => mkdirSync(p, { recursive: true }),
    },
  };
}

export function systemdScheduler(env: SystemdEnv = defaultEnv()): Scheduler {
  const unitDir = join(env.homeDir, ".config", "systemd", "user");

  function unitPaths(name: string): { service: string; timer: string } {
    const u = unitName(name);
    return {
      service: join(unitDir, `${u}${SERVICE_SUFFIX}`),
      timer:   join(unitDir, `${u}${TIMER_SUFFIX}`),
    };
  }

  // Probe — `show-environment` requires the user manager to be alive
  // (DBus + XDG_RUNTIME_DIR). Non-zero exit means we should fall back to cron.
  function systemdAvailable(): boolean {
    const r = env.exec("systemctl", ["--user", "show-environment"]);
    return r.status === 0;
  }

  function installViaSystemd(job: SchedulerJob): void {
    env.fs.mkdirp(unitDir);
    const { service, timer } = unitPaths(job.name);
    env.fs.writeFile(service, serviceUnitContent(job));
    env.fs.writeFile(timer, timerUnitContent(job));
    expectOk(env.exec("systemctl", ["--user", "daemon-reload"]), "daemon-reload");
    expectOk(
      env.exec("systemctl", ["--user", "enable", "--now", `${unitName(job.name)}${TIMER_SUFFIX}`]),
      "enable --now",
    );
  }

  function uninstallViaSystemd(name: string): void {
    const { service, timer } = unitPaths(name);
    // disable --now is best-effort: if the unit was never enabled this exits
    // non-zero, and that's fine — proceed with file cleanup.
    env.exec("systemctl", ["--user", "disable", "--now", `${unitName(name)}${TIMER_SUFFIX}`]);
    env.fs.unlink(service);
    env.fs.unlink(timer);
    env.exec("systemctl", ["--user", "daemon-reload"]);
  }

  function installViaCron(job: SchedulerJob): void {
    const current = readCrontab();
    const stripped = stripCronEntry(current, job.name);
    const next = ensureTrailingNewline(stripped) + cronLine(job) + "\n";
    writeCrontab(next);
  }

  function uninstallViaCron(name: string): void {
    const current = readCrontab();
    const next = ensureTrailingNewline(stripCronEntry(current, name));
    writeCrontab(next);
  }

  function readCrontab(): string {
    const r = env.exec("crontab", ["-l"]);
    // `crontab -l` with no crontab installed exits 1 with "no crontab for ..."
    // on stderr — treat as empty rather than an error.
    if (r.status !== 0) {
      if (/no crontab/i.test(r.stderr)) return "";
      throw new Error(`crontab -l failed (exit ${r.status}): ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  function writeCrontab(content: string): void {
    const r = env.exec("crontab", ["-"], { input: content });
    if (r.status !== 0) {
      throw new Error(`crontab - failed (exit ${r.status}): ${r.stderr.trim()}`);
    }
  }

  return {
    install(job) {
      validateJobName(job.name);
      if (!Number.isFinite(job.intervalSeconds) || job.intervalSeconds <= 0) {
        throw new Error(`tpm schedule: intervalSeconds must be positive (got ${job.intervalSeconds}).`);
      }
      if (job.args.length === 0) {
        throw new Error("tpm schedule: job command is empty.");
      }
      if (systemdAvailable()) installViaSystemd(job);
      else installViaCron(job);
    },
    uninstall(name) {
      validateJobName(name);
      if (systemdAvailable()) uninstallViaSystemd(name);
      else uninstallViaCron(name);
    },
    status(name): SchedulerStatus {
      validateJobName(name);
      if (systemdAvailable()) {
        const { timer } = unitPaths(name);
        return env.fs.exists(timer) ? "installed" : "missing";
      }
      return readCrontab().split("\n").some(line =>
        new RegExp(`${escapeRegExp(`${CRON_SENTINEL_PREFIX}${name}`)}(?![A-Za-z0-9_\\-])`).test(line),
      ) ? "installed" : "missing";
    },
    list() {
      if (systemdAvailable()) {
        return env.fs.readdir(unitDir)
          .filter(f => f.startsWith(UNIT_PREFIX) && f.endsWith(TIMER_SUFFIX))
          .map(f => f.slice(UNIT_PREFIX.length, -TIMER_SUFFIX.length))
          .sort();
      }
      return listCronNames(readCrontab()).sort();
    },
  };
}

function ensureTrailingNewline(s: string): string {
  if (s.length === 0) return "";
  return s.endsWith("\n") ? s : s + "\n";
}

function expectOk(r: ExecResult, label: string): void {
  if (r.status !== 0) {
    throw new Error(`systemctl --user ${label} failed (exit ${r.status}): ${r.stderr.trim()}`);
  }
}
