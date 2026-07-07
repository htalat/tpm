import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allRunLogs, latestRunLog } from "./orchestrate/run_log.ts";
import { scoreRunLog, readJournal } from "./evals.ts";
import type { RunMetric } from "./evals.ts";
import { loadProjects } from "./tree.ts";
import { CONFIG_DIR } from "./config.ts";

// Evals layer 2: the golden-task benchmark (design: task 182's report). Each
// golden task is a hermetic fixture — throwaway HOME + tree, scratch git repo
// with a LOCAL BARE ORIGIN so branch/push mechanics are real without network —
// dispatched through the REAL orchestrate loop (`tpm next --claim` +
// `tpm orchestrate --task`), then scored by deterministic checks plus the
// layer-1 run metrics. The PR boundary is fabricated (the workflow doc hands
// the agent a URL to `tpm pr` with); GitHub itself is the only thing not
// exercised.
//
// Cost note: with the default agent this spends real tokens — the CLI wires
// --budget as a hard stop. Tests (and dry mechanics runs) inject a fake agent
// via `agentBin`, which becomes CLAUDE_BIN for the spawned orchestrator.

export interface GoldenEnv {
  name: string;
  rep: number;
  base: string;    // temp base dir (removed after scoring unless keep)
  home: string;    // isolated HOME (config points root at `tree`)
  root: string;    // tpm tree
  repoDir: string; // working clone the agent operates in
  bareDir: string; // local bare origin
  slug: string;    // task slug within the fixture project
  prUrl: string;   // fabricated PR url the workflow doc hands the agent
}

export interface GoldenCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GoldenResult {
  task: string;
  rep: number;
  pass: boolean;
  checks: GoldenCheck[];
  metrics: RunMetric | null;
  orchestrateExit: number | null;
}

export interface GoldenSuiteReport {
  suite: "golden";
  startedAt: string;
  agentBin: string | null;
  model: string | null;
  reps: number;
  budgetUsd: number | null;
  spentUsd: number;
  budgetExhausted: boolean;
  results: GoldenResult[];
}

interface GoldenTaskDef {
  name: string;
  setup: (env: GoldenEnv) => void;
  score: (env: GoldenEnv) => GoldenCheck[];
}

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function git(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", args);
}

// ---- fixture plumbing ---------------------------------------------------------

function writeTree(env: GoldenEnv, opts: { type: string; title: string; context: string; notes: string }): void {
  mkdirSync(join(env.home, ".tpm"), { recursive: true });
  // Notifications off: eval runs must not ping the desktop.
  writeFileSync(join(env.home, ".tpm", "config.json"), JSON.stringify({
    root: env.root,
    notifications: { start: false, finish: false, fail: false },
  }));
  mkdirSync(join(env.root, ".tpm"), { recursive: true });
  const proj = join(env.root, "golden");
  // Folder-form from the start: dispatch writes runs/ into the task folder,
  // and seeding file-form trips a fold-then-stale-path bug in the eager claim
  // flip (filed separately) that real dispatch-ready tasks don't hit.
  mkdirSync(join(proj, "tasks", env.slug), { recursive: true });
  writeFileSync(join(proj, "project.md"), `---
name: Golden
slug: golden
status: active
repo:
  remote: ${env.bareDir}
  local: ${env.repoDir}
---

# Golden

## Goal
Evals fixture project.

## Notes
${opts.notes}
`);
  writeFileSync(join(proj, "tasks", env.slug, "task.md"), `---
title: ${opts.title}
slug: ${env.slug.replace(/^\d+-/, "")}
project: golden
status: open
type: ${opts.type}
prs: []
tags: []
---

# ${opts.title}

## Context
${opts.context}

## Plan
1. Follow the project Notes exactly.

## Log
- 2026-01-01 00:00 PDT: created

## Outcome
`);
}

function initRepo(env: GoldenEnv, files: Record<string, string>): void {
  mkdirSync(env.repoDir, { recursive: true });
  git(env.repoDir, "init", "-q", "-b", "main");
  git(env.repoDir, "config", "user.email", "evals@tpm");
  git(env.repoDir, "config", "user.name", "tpm evals");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(env.repoDir, file)), { recursive: true });
    writeFileSync(join(env.repoDir, file), content);
  }
  git(env.repoDir, "add", "-A");
  git(env.repoDir, "commit", "-q", "-m", "baseline");
  git(env.repoDir, "clone", "-q", "--bare", env.repoDir, env.bareDir);
  git(env.repoDir, "remote", "add", "origin", env.bareDir);
}

