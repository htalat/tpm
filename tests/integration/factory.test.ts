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
  REVIEWER_CLIS,
  STATUS,
  syncOnce,
  type AgentCli,
  type AgentRunnerConfig,
} from '@durable/agent-runner';
import { registerAgentRunRoutes } from '@durable/agent-runner';
import { silentLogger } from '@durable/observability';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { FakeSource } from '../support/fake-source';
import { useHarness } from '../support/harness';

const FAKE_AGENT = resolve('tests/support/fake-agent.mjs');
const FAKE_REVIEWER = resolve('tests/support/fake-reviewer.mjs');
const fakeCli: AgentCli = {
  name: 'fake',
  bin: process.execPath,
  buildArgs: (prompt) => [FAKE_AGENT, prompt],
};
const fakeReviewers = {
  claude: {
    ...REVIEWER_CLIS.claude!,
    envVar: undefined,
    bin: process.execPath,
    buildArgs: (p: string) => [FAKE_REVIEWER, 'claude', p],
  },
  copilot: {
    ...REVIEWER_CLIS.copilot!,
    envVar: undefined,
    bin: process.execPath,
    buildArgs: (p: string) => [FAKE_REVIEWER, 'copilot', p],
  },
};
const REPO = 'acme/site';
const POLICY = `
version: 1
rules:
  - paths: ["docs/**"]
    level: auto-merge
  - paths: ["dist/**"]
    level: human-approve
    verify: true
reviewers: [{ name: claude }, { name: copilot }]
approvers: [htalat]
starters: [htalat]
verify:
  command: node -e "process.exit(Number(process.env.FAKE_VERIFY_EXIT || 0))"
maxAutoMergesPerDay: 5
`;

