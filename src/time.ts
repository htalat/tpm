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
