import { TEMP_HOME } from "../_test_helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { init } from "../init.ts";
import { startHarness } from "./supervisor.ts";
import type { HarnessEvent } from "./supervisor.ts";

// Integration: a real (empty) temp tree, workers: 0 so the pool parks with
// no worker loops, an immediate poll tick against zero tasks. Exercises the
// full start → snapshot → stop lifecycle without spawning agent processes.
test("startHarness: starts, polls once, snapshots, and stops cleanly", async () => {
  const root = join(TEMP_HOME, "tree");
  init(root); // writes ~/.tpm/config.json (re-homed by _test_helpers)

  const events: HarnessEvent[] = [];
  const harness = startHarness({
    root,
    workers: 0,
    pollIntervalSec: 3600, // only the immediate first tick fires during the test
    onEvent: e => events.push(e),
  });

  // The first poll tick fires immediately; give it a beat to settle.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (harness.snapshot().lastPoll) break;
    await new Promise(r => setTimeout(r, 25));
  }

  const snap = harness.snapshot();
  assert.ok(snap.lastPoll, "first poll tick should have completed");
  assert.equal(snap.lastPoll?.error, undefined, `poll errored: ${snap.lastPoll?.error}`);
  assert.equal(snap.lastPoll?.summary?.checked, 0, "empty tree: nothing to check");
  assert.equal(snap.desiredWorkers, 0);
  assert.equal(snap.stopping, false);
  assert.ok(!Number.isNaN(Date.parse(snap.startedAt)));

  await harness.stop();
  const snapAfter = harness.snapshot();
  assert.equal(snapAfter.stopping, true);

  const types = events.map(e => e.type);
  assert.ok(types.includes("started"), `missing started event: ${types.join(",")}`);
  assert.ok(types.includes("poll"), `missing poll event: ${types.join(",")}`);
  assert.equal(types[types.length - 1], "stopped", `expected stopped last: ${types.join(",")}`);
});
