import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Regression guard for task 114: a top-level help/config branch referencing a
// const declared *after* the dispatch crashes with a TDZ ReferenceError before
// any of the assertions below would have caught it. Spawning the real entry
// point is the only thing that exercises module-load order.
for (const variant of ["help", "--help", "-h"]) {
  test(`entry point: \`tpm ${variant}\` exits clean and prints usage`, () => {
    const r = runCli([variant]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Usage:/);
    assert.doesNotMatch(r.stderr, /before initialization/);
  });
}

test("entry point: bare `tpm` prints usage and exits clean", () => {
  const r = runCli([]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage:/);
});

test("entry point: `tpm drop` with no task prints usage and exits non-zero", () => {
  // The drop verb (task 140) gates on a task arg before touching the tree, so
  // this exercises the dispatch + usage path without needing a configured root.
  const r = runCli(["drop"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /tpm drop <task>/);
});

test("entry point: `tpm help` documents the drop verb", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /tpm drop <task>/);
});

test("entry point: `tpm config get <unknown>` reports the known-keys list (no TDZ)", () => {
  // Hits the same const that broke `help`. Validation error is expected; a
  // TDZ ReferenceError is not.
  const r = runCli(["config", "get", "definitely-not-a-key"]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /before initialization/);
  assert.match(r.stderr, /unknown key.*known: workers/);
});
