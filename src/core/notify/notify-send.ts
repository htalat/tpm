import { spawnSync } from "node:child_process";
import { logLine } from "../log.ts";

// Adapter for Linux desktops. Backed by `notify-send` (libnotify) — the
// de-facto CLI for desktop notifications across GNOME/KDE and most
// freedesktop.org environments. Best-effort: if `notify-send` isn't installed
// (headless box, minimal container, plain SSH session) the spawn fails and we
// log a single WARN, so a missing binary can never block the orchestrator.
//
// Unlike the macOS/Windows adapters there's no click-to-open here: `notify-send`
// can only attach actions when a live action-handling daemon is present and the
// caller blocks waiting for the click, which doesn't fit a fire-and-forget cron
// hook. So the serve deep link is dropped on Linux — the notification is
// display-only. (Wire `--action` + `--wait` in a follow-up if click-through
// becomes worth the blocking call.)

export function buildNotifySendArgs(title: string, body: string): string[] {
  // Title/body go straight to argv — no shell, so nothing to escape. `-a tpm`
  // sets the application name (groups tpm's toasts in notification centres);
  // `--` stops option parsing so a title beginning with `-` is treated as text.
  return ["-a", "tpm", "--", title, body];
}

export interface NotifySendSpawnResult {
  status: number | null;
  error?: Error;
}

export interface NotifySendOpts {
  // Test seam — replace the real spawnSync call.
  spawn?: (cmd: string, args: string[]) => NotifySendSpawnResult;
  // Test seam — replace the WARN log sink.
  log?: (message: string) => void;
}

// Fire a Linux desktop notification. Best-effort: a missing `notify-send` or a
// non-zero exit is logged once as WARN and swallowed.
export function fireNotifySendNotification(
  title: string,
  body: string,
  opts: NotifySendOpts = {},
): void {
  const args = buildNotifySendArgs(title, body);
  const spawn = opts.spawn ?? defaultSpawn;
  const warn = opts.log ?? defaultWarn;
  try {
    const r = spawn("notify-send", args);
    if (r.error) {
      warn(`notify-send spawn failed: ${r.error.message} — notification skipped`);
      return;
    }
    if (r.status !== 0 && r.status !== null) {
      warn(`notify-send exited ${r.status} — notification skipped`);
    }
  } catch (e) {
    warn(`notify-send unexpected error: ${(e as Error).message} — notification skipped`);
  }
}

function defaultSpawn(cmd: string, args: string[]): NotifySendSpawnResult {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return { status: r.status, error: r.error };
}

function defaultWarn(message: string): void {
  logLine("WARN", "notify", message);
}
