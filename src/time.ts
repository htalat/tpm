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
