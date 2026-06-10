// PR-signal poller. Walks every non-terminal task with a linked PR,
// dispatches per-URL fetches to the host adapter registry, and flips status
// based on the aggregated signal: merged → needs-close + inline auto-close;
// CI red / behind / conflict / open threads → needs-feedback;
// CHANGES_REQUESTED / abandoned → needs-review. Logs in the same structured
// envelope as `tpm orchestrate` (src/log.ts) so a single `tpm` log file tails
// cleanly.

import { findRoot } from "../root.ts";
import { flatTasks, loadProjects } from "../tree.ts";
import type { Project, Task } from "../tree.ts";
import {
  aggregateSignals,
  deriveOutcomeFromSignals,
  hostFor,
  shouldWatchForPrSignal,
  type ClassifiedSignal,
  type FetchedSignal,
  type PrSignal,
} from "./pr_signal.ts";
import { readPrCache, writePrCache } from "./pr_cache.ts";
import * as mutate from "../mutate.ts";
import { logLine, type LogLevel } from "../log.ts";
import {
  CONFIG_DIR,
  DEFAULT_POLL_MIN_INTERVAL_MINUTES,
  DEFAULT_POLL_PER_HOST,
  readConfig,
  type PollConfig,
} from "../config.ts";

const SCRIPT = "poll";

// Statuses whose tasks are candidates for the watch set. shouldWatchForPrSignal
// in src/pr_signal.ts is the per-task source of truth (additionally requires a
// non-empty prs list); this set is just the cheap enumeration filter — anything
// in `open` / `blocked` / `done` / `dropped` skips before we look at prs.
const WATCHED_STATUSES = new Set([
  "in-progress",
  "ready",
  "needs-review",
  "needs-feedback",
  "needs-close",
]);

export interface PollOpts {
  dryRun?: boolean;
  // Bypass the per-PR cache-freshness throttle (cron uses the throttled path;
  // `tpm poll --force` is the manual-diagnostic escape hatch).
  force?: boolean;
  // Injected for tests; production callers leave both undefined and resolve
  // via findRoot() + hostFor(url).fetchSignal(url) at the host registry.
  root?: string;
  fetchSignal?: (url: string) => Promise<FetchedSignal>;
  log?: (level: LogLevel, message: string) => void;
  // Injected for tests; production reads via readConfig().poll. Resolves the
  // per-PR fetch floor (see resolvePollFloor).
  pollConfig?: PollConfig;
  // Where the pr-cache lives (injected for tests). Production uses CONFIG_DIR.
  cacheDir?: string;
  // Injected for tests; production stamps the real wall clock once per tick.
  now?: () => Date;
}

export interface PollSummary {
  checked: number;
  flipped: number;
  noSignal: number;
  fetchFailed: number;
  throttled: number;
}

// Resolve the per-PR fetch floor (minutes) for a host: a configured per-host
// override wins, then the configured global floor, then the built-in default
// (host-aware so an unconfigured tree still backs ADO off). Mirrors the plan's
// `per_host[host] ?? min_interval_minutes ?? <default>` precedence.
export function resolvePollFloor(cfg: PollConfig | undefined, host: string): number {
  const perHost = cfg?.per_host?.[host]?.min_interval_minutes;
  if (perHost !== undefined) return perHost;
  const global = cfg?.min_interval_minutes;
  if (global !== undefined) return global;
  return DEFAULT_POLL_PER_HOST[host] ?? DEFAULT_POLL_MIN_INTERVAL_MINUTES;
}

