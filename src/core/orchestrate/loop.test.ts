import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLoopArgs } from "./loop.ts";

// A bail() that throws so we can assert on rejection instead of exiting the
// test process (cli.ts passes the real `usage`, which calls process.exit).
function bail(msg: string): never {
  throw new Error(msg);
}

test("defaults: 60s cadences, run forever", () => {
  const opts = parseLoopArgs([], bail);
  assert.deepEqual(opts, { pollInterval: 60, orchestrateInterval: 60, once: false });
});

test("parses intervals, workers, and --once", () => {
  const opts = parseLoopArgs(
    ["--poll-interval", "30", "--orchestrate-interval", "300", "--workers", "2", "--once"],
    bail,
  );
  assert.deepEqual(opts, { pollInterval: 30, orchestrateInterval: 300, workers: 2, once: true });
});

test("rejects non-positive / non-numeric values", () => {
  assert.throws(() => parseLoopArgs(["--poll-interval", "0"], bail), /--poll-interval must be a positive number/);
  assert.throws(() => parseLoopArgs(["--workers", "-1"], bail), /--workers must be a positive number/);
  assert.throws(() => parseLoopArgs(["--orchestrate-interval", "abc"], bail), /--orchestrate-interval must be a positive number/);
});

test("rejects unknown flags", () => {
  assert.throws(() => parseLoopArgs(["--nope"], bail), /unknown argument: --nope/);
});
