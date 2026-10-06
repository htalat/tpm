import { ConcurrencyConflictError, SimulatedCrash } from '@durable/core';
import { lockTask, transitionTask } from '@durable/engine';
import { withTransaction } from '@durable/db';
import { describe, expect, it } from 'vitest';
import { useHarness } from '../support/harness';

describe('optimistic concurrency, simultaneous orchestrators, crash points', () => {
  const h = useHarness();

  it('a transition with a stale version fails loudly and changes nothing', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    await withTransaction(h.pool, async (tx) => {
      const t = (await lockTask(tx, task.id))!;
      await transitionTask(tx, { task: t, to: 'READY', now: h.clock.now() });
    });
    await expect(
      withTransaction(h.pool, (tx) =>
        transitionTask(tx, {
          task: { ...task, status: 'PENDING', version: 0 },
          to: 'RUNNING',
          now: h.clock.now(),
        }),
      ),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect((await h.task(task.id)).status).toBe('READY');
  });

  it('many orchestrators running at once produce exactly one set of transitions', async () => {
    const tasks = await Promise.all(
      Array.from({ length: 20 }, () => h.engine.createTask({ type: 'example-parallel', input: null })),
    );
    const engines = Array.from({ length: 6 }, () => h.newEngine());
    const w = h.worker();
    for (let i = 0; i < 30; i++) {
      await Promise.all(engines.map((e) => e.tick()));
      await w.pollOnce(50);
    }
    for (const { task } of tasks) {
      const t = await h.task(task.id);
      expect(t.status).toBe('COMPLETED');
      const hist = await h.history(task.id);
      expect(hist.filter((e) => e === 'task.completed:COMPLETED')).toHaveLength(1);
      expect(hist.filter((e) => e === 'step.ready:READY')).toHaveLength(5);
    }
  });

  it('crash BEFORE_COMPLETION_COMMIT: nothing persisted; the retried completion succeeds', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    await h.engine.runUntilIdle();
    const crashing = h.newEngine({ crashAt: { BEFORE_COMPLETION_COMMIT: 1 } });
    const { workerId } = await crashing.registerWorker('w', ['compute']);
    const [item] = await crashing.claim({ workerId, capabilities: ['compute'] });
    await expect(
      crashing.complete(item!.attemptId, { leaseToken: item!.leaseToken, output: 1 }),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await h.steps(task.id))[0]!.status).toBe('RUNNING');
    expect(await h.engine.complete(item!.attemptId, { leaseToken: item!.leaseToken, output: 1 })).toEqual({
      status: 'ACCEPTED',
    });
  });

  it('crash AFTER_COMPLETION_COMMIT: completion is durable; the worker retry is acknowledged idempotently', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    await h.engine.runUntilIdle();
    const crashing = h.newEngine({ crashAt: { AFTER_COMPLETION_COMMIT: 1 } });
    const { workerId } = await crashing.registerWorker('w', ['compute']);
    const [item] = await crashing.claim({ workerId, capabilities: ['compute'] });
    await expect(
      crashing.complete(item!.attemptId, { leaseToken: item!.leaseToken, output: 1 }),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await h.steps(task.id))[0]!.status).toBe('COMPLETED');
    expect(await h.engine.complete(item!.attemptId, { leaseToken: item!.leaseToken, output: 1 })).toEqual({
      status: 'ALREADY_ACCEPTED',
    });
  });

  it('worker crash AFTER_WORK_CLAIMED: the lease expires and another worker recovers the step', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    await h.engine.runUntilIdle();
    expect(await h.worker(undefined, { crashAt: { AFTER_WORK_CLAIMED: 1 } }).pollOnce()).toEqual(['crashed']);
    const t = await h.drive(task.id, [h.worker()], { advanceMs: 5_000 });
    expect(t.status).toBe('COMPLETED');
    const a = await h.pool.query(
      `SELECT status FROM attempts WHERE task_id = $1 ORDER BY started_at, attempt_number`,
      [task.id],
    );
    expect(a.rows.map((r) => r.status)).toEqual(['EXPIRED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
  });

  it('orchestrator crash MID_ORCHESTRATION_CYCLE: the whole cycle rolls back and is redone', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    const crashing = h.newEngine({ crashAt: { MID_ORCHESTRATION_CYCLE: 1 } });
    await expect(crashing.runOrchestrationPass()).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await h.task(task.id)).status).toBe('PENDING');
    expect(await h.history(task.id)).toEqual(['task.created:PENDING']);
    const t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('COMPLETED');
  });
});
