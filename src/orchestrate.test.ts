import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  classifyDisposition,
  evaluateTerminalState,
  formatDispositionLine,
  noPickLogEntry,
  resolveTimeBound,
  runWithTimeout,
  shouldAutoRevert,
} from "./orchestrate.ts";
import type { Project, Task } from "./tree.ts";

function task(extra: Record<string, unknown> = {}): Task {
  return {
    slug: "001-t",
    path: "/tmp/t.md",
    archived: false,
    data: { slug: "001-t", status: "ready", ...extra },
    body: "",
  };
}

function project(extra: Record<string, unknown> = {}): Project {
  return {
    slug: "p",
    path: "/tmp/p/project.md",
    dir: "/tmp/p",
    data: { slug: "p", status: "active", ...extra },
    body: "",
    tasks: [],
  };
}

test("resolveTimeBound: built-in default when nothing set", () => {
  assert.equal(resolveTimeBound({ task: task(), project: project() }), 30);
});

test("resolveTimeBound: global config wins over default", () => {
  assert.equal(
    resolveTimeBound({ task: task(), project: project() }, 45),
    45,
  );
});

test("resolveTimeBound: project frontmatter wins over global", () => {
  assert.equal(
    resolveTimeBound({ task: task(), project: project({ time_bound_minutes: 60 }) }, 45),
    60,
  );
});

test("resolveTimeBound: task frontmatter wins over project", () => {
  assert.equal(
    resolveTimeBound({
      task: task({ time_bound_minutes: 15 }),
      project: project({ time_bound_minutes: 60 }),
    }, 45),
    15,
  );
});

test("resolveTimeBound: ignores non-positive integers in frontmatter", () => {
  // 0, negative, non-integer, string — all silently fall through.
  assert.equal(
    resolveTimeBound({
      task: task({ time_bound_minutes: 0 }),
      project: project({ time_bound_minutes: -5 }),
    }),
    30,
  );
  assert.equal(
    resolveTimeBound({
      task: task({ time_bound_minutes: 12.5 }),
      project: project({ time_bound_minutes: "60" }),
    }),
    30,
  );
});

test("resolveTimeBound: ignores invalid global, falls back to default", () => {
  assert.equal(
    resolveTimeBound({ task: task(), project: project() }, 0),
    30,
  );
  assert.equal(
    resolveTimeBound({ task: task(), project: project() }, -1),
    30,
  );
});

test("classifyDisposition: exit 0 with unchanged status and prs → stalled", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 0 },
    }),
    "stalled",
  );
});

test("classifyDisposition: exit 0 with status flipped → shipped", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "ready", prs: 0 },
      after: { status: "needs-review", prs: 0 },
    }),
    "shipped",
  );
});

test("classifyDisposition: ready → in-progress, prs unchanged → stalled (entry flip is not shipped)", () => {
  // The live bug from task 064: agent ran `tpm start`, flipped status, then
  // exited without shipping. That's the first step of work, not progress.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "ready", prs: 0 },
      after: { status: "in-progress", prs: 0 },
    }),
    "stalled",
  );
});

test("classifyDisposition: needs-feedback → in-progress, prs unchanged → stalled (feedback-round entry flip)", () => {
  // Feedback dispatch flips status to in-progress on entry; exiting without
  // addressing anything (no commit, no new PR) is the same non-progress case.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "needs-feedback", prs: 1 },
      after: { status: "in-progress", prs: 1 },
    }),
    "stalled",
  );
});

test("classifyDisposition: in-progress → needs-review with PR opened → shipped", () => {
  // Canonical ship: agent ran `tpm pr`, status flipped, prs grew.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "needs-review", prs: 1 },
    }),
    "shipped",
  );
});

test("classifyDisposition: in-progress → done → shipped", () => {
  // `tpm complete` ran (investigation/spike close-out, or direct-push task).
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "done", prs: 0 },
    }),
    "shipped",
  );
});

