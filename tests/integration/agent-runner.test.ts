import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  agentRunWorkflow,
  AgentRunnerConfigSchema,
  createAgentRunnerHandlers,
  LABELS,
  syncOnce,
  type AgentCli,
  type AgentRunnerConfig,
} from '@durable/agent-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSource } from '../support/fake-source';
import { useHarness } from '../support/harness';

const FAKE_AGENT = resolve('tests/support/fake-agent.mjs');
const fakeCli: AgentCli = {
  name: 'fake',
  bin: process.execPath,
  buildArgs: (prompt) => [FAKE_AGENT, prompt],
};
const REPO = 'acme/app';

function gitRepo(dir: string): void {
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'README.md'), '# app\n');
  g('add', '.');
  g('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
}

describe('agent-runner: tracker -> agent-run -> PR', () => {
  const h = useHarness([agentRunWorkflow]);
  let dir: string;
  let source: FakeSource;
  let config: AgentRunnerConfig;
  let callsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-runner-'));
    gitRepo(join(dir, 'repo'));
    callsFile = join(dir, 'calls.log');
    process.env.FAKE_PR_DIR = join(dir, 'prs');
    process.env.FAKE_AGENT_CALLS = callsFile;
    process.env.FAKE_AGENT_MODE = 'pr';
    source = new FakeSource(join(dir, 'prs'));
    config = AgentRunnerConfigSchema.parse({
      runsDir: join(dir, 'runs'),
      repos: [{ name: REPO, path: join(dir, 'repo'), agent: 'fake', timeBoundMinutes: 1 }],
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const worker = (crashAt?: Record<string, number>) =>
    h.worker(createAgentRunnerHandlers({ source, config, agents: { fake: fakeCli }, killGraceMs: 500 }), {
      crashAt,
    });
  const calls = () =>
    existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  const runsFor = async (ref: string) =>
    (
      await h.pool.query(
        `SELECT id, status FROM tasks WHERE metadata->>'sourceRef' = $1 ORDER BY created_at`,
        [ref],
      )
    ).rows;

  it('happy path: ready issue -> run -> PR -> issue labelled for review', async () => {
    const ref = source.add(REPO, 12);
    const { created } = await syncOnce(h.engine, source, config);
    expect(created).toHaveLength(1);
    const t = await h.drive(created[0]!, [worker()]);
    expect(t.status).toBe('COMPLETED');
    expect(t.output).toMatchObject({ prUrl: 'https://github.example/pr/12', branch: 'agent/issue-12' });
    expect(source.item(ref).labels).toEqual([LABELS.review]);
    expect(source.item(ref).comments).toHaveLength(2);
    expect(source.item(ref).comments[1]).toContain('https://github.example/pr/12');
    expect(calls()).toHaveLength(1);
    const art = await h.pool.query(`SELECT type FROM artifacts WHERE task_id = $1`, [t.id]);
    expect(art.rows).toEqual([{ type: 'agent-log' }]);
    // Not ready any more: a new sync creates nothing.
    expect((await syncOnce(h.engine, source, config)).created).toEqual([]);
  });

  it('worker dies after the agent opened its PR: the retry reconciles, the agent does not run again', async () => {
    source.add(REPO, 7);
    const [taskId] = (await syncOnce(h.engine, source, config)).created;
    await h.engine.runUntilIdle();
    expect(await worker().pollOnce()).toEqual(['completed']); // start
    await h.engine.runUntilIdle();
    expect(await worker({ AFTER_SIDE_EFFECT: 1 }).pollOnce()).toEqual(['crashed']); // agent ran, PR exists
    expect(calls()).toHaveLength(1);
    h.clock.advance(10_001); // lease expires
    const t = await h.drive(taskId!, [worker()], { advanceMs: 60_000 });
    expect(t.status).toBe('COMPLETED');
    expect(t.output).toMatchObject({ reconciled: true, prUrl: 'https://github.example/pr/7' });
    expect(calls()).toHaveLength(1); // still one agent run
    const attempts = await h.pool.query(
      `SELECT a.status, a.error_type FROM attempts a JOIN steps s ON s.id = a.step_id WHERE s.task_id = $1 AND s.key = 'agent' ORDER BY a.attempt_number`,
      [taskId],
    );
    expect(attempts.rows).toEqual([
      { status: 'EXPIRED', error_type: 'AMBIGUOUS' },
      { status: 'COMPLETED', error_type: null },
    ]);
  });

  it('runs at most one agent per repository at a time', async () => {
    source.add(REPO, 1);
    source.add(REPO, 2);
    await syncOnce(h.engine, source, config);
    await h.engine.runUntilIdle();
    const w = worker();
    await w.pollOnce(); // both start steps
    await h.engine.runUntilIdle();
    const [a, b] = await Promise.all([
      h.engine.registerWorker('a', ['agent-cli']),
      h.engine.registerWorker('b', ['agent-cli']),
    ]);
    const claims = await Promise.all([
      h.engine.claim({ workerId: a.workerId, capabilities: ['agent-cli'], maxItems: 2 }),
      h.engine.claim({ workerId: b.workerId, capabilities: ['agent-cli'], maxItems: 2 }),
    ]);
    expect(claims.flat()).toHaveLength(1);
  });

  it('an agent that never opens a PR exhausts its retries; compensation marks the issue failed', async () => {
    process.env.FAKE_AGENT_MODE = 'noop';
    const ref = source.add(REPO, 3);
    const [taskId] = (await syncOnce(h.engine, source, config)).created;
    const t = await h.drive(taskId!, [worker()], { advanceMs: 60_000 });
    expect(t.status).toBe('FAILED');
    expect(t.compensation_status).toBe('COMPLETED');
    expect(calls()).toHaveLength(3); // maxAttempts
    expect(source.item(ref).labels).toEqual([LABELS.failed]);
    expect(source.item(ref).comments.at(-1)).toMatch(/Agent run failed[\s\S]*without a pull request/);
    // A human re-labels the issue: a new round starts.
    source.item(ref).labels = [LABELS.ready];
    process.env.FAKE_AGENT_MODE = 'pr';
    const { created } = await syncOnce(h.engine, source, config);
    expect(created).toHaveLength(1);
    expect((await h.task(created[0]!)).input).toMatchObject({ round: 2 });
    expect((await h.drive(created[0]!, [worker()])).status).toBe('COMPLETED');
  });

  it('a provider usage limit is retried later without using up an attempt', async () => {
    process.env.FAKE_AGENT_MODE = 'ratelimit';
    source.add(REPO, 4);
    const [taskId] = (await syncOnce(h.engine, source, config)).created;
    await h.engine.runUntilIdle();
    await worker().pollOnce(); // start
    await h.engine.runUntilIdle();
    expect(await worker().pollOnce()).toEqual(['failed']);
    const s = (
      await h.pool.query(
        `SELECT status, available_at, uncharged_attempts FROM steps WHERE task_id = $1 AND key = 'agent'`,
        [taskId],
      )
    ).rows[0];
    expect(s.status).toBe('RETRYING');
    expect(s.uncharged_attempts).toBe(1);
    // The reset time in the agent's output (far future) is capped at 6 hours.
    expect(s.available_at.getTime() - h.clock.now().getTime()).toBeGreaterThan(5 * 3600_000);
    process.env.FAKE_AGENT_MODE = 'pr';
    h.clock.advance(6 * 3600_000);
    expect((await h.drive(taskId!, [worker()])).status).toBe('COMPLETED');
  });

  it('refuses to start on a dirty checkout and tells the human', async () => {
    writeFileSync(join(dir, 'repo', 'README.md'), 'local edit\n');
    const ref = source.add(REPO, 5);
    const [taskId] = (await syncOnce(h.engine, source, config)).created;
    const t = await h.drive(taskId!, [worker()]);
    expect(t.status).toBe('FAILED');
    expect(t.error).toMatchObject({ stepKey: 'agent', category: 'POLICY' });
    expect(calls()).toHaveLength(0);
    expect(source.item(ref).labels).toEqual([LABELS.failed]);
    expect(source.item(ref).comments.at(-1)).toContain('uncommitted changes');
  });

  it('kills an agent that exceeds its time bound', async () => {
    process.env.FAKE_AGENT_MODE = 'slow';
    config.repos[0]!.timeBoundMinutes = 0.02; // 1.2 s
    source.add(REPO, 6);
    const [taskId] = (await syncOnce(h.engine, source, config)).created;
    await h.engine.runUntilIdle();
    await worker().pollOnce(); // start
    await h.engine.runUntilIdle();
    const t0 = Date.now();
    expect(await worker().pollOnce()).toEqual(['failed']);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const a = (
      await h.pool.query(
        `SELECT a.error_type FROM attempts a JOIN steps s ON s.id = a.step_id WHERE s.task_id = $1 AND s.key = 'agent'`,
        [taskId],
      )
    ).rows[0];
    expect(a.error_type).toBe('TIMEOUT');
  });

  it('concurrent syncers create one run per item', async () => {
    source.add(REPO, 8);
    const results = await Promise.all([1, 2, 3].map(() => syncOnce(h.engine, source, config)));
    expect(results.flatMap((r) => r.created)).toHaveLength(1);
    expect(await runsFor(`github:${REPO}#8`)).toHaveLength(1);
  });
});
