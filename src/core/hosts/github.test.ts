import { test } from "node:test";
import assert from "node:assert/strict";
import { github, mapGithub, GITHUB_PR_JSON_FIELDS, GITHUB_FEEDBACK_FIELDS, type GithubPrJson } from "./github.ts";

function pr(extra: GithubPrJson = {}): GithubPrJson {
  return { url: "https://github.com/x/y/pull/1", state: "OPEN", isDraft: false, ...extra };
}

// ---- mapGithub: 5-variant compression --------------------------------------

test("mapGithub: MERGED -> merged signal carries title/body/url/mergedAt", () => {
  const s = mapGithub(pr({
    state: "MERGED",
    title: "Ship it",
    body: "## Summary\nthings",
    mergedAt: "2026-05-10T19:00:00Z",
  }));
  assert.deepEqual(s, {
    kind: "merged",
    url: "https://github.com/x/y/pull/1",
    title: "Ship it",
    body: "## Summary\nthings",
    mergedAt: "2026-05-10T19:00:00Z",
  });
});

test("mapGithub: CLOSED (not merged) -> abandoned", () => {
  // Even with red CI / dirty merge state — once closed, the PR is no longer
  // actionable for the agent. The aggregator routes abandoned to review.
  assert.deepEqual(
    mapGithub(pr({ state: "CLOSED", mergeStateStatus: "DIRTY", statusCheckRollup: [{ conclusion: "FAILURE" }] })),
    { kind: "abandoned" },
  );
});

test("mapGithub: clean open PR -> no-action", () => {
  assert.deepEqual(
    mapGithub(pr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      latestReviews: [{ state: "APPROVED" }],
    })),
    { kind: "no-action" },
  );
});

test("mapGithub: draft PR -> no-action even with red CI / dirty merge", () => {
  assert.deepEqual(
    mapGithub(pr({
      isDraft: true,
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    })),
    { kind: "no-action" },
  );
});

test("mapGithub: CHANGES_REQUESTED -> needs-human", () => {
  const s = mapGithub(pr({
    reviewDecision: "CHANGES_REQUESTED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(s.kind, "needs-human");
  if (s.kind === "needs-human") {
    assert.match(s.reason, /CHANGES_REQUESTED on https:\/\/github\.com\/x\/y\/pull\/1/);
  }
});

test("mapGithub: merge conflict (DIRTY) -> needs-agent (agent attempts rebase)", () => {
  // Routing was needs-human until task 044 — the agent now attempts the
  // rebase via /tpm feedback and only escalates if it can't resolve cleanly.
  const s = mapGithub(pr({
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(s.kind, "needs-agent");
  if (s.kind === "needs-agent") assert.match(s.reason, /merge conflict/);
});

test("mapGithub: CI failed -> needs-agent", () => {
  for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]) {
    const s = mapGithub(pr({
      mergeStateStatus: "UNSTABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion }],
    }));
    assert.equal(s.kind, "needs-agent", `conclusion ${conclusion}`);
    if (s.kind === "needs-agent") assert.match(s.reason, /CI failed/);
  }
});

test("mapGithub: branch behind main -> needs-agent", () => {
  const s = mapGithub(pr({
    mergeStateStatus: "BEHIND",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(s.kind, "needs-agent");
  if (s.kind === "needs-agent") assert.match(s.reason, /behind main/);
});

test("mapGithub: reviewer COMMENTED -> needs-agent", () => {
  const s = mapGithub(pr({
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "COMMENTED" }],
  }));
  assert.equal(s.kind, "needs-agent");
  if (s.kind === "needs-agent") assert.match(s.reason, /reviewer comments/);
});

test("mapGithub: stale COMMENTED (review older than latest commit) -> no-action", () => {
  // Sticky-reviewer thrash: GitHub keeps a COMMENTED entry in latestReviews
  // until the same author re-reviews. Without a freshness check, every poll
  // tick re-flags the task even though the reviewer hasn't seen the new code.
  assert.deepEqual(
    mapGithub(pr({
      reviewDecision: "REVIEW_REQUIRED",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      latestReviews: [{ state: "COMMENTED", submittedAt: "2026-05-15T07:20:30Z" }],
      commits: [{ committedDate: "2026-05-15T08:00:00Z" }],
    })),
    { kind: "no-action" },
  );
});

test("mapGithub: fresh COMMENTED (review newer than latest commit) -> needs-agent", () => {
  const s = mapGithub(pr({
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "COMMENTED", submittedAt: "2026-05-15T08:30:00Z" }],
    commits: [{ committedDate: "2026-05-15T08:00:00Z" }],
  }));
  assert.equal(s.kind, "needs-agent");
  if (s.kind === "needs-agent") assert.match(s.reason, /reviewer comments/);
});

test("mapGithub: mixed COMMENTED (one stale + one fresh) -> needs-agent (any fresh wins)", () => {
  const s = mapGithub(pr({
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [
      { state: "COMMENTED", submittedAt: "2026-05-15T07:20:30Z" },
      { state: "COMMENTED", submittedAt: "2026-05-15T08:30:00Z" },
    ],
    commits: [{ committedDate: "2026-05-15T08:00:00Z" }],
  }));
  assert.equal(s.kind, "needs-agent");
});

test("mapGithub: COMMENTED with no commits field -> needs-agent (defensive: treat as fresh)", () => {
  // Better to over-flag than silently swallow signal when the payload is
  // incomplete — the agent will re-check and find no-op work to do.
  const s = mapGithub(pr({
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "COMMENTED", submittedAt: "2026-05-15T07:20:30Z" }],
  }));
  assert.equal(s.kind, "needs-agent");
});

test("mapGithub: COMMENTED with no submittedAt -> needs-agent (defensive: treat as fresh)", () => {
  const s = mapGithub(pr({
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "COMMENTED" }],
    commits: [{ committedDate: "2026-05-15T08:00:00Z" }],
  }));
  assert.equal(s.kind, "needs-agent");
});

