// PR-signal poller. Walks every non-terminal task with a linked PR,
// dispatches per-URL fetches to the host adapter registry, and flips status
// based on the aggregated signal: merged → needs-close + inline auto-close;
// CI red / behind / conflict / open threads → needs-feedback;
// CHANGES_REQUESTED / abandoned → needs-review. Logs in the same structured
// envelope as `tpm orchestrate` (src/log.ts) so a single `tpm` log file tails
// cleanly.

import { findRoot } from "./root.ts";
import { flatTasks, loadProjects } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import {
  aggregateSignals,
  deriveOutcomeFromSignals,
  hostFor,
  shouldWatchForPrSignal,
  type ClassifiedSignal,
  type FetchedSignal,
  type PrSignal,
} from "./pr_signal.ts";
import { writePrCache } from "./pr_cache.ts";
import * as mutate from "./mutate.ts";
import { logLine, type LogLevel } from "./log.ts";

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
  // Injected for tests; production callers leave both undefined and resolve
  // via findRoot() + hostFor(url).fetchSignal(url) at the host registry.
  root?: string;
  fetchSignal?: (url: string) => Promise<FetchedSignal>;
  log?: (level: LogLevel, message: string) => void;
}

export interface PollSummary {
  checked: number;
  flipped: number;
  noSignal: number;
  fetchFailed: number;
}

export async function runPoll(opts: PollOpts = {}): Promise<PollSummary> {
  const root = opts.root ?? findRoot();
  const log = opts.log ?? ((level, message) => logLine(level, SCRIPT, message));
  const summary: PollSummary = { checked: 0, flipped: 0, noSignal: 0, fetchFailed: 0 };

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
    for (const url of urls) {
      const host = hostFor(url);
      if (!host) {
        log("INFO", `decide ${slug} pr=${url} host=unknown action=error reason=no-host-matches`);
        anyFetchError = true;
        continue;
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
        writePrCache(url, fetched.raw, { host: host.name });
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
    `summary checked=${summary.checked} flipped=${summary.flipped} no-signal=${summary.noSignal} fetch-failed=${summary.fetchFailed}${dryStr}`,
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