test("classifyDisposition: in-progress → blocked → shipped (legitimate end-state flip)", () => {
  // Agent escalated via `tpm block`. Surfacing a blocker is a meaningful
  // action even though no code shipped.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "blocked", prs: 0 },
    }),
    "shipped",
  );
});

test("classifyDisposition: ready → in-progress with PR opened in same run → shipped", () => {
  // Agent did the full ready → in-progress → PR cycle in one run. The PR
  // count gain wins over the entry-flip rule.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "ready", prs: 0 },
      after: { status: "in-progress", prs: 1 },
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 0 with prs gained → shipped", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 1 },
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 0 with task gone (archived mid-run) → shipped", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 1 },
      after: null,
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 124 → timeout regardless of state", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "ready", prs: 0 },
      after: { status: "ready", prs: 0 },
    }),
    "timeout",
  );
});

test("classifyDisposition: non-zero non-124 exit → failed", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 1,
      before: { status: "ready", prs: 0 },
      after: { status: "ready", prs: 0 },
    }),
    "failed",
  );
  assert.equal(
    classifyDisposition({
      exitCode: 127,
      before: { status: "ready", prs: 0 },
      after: null,
    }),
    "failed",
  );
});

test("formatDispositionLine: stable schema for stalled run", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/051-foo",
      "stalled",
      0,
      { status: "in-progress", prs: 0 },
      { status: "in-progress", prs: 0 },
    ),
    "disposition tpm/051-foo stalled exit=0 status=in-progress->in-progress prs=0->0",
  );
});

test("formatDispositionLine: shipped run shows after-state diff", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/051-foo",
      "shipped",
      0,
      { status: "ready", prs: 0 },
      { status: "needs-review", prs: 1 },
    ),
    "disposition tpm/051-foo shipped exit=0 status=ready->needs-review prs=0->1",
  );
});

test("formatDispositionLine: archived-mid-run renders after-status as ?", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/051-foo",
      "shipped",
      0,
      { status: "in-progress", prs: 1 },
      null,
    ),
    "disposition tpm/051-foo shipped exit=0 status=in-progress->? prs=1->1",
  );
});

test("formatDispositionLine: timeout carries exit=124", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/051-foo",
      "timeout",
      124,
      { status: "ready", prs: 0 },
      { status: "ready", prs: 0 },
    ),
    "disposition tpm/051-foo timeout exit=124 status=ready->ready prs=0->0",
  );
});

test("noPickLogEntry: empty queue → INFO with 'no eligible tasks'", () => {
  const entry = noPickLogEntry(0);
  assert.equal(entry.level, "INFO");
  assert.match(entry.message, /no eligible tasks/);
});

test("noPickLogEntry: candidates exist but all locked → WARN about contention", () => {
  const entry = noPickLogEntry(3);
  assert.equal(entry.level, "WARN");
  assert.match(entry.message, /repos busy or task-locked/);
});

test("evaluateTerminalState: null task (archived/missing) → 'archived'", () => {
  assert.equal(evaluateTerminalState(null), "archived");
});

test("evaluateTerminalState: status=done → 'done'", () => {
  assert.equal(evaluateTerminalState(task({ status: "done" })), "done");
});

test("evaluateTerminalState: status=dropped → 'dropped'", () => {
  assert.equal(evaluateTerminalState(task({ status: "dropped" })), "dropped");
});

test("evaluateTerminalState: status=in-progress → null (still running)", () => {
  assert.equal(evaluateTerminalState(task({ status: "in-progress" })), null);
});

test("evaluateTerminalState: status=needs-close → null (transient, don't kill)", () => {
  // needs-close is the poller's transient state right before its inline
  // auto-close; SIGTERMing here would race the close-out for no benefit.
  assert.equal(evaluateTerminalState(task({ status: "needs-close" })), null);
});

test("evaluateTerminalState: status=needs-feedback → null (agent should react, not be killed)", () => {
  assert.equal(evaluateTerminalState(task({ status: "needs-feedback" })), null);
});

