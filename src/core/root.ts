import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, CONFIG_PATH } from "./config.ts";

export function findRoot(): string {
  // TPM_ROOT: point every tpm invocation in a process tree at a specific
  // tree without touching ~/.tpm/config.json. The evals runner uses it so
  // fixture isolation doesn't require faking HOME (which strands the real
  // agent CLI's login). Same validation as the config path.
  if (process.env.TPM_ROOT) {
    return validateRoot(resolve(process.env.TPM_ROOT));
  }
  const cfg = readConfig();
  if (!cfg.root || !cfg.root.length) {
    throw new Error(
      `No tpm tree configured. Run: tpm init [<dir>]\n` +
      `(writes ${CONFIG_PATH} with the chosen root)`
    );
  }
  return validateRoot(resolve(cfg.root));
}

function validateRoot(path: string): string {
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
