import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createTestPool,
  ProcessSupervisor,
  REPO_ROOT,
  testDatabaseUrl,
  truncateAll,
  waitFor,
} from '@durable/testkit';
import { describe, expect, it } from 'vitest';

/**
 * Real processes: API, orchestrator, agent-runner sync, agent-runner worker.
 * Real GitHubIssuesSource (through a fake `gh` binary) and the real claude
 * argument list (through a fake `claude` binary). The worker is SIGKILLed
 * right after the agent opened its PR.
 */
const API_PORT = 3213;

describe('agent-runner end to end', () => {
  it('issue -> PR survives a worker crash after the side effect, with one agent run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runner-e2e-'));
    const repoDir = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
    writeFileSync(join(repoDir, 'README.md'), '# app\n');
    execFileSync('git', ['-C', repoDir, 'add', '.']);
    execFileSync('git', [
      '-C',
      repoDir,
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '-m',
      'init',
    ]);
    const ghState = join(dir, 'gh.json');
    writeFileSync(
      ghState,
      JSON.stringify({
        issues: {
          'acme/app#42': {
            repo: 'acme/app',
            number: 42,
            title: 'Add a greeting',
            body: 'Print hello.',
            url: 'https://github.example/acme/app/issues/42',
            labels: ['agent:ready'],
            comments: [],
          },
        },
        prs: {},
      }),
    );
    const configFile = join(dir, 'agent-runner.config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        syncIntervalMs: 1000,
        runsDir: join(dir, 'runs'),
        repos: [{ name: 'acme/app', path: repoDir, agent: 'claude' }],
      }),
    );
    const calls = join(dir, 'calls.log');
    const pool = createTestPool(2);
    await truncateAll(pool);
    const sup = new ProcessSupervisor(
      {
        DATABASE_URL: testDatabaseUrl(),
        API_PORT: String(API_PORT),
        API_HOST: '127.0.0.1',
        API_URL: `http://127.0.0.1:${API_PORT}`,
        ORCHESTRATOR_POLL_MS: '100',
        ORCHESTRATOR_METRICS_PORT: '0',
        WORKER_POLL_MS: '100',
        LEASE_MS: '3000',
        LOG_LEVEL: 'warn',
        AGENT_RUNNER_CONFIG: configFile,
        GH_BIN: resolve('tests/support/fake-gh.mjs'),
        CLAUDE_BIN: resolve('tests/support/fake-agent.mjs'),
        FAKE_GH_STATE: ghState,
        FAKE_AGENT_CALLS: calls,
        FAKE_AGENT_MODE: 'pr',
        CRASH_AT: '',
      },
      join(REPO_ROOT, 'data', 'logs', `agent-runner-e2e-${Date.now()}.log`),
    );
    const gh = () => JSON.parse(readFileSync(ghState, 'utf8'));
    const runner = 'apps/agent-runner/src/main.ts';
    const agentAttempts = async () =>
      (
        await pool.query(
          `SELECT a.attempt_number, a.status, a.error_type FROM attempts a JOIN steps s ON s.id = a.step_id
           WHERE s.key = 'agent' ORDER BY a.attempt_number`,
        )
      ).rows;
    try {
      sup.start('api', 'apps/api/src/main.ts');
      sup.start('orchestrator', 'apps/orchestrator/src/main.ts');
      sup.start('sync', runner, {}, ['sync']);
      // This worker kills itself right after the agent opened the PR.
      const crashing = sup.start(
        'worker-1',
        runner,
        { CRASH_AT: 'AFTER_SIDE_EFFECT', WORKER_NAME: 'worker-1' },
        ['worker'],
      );
      await waitFor(async () => crashing.child.exitCode !== null || crashing.child.signalCode !== null, {
        timeoutMs: 60_000,
        message: 'worker crash after side effect',
      });
      expect(gh().prs['acme/app:agent/issue-42']).toBeTruthy();
      expect(gh().issues['acme/app#42'].labels).toEqual(['agent:running']);

      // A fresh worker: the lease expires, the retry reconciles instead of running the agent again.
      sup.start('worker-2', runner, { WORKER_NAME: 'worker-2' }, ['worker']);
      const task = await waitFor(
        async () => {
          const r = (await pool.query(`SELECT status, output FROM tasks WHERE type = 'agent-run'`)).rows[0];
          return r && ['COMPLETED', 'FAILED'].includes(r.status) ? r : undefined;
        },
        { timeoutMs: 120_000, intervalMs: 250, message: 'agent-run to finish' },
      );
      expect(task.status).toBe('COMPLETED');
      expect(task.output).toMatchObject({
        reconciled: true,
        prUrl: 'https://github.example/acme/app/pull/42',
      });
      expect(await agentAttempts()).toEqual([
        { attempt_number: 1, status: 'EXPIRED', error_type: 'AMBIGUOUS' },
        { attempt_number: 2, status: 'COMPLETED', error_type: null },
      ]);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1); // the agent ran once
      const issue = gh().issues['acme/app#42'];
      expect(issue.labels).toEqual(['agent:review']);
      expect(issue.comments).toHaveLength(2);
      expect(issue.comments[1]).toContain('https://github.example/acme/app/pull/42');
      // The item is no longer ready: the sync loop must not start a second run.
      await new Promise((r) => setTimeout(r, 2500));
      expect(
        (await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE type = 'agent-run'`)).rows[0].n,
      ).toBe(1);
    } finally {
      await sup.killAll();
      sup.close();
      await pool.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
