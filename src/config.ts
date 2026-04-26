import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const CONFIG_DIR = resolve(homedir(), ".tpm");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

export interface Config {
  root?: string;
}

export function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  const text = readFileSync(CONFIG_PATH, "utf8");
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj as Config : {};
  } catch (e) {
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

export function writeConfig(cfg: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
