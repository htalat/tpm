// Classifier for the PR-signal poller (scripts/recurring/check-pr-signal.sh).
//
// Pure function `classifyPrs` decides whether a task's in-flight PRs warrant
// a status flip (`needs-feedback` for the agent, `needs-review` for the
// human). The shell script gathers `gh pr view --json` payloads per PR, pipes
// them in as JSON on stdin, and acts on this module's stdout.
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

const CI_FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "CANCELLED",
]);

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
// objects from stdin and prints:
//   - nothing (exit 0) when no flip is warranted
//   - "<status>\n<reason1>; <reason2>; ...\n" (exit 0) when flipping
//
// The shell script consumes that output to decide whether to call
// `tpm status` + `tpm log`.
function main(): void {
  const raw = readFileSync(0, "utf8");
  const parsed = JSON.parse(raw) as RawPrJson[];
  const decision = classifyPrs(parsed);
  if (!decision) return;
  process.stdout.write(`${decision.status}\n${decision.reasons.join("; ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
