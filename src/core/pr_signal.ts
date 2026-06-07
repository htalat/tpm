// PR signal registry + classifier for the poller (src/poll.ts).
//
// The classifier itself lives in src/hosts/<name>.ts — each host adapter
// answers the same coarse question in its own dialect (mapGithub, mapAdo).
// This module is the registry: it picks the adapter that matches a PR URL,
// dispatches the fetch, and aggregates per-PR signals into the single
// status flip the poller acts on.
//
// Why the abstraction shifted down a level: normalizing host data into a
// shared wire schema would grow with every new host (ADO vote=-5 has no
// faithful GitHub equivalent; pipeline state is a separate call). The
// poller's actual decision space is tiny — merged / needs-agent / needs-human
// / no-action / abandoned — so each adapter answers in its own dialect and
// the harness only sees the verdict.
//
// The legacy stdin-driven `main()` entrypoint below stays for back-compat
// with anything still piping URLs into `node src/pr_signal.ts` (it emits
// DECIDE / FLIP / OUTCOME_BEGIN/_END lines on stdout). `tpm poll` calls
// `aggregateSignals` / `deriveOutcomeFromSignals` directly — no spawn, no
// stdin/stdout protocol.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writePrCache } from "./pr_cache.ts";
import { github, mapGithub, GITHUB_PR_JSON_FIELDS } from "./hosts/github.ts";
import type { GithubPrJson } from "./hosts/github.ts";
import { ado } from "./hosts/ado.ts";
import type { FetchedSignal, PrHost, PrSignal } from "./hosts/types.ts";

export type { PrSignal, PrHost, PrRef, FetchedSignal } from "./hosts/types.ts";

// Open-ended registry. Adding a new host = append an entry here plus a
// src/hosts/<name>.ts file. No abstract base class to extend.
export const HOSTS: PrHost[] = [github, ado];

export function hostFor(url: string): PrHost | null {
  return HOSTS.find((h) => h.matches(url)) ?? null;
}

// Dispatch a fetch for one PR URL. Throws if no host claims the URL or if
// the host's CLI is missing — the poller catches both as per-PR errors so a
// single misconfigured host doesn't poison the whole tick.
export async function fetchSignal(url: string): Promise<FetchedSignal> {
  const host = hostFor(url);
  if (!host) throw new Error(`no PR host matches URL: ${url}`);
  return host.fetchSignal(url);
}

// ---- Exports for src/serve.ts (PR panel rendering) ---------------------
//
// The serve UI renders GitHub-specific badges (CI rollup, mergeable=CLEAN/...,
// reviewDecision); it needs the richer per-field view, not the coarse signal.
// analyzePr stays as the GitHub-only renderer surface. ADO panel rendering is
// out of scope for this task — serve.ts gates rich rendering on host=github.

export const PR_JSON_FIELDS = GITHUB_PR_JSON_FIELDS;

export type RawPrJson = GithubPrJson;

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

// Per-PR analysis: GitHub-only, used by serve.ts to render the PR panel
// (state / CI / review / mergeable badges). The poller's verdict comes from
// mapGithub / mapAdo via fetchSignal — this function is just for the UI.
export function analyzePr(pr: RawPrJson): PrDecision {
  const url = pr.url ?? "<unknown>";
  const state = (pr.state ?? "UNKNOWN").toUpperCase();
  const mergeable = (pr.mergeStateStatus ?? "UNKNOWN").toUpperCase();
  const review = pickReview(pr);
  const ci = pickCi(pr);

  const action = actionFor(mapGithub(pr));
  return { url, state, review, ci, mergeable, action };
}

