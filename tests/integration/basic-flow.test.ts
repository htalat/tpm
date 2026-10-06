import { describe, expect, it } from 'vitest';
import { useHarness } from '../support/harness';

describe('phase 1: create -> claim -> complete -> task completes', () => {
  const h = useHarness();

  it('runs a sequence workflow to completion with full history', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: { start: 5 } });
    expect(task.status).toBe('PENDING');
    const w = h.worker();
    const done = await h.drive(task.id, [w]);
    expect(done.status).toBe('COMPLETED');
    expect(done.output).toMatchObject({ label: 'C', value: 8 });
    const hist = await h.history(task.id);
    expect(hist[0]).toBe('task.created:PENDING');
    expect(hist).toContain('task.completed:COMPLETED');
    expect(hist.filter((e) => e === 'step.completed:COMPLETED')).toHaveLength(3);
    expect(hist.filter((e) => e === 'step.running:RUNNING')).toHaveLength(3);
  });

  it('runs parallel branches and aggregates (fan-in)', async () => {
    const { task } = await h.engine.createTask({ type: 'example-parallel', input: null });
    await h.engine.runUntilIdle();
    const w = h.worker();
    await w.pollOnce(); // a
    await h.engine.runUntilIdle();
    const items = await h.engine.claim({ workerId: w.id!, capabilities: ['compute'], maxItems: 10 });
    expect(items.map((i) => i.stepKey).sort()).toEqual(['b1', 'b2', 'b3']);
    // aggregate is not eligible until all three finish
    await h.engine.complete(items[0]!.attemptId, { leaseToken: items[0]!.leaseToken, output: { value: 1 } });
    await h.engine.complete(items[1]!.attemptId, { leaseToken: items[1]!.leaseToken, output: { value: 2 } });
    await h.engine.runUntilIdle();
    expect((await h.steps(task.id)).find((s) => s.key === 'aggregate')!.status).toBe('PENDING');
    await h.engine.complete(items[2]!.attemptId, { leaseToken: items[2]!.leaseToken, output: { value: 3 } });
    await h.engine.runUntilIdle();
    expect((await h.steps(task.id)).find((s) => s.key === 'aggregate')!.status).toBe('READY');
    const done = await h.drive(task.id, [w]);
    expect(done.status).toBe('COMPLETED');
    expect(done.output).toMatchObject({ count: 3 });
  });

  it('creates tasks idempotently with an idempotency key', async () => {
    const a = await h.engine.createTask({ type: 'example-sequence', input: { start: 1 } }, 'key-1');
    const b = await h.engine.createTask({ type: 'example-sequence', input: { start: 1 } }, 'key-1');
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.task.id).toBe(a.task.id);
    await expect(
      h.engine.createTask({ type: 'example-sequence', input: { start: 2 } }, 'key-1'),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    });
  });

  it('validates input with the workflow schema', async () => {
    await expect(
      h.engine.createTask({ type: 'company-research', input: { companies: [] } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(h.engine.createTask({ type: 'nope', input: null })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects history mutation at the database level', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    await expect(
      h.pool.query(`UPDATE task_history SET event_type = 'x' WHERE task_id = $1`, [task.id]),
    ).rejects.toThrow(/append-only/);
    await expect(h.pool.query(`DELETE FROM task_history WHERE task_id = $1`, [task.id])).rejects.toThrow(
      /append-only/,
    );
  });
});
