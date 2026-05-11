// Classifier for the PR-signal poller (scripts/recurring/check-pr-signal.sh).
//
// Decides whether a task's in-flight PRs warrant a status flip
// (`needs-feedback` for the agent, `needs-review` for the human). The shell
// script gathers `gh pr view --json` payloads per PR, pipes them in as JSON
// on stdin, and reads structured decision lines from stdout.
//
// Output protocol — one DECIDE line per PR, then optionally one FLIP line:
//
//   DECIDE pr=<url> state=OPEN review=APPROVED ci=PASS mergeable=CLEAN action=no-signal
//   DECIDE pr=<url> state=OPEN review=COMMENTED ci=FAIL mergeable=BLOCKED action=flip-to-needs-feedback
//   FLIP needs-feedback CI failed on <url>
//
// DECIDE lines let the poller log a per-PR verdict (no more silent
// no-signal skips). The FLIP line, when present, tells the bash which
// `tpm status` mutation to dispatch.
//
// Why a TS module instead of jq+bash: the `gh pr view --json` field set is a
// drift hazard (we shipped a poller asking for `reviewThreads`, which doesn't
// exist). Keeping the classifier here makes it testable from `node --test`.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Field set passed to `gh pr view --json`. The shell script reads this list
// at runtime so the request stays in sync with the classifier's expectations.
export const PR_JSON_FIELDS = [
  "url",
  "state",
  "isDraft",
  "reviewDecision",
  "statusCheckRollup",
  "mergeStateStatus",
  "latestReviews",
] as const;

export type RawPrJson = {
  url?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<{ conclusion?: string | null }>;
  mergeStateStatus?: string;
  latestReviews?: Array<{ state?: string }>;
};

export type Classification = {
  status: "needs-review" | "needs-feedback";
  reasons: string[];
};

export type PrAction =
  | "no-signal"
  | "flip-to-needs-feedback"
  | "flip-to-needs-review";

export type PrDecision = {
  url: string;
  state: string;
  review: string;
  ci: "PASS" | "FAIL" | "PENDING" | "NONE";
  mergeable: string;
  action: PrAction;
};

const CI_FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "CANCELLED",
]);

const CI_PENDING_CONCLUSIONS = new Set([
  "",
  "PENDING",
  "IN_PROGRESS",
  "QUEUED",
  "WAITING",
  "REQUESTED",
]);

// Per-PR analysis: independent verdict for one PR. Exposed so the poller can
// log a `decide` line per PR (no more invisible no-signal skips). The
// aggregation precedence (needs-review > needs-feedback) lives in classifyPrs.
export function analyzePr(pr: RawPrJson): PrDecision {
  const url = pr.url ?? "<unknown>";
  const state = (pr.state ?? "UNKNOWN").toUpperCase();
  const mergeable = (pr.mergeStateStatus ?? "UNKNOWN").toUpperCase();
  const review = pickReview(pr);
  const ci = pickCi(pr);

  // Drafts and closed/merged PRs cast no vote.
  if (pr.isDraft === true || (state !== "OPEN")) {
    return { url, state, review, ci, mergeable, action: "no-signal" };
  }

  const conflicting = mergeable === "DIRTY";
  const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";
  const ciFailed = ci === "FAIL";
  const behind = mergeable === "BEHIND";
  const commented = (pr.latestReviews ?? []).some((r) => r.state === "COMMENTED");

  let action: PrAction = "no-signal";
  if (conflicting || changesRequested) {
    action = "flip-to-needs-review";
  } else if (ciFailed || behind || commented) {
    action = "flip-to-needs-feedback";
  }

  return { url, state, review, ci, mergeable, action };
}

function pickReview(pr: RawPrJson): string {
  const decision = (pr.reviewDecision ?? "").toUpperCase();
  if (decision) return decision;
  // Fall back to surfacing a COMMENTED review (reviewDecision stays
  // REVIEW_REQUIRED in that case, which hides the comment from the operator).
  if ((pr.latestReviews ?? []).some((r) => r.state === "COMMENTED")) {
    return "COMMENTED";
  }
  return "NONE";
}

function pickCi(pr: RawPrJson): PrDecision["ci"] {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) return "NONE";
  let sawPending = false;
  for (const c of checks) {
    const v = (c.conclusion ?? "").toUpperCase();
    if (CI_FAILED_CONCLUSIONS.has(v)) return "FAIL";
    if (CI_PENDING_CONCLUSIONS.has(v)) sawPending = true;
  }
  return sawPending ? "PENDING" : "PASS";
}

// Returns null when no signal warrants a flip.
//
// Precedence (matches the pre-refactor bash):
//   needs-review (conflict, CHANGES_REQUESTED) > needs-feedback (CI red,
//   behind main, reviewer comments). Once any PR triggers needs-review,
//   subsequent needs-feedback signals are suppressed; needs-review reasons
//   accumulate across PRs.
//
// Closed/merged PRs and draft PRs are ignored.
export function classifyPrs(prs: RawPrJson[]): Classification | null {
  const reasons: string[] = [];
  let status: Classification["status"] | null = null;

  for (const pr of prs) {
    if (pr.state !== "OPEN") continue;
    if (pr.isDraft === true) continue;

    const url = pr.url ?? "<unknown>";
    const ciFailed = (pr.statusCheckRollup ?? []).some((c) =>
      CI_FAILED_CONCLUSIONS.has((c.conclusion ?? "").toUpperCase()),
    );
    const behind = pr.mergeStateStatus === "BEHIND";
    const conflicting = pr.mergeStateStatus === "DIRTY";
    const commented = (pr.latestReviews ?? []).some(
      (r) => r.state === "COMMENTED",
    );
    const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";

    if (conflicting) {
      status = "needs-review";
      reasons.push(`merge conflict on ${url}`);
    } else if (changesRequested) {
      status = "needs-review";
      reasons.push(`CHANGES_REQUESTED on ${url}`);
    } else if (!status && ciFailed) {
      status = "needs-feedback";
      reasons.push(`CI failed on ${url}`);
    } else if (!status && behind) {
      status = "needs-feedback";
      reasons.push(`branch behind main on ${url}`);
    } else if (!status && commented) {
      status = "needs-feedback";
      reasons.push(`reviewer comments on ${url}`);
    }
  }

  return status ? { status, reasons } : null;
}

// CLI entry: reads a JSON array of `gh pr view --json <PR_JSON_FIELDS>`
// objects from stdin and writes:
//
//   DECIDE pr=<url> state=<S> review=<R> ci=<C> mergeable=<M> action=<A>
//   ...one per PR...
//   FLIP <new-status> <reason1>; <reason2>; ...
//
// The FLIP line is omitted when no flip is warranted. The shell script logs
// each DECIDE as an INFO line and uses FLIP to dispatch `tpm status` + `tpm log`.
function main(): void {
  const raw = readFileSync(0, "utf8");
  const parsed = JSON.parse(raw) as RawPrJson[];
  for (const pr of parsed) {
    const d = analyzePr(pr);
    process.stdout.write(
      `DECIDE pr=${d.url} state=${d.state} review=${d.review} ci=${d.ci} mergeable=${d.mergeable} action=${d.action}\n`,
    );
  }
  const decision = classifyPrs(parsed);
  if (!decision) return;
  process.stdout.write(`FLIP ${decision.status} ${decision.reasons.join("; ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
