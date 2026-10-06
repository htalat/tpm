import { defineWorkflow, map, step } from '@durable/core';
import { describe, expect, it } from 'vitest';
import { useHarness } from '../support/harness';

// One agent per checkout: the key is the repo path from the step's input.
const perRepo = defineWorkflow({
  name: 'test-per-repo',
  steps: {
    work: step({
      executor: 'op',
      input: (ctx) => ctx.input,
      concurrencyGroup: { key: (input) => `repo:${(input as { repo: string }).repo}`, limit: 1 },
      retry: { maxAttempts: 3, initialDelayMs: 100, jitter: 0 },
    }),
  },
});
const fanned = defineWorkflow({
  name: 'test-fanned-groups',
  steps: {
    items: map({
      items: () => Array.from({ length: 12 }, (_, i) => ({ repo: `r${i % 3}`, i })),
      executor: 'op',
      concurrency: 12,
      concurrencyGroup: { key: (input) => (input as { repo: string }).repo, limit: 2 },
    }),
  },
});
const limited = defineWorkflow({
  name: 'test-uncharged',
  steps: { s: step({ executor: 'op', retry: { maxAttempts: 2, initialDelayMs: 100, jitter: 0 } }) },
});

describe('concurrency groups', () => {
  const h = useHarness([perRepo, fanned, limited]);

  it('allows one running step per key across tasks, and frees the slot on completion', async () => {
    const a = await h.engine.createTask({ type: 'test-per-repo', input: { repo: 'x' } });
    const b = await h.engine.createTask({ type: 'test-per-repo', input: { repo: 'x' } });
    const c = await h.engine.createTask({ type: 'test-per-repo', input: { repo: 'y' } });
    await h.engine.runUntilIdle();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    const first = await h.engine.claim({ workerId, capabilities: ['op'], maxItems: 10 });
    expect(first.some((i) => i.taskId === c.task.id)).toBe(true);
    expect(first.filter((i) => i.taskId === a.task.id || i.taskId === b.task.id)).toHaveLength(1);
    expect(first).toHaveLength(2); // one for x, one for y
    expect(await h.engine.claim({ workerId, capabilities: ['op'], maxItems: 10 })).toEqual([]);
    const x = first.find((i) => i.taskId !== c.task.id)!;
    await h.engine.complete(x.attemptId, { leaseToken: x.leaseToken, output: 1 });
    const second = await h.engine.claim({ workerId, capabilities: ['op'], maxItems: 10 });
    expect(second).toHaveLength(1);
    expect([a.task.id, b.task.id]).toContain(second[0]!.taskId);
  });

  it('concurrent claimers never exceed the limit', async () => {
    await h.engine.createTask({ type: 'test-fanned-groups', input: null });
    await h.engine.runUntilIdle();
    const workers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => h.engine.registerWorker(`w${i}`, ['op'])),
    );
    const running = async () =>
      (
        await h.pool.query(
          `SELECT concurrency_key, count(*)::int AS n FROM steps WHERE status = 'RUNNING' GROUP BY concurrency_key ORDER BY 1`,
        )
      ).rows;
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        workers.map((w) => h.engine.claim({ workerId: w.workerId, capabilities: ['op'], maxItems: 5 })),
      );
      // A busy key is skipped, never over-filled.
      for (const r of await running()) expect(r.n).toBeLessThanOrEqual(2);
    }
    expect(await running()).toEqual([
      { concurrency_key: 'r0', n: 2 },
      { concurrency_key: 'r1', n: 2 },
      { concurrency_key: 'r2', n: 2 },
    ]);
  });

  it('a reaped lease frees the slot', async () => {
    await h.engine.createTask({ type: 'test-per-repo', input: { repo: 'x' } });
    await h.engine.createTask({ type: 'test-per-repo', input: { repo: 'x' } });
    await h.engine.runUntilIdle();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    expect(await h.engine.claim({ workerId, capabilities: ['op'], maxItems: 10 })).toHaveLength(1);
    h.clock.advance(10_001);
    await h.engine.reapExpiredLeases();
    const next = await h.engine.claim({ workerId, capabilities: ['op'], maxItems: 10 });
    expect(next).toHaveLength(1);
    expect(next[0]!.attemptNumber).toBe(1); // the other task's step, not the retry (still in backoff)
  });

  it('uncharged failures do not use up maxAttempts (bounded)', async () => {
    const { task } = await h.engine.createTask({ type: 'test-uncharged', input: null });
    await h.engine.runUntilIdle();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    for (let i = 0; i < 4; i++) {
      const [item] = await h.engine.claim({ workerId, capabilities: ['op'] });
      await h.engine.fail(item!.attemptId, {
        leaseToken: item!.leaseToken,
        error: { category: 'TRANSIENT', message: 'usage limit' },
        retryAfterMs: 1000,
        chargeAttempt: false,
      });
      h.clock.advance(1000);
      await h.engine.promoteDueRetries();
    }
    let s = (
      await h.pool.query(`SELECT status, attempt_count, uncharged_attempts FROM steps WHERE task_id = $1`, [
        task.id,
      ])
    ).rows[0];
    expect(s).toEqual({ status: 'READY', attempt_count: 4, uncharged_attempts: 4 });
    // Charged failures still exhaust the policy: maxAttempts = 2 charged attempts.
    for (let i = 0; i < 2; i++) {
      const [item] = await h.engine.claim({ workerId, capabilities: ['op'] });
      await h.engine.fail(item!.attemptId, {
        leaseToken: item!.leaseToken,
        error: { category: 'TRANSIENT', message: 'boom' },
      });
      h.clock.advance(10_000);
      await h.engine.promoteDueRetries();
    }
    s = (await h.pool.query(`SELECT status, attempt_count FROM steps WHERE task_id = $1`, [task.id])).rows[0];
    expect(s).toEqual({ status: 'FAILED', attempt_count: 6 });
  });
});
