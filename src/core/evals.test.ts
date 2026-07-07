import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { runEvals, scoreRunLog } from "./evals.ts";

const FULL_LOG = [
  '{"type":"system","subtype":"init","session_id":"s1"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Bash","input":{"command":"ls"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","is_error":true,"content":"This command requires approval"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"2","name":"Read","input":{"file_path":"x"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"2","is_error":false,"content":"ok"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"done","duration_ms":120000,"total_cost_usd":1.25}',
].join("\n") + "\n";

test("scoreRunLog: turns, errors, denials, cost, duration, outcome", () => {
  const m = scoreRunLog("p/001-a", "20260701T120000Z.log", FULL_LOG);
  assert.equal(m.turns, 2);
  assert.equal(m.toolErrors, 1);
  assert.equal(m.permissionDenials, 1);
  assert.equal(m.costUsd, 1.25);
  assert.equal(m.durationMs, 120000);
  assert.equal(m.outcome, "success");
  assert.equal(m.startedAt, "2026-07-01T12:00:00Z");

  const dead = scoreRunLog("p/001-a", "20260701T130000Z.log", '{"type":"system","subtype":"init"}\n');
  assert.equal(dead.outcome, "no-result");
});

function tree(): string {
  const root = mkTempDir("tpm-evals-");
  mkdirSync(join(root, ".tpm"), { recursive: true });
  const tdir = join(root, "p", "tasks", "001-a");
  mkdirSync(join(tdir, "runs"), { recursive: true });
  writeFileSync(join(root, "p", "project.md"), "---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n");
  writeFileSync(join(tdir, "task.md"), "---\ntitle: A\nslug: a\nproject: p\nstatus: done\ntype: pr\norchestrator_attempts: 2\nprs:\n  - https://x/1\n---\n\n# A\n");
  writeFileSync(join(tdir, "runs", "20260701T120000Z.log"), FULL_LOG);
  writeFileSync(join(tdir, "runs", "20260601T120000Z.log"), FULL_LOG); // outside a 7d window from July 5
  const journal = [
    { at: "2026-07-01T10:00:00Z", task: "p/001-a", from: "ready", to: "in-progress", verb: "started", actor: "w1" },
    { at: "2026-07-01T18:00:00Z", task: "p/001-a", from: "review", to: "rework", verb: "ci fail", actor: "poll" },
    { at: "2026-07-02T10:00:00Z", task: "p/001-a", from: "review", to: "done", verb: "closed", actor: "cli" },
  ].map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(root, ".tpm", "events.ndjson"), journal);
  return root;
}

test("runEvals: windows runs, aggregates, and derives task metrics from the journal", () => {
  const root = tree();
  try {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const r = runEvals(root, { sinceDays: 7, now });
    assert.equal(r.runs.length, 1); // June run excluded by the window
    assert.equal(r.aggregate.totalCostUsd, 1.25);
    assert.equal(r.aggregate.permissionDenialRuns, 1);
    assert.equal(r.tasks.length, 1);
    const t = r.tasks[0];
    assert.equal(t.reworkCycles, 1);
    assert.equal(t.attempts, 2);
    assert.equal(t.timeToCloseMs, Date.parse("2026-07-02T10:00:00Z") - Date.parse("2026-07-01T10:00:00Z"));
    assert.deepEqual(r.aggregate.hotTasks, []); // 1 run — under the runaway threshold

    const all = runEvals(root, { now });
    assert.equal(all.runs.length, 2); // no window -> both
  } finally {
    rmTempDir(root);
  }
});
