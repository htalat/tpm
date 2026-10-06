import { defineWorkflow, step, WorkerError } from '@durable/core';
import type { WorkerHandler } from '@durable/sdk';
import { describe, expect, it } from 'vitest';
import { useHarness } from '../support/harness';

const permanent = defineWorkflow({ name: 'test-permanent', steps: { p: step({ executor: 'perm' }) } });
const exhaust = defineWorkflow({
  name: 'test-exhaust',
  steps: {
    x: step({
      executor: 'flaky',
      input: () => ({ failUntilAttempt: 99 }),
      retry: { maxAttempts: 3, initialDelayMs: 100, jitter: 0 },
    }),
  },
});
const charge = defineWorkflow({
  name: 'test-charge',
  steps: { charge: step({ executor: 'side-effect', input: () => ({ amountCents: 100 }) }) },
});
const unsafe = defineWorkflow({
  name: 'test-unsafe',
  steps: { email: step({ executor: 'side-effect', effect: 'unsafe' }) },
});
const permHandler: WorkerHandler = {
  execute: async () => {
    throw new WorkerError('PERMANENT', 'bad request');
  },
};

describe('retries, permanent failures and ambiguous outcomes', () => {
  const h = useHarness([permanent, exhaust, charge, unsafe]);

  it('Example C: fails twice, persists backoff, succeeds on attempt 3', async () => {
    const { task } = await h.engine.createTask({ type: 'example-retry', input: null });
    const w = h.worker();
    await h.engine.runUntilIdle();
    expect(await w.pollOnce()).toEqual(['failed']);
    const s1 = (await h.pool.query(`SELECT status, available_at FROM steps WHERE task_id = $1`, [task.id]))
      .rows[0];
    expect(s1.status).toBe('RETRYING');
    const delay1 = s1.available_at.getTime() - h.clock.now().getTime();
    expect(delay1).toBeGreaterThanOrEqual(900);
    expect(delay1).toBeLessThanOrEqual(1000);
    // Not eligible before the persisted time — even with a brand-new engine (restart).
    const restarted = h.newEngine();
    await restarted.tick();
    expect(await w.pollOnce()).toEqual([]);
    h.clock.advance(delay1);
    await restarted.tick();
    expect(await w.pollOnce()).toEqual(['failed']);
    const done = await h.drive(task.id, [w], { advanceMs: 1000 });
    expect(done.status).toBe('COMPLETED');
    expect(done.output).toEqual({ succeededOnAttempt: 3 });
    const attempts = await h.pool.query(
      `SELECT attempt_number, status, error_type FROM attempts WHERE task_id = $1 ORDER BY attempt_number`,
      [task.id],
    );
    expect(attempts.rows).toEqual([
      { attempt_number: 1, status: 'FAILED', error_type: 'TRANSIENT' },
      { attempt_number: 2, status: 'FAILED', error_type: 'TRANSIENT' },
      { attempt_number: 3, status: 'COMPLETED', error_type: null },
    ]);
    const hist = await h.history(task.id);
    expect(hist.filter((e) => e === 'step.retrying:RETRYING')).toHaveLength(2);
  });

  it('retry exhaustion fails the step and the task', async () => {
    const { task } = await h.engine.createTask({ type: 'test-exhaust', input: null });
    const done = await h.drive(task.id, [h.worker()], { advanceMs: 1000 });
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatchObject({ stepKey: 'x', category: 'TRANSIENT' });
    expect((await h.steps(task.id))[0]).toMatchObject({ status: 'FAILED', attempt_count: 3 });
  });

  it('permanent failure is never retried', async () => {
    const { task } = await h.engine.createTask({ type: 'test-permanent', input: null });
    const done = await h.drive(task.id, [h.worker({ perm: permHandler })], { advanceMs: 1000 });
    expect(done.status).toBe('FAILED');
    expect((await h.steps(task.id))[0]).toMatchObject({ status: 'FAILED', attempt_count: 1 });
  });

  it('crash after side effect: ambiguous -> reconciled -> completed, effect applied once', async () => {
    const { task } = await h.engine.createTask({ type: 'test-charge', input: null });
    await h.engine.runUntilIdle();
    const crashing = h.worker(undefined, { crashAt: { AFTER_SIDE_EFFECT: 1 } });
    expect(await crashing.pollOnce()).toEqual(['crashed']);
    // The external effect happened; the engine does not know.
    expect((await h.external.stats()).effects).toBe(1);
    expect((await h.steps(task.id))[0]!.status).toBe('RUNNING');
    h.clock.advance(10_001);
    await h.engine.reapExpiredLeases();
    const a1 = (await h.pool.query(`SELECT status, error_type FROM attempts WHERE attempt_number = 1`))
      .rows[0];
    expect(a1).toEqual({ status: 'EXPIRED', error_type: 'AMBIGUOUS' });
    const done = await h.drive(task.id, [h.worker()], { advanceMs: 1000 });
    expect(done.status).toBe('COMPLETED');
    const out = (await h.steps(task.id))[0]!.output as Record<string, unknown>;
    expect(out.reconciled).toBe(true);
    const stats = await h.external.stats();
    expect(stats.effects).toBe(1);
    expect(stats.duplicateEffects).toBe(0);
  });

  it('crash after side effect without reconcile: re-execution is deduplicated by the idempotency key', async () => {
    const { task } = await h.engine.createTask({ type: 'test-charge', input: null });
    await h.engine.runUntilIdle();
    await h.worker(undefined, { crashAt: { AFTER_SIDE_EFFECT: 1 } }).pollOnce();
    h.clock.advance(10_001);
    const noReconcile = {
      'side-effect': {
        execute: (i: unknown, c: Parameters<WorkerHandler['execute']>[1]) =>
          h.external
            .apply(c.idempotencyKey, 'charge', i)
            .then((r) => ({ ...r.result, deduplicated: !r.applied })),
      },
    };
    const done = await h.drive(task.id, [h.worker(noReconcile)], { advanceMs: 1000 });
    expect(done.status).toBe('COMPLETED');
    expect((await h.steps(task.id))[0]!.output).toMatchObject({ deduplicated: true });
    const stats = await h.external.stats();
    expect(stats).toMatchObject({ effects: 1, calls: 2, duplicateEffects: 0 });
  });

  it('ambiguous outcome on an unsafe step blocks the task for an operator', async () => {
    const { task } = await h.engine.createTask({ type: 'test-unsafe', input: null });
    await h.engine.runUntilIdle();
    await h.worker(undefined, { crashAt: { AFTER_SIDE_EFFECT: 1 } }).pollOnce();
    h.clock.advance(10_001);
    await h.engine.runUntilIdle();
    expect((await h.task(task.id)).status).toBe('BLOCKED');
    expect((await h.steps(task.id))[0]!.status).toBe('BLOCKED');
    // Nothing is claimable while blocked.
    expect(await h.worker().pollOnce()).toEqual([]);
    await h.engine.resolveStep(
      task.id,
      'email',
      'complete',
      { confirmedManually: true },
      'checked provider dashboard',
    );
    await h.engine.runUntilIdle();
    const t = await h.task(task.id);
    expect(t.status).toBe('COMPLETED');
  });

  it('reconciliation that cannot decide reports AMBIGUOUS again', async () => {
    const { task } = await h.engine.createTask({ type: 'test-charge', input: null });
    await h.engine.runUntilIdle();
    const w0 = h.worker(undefined, { crashAt: { AFTER_SIDE_EFFECT: 1 } });
    await w0.pollOnce();
    h.clock.advance(10_001);
    await h.engine.runUntilIdle();
    h.clock.advance(60_000);
    await h.engine.runUntilIdle();
    const unknown: Record<string, WorkerHandler> = {
      'side-effect': {
        execute: async () => ({}),
        reconcile: async () => ({ outcome: 'UNKNOWN', reason: 'provider down' }),
      },
    };
    expect(await h.worker(unknown).pollOnce()).toEqual(['failed']);
    const a2 = (
      await h.pool.query(
        `SELECT error_type, error_message FROM attempts WHERE task_id = $1 AND attempt_number = 2`,
        [task.id],
      )
    ).rows[0];
    expect(a2.error_type).toBe('AMBIGUOUS');
    expect(a2.error_message).toMatch(/provider down/);
  });
});
