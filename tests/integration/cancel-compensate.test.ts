import { describe, expect, it } from 'vitest';
import { useHarness } from '../support/harness';

describe('cancellation, pause/resume and compensation', () => {
  const h = useHarness();

  it('cancels: running worker observes it on heartbeat, completed results are preserved, nothing new is scheduled', async () => {
    const { task } = await h.engine.createTask({ type: 'example-parallel', input: null });
    await h.engine.runUntilIdle();
    const { workerId } = await h.engine.registerWorker('w', ['compute', 'aggregate']);
    const [a] = await h.engine.claim({ workerId, capabilities: ['compute'] });
    await h.engine.complete(a!.attemptId, { leaseToken: a!.leaseToken, output: { value: 1 } });
    await h.engine.runUntilIdle();
    const [b1, b2] = await h.engine.claim({ workerId, capabilities: ['compute'], maxItems: 2 });
    const r = await h.engine.cancelTask(task.id, 'user asked');
    expect(r.task.status).toBe('CANCELLED');
    expect((await h.engine.cancelTask(task.id)).alreadyCancelled).toBe(true);
    expect((await h.engine.heartbeat(b1!.attemptId, b1!.leaseToken)).cancelRequested).toBe(true);
    // b1 finishes anyway: the result is real and kept. b2 gives up.
    await h.engine.complete(b1!.attemptId, { leaseToken: b1!.leaseToken, output: { value: 2 } });
    await h.engine.fail(b2!.attemptId, {
      leaseToken: b2!.leaseToken,
      error: { category: 'POLICY', message: 'cancelled' },
    });
    await h.engine.runUntilIdle();
    expect(await h.engine.claim({ workerId, capabilities: ['compute', 'aggregate'], maxItems: 10 })).toEqual(
      [],
    );
    const steps = Object.fromEntries((await h.steps(task.id)).map((s) => [s.key, s.status]));
    expect(steps).toEqual({
      a: 'COMPLETED',
      b1: 'COMPLETED',
      b2: 'CANCELLED',
      b3: 'CANCELLED',
      aggregate: 'CANCELLED',
    });
    expect((await h.task(task.id)).status).toBe('CANCELLED');
    await expect(h.engine.signal(task.id, { type: 'x', payload: null })).rejects.toMatchObject({
      code: 'TASK_TERMINAL',
    });
    await expect(h.engine.resumeTask(task.id)).rejects.toMatchObject({ code: 'TASK_TERMINAL' });
    expect(await h.history(task.id)).toContain('step.cancel_requested:RUNNING');
  });

  it('cancelling a parent cancels its children and their timers', async () => {
    const { task } = await h.engine.createTask({
      type: 'parent-with-children',
      input: { starts: [1, 2, 3] },
    });
    await h.engine.runUntilIdle();
    await h.engine.cancelTask(task.id);
    const kids = await h.pool.query(`SELECT status FROM tasks WHERE parent_task_id = $1`, [task.id]);
    expect(kids.rows.every((k) => k.status === 'CANCELLED')).toBe(true);
    await h.engine.runUntilIdle();
    expect(await h.worker().pollOnce()).toEqual([]);
  });

  it('pause stops new claims; resume continues', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    await h.engine.runUntilIdle();
    await h.engine.pauseTask(task.id);
    const w = h.worker();
    expect(await w.pollOnce()).toEqual([]);
    await h.engine.resumeTask(task.id);
    const t = await h.drive(task.id, [w]);
    expect(t.status).toBe('COMPLETED');
    const hist = await h.history(task.id);
    expect(hist).toContain('task.paused:PAUSED');
  });

  it('saga: ship fails -> refund charge -> release reservation, in reverse order, each once', async () => {
    const { task } = await h.engine.createTask({ type: 'saga-order', input: { failShipping: true } });
    const t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('FAILED');
    expect(t.compensation_status).toBe('COMPLETED');
    expect(t.error).toMatchObject({ stepKey: 'ship', category: 'PERMANENT' });
    const steps = await h.pool.query(
      `SELECT key, status, dependencies FROM steps WHERE task_id = $1 ORDER BY created_at, key`,
      [task.id],
    );
    expect(
      Object.fromEntries(steps.rows.map((s) => [s.key, `${s.status} after [${s.dependencies}]`])),
    ).toEqual({
      reserve: 'COMPLETED after []',
      charge: 'COMPLETED after [reserve]',
      ship: 'FAILED after [charge]',
      'compensate:charge': 'COMPLETED after []',
      'compensate:reserve': 'COMPLETED after [compensate:charge]',
    });
    const ops = await h.pool.query(`SELECT operation FROM example_external.operations ORDER BY id`);
    expect(ops.rows.map((r) => r.operation)).toEqual(['reserve', 'charge', 'refund', 'release']);
    const refund = await h.pool.query(
      `SELECT payload FROM example_external.operations WHERE operation = 'refund'`,
    );
    expect(refund.rows[0].payload.charge.operation).toBe('charge');
  });

  it('saga happy path runs no compensation', async () => {
    const { task } = await h.engine.createTask({ type: 'saga-order', input: { failShipping: false } });
    const t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('COMPLETED');
    expect(t.compensation_status).toBeNull();
  });
});
