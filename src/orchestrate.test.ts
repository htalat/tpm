import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildExecutionPrompt,
  buildFeedbackPrompt,
  checkProjectRepo,
  classifyDisposition,
  evaluateTerminalState,
  fetchFeedbackContexts,
  formatDispositionLine,
  noPickLogEntry,
  parsePrUrls,
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
  assert.match(result.reason, /tpm\/084-foo/);
  assert.match(result.reason, /\/path\/never\/cloned/);
  assert.match(result.reason, /not on disk/);
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