function pickReview(pr: RawPrJson): string {
  const decision = (pr.reviewDecision ?? "").toUpperCase();
  if (decision) return decision;
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

// ---- Aggregation: PR signals → status flip ------------------------------

export type Classification = {
  status: "needs-review" | "needs-feedback" | "needs-close";
  reasons: string[];
};

export interface ClassifiedSignal {
  url: string;
  signal: PrSignal;
}

// Aggregate per-PR signals into the single flip the poller acts on.
//
// Precedence (unchanged from the prior GitHub-only classifier):
//   needs-close (any PR merged — work shipped, close the task) >
//   needs-review (any needs-human OR abandoned PR) >
//   needs-feedback (any needs-agent).
//
// Once a needs-review trigger fires, subsequent needs-agent reasons are
// suppressed (the human reviews first; the agent doesn't churn). needs-agent
// only records the first reason — within one tick we want the agent to pick
// the most urgent fix, not be told about every problem. needs-review reasons
// accumulate so the operator sees every blocking issue at once.
//
// abandoned (closed-without-merge) routes to needs-review rather than being
// ignored: a PR that died without merging means the task needs human triage —
// reopen the PR, drop the task, or something in between. The previous
// behaviour silently swallowed the signal and stranded the task.
export function aggregateSignals(items: ClassifiedSignal[]): Classification | null {
  const merged = items.filter((i) => i.signal.kind === "merged");
  if (merged.length > 0) {
    return {
      status: "needs-close",
      reasons: merged.map((i) => `merged ${i.url || "<unknown>"}`),
    };
  }

  const reasons: string[] = [];
  let status: Classification["status"] | null = null;

  for (const { url, signal } of items) {
    if (signal.kind === "needs-human") {
      status = "needs-review";
      reasons.push(signal.reason);
    } else if (signal.kind === "abandoned") {
      status = "needs-review";
      reasons.push(`PR abandoned: ${url || "<unknown>"}`);
    } else if (!status && signal.kind === "needs-agent") {
      status = "needs-feedback";
      reasons.push(signal.reason);
    }
  }

  return status ? { status, reasons } : null;
}

// Build the auto-Outcome string for a merged PR. Pulls from the first
// `merged` signal it finds — multiple merged PRs on one task are rare; the
// canonical case is one PR shipping the work. Returns null when there's
// nothing useful to derive (no merged signal, or both title and body empty
// after stripping) — caller leaves the task at needs-close for the manual
// /tpm done escape hatch.
export function deriveOutcomeFromSignals(items: ClassifiedSignal[]): string | null {
  const merged = items.find((i) => i.signal.kind === "merged");
  if (!merged || merged.signal.kind !== "merged") return null;
  return formatMergedOutcome(
    merged.signal.title,
    merged.signal.body,
    merged.signal.url,
    merged.signal.mergedAt,
  );
}

function formatMergedOutcome(
  rawTitle: string,
  rawBody: string,
  rawUrl: string,
  rawMergedAt: string,
): string | null {
  const title = (rawTitle ?? "").trim();
  const body = stripPrBody(rawBody ?? "");
  if (!title && !body) return null;

  const url = (rawUrl ?? "").trim();
  const mergedAt = (rawMergedAt ?? "").trim();

  const parts: string[] = [];
  if (title) parts.push(title.endsWith(".") ? title : `${title}.`);
  if (body) parts.push(body);
  if (url) {
    parts.push(mergedAt ? `Merged via ${url} at ${mergedAt}.` : `Merged via ${url}.`);
  }
  return parts.join("\n\n");
}

// Strip the "## Test plan" tail and the Claude Code footer from a PR body.
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

// ---- WatchableTask filter -----------------------------------------------
//
// The watch set is "any non-terminal task whose linked PR's state could
// plausibly change in a way that matters." Status indicates which inbox the
// task is parked in right now, but the PR is alive across statuses — review
// states, CI runs, and merges all keep landing after a task moves past
// in-progress. Stranding the task at needs-review / needs-feedback /
// needs-close (the post-049 forward-direction gap) made the poller blind to
// reviewer comments on PRs the agent had already handed off.
//
// Excluded statuses: `open` (not yet shaped), `blocked` (deliberately parked
// — flip back to ready/in-progress to resume watching), `done` / `dropped`
// (terminal). `in-progress` without a linked PR also returns false here:
// the shell skips it the same way either way (no URL to fetch), and folding
// the hasPrs gate into one rule keeps the predicate small.

const WATCHED_STATUSES = new Set([
  "in-progress",
  "ready",
  "needs-review",
  "needs-feedback",
  "needs-close",
]);

export type WatchableTask = { status?: unknown; prs?: unknown };

export function shouldWatchForPrSignal(task: WatchableTask): boolean {
  const status = String(task.status ?? "");
  if (!WATCHED_STATUSES.has(status)) return false;
  return Array.isArray(task.prs) && task.prs.length > 0;
}

// ---- CLI entrypoint ----------------------------------------------------

// Map a PrSignal to the action string the shell script consumes.
function actionFor(signal: PrSignal): PrAction {
  switch (signal.kind) {
    case "merged":
      return "flip-to-needs-close";
    case "needs-human":
      return "flip-to-needs-review";
    case "abandoned":
      return "flip-to-needs-review";
    case "needs-agent":
      return "flip-to-needs-feedback";
    case "no-action":
      return "no-signal";
  }
}

function reasonFor(signal: PrSignal, url: string): string {
  switch (signal.kind) {
    case "merged":
      return `merged ${url || "<unknown>"}`;
    case "needs-human":
    case "needs-agent":
      return signal.reason;
    case "abandoned":
      return `PR abandoned: ${url || "<unknown>"}`;
    case "no-action":
      return "no-action";
  }
}

async function main(): Promise<void> {
  const raw = readFileSync(0, "utf8");
  const urls = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const items: ClassifiedSignal[] = [];

  for (const url of urls) {
    const host = hostFor(url);
    if (!host) {
      process.stdout.write(
        `DECIDE pr=${url} host=unknown action=error reason=no-host-matches\n`,
      );
      continue;
    }
    try {
      const { signal, raw: payload } = await host.fetchSignal(url);
      try {
        writePrCache(url, payload, { host: host.name });
      } catch {
        // best-effort — cache write failure must not abort the poll
      }
      const reason = reasonFor(signal, url);
      const action = actionFor(signal);
      process.stdout.write(
        `DECIDE pr=${url} host=${host.name} action=${action} reason=${flatten(reason)}\n`,
      );
      items.push({ url, signal });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      process.stdout.write(
        `DECIDE pr=${url} host=${host.name} action=error reason=${flatten(msg)}\n`,
      );
    }
  }

  const decision = aggregateSignals(items);
  if (!decision) return;
  process.stdout.write(`FLIP ${decision.status} ${decision.reasons.join("; ")}\n`);

  if (decision.status === "needs-close") {
    const outcome = deriveOutcomeFromSignals(items);
    if (outcome !== null) {
      process.stdout.write("OUTCOME_BEGIN\n");
      process.stdout.write(outcome);
      if (!outcome.endsWith("\n")) process.stdout.write("\n");
      process.stdout.write("OUTCOME_END\n");
    }
  }
}

// Collapse newlines/extra whitespace so DECIDE/FLIP stay one-line.
function flatten(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`pr_signal: ${(e as Error).message ?? e}\n`);
    process.exit(2);
  });
}
