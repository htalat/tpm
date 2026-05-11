import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPrs, PR_JSON_FIELDS, type RawPrJson } from "./pr_signal.ts";

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

test("classifyPrs: merge conflict -> needs-review", () => {
  const result = classifyPrs([
    pr("https://x/1", {
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  ]);
  assert.deepEqual(result, {
    status: "needs-review",
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
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }),
  ]);
  assert.equal(result?.status, "needs-review");
  // First PR's CI-failed reason still accumulates, but conflict pushes status.
  assert.deepEqual(result?.reasons, [
    "CI failed on https://x/1",
    "merge conflict on https://x/2",
  ]);
});

test("classifyPrs: subsequent feedback signals suppressed once needs-review is set", () => {
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
    status: "needs-review",
    reasons: ["merge conflict on https://x/1"],
  });
});

test("PR_JSON_FIELDS: includes only real `gh pr view --json` fields", () => {
  // Regression guard for the bug this module was created to fix.
  assert.ok(!PR_JSON_FIELDS.includes("reviewThreads" as never));
  assert.ok(PR_JSON_FIELDS.includes("latestReviews"));
  assert.ok(PR_JSON_FIELDS.includes("isDraft"));
  assert.ok(PR_JSON_FIELDS.includes("url"));
});
