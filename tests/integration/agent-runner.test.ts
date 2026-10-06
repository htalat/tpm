import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  agentRunWorkflow,
  AgentRunnerConfigSchema,
  createAgentRunnerHandlers,
  LABELS,
  pollPullRequestsOnce,
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

describe('agent-runner: tracker -> rounds of agent work -> PR outcome', () => {
  const h = useHarness([agentRunWorkflow]);
  let dir: string;
  let source: FakeSource;
  let config: AgentRunnerConfig;
  let callsFile: string;
  let promptsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-runner-'));
    gitRepo(join(dir, 'repo'));
    callsFile = join(dir, 'calls.log');
    promptsFile = join(dir, 'prompts.log');
    process.env.FAKE_PR_DIR = join(dir, 'prs');
    process.env.FAKE_AGENT_CALLS = callsFile;
    process.env.FAKE_AGENT_PROMPTS = promptsFile;
    process.env.FAKE_AGENT_MODE = 'pr';
    source = new FakeSource(join(dir, 'prs'));
    config = AgentRunnerConfigSchema.parse({
      runsDir: join(dir, 'runs'),
      repos: [{ name: REPO, path: join(dir, 'repo'), agent: 'fake', timeBoundMinutes: 1, maxRounds: 3 }],
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const worker = (crashAt?: Record<string, number>) =>
    h.worker(createAgentRunnerHandlers({ source, config, agents: { fake: fakeCli }, killGraceMs: 500 }), {
      crashAt,
    });
  const calls = () =>
    existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  const prompts = () =>
    existsSync(promptsFile) ? readFileSync(promptsFile, 'utf8').split('\n=====\n').filter(Boolean) : [];
  const stepStatus = async (taskId: string, key: string) =>
    (await h.pool.query(`SELECT status FROM steps WHERE task_id = $1 AND key = $2`, [taskId, key])).rows[0]
      ?.status;
  const agentAttempts = async (taskId: string) =>
    (
      await h.pool.query(
        `SELECT a.status, a.error_type FROM attempts a JOIN steps s ON s.id = a.step_id
         WHERE s.task_id = $1 AND s.key = 'agent' ORDER BY a.attempt_number`,
        [taskId],
      )
    ).rows;

  /** Sync one new round for the item and drive it until it waits for review (or ends). */
  async function runRound(opts: { advanceMs?: number } = {}) {
    const { created } = await syncOnce(h.engine, source, config);
    expect(created).toHaveLength(1);
    const t = await h.drive(created[0]!, [worker()], { advanceMs: opts.advanceMs });
    return { taskId: created[0]!, task: t };
  }
  /** One watcher pass + drive to the end. */
  async function settle(taskId: string) {
    await pollPullRequestsOnce(h.engine, source);
    return h.drive(taskId, [worker()]);
  }

  it('round 1: issue -> PR -> waits for review -> merged -> done', async () => {
    const ref = source.add(REPO, 12);
    const { taskId, task } = await runRound();
    expect(task.status).toBe('WAITING');
    expect(await stepStatus(taskId, 'review')).toBe('WAITING');
    expect(source.item(ref).labels).toEqual([LABELS.review]);
    // Nothing actionable yet: the watcher signals nothing.
    expect(await pollPullRequestsOnce(h.engine, source)).toMatchObject({ checked: 1, signalled: 0 });
    // Not ready: no second run.
    expect((await syncOnce(h.engine, source, config)).created).toEqual([]);

    source.patchPr(ref, { state: 'MERGED' });
    const done = await settle(taskId);
    expect(done.status).toBe('COMPLETED');
    expect(done.output).toMatchObject({ outcome: { kind: 'merged' }, next: { decision: 'done' } });
    expect(source.item(ref).labels).toEqual([LABELS.done]);
    expect(source.item(ref).comments.at(-1)).toContain('merged');
    expect(calls()).toHaveLength(1);
  });

  it('CI failure starts round 2 with the feedback in the prompt; the new push completes it', async () => {
    const ref = source.add(REPO, 20);
    const r1 = await runRound();
    const headAfterRound1 = source.pr(ref).headSha;
    source.patchPr(ref, {
      checks: [{ name: 'unit-tests', conclusion: 'FAILURE' }],
      feedback: 'Please also handle the empty case.',
    });
    const t1 = await settle(r1.taskId);
    expect(t1.status).toBe('COMPLETED');
    expect(t1.output).toMatchObject({ outcome: { kind: 'needs-agent' }, next: { decision: 'next-round' } });
    expect(source.item(ref).labels).toEqual([LABELS.ready]);

    const r2 = await runRound();
    expect(r2.task.status).toBe('WAITING');
    expect((await h.task(r2.taskId)).input).toMatchObject({ round: 2 });
    const baseline = (
      await h.pool.query(`SELECT output FROM steps WHERE task_id = $1 AND key = 'prepare'`, [r2.taskId])
    ).rows[0].output;
    expect(baseline.pr.headSha).toBe(headAfterRound1);
    const p2 = prompts().at(-1)!;
    expect(p2).toContain('Failed checks: unit-tests');
    expect(p2).toContain('Please also handle the empty case.');
    expect(p2).toContain('A round without new commits counts as failed');
    expect(source.pr(ref).headSha).not.toBe(headAfterRound1);
    expect(source.item(ref).labels).toEqual([LABELS.review]);
    expect(calls()).toHaveLength(2);
  });

  it('round 2 without new commits fails and goes to a human', async () => {
    const ref = source.add(REPO, 21);
    const r1 = await runRound();
    source.patchPr(ref, { mergeStateStatus: 'DIRTY' });
    await settle(r1.taskId);
    process.env.FAKE_AGENT_MODE = 'noop';
    const r2 = await runRound({ advanceMs: 60_000 });
    expect(r2.task.status).toBe('FAILED');
    expect(r2.task.error).toMatchObject({ stepKey: 'agent' });
    expect(calls()).toHaveLength(4); // 1 + 3 attempts
    expect(source.item(ref).labels).toEqual([LABELS.failed]);
    expect(source.item(ref).comments.at(-1)).toMatch(/no new commits on .* since the round started/);
  });

  it('crash right after the round-2 push: reconcile compares against the stored baseline, agent runs once', async () => {
    const ref = source.add(REPO, 22);
    const r1 = await runRound();
    source.patchPr(ref, { checks: [{ name: 'lint', conclusion: 'FAILURE' }] });
    await settle(r1.taskId);

    const { created } = await syncOnce(h.engine, source, config);
    const taskId = created[0]!;
    await h.engine.runUntilIdle();
    await worker().pollOnce(); // start
    await h.engine.runUntilIdle();
    await worker().pollOnce(); // prepare (baseline = round-1 head)
    await h.engine.runUntilIdle();
    expect(await worker({ AFTER_SIDE_EFFECT: 1 }).pollOnce()).toEqual(['crashed']);
    expect(calls()).toHaveLength(2);
    h.clock.advance(10_001);
    const t = await h.drive(taskId, [worker()], { advanceMs: 60_000 });
    expect(t.status).toBe('WAITING'); // in review again
    expect(calls()).toHaveLength(2); // no third agent run
    expect(await agentAttempts(taskId)).toEqual([
      { status: 'EXPIRED', error_type: 'AMBIGUOUS' },
      { status: 'COMPLETED', error_type: null },
    ]);
    const out = (
      await h.pool.query(`SELECT output FROM steps WHERE task_id = $1 AND key = 'agent'`, [taskId])
    ).rows[0].output;
    expect(out).toMatchObject({ reconciled: true, headSha: source.pr(ref).headSha });
  });

  it('polling the same PR state many times signals once; a new push makes a new event', async () => {
    const ref = source.add(REPO, 23);
    const r1 = await runRound();
    source.patchPr(ref, { mergeStateStatus: 'BEHIND' });
    const passes = await Promise.all([1, 2, 3].map(() => pollPullRequestsOnce(h.engine, source)));
    expect(passes.reduce((n, p) => n + p.signalled, 0)).toBe(1);
    const events = await h.pool.query(
      `SELECT deduplication_key FROM events WHERE task_id = $1 AND event_type = 'pr.outcome'`,
      [r1.taskId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].deduplication_key).toBe(
      `${source.pr(ref).url}:needs-agent:${source.pr(ref).headSha}`,
    );
    const t = await h.drive(r1.taskId, [worker()]);
    expect(t.status).toBe('COMPLETED');
    // After completion nothing is watched any more.
    expect(await pollPullRequestsOnce(h.engine, source)).toMatchObject({ checked: 0 });
  });

  it('stops after maxRounds and hands the item to a human', async () => {
    config.repos[0]!.maxRounds = 2;
    const ref = source.add(REPO, 24);
    for (let round = 1; round <= 2; round++) {
      const r = await runRound();
      source.patchPr(ref, { checks: [{ name: 'e2e', conclusion: 'FAILURE' }] });
      const t = await settle(r.taskId);
      expect(t.output).toMatchObject({ next: { decision: round < 2 ? 'next-round' : 'human' } });
    }
    expect(source.item(ref).labels).toEqual([LABELS.review]);
    expect(source.item(ref).comments.at(-1)).toContain('already used 2 round(s)');
    expect((await syncOnce(h.engine, source, config)).created).toEqual([]);
  });

  it('changes requested -> stays in review for a human; closed PR -> failed', async () => {
    const a = source.add(REPO, 25);
    const ra = await runRound();
    source.patchPr(a, { reviewDecision: 'CHANGES_REQUESTED' });
    expect((await settle(ra.taskId)).output).toMatchObject({ next: { decision: 'human' } });
    expect(source.item(a).labels).toEqual([LABELS.review]);

    const b = source.add(REPO, 26);
    const rb = await runRound();
    source.patchPr(b, { state: 'CLOSED' });
    expect((await settle(rb.taskId)).output).toMatchObject({ next: { decision: 'failed' } });
    expect(source.item(b).labels).toEqual([LABELS.failed]);
  });

  it('the review wait survives a restart: a new engine instance resumes on the signal', async () => {
    const ref = source.add(REPO, 27);
    const r = await runRound();
    // "Restart": only PostgreSQL and the tracker survive.
    const engine2 = h.newEngine();
    source.patchPr(ref, { state: 'MERGED' });
    expect(await pollPullRequestsOnce(engine2, source)).toMatchObject({ signalled: 1 });
    await engine2.runUntilIdle();
    await worker().pollOnce();
    await engine2.runUntilIdle();
    expect((await h.task(r.taskId)).status).toBe('COMPLETED');
  });

  it('runs at most one agent per repository at a time', async () => {
    source.add(REPO, 1);
    source.add(REPO, 2);
    await syncOnce(h.engine, source, config);
    const w = worker();
    for (let i = 0; i < 2; i++) {
      await h.engine.runUntilIdle();
      await w.pollOnce(); // start, then prepare, for both items
    }
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

  it('round 1 without a PR exhausts retries; compensation marks the issue failed', async () => {
    process.env.FAKE_AGENT_MODE = 'noop';
    const ref = source.add(REPO, 3);
    const r = await runRound({ advanceMs: 60_000 });
    expect(r.task.status).toBe('FAILED');
    expect(r.task.compensation_status).toBe('COMPLETED');
    expect(calls()).toHaveLength(3);
    expect(source.item(ref).labels).toEqual([LABELS.failed]);
    expect(source.item(ref).comments.at(-1)).toMatch(/Agent run failed[\s\S]*no pull request/);
  });

  it('a provider usage limit is retried later without using up an attempt', async () => {
    process.env.FAKE_AGENT_MODE = 'ratelimit';
    source.add(REPO, 4);
    const [taskId] = (await syncOnce(h.engine, source, config)).created;
    for (let i = 0; i < 2; i++) {
      await h.engine.runUntilIdle();
      await worker().pollOnce(); // start, prepare
    }
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
    expect(s.available_at.getTime() - h.clock.now().getTime()).toBeGreaterThan(5 * 3600_000);
    process.env.FAKE_AGENT_MODE = 'pr';
    h.clock.advance(6 * 3600_000);
    expect((await h.drive(taskId!, [worker()])).status).toBe('WAITING');
  });

  it('refuses to start on a dirty checkout and tells the human', async () => {
    writeFileSync(join(dir, 'repo', 'README.md'), 'local edit\n');
    const ref = source.add(REPO, 5);
    const r = await runRound();
    expect(r.task.status).toBe('FAILED');
    expect(r.task.error).toMatchObject({ stepKey: 'agent', category: 'POLICY' });
    expect(calls()).toHaveLength(0);
    expect(source.item(ref).labels).toEqual([LABELS.failed]);
    expect(source.item(ref).comments.at(-1)).toContain('uncommitted changes');
  });

  it('kills an agent that exceeds its time bound', async () => {
    process.env.FAKE_AGENT_MODE = 'slow';
    config.repos[0]!.timeBoundMinutes = 0.02; // 1.2 s
    source.add(REPO, 6);
    const [taskId] = (await syncOnce(h.engine, source, config)).created;
    for (let i = 0; i < 2; i++) {
      await h.engine.runUntilIdle();
      await worker().pollOnce(); // start, prepare
    }
    await h.engine.runUntilIdle();
    const t0 = Date.now();
    expect(await worker().pollOnce()).toEqual(['failed']);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await agentAttempts(taskId!))[0]).toMatchObject({ error_type: 'TIMEOUT' });
  });

  it('trial regression: a limit-looking status event in a successful run does not hide the PR', async () => {
    // Real claude output contains "overageDisabledReason":"out_of_credits" on successful runs,
    // and the process may still exit non-zero with limit text after the PR was opened.
    process.env.FAKE_AGENT_RESULT_ERROR = '1';
    try {
      const ref = source.add(REPO, 30);
      const r = await runRound();
      expect(r.task.status).toBe('WAITING');
      expect(source.item(ref).labels).toEqual([LABELS.review]);
      expect(calls()).toHaveLength(1);
    } finally {
      delete process.env.FAKE_AGENT_RESULT_ERROR;
    }
  });

  it('trial regression: the agent leaves the checkout on its branch; the next round still starts', async () => {
    const ref = source.add(REPO, 31);
    const r1 = await runRound();
    const branch = execFileSync('git', ['-C', join(dir, 'repo'), 'rev-parse', '--abbrev-ref', 'HEAD'])
      .toString()
      .trim();
    expect(branch).toBe('main'); // the worker switched the clean checkout back
    source.patchPr(ref, { checks: [{ name: 'ci', conclusion: 'FAILURE' }] });
    await settle(r1.taskId);
    // Even if something else leaves it on another clean branch, the run resets it.
    execFileSync('git', ['-C', join(dir, 'repo'), 'checkout', '-q', '-b', 'stray']);
    const r2 = await runRound();
    expect(r2.task.status).toBe('WAITING');
    expect(calls()).toHaveLength(2);
  });

  it('trial regression: any retry checks for evidence first and does not run the agent again', async () => {
    source.add(REPO, 32);
    source.failFinds = 0;
    const [taskId] = (await syncOnce(h.engine, source, config)).created;
    for (let i = 0; i < 2; i++) {
      await h.engine.runUntilIdle();
      await worker().pollOnce(); // start, prepare
    }
    await h.engine.runUntilIdle();
    source.failFinds = 1; // the agent pushes, then the PR lookup fails: a TRANSIENT failure, not AMBIGUOUS
    expect(await worker().pollOnce()).toEqual(['failed']);
    expect(calls()).toHaveLength(1);
    const t = await h.drive(taskId!, [worker()], { advanceMs: 60_000 });
    expect(t.status).toBe('WAITING');
    expect(calls()).toHaveLength(1); // the retry found the PR instead of running the agent
    const out = (
      await h.pool.query(`SELECT output FROM steps WHERE task_id = $1 AND key = 'agent'`, [taskId])
    ).rows[0].output;
    expect(out).toMatchObject({ reconciled: true });
  });

  it('concurrent syncers create one run per item', async () => {
    source.add(REPO, 8);
    const results = await Promise.all([1, 2, 3].map(() => syncOnce(h.engine, source, config)));
    expect(results.flatMap((r) => r.created)).toHaveLength(1);
  });
});