test("mapGithub: CHANGES_REQUESTED wins even when review is stale relative to commits", () => {
  // The freshness check only gates the COMMENTED-as-needs-agent path.
  // CHANGES_REQUESTED is encoded in reviewDecision and persists by design
  // until the reviewer downgrades or a new approving review lands.
  const s = mapGithub(pr({
    reviewDecision: "CHANGES_REQUESTED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "CHANGES_REQUESTED", submittedAt: "2026-05-15T07:20:30Z" }],
    commits: [{ committedDate: "2026-05-15T08:00:00Z" }],
  }));
  assert.equal(s.kind, "needs-human");
});

test("mapGithub: APPROVED + UNSTABLE merge state -> no-action (UNSTABLE = non-required check red)", () => {
  assert.deepEqual(
    mapGithub(pr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "UNSTABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      latestReviews: [{ state: "APPROVED" }],
    })),
    { kind: "no-action" },
  );
});

test("mapGithub: CHANGES_REQUESTED wins over agent-actionable signals on the same PR", () => {
  // Within one PR, human-blocking signal trumps anything the agent could
  // chase — the agent shouldn't push a rebase to a PR the reviewer has
  // already said no to.
  const s = mapGithub(pr({
    reviewDecision: "CHANGES_REQUESTED",
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
  }));
  assert.equal(s.kind, "needs-human");
});

test("mapGithub: conflict wins over CI within one PR (rebase priority)", () => {
  const s = mapGithub(pr({
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
  }));
  assert.equal(s.kind, "needs-agent");
  if (s.kind === "needs-agent") assert.match(s.reason, /merge conflict/);
});

// ---- github.parse + github.matches -----------------------------------------

test("github.matches: GitHub PR URLs only", () => {
  assert.ok(github.matches("https://github.com/htalat/tpm/pull/42"));
  assert.ok(github.matches("https://github.com/o/r/pull/7/files"));
  assert.ok(!github.matches("https://dev.azure.com/o/p/_git/r/pullrequest/9"));
  assert.ok(!github.matches("https://github.com/htalat/tpm/issues/12"));
  assert.ok(!github.matches("not a url"));
});

test("github.parse: returns owner/repo/N-derived cachePath + #N displayId", () => {
  const ref = github.parse("https://github.com/htalat/tpm/pull/42");
  assert.deepEqual(ref, {
    host: "github",
    cachePath: "htalat/tpm/42.json",
    displayId: "#42",
  });
});

test("github.parse: handles trailing path segments (/files etc.)", () => {
  const ref = github.parse("https://github.com/octo-org/some.repo/pull/7/files");
  assert.equal(ref?.cachePath, "octo-org/some.repo/7.json");
  assert.equal(ref?.displayId, "#7");
});

test("github.parse: returns null for non-GitHub-PR URLs", () => {
  assert.equal(github.parse("https://dev.azure.com/o/p/_git/r/pullrequest/9"), null);
  assert.equal(github.parse(""), null);
});

test("GITHUB_PR_JSON_FIELDS: stable contract for the poller's gh request", () => {
  // The poller no longer invokes `gh` itself (the adapter does), but the
  // constant is still the source-of-truth for which fields mapGithub reads.
  // Any removal here without updating mapGithub would silently miss signal.
  for (const f of ["url", "state", "isDraft", "reviewDecision", "statusCheckRollup", "mergeStateStatus", "latestReviews", "title", "body", "mergedAt", "commits"] as const) {
    assert.ok(GITHUB_PR_JSON_FIELDS.includes(f), `missing field: ${f}`);
  }
});

test("GITHUB_FEEDBACK_FIELDS: excludes reviewThreads (not a `gh pr view --json` field)", () => {
  // Regression guard, same shape as the PR_JSON_FIELDS check in
  // pr_signal.test.ts. Live failure 2026-05-17: the first cut of
  // fetchFeedbackContext passed `reviewThreads` to `gh pr view --json`, which
  // failed with `Unknown JSON field: "reviewThreads"`. Resolution state for
  // review threads is fetched via `gh api graphql` instead, as a separate
  // block. See AGENTS.md / SKILL.md feedback-mode notes.
  assert.ok(!GITHUB_FEEDBACK_FIELDS.includes("reviewThreads" as never));
  // Spot-check the fields that *are* valid + needed by the agent.
  for (const f of ["title", "state", "comments", "reviews", "statusCheckRollup"] as const) {
    assert.ok(GITHUB_FEEDBACK_FIELDS.includes(f), `missing field: ${f}`);
  }
});
