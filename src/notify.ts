import { spawnSync } from "node:child_process";
import { DEFAULT_NOTIFICATIONS } from "./config.ts";
import type { NotificationsConfig } from "./config.ts";
import { firePowerShellNotification } from "./notify/powershell.ts";
import type { Project, Task } from "./tree.ts";

export type NotifyEvent = "start" | "finish" | "fail";
export const NOTIFY_EVENTS: readonly NotifyEvent[] = ["start", "finish", "fail"];

export interface ResolveNotifyInput {
  task: Task;
  project: Project;
  globalConfig?: NotificationsConfig;
}

// Cascade: task > project > global > built-in default. Each event resolves
// independently — a task can override `fail: false` while inheriting the
// global `finish: true`.
export function resolveNotifyConfig(input: ResolveNotifyInput): Required<NotificationsConfig> {
  const taskNotif = readNotifications(input.task.data.notifications);
  const projectNotif = readNotifications(input.project.data.notifications);
  const global = input.globalConfig ?? {};
  return {
    start:  pick(taskNotif.start,  projectNotif.start,  global.start,  DEFAULT_NOTIFICATIONS.start),
    finish: pick(taskNotif.finish, projectNotif.finish, global.finish, DEFAULT_NOTIFICATIONS.finish),
    fail:   pick(taskNotif.fail,   projectNotif.fail,   global.fail,   DEFAULT_NOTIFICATIONS.fail),
  };
}

function pick(...values: Array<boolean | undefined>): boolean {
  for (const v of values) if (v !== undefined) return v;
  return false; // unreachable: the last arg is always a default boolean
}

function readNotifications(v: unknown): NotificationsConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const record = v as Record<string, unknown>;
  const out: NotificationsConfig = {};
  for (const key of NOTIFY_EVENTS) {
    if (typeof record[key] === "boolean") out[key] = record[key] as boolean;
  }
  return out;
}

export function shouldNotify(event: NotifyEvent, input: ResolveNotifyInput): boolean {
  return resolveNotifyConfig(input)[event];
}

export interface FireNotifyOpts {
  // For tests: replace the side-effecting OS call.
  osascript?: (title: string, message: string) => void;
  powershell?: (title: string, message: string) => void;
}

// Fire a system notification. Best-effort — silently skips on unsupported
// platforms and swallows adapter errors so a missing binary or permission
// denial never blocks the orchestrator.
export function fireNotification(title: string, message: string, opts: FireNotifyOpts = {}): void {
  if (opts.osascript) {
    try { opts.osascript(title, message); } catch { /* best-effort */ }
    return;
  }
  if (opts.powershell) {
    try { opts.powershell(title, message); } catch { /* best-effort */ }
    return;
  }
  if (process.platform === "darwin") {
    // `display notification` accepts double-quoted strings; escape `"` and `\`
    // in the message + title so a slug or reason with quotes can't break out.
    const script = `display notification "${escapeOsa(message)}" with title "${escapeOsa(title)}"`;
    try {
      spawnSync("osascript", ["-e", script], { stdio: "ignore" });
    } catch {
      // best-effort
    }
    return;
  }
  if (process.platform === "win32") {
    firePowerShellNotification(title, message);
    return;
  }
  // No portable system-notification channel for this platform yet. Log to
  // stderr so cron logs still capture the event signal.
  console.error(`tpm notify: skipping (platform=${process.platform}, no adapter) — ${title}: ${message}`);
}

function escapeOsa(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
