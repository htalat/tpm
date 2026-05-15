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
] as const;

export interface GithubPrJson {
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
  const commented = (pr.latestReviews ?? []).some((r) => r.state === "COMMENTED");

  if (changesRequested) return { kind: "needs-human", reason: `CHANGES_REQUESTED on ${url}` };
  if (conflicting) return { kind: "needs-agent", reason: `merge conflict on ${url}` };
  if (ciFailed) return { kind: "needs-agent", reason: `CI failed on ${url}` };
  if (behind) return { kind: "needs-agent", reason: `branch behind main on ${url}` };
  if (commented) return { kind: "needs-agent", reason: `reviewer comments on ${url}` };

  return { kind: "no-action" };
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
};

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
