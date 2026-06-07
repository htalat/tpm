// GitHub PR host adapter.
//
// Wraps `gh pr view --json` and maps the result to the coarse PrSignal
// vocabulary. Mirrors the prior classifier logic in src/pr_signal.ts (now
// archived behind analyzePr for serve.ts's panel rendering) compressed to
// the five-variant output: a clean OPEN PR → no-action, MERGED → merged,
// CLOSED-not-merged → abandoned, CI-red / behind / DIRTY / COMMENTED →
// needs-agent, CHANGES_REQUESTED → needs-human.

import { execSync } from "node:child_process";
import type { FetchedSignal, PrHost, PrRef, PrSignal } from "./types.ts";

const URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

// `gh pr view --json` field list. Shared with the poller (it imports this
// constant so its `gh` invocation always matches what mapGithub consumes).
export const GITHUB_PR_JSON_FIELDS = [
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
  // Used to gate the COMMENTED-as-needs-agent heuristic: a COMMENTED review
  // only counts as fresh signal if its submittedAt is newer than the most
  // recent commit on the branch. Otherwise the reviewer hasn't seen the code
  // they'd be commenting on. See mapGithub.
  "commits",
] as const;

export interface GithubPrJson {
  url?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<{ conclusion?: string | null }>;
  mergeStateStatus?: string;
  latestReviews?: Array<{ state?: string; submittedAt?: string }>;
  title?: string;
  body?: string;
  mergedAt?: string;
  commits?: Array<{ committedDate?: string }>;
}

const CI_FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "CANCELLED",
]);

// Compress a `gh pr view --json` payload to the coarse PrSignal. Priority
// inside a single PR: merged > abandoned > non-actionable (draft / weird
// state) > human-blocking (CHANGES_REQUESTED) > agent-actionable
// (conflict > CI > behind > reviewer comments) > no-action. Reasons name the
// URL so multi-PR aggregation upstream still has identifying info.
export function mapGithub(pr: GithubPrJson): PrSignal {
  const url = pr.url ?? "<unknown>";
  const state = (pr.state ?? "").toUpperCase();

  if (state === "MERGED") {
    return {
      kind: "merged",
      url: pr.url ?? "",
      title: pr.title ?? "",
      body: pr.body ?? "",
      mergedAt: pr.mergedAt ?? "",
    };
  }
  if (state === "CLOSED") return { kind: "abandoned" };
  if (state !== "OPEN" || pr.isDraft === true) return { kind: "no-action" };

  const merge = (pr.mergeStateStatus ?? "").toUpperCase();
  const conflicting = merge === "DIRTY";
  const behind = merge === "BEHIND";
  const ciFailed = (pr.statusCheckRollup ?? []).some((c) =>
    CI_FAILED_CONCLUSIONS.has((c.conclusion ?? "").toUpperCase()),
  );
  const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";
  // A COMMENTED review is only actionable if the reviewer's comments are
  // about the *current* code. Once a commit lands after the review, the
  // COMMENTED state is stale — the reviewer hasn't seen the new code, so
  // flipping the task to needs-agent each tick just thrashes the agent
  // against feedback it has already addressed. Defensive case: if either
  // commits or submittedAt is missing, treat as fresh (= flag) rather than
  // silently dropping signal.
  const latestCommitDate = latestCommitTimestamp(pr);
  const commented = (pr.latestReviews ?? []).some(
    (r) =>
      r.state === "COMMENTED" &&
      (!latestCommitDate || !r.submittedAt || r.submittedAt > latestCommitDate),
  );

  if (changesRequested) return { kind: "needs-human", reason: `CHANGES_REQUESTED on ${url}` };
  if (conflicting) return { kind: "needs-agent", reason: `merge conflict on ${url}` };
  if (ciFailed) return { kind: "needs-agent", reason: `CI failed on ${url}` };
  if (behind) return { kind: "needs-agent", reason: `branch behind main on ${url}` };
  if (commented) return { kind: "needs-agent", reason: `reviewer comments on ${url}` };

  return { kind: "no-action" };
}

function latestCommitTimestamp(pr: GithubPrJson): string | undefined {
  let max: string | undefined;
  for (const c of pr.commits ?? []) {
    if (c.committedDate && (!max || c.committedDate > max)) max = c.committedDate;
  }
  return max;
}

export const github: PrHost = {
  name: "github",

  matches: (url) => URL_RE.test(url),

  parse(url) {
    const m = url.match(URL_RE);
    if (!m) return null;
    const ref: PrRef = {
      host: "github",
      // Existing cache layout — kept stable so v0 GitHub snapshots don't get
      // orphaned when this module ships.
      cachePath: `${m[1]}/${m[2]}/${m[3]}.json`,
      displayId: `#${m[3]}`,
    };
    return ref;
  },

  async fetchSignal(url): Promise<FetchedSignal> {
    if (!hasCli("gh")) {
      throw new Error("gh CLI not found on PATH");
    }
    const fields = GITHUB_PR_JSON_FIELDS.join(",");
    const out = execSync(`gh pr view ${shq(url)} --json ${fields}`, {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    const raw = JSON.parse(out) as GithubPrJson;
    return { signal: mapGithub(raw), raw };
  },

  async fetchFeedbackContext(url): Promise<string> {
    if (!hasCli("gh")) {
      throw new Error("gh CLI not found on PATH");
    }
    // Distinct field list from fetchSignal: optimized for the feedback agent
    // (comments + reviews + CI rollup), not the poller's verdict. Keeping
    // the two separate avoids dragging the poller through a larger payload
    // it doesn't use.
    //
    // `reviewThreads` isn't a `gh pr view --json` field — fetch resolution
    // state via `gh api graphql` instead and emit as a second JSON block.
    // See AGENTS.md / task 041's regression guard.
    const fields = GITHUB_FEEDBACK_FIELDS.join(",");
    const prOut = execSync(`gh pr view ${shq(url)} --json ${fields}`, {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString().trim();
    const parts = parseGithubUrl(url);
    let threadsOut = "[]";
    if (parts) {
      try {
        threadsOut = execSync(
          `gh api graphql -f query=${shq(REVIEW_THREADS_QUERY)} -F owner=${shq(parts.owner)} -F name=${shq(parts.repo)} -F number=${parts.number}`,
          { stdio: ["ignore", "pipe", "pipe"] },
        ).toString().trim();
      } catch {
        // Best-effort — auth scope or rate limit shouldn't kill the whole
        // feedback round. Agent still has the PR body + comments + reviews.
      }
    }
    return [
      `## PR ${url}`,
      "",
      "### PR",
      "```json",
      prOut,
      "```",
      "",
      "### ReviewThreads",
      "```json",
      threadsOut,
      "```",
    ].join("\n");
  },
};

// `gh pr view --json` field list for the feedback-context fetch. Smaller and
// distinct from GITHUB_PR_JSON_FIELDS (the poller's set). Notably excludes
// `reviewThreads` — that field doesn't exist for `gh pr view --json`; review
// thread resolution state is fetched separately via `gh api graphql` (see
// REVIEW_THREADS_QUERY below) and emitted as a second JSON block.
export const GITHUB_FEEDBACK_FIELDS = [
  "title",
  "state",
  "comments",
  "reviews",
  "statusCheckRollup",
] as const;

interface GithubUrlParts {
  owner: string;
  repo: string;
  number: number;
}

function parseGithubUrl(url: string): GithubUrlParts | null {
  const m = url.match(URL_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          diffSide
          comments(first: 50) {
            nodes {
              id
              author { login }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}`;

function hasCli(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
