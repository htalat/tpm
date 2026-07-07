import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { flatTasks, loadProjects } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { allRunLogs, parseRunLog } from "./orchestrate/run_log.ts";
import { eventsPath } from "./events.ts";
import type { StatusEventRecord } from "./events.ts";

// Evals layer 1: score the harness from artifacts every run already leaves
// behind — NDJSON transcripts (cost, duration, tool errors, permission
// denials) and the status journal (rework round-trips, time-to-ship). No
// model calls, read-only; this is the June run-log audit as a repeatable
// command instead of a one-off. Layers 2-4 (golden suite, transcript judge,
// prompt A/B) build on the baselines this produces.

export interface RunMetric {
  task: string;        // qualified slug
  log: string;         // basename
  startedAt: string;   // from the log filename (UTC), "" when unparseable
  events: number;
  turns: number;       // tool_use count — a proxy for agent effort
  toolErrors: number;  // tool_result with is_error
  permissionDenials: number;
  costUsd: number | null;
  durationMs: number | null;
  outcome: string;     // result subtype ("success", "error_max_turns", …) or "no-result" (died mid-run)
}

export interface TaskMetric {
  task: string;
  status: string;
  type: string;
  runs: number;
  reworkCycles: number;     // journal transitions INTO rework
  attempts: number;         // orchestrator_attempts frontmatter (live counter)
  prs: number;
  timeToCloseMs: number | null; // journal first-seen -> done/dropped
}

export interface EvalsReport {
  windowDays: number | null;
  runs: RunMetric[];
  tasks: TaskMetric[];
  aggregate: {
    runs: number;
    runsWithResult: number;
    diedMidRun: number;
    totalCostUsd: number;
    meanCostUsd: number | null;
    meanDurationMs: number | null;
    meanTurns: number | null;
    toolErrorRate: number | null;       // tool errors per run
    permissionDenialRuns: number;       // runs with >=1 denial
    reworkCycles: number;
    tasksClosed: number;
    // Tasks with the most runs in the window — a runaway re-dispatch loop
    // (the June 29 incident: 4,370 logs on one task, one every ~11s) shows up
    // here instead of silently skewing every mean.
    hotTasks: { task: string; runs: number }[];
  };
}

// The denial phrasings agents actually hit (June audit theme: 17 in one
// project). Matched against tool_result error previews.
const DENIAL_PATTERNS = [
  /requires approval/i,
  /permission denied/i,
  /may only .* files? from/i, // sandbox cwd pin ("may only concatenate files from …")
  /haven't granted it yet/i,
];

// Filename timestamp: `<utc>.log` or `<child>--<utc>.log`.
function startedAtOf(name: string): string {
  const m = name.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.log$/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

export function scoreRunLog(qualifiedSlug: string, name: string, text: string): RunMetric {
  const { events } = parseRunLog(text);
  let turns = 0;
  let toolErrors = 0;
  let permissionDenials = 0;
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  let outcome = "no-result";
  for (const ev of events) {
    if (ev.kind === "tool_use") turns++;
    else if (ev.kind === "tool_result" && ev.isError) {
      toolErrors++;
      if (DENIAL_PATTERNS.some(p => p.test(ev.preview))) permissionDenials++;
    } else if (ev.kind === "result") {
      outcome = ev.subtype || (ev.isError ? "error" : "success");
      if (typeof ev.totalCostUsd === "number") costUsd = ev.totalCostUsd;
      if (typeof ev.durationMs === "number") durationMs = ev.durationMs;
    }
  }
  return {
    task: qualifiedSlug,
    log: name,
    startedAt: startedAtOf(name),
    events: events.length,
    turns,
    toolErrors,
    permissionDenials,
    costUsd,
    durationMs,
    outcome,
  };
}

// Journal, both generations (rotation keeps one archived file).
export function readJournal(root: string): StatusEventRecord[] {
  const out: StatusEventRecord[] = [];
  for (const path of [`${eventsPath(root)}.1`, eventsPath(root)]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as StatusEventRecord);
      } catch {
        // torn line at a rotation boundary — skip
      }
    }
  }
  return out;
}

function qualify(project: Project, task: Task): string {
  return task.parent ? `${project.slug}/${task.parent}/${task.slug}` : `${project.slug}/${task.slug}`;
}

