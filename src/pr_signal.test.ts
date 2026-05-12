import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePr, classifyPrs, deriveCloseOutcome, stripPrBody, shouldWatchForPrSignal, PR_JSON_FIELDS, type RawPrJson } from "./pr_signal.ts";

function pr(url: string, extra: Omit<RawPrJson, "url">): RawPrJson {
  return { url, state: "OPEN", isDraft: false, ...extra };
}

test("classifyPrs: clean open PR -> no flip", () => {
  const result = classifyPrs([
    pr("https://x/1", {
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      latestReviews: [{ state: "APPROVED" }],
    }),
  ]);
  assert.equal(result, null);
});

test("classifyPrs: CI failed -> needs-feedback", () => {
  const result = classifyPrs([
    pr("https://x/1", {
      mergeStateStatus: "UNSTABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-feedback",
    reasons: ["CI failed on https://x/1"],
  });
});

test("classifyPrs: TIMED_OUT / CANCELLED / ACTION_REQUIRED all count as CI failure", () => {
  for (const conclusion of ["TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]) {
    const result = classifyPrs([
      pr("https://x/1", { statusCheckRollup: [{ conclusion }] }),
    ]);
    assert.equal(result?.status, "needs-feedback", `conclusion ${conclusion}`);
  }
});

test("classifyPrs: behind main -> needs-feedback", () => {
  const result = classifyPrs([
    pr("https://x/1", {
      mergeStateStatus: "BEHIND",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-feedback",
    reasons: ["branch behind main on https://x/1"],
  });
});

test("classifyPrs: merge conflict -> needs-feedback (agent attempts rebase)", () => {
  // Routing was needs-review until task 044 — the agent now attempts the
  // rebase via /tpm feedback and only escalates if it can't resolve cleanly.
  const result = classifyPrs([
    pr("https://x/1", {
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-feedback",
    reasons: ["merge conflict on https://x/1"],
  });
});

test("classifyPrs: merge conflict + CI failed on same PR -> needs-feedback, conflict reason wins", () => {
  // Within one PR, rebase comes before CI in the feedback procedure's
  // priority order. Surface the conflict so the agent tackles it first.
  const result = classifyPrs([
    pr("https://x/1", {
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-feedback",
    reasons: ["merge conflict on https://x/1"],
  });
});

test("classifyPrs: CHANGES_REQUESTED -> needs-review", () => {
  const result = classifyPrs([
    pr("https://x/1", {
      reviewDecision: "CHANGES_REQUESTED",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-review",
    reasons: ["CHANGES_REQUESTED on https://x/1"],
  });
});

test("classifyPrs: reviewer left COMMENTED -> needs-feedback", () => {
  const result = classifyPrs([
    pr("https://x/1", {
      reviewDecision: "REVIEW_REQUIRED",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      latestReviews: [{ state: "COMMENTED" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-feedback",
    reasons: ["reviewer comments on https://x/1"],
  });
});

test("classifyPrs: APPROVED + UNSTABLE merge state -> no flip (ignore UNSTABLE)", () => {
  // UNSTABLE means non-required check is red. Not actionable.
  const result = classifyPrs([
    pr("https://x/1", {
      reviewDecision: "APPROVED",
      mergeStateStatus: "UNSTABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      latestReviews: [{ state: "APPROVED" }],
    }),
  ]);
  assert.equal(result, null);
});

test("classifyPrs: draft PR -> ignored even with red CI", () => {
  const result = classifyPrs([
    {
      url: "https://x/1",
      state: "OPEN",
      isDraft: true,
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    },
  ]);
  assert.equal(result, null);
});

test("classifyPrs: closed (not merged) PRs ignored", () => {
  // Abandoned PRs (state=CLOSED without merge) are not actionable signal —
  // the human decides whether to drop the task or reopen the PR.
  const result = classifyPrs([
    {
      url: "https://x/1",
      state: "CLOSED",
      isDraft: false,
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    },
  ]);
  assert.equal(result, null);
});

test("classifyPrs: merged PR -> needs-close", () => {
  const result = classifyPrs([
    {
      url: "https://x/1",
      state: "MERGED",
      isDraft: false,
    },
  ]);
  assert.deepEqual(result, {
    status: "needs-close",
    reasons: ["merged https://x/1"],
  });
});

test("classifyPrs: merged wins over in-flight feedback signal on another PR", () => {
  // Mixed multi-PR task: primary merged, secondary still draft / failing.
  // The merge means the work shipped — close the task; spin up a new one
  // for follow-up work if needed.
  const result = classifyPrs([
    { url: "https://x/1", state: "MERGED", isDraft: false },
    {
      url: "https://x/2",
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    },
  ]);
  assert.deepEqual(result, {
    status: "needs-close",
    reasons: ["merged https://x/1"],
  });
});

test("classifyPrs: multiple merged PRs -> all listed in reasons", () => {
  const result = classifyPrs([
    { url: "https://x/1", state: "MERGED", isDraft: false },
    { url: "https://x/2", state: "MERGED", isDraft: false },
  ]);
  assert.deepEqual(result, {
    status: "needs-close",
    reasons: ["merged https://x/1", "merged https://x/2"],
  });
});

test("classifyPrs: needs-review wins over needs-feedback across PRs", () => {
  const result = classifyPrs([
    pr("https://x/1", {
      mergeStateStatus: "BEHIND",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    }),
    pr("https://x/2", {
      reviewDecision: "CHANGES_REQUESTED",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  ]);
  assert.equal(result?.status, "needs-review");
  // First PR's CI-failed reason still accumulates, but CHANGES_REQUESTED pushes status.
  assert.deepEqual(result?.reasons, [
    "CI failed on https://x/1",
    "CHANGES_REQUESTED on https://x/2",
  ]);
});

test("classifyPrs: subsequent feedback signals suppressed once needs-review is set", () => {
  const result = classifyPrs([
    pr("https://x/1", {
      reviewDecision: "CHANGES_REQUESTED",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
    pr("https://x/2", {
      mergeStateStatus: "BEHIND",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-review",
    reasons: ["CHANGES_REQUESTED on https://x/1"],
  });
});

test("classifyPrs: conflict on one PR + feedback signal on another -> single feedback reason", () => {
  // Both signals are needs-feedback after task 044. First PR's conflict wins
  // (rebase before CI in the feedback procedure's priority); subsequent
  // feedback reasons are suppressed by the !status guard.
  const result = classifyPrs([
    pr("https://x/1", {
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
    pr("https://x/2", {
      mergeStateStatus: "BEHIND",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-feedback",
    reasons: ["merge conflict on https://x/1"],
  });
});

test("analyzePr: clean open PR -> no-signal", () => {
  const d = analyzePr(pr("https://x/1", {
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "APPROVED" }],
  }));
  assert.deepEqual(d, {
    url: "https://x/1",
    state: "OPEN",
    review: "APPROVED",
    ci: "PASS",
    mergeable: "CLEAN",
    action: "no-signal",
  });
});

test("analyzePr: CI failed -> flip-to-needs-feedback (CI=FAIL)", () => {
  const d = analyzePr(pr("https://x/1", {
    mergeStateStatus: "UNSTABLE",
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
  }));
  assert.equal(d.action, "flip-to-needs-feedback");
  assert.equal(d.ci, "FAIL");
});

test("analyzePr: behind main -> flip-to-needs-feedback (mergeable=BEHIND)", () => {
  const d = analyzePr(pr("https://x/1", {
    mergeStateStatus: "BEHIND",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(d.action, "flip-to-needs-feedback");
  assert.equal(d.mergeable, "BEHIND");
});

test("analyzePr: merge conflict -> flip-to-needs-feedback (agent attempts rebase)", () => {
  const d = analyzePr(pr("https://x/1", {
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(d.action, "flip-to-needs-feedback");
  assert.equal(d.mergeable, "DIRTY");
});

test("analyzePr: CHANGES_REQUESTED -> flip-to-needs-review", () => {
  const d = analyzePr(pr("https://x/1", {
    reviewDecision: "CHANGES_REQUESTED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(d.action, "flip-to-needs-review");
  assert.equal(d.review, "CHANGES_REQUESTED");
});

test("analyzePr: COMMENTED reviewer surfaces in review= field", () => {
  // reviewDecision stays REVIEW_REQUIRED; latestReviews has the COMMENTED.
  const d = analyzePr(pr("https://x/1", {
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "COMMENTED" }],
  }));
  assert.equal(d.action, "flip-to-needs-feedback");
  assert.equal(d.review, "REVIEW_REQUIRED");
});

test("analyzePr: no reviewDecision but COMMENTED in latestReviews -> review=COMMENTED", () => {
  const d = analyzePr(pr("https://x/1", {
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "COMMENTED" }],
  }));
  assert.equal(d.review, "COMMENTED");
  assert.equal(d.action, "flip-to-needs-feedback");
});

test("analyzePr: pending CI -> ci=PENDING, no flip", () => {
  const d = analyzePr(pr("https://x/1", {
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: null }, { conclusion: "SUCCESS" }],
  }));
  assert.equal(d.ci, "PENDING");
  assert.equal(d.action, "no-signal");
});

test("analyzePr: no CI checks -> ci=NONE", () => {
  const d = analyzePr(pr("https://x/1", {
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [],
  }));
  assert.equal(d.ci, "NONE");
});

test("analyzePr: draft PR -> no-signal even with red CI / dirty mergeable", () => {
  const d = analyzePr({
    url: "https://x/1",
    state: "OPEN",
    isDraft: true,
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
  });
  assert.equal(d.action, "no-signal");
  // We still surface the underlying state so the operator can see why.
  assert.equal(d.mergeable, "DIRTY");
  assert.equal(d.ci, "FAIL");
});

test("analyzePr: merged -> flip-to-needs-close", () => {
  const d = analyzePr({
    url: "https://x/1",
    state: "MERGED",
    isDraft: false,
  });
  assert.equal(d.action, "flip-to-needs-close");
  assert.equal(d.state, "MERGED");
});

test("analyzePr: closed (not merged) -> no-signal regardless of signals", () => {
  const d = analyzePr({
    url: "https://x/1",
    state: "CLOSED",
    isDraft: false,
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
  });
  assert.equal(d.action, "no-signal");
  assert.equal(d.state, "CLOSED");
});

test("analyzePr: missing url -> '<unknown>' placeholder", () => {
  const d = analyzePr({ state: "OPEN", isDraft: false });
  assert.equal(d.url, "<unknown>");
});

// ---- shouldWatchForPrSignal (task 049) ----------------------------------

test("shouldWatchForPrSignal: in-progress is always watched", () => {
  assert.equal(shouldWatchForPrSignal({ status: "in-progress", prs: ["https://x/1"] }), true);
  assert.equal(shouldWatchForPrSignal({ status: "in-progress", prs: [] }), true);
  assert.equal(shouldWatchForPrSignal({ status: "in-progress" }), true);
});

test("shouldWatchForPrSignal: ready is watched only with a linked PR", () => {
  // The task-049 case: a manual `needs-review -> ready` revert (or an agent
  // bouncing the task back) must not strand a task whose PR then merges.
  assert.equal(shouldWatchForPrSignal({ status: "ready", prs: ["https://x/1"] }), true);
  // ...but a plain queued task with no PR has nothing to watch.
  assert.equal(shouldWatchForPrSignal({ status: "ready", prs: [] }), false);
  assert.equal(shouldWatchForPrSignal({ status: "ready" }), false);
  assert.equal(shouldWatchForPrSignal({ status: "ready", prs: "not-an-array" }), false);
});

test("shouldWatchForPrSignal: parked / terminal / already-queued statuses are never watched", () => {
  // Even if a PR somehow got attached: `open`/`blocked` are deliberately
  // parked, `done`/`dropped` are terminal, and `needs-*` are already in
  // someone's queue (re-watching would re-log the same signal every tick).
  for (const status of ["open", "blocked", "done", "dropped", "needs-feedback", "needs-review", "needs-close"]) {
    assert.equal(
      shouldWatchForPrSignal({ status, prs: ["https://x/1"] }),
      false,
      `status ${status} with a linked PR should still be skipped`,
    );
  }
});

test("shouldWatchForPrSignal: missing / empty status is not watched", () => {
  assert.equal(shouldWatchForPrSignal({}), false);
  assert.equal(shouldWatchForPrSignal({ status: "" }), false);
  assert.equal(shouldWatchForPrSignal({ status: undefined, prs: ["https://x/1"] }), false);
});

test("ready task with a merged PR: watched, then classifier closes it (task 049 end-to-end)", () => {
  // The filter expansion is the whole fix — once the `ready` task is back in
  // scope, the existing merged-PR path (classifyPrs -> needs-close, plus the
  // auto-Outcome) takes it the rest of the way without caring what the prior
  // status was.
  const prs: RawPrJson[] = [{
    url: "https://x/1",
    state: "MERGED",
    isDraft: false,
    title: "Did the thing",
    body: "summary line",
    mergedAt: "2026-05-10T19:00:00Z",
  }];
  assert.equal(shouldWatchForPrSignal({ status: "ready", prs: ["https://x/1"] }), true);
  assert.deepEqual(classifyPrs(prs), { status: "needs-close", reasons: ["merged https://x/1"] });
  assert.match(deriveCloseOutcome(prs) ?? "", /^Did the thing\./);
});

test("ready task with a clean OPEN PR: watched, but classifier leaves it alone", () => {
  // No churn: only the MERGED (and CHANGES_REQUESTED / CI-red / BEHIND) cases
  // mutate state — a clean open PR on a `ready` task stays put.
  assert.equal(shouldWatchForPrSignal({ status: "ready", prs: ["https://x/1"] }), true);
  assert.equal(
    classifyPrs([
      {
        url: "https://x/1",
        state: "OPEN",
        isDraft: false,
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        latestReviews: [{ state: "APPROVED" }],
      },
    ]),
    null,
  );
});

test("PR_JSON_FIELDS: includes only real `gh pr view --json` fields", () => {
  // Regression guard for the bug this module was created to fix.
  assert.ok(!PR_JSON_FIELDS.includes("reviewThreads" as never));
  assert.ok(PR_JSON_FIELDS.includes("latestReviews"));
  assert.ok(PR_JSON_FIELDS.includes("isDraft"));
  assert.ok(PR_JSON_FIELDS.includes("url"));
  // Task 045: deriveCloseOutcome needs title/body/mergedAt for inline auto-close.
  assert.ok(PR_JSON_FIELDS.includes("title"));
  assert.ok(PR_JSON_FIELDS.includes("body"));
  assert.ok(PR_JSON_FIELDS.includes("mergedAt"));
});

// ---- stripPrBody / deriveCloseOutcome (task 045) -------------------------

test("stripPrBody: cuts everything from '## Test plan' onward", () => {
  const body = [
    "## Summary",
    "- bullet 1",
    "- bullet 2",
    "",
    "## Test plan",
    "- [ ] verify thing",
  ].join("\n");
  assert.equal(stripPrBody(body), "## Summary\n- bullet 1\n- bullet 2");
});

test("stripPrBody: 'Test Plan' header (case-insensitive) also cuts", () => {
  const body = "Words.\n\n## Test Plan\nfoo";
  assert.equal(stripPrBody(body), "Words.");
});

test("stripPrBody: drops Claude Code footer line (with or without robot emoji)", () => {
  const withEmoji = "Body line.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)";
  assert.equal(stripPrBody(withEmoji), "Body line.");
  const noEmoji = "Body line.\n\nGenerated with Claude Code";
  assert.equal(stripPrBody(noEmoji), "Body line.");
});

test("stripPrBody: empty body returns empty string", () => {
  assert.equal(stripPrBody(""), "");
});

test("stripPrBody: body that is only the Claude Code footer returns empty", () => {
  assert.equal(stripPrBody("🤖 Generated with Claude Code\n"), "");
});

test("stripPrBody: CRLF line endings normalized to LF before stripping", () => {
  const body = "## Summary\r\n- a\r\n\r\n## Test plan\r\n- check";
  assert.equal(stripPrBody(body), "## Summary\n- a");
});

test("deriveCloseOutcome: returns null when no merged PR in the list", () => {
  assert.equal(deriveCloseOutcome([{ url: "https://x/1", state: "OPEN" }]), null);
  assert.equal(deriveCloseOutcome([{ url: "https://x/1", state: "CLOSED" }]), null);
  assert.equal(deriveCloseOutcome([]), null);
});

test("deriveCloseOutcome: typical merged PR -> title + summary + merge link", () => {
  const out = deriveCloseOutcome([
    {
      url: "https://github.com/o/r/pull/42",
      state: "MERGED",
      title: "Fix the foo widget",
      body: "## Summary\n- swapped the bar for a baz\n\n## Test plan\n- [ ] click foo\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      mergedAt: "2026-05-10T19:00:00Z",
    },
  ]);
  assert.equal(
    out,
    "Fix the foo widget.\n\n## Summary\n- swapped the bar for a baz\n\nMerged via https://github.com/o/r/pull/42 at 2026-05-10T19:00:00Z.",
  );
});

test("deriveCloseOutcome: picks the FIRST merged PR when multiple are merged", () => {
  const out = deriveCloseOutcome([
    { url: "https://x/1", state: "MERGED", title: "First", body: "first body", mergedAt: "2026-01-01" },
    { url: "https://x/2", state: "MERGED", title: "Second", body: "second body", mergedAt: "2026-01-02" },
  ]);
  assert.match(out ?? "", /^First\./);
  assert.match(out ?? "", /https:\/\/x\/1/);
  assert.doesNotMatch(out ?? "", /Second/);
});

test("deriveCloseOutcome: skips a non-merged PR to find a merged one", () => {
  const out = deriveCloseOutcome([
    { url: "https://x/1", state: "OPEN" },
    { url: "https://x/2", state: "MERGED", title: "Real one", body: "body", mergedAt: "2026-05-10" },
  ]);
  assert.match(out ?? "", /^Real one\./);
});

test("deriveCloseOutcome: title-only PR (empty body after stripping) still derives", () => {
  const out = deriveCloseOutcome([
    {
      url: "https://x/1",
      state: "MERGED",
      title: "Just a title",
      body: "## Test plan\n- check it\n",
      mergedAt: "2026-05-10T19:00:00Z",
    },
  ]);
  assert.equal(out, "Just a title.\n\nMerged via https://x/1 at 2026-05-10T19:00:00Z.");
});

test("deriveCloseOutcome: title that already ends with period not double-punctuated", () => {
  const out = deriveCloseOutcome([
    { url: "https://x/1", state: "MERGED", title: "Done.", body: "", mergedAt: "" },
  ]);
  assert.match(out ?? "", /^Done\.$/m);
  assert.doesNotMatch(out ?? "", /Done\.\./);
});

test("deriveCloseOutcome: no title AND no usable body -> null (manual escape hatch)", () => {
  assert.equal(
    deriveCloseOutcome([
      { url: "https://x/1", state: "MERGED", title: "", body: "🤖 Generated with Claude Code\n", mergedAt: "2026-05-10" },
    ]),
    null,
  );
});

test("deriveCloseOutcome: missing mergedAt -> 'Merged via <url>.' without timestamp", () => {
  const out = deriveCloseOutcome([
    { url: "https://x/1", state: "MERGED", title: "Ship it", body: "" },
  ]);
  assert.equal(out, "Ship it.\n\nMerged via https://x/1.");
});

test("deriveCloseOutcome: multi-paragraph body preserved between title and merge link", () => {
  const body = "Para one — context.\n\nPara two — what we shipped.\n\n## Test plan\n- [ ] later";
  const out = deriveCloseOutcome([
    { url: "https://x/1", state: "MERGED", title: "Title", body, mergedAt: "2026-05-10" },
  ]);
  assert.match(out ?? "", /Para one — context\./);
  assert.match(out ?? "", /Para two — what we shipped\./);
  assert.doesNotMatch(out ?? "", /Test plan/);
});