// Journal transitions for the fixture task, in order.
function journalPath(env: GoldenEnv): string[] {
  return readJournal(env.root)
    .filter(e => e.task === `golden/${env.slug}`)
    .map(e => e.to);
}

function taskStatus(env: GoldenEnv): string {
  const projects = loadProjects(env.root, { archived: true });
  for (const p of projects) {
    for (const t of p.tasks) {
      if (t.slug === env.slug) return String(t.data.status ?? "?");
    }
  }
  return "(missing)";
}

function taskFile(env: GoldenEnv): string {
  const live = join(env.root, "golden", "tasks", `${env.slug}.md`);
  if (existsSync(live)) return readFileSync(live, "utf8");
  const folder = join(env.root, "golden", "tasks", env.slug, "task.md");
  if (existsSync(folder)) return readFileSync(folder, "utf8");
  const archived = join(env.root, "golden", "tasks", "archive", `${env.slug}.md`);
  return existsSync(archived) ? readFileSync(archived, "utf8") : "";
}

function check(name: string, ok: boolean, detail: string): GoldenCheck {
  return { name, ok, detail };
}

// ---- golden tasks ---------------------------------------------------------------

const FIX_BUG: GoldenTaskDef = {
  name: "fix-bug",
  setup(env) {
    initRepo(env, {
      "add.js": "export function add(a, b) {\n  return a - b; // BUG\n}\n",
      "test.js": 'import { add } from "./add.js";\nif (add(2, 3) !== 5) { console.error("FAIL: add(2,3)=" + add(2, 3)); process.exit(1); }\nconsole.log("PASS");\n',
      "package.json": '{ "type": "module" }\n',
    });
    writeTree(env, {
      type: "pr",
      title: "Fix add()",
      context: "`node test.js` fails because add() is wrong. Make the test pass.",
      notes: [
        "Workflow for this repo:",
        "1. Validate with `node test.js`.",
        `2. Work on a branch named fix/${env.slug}; commit; push it to origin.`,
        `3. Then run \`tpm pr ${env.slug} ${env.prUrl}\` — the PR itself is pre-arranged; do NOT try to open one with gh.`,
        "4. Close after merge: STOP after tpm pr. Do not complete the task yourself.",
      ].join("\n"),
    });
  },
  score(env) {
    const checks: GoldenCheck[] = [];
    // The pushed branch fixes the test — clone from the bare origin and run it.
    let branchOk = false;
    let detail = "";
    try {
      const probe = mkdtempSync(join(tmpdir(), "tpm-golden-probe-"));
      try {
        const branches = git(env.bareDir, "branch", "--format=%(refname:short)").trim().split("\n");
        const fix = branches.find(b => b !== "main");
        if (!fix) {
          detail = `no non-main branch on origin (have: ${branches.join(", ")})`;
        } else {
          git(probe, "clone", "-q", "--branch", fix, env.bareDir, "clone");
          const r = spawnSync(process.execPath, ["test.js"], { cwd: join(probe, "clone"), encoding: "utf8" });
          branchOk = r.status === 0;
          detail = branchOk ? `branch ${fix} passes test.js` : `test.js still fails on ${fix}: ${r.stderr || r.stdout}`.trim();
        }
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check("pushed branch passes the test", branchOk, detail));

    const status = taskStatus(env);
    checks.push(check("status handed off at review", status === "review", `status: ${status}`));
    checks.push(check("did not self-complete", status !== "done" && status !== "dropped", `status: ${status}`));
    checks.push(check("PR linked", taskFile(env).includes(env.prUrl), "prs frontmatter"));
    const path = journalPath(env);
    const legal = path.every(s => ["ready", "in-progress", "review"].includes(s));
    checks.push(check("legal transition path", legal && path.includes("review"), path.join(" -> ") || "(no journal)"));
    return checks;
  },
};

const INVESTIGATE: GoldenTaskDef = {
  name: "investigate",
  setup(env) {
    initRepo(env, {
      "config.json": '{ "port": 7443, "host": "127.0.0.1" }\n',
      "README.md": "# Svc\nConfig lives in config.json.\n",
    });
    writeTree(env, {
      type: "investigation",
      title: "Which port does the service bind?",
      context: "Answer from the repo. The deliverable is a report file, not a PR.",
      notes: [
        "Workflow for this repo:",
        `1. Investigate, then run \`tpm report ${env.slug}\` to scaffold the report file.`,
        "2. Write ## Summary / ## Findings / ## Recommendation into it (include the port number).",
        `3. Re-run \`tpm report ${env.slug}\` when done. Do NOT open a PR; do NOT run tpm pr.`,
      ].join("\n"),
    });
  },
  score(env) {
    const checks: GoldenCheck[] = [];
    const reportPath = join(env.root, "golden", "tasks", env.slug, "report.md");
    const hasReport = existsSync(reportPath);
    const report = hasReport ? readFileSync(reportPath, "utf8") : "";
    checks.push(check("report.md attached", hasReport, reportPath));
    checks.push(check("report has the required sections",
      /## Summary/.test(report) && /## Findings/.test(report) && /## Recommendation/.test(report),
      hasReport ? "sections present" : "no report"));
    checks.push(check("report answers the question", /7443/.test(report), hasReport ? "port mentioned" : "no report"));
    const status = taskStatus(env);
    checks.push(check("status handed off at review", status === "review", `status: ${status}`));
    checks.push(check("no PR opened", !taskFile(env).includes("http"), "prs frontmatter"));
    return checks;
  },
};

export const GOLDEN_TASKS: GoldenTaskDef[] = [FIX_BUG, INVESTIGATE];

// ---- runner ----------------------------------------------------------------------

export interface GoldenRunOpts {
  reps?: number;
  budgetUsd?: number;
  only?: string;
  agentBin?: string;   // fake-agent seam (becomes CLAUDE_BIN for the child)
  model?: string;      // TPM_AGENT_MODEL pin
  minutes?: number;    // per-dispatch time bound
  keep?: boolean;      // keep env dirs for debugging
  log?: (line: string) => void;
}

function childEnv(env: GoldenEnv, opts: GoldenRunOpts): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: env.home,
    USERPROFILE: env.home,
    TPM_NO_DAEMON: "1",
    // The claim (next --claim) and the dispatch (orchestrate --task) must
    // share one agent identity — the per-task lock is keyed on it.
    TPM_AGENT_ID: "evals-runner",
    ...(opts.agentBin ? { CLAUDE_BIN: opts.agentBin } : {}),
    ...(opts.model ? { TPM_AGENT_MODEL: opts.model } : {}),
  };
}