export function runEvals(root: string, opts: { sinceDays?: number; now?: number } = {}): EvalsReport {
  const nowMs = opts.now ?? Date.now();
  const cutoffMs = opts.sinceDays ? nowMs - opts.sinceDays * 24 * 60 * 60 * 1000 : null;
  const inWindow = (iso: string) => cutoffMs === null || (iso !== "" && Date.parse(iso) >= cutoffMs);

  const journal = readJournal(root);
  const byTask = new Map<string, StatusEventRecord[]>();
  for (const e of journal) {
    const g = byTask.get(e.task) ?? [];
    g.push(e);
    byTask.set(e.task, g);
  }

  const runs: RunMetric[] = [];
  const tasks: TaskMetric[] = [];
  for (const project of loadProjects(root, { archived: true })) {
    for (const task of flatTasks(project.tasks)) {
      const slug = qualify(project, task);
      let taskRuns = 0;
      for (const path of allRunLogs(task)) {
        const name = basename(path);
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        const metric = scoreRunLog(slug, name, text);
        if (!inWindow(metric.startedAt)) continue;
        runs.push(metric);
        taskRuns++;
      }
      const events = (byTask.get(slug) ?? []).filter(e => inWindow(e.at));
      const reworkCycles = events.filter(e => e.to === "rework").length;
      const closed = events.find(e => e.to === "done" || e.to === "dropped");
      const first = events[0];
      const timeToCloseMs = closed && first ? Date.parse(closed.at) - Date.parse(first.at) : null;
      if (taskRuns === 0 && events.length === 0) continue; // outside the window entirely
      tasks.push({
        task: slug,
        status: String(task.data.status ?? "?"),
        type: String(task.data.type ?? "?"),
        runs: taskRuns,
        reworkCycles,
        attempts: typeof task.data.orchestrator_attempts === "number" ? task.data.orchestrator_attempts : 0,
        prs: Array.isArray(task.data.prs) ? task.data.prs.length : 0,
        timeToCloseMs,
      });
    }
  }

  const withResult = runs.filter(r => r.outcome !== "no-result");
  const costs = runs.map(r => r.costUsd).filter((c): c is number => c !== null);
  const durations = runs.map(r => r.durationMs).filter((d): d is number => d !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    windowDays: opts.sinceDays ?? null,
    runs,
    tasks,
    aggregate: {
      runs: runs.length,
      runsWithResult: withResult.length,
      diedMidRun: runs.length - withResult.length,
      totalCostUsd: costs.reduce((a, b) => a + b, 0),
      meanCostUsd: mean(costs),
      meanDurationMs: mean(durations),
      meanTurns: mean(runs.map(r => r.turns)),
      toolErrorRate: runs.length ? runs.reduce((a, r) => a + r.toolErrors, 0) / runs.length : null,
      permissionDenialRuns: runs.filter(r => r.permissionDenials > 0).length,
      reworkCycles: tasks.reduce((a, t) => a + t.reworkCycles, 0),
      tasksClosed: tasks.filter(t => t.timeToCloseMs !== null).length,
      hotTasks: [...tasks].sort((a, b) => b.runs - a.runs).slice(0, 3)
        .filter(t => t.runs > 10)
        .map(t => ({ task: t.task, runs: t.runs })),
    },
  };
}

// ---- CLI rendering -----------------------------------------------------------

const fmtMs = (ms: number | null) => (ms === null ? "—" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`);
const fmtUsd = (c: number | null) => (c === null ? "—" : `$${c.toFixed(2)}`);

export function formatEvals(report: EvalsReport): string {
  const a = report.aggregate;
  const lines: string[] = [];
  const window = report.windowDays ? `last ${report.windowDays}d` : "all time";
  lines.push(`# Harness evals (${window})`);
  lines.push("");
  lines.push(`runs: ${a.runs} (${a.diedMidRun} died mid-run) · total cost ${fmtUsd(a.totalCostUsd)} · mean ${fmtUsd(a.meanCostUsd)} / ${fmtMs(a.meanDurationMs)} / ${a.meanTurns === null ? "—" : a.meanTurns.toFixed(1)} turns`);
  lines.push(`tool errors/run: ${a.toolErrorRate === null ? "—" : a.toolErrorRate.toFixed(1)} · runs with permission denials: ${a.permissionDenialRuns} · rework cycles: ${a.reworkCycles} · tasks closed: ${a.tasksClosed}`);
  for (const h of a.hotTasks) {
    lines.push(`⚠ ${h.task}: ${h.runs} runs in the window — check for a re-dispatch loop`);
  }
  lines.push("");
  if (report.runs.length > 0) {
    lines.push("run                                       outcome            turns  errs  deny  cost    time");
    for (const r of [...report.runs].sort((x, y) => y.startedAt.localeCompare(x.startedAt)).slice(0, 30)) {
      const id = `${r.task} ${r.log.replace(/\.log$/, "")}`;
      lines.push(`${id.slice(0, 41).padEnd(41)} ${r.outcome.padEnd(18)} ${String(r.turns).padStart(5)} ${String(r.toolErrors).padStart(5)} ${String(r.permissionDenials).padStart(5)}  ${fmtUsd(r.costUsd).padEnd(7)} ${fmtMs(r.durationMs)}`);
    }
    if (report.runs.length > 30) lines.push(`… ${report.runs.length - 30} older runs (use --json for everything)`);
  }
  return lines.join("\n");
}
