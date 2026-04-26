import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, CONFIG_PATH } from "./config.ts";

export function findRoot(): string {
  const cfg = readConfig();
  if (!cfg.root || !cfg.root.length) {
    throw new Error(
      `No tpm tree configured. Run: tpm init [<dir>]\n` +
      `(writes ${CONFIG_PATH} with the chosen root)`
    );
  }
  const path = resolve(cfg.root);
  if (!existsSync(path)) {
    throw new Error(`tpm root does not exist: ${path}\nRun: tpm init <dir>`);
  }
  if (!statSync(path).isDirectory()) {
    throw new Error(`tpm root is not a directory: ${path}`);
  }
  if (!existsSync(resolve(path, ".tpm"))) {
    throw new Error(`tpm root has no .tpm/ directory: ${path}\nRun: tpm init ${path}`);
  }
  return path;
}
