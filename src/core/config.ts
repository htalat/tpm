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
  // Where a running `tpm serve` can be reached, used to build clickable
  // notification deep links. Hand-edited (no `tpm config set` setter); see
  // serveBaseUrl below for the default.
  serve?: ServeConfig;
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
  // PR-signal poller cadence. A per-PR fetch floor: `tpm poll` skips a PR
  // whose cache was last refreshed within the window, so a fast cron doesn't
  // hammer the host API for PRs that haven't moved. See src/orchestrate/poll.ts
  // for resolution + built-in defaults (conservative for ADO).
  poll?: PollConfig;
}

export interface PollConfig {
  // Global per-PR floor in minutes. Skipped if a fresher cache exists.
  min_interval_minutes?: number;
  // Optional per-host overrides keyed by host name ('github', 'ado', …).
  // A configured per-host value wins over the global floor for that host.
  per_host?: Record<string, PollHostConfig>;
}

export interface PollHostConfig {
  min_interval_minutes?: number;
}

export interface NotificationsConfig {
  start?: boolean;
  finish?: boolean;
  fail?: boolean;
}

export interface ServeConfig {
  // Base URL of a running `tpm serve`, e.g. `http://127.0.0.1:7777`. Notification
  // deep links are built as `<url>/t/<project>/<slug>`. Only meaningful while
  // serve is running — clicking when it's down lands the browser on a connection
  // error (acceptable for v0; the user starts serve themselves).
  url?: string;
}

// Defaults for `tpm serve` (host/port) — kept here so the serve command and the
// notification deep-link builder share one source of truth.
export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 7777;
export const DEFAULT_SERVE_BASE_URL = `http://${DEFAULT_SERVE_HOST}:${DEFAULT_SERVE_PORT}`;

// Resolve the base URL for notification deep links: the configured `serve.url`
// when set (trimmed, non-empty), else the default loopback address.
export function serveBaseUrl(cfg: Config): string {
  const u = cfg.serve?.url?.trim();
  return u ? u : DEFAULT_SERVE_BASE_URL;
}

export const DEFAULT_TIMEZONE = "America/Los_Angeles";
export const DEFAULT_TIME_BOUND_MINUTES = 30;
// PR-signal poll floor (minutes since last successful fetch) when nothing is
// configured. Global default stays responsive for GitHub; the per-host map
// pushes ADO out to 15m so an unconfigured tree stops hammering its API.
export const DEFAULT_POLL_MIN_INTERVAL_MINUTES = 5;
export const DEFAULT_POLL_PER_HOST: Readonly<Record<string, number>> = { ado: 15 };
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
  if (record.serve !== undefined) {
    cfg.serve = expectServe(record.serve);
  }
  if (record.agent !== undefined) {
    cfg.agent = expectString(record.agent, "agent");
  }
  if (record.workers !== undefined) {
    cfg.workers = expectFiniteNumber(record.workers, "workers");
  }
  if (record.poll !== undefined) {
    cfg.poll = expectPoll(record.poll);
  }
  return cfg;
}

function expectPoll(value: unknown): PollConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    throw new Error(`${CONFIG_PATH}: "poll" must be an object, got ${got}`);
  }
  const record = value as Record<string, unknown>;
  const out: PollConfig = {};
  if (record.min_interval_minutes !== undefined) {
    out.min_interval_minutes = expectPositiveInt(record.min_interval_minutes, "poll.min_interval_minutes");
  }
  if (record.per_host !== undefined) {
    out.per_host = expectPerHost(record.per_host);
  }
  return out;
}

function expectPerHost(value: unknown): Record<string, PollHostConfig> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    throw new Error(`${CONFIG_PATH}: "poll.per_host" must be an object, got ${got}`);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, PollHostConfig> = {};
  for (const [host, hostValue] of Object.entries(record)) {
    if (hostValue === null || typeof hostValue !== "object" || Array.isArray(hostValue)) {
      const got = hostValue === null ? "null" : Array.isArray(hostValue) ? "array" : typeof hostValue;
      throw new Error(`${CONFIG_PATH}: "poll.per_host.${host}" must be an object, got ${got}`);
    }
    const hostRecord = hostValue as Record<string, unknown>;
    const hostOut: PollHostConfig = {};
    if (hostRecord.min_interval_minutes !== undefined) {
      hostOut.min_interval_minutes = expectPositiveInt(
        hostRecord.min_interval_minutes,
        `poll.per_host.${host}.min_interval_minutes`,
      );
    }
    out[host] = hostOut;
  }
  return out;
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

function expectServe(value: unknown): ServeConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    throw new Error(`${CONFIG_PATH}: "serve" must be an object, got ${got}`);
  }
  const record = value as Record<string, unknown>;
  const out: ServeConfig = {};
  if (record.url !== undefined) {
    out.url = expectString(record.url, "serve.url");
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
