import { spawnSync } from "node:child_process";
import { DEFAULT_NOTIFICATIONS } from "./config.ts";
import type { NotificationsConfig } from "./config.ts";
import { firePowerShellNotification } from "./notify/powershell.ts";
import { fireNotifySendNotification } from "./notify/notify-send.ts";
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
  // Deep link to open when the notification is clicked (e.g. the task's
  // `tpm serve` page). On macOS this needs `terminal-notifier` on PATH —
  // `osascript display notification` has no click-action API — so when it's
  // absent we fall back to a non-clickable osascript notification. On Windows
  // the URL becomes the toast's protocol-launch target.
  url?: string;
  // For tests: replace the side-effecting OS calls and PATH probe so adapter
  // selection is unit-testable off-platform.
  osascript?: (title: string, message: string) => void;
  terminalNotifier?: (title: string, message: string, url: string) => void;
  powershell?: (title: string, message: string, url?: string) => void;
  notifySend?: (title: string, message: string) => void;
  hasTerminalNotifier?: () => boolean;
}

// Fire a system notification. Best-effort — silently skips on unsupported
// platforms and swallows adapter errors so a missing binary or permission
// denial never blocks the orchestrator.
export function fireNotification(title: string, message: string, opts: FireNotifyOpts = {}): void {
  // A macOS seam (or the detection seam) forces the darwin path; `powershell`
  // forces win32; `notifySend` forces linux — so the selection logic runs in
  // tests on any host.
  if (opts.osascript || opts.terminalNotifier || opts.hasTerminalNotifier) {
    fireDarwin(title, message, opts);
    return;
  }
  if (opts.powershell) {
    fireWindows(title, message, opts);
    return;
  }
  if (opts.notifySend) {
    fireLinux(title, message, opts);
    return;
  }
  if (process.platform === "darwin") {
    fireDarwin(title, message, opts);
    return;
  }
  if (process.platform === "win32") {
    fireWindows(title, message, opts);
    return;
  }
  if (process.platform === "linux") {
    fireLinux(title, message, opts);
    return;
  }
  // No portable system-notification channel for this platform yet. Log to
  // stderr so cron logs still capture the event signal.
  console.error(`tpm notify: skipping (platform=${process.platform}, no adapter) — ${title}: ${message}`);
}

// macOS: clickable via `terminal-notifier` when a URL is set and the binary is
// installed; otherwise the current non-clickable osascript notification.
function fireDarwin(title: string, message: string, opts: FireNotifyOpts): void {
  const hasTn = opts.hasTerminalNotifier ?? defaultHasTerminalNotifier;
  if (opts.url && hasTn()) {
    const tn = opts.terminalNotifier ?? defaultTerminalNotifier;
    try { tn(title, message, opts.url); } catch { /* best-effort */ }
    return;
  }
  const osa = opts.osascript ?? defaultOsascript;
  try { osa(title, message); } catch { /* best-effort */ }
}

// Windows: the PowerShell adapter carries the URL as the toast's launch target.
function fireWindows(title: string, message: string, opts: FireNotifyOpts): void {
  if (opts.powershell) {
    try { opts.powershell(title, message, opts.url); } catch { /* best-effort */ }
    return;
  }
  firePowerShellNotification(title, message, { url: opts.url });
}

// Linux: `notify-send` (libnotify). Display-only — no portable click action, so
// `url` is intentionally ignored (see notify-send.ts).
function fireLinux(title: string, message: string, opts: FireNotifyOpts): void {
  if (opts.notifySend) {
    try { opts.notifySend(title, message); } catch { /* best-effort */ }
    return;
  }
  fireNotifySendNotification(title, message);
}

function defaultOsascript(title: string, message: string): void {
  // `display notification` accepts double-quoted strings; escape `"` and `\`
  // in the message + title so a slug or reason with quotes can't break out.
  const script = `display notification "${escapeOsa(message)}" with title "${escapeOsa(title)}"`;
  spawnSync("osascript", ["-e", script], { stdio: "ignore" });
}

function defaultTerminalNotifier(title: string, message: string, url: string): void {
  // Title/message go as separate argv (no shell escaping needed). `-execute`
  // runs a shell command on click; single-quote the URL so a configured base
  // URL with shell metacharacters can't break out of `open`.
  spawnSync(
    "terminal-notifier",
    ["-title", title, "-message", message, "-execute", `open '${url.replace(/'/g, "'\\''")}'`],
    { stdio: "ignore" },
  );
}

// True when `terminal-notifier` is on PATH. `which` is always present on macOS,
// the only platform that reaches this; any spawn error is treated as "absent".
function defaultHasTerminalNotifier(): boolean {
  try {
    return spawnSync("which", ["terminal-notifier"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function escapeOsa(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
