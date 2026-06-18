import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzePr,
  aggregateSignals,
  deriveOutcomeFromSignals,
  stripPrBody,
  shouldWatchForPrSignal,
  hostFor,
  PR_JSON_FIELDS,
  HOSTS,
  type RawPrJson,
  type ClassifiedSignal,
} from "./pr_signal.ts";

function pr(url: string, extra: Omit<RawPrJson, "url">): RawPrJson {
  return { url, state: "OPEN", isDraft: false, ...extra };
}

// ---- analyzePr (serve.ts panel renderer; GitHub-only) -------------------

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

test("analyzePr: CI failed -> flip-to-rework (CI=FAIL)", () => {
  const d = analyzePr(pr("https://x/1", {
    mergeStateStatus: "UNSTABLE",
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
  }));
  assert.equal(d.action, "flip-to-rework");
  assert.equal(d.ci, "FAIL");
});

test("analyzePr: behind main -> flip-to-rework (mergeable=BEHIND)", () => {
  const d = analyzePr(pr("https://x/1", {
    mergeStateStatus: "BEHIND",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(d.action, "flip-to-rework");
  assert.equal(d.mergeable, "BEHIND");
});

test("analyzePr: merge conflict -> flip-to-rework (agent attempts rebase)", () => {
  const d = analyzePr(pr("https://x/1", {
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(d.action, "flip-to-rework");
  assert.equal(d.mergeable, "DIRTY");
});

test("analyzePr: CHANGES_REQUESTED -> flip-to-review", () => {
  const d = analyzePr(pr("https://x/1", {
    reviewDecision: "CHANGES_REQUESTED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(d.action, "flip-to-review");
  assert.equal(d.review, "CHANGES_REQUESTED");
});

test("analyzePr: COMMENTED reviewer surfaces in review= field", () => {
  const d = analyzePr(pr("https://x/1", {
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "COMMENTED" }],
  }));
  assert.equal(d.action, "flip-to-rework");
  assert.equal(d.review, "REVIEW_REQUIRED");
});

test("analyzePr: no reviewDecision but COMMENTED in latestReviews -> review=COMMENTED", () => {
  const d = analyzePr(pr("https://x/1", {
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    latestReviews: [{ state: "COMMENTED" }],
  }));
  assert.equal(d.review, "COMMENTED");
  assert.equal(d.action, "flip-to-rework");
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
  assert.equal(d.mergeable, "DIRTY");
  assert.equal(d.ci, "FAIL");
});

test("analyzePr: merged -> flip-to-closing", () => {
  const d = analyzePr({
    url: "https://x/1",
    state: "MERGED",
    isDraft: false,
  });
  assert.equal(d.action, "flip-to-closing");
  assert.equal(d.state, "MERGED");
});

test("analyzePr: closed (not merged) -> flip-to-review (abandoned)", () => {
  // Task 052: abandoned PRs surface to the human inbox (previously silently
  // ignored). The user decides whether to reopen the PR or drop the task.
  const d = analyzePr({
    url: "https://x/1",
    state: "CLOSED",
    isDraft: false,
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
  });
  assert.equal(d.action, "flip-to-review");
  assert.equal(d.state, "CLOSED");
});

test("analyzePr: missing url -> '<unknown>' placeholder", () => {
  const d = analyzePr({ state: "OPEN", isDraft: false });
  assert.equal(d.url, "<unknown>");
});

// ---- aggregateSignals (merged-PR precedence; host-agnostic) ------------

function sig(url: string, kind: "no-action" | "needs-agent" | "needs-human" | "merged" | "abandoned", reason?: string): ClassifiedSignal {
  if (kind === "merged") {
    return { url, signal: { kind, mergedAt: "", title: "", body: "", url } };
  }
  if (kind === "needs-agent" || kind === "needs-human") {
    return { url, signal: { kind, reason: reason ?? "(reason)" } };
  }
  return { url, signal: { kind } };
}

test("aggregateSignals: empty list -> null", () => {
  assert.equal(aggregateSignals([]), null);
});

test("aggregateSignals: all no-action -> null", () => {
  assert.equal(aggregateSignals([sig("https://x/1", "no-action")]), null);
});

test("aggregateSignals: any merged -> closing (wins over everything)", () => {
  assert.deepEqual(
    aggregateSignals([
      sig("https://x/1", "merged"),
      sig("https://x/2", "needs-agent", "CI failed"),
    ]),
    { status: "closing", reasons: ["merged https://x/1"] },
  );
});

test("aggregateSignals: multiple merged -> all reasons", () => {
  assert.deepEqual(
    aggregateSignals([
      sig("https://x/1", "merged"),
      sig("https://x/2", "merged"),
    ]),
    { status: "closing", reasons: ["merged https://x/1", "merged https://x/2"] },
  );
});

test("aggregateSignals: needs-human -> review (verbatim reason)", () => {
  assert.deepEqual(
    aggregateSignals([sig("https://x/1", "needs-human", "CHANGES_REQUESTED on https://x/1")]),
    { status: "review", reasons: ["CHANGES_REQUESTED on https://x/1"] },
  );
});

test("aggregateSignals: review wins over rework across PRs (both reasons accumulate)", () => {
  const result = aggregateSignals([
    sig("https://x/1", "needs-agent", "CI failed on https://x/1"),
    sig("https://x/2", "needs-human", "CHANGES_REQUESTED on https://x/2"),
  ]);
  assert.deepEqual(result, {
    status: "review",
    reasons: ["CI failed on https://x/1", "CHANGES_REQUESTED on https://x/2"],
  });
});

test("aggregateSignals: subsequent needs-agent reasons suppressed once review fired", () => {
  const result = aggregateSignals([
    sig("https://x/1", "needs-human", "CHANGES_REQUESTED on https://x/1"),
    sig("https://x/2", "needs-agent", "behind main on https://x/2"),
  ]);
  assert.deepEqual(result, {
    status: "review",
    reasons: ["CHANGES_REQUESTED on https://x/1"],
  });
});

test("aggregateSignals: only the first needs-agent reason is recorded", () => {
  const result = aggregateSignals([
    sig("https://x/1", "needs-agent", "merge conflict on https://x/1"),
    sig("https://x/2", "needs-agent", "branch behind main on https://x/2"),
  ]);
  assert.deepEqual(result, {
    status: "rework",
    reasons: ["merge conflict on https://x/1"],
  });
});

test("aggregateSignals: abandoned PR routes to review (was silently ignored before task 052)", () => {
  assert.deepEqual(
    aggregateSignals([sig("https://x/1", "abandoned")]),
    { status: "review", reasons: ["PR abandoned: https://x/1"] },
  );
});

test("aggregateSignals: merged on one PR + abandoned on another -> closing (merge wins)", () => {
  const result = aggregateSignals([
    sig("https://x/1", "merged"),
    sig("https://x/2", "abandoned"),
  ]);
  assert.equal(result?.status, "closing");
});

// ---- shouldWatchForPrSignal (tasks 049 + 055) ---------------------------

test("shouldWatchForPrSignal: every non-terminal status with a linked PR is watched", () => {
  // Forward-direction (055): linked PRs keep generating signals as the task
  // moves through review / rework / closing. Backward (049):
  // a manual review -> ready revert mustn't strand a merge signal.
  for (const status of ["in-progress", "ready", "review", "rework", "closing"]) {
    assert.equal(
      shouldWatchForPrSignal({ status, prs: ["https://x/1"] }),
      true,
      `status ${status} with a linked PR should be watched`,
    );
  }
});

test("shouldWatchForPrSignal: non-terminal statuses without a linked PR are skipped", () => {
  // No URL to fetch means no signal to read — including in-progress before
  // the agent has opened its PR.
  for (const status of ["in-progress", "ready", "review", "rework", "closing"]) {
    assert.equal(shouldWatchForPrSignal({ status, prs: [] }), false, `${status} + empty prs`);
    assert.equal(shouldWatchForPrSignal({ status }), false, `${status} + missing prs`);
    assert.equal(
      shouldWatchForPrSignal({ status, prs: "not-an-array" }),
      false,
      `${status} + non-array prs`,
    );
  }
});

test("shouldWatchForPrSignal: parked / terminal statuses are never watched", () => {
  // open + blocked are deliberately parked; done + dropped are terminal.
  for (const status of ["open", "blocked", "done", "dropped"]) {
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

// ---- hostFor (registry dispatch) ----------------------------------------

test("hostFor: github URL routes to the github adapter", () => {
  const h = hostFor("https://github.com/htalat/tpm/pull/42");
  assert.equal(h?.name, "github");
});

test("hostFor: ADO URL routes to the ado adapter", () => {
  const h = hostFor("https://dev.azure.com/org/proj/_git/repo/pullrequest/9");
  assert.equal(h?.name, "ado");
});

test("hostFor: unknown URL returns null", () => {
  assert.equal(hostFor("https://gitlab.com/x/y/merge_requests/1"), null);
  assert.equal(hostFor("not a url"), null);
  assert.equal(hostFor(""), null);
});

test("HOSTS: contains the bundled adapters in stable order", () => {
  // Order doesn't matter for matching (matches() is mutually exclusive across
  // hosts), but the array is the registration surface — accidental
  // deduplication or reorder during a refactor would be visible here.
  assert.ok(HOSTS.some((h) => h.name === "github"));
  assert.ok(HOSTS.some((h) => h.name === "ado"));
});

// ---- PR_JSON_FIELDS (regression guard from task 041) --------------------

test("PR_JSON_FIELDS: includes only real `gh pr view --json` fields", () => {
  assert.ok(!PR_JSON_FIELDS.includes("reviewThreads" as never));
  assert.ok(PR_JSON_FIELDS.includes("latestReviews"));
  assert.ok(PR_JSON_FIELDS.includes("isDraft"));
  assert.ok(PR_JSON_FIELDS.includes("url"));
  assert.ok(PR_JSON_FIELDS.includes("title"));
  assert.ok(PR_JSON_FIELDS.includes("body"));
  assert.ok(PR_JSON_FIELDS.includes("mergedAt"));
});

// ---- stripPrBody / deriveOutcomeFromSignals -----------------------------

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

function mergedSig(url: string, fields: { title?: string; body?: string; mergedAt?: string } = {}): ClassifiedSignal {
  return {
    url,
    signal: {
      kind: "merged",
      url,
      title: fields.title ?? "",
      body: fields.body ?? "",
      mergedAt: fields.mergedAt ?? "",
    },
  };
}

test("deriveOutcomeFromSignals: returns null when no merged signal", () => {
  assert.equal(deriveOutcomeFromSignals([sig("https://x/1", "no-action")]), null);
  assert.equal(deriveOutcomeFromSignals([sig("https://x/1", "abandoned")]), null);
  assert.equal(deriveOutcomeFromSignals([]), null);
});

test("deriveOutcomeFromSignals: typical merged PR -> title + summary + merge link", () => {
  const out = deriveOutcomeFromSignals([
    mergedSig("https://github.com/o/r/pull/42", {
      title: "Fix the foo widget",
      body: "## Summary\n- swapped the bar for a baz\n\n## Test plan\n- [ ] click foo\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      mergedAt: "2026-05-10T19:00:00Z",
    }),
  ]);
  assert.equal(
    out,
    "Fix the foo widget.\n\n## Summary\n- swapped the bar for a baz\n\nMerged via https://github.com/o/r/pull/42 at 2026-05-10T19:00:00Z.",
  );
});

test("deriveOutcomeFromSignals: picks the FIRST merged signal when multiple are merged", () => {
  const out = deriveOutcomeFromSignals([
    mergedSig("https://x/1", { title: "First", body: "first body", mergedAt: "2026-01-01" }),
    mergedSig("https://x/2", { title: "Second", body: "second body", mergedAt: "2026-01-02" }),
  ]);
  assert.match(out ?? "", /^First\./);
  assert.match(out ?? "", /https:\/\/x\/1/);
  assert.doesNotMatch(out ?? "", /Second/);
});

test("deriveOutcomeFromSignals: skips non-merged signals to find a merged one", () => {
  const out = deriveOutcomeFromSignals([
    sig("https://x/1", "no-action"),
    mergedSig("https://x/2", { title: "Real one", body: "body", mergedAt: "2026-05-10" }),
  ]);
  assert.match(out ?? "", /^Real one\./);
});

test("deriveOutcomeFromSignals: title-only signal (empty body after stripping) still derives", () => {
  const out = deriveOutcomeFromSignals([
    mergedSig("https://x/1", { title: "Just a title", body: "## Test plan\n- check it\n", mergedAt: "2026-05-10T19:00:00Z" }),
  ]);
  assert.equal(out, "Just a title.\n\nMerged via https://x/1 at 2026-05-10T19:00:00Z.");
});

test("deriveOutcomeFromSignals: title that already ends with period not double-punctuated", () => {
  const out = deriveOutcomeFromSignals([
    mergedSig("https://x/1", { title: "Done." }),
  ]);
  assert.match(out ?? "", /^Done\.$/m);
  assert.doesNotMatch(out ?? "", /Done\.\./);
});

test("deriveOutcomeFromSignals: no title AND no usable body -> null (manual escape hatch)", () => {
  assert.equal(
    deriveOutcomeFromSignals([
      mergedSig("https://x/1", { body: "🤖 Generated with Claude Code\n", mergedAt: "2026-05-10" }),
    ]),
    null,
  );
});

test("deriveOutcomeFromSignals: missing mergedAt -> 'Merged via <url>.' without timestamp", () => {
  const out = deriveOutcomeFromSignals([
    mergedSig("https://x/1", { title: "Ship it", body: "" }),
  ]);
  assert.equal(out, "Ship it.\n\nMerged via https://x/1.");
});

test("deriveOutcomeFromSignals: multi-paragraph body preserved between title and merge link", () => {
  const body = "Para one — context.\n\nPara two — what we shipped.\n\n## Test plan\n- [ ] later";
  const out = deriveOutcomeFromSignals([
    mergedSig("https://x/1", { title: "Title", body, mergedAt: "2026-05-10" }),
  ]);
  assert.match(out ?? "", /Para one — context\./);
  assert.match(out ?? "", /Para two — what we shipped\./);
  assert.doesNotMatch(out ?? "", /Test plan/);
});
