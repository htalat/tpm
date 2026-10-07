import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AgentRunnerConfigSchema,
  GitHubPrHost,
  LABELS,
  parsePolicy,
  POLICY_PATH,
  resolveAgentCli,
  resolveReviewerCli,
  type AgentRunnerConfig,
  type RepoConfig,
} from '@durable/agent-runner';
import { createPool, MIGRATIONS_DIR, type Pool } from '@durable/db';
import { createRegistry } from '@durable/workflows';

/**
 * `npm run doctor`: one read-only pass over everything a run depends on.
 * Every check is independent; a failing one does not hide the others.
 * Nothing here changes state.
 */
export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  group: string;
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command and never throws (a missing binary is code null). */
export type Probe = (
  bin: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<ProbeResult>;

export const execProbe: Probe = (bin, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : null
          : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });

export interface DoctorOptions {
  probe?: Probe;
  env?: NodeJS.ProcessEnv;
  configPath: string;
  dataDir: string;
  now?: () => Date;
}

const first = (s: string) => s.trim().split('\n')[0] ?? '';

export async function runDoctor(o: DoctorOptions): Promise<CheckResult[]> {
  const probe = o.probe ?? execProbe;
  const env = o.env ?? process.env;
  const now = o.now ?? (() => new Date());
  const out: CheckResult[] = [];
  const add = (group: string, name: string, status: Status, detail: string, fix?: string) =>
    out.push({ group, name, status, detail, fix });

  // ---- system ---------------------------------------------------------------------------------
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major! > 22 || (major === 22 && minor! >= 12);
  add(
    'system',
    'node',
    nodeOk ? 'ok' : 'fail',
    `v${process.versions.node}`,
    nodeOk ? undefined : 'install Node.js 22.12 or newer',
  );
  for (const [bin, args] of [
    ['git', ['--version']],
    ['bash', ['--version']],
  ] as const) {
    const r = await probe(bin, [...args]);
    add('system', bin, r.code === 0 ? 'ok' : 'fail', r.code === 0 ? first(r.stdout) : 'not found');
  }

  // ---- database ---------------------------------------------------------------------------------
  let pool: Pool | null = null;
  if (!env.DATABASE_URL) {
    add('database', 'DATABASE_URL', 'fail', 'not set', 'cp .env.example .env and set DATABASE_URL');
  } else {
    pool = createPool({ connectionString: env.DATABASE_URL, max: 2, applicationName: 'durable-doctor' });
    try {
      const v = await pool.query<{ server_version: string }>('SHOW server_version');
      add('database', 'connection', 'ok', `PostgreSQL ${v.rows[0]!.server_version}`);
    } catch (e) {
      add(
        'database',
        'connection',
        'fail',
        (e as Error).message,
        'start PostgreSQL (docker compose up -d postgres) or fix DATABASE_URL',
      );
      await pool.end().catch(() => undefined);
      pool = null;
    }
  }
  if (pool) {
    try {
      await checkDatabase(pool, now(), add);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  // ---- api ---------------------------------------------------------------------------------------
  const apiUrl = env.API_URL ?? `http://127.0.0.1:${env.API_PORT ?? 3000}`;
  try {
    const res = await fetch(`${apiUrl}/ready`, { signal: AbortSignal.timeout(3000) });
    add(
      'api',
      'ready',
      res.ok ? 'ok' : 'warn',
      `${apiUrl} -> HTTP ${res.status}`,
      res.ok ? undefined : 'run the migrations',
    );
  } catch {
    add(
      'api',
      'ready',
      'warn',
      `${apiUrl} is not answering`,
      'start the factory (menu bar app, or npm run api)',
    );
  }

  // ---- agent-runner -----------------------------------------------------------------------------
  if (!existsSync(o.configPath)) {
    add(
      'agent-runner',
      'config',
      'skip',
      `${o.configPath} not found`,
      'cp agent-runner.config.example.json agent-runner.config.json',
    );
  } else {
    let config: AgentRunnerConfig | null = null;
    try {
      config = AgentRunnerConfigSchema.parse(JSON.parse(readFileSync(o.configPath, 'utf8')));
      add('agent-runner', 'config', 'ok', `${o.configPath}: ${config.repos.length} repo(s)`);
    } catch (e) {
      add('agent-runner', 'config', 'fail', `${o.configPath}: ${(e as Error).message.slice(0, 500)}`);
    }
    if (config) {
      await checkTrackerClis(config, probe, env, add);
      for (const repo of config.repos) await checkRepo(repo, probe, env, add);
    }
  }

  // ---- data --------------------------------------------------------------------------------------
  const bytes = dirSize(o.dataDir);
  const gb = bytes / 1024 ** 3;
  add(
    'data',
    'size',
    gb > 2 ? 'warn' : 'ok',
    `${o.dataDir}: ${(bytes / 1024 ** 2).toFixed(1)} MB`,
    gb > 2 ? 'delete old data/logs and data/agent-runs (see issue #197)' : undefined,
  );
  return out;
}

async function checkDatabase(
  pool: Pool,
  now: Date,
  add: (g: string, n: string, s: Status, d: string, f?: string) => void,
) {
  // Migrations: every file in packages/db/migrations must be applied.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let applied: string[] = [];
  try {
    applied = (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name,
    );
  } catch {
    // table missing: nothing applied
  }
  const missing = files.filter((f) => !applied.includes(f));
  add(
    'database',
    'migrations',
    missing.length ? 'fail' : 'ok',
    missing.length ? `not applied: ${missing.join(', ')}` : `${files.length} applied`,
    missing.length ? 'npm run db:migrate' : undefined,
  );
  if (missing.length && !applied.length) return; // no schema: the checks below cannot run

  // Every workflow version still in use must be registered, or those tasks can never finish.
  const registry = createRegistry();
  const inUse = (
    await pool.query<{ type: string; workflow_version: number; n: number }>(
      `SELECT type, workflow_version, count(*)::int AS n FROM tasks
       WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED') GROUP BY 1, 2`,
    )
  ).rows;
  const orphans = inUse.filter((r) => !registry.get(r.type, r.workflow_version));
  add(
    'database',
    'workflow versions',
    orphans.length ? 'fail' : 'ok',
    orphans.length
      ? `active tasks use unregistered workflows: ${orphans.map((r) => `${r.type}@${r.workflow_version} (${r.n})`).join(', ')}`
      : `${inUse.reduce((n, r) => n + r.n, 0)} active task(s), all versions registered`,
    orphans.length
      ? 'register the old version again until those tasks finish, or cancel them (issue #196)'
      : undefined,
  );

  // Engine health: work that is due but nobody processes.
  const twoMin = new Date(now.getTime() - 2 * 60_000);
  const stale = (
    await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks WHERE wake_at < $1`, [twoMin])
  ).rows[0]!.n;
  add(
    'engine',
    'orchestrator',
    stale ? 'warn' : 'ok',
    stale ? `${stale} task(s) waiting > 2 min for an orchestrator cycle` : 'no overdue wake-ups',
    stale ? 'is the orchestrator running?' : undefined,
  );
  const leases = (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM attempts WHERE status = 'RUNNING' AND lease_expires_at < $1`,
      [twoMin],
    )
  ).rows[0]!.n;
  add(
    'engine',
    'reaper',
    leases ? 'warn' : 'ok',
    leases ? `${leases} lease(s) expired > 2 min ago and not reaped` : 'no overdue leases',
    leases ? 'is the orchestrator running?' : undefined,
  );
  const timers = (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM timers WHERE status = 'SCHEDULED' AND fire_at < $1`,
      [twoMin],
    )
  ).rows[0]!.n;
  add(
    'engine',
    'timers',
    timers ? 'warn' : 'ok',
    timers ? `${timers} timer(s) overdue > 2 min` : 'no overdue timers',
    timers ? 'is the orchestrator running?' : undefined,
  );
  const blocked = (
    await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks WHERE status = 'BLOCKED'`)
  ).rows[0]!.n;
  add(
    'engine',
    'blocked tasks',
    blocked ? 'warn' : 'ok',
    blocked ? `${blocked} task(s) need an operator decision` : 'none',
    blocked ? 'npm run cli -- task list --status BLOCKED, then task resolve' : undefined,
  );
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
  const longWaits = (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM steps s JOIN tasks t ON t.id = s.task_id
       WHERE t.type = 'agent-run' AND s.key = 'review' AND s.status = 'WAITING' AND s.updated_at < $1`,
      [weekAgo],
    )
  ).rows[0]!.n;
  add(
    'engine',
    'long reviews',
    longWaits ? 'warn' : 'ok',
    longWaits ? `${longWaits} agent-run(s) waiting for review > 7 days` : 'none older than 7 days',
    longWaits ? 'review or close those PRs (issue #195)' : undefined,
  );
}

/** gh / az: installed and logged in (once, not per repo). */
async function checkTrackerClis(
  config: AgentRunnerConfig,
  probe: Probe,
  env: NodeJS.ProcessEnv,
  add: (g: string, n: string, s: Status, d: string, f?: string) => void,
) {
  if (config.repos.some((r) => r.tracker === 'github' || r.host === 'github')) {
    const gh = env.GH_BIN ?? 'gh';
    await checkCli('github', 'gh', gh, probe, add);
    const auth = await probe(gh, ['auth', 'status']);
    const who = /Logged in to (\S+) account (\S+)/.exec(`${auth.stdout}\n${auth.stderr}`);
    if (auth.code === 0) add('github', 'gh auth', 'ok', who ? `${who[2]} on ${who[1]}` : 'logged in');
    else add('github', 'gh auth', 'fail', first(auth.stderr) || 'not logged in', 'gh auth login');
  }
  if (config.repos.some((r) => r.tracker === 'azure-boards' || r.host === 'ado')) {
    const az = env.AZ_BIN ?? 'az';
    await checkCli('azure', 'az', az, probe, add);
    const ext = await probe(az, ['extension', 'show', '--name', 'azure-devops', '--output', 'json']);
    if (ext.code === 0) add('azure', 'azure-devops extension', 'ok', 'installed');
    else
      add('azure', 'azure-devops extension', 'fail', 'not installed', 'az extension add --name azure-devops');
  }
}

/** A CommandRunner (throws on failure) on top of a Probe, for the real adapters. */
const runnerFrom = (probe: Probe) => async (bin: string, args: string[]) => {
  const r = await probe(bin, args);
  if (r.code !== 0)
    throw new Error(`${bin} ${args.slice(0, 3).join(' ')} failed: ${r.stderr || `exit ${r.code}`}`);
  return r.stdout;
};

async function checkRepo(
  repo: RepoConfig,
  probe: Probe,
  env: NodeJS.ProcessEnv,
  add: (g: string, n: string, s: Status, d: string, f?: string) => void,
) {
  const g = `repo ${repo.name}`;

  // Checkout
  if (!existsSync(repo.path)) {
    add(
      g,
      'checkout',
      'fail',
      `${repo.path} does not exist`,
      repo.host === 'github' ? `gh repo clone ${repo.name} ${repo.path}` : 'clone the repository there',
    );
  } else {
    const branch = await probe('git', ['-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch.code !== 0) {
      add(g, 'checkout', 'fail', `${repo.path} is not a git checkout`);
    } else {
      const status = await probe('git', ['-C', repo.path, 'status', '--porcelain']);
      const dirty = status.stdout.trim();
      const b = branch.stdout.trim();
      if (dirty)
        add(
          g,
          'checkout',
          'fail',
          `${repo.path} has uncommitted changes (the next run will refuse)`,
          `cd ${repo.path} && git status`,
        );
      else if (b !== repo.defaultBranch)
        add(g, 'checkout', 'warn', `clean, on "${b}" (the worker switches back to ${repo.defaultBranch})`);
      else add(g, 'checkout', 'ok', `${repo.path} clean on ${b}`);
      if (repo.host === 'github') {
        const origin = (await probe('git', ['-C', repo.path, 'remote', 'get-url', 'origin'])).stdout.trim();
        const match = origin
          .replace(/\.git$/, '')
          .toLowerCase()
          .endsWith(repo.name.toLowerCase());
        add(
          g,
          'origin',
          match ? 'ok' : 'warn',
          origin || '(no origin)',
          match ? undefined : `the checkout's origin is not ${repo.name}`,
        );
      }
    }
  }

  // Agent CLI
  const cli = safe(() => resolveAgentCli(repo.agent));
  if (!cli) add(g, 'agent CLI', 'fail', `unknown agent "${repo.agent}"`);
  else await checkCli(g, `agent CLI (${cli.name})`, cli.bin, probe, add);

  // Tracker / host CLIs and access
  const gh = env.GH_BIN ?? 'gh';
  if (repo.tracker === 'github' || repo.host === 'github') {
    const view = await probe(gh, ['repo', 'view', repo.name, '--json', 'name']);
    add(
      g,
      'repo access',
      view.code === 0 ? 'ok' : 'fail',
      view.code === 0 ? 'readable with gh' : first(view.stderr) || 'no access',
      view.code === 0 ? undefined : 'check gh auth and the repo name',
    );
    if (repo.tracker === 'github' && view.code === 0) {
      const labels = await probe(gh, [
        'label',
        'list',
        '--repo',
        repo.name,
        '--limit',
        '200',
        '--json',
        'name',
      ]);
      const have = new Set(
        safe(() => (JSON.parse(labels.stdout) as Array<{ name: string }>).map((l) => l.name)) ?? [],
      );
      const missing = Object.values(LABELS).filter((l) => !have.has(l));
      add(
        g,
        'labels',
        missing.length ? 'warn' : 'ok',
        missing.length
          ? `missing: ${missing.join(', ')}`
          : `all ${Object.keys(LABELS).length} tpm:agent:* labels exist`,
        missing.length ? 'npm run agent-runner -- labels' : undefined,
      );
    }
  }
  if (repo.tracker === 'azure-boards' || repo.host === 'ado') {
    const az = env.AZ_BIN ?? 'az';
    if (repo.ado) {
      const proj = await probe(az, [
        'devops',
        'project',
        'show',
        '--project',
        repo.ado.project,
        '--org',
        `https://dev.azure.com/${repo.ado.organization}`,
        '--output',
        'json',
      ]);
      add(
        g,
        'ado access',
        proj.code === 0 ? 'ok' : 'fail',
        proj.code === 0 ? `project ${repo.ado.project} readable` : first(proj.stderr) || 'no access',
        proj.code === 0 ? undefined : 'az login, or set AZURE_DEVOPS_EXT_PAT',
      );
    }
  }

  // Software factory
  if (repo.factory) {
    if (repo.host !== 'github') {
      add(g, 'factory', 'fail', 'the factory supports GitHub PR hosts only');
      return;
    }
    let text: string | null | undefined; // undefined = could not read
    try {
      text = await new GitHubPrHost(runnerFrom(probe), env.GH_BIN ?? 'gh').factory.readPolicy(
        repo,
        POLICY_PATH,
      );
    } catch (e) {
      add(g, 'policy', 'fail', `cannot read ${POLICY_PATH}: ${first((e as Error).message)}`);
    }
    if (text === null) {
      add(
        g,
        'policy',
        'warn',
        `no ${POLICY_PATH} on ${repo.defaultBranch}: reviews run, but a human merges everything`,
      );
    } else if (text !== undefined) {
      try {
        const policy = parsePolicy(text);
        const auto = policy.rules.filter((r) => r.level === 'auto-merge').flatMap((r) => r.paths);
        add(
          g,
          'policy',
          'ok',
          `${policy.rules.length} rule(s); auto-merge: ${auto.join(', ') || 'none'}; reviewers: ${policy.reviewers.map((r) => r.name).join(', ') || 'none'}`,
        );
        for (const r of policy.reviewers) {
          const rc = safe(() => resolveReviewerCli(r.name));
          if (rc) await checkCli(g, `reviewer (${r.name})`, rc.bin, probe, add);
        }
        if (policy.rules.some((r) => r.verify) && !policy.verify)
          add(g, 'verify', 'fail', 'rules need verify but the policy has no verify.command');
      } catch (e) {
        add(
          g,
          'policy',
          'fail',
          `invalid ${POLICY_PATH}: ${(e as Error).message.slice(0, 300)}`,
          'fix the policy in a PR (a human must merge it)',
        );
      }
    }
    const reviewPath = repo.reviewPath ?? `${repo.path}.review`;
    const parent = dirname(reviewPath);
    add(
      g,
      'review clone',
      existsSync(reviewPath) || existsSync(parent) ? 'ok' : 'fail',
      existsSync(reviewPath) ? reviewPath : `${reviewPath} (created on first review)`,
      existsSync(parent) ? undefined : `mkdir -p ${parent}`,
    );
  }
}

async function checkCli(
  group: string,
  name: string,
  bin: string,
  probe: Probe,
  add: (g: string, n: string, s: Status, d: string, f?: string) => void,
) {
  const r = await probe(bin, ['--version']);
  add(
    group,
    name,
    r.code === 0 ? 'ok' : 'fail',
    r.code === 0 ? `${bin}: ${first(r.stdout || r.stderr)}` : `${bin} not found or not working`,
    r.code === 0 ? undefined : `install ${name}, or set its *_BIN variable`,
  );
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

const ICON: Record<Status, string> = { ok: '✔', warn: '⚠', fail: '✘', skip: '–' };

export function formatReport(results: CheckResult[]): string {
  const lines: string[] = [];
  let group = '';
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      lines.push('', group);
    }
    lines.push(`  ${ICON[r.status]} ${r.name.padEnd(22)} ${r.detail}`);
    if (r.fix && r.status !== 'ok') lines.push(`    → ${r.fix}`);
  }
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  lines.push('', `${count('ok')} ok, ${count('warn')} warning(s), ${count('fail')} failure(s)`);
  return lines.join('\n');
}

export const defaultDataDir = () => resolve('data');