function tpm(env: GoldenEnv, opts: GoldenRunOpts, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: childEnv(env, opts),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export async function runGoldenSuite(opts: GoldenRunOpts = {}): Promise<GoldenSuiteReport> {
  const reps = opts.reps ?? 3;
  const log = opts.log ?? (() => {});
  const defs = GOLDEN_TASKS.filter(d => !opts.only || d.name === opts.only);
  if (defs.length === 0) throw new Error(`no golden task named "${opts.only}" (have: ${GOLDEN_TASKS.map(d => d.name).join(", ")})`);

  const report: GoldenSuiteReport = {
    suite: "golden",
    startedAt: new Date().toISOString(),
    agentBin: opts.agentBin ?? null,
    model: opts.model ?? null,
    reps,
    budgetUsd: opts.budgetUsd ?? null,
    spentUsd: 0,
    budgetExhausted: false,
    results: [],
  };

  outer:
  for (const def of defs) {
    for (let rep = 1; rep <= reps; rep++) {
      if (report.budgetUsd !== null && report.spentUsd >= report.budgetUsd) {
        report.budgetExhausted = true;
        log(`budget exhausted ($${report.spentUsd.toFixed(2)} >= $${report.budgetUsd}); stopping`);
        break outer;
      }
      const base = mkdtempSync(join(tmpdir(), `tpm-golden-${def.name}-`));
      const env: GoldenEnv = {
        name: def.name,
        rep,
        base,
        home: join(base, "home"),
        root: join(base, "tree"),
        repoDir: join(base, "repo"),
        bareDir: join(base, "origin.git"),
        slug: `001-${def.name}`,
        prUrl: `https://example.invalid/golden/${def.name}/pull/${rep}`,
      };
      log(`${def.name} rep ${rep}: setting up ${base}`);
      def.setup(env);

      const readied = tpm(env, opts, ["ready", env.slug]);
      const claimed = tpm(env, opts, ["next", "--autonomous", "--claim", "evals-runner"]);
      let orchestrateExit: number | null = null;
      if (readied.status !== 0 || claimed.status !== 0 || !claimed.stdout.includes(env.slug)) {
        report.results.push({
          task: def.name,
          rep,
          pass: false,
          checks: [check("dispatch", false, `ready/claim failed: ${(readied.stderr + claimed.stderr + claimed.stdout).trim()}`)],
          metrics: null,
          orchestrateExit,
        });
        if (!opts.keep) rmSync(base, { recursive: true, force: true });
        continue;
      }
      log(`${def.name} rep ${rep}: dispatching agent`);
      const run = tpm(env, opts, ["orchestrate", "--task", `golden/${env.slug}`, "--minutes", String(opts.minutes ?? 15)]);
      orchestrateExit = run.status;

      // Score: fixture checks + layer-1 metrics from the run's transcript.
      const projects = loadProjects(env.root, { archived: true });
      let metrics: RunMetric | null = null;
      for (const p of projects) {
        for (const t of p.tasks) {
          if (t.slug !== env.slug) continue;
          const latest = latestRunLog(t) ?? allRunLogs(t)[0];
          if (latest) metrics = scoreRunLog(`golden/${env.slug}`, basename(latest), readFileSync(latest, "utf8"));
        }
      }
      const checks = def.score(env);
      const pass = checks.every(c => c.ok);
      if (metrics?.costUsd) report.spentUsd += metrics.costUsd;
      report.results.push({ task: def.name, rep, pass, checks, metrics, orchestrateExit });
      log(`${def.name} rep ${rep}: ${pass ? "PASS" : "FAIL"} (${checks.filter(c => !c.ok).map(c => c.name).join("; ") || "all checks ok"})`);
      if (!opts.keep) rmSync(base, { recursive: true, force: true });
    }
  }

  persist(report);
  return report;
}

// Results land under the REAL config dir (the suite itself ran in throwaway
// HOMEs) so runs accumulate into a comparable history.
function persist(report: GoldenSuiteReport): void {
  try {
    const dir = join(CONFIG_DIR, "evals");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "golden.ndjson"), `${JSON.stringify(report)}\n`);
  } catch {
    // history is best-effort; the run's stdout already carries the results
  }
}

