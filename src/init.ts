import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig, writeConfig, CONFIG_PATH, DEFAULT_TIMEZONE } from "./config.ts";
import { PROJECT_TEMPLATE, TASK_TEMPLATE } from "./defaults.ts";

export interface InitResult {
  root: string;
  configPath: string;
  created: string[];
}

export function init(dir?: string): InitResult {
  const root = resolve(dir && dir.length ? dir : join(homedir(), "tpm"));
  const created: string[] = [];

  const ensureDir = (p: string) => {
    if (!existsSync(p)) { mkdirSync(p, { recursive: true }); created.push(p + "/"); }
  };
  const ensureFile = (p: string, content: string) => {
    if (!existsSync(p)) { writeFileSync(p, content); created.push(p); }
  };

  ensureDir(root);
  ensureDir(join(root, "reports"));
  ensureDir(join(root, ".tpm", "templates"));
  ensureFile(join(root, ".tpm", "templates", "project.md"), PROJECT_TEMPLATE);
  ensureFile(join(root, ".tpm", "templates", "task.md"), TASK_TEMPLATE);

  const cfg = readConfig();
  cfg.root = root;
  if (!cfg.timezone) cfg.timezone = DEFAULT_TIMEZONE;
  writeConfig(cfg);

  return { root, configPath: CONFIG_PATH, created };
}