test("classifyDisposition: terminationReason=early-term → terminal (wins over exit code)", () => {
  // Early-term resolves with exit 0 because the work shipped externally; the
  // termination reason is what tells classify it wasn't a normal completion.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "done", prs: 0 },
      terminationReason: "early-term",
    }),
    "terminal",
  );
});

test("classifyDisposition: terminationReason=early-term with archived after → terminal", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 1 },
      after: null,
      terminationReason: "early-term",
    }),
    "terminal",
  );
});

test("classifyDisposition: terminationReason=timeout still classifies as timeout via exit 124", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 0 },
      terminationReason: "timeout",
    }),
    "timeout",
  );
});

test("formatDispositionLine: terminal disposition renders cleanly", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/059-foo",
      "terminal",
      0,
      { status: "in-progress", prs: 1 },
      { status: "done", prs: 1 },
    ),
    "disposition tpm/059-foo terminal exit=0 status=in-progress->done prs=1->1",
  );
});

test("shouldAutoRevert: ready -> in-progress with no PR opened → true (the 058 strand case)", () => {
  // The live bug: an investigation task picked up at ready, flipped to
  // in-progress via `tpm start`, then the agent exited without shipping.
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "ready", prs: 0 },
      after: { status: "in-progress", prs: 0 },
    }),
    true,
  );
});

test("shouldAutoRevert: in-progress -> in-progress with no PR opened → true", () => {
  // Agent resumed an already-in-progress task and exited without shipping.
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 0 },
    }),
    true,
  );
});

test("shouldAutoRevert: needs-feedback -> in-progress with no PR opened → false", () => {
  // A feedback round legitimately ends here: the agent addressed CI/threads
  // and ran `tpm status <slug> in-progress`. Don't revert that.
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "needs-feedback", prs: 1 },
      after: { status: "in-progress", prs: 1 },
    }),
    false,
  );
});

test("shouldAutoRevert: after status is needs-review (PR opened) → false", () => {
  // `tpm pr` flipped status, so this is the shipped path.
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "ready", prs: 0 },
      after: { status: "needs-review", prs: 1 },
    }),
    false,
  );
});

test("shouldAutoRevert: after status is ready (agent self-reverted) → false", () => {
  // The agent already followed the rule and called `tpm revert`.
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "ready", prs: 0 },
      after: { status: "ready", prs: 0 },
    }),
    false,
  );
});

test("shouldAutoRevert: prs grew → false", () => {
  // Defensive: if a PR was added but status didn't flip (shouldn't happen
  // with `tpm pr` but a direct edit could), still treat it as shipped.
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 1 },
    }),
    false,
  );
});

test("shouldAutoRevert: non-zero exit → false (failed runs aren't auto-handled here)", () => {
  // Crashed/failed runs leave the task at in-progress, but the disposition
  // classifier marks them `failed` and task 065's stranded-reclaim sweeper
  // handles them. This predicate only catches clean exits.
  assert.equal(
    shouldAutoRevert({
      exitCode: 1,
      before: { status: "ready", prs: 0 },
      after: { status: "in-progress", prs: 0 },
    }),
    false,
  );
});

test("shouldAutoRevert: terminationReason=timeout → false (onTimeout already reverts)", () => {
  assert.equal(
    shouldAutoRevert({
      exitCode: 124,
      before: { status: "ready", prs: 0 },
      after: { status: "in-progress", prs: 0 },
      terminationReason: "timeout",
    }),
    false,
  );
});

test("shouldAutoRevert: terminationReason=early-term → false (task went terminal externally)", () => {
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 0 },
      terminationReason: "early-term",
    }),
    false,
  );
});

test("shouldAutoRevert: after=null (task archived mid-run) → false", () => {
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "in-progress", prs: 1 },
      after: null,
    }),
    false,
  );
});

