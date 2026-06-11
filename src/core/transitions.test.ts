import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VALID_STATUSES,
  TRANSITIONS,
  canTransition,
  legalTargets,
  assertTransition,
  isStatus,
} from "./transitions.ts";

test("every status has a row; targets are valid statuses and never self", () => {
  for (const from of VALID_STATUSES) {
    const targets = TRANSITIONS[from];
    assert.ok(Array.isArray(targets), `missing row for ${from}`);
    assert.ok(!targets.includes(from), `${from} lists itself as a target`);
    for (const to of targets) {
      assert.ok(isStatus(to), `${from} -> ${to}: unknown target`);
    }
  }
});

test("terminals have exactly one exit: reopen to open", () => {
  assert.deepEqual([...TRANSITIONS.done], ["open"]);
  assert.deepEqual([...TRANSITIONS.dropped], ["open"]);
  // Cross-terminal moves are refused both ways.
  assert.equal(canTransition("done", "dropped"), false);
  assert.equal(canTransition("dropped", "done"), false);
});

test("open is pre-deliverable: no jump to needs-* states", () => {
  assert.equal(canTransition("open", "needs-review"), false);
  assert.equal(canTransition("open", "needs-feedback"), false);
  assert.equal(canTransition("open", "needs-close"), false);
  // But the legitimate entries are all there.
  for (const to of ["ready", "in-progress", "blocked", "done", "dropped"] as const) {
    assert.equal(canTransition("open", to), true, `open -> ${to}`);
  }
});

test("queue / in-flight statuses are fully connected", () => {
  const inFlight = ["ready", "in-progress", "needs-feedback", "needs-review", "needs-close"] as const;
  for (const from of inFlight) {
    for (const to of inFlight) {
      if (from === to) continue;
      assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
    }
    // And each can be pulled to open, blocked... (needs-* and ready/in-progress
    // reach every other status).
    assert.equal(canTransition(from, "open"), true, `${from} -> open`);
    assert.equal(canTransition(from, "done"), true, `${from} -> done`);
    assert.equal(canTransition(from, "dropped"), true, `${from} -> dropped`);
  }
});

test("blocked re-enters via open/ready/in-progress or closes; poller targets unreachable", () => {
  assert.deepEqual([...TRANSITIONS.blocked], ["open", "ready", "in-progress", "done", "dropped"]);
  assert.equal(canTransition("blocked", "needs-review"), false);
});

test("unknown or empty `from` is a repair wildcard", () => {
  assert.equal(canTransition("", "done"), true);
  assert.equal(canTransition("garbage", "ready"), true);
  assert.deepEqual([...legalTargets("garbage")], [...VALID_STATUSES]);
});

test("assertTransition: passes on legal, throws with hint on illegal", () => {
  assertTransition("t", "ready", "in-progress"); // no throw
  assert.throws(
    () => assertTransition("alpha/001-a", "done", "in-progress"),
    /Cannot transition alpha\/001-a from "done" to "in-progress"\. done is terminal — `tpm reopen` is the only exit\./,
  );
  assert.throws(
    () => assertTransition("t", "open", "needs-review"),
    /Legal targets from "open": ready, in-progress, blocked, done, dropped\./,
  );
});
