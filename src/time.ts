import { readConfig, DEFAULT_TIMEZONE } from "./config.ts";

export function now(date: Date = new Date()): string {
  return format(date, configuredTimezone());
}

export function configuredTimezone(): string {
  const cfg = readConfig();
  return cfg.timezone && cfg.timezone.length ? cfg.timezone : DEFAULT_TIMEZONE;
}

function format(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")} ${get("timeZoneName")}`;
}

// ISO-8601 second precision with explicit offset (e.g. 2026-05-15T09:14:23-07:00)
// in the configured TZ. Used by structured log emitters so live-tailing a log
// shows wall-clock-readable timestamps; the offset keeps lines unambiguous if
// they're ever shipped off-host.
export function isoWithOffset(date: Date = new Date(), tz?: string): string {
  const timeZone = tz ?? configuredTimezone();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const wall = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  // Offset = (wall-clock interpreted as UTC) minus the actual UTC instant.
  const offMinutes = Math.round((Date.parse(`${wall}Z`) - date.getTime()) / 60000);
  const sign = offMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${wall}${sign}${hh}:${mm}`;
}

// Convert a wall-clock string in the configured TZ ("YYYY-MM-DD HH:MM[:SS]")
// to an ISO-with-offset string. The trailing zone abbreviation that `tpm now`
// emits (e.g. " PDT") is accepted and ignored — `tz` (or the configured
// timezone) is the authority, so DST is settled correctly even if the
// abbreviation in the original string is wrong or unfamiliar.
//
// Used to merge task-body Log entries (minute-precision, configured-TZ) with
// envelope-log entries (second-precision ISO-with-offset) on a single
// chronological timeline.
export function wallToIsoOffset(wall: string, tz?: string): string | null {
  const m = wall.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\b/);
  if (!m) return null;
  const timeZone = tz ?? configuredTimezone();
  // Treat the wall-clock as if it were UTC, then back out the actual UTC
  // instant by subtracting the tz's offset at that instant. One iteration of
  // refinement settles the rare DST-fall-back overlap.
  const fauxUtcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? "0"));
  let actualMs = fauxUtcMs;
  for (let i = 0; i < 2; i++) {
    actualMs = fauxUtcMs - tzOffsetMinutes(new Date(actualMs), timeZone) * 60000;
  }
  return isoWithOffset(new Date(actualMs), timeZone);
}

// Offset (in minutes east of UTC) for `date` interpreted in `timeZone`. Same
// trick as `isoWithOffset` uses inline: format the instant in the zone,
// pretend that wall time is UTC, subtract the actual UTC instant. Positive
// for zones ahead of UTC (e.g. Asia/Kolkata = +330).
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const wall = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  return Math.round((Date.parse(`${wall}Z`) - date.getTime()) / 60000);
}