// runWithTimeout integration: spawn a real (short-lived) child and verify the
// terminal-state poll fires SIGTERM ahead of the time bound. We use `sleep`
// because Node's `node -e` adds startup overhead that makes these tests slow.
test("runWithTimeout: SIGTERMs early when isTaskTerminal returns a reason", async () => {
  let callCount = 0;
  const result = await runWithTimeout(
    "sleep",
    ["30"],
    5, // 5 minute time bound — well outside the test window
    100, // 100ms grace
    () => { throw new Error("onTimeout should not fire — task went terminal"); },
    () => {
      callCount++;
      // First poll: still running. Second poll: task went done.
      return callCount >= 2 ? "done" : null;
    },
    50, // poll every 50ms
  );
  assert.equal(result.terminationReason, "early-term");
  assert.equal(result.exitCode, 0);
  assert.ok(callCount >= 2, `expected at least 2 polls, got ${callCount}`);
});

test("runWithTimeout: early-term fires immediately when task already archived", async () => {
  const result = await runWithTimeout(
    "sleep",
    ["30"],
    5,
    100,
    () => { throw new Error("onTimeout should not fire"); },
    () => "archived",
    50,
  );
  assert.equal(result.terminationReason, "early-term");
  assert.equal(result.exitCode, 0);
});

test("runWithTimeout: does not SIGTERM when task stays at needs-close (transient)", async () => {
  // Mimic the poller window: status is needs-close, but evaluateTerminalState
  // returns null for that. The child should exit on its own.
  const result = await runWithTimeout(
    "sleep",
    ["0.3"], // exit on its own after 300ms
    5,
    100,
    () => { throw new Error("onTimeout should not fire"); },
    () => null, // task never goes terminal
    50,
  );
  assert.equal(result.terminationReason, undefined);
  assert.equal(result.exitCode, 0);
});

test("runWithTimeout: captures child stdout to logFile when provided", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-log-"));
  const logFile = resolve(dir, "run.log");
  try {
    const result = await runWithTimeout(
      "sh",
      ["-c", "echo hello-from-child; echo bye-from-child"],
      5,
      100,
      () => { throw new Error("onTimeout should not fire"); },
      () => null,
      50,
      logFile,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminationReason, undefined);
    const captured = readFileSync(logFile, "utf8");
    assert.match(captured, /hello-from-child/);
    assert.match(captured, /bye-from-child/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithTimeout: captures child stderr to the same logFile", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-log-"));
  const logFile = resolve(dir, "run.log");
  try {
    const result = await runWithTimeout(
      "sh",
      ["-c", "echo on-stdout; echo on-stderr 1>&2"],
      5,
      100,
      () => { throw new Error("onTimeout should not fire"); },
      () => null,
      50,
      logFile,
    );
    assert.equal(result.exitCode, 0);
    const captured = readFileSync(logFile, "utf8");
    assert.match(captured, /on-stdout/);
    assert.match(captured, /on-stderr/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithTimeout: creates parent directories for the logFile path", async () => {
  // The orchestrator passes `~/.tpm/runs/<file>` — on a fresh machine that
  // directory may not exist yet. The lazy mkdirSync must handle that.
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-log-"));
  const logFile = resolve(dir, "nested", "deeper", "run.log");
  try {
    const result = await runWithTimeout(
      "sh",
      ["-c", "echo nested-write"],
      5,
      100,
      () => { throw new Error("onTimeout should not fire"); },
      () => null,
      50,
      logFile,
    );
    assert.equal(result.exitCode, 0);
    const captured = readFileSync(logFile, "utf8");
    assert.match(captured, /nested-write/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithTimeout: ignores isTaskTerminal exceptions and keeps running", async () => {
  // Tree read failures shouldn't kill the agent — time bound is the backstop.
  let attempts = 0;
  const result = await runWithTimeout(
    "sleep",
    ["0.3"],
    5,
    100,
    () => { throw new Error("onTimeout should not fire"); },
    () => { attempts++; throw new Error("synthetic tree read failure"); },
    50,
  );
  assert.equal(result.terminationReason, undefined);
  assert.equal(result.exitCode, 0);
  assert.ok(attempts >= 1, "isTaskTerminal should have been called at least once");
});
