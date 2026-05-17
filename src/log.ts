import { isoWithOffset } from "./time.ts";

export type LogLevel = "INFO" | "WARN" | "ERROR";

// Structured log line — same shape as the legacy scripts/recurring/_log.sh
// emitted, so tailing a single tpm log file (orchestrator runs, poll tick,
// future recurring scripts) sorts/greps cleanly across producers.
//
//   2026-05-15T09:14:23-07:00  INFO   <script>          <message>
//
// Timestamp is ISO-8601 second precision in the configured TZ with explicit
// offset (task 061 — readable when live-tailing; unambiguous if shipped
// cross-host). Level padded to 5 chars; script padded to 16 chars (fits
// "check-pr-signal" with room to grow). INFO/WARN go to stdout, ERROR to
// stderr — interactive runs can `2>/dev/null` for warn-free output without
// losing errors; cron's `>> log 2>&1` collapses both.
export function logLine(level: LogLevel, script: string, message: string): void {
  const ts = isoWithOffset();
  const line = `${ts}  ${level.padEnd(5)}  ${script.padEnd(16)} ${message}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}
