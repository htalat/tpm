import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const CONFIG_DIR = resolve(homedir(), ".tpm");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

export interface Config {
  root?: string;
  timezone?: string;
  time_bound_minutes?: number;
  notifications?: NotificationsConfig;
  // Default agent CLI for `tpm orchestrate` (claude, copilot, …). Per-task
  // and per-project `agent:` frontmatter overrides this; the orchestrator's
  // `--agent <name>` flag wins over both. See src/agent_cli.ts.
  agent?: string;
  // Desired worker pool size for `tpm orchestrate`. Re-read each reconcile
  // tick so `tpm config set workers N` adjusts the live pool without
  // restarting the process. `0` parks the pool (no workers; orchestrate
  // keeps watching the config). Negative / non-integer values are clamped
  // to 1 by the orchestrator with a warning — config.ts permits any finite
  // number so a hand-edited bad value doesn't crash every consumer.
  workers?: number;
}

export interface NotificationsConfig {
  start?: boolean;
  finish?: boolean;
  fail?: boolean;
}

export const DEFAULT_TIMEZONE = "America/Los_Angeles";
export const DEFAULT_TIME_BOUND_MINUTES = 30;
// Quiet on start (every cron tick), visible on completion + failure.
export const DEFAULT_NOTIFICATIONS: Required<NotificationsConfig> = {
  start: false,
  finish: true,
  fail: true,
};

export function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  const text = readFileSync(CONFIG_PATH, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    const got = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
    throw new Error(`${CONFIG_PATH} must be a JSON object, got ${got}`);
  }
  // Validate each known field instead of casting the whole object to Config —
  // a bare `as Config` claims more than we've checked (e.g., would let
  // `{"root": 42}` through with cfg.root: 42 at runtime).
  const record = raw as Record<string, unknown>;
  const cfg: Config = {};
  if (record.root !== undefined) {
    cfg.root = expectString(record.root, "root");
  }
  if (record.timezone !== undefined) {
    cfg.timezone = expectString(record.timezone, "timezone");
  }
  if (record.time_bound_minutes !== undefined) {
    cfg.time_bound_minutes = expectPositiveInt(record.time_bound_minutes, "time_bound_minutes");
  }
  if (record.notifications !== undefined) {
    cfg.notifications = expectNotifications(record.notifications);
  }
  if (record.agent !== undefined) {
    cfg.agent = expectString(record.agent, "agent");
  }
  if (record.workers !== undefined) {
    cfg.workers = expectFiniteNumber(record.workers, "workers");
  }
  return cfg;
}

function expectNotifications(value: unknown): NotificationsConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    throw new Error(`${CONFIG_PATH}: "notifications" must be an object, got ${got}`);
  }
  const record = value as Record<string, unknown>;
  const out: NotificationsConfig = {};
  for (const key of ["start", "finish", "fail"] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== "boolean") {
        throw new Error(`${CONFIG_PATH}: "notifications.${key}" must be a boolean, got ${typeof record[key]}`);
      }
      out[key] = record[key] as boolean;
    }
  }
  return out;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${CONFIG_PATH}: "${field}" must be a string, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
  }
  return value;
}

function expectPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${CONFIG_PATH}: "${field}" must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

// Permissive number validator: rejects non-number/non-finite types so the
// caller is guaranteed `typeof value === "number"`, but accepts zero,
// negatives, and floats. Callers that need stricter semantics (e.g. clamp
// bad values to 1 at runtime) apply their own logic — see clampWorkers in
// src/orchestrate.ts.
function expectFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${CONFIG_PATH}: "${field}" must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function writeConfig(cfg: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