export async function runPoll(opts: PollOpts = {}): Promise<PollSummary> {
  const root = opts.root ?? findRoot();
  const log = opts.log ?? ((level, message) => logLine(level, SCRIPT, message));
  const summary: PollSummary = { checked: 0, flipped: 0, noSignal: 0, fetchFailed: 0, throttled: 0 };
  const pollConfig = opts.pollConfig ?? readConfig().poll;
  const cacheDir = opts.cacheDir ?? CONFIG_DIR;
  const nowMs = (opts.now?.() ?? new Date()).getTime();

  const projects = loadProjects(root);
  const candidates = enumerateCandidates(projects);
  if (candidates.length === 0) {
    log("INFO", "no tasks to watch");
    return summary;
  }

  for (const { project, task } of candidates) {
    summary.checked++;
    const slug = qualifySlug(project.slug, task);

    if (!shouldWatchForPrSignal({ status: task.data.status, prs: task.data.prs })) {
      // Watched status but no linked PR yet (e.g. in-progress before `tpm pr`).
      // Bash version also counted this as no-signal.
      summary.noSignal++;
      continue;
    }

    const urls = (task.data.prs as unknown[])
      .map((u) => String(u).trim())
      .filter((u) => u.length > 0);
    if (urls.length === 0) {
      summary.noSignal++;
      continue;
    }

    const items: ClassifiedSignal[] = [];
    let anyFetchError = false;
    let anyThrottled = false;
    for (const url of urls) {
      const host = hostFor(url);
      if (!host) {
        log("INFO", `decide ${slug} pr=${url} host=unknown action=error reason=no-host-matches`);
        anyFetchError = true;
        continue;
      }
      // Cache-as-freshness gate: skip a PR whose snapshot is younger than the
      // resolved floor, so a fast cron doesn't re-hit the host for a PR that
      // hasn't moved. --force bypasses for manual diagnostic runs.
      if (!opts.force) {
        const floorMin = resolvePollFloor(pollConfig, host.name);
        const cached = readPrCache(url, { baseDir: cacheDir });
        if (cached) {
          const ageMin = (nowMs - new Date(cached.fetchedAt).getTime()) / 60000;
          if (Number.isFinite(ageMin) && ageMin >= 0 && ageMin < floorMin) {
            log(
              "INFO",
              `decide ${slug} pr=${url} host=${host.name} action=skip reason=throttled (age=${Math.round(ageMin)}m, floor=${floorMin}m)`,
            );
            summary.throttled++;
            anyThrottled = true;
            continue;
          }
        }
      }
      let fetched: FetchedSignal;
      try {
        fetched = opts.fetchSignal
          ? await opts.fetchSignal(url)
          : await host.fetchSignal(url);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        log("INFO", `decide ${slug} pr=${url} host=${host.name} action=error reason=${flatten(msg)}`);
        anyFetchError = true;
        continue;
      }
      try {
        writePrCache(url, fetched.raw, { host: host.name, baseDir: cacheDir });
      } catch { /* best-effort — cache failure must not abort the tick */ }
      const action = actionFor(fetched.signal);
      const reason = reasonFor(fetched.signal, url);
      log("INFO", `decide ${slug} pr=${url} host=${host.name} action=${action} reason=${flatten(reason)}`);
      items.push({ url, signal: fetched.signal });
    }

    // Every fetch errored — no signal to classify. Mirrors the bash version's
    // per-task `fetch-failed` increment. Partial errors with ≥1 successful
    // fetch fall through to aggregation; a non-classifiable mix counts as
    // no-signal (also matches bash behavior past the classifier_out parse).
    if (items.length === 0) {
      if (anyFetchError) summary.fetchFailed++;
      // Every URL throttled (and none errored): already counted per-URL in
      // summary.throttled — don't double-count as no-signal.
      else if (anyThrottled) { /* fully throttled — no task-level counter */ }
      else summary.noSignal++;
      continue;
    }

    const decision = aggregateSignals(items);
    if (!decision) {
      summary.noSignal++;
      continue;
    }
    const reasonsJoined = decision.reasons.join("; ");
    const outcome = decision.status === "needs-close"
      ? deriveOutcomeFromSignals(items)
      : null;

    if (opts.dryRun) {
      if (decision.status === "needs-close" && outcome) {
        log("INFO", `would auto-close ${slug} (${reasonsJoined})`);
      } else {
        log("INFO", `would flip ${slug} -> ${decision.status} (${reasonsJoined})`);
      }
      summary.flipped++;
      continue;
    }

    try {
      mutate.setStatus(task, decision.status);
      mutate.logEntry(task, `poller — ${reasonsJoined}`);
    } catch (e) {
      log("WARN", `flip ${slug} failed: ${(e as Error).message}`);
      summary.fetchFailed++;
      continue;
    }

    if (decision.status === "needs-close" && outcome) {
      try {
        mutate.complete(task, { outcome });
        log("INFO", `auto-closed ${slug} (${reasonsJoined})`);
      } catch (e) {
        log(
          "WARN",
          `auto-close ${slug} failed (${(e as Error).message}) — leaving at needs-close`,
        );
      }
    } else {
      log("INFO", `flipped ${slug} -> ${decision.status} (${reasonsJoined})`);
    }
    summary.flipped++;
  }

  const dryStr = opts.dryRun ? " (dry-run)" : "";
  log(
    "INFO",
    `summary checked=${summary.checked} flipped=${summary.flipped} no-signal=${summary.noSignal} fetch-failed=${summary.fetchFailed} throttled=${summary.throttled}${dryStr}`,
  );
  return summary;
}

function enumerateCandidates(projects: Project[]): { project: Project; task: Task }[] {
  const out: { project: Project; task: Task }[] = [];
  for (const project of projects) {
    for (const task of flatTasks(project.tasks)) {
      if (task.archived) continue;
      const status = String(task.data.status ?? "");
      if (!WATCHED_STATUSES.has(status)) continue;
      out.push({ project, task });
    }
  }
  return out;
}

function qualifySlug(projectSlug: string, task: Task): string {
  return task.parent
    ? `${projectSlug}/${task.parent}/${task.slug}`
    : `${projectSlug}/${task.slug}`;
}

function actionFor(signal: PrSignal): string {
  switch (signal.kind) {
    case "merged":      return "flip-to-needs-close";
    case "needs-human": return "flip-to-needs-review";
    case "abandoned":   return "flip-to-needs-review";
    case "needs-agent": return "flip-to-needs-feedback";
    case "no-action":   return "no-signal";
  }
}

function reasonFor(signal: PrSignal, url: string): string {
  switch (signal.kind) {
    case "merged":      return `merged ${url || "<unknown>"}`;
    case "needs-human":
    case "needs-agent": return signal.reason;
    case "abandoned":   return `PR abandoned: ${url || "<unknown>"}`;
    case "no-action":   return "no-action";
  }
}

function flatten(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
