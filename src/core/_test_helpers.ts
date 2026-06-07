import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Side-effect: re-home this process before any tpm module reads ~/.tpm.
// Static ES-module imports are evaluated in order, so importing this file
// from a test before importing config/init/time gives that test its own
// isolated HOME.
const home = mkdtempSync(join(tmpdir(), "tpm-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

export const TEMP_HOME = home;

export function mkTempDir(prefix = "tpm-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rmTempDir(p: string): void {
  rmSync(p, { recursive: true, force: true });
}
