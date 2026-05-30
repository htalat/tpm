import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildExecutionPrompt,
  buildFeedbackPrompt,
  checkProjectRepo,
  clampWorkers,
  classifyDisposition,
  evaluateTerminalState,
  fetchFeedbackContexts,
  formatDispositionLine,
  noPickLogEntry,
  ORCHESTRATOR_CLAIM_VERB,
  parsePrUrls,
  planReconcile,
  repoGuardAction,
  resolvePoolShape,
  resolveTimeBound,
  runPool,
  runWithTimeout,
  shouldAutoRevert,
} from "./orchestrate.ts";
import * as mutate from "./mutate.ts";
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

test("classifyDisposition: exit 124 with no shipped flip → timeout", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "ready", prs: 0 },
      after: { status: "ready", prs: 0 },
    }),
    "timeout",
  );
});

test("classifyDisposition: exit 124 with in-progress -> in-progress, no PR → timeout", () => {
  // Agent claimed the task, churned, and ran out the clock without delivering.
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "in-progress", prs: 0 },
      after: { status: "in-progress", prs: 0 },
    }),
    "timeout",
  );
});

test("classifyDisposition: exit 124 with ready -> in-progress entry flip only → timeout", () => {
  // Entry flip is claim-not-progress (per 064). SIGTERM on top of that is a
  // real "agent didn't deliver" run, not a shipped one.
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "ready", prs: 0 },
      after: { status: "in-progress", prs: 0 },
    }),
    "timeout",
  );
});

test("classifyDisposition: exit 124 with ready -> needs-review and prs +1 → shipped (the 057 trace)", () => {
  // The canonical 068 case: agent ran `tpm pr` then lingered past the time
  // bound and got SIGTERM'd. The PR exists; the headline should report that.
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "ready", prs: 0 },
      after: { status: "needs-review", prs: 1 },
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 124 with in-progress -> needs-review and prs +1 → shipped", () => {
  // Same shape as the 057 trace but starting from in-progress (agent resumed
  // an already-claimed task before opening the PR).
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "in-progress", prs: 0 },
      after: { status: "needs-review", prs: 1 },
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 124 with in-progress -> done → shipped (delivery state)", () => {
  // Investigation/spike close-out (`tpm complete`) lands here. The agent
  // closed the task; SIGTERM after that is just cleanup noise.
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "in-progress", prs: 0 },
      after: { status: "done", prs: 0 },
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 124 with in-progress -> blocked → shipped (blocker surfaced)", () => {
  // `tpm block` is a delivery action even though no code shipped — the agent
  // surfaced what's in the way. SIGTERM afterward doesn't undo that.
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "in-progress", prs: 0 },
      after: { status: "blocked", prs: 0 },
    }),
    "shipped",
  );
});

test("classifyDisposition: exit 124 with after=null (archived mid-run) → shipped", () => {
  // Poller closed the task while the agent was running and the time bound hit
  // around the same window. Archived = definitively shipped externally.
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "in-progress", prs: 1 },
      after: null,
    }),
    "shipped",
  );
});

test("classifyDisposition: non-zero non-124 exit → failed regardless of progress", () => {
  // A crashed/externally-killed run can leave half-written state; even if the
  // before/after diff looks like shipping, we don't trust it. exit=124 is the
  // only SIGTERM the orchestrator's runWithTimeout produces — anything else is
  // either a crash (1) or an external kill (137 from OOM/`kill -9`), and both
  // are closer to "failed" than "shipped".
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
  assert.equal(
    classifyDisposition({
      exitCode: 137,
      before: { status: "ready", prs: 0 },
      after: { status: "needs-review", prs: 1 },
    }),
    "failed",
  );
});

test("classifyDisposition: in-progress → in-progress with report attached → shipped (task 080)", () => {
  // `tpm report` flips in-progress -> needs-review under normal flow, so we
  // shouldn't usually see this exact transition. But if the agent attaches
  // a report and the orchestrator's snapshot races a status flip, the
  // empty→set transition is itself the shipping signal.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0, report: false },
      after: { status: "in-progress", prs: 0, report: true },
    }),
    "shipped",
  );
});

test("classifyDisposition: in-progress → needs-review with report attached → shipped (canonical investigation flow)", () => {
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0, report: false },
      after: { status: "needs-review", prs: 0, report: true },
    }),
    "shipped",
  );
});

test("classifyDisposition: ready → in-progress with report attached counts as shipping (overrides entry-flip rule)", () => {
  // Agent did the full ready → start → report cycle in one run but didn't
  // emit the needs-review flip yet — report-set still wins, mirroring the
  // ready→in-progress+prs=+1 case.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "ready", prs: 0, report: false },
      after: { status: "in-progress", prs: 0, report: true },
    }),
    "shipped",
  );
});

test("classifyDisposition: existing report (no transition) on stalled run stays stalled", () => {
  // Round-trip case: report already set, agent picked up needs-feedback,
  // re-attached (no transition because report:empty→set didn't happen, but
  // status flipped via the re-fire path). Without a status change AND no
  // report transition, the run is genuinely stalled.
  assert.equal(
    classifyDisposition({
      exitCode: 0,
      before: { status: "in-progress", prs: 0, report: true },
      after: { status: "in-progress", prs: 0, report: true },
    }),
    "stalled",
  );
});

