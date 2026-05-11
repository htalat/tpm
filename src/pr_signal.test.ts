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

test("classifyPrs: closed / merged PRs ignored", () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const result = classifyPrs([
      {
        url: "https://x/1",
        state,
        isDraft: false,
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [{ conclusion: "FAILURE" }],
      },
    ]);
    assert.equal(result, null, `state=${state}`);
  }
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
