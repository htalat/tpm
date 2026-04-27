import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const CONFIG_DIR = resolve(homedir(), ".tpm");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

export interface Config {
  root?: string;
  timezone?: string;
}

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

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
  return cfg;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${CONFIG_PATH}: "${field}" must be a string, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
  }
  return value;
}

export function writeConfig(cfg: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