export function formatGolden(report: GoldenSuiteReport): string {
  const lines: string[] = [];
  lines.push(`# Golden suite — ${report.startedAt}`);
  lines.push(`agent: ${report.agentBin ?? "(default claude)"} · model: ${report.model ?? "(cli default)"} · reps: ${report.reps} · spent: $${report.spentUsd.toFixed(2)}${report.budgetUsd !== null ? ` / budget $${report.budgetUsd}` : ""}${report.budgetExhausted ? " (EXHAUSTED — partial)" : ""}`);
  lines.push("");
  for (const r of report.results) {
    const cost = r.metrics?.costUsd != null ? ` $${r.metrics.costUsd.toFixed(2)}` : "";
    const turns = r.metrics ? ` ${r.metrics.turns}t` : "";
    lines.push(`${r.pass ? "✓" : "✗"} ${r.task} #${r.rep}${cost}${turns}`);
    for (const c of r.checks.filter(c => !c.ok)) {
      lines.push(`    ✗ ${c.name}: ${c.detail}`);
    }
  }
  const byTask = new Map<string, { pass: number; total: number }>();
  for (const r of report.results) {
    const s = byTask.get(r.task) ?? { pass: 0, total: 0 };
    s.total++;
    if (r.pass) s.pass++;
    byTask.set(r.task, s);
  }
  lines.push("");
  lines.push([...byTask.entries()].map(([t, s]) => `${t}: ${s.pass}/${s.total}`).join(" · "));
  return lines.join("\n");
}