describe('software factory: agents write, agents review, policy merges', () => {
  const h = useHarness([agentRunWorkflow]);
  let dir: string;
  let source: FakeSource;
  let config: AgentRunnerConfig;
  let reviewCalls: string;
  let prompts: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-'));
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README.md'), '# site\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '-m',
      'init',
    ]);
    reviewCalls = join(dir, 'reviews.log');
    prompts = join(dir, 'prompts.log');
    Object.assign(process.env, {
      FAKE_PR_DIR: join(dir, 'prs'),
      FAKE_AGENT_CALLS: join(dir, 'calls.log'),
      FAKE_AGENT_PROMPTS: prompts,
      FAKE_AGENT_MODE: 'pr',
      FAKE_REVIEW_CALLS: reviewCalls,
    });
    for (const k of [
      'FAKE_AGENT_FILE',
      'FAKE_AGENT_LINES',
      'FAKE_REVIEW_CLAUDE',
      'FAKE_REVIEW_COPILOT',
      'FAKE_VERIFY_EXIT',
    ])
      delete process.env[k];
    source = new FakeSource(join(dir, 'prs'));
    source.policyText = POLICY;
    config = AgentRunnerConfigSchema.parse({
      runsDir: join(dir, 'runs'),
      repos: [{ name: REPO, path: repo, agent: 'fake', timeBoundMinutes: 1, maxRounds: 2, factory: true }],
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const worker = () =>
    h.worker(
      createAgentRunnerHandlers({
        sources: () => source,
        config,
        agents: { fake: fakeCli },
        reviewers: fakeReviewers,
        killGraceMs: 500,
      }),
    );
  const reviews = () =>
    existsSync(reviewCalls) ? readFileSync(reviewCalls, 'utf8').trim().split('\n').filter(Boolean) : [];
  const output = async (taskId: string, key: string) =>
    (await h.pool.query(`SELECT output FROM steps WHERE task_id = $1 AND key = $2`, [taskId, key])).rows[0]
      ?.output;

  /** Start a round and drive it through agent, verify and reviews, to the review wait. */
  async function roundToReview() {
    const { created } = await syncOnce(h.engine, () => source, config);
    expect(created).toHaveLength(1);
    const task = await h.drive(created[0]!, [worker()]);
    expect(task.status).toBe('WAITING');
    return { taskId: created[0]!, agent: await output(created[0]!, 'agent') };
  }
  async function decide(taskId: string) {
    await pollPullRequestsOnce(h.engine, () => source, config);
    return h.drive(taskId, [worker()]);
  }

  it('docs-only change: both agents review the exact commit, the factory merges it, no human', async () => {
    const ref = source.add(REPO, 1);
    const { taskId, agent } = await roundToReview();
    expect(await output(taskId, 'verify')).toMatchObject({ skipped: 'no changed file requires verify' });
    // Both reviewers ran in the review clone at the agent's commit.
    expect(reviews()).toEqual([`claude ${agent.headSha} approve`, `copilot ${agent.headSha} approve`]);
    expect(source.statuses.get(agent.headSha)).toMatchObject({
      [STATUS.review('claude')]: { state: 'success' },
      [STATUS.review('copilot')]: { state: 'success' },
    });
    expect(source.prComments.filter((c) => c.body.includes('review of'))).toHaveLength(2);

    const t = await decide(taskId);
    expect(t.status).toBe('COMPLETED');
    expect(t.output).toMatchObject({
      outcome: { kind: 'ready-to-merge', level: 'auto-merge' },
      next: { decision: 'merged', level: 'auto-merge' },
    });
    expect(source.merges).toEqual([{ url: agent.prUrl, sha: agent.headSha }]);
    expect(source.item(ref).labels).toEqual([LABELS.done]);
  });

  it('dist change: verify runs first, then reviews, then waits for an approver, then merges', async () => {
    process.env.FAKE_AGENT_FILE = 'dist/index-{n}.html';
    source.add(REPO, 2);
    const { taskId, agent } = await roundToReview();
    expect(await output(taskId, 'verify')).toMatchObject({ passed: true });
    expect(source.statuses.get(agent.headSha)![STATUS.verify]).toMatchObject({ state: 'success' });

    // Reviews passed, but the policy wants a human approval: nothing happens yet.
    expect(await pollPullRequestsOnce(h.engine, () => source, config)).toMatchObject({
      checked: 1,
      signalled: 0,
    });
    // An approval by someone who is not an approver does not count.
    source.approvalEvents.push({ actor: 'mallory', at: new Date().toISOString() });
    expect(await pollPullRequestsOnce(h.engine, () => source, config)).toMatchObject({ signalled: 0 });

    source.approvalEvents.push({ actor: 'htalat', at: new Date(Date.now() + 1000).toISOString() });
    const t = await decide(taskId);
    expect(t.output).toMatchObject({
      next: { decision: 'merged', level: 'human-approve', approvedBy: 'htalat' },
    });
    expect(source.statuses.get(agent.headSha)![STATUS.approval]).toMatchObject({
      state: 'success',
      description: 'approved by htalat',
    });
    expect(source.merges).toHaveLength(1);
  });

  it('failed verify: no reviews are spent, the agent gets the failure as feedback', async () => {
    process.env.FAKE_AGENT_FILE = 'dist/page-{n}.html';
    process.env.FAKE_VERIFY_EXIT = '1';
    const ref = source.add(REPO, 3);
    const { taskId } = await roundToReview();
    expect(await output(taskId, 'reviewA')).toMatchObject({ skipped: 'verify did not pass' });
    expect(reviews()).toEqual([]);
    const t = await decide(taskId);
    expect(t.output).toMatchObject({ outcome: { kind: 'needs-agent' }, next: { decision: 'next-round' } });
    expect(source.item(ref).labels).toEqual([LABELS.ready]);
  });

  it('a reviewer asks for changes: the second review is skipped, round 2 fixes it, then it merges', async () => {
    process.env.FAKE_REVIEW_CLAUDE = 'request-changes';
    const ref = source.add(REPO, 4);
    const r1 = await roundToReview();
    expect(reviews()).toEqual([`claude ${r1.agent.headSha} request-changes`]); // copilot not called
    expect((await decide(r1.taskId)).output).toMatchObject({ next: { decision: 'next-round' } });

    process.env.FAKE_REVIEW_CLAUDE = 'approve';
    const r2 = await roundToReview();
    // The reviewer's finding reached the author agent.
    expect(readFileSync(prompts, 'utf8')).toContain('claude: please fix the wording');
    expect(r2.agent.headSha).not.toBe(r1.agent.headSha);
    const t = await decide(r2.taskId);
    expect(t.output).toMatchObject({ next: { decision: 'merged' } });
    expect(source.merges).toEqual([{ url: r2.agent.prUrl, sha: r2.agent.headSha }]);
    expect(source.item(ref).labels).toEqual([LABELS.done]);
  });

  it('unreadable reviewer output is "needs a human", never "approve"', async () => {
    process.env.FAKE_REVIEW_COPILOT = 'garbage';
    const ref = source.add(REPO, 5);
    const { taskId, agent } = await roundToReview();
    expect(source.statuses.get(agent.headSha)![STATUS.review('copilot')]).toMatchObject({ state: 'error' });
    const t = await decide(taskId);
    expect(t.output).toMatchObject({ outcome: { kind: 'needs-human' }, next: { decision: 'human' } });
    expect(source.merges).toEqual([]);
    expect(source.item(ref).labels).toEqual([LABELS.review]);
  });

  it('a push after the reviews blocks the merge (evidence is bound to the commit)', async () => {
    source.add(REPO, 6);
    const { taskId, agent } = await roundToReview();
    source.patchPr(`github:${REPO}#6`, { headSha: 'f'.repeat(40) }); // someone pushed
    const t = await decide(taskId);
    expect(t.output).toMatchObject({ outcome: { kind: 'needs-human' } });
    expect(String((t.output as { outcome: { reason: string } }).outcome.reason)).toContain(
      agent.headSha.slice(0, 7),
    );
    expect(source.merges).toEqual([]);
  });

  it('a push between the decision and the merge: the platform refuses, a human is asked', async () => {
    const ref = source.add(REPO, 7);
    const { taskId } = await roundToReview();
    expect(await pollPullRequestsOnce(h.engine, () => source, config)).toMatchObject({ signalled: 1 }); // ready-to-merge
    source.patchPr(ref, { headSha: 'e'.repeat(40) }); // push races the merge
    const t = await h.drive(taskId, [worker()]);
    expect(t.output).toMatchObject({ next: { decision: 'human' } });
    expect(source.merges).toEqual([]);
    expect(source.item(ref).comments.at(-1)).toContain('Could not merge');
  });

  it('paths outside the policy, and the policy file itself, need a human merge', async () => {
    process.env.FAKE_AGENT_FILE = '.tpm/agent-policy-{n}.yml';
    source.add(REPO, 8);
    const { taskId } = await roundToReview();
    expect((await decide(taskId)).output).toMatchObject({
      outcome: { kind: 'needs-human', level: 'human-merge' },
    });
    expect(source.merges).toEqual([]);
  });

  it('respects the daily auto-merge cap', async () => {
    source.policyText = POLICY.replace('maxAutoMergesPerDay: 5', 'maxAutoMergesPerDay: 1');
    source.add(REPO, 9);
    const a = await roundToReview();
    expect((await decide(a.taskId)).output).toMatchObject({ next: { decision: 'merged' } });
    source.add(REPO, 10);
    const b = await roundToReview();
    expect((await decide(b.taskId)).output).toMatchObject({ outcome: { kind: 'needs-human' } });
    expect(source.merges).toHaveLength(1);
  });

  it('only listed starters can start a run', async () => {
    source.readyLabelActor = 'mallory';
    source.add(REPO, 11);
    const r = await syncOnce(h.engine, () => source, config);
    expect(r).toMatchObject({ created: [], unauthorized: [`github:${REPO}#11`] });
  });

  it('menu bar API: lists runs with "needs you", approves, retries and cancels through the same paths', async () => {
    const app = await buildServer({
      engine: h.engine,
      logger: silentLogger,
      extend: (a, guard) =>
        registerAgentRunRoutes(a, { engine: h.engine, config, sources: () => source, guard }),
    });
    try {
      process.env.FAKE_AGENT_FILE = 'dist/menu-{n}.html';
      const ref = source.add(REPO, 20);
      const { taskId } = await roundToReview();
      await pollPullRequestsOnce(h.engine, () => source, config); // records "waiting for approval"
      let list = (await app.inject({ method: 'GET', url: '/agent-runs' })).json();
      const run = list.runs.find((r: { id: string }) => r.id === taskId);
      expect(run).toMatchObject({
        number: 20,
        status: 'WAITING',
        step: { key: 'review', status: 'WAITING' },
        attention: { kind: 'approve' },
        costUsd: 0.26, // agent 0.25 + claude review 0.01 (copilot reports no cost)
      });
      expect(list.overview).toMatchObject({ active: 1, attention: 1 });

      // Approve from the app = the approve label on the PR; the watcher then merges.
      expect((await app.inject({ method: 'POST', url: `/agent-runs/${taskId}/approve` })).json()).toEqual({
        ok: true,
      });
      await decide(taskId);
      list = (await app.inject({ method: 'GET', url: '/agent-runs' })).json();
      expect(list.runs[0]).toMatchObject({ status: 'COMPLETED', decision: 'merged', attention: null });
      expect((await app.inject({ method: 'POST', url: `/agent-runs/${taskId}/approve` })).statusCode).toBe(
        409,
      );

      // Detail has the durable history.
      const detail = (await app.inject({ method: 'GET', url: `/agent-runs/${taskId}` })).json();
      expect(detail.history.map((e: { event_type: string }) => e.event_type)).toContain('task.completed');

      // Retry puts the item back in the queue; cancel stops an active run and tells the tracker.
      expect((await app.inject({ method: 'POST', url: `/agent-runs/${taskId}/retry` })).json()).toEqual({
        ok: true,
      });
      expect(source.item(ref).labels).toContain(LABELS.ready);
      const { created } = await syncOnce(h.engine, () => source, config);
      expect((await app.inject({ method: 'POST', url: `/agent-runs/${created[0]}/cancel` })).json()).toEqual({
        ok: true,
      });
      expect((await h.task(created[0]!)).status).toBe('CANCELLED');
      expect(source.item(ref).labels).toEqual([LABELS.failed]);
      expect(
        (await app.inject({ method: 'GET', url: '/agent-runs/00000000-0000-4000-8000-000000000000' }))
          .statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('without a policy file the factory still reviews, but a human merges', async () => {
    source.policyText = null;
    source.add(REPO, 12);
    const { taskId } = await roundToReview();
    expect(await output(taskId, 'reviewA')).toMatchObject({ skipped: 'no reviewer in slot 0' });
    expect((await decide(taskId)).output).toMatchObject({ outcome: { kind: 'needs-human' } });
  });
});
