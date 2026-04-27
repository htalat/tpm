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
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    const got = obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj;
    throw new Error(`${CONFIG_PATH} must be a JSON object, got ${got}`);
  }
  return obj as Config;
}

export function writeConfig(cfg: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