test("classifyDisposition: exit 124 with report attached → shipped", () => {
  // Same 068 timing pattern as PR shipping: agent attached report then
  // lingered past the time bound. Delivery wins over the SIGTERM.
  assert.equal(
    classifyDisposition({
      exitCode: 124,
      before: { status: "ready", prs: 0, report: false },
      after: { status: "needs-review", prs: 0, report: true },
    }),
    "shipped",
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

test("formatDispositionLine: appends report=empty->set when the report field flipped", () => {
  assert.equal(
    formatDispositionLine(
      "tpm/080-investigation",
      "shipped",
      0,
      { status: "in-progress", prs: 0, report: false },
      { status: "needs-review", prs: 0, report: true },
    ),
    "disposition tpm/080-investigation shipped exit=0 status=in-progress->needs-review prs=0->0 report=empty->set",
  );
});

test("formatDispositionLine: omits report= field when no report has ever been attached (back-compat)", () => {
  // PR-shaped tasks (every pre-080 run) shouldn't grow a useless
  // report=empty->empty suffix in the envelope log.
  assert.equal(
    formatDispositionLine(
      "tpm/045-pr",
      "shipped",
      0,
      { status: "in-progress", prs: 0, report: false },
      { status: "needs-review", prs: 1, report: false },
    ),
    "disposition tpm/045-pr shipped exit=0 status=in-progress->needs-review prs=0->1",
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

test("shouldAutoRevert: report attached this run → false (task 080)", () => {
  // Agent attached a report (empty→set) but the orchestrator's snapshot
  // raced the auto-flip and still sees in-progress. Don't auto-revert: the
  // report-shipped signal means the agent delivered.
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "in-progress", prs: 0, report: false },
      after: { status: "in-progress", prs: 0, report: true },
    }),
    false,
  );
});

test("shouldAutoRevert: report unchanged (no transition this run) → true", () => {
  // Existing report, agent picked up and exited without further progress.
  // No transition means nothing shipped this run.
  assert.equal(
    shouldAutoRevert({
      exitCode: 0,
      before: { status: "in-progress", prs: 0, report: true },
      after: { status: "in-progress", prs: 0, report: true },
    }),
    true,
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

test("buildExecutionPrompt: prompt embeds the briefing inline and is not /tpm <slug>", () => {
  // Per task 077: orchestrator no longer spawns `claude -p "/tpm <slug>"`.
  // The agent gets the briefing inline and the four execution rules, so it
  // skips skill discovery + `tpm context` round-trip entirely. Per task 085
  // a non-interactive preamble precedes the briefing — assert inclusion, not
  // strict startsWith.
  const briefing = "# Task briefing: do the thing\n\nslug: tpm/099-foo";
  const prompt = buildExecutionPrompt(briefing);
  assert.ok(prompt.includes(briefing), "prompt should include the briefing");
  assert.doesNotMatch(prompt, /^\/tpm /, "prompt should not be the legacy /tpm <slug> form");
});

test("buildExecutionPrompt: leads with the non-interactive 'never ask, always act' rule (task 085)", () => {
  // Live failure 2026-05-17: in non-interactive mode the agent hit a fork,
  // articulated options, and asked the user which to take. There is no user.
  // Placing this rule at the top of the prompt makes it the first thing the
  // agent reads.
  const prompt = buildExecutionPrompt("BRIEFING");
  assert.match(prompt, /non-interactive mode/);
  assert.match(prompt, /always act/);
  assert.match(prompt, /take the smaller \/ safer path \(`tpm block`, `tpm revert`, log a Log line\) and exit/);
  // The rule must precede the briefing — that's the placement contract.
  const ruleIdx = prompt.indexOf("non-interactive mode");
  const briefingIdx = prompt.indexOf("BRIEFING");
  assert.ok(ruleIdx >= 0 && briefingIdx > ruleIdx, "rule should appear before the briefing");
});

test("buildExecutionPrompt: includes all execution rules verbatim", () => {
  // These rules replace the SKILL.md "Start a task" section for orchestrator
  // runs; any drift between this prompt and the skill's guidance needs to be
  // intentional (cross-ref in 077). Pin each line so a typo trips the test.
  const prompt = buildExecutionPrompt("BRIEFING");
  assert.match(prompt, /You are executing this task\. Rules:/);
  assert.match(prompt, /- If `prs:` is non-empty and any linked PR is OPEN, fetch its comments and reviews via the host CLI \(dispatch on `Host:` in the briefing\) before any other discovery\. Unaddressed comments are almost certainly why you're seeing this task — address them first\./);
  assert.match(prompt, /- Follow the Plan above\./);
  assert.match(prompt, /- If type=pr: after opening a PR, run `tpm pr <slug> <url>` \(CLI auto-flips to needs-review\)\. Stop\./);
  assert.match(prompt, /- If type=investigation: your deliverable is a \*\*report\*\*, not a PR\. Run `tpm report <slug>` to fold the task into a folder and scaffold `<project>\/tasks\/<slug>\/report\.md` from the template\. Write findings into that file\. When done, re-run `tpm report <slug>` — the CLI auto-flips to needs-review\. Don't run `tpm pr`\./);
  assert.match(prompt, /- Can't proceed\? `tpm revert <slug> "<reason>"` \(back to ready\) or `tpm block <slug> "<reason>"` \(human queue\)\. Never exit at in-progress\./);
  assert.match(prompt, /- Unanticipated decision\? Ship the smaller \/ more local change, file follow-ups, don't halt\./);
});

test("buildExecutionPrompt: PR-comments-first rule appears before the Plan-execution rule (task 088)", () => {
  // Live failure 2026-05-17 on task 085: agent picked up `ready` with open PR,
  // saw the commit was shipped, never fetched the PR's comments, flipped to
  // needs-review without addressing the user's feedback. The rule must
  // precede "Follow the Plan above." so the agent reads the PR's comment
  // state before any other discovery. Phrased host-agnostically (dispatch on
  // `Host:` in the briefing) — the agent picks the right CLI for github vs ado.
  const prompt = buildExecutionPrompt("BRIEFING");
  const commentsRuleIdx = prompt.indexOf("fetch its comments and reviews via the host CLI");
  const followPlanIdx = prompt.indexOf("Follow the Plan above");
  assert.ok(commentsRuleIdx >= 0, "PR-comments-first rule should be present");
  assert.ok(followPlanIdx > commentsRuleIdx, "PR-comments-first rule should precede 'Follow the Plan above'");
});

test("buildFeedbackPrompt: embeds briefing + PR context + scoped feedback rules (task 089)", () => {
  // The structural fix for the 085 / 088 incident family: with PR JSON in the
  // prompt, the agent can't ignore comments. We assert briefing precedence,
  // the context block, and the feedback rules — same shape contract as
  // buildExecutionPrompt's test.
  const briefing = "# Task briefing: do the thing\n\nslug: tpm/099-foo";
  const prContext = '## PR https://github.com/x/y/pull/42\n\n```json\n{"state":"OPEN"}\n```';
  const prompt = buildFeedbackPrompt(briefing, prContext);
  assert.ok(prompt.includes(briefing), "prompt should include the briefing");
  assert.ok(prompt.includes(prContext), "prompt should include the PR context block");
  assert.match(prompt, /non-interactive mode/);
  assert.match(prompt, /You are addressing feedback on the PR\(s\) above\. Rules:/);
  // Pin the don't-refetch rule: agent should read the inline JSON instead of
  // re-running `gh pr view` — that's what the 089 patch is for.
  assert.match(prompt, /don't re-fetch with `gh pr view` \/ `gh api graphql` \/ `az repos pr show`/);
  assert.match(prompt, /addressed feedback — <one-line summary>/);
  assert.match(prompt, /tpm status <slug> in-progress/);
});

test("buildFeedbackPrompt: rule precedence — non-interactive preamble before briefing before PR context before rules", () => {
  // Placement contract: the agent reads the preamble first (so non-interactive
  // wins over any "ask the user" reflex), then the briefing, then the PR JSON,
  // then the rules that operate on both.
  const prompt = buildFeedbackPrompt("BRIEFING-MARKER", "PR-CONTEXT-MARKER");
  const preambleIdx = prompt.indexOf("non-interactive mode");
  const briefingIdx = prompt.indexOf("BRIEFING-MARKER");
  const prCtxIdx = prompt.indexOf("PR-CONTEXT-MARKER");
  const rulesIdx = prompt.indexOf("You are addressing feedback");
  assert.ok(preambleIdx >= 0 && briefingIdx > preambleIdx, "preamble before briefing");
  assert.ok(prCtxIdx > briefingIdx, "PR context after briefing");
  assert.ok(rulesIdx > prCtxIdx, "feedback rules after PR context");
});

test("parsePrUrls: returns string URLs, filters non-strings and empties", () => {
  // Defensive against a hand-edited task file where `prs:` has a stray null,
  // a number, or an empty string — those shouldn't blow up the fetch loop.
  assert.deepEqual(
    parsePrUrls(task({ prs: ["https://x/1", "", null, 42, "https://y/2"] as unknown[] })),
    ["https://x/1", "https://y/2"],
  );
});

test("parsePrUrls: missing prs frontmatter → empty list", () => {
  assert.deepEqual(parsePrUrls(task()), []);
});

test("parsePrUrls: prs is not an array → empty list", () => {
  // YAML could parse a single-string `prs: https://x` as a scalar; we should
  // still treat that as empty (no array) rather than crash.
  assert.deepEqual(parsePrUrls(task({ prs: "https://x/1" })), []);
});

test("fetchFeedbackContexts: empty URL list → empty string (caller should skip feedback mode)", async () => {
  const out = await fetchFeedbackContexts([]);
  assert.equal(out, "");
});

test("fetchFeedbackContexts: unknown-host URL → stub block, no crash", async () => {
  // Defensive: a malformed `prs:` entry shouldn't kill the run. The agent sees
  // a `_no host adapter matched_` stub and can still operate on the rest.
  const out = await fetchFeedbackContexts(["not-a-pr-url"]);
  assert.match(out, /## PR not-a-pr-url/);
  assert.match(out, /_no host adapter matched this URL_/);
});

test("fetchFeedbackContexts: multi-PR concatenates each block separated by a blank line", async () => {
  // Multi-PR tasks (uncommon but possible — e.g. a CLI + docs split) should
  // get each PR's block in the prompt, not just the first.
  const out = await fetchFeedbackContexts(["not-a-pr-url-a", "not-a-pr-url-b"]);
  const aIdx = out.indexOf("not-a-pr-url-a");
  const bIdx = out.indexOf("not-a-pr-url-b");
  assert.ok(aIdx >= 0 && bIdx > aIdx, "both PR blocks should appear in order");
  // Separator: two newlines between blocks.
  assert.match(out, /not-a-pr-url-a[^]*?\n\n## PR not-a-pr-url-b/);
});

test("checkProjectRepo: repo.local set and directory exists → ok with cwd", () => {
  const result = checkProjectRepo(
    "tpm/084-foo",
    { remote: "https://example/repo.git", local: "/path/to/repo" },
    (p) => p === "/path/to/repo",
  );
  assert.deepEqual(result, { ok: true, cwd: "/path/to/repo" });
});

test("checkProjectRepo: repo.local unset → bail with 'is unset' reason", () => {
  // Project frontmatter never set repo.local. We can't sandbox the spawn to
  // anything sensible — operator needs to add it to the project.md.
  const result = checkProjectRepo(
    "tpm/084-foo",
    { remote: null, local: null },
    () => true,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /tpm\/084-foo/);
  assert.match(result.reason, /repo\.local is unset/);
});

test("checkProjectRepo: repo.local set but path missing on disk → bail with 'not on disk' reason", () => {
  // Project declares a clone path that hasn't been created — clone is missing.
  const result = checkProjectRepo(
    "tpm/084-foo",
    { remote: null, local: "/path/never/cloned" },
    () => false,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /\/path\/never\/cloned/);
  assert.match(result.reason, /not on disk/);
  // The reason doubles as the block reason on the task body, so it names the
  // copy-pasteable command to re-enter the autonomous queue after cloning.
  assert.match(result.reason, /tpm ready tpm\/084-foo/);
});

test("repoGuardAction: usable repo → spawn with the repo cwd", () => {
  assert.deepEqual(
    repoGuardAction("ready", { ok: true, cwd: "/path/to/repo" }),
    { action: "spawn", cwd: "/path/to/repo" },
  );
});

test("repoGuardAction: missing repo on a ready task → block with a path-bearing reason", () => {
  // First encounter: flip to blocked so the task lands in `tpm inbox` and stops
  // re-failing every tick. The block reason carries the missing path.
  const check = checkProjectRepo("tpm/002-foo", { remote: null, local: "/never/cloned" }, () => false);
  const action = repoGuardAction("ready", check);
  assert.equal(action.action, "block");
  if (action.action !== "block") return;
  assert.match(action.reason, /\/never\/cloned/);
  assert.match(action.reason, /not on disk/);
});

test("repoGuardAction: unset repo.local on a ready task → block (project config needs fixing)", () => {
  const check = checkProjectRepo("tpm/002-foo", { remote: null, local: null }, () => true);
  const action = repoGuardAction("ready", check);
  assert.equal(action.action, "block");
  if (action.action !== "block") return;
  assert.match(action.reason, /repo\.local is unset/);
});

test("repoGuardAction: missing repo on an already-blocked task → skip (idempotent, no re-block)", () => {
  // A pre-claimed re-encounter (queue.ts already excludes blocked from normal
  // selection) finds the task blocked from a prior tick. Don't re-block or
  // re-log — the skip branch is the idempotency backstop.
  const check = checkProjectRepo("tpm/002-foo", { remote: null, local: "/never/cloned" }, () => false);
  assert.deepEqual(repoGuardAction("blocked", check), { action: "skip" });
});

test("buildExecutionPrompt: includes the refresh-main-before-branching rule (task 118)", () => {
  // PR #120 failure mode: agent inherits a stale checkout, branches off stale
  // main, conflicts at merge time. The rule lives in the agent prompt so both
  // orchestrator and manual `/tpm <slug>` runs land on a fresh main.
  const prompt = buildExecutionPrompt("BRIEFING");
  assert.match(prompt, /Before cutting your feature branch, refresh `main`/);
  assert.match(prompt, /git checkout main && git pull --ff-only/);
  assert.match(prompt, /tpm block <slug> "stale checkout — needs human reconcile"/);
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
  // The orchestrator passes `<task>/runs/<file>` — for a fresh task the
  // runs/ subfolder may not exist yet. The lazy mkdirSync must handle that.
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

test("runWithTimeout: passes cwd to spawn so the child runs in the project repo (task 084)", async () => {
  // The root cause from 084: without cwd, claude inherits the orchestrator's
  // install dir as the sandbox root and gets blocked on every file op in the
  // project repo. The plumbing here is what fixes it.
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), "tpm-orch-cwd-")));
  const logFile = resolve(dir, "run.log");
  try {
    const result = await runWithTimeout(
      "sh",
      ["-c", "pwd"],
      5,
      100,
      () => { throw new Error("onTimeout should not fire"); },
      () => null,
      50,
      logFile,
      dir,
    );
    assert.equal(result.exitCode, 0);
    const captured = readFileSync(logFile, "utf8");
    assert.ok(
      captured.includes(dir),
      `expected child's pwd to be ${dir}, got log: ${captured}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithTimeout: undefined cwd preserves pre-084 behavior (inherits parent cwd)", async () => {
  // Existing callers (and the no-logFile path) shouldn't change behavior. With
  // cwd omitted, spawn inherits process.cwd() — matches Node's default.
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-cwd-default-"));
  const logFile = resolve(dir, "run.log");
  try {
    const result = await runWithTimeout(
      "sh",
      ["-c", "pwd"],
      5,
      100,
      () => { throw new Error("onTimeout should not fire"); },
      () => null,
      50,
      logFile,
      // no cwd
    );
    assert.equal(result.exitCode, 0);
    const captured = readFileSync(logFile, "utf8").trim();
    assert.equal(captured, realpathSync(process.cwd()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithTimeout: writes the logHeader as the first line of the log file (task 092)", async () => {
  // The orchestrator writes `# tpm-run agent=<name> outputFormat=<fmt>` so
  // the per-run log viewer can dispatch on the right interpreter. The header
  // must precede any captured child output — assert position, not just
  // presence.
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-header-"));
  const logFile = resolve(dir, "run.log");
  try {
    const result = await runWithTimeout(
      "sh",
      ["-c", "echo child-line-one; echo child-line-two"],
      5,
      100,
      () => { throw new Error("onTimeout should not fire"); },
      () => null,
      50,
      logFile,
      undefined,
      "# tpm-run agent=copilot outputFormat=copilot-json\n",
    );
    assert.equal(result.exitCode, 0);
    const captured = readFileSync(logFile, "utf8");
    const lines = captured.split("\n");
    assert.equal(lines[0], "# tpm-run agent=copilot outputFormat=copilot-json");
    assert.match(captured, /child-line-one/);
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

// ---- eager claim + spawn-failure rollback (task 108) ----------------------
//
// runOrchestrate itself reads ~/.tpm/config.json (via findRoot) and is hard
// to bootstrap inside a unit test. These tests exercise the orchestrator's
// claim/rollback *contract* on real task files by calling the same mutate
// verbs runOrchestrate calls — same on-disk effects, same idempotency rules.

function writeClaimableTask(dir: string, slug: string, status: string): Task {
  const path = resolve(dir, `${slug}.md`);
  writeFileSync(
    path,
    `---
title: ${slug}
slug: ${slug}
project: alpha
status: ${status}
type: pr
created: 2026-01-01 00:00 PDT
closed:
prs: []
tags: []
---

# ${slug}

## Context
ctx

## Plan
1. do thing

## Log
- 2026-01-01 00:00 PDT: created

## Outcome
<!-- Filled when closed -->
`,
  );
  // Minimal in-memory Task shape — mutate.* re-reads `path` on every call.
  return {
    slug,
    path,
    archived: false,
    data: { slug, status, prs: [] },
    body: "",
  };
}

test("ORCHESTRATOR_CLAIM_VERB: pins the exact verb the orchestrator writes (audit-trail contract)", () => {
  // The verb is the one durable hook the audit trail relies on to tell
  // orchestrator-claim from agent self-start. Pinning it here means a typo
  // or drift trips the test instead of silently breaking the differentiation.
  assert.equal(ORCHESTRATOR_CLAIM_VERB, "claimed by orchestrator (spawning agent)");
});

test("eager claim: ready -> in-progress writes the orchestrator verb before any spawn (a)", () => {
  // Plan step 1: the orchestrator calls mutate.start with the claim verb
  // *before* the agent process is spawned. Disk truth must match the claim
  // by the time runWithTimeout starts the child — that's the whole point of
  // task 108 (so `tpm serve` doesn't show `ready` during the agent's ~30s
  // boot window).
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-eager-"));
  try {
    const task = writeClaimableTask(dir, "001-a", "ready");
    const r = mutate.start(task, ORCHESTRATOR_CLAIM_VERB);
    assert.match(r.message, /-> in-progress/);
    const text = readFileSync(task.path, "utf8");
    assert.match(text, /status: in-progress/);
    assert.match(text, /: claimed by orchestrator \(spawning agent\)$/m);
    // The agent's self-claim verb must not leak through — that's how the
    // audit trail distinguishes the two paths.
    assert.doesNotMatch(text, /: started$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eager claim: needs-feedback -> in-progress also gets the claim verb (feedback dispatch path)", () => {
  // The orchestrator pre-claims the same way for feedback-mode dispatches.
  // mutate.start refuses only done/dropped, so needs-feedback is accepted.
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-eager-feedback-"));
  try {
    const task = writeClaimableTask(dir, "001-a", "needs-feedback");
    mutate.start(task, ORCHESTRATOR_CLAIM_VERB);
    const text = readFileSync(task.path, "utf8");
    assert.match(text, /status: in-progress/);
    assert.match(text, /: claimed by orchestrator \(spawning agent\)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eager claim: re-flipping an already-in-progress task is a no-op (c — double-claim race)", () => {
  // Stranded-reclaim path: queue.ts admits tasks already at in-progress when
  // their lock has been released (e.g. agent crashed mid-run). The eager
  // flip must not append a duplicate Log line — the audit trail should
  // reflect that no new claim happened.
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-eager-idem-"));
  try {
    const task = writeClaimableTask(dir, "001-a", "in-progress");
    const before = readFileSync(task.path, "utf8");
    const r = mutate.start(task, ORCHESTRATOR_CLAIM_VERB);
    assert.match(r.message, /already in-progress/);
    assert.equal(readFileSync(task.path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn-failure rollback: reverts in-progress back to the pre-claim status with a claim-failed Log line (b)", () => {
  // Plan step 3: when the agent binary can't be spawned (exit 127), the
  // orchestrator rolls the eager flip back. The Log line must name the
  // failure cause so the audit trail explains why an in-progress -> ready
  // hop happened with no agent activity between.
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-rollback-"));
  try {
    const task = writeClaimableTask(dir, "001-a", "ready");
    // Eager flip first (mirrors runOrchestrate sequencing).
    mutate.start(task, ORCHESTRATOR_CLAIM_VERB);
    assert.match(readFileSync(task.path, "utf8"), /status: in-progress/);
    // Spawn failed — roll back.
    mutate.setStatus(
      task,
      "ready",
      "claim failed: agent spawn failed (exit 127, bin=/nope/claude); reverted to ready",
    );
    const text = readFileSync(task.path, "utf8");
    assert.match(text, /status: ready/);
    assert.match(text, /: claimed by orchestrator \(spawning agent\)$/m);
    assert.match(text, /: claim failed: agent spawn failed \(exit 127, bin=\/nope\/claude\); reverted to ready$/m);
    // Both Log entries should be present and ordered (claim before rollback).
    const claimIdx = text.indexOf("claimed by orchestrator");
    const rollbackIdx = text.indexOf("claim failed:");
    assert.ok(claimIdx >= 0 && rollbackIdx > claimIdx, "rollback line should follow the claim line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn-failure rollback: needs-feedback round bounces back to needs-feedback (not ready)", () => {
  // Feedback-mode dispatches must roll back to the original needs-feedback
  // status, not to ready — otherwise the next tick would lose the "addressing
  // PR feedback" signal and re-shape the task as a fresh ready entry.
  const dir = mkdtempSync(resolve(tmpdir(), "tpm-orch-rollback-feedback-"));
  try {
    const task = writeClaimableTask(dir, "001-a", "needs-feedback");
    mutate.start(task, ORCHESTRATOR_CLAIM_VERB);
    mutate.setStatus(
      task,
      "needs-feedback",
      "claim failed: agent spawn failed (exit 127, bin=/nope/claude); reverted to needs-feedback",
    );
    const text = readFileSync(task.path, "utf8");
    assert.match(text, /status: needs-feedback/);
    assert.match(text, /: claim failed: agent spawn failed .* reverted to needs-feedback$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- worker pool shape (task 111) ----------------------------------------

test("resolvePoolShape: defaults to 1 worker when --workers is omitted", () => {
  assert.deepEqual(resolvePoolShape({}), { workers: 1 });
});

test("resolvePoolShape: accepts a positive integer", () => {
  assert.deepEqual(resolvePoolShape({ workers: 4 }), { workers: 4 });
});

test("resolvePoolShape: rejects zero / negative / non-integer worker counts", () => {
  assert.throws(() => resolvePoolShape({ workers: 0 }), /positive integer/);
  assert.throws(() => resolvePoolShape({ workers: -1 }), /positive integer/);
  assert.throws(() => resolvePoolShape({ workers: 2.5 }), /positive integer/);
});

test("resolvePoolShape: accepts a --cli list when its length matches --workers", () => {
  assert.deepEqual(
    resolvePoolShape({ workers: 2, cliPerWorker: ["claude", "copilot"] }),
    { workers: 2 },
  );
});

test("resolvePoolShape: rejects a --cli list whose length differs from --workers", () => {
  // The whole point of per-worker CLI is to pin which agent each slot runs;
  // a length mismatch is almost always a typo and silently dropping/truncating
  // would dispatch the wrong CLI for the unnamed slots.
  assert.throws(
    () => resolvePoolShape({ workers: 2, cliPerWorker: ["claude"] }),
    /--cli has 1 entries but --workers is 2/,
  );
  assert.throws(
    () => resolvePoolShape({ workers: 1, cliPerWorker: ["claude", "copilot"] }),
    /--cli has 2 entries but --workers is 1/,
  );
});

test("resolvePoolShape: --cli alone (no --workers) only validates against the default of 1", () => {
  // If you pass --cli without --workers, you implicitly opted into a one-worker
  // pool — any list longer than that is a mismatch the operator should fix.
  assert.deepEqual(resolvePoolShape({ cliPerWorker: ["claude"] }), { workers: 1 });
  assert.throws(
    () => resolvePoolShape({ cliPerWorker: ["claude", "copilot"] }),
    /--cli has 2 entries but --workers is 1/,
  );
});

// The pool's no-double-dispatch guarantee rides on the per-task lock (atomic
// O_CREAT|O_EXCL on `~/.tpm/locks/<slug>.lock`) — exactly the contention model
// that `tpm next --claim` already deduplicates against. The full
// runOrchestrate pool spawns real child processes which is awkward to bring up
// in a unit test; this test exercises the same selection+lock contract two
// workers would race on, using the same queue+lock primitives runWorkerIteration
// calls.
test("worker pool: two concurrent workers pick distinct tasks via lock contention", async () => {
  const { selectCandidates } = await import("./queue.ts");
  const { acquireTask, releaseTask } = await import("./lock.ts");
  const root = mkdtempSync(resolve(tmpdir(), "tpm-orch-pool-"));
  try {
    // Two ready, autonomous tasks under one project. selectCandidates reads
    // the in-memory Project[] only — no disk I/O for the tasks themselves —
    // and acquireTask creates `<root>/.tpm/locks/` lazily.
    const projects = [{
      slug: "alpha",
      path: resolve(root, "alpha", "project.md"),
      dir: resolve(root, "alpha"),
      data: { slug: "alpha", status: "active" },
      body: "",
      tasks: [
        {
          slug: "001-a",
          path: resolve(root, "alpha", "tasks", "001-a.md"),
          archived: false,
          data: { slug: "001-a", status: "ready", allow_orchestrator: true, created: "2026-01-01 00:00 PDT" },
          body: "",
        },
        {
          slug: "002-b",
          path: resolve(root, "alpha", "tasks", "002-b.md"),
          archived: false,
          data: { slug: "002-b", status: "ready", allow_orchestrator: true, created: "2026-01-01 00:01 PDT" },
          body: "",
        },
      ],
    }];
    const candidates = selectCandidates(projects as unknown as Parameters<typeof selectCandidates>[0], { autonomous: true });
    assert.equal(candidates.length, 2);

    // Simulate two workers picking in parallel: each grabs the first claimable
    // candidate. The atomic `wx` open guarantees one acquire per slug.
    const claimed: Array<{ workerId: string; slug: string }> = [];
    function walkAndClaim(workerId: string): string | null {
      for (const c of candidates) {
        const slug = `alpha/${c.task.slug}`;
        const r = acquireTask(root, slug, workerId);
        if (r.acquired) return slug;
      }
      return null;
    }
    const a = walkAndClaim("worker-1");
    const b = walkAndClaim("worker-2");
    if (a) claimed.push({ workerId: "worker-1", slug: a });
    if (b) claimed.push({ workerId: "worker-2", slug: b });

    // Both workers should have claimed; the slugs should be distinct.
    assert.equal(claimed.length, 2, `expected two claims, got ${claimed.length}`);
    assert.notEqual(claimed[0].slug, claimed[1].slug);

    // Cleanup: both workers can release the lock they hold.
    for (const c of claimed) {
      const r = releaseTask(root, c.slug, c.workerId);
      assert.equal(r.released, true, `worker ${c.workerId} should release its own lock`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker pool: a third worker finds nothing claimable once two locks are held", async () => {
  // The pool can't dispatch the same task twice — once a worker holds a per-
  // task lock, sibling workers walking the same candidate list see EEXIST and
  // fall through. With only two tasks and two locks held, the third worker's
  // pick must come back empty.
  const { selectCandidates } = await import("./queue.ts");
  const { acquireTask } = await import("./lock.ts");
  const root = mkdtempSync(resolve(tmpdir(), "tpm-orch-pool-third-"));
  try {
    const projects = [{
      slug: "alpha",
      path: resolve(root, "alpha", "project.md"),
      dir: resolve(root, "alpha"),
      data: { slug: "alpha", status: "active" },
      body: "",
      tasks: [
        {
          slug: "001-a",
          path: resolve(root, "alpha", "tasks", "001-a.md"),
          archived: false,
          data: { slug: "001-a", status: "ready", allow_orchestrator: true, created: "2026-01-01 00:00 PDT" },
          body: "",
        },
        {
          slug: "002-b",
          path: resolve(root, "alpha", "tasks", "002-b.md"),
          archived: false,
          data: { slug: "002-b", status: "ready", allow_orchestrator: true, created: "2026-01-01 00:01 PDT" },
          body: "",
        },
      ],
    }];
    const candidates = selectCandidates(projects as unknown as Parameters<typeof selectCandidates>[0], { autonomous: true });

    assert.equal(acquireTask(root, "alpha/001-a", "worker-1").acquired, true);
    assert.equal(acquireTask(root, "alpha/002-b", "worker-2").acquired, true);
    // The third worker walks the same candidate list and finds every slug
    // already locked — exactly the "all eligible tasks claimable but repos
    // busy or task-locked" case noPickLogEntry reports.
    let thirdClaim: string | null = null;
    for (const c of candidates) {
      const slug = `alpha/${c.task.slug}`;
      if (acquireTask(root, slug, "worker-3").acquired) {
        thirdClaim = slug;
        break;
      }
    }
    assert.equal(thirdClaim, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- hot-reload workers (task 113) -----------------------------------------

test("clampWorkers: undefined/null fall through to 1 with no warning", () => {
  assert.deepEqual(clampWorkers(undefined), { value: 1, warning: null });
  assert.deepEqual(clampWorkers(null), { value: 1, warning: null });
});

test("clampWorkers: accepts non-negative integers as-is", () => {
  // 0 is the documented "park the pool" value — not clamped.
  assert.deepEqual(clampWorkers(0), { value: 0, warning: null });
  assert.deepEqual(clampWorkers(1), { value: 1, warning: null });
  assert.deepEqual(clampWorkers(7), { value: 7, warning: null });
});

test("clampWorkers: clamps negatives, non-integers, and bad types to 1 with a warning", () => {
  for (const bad of [-1, -10, 1.5, NaN, Infinity, -Infinity, "3", true, [], {}]) {
    const r = clampWorkers(bad);
    assert.equal(r.value, 1, `clampWorkers(${JSON.stringify(bad)}) should clamp to 1`);
    assert.ok(r.warning, `clampWorkers(${JSON.stringify(bad)}) should warn`);
    assert.match(r.warning!, /workers must be a non-negative integer/);
  }
});

test("planReconcile: from empty, spawns 1..desired in order", () => {
  assert.deepEqual(planReconcile([], 0), { spawn: [], drain: [] });
  assert.deepEqual(planReconcile([], 1), { spawn: [1], drain: [] });
  assert.deepEqual(planReconcile([], 3), { spawn: [1, 2, 3], drain: [] });
});

test("planReconcile: scale-up adds the next free ids without disturbing existing workers", () => {
  // 1->3: worker-1 stays; spawn 2 and 3.
  assert.deepEqual(planReconcile([1], 3), { spawn: [2, 3], drain: [] });
  // 2->5: spawn 3,4,5 — no churn on 1 or 2.
  assert.deepEqual(planReconcile([1, 2], 5), { spawn: [3, 4, 5], drain: [] });
});

test("planReconcile: scale-down drains the highest ids first", () => {
  // The plan is documented as "worker-1 survives a 3->2 scale".
  assert.deepEqual(planReconcile([1, 2, 3], 2), { spawn: [], drain: [3] });
  assert.deepEqual(planReconcile([1, 2, 3, 4], 1), { spawn: [], drain: [4, 3, 2] });
});

test("planReconcile: workers: 0 drains every live worker", () => {
  assert.deepEqual(planReconcile([1, 2, 3], 0), { spawn: [], drain: [3, 2, 1] });
});

test("planReconcile: gap in live ids refills the missing slot on a scale-up", () => {
  // Worker-2 drained out (e.g. spawn failed mid-run); the next reconcile
  // sees ids {1,3} and a desired of 3 should refill slot 2.
  assert.deepEqual(planReconcile([1, 3], 3), { spawn: [2], drain: [] });
});

test("planReconcile: steady state is a no-op", () => {
  assert.deepEqual(planReconcile([1, 2, 3], 3), { spawn: [], drain: [] });
});

// Pool integration: drive runPool with fake spawnWorker / readDesired / sleep
// so we can verify the supervisor's spawn/drain decisions without spinning up
// real child processes. The supervisor's contract is that the worker's promise
// resolves once shouldDrain() (or its own deadline check) tells it to exit;
// our fake mirrors that by resolving as soon as shouldDrain() is true. Each
// test installs its own Date.now() so the supervisor's deadline check, the
// fake clock, and the orchestrated `sleep` callback all agree.
interface FakeWorker {
  id: number;
  shouldDrain: () => boolean;
  resolve: () => void;
}

function makeFakePool() {
  const spawned: number[] = [];
  const drainedAtExit: number[] = [];
  const active = new Map<number, FakeWorker>();
  return {
    spawned,
    drainedAtExit,
    active,
    spawnWorker(id: number, shouldDrain: () => boolean): Promise<void> {
      spawned.push(id);
      return new Promise<void>((resolve) => {
        active.set(id, {
          id,
          shouldDrain,
          resolve: () => {
            if (shouldDrain()) drainedAtExit.push(id);
            active.delete(id);
            resolve();
          },
        });
      });
    },
    // Resolve any worker whose drain flag has flipped (mirrors a real worker
    // observing shouldDrain() between iterations).
    flushDrained(): number[] {
      const out: number[] = [];
      for (const [id, w] of active) {
        if (w.shouldDrain()) {
          out.push(id);
          w.resolve();
        }
      }
      return out;
    },
    // Resolve every still-active worker — simulates the deadline propagating
    // to each worker loop (the real loop's `while (Date.now() < deadlineMs)`
    // exits too). Used at the end of a test to let Promise.allSettled return.
    resolveAll(): void {
      for (const w of [...active.values()]) w.resolve();
    },
  };
}

test("runPool: initial converge spawns workers up to the desired count", async () => {
  const fake = makeFakePool();
  const logs: Array<[string, string]> = [];
  let now = 1000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const deadlineMs = now + 60_000;
    let tick = 0;
    await runPool({
      initialDesired: 3,
      deadlineMs,
      reconcileIntervalMs: 10,
      readDesired: () => 3,
      spawnWorker: (id, shouldDrain) => fake.spawnWorker(id, shouldDrain),
      log: (level, msg) => logs.push([level, msg]),
      sleep: async () => {
        tick++;
        // Initial reconcile fires before the first sleep. On the first sleep
        // tick, simulate the deadline arriving: resolve every worker (their
        // own loop would do this on `Date.now() < deadlineMs` going false)
        // and push the clock past the deadline so runPool exits.
        if (tick === 1) {
          fake.resolveAll();
          now = deadlineMs + 1;
        }
      },
    });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(fake.spawned, [1, 2, 3], "initial reconcile should spawn workers 1..3");
  assert.ok(
    logs.some(([l, m]) => l === "INFO" && /workers: 0 -> 3.*spawning worker-1, worker-2, worker-3/.test(m)),
    `expected initial-spawn log, got: ${logs.map(([, m]) => m).join(" | ")}`,
  );
});

test("runPool: scale-down marks the highest worker ids for drain — worker-1 survives", async () => {
  const fake = makeFakePool();
  const logs: Array<[string, string]> = [];
  let desired = 3;
  let tick = 0;
  let now = 1000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const deadlineMs = now + 60_000;
    await runPool({
      initialDesired: 3,
      deadlineMs,
      reconcileIntervalMs: 10,
      readDesired: () => desired,
      spawnWorker: (id, shouldDrain) => fake.spawnWorker(id, shouldDrain),
      log: (level, msg) => logs.push([level, msg]),
      sleep: async () => {
        tick++;
        if (tick === 1) {
          // Initial spawn done. Scale down 3 -> 1 before the next reconcile.
          desired = 1;
        } else if (tick === 2) {
          // After the reconcile flipped drain on workers 2 and 3, let them
          // observe the flag and resolve (mirrors a real worker checking
          // shouldDrain() at the top of its next iteration).
          fake.flushDrained();
          // Then propagate the deadline to worker-1 so the supervisor exits.
          fake.resolveAll();
          now = deadlineMs + 1;
        }
      },
    });
  } finally {
    Date.now = realNow;
  }

  assert.deepEqual(fake.spawned, [1, 2, 3]);
  // Workers 2 and 3 exited because shouldDrain() was true — the documented
  // "scale-down picks the highest-id workers first" rule. Worker-1 exited
  // because the deadline propagated (shouldDrain() false), so it isn't in
  // the drained set.
  assert.deepEqual(fake.drainedAtExit.sort((a, b) => a - b), [2, 3]);
  assert.ok(
    logs.some(([l, m]) => l === "INFO" && /workers: 3 -> 1.*draining worker-3, worker-2/.test(m)),
    `expected a 3->1 drain log, got: ${logs.map(([, m]) => m).join(" | ")}`,
  );
});

test("runPool: workers: 0 parks the pool — no spawns, supervisor keeps ticking", async () => {
  const fake = makeFakePool();
  const logs: Array<[string, string]> = [];
  let now = 1000;
  let tick = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const deadlineMs = now + 60_000;
    await runPool({
      initialDesired: 0,
      deadlineMs,
      reconcileIntervalMs: 10,
      readDesired: () => 0,
      spawnWorker: (id, shouldDrain) => fake.spawnWorker(id, shouldDrain),
      log: (level, msg) => logs.push([level, msg]),
      sleep: async () => {
        tick++;
        // No workers exist; just advance through a couple of ticks and exit.
        if (tick >= 2) now = deadlineMs + 1;
      },
    });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(fake.spawned, [], "no workers should spawn when desired = 0");
  // Supervisor still tick'd a couple of times (proving it doesn't exit just
  // because the pool is empty — a later `tpm config set workers N` would
  // flip it on without restart).
  assert.ok(tick >= 2, "supervisor should keep ticking with an empty pool");
});

test("runPool: a bad config value (clamped to 1) reconciles to a single worker", async () => {
  // Verifies the end-to-end behavior of clampWorkers + planReconcile via
  // runPool: when readDesired returns the clamped value 1 (callers are
  // expected to apply clampWorkers before passing it through), the pool
  // converges to one worker regardless of the raw bad input.
  const fake = makeFakePool();
  let now = 1000;
  let tick = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const deadlineMs = now + 60_000;
    await runPool({
      initialDesired: 1,
      deadlineMs,
      reconcileIntervalMs: 10,
      // Simulate config.workers = -5 → clampWorkers(-5).value = 1.
      readDesired: () => clampWorkers(-5).value,
      spawnWorker: (id, shouldDrain) => fake.spawnWorker(id, shouldDrain),
      log: () => {},
      sleep: async () => {
        tick++;
        if (tick === 1) {
          fake.resolveAll();
          now = deadlineMs + 1;
        }
      },
    });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(fake.spawned, [1], "bad value clamped to 1 should still spawn worker-1");
});
