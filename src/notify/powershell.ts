import { spawnSync } from "node:child_process";
import { logLine } from "../log.ts";

// Adapter for Windows. Backed by powershell.exe (Windows PowerShell 5.1,
// always present on Win10+) so it works on a stock install. Prefers the
// BurntToast module when present — one-liner that produces the same kind of
// toast a user would write themselves — and falls back to the built-in
// Windows.UI.Notifications WinRT API so missing modules don't break notify.

// Escape a string for embedding inside a PowerShell single-quoted literal.
// `'` is the only character that needs escaping there — it doubles into `''`.
// Everything else (including `"`, `$`, backticks, backslashes, newlines) is
// literal inside single quotes.
export function escapePsSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

// Inline PowerShell snippet for `-Command`. Single line, statements joined
// with `;` so any shell/argv layer that re-renders the arg can't mangle it.
// Order: BurntToast (preferred — one cmdlet, themed) → WinRT (verbose but
// dependency-free). Inside the snippet `$ErrorActionPreference = 'SilentlyContinue'`
// keeps both branches silent on failure; the outer process exit code is the
// only signal the Node side gets.
export function buildPowerShellSnippet(title: string, body: string): string {
  const t = escapePsSingleQuoted(title);
  const b = escapePsSingleQuoted(body);
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$t = '${t}'`,
    `$b = '${b}'`,
    `if (Get-Module -ListAvailable -Name BurntToast) {`,
    ` Import-Module BurntToast;`,
    ` New-BurntToastNotification -Text @($t, $b)`,
    `} else {`,
    ` [void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];`,
    ` [void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime];`,
    ` $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);`,
    ` $nodes = $tpl.GetElementsByTagName('text');`,
    ` [void]$nodes.Item(0).AppendChild($tpl.CreateTextNode($t));`,
    ` [void]$nodes.Item(1).AppendChild($tpl.CreateTextNode($b));`,
    ` $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl);`,
    ` [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('tpm').Show($toast)`,
    `}`,
  ].join(" ");
}

export function buildPowerShellArgs(title: string, body: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", buildPowerShellSnippet(title, body)];
}

export interface PowerShellSpawnResult {
  status: number | null;
  error?: Error;
}

export interface PowerShellNotifyOpts {
  // Test seam — replace the real spawnSync call.
  spawn?: (cmd: string, args: string[]) => PowerShellSpawnResult;
  // Test seam — replace the WARN log sink.
  log?: (message: string) => void;
}

// Fire a Windows toast. Best-effort: missing powershell.exe or a non-zero exit
// is logged once as WARN and swallowed so a missing dependency can never block
// the orchestrator.
export function firePowerShellNotification(
  title: string,
  body: string,
  opts: PowerShellNotifyOpts = {},
): void {
  const args = buildPowerShellArgs(title, body);
  const spawn = opts.spawn ?? defaultSpawn;
  const warn = opts.log ?? defaultWarn;
  try {
    const r = spawn("powershell", args);
    if (r.error) {
      warn(`powershell spawn failed: ${r.error.message} — toast skipped`);
      return;
    }
    if (r.status !== 0 && r.status !== null) {
      warn(`powershell exited ${r.status} — toast skipped`);
    }
  } catch (e) {
    warn(`powershell unexpected error: ${(e as Error).message} — toast skipped`);
  }
}

function defaultSpawn(cmd: string, args: string[]): PowerShellSpawnResult {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return { status: r.status, error: r.error };
}

function defaultWarn(message: string): void {
  logLine("WARN", "notify", message);
}
