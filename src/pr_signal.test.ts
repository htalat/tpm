import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePr, classifyPrs, PR_JSON_FIELDS, type RawPrJson } from "./pr_signal.ts";

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

test("PR_JSON_FIELDS: includes only real `gh pr view --json` fields", () => {
  // Regression guard for the bug this module was created to fix.
  assert.ok(!PR_JSON_FIELDS.includes("reviewThreads" as never));
  assert.ok(PR_JSON_FIELDS.includes("latestReviews"));
  assert.ok(PR_JSON_FIELDS.includes("isDraft"));
  assert.ok(PR_JSON_FIELDS.includes("url"));
});
