// Classifier for the PR-signal poller (scripts/recurring/check-pr-signal.sh).
//
// Decides whether a task's in-flight PRs warrant a status flip
// (`needs-close` once any PR has merged, `needs-feedback` for the agent,
// `needs-review` for the human). The shell script gathers `gh pr view --json`
// payloads per PR, pipes them in as JSON on stdin, and reads structured
// decision lines from stdout.
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
// `title`, `body`, `mergedAt` feed deriveCloseOutcome so the poller can write
// an auto-Outcome inline without a second gh round-trip.
export const PR_JSON_FIELDS = [
  "url",
  "state",
  "isDraft",
  "reviewDecision",
  "statusCheckRollup",
  "mergeStateStatus",
  "latestReviews",
  "title",
  "body",
  "mergedAt",
] as const;

export type RawPrJson = {
  url?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<{ conclusion?: string | null }>;
  mergeStateStatus?: string;
  latestReviews?: Array<{ state?: string }>;
  title?: string;
  body?: string;
  mergedAt?: string;
};

export type Classification = {
  status: "needs-review" | "needs-feedback" | "needs-close";
  reasons: string[];
};

export type PrAction =
  | "no-signal"
  | "flip-to-needs-feedback"
  | "flip-to-needs-review"
  | "flip-to-needs-close";

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
// aggregation precedence (needs-close > needs-review > needs-feedback) lives
// in classifyPrs.
export function analyzePr(pr: RawPrJson): PrDecision {
  const url = pr.url ?? "<unknown>";
  const state = (pr.state ?? "UNKNOWN").toUpperCase();
  const mergeable = (pr.mergeStateStatus ?? "UNKNOWN").toUpperCase();
  const review = pickReview(pr);
  const ci = pickCi(pr);

  // Merged PR — the work shipped, task should close out.
  if (state === "MERGED") {
    return { url, state, review, ci, mergeable, action: "flip-to-needs-close" };
  }

  // Drafts and closed-not-merged PRs cast no vote.
  if (pr.isDraft === true || state !== "OPEN") {
    return { url, state, review, ci, mergeable, action: "no-signal" };
  }

  const conflicting = mergeable === "DIRTY";
  const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";
  const ciFailed = ci === "FAIL";
  const behind = mergeable === "BEHIND";
  const commented = (pr.latestReviews ?? []).some((r) => r.state === "COMMENTED");

  // DIRTY is the agent's problem first — /tpm feedback attempts the rebase,
  // resolves conflicts where tests still pass, and only escalates if the
  // resolution is genuinely ambiguous. Only CHANGES_REQUESTED is unconditional
  // human queue: a reviewer's "no" needs a human to translate it to a fix.
  let action: PrAction = "no-signal";
  if (changesRequested) {
    action = "flip-to-needs-review";
  } else if (conflicting || ciFailed || behind || commented) {
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
// Precedence:
//   needs-close (any PR merged — work shipped, close the task) >
//   needs-review (CHANGES_REQUESTED only) >
//   needs-feedback (merge conflict, CI red, behind main, reviewer comments).
// Once any PR triggers needs-review, subsequent needs-feedback signals are
// suppressed; needs-review reasons accumulate across PRs. needs-close
// supersedes everything — if the work shipped on any linked PR, that's the
// signal that matters and the task should close. Follow-up work for a
// secondary PR belongs in a separate task.
//
// Merge conflicts (mergeStateStatus=DIRTY) route to needs-feedback, not
// needs-review: the agent attempts the rebase via /tpm feedback and only
// escalates if the conflict can't be resolved cleanly (test-as-arbiter).
// Routing every conflict to the human inbox defeats the harness's promise.
//
// Closed-not-merged PRs and draft PRs are ignored.
export function classifyPrs(prs: RawPrJson[]): Classification | null {
  const merged = prs.filter((pr) => pr.state === "MERGED");
  if (merged.length > 0) {
    return {
      status: "needs-close",
      reasons: merged.map((pr) => `merged ${pr.url ?? "<unknown>"}`),
    };
  }

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

    if (changesRequested) {
      status = "needs-review";
      reasons.push(`CHANGES_REQUESTED on ${url}`);
    } else if (!status && conflicting) {
      status = "needs-feedback";
      reasons.push(`merge conflict on ${url}`);
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

// Build the auto-Outcome string for a merged PR so the poller can call
// `tpm complete --outcome "<derived>"` inline instead of handing off to a
// model-driven /tpm done round. Returns null when there's nothing useful to
// derive (no merged PR, or title+body both empty) — caller then leaves the
// task at `needs-close` for the manual escape hatch.
//
// Shape: PR title as the headline, body trimmed to everything before
// "## Test plan" (case-insensitive) and minus the "🤖 Generated with Claude
// Code" footer, followed by `Merged via <url> at <mergedAt>.` when those
// fields are present.
export function deriveCloseOutcome(prs: RawPrJson[]): string | null {
  const merged = prs.find((p) => (p.state ?? "").toUpperCase() === "MERGED");
  if (!merged) return null;

  const title = (merged.title ?? "").trim();
  const body = stripPrBody(merged.body ?? "");
  if (!title && !body) return null;

  const url = (merged.url ?? "").trim();
  const mergedAt = (merged.mergedAt ?? "").trim();

  const parts: string[] = [];
  if (title) parts.push(title.endsWith(".") ? title : `${title}.`);
  if (body) parts.push(body);
  if (url) {
    parts.push(mergedAt ? `Merged via ${url} at ${mergedAt}.` : `Merged via ${url}.`);
  }
  return parts.join("\n\n");
}

// Strip the "## Test plan" tail and the Claude Code footer from a PR body.
// Keeps everything before "## Test plan" (case-insensitive) and drops any
// trailing line containing "Generated with Claude Code" (with or without the
// 🤖 prefix or markdown link wrapping). Exposed for unit tests.
export function stripPrBody(body: string): string {
  if (!body) return "";
  let result = body.replace(/\r\n/g, "\n");

  const testPlanMatch = result.match(/^##\s+test plan\b/im);
  if (testPlanMatch && testPlanMatch.index !== undefined) {
    result = result.slice(0, testPlanMatch.index);
  }

  result = result
    .split("\n")
    .filter((line) => !/generated with .*claude code/i.test(line))
    .join("\n");

  return result.trim();
}

// CLI entry: reads a JSON array of `gh pr view --json <PR_JSON_FIELDS>`
// objects from stdin and writes:
//
//   DECIDE pr=<url> state=<S> review=<R> ci=<C> mergeable=<M> action=<A>
//   ...one per PR...
//   FLIP <new-status> <reason1>; <reason2>; ...
//   OUTCOME_BEGIN
//   <auto-Outcome lines>
//   OUTCOME_END
//
// The FLIP line is omitted when no flip is warranted. The OUTCOME block is
// emitted only when the flip is `needs-close` AND deriveCloseOutcome returns
// non-null — the shell script then calls `tpm complete --outcome` inline.
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
  if (decision.status === "needs-close") {
    const outcome = deriveCloseOutcome(parsed);
    if (outcome !== null) {
      process.stdout.write("OUTCOME_BEGIN\n");
      process.stdout.write(outcome);
      if (!outcome.endsWith("\n")) process.stdout.write("\n");
      process.stdout.write("OUTCOME_END\n");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
