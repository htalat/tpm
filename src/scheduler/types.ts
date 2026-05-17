import { systemdScheduler } from "./systemd.ts";
import { windowsScheduler } from "./task-scheduler.ts";

// One scheduler interface, per-platform writers underneath. Linux/systemd
// and Windows/schtasks adapters exist today; macOS launchd lands in a follow-up.

export type SchedulerJob = {
  // Stable job identifier — used as the unit name (`tpm-<name>`) and the
  // crontab sentinel (`# tpm:<name>`). Restricted to a safe charset so it
  // can flow through both without escaping.
  name: string;
  // Full command to invoke, args[0] is the executable. The CLI resolves
  // bare `tpm` to an absolute path before calling install() so the unit
  // file works under a stripped systemd/cron environment.
  args: string[];
  intervalSeconds: number;
};

export type SchedulerStatus = "installed" | "missing";

export interface Scheduler {
  install(job: SchedulerJob): void;
  uninstall(name: string): void;
  status(name: string): SchedulerStatus;
  list(): string[];
}

export function getScheduler(platform: NodeJS.Platform = process.platform): Scheduler {
  if (platform === "linux") return systemdScheduler();
  if (platform === "win32") return windowsScheduler();
  if (platform === "darwin") {
    throw new Error(
      `tpm schedule: macOS launchd adapter is not yet implemented. ` +
      `Install recurring jobs via crontab for now (see the README's "Recurring scripts" section).`,
    );
  }
  throw new Error(`tpm schedule: unsupported platform "${platform}" (supported: linux, win32).`);
}

export const SCHEDULER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-]*$/;

export function validateJobName(name: string): void {
  if (!SCHEDULER_NAME_RE.test(name)) {
    throw new Error(
      `tpm schedule: invalid job name "${name}" — must match ${SCHEDULER_NAME_RE} ` +
      `(letters, digits, underscore, hyphen; must start with alphanumeric).`,
    );
  }
}
