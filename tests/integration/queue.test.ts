import { defineWorkflow, map } from '@durable/core';
import { describe, expect, it } from 'vitest';
import { useHarness } from '../support/harness';

const wide = defineWorkflow({
  name: 'test-wide',
  steps: {
    many: map({ items: () => Array.from({ length: 60 }, (_, i) => i), executor: 'op', concurrency: 60 }),
  },
});

describe('work queue: claims, leases, heartbeats', () => {
  const h = useHarness([wide]);

  async function readyWide() {
    const { task } = await h.engine.createTask({ type: 'test-wide', input: null });
    await h.engine.runUntilIdle();
    return task;
  }

  it('concurrent claimers never claim the same step (SKIP LOCKED)', async () => {
    const task = await readyWide();
    const workers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => h.engine.registerWorker(`w${i}`, ['op'])),
    );
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        h.engine.claim({ workerId: workers[i % 8]!.workerId, capabilities: ['op'], maxItems: 5 }),
      ),
    );
    const claimed = results.flat();
    expect(claimed).toHaveLength(60);
    expect(new Set(claimed.map((c) => c.stepId)).size).toBe(60);
    const r = await h.pool.query(`SELECT count(*)::int AS n FROM attempts WHERE task_id = $1`, [task.id]);
    expect(r.rows[0].n).toBe(60);
  });

  it('SKIP LOCKED: a claimer skips rows locked by an in-flight transaction instead of blocking', async () => {
    await readyWide();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    const locker = await h.pool.connect();
    try {
      await locker.query('BEGIN');
      const locked = await locker.query(
        `SELECT id FROM steps WHERE status = 'READY' ORDER BY available_at, created_at LIMIT 10 FOR UPDATE`,
      );
      const items = await h.engine.claim({ workerId, capabilities: ['op'], maxItems: 100 });
      expect(items).toHaveLength(50);
      const lockedIds = new Set(locked.rows.map((r) => r.id));
      expect(items.some((i) => lockedIds.has(i.stepId))).toBe(false);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });

  it('the database refuses a second running attempt for a step', async () => {
    await readyWide();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    const [item] = await h.engine.claim({ workerId, capabilities: ['op'] });
    await expect(
      h.pool.query(
        `INSERT INTO attempts (id, task_id, step_id, attempt_number, worker_id, status, lease_token, lease_expires_at, deadline_at, started_at)
         VALUES (gen_random_uuid(), $1, $2, 2, $3, 'RUNNING', gen_random_uuid(), now(), now(), now())`,
        [item!.taskId, item!.stepId, workerId],
      ),
    ).rejects.toThrow(/attempts_one_running_per_step/);
  });

  it('heartbeat extends the lease; an expired lease is reaped and the step retried', async () => {
    const task = await readyWide();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    const [item] = await h.engine.claim({ workerId, capabilities: ['op'] });
    h.clock.advance(8_000);
    const hb = await h.engine.heartbeat(item!.attemptId, item!.leaseToken);
    expect(new Date(hb.leaseExpiresAt).getTime()).toBe(h.clock.now().getTime() + 10_000);
    h.clock.advance(8_000); // 16s after claim, but only 8s after heartbeat
    expect(await h.engine.reapExpiredLeases()).toBe(0);
    h.clock.advance(3_000); // lease now expired
    expect(await h.engine.reapExpiredLeases()).toBe(1);
    const a = await h.pool.query(`SELECT status, error_type FROM attempts WHERE id = $1`, [item!.attemptId]);
    expect(a.rows[0]).toEqual({ status: 'EXPIRED', error_type: 'AMBIGUOUS' });
    const s = await h.pool.query(`SELECT status FROM steps WHERE id = $1`, [item!.stepId]);
    expect(s.rows[0].status).toBe('RETRYING');
    // Heartbeat from the dead worker is rejected now.
    await expect(h.engine.heartbeat(item!.attemptId, item!.leaseToken)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    });
    expect(task).toBeTruthy();
  });

  it('a stale worker cannot complete after its lease was reaped, and cannot overwrite the new attempt (Invariants 2 and 7)', async () => {
    await readyWide();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    const [old] = await h.engine.claim({ workerId, capabilities: ['op'] });
    h.clock.advance(11_000);
    await h.engine.reapExpiredLeases();
    h.clock.advance(60_000);
    await h.engine.promoteDueRetries();
    const fresh = (await h.engine.claim({ workerId, capabilities: ['op'], maxItems: 100 })).find(
      (i) => i.stepId === old!.stepId,
    )!;
    expect(fresh.attemptNumber).toBe(2);
    expect(fresh.context.recoveringAmbiguous).toBe(true);
    await expect(
      h.engine.complete(old!.attemptId, { leaseToken: old!.leaseToken, output: 'stale' }),
    ).rejects.toMatchObject({
      code: 'LEASE_LOST',
    });
    await expect(
      h.engine.complete(fresh.attemptId, { leaseToken: old!.leaseToken, output: 'forged' }),
    ).rejects.toMatchObject({
      code: 'LEASE_LOST',
    });
    await h.engine.complete(fresh.attemptId, { leaseToken: fresh.leaseToken, output: 'fresh' });
    const s = await h.pool.query(`SELECT status, output FROM steps WHERE id = $1`, [old!.stepId]);
    expect(s.rows[0]).toEqual({ status: 'COMPLETED', output: 'fresh' });
  });

  it('duplicate completion (lost response) is acknowledged without a second transition', async () => {
    await readyWide();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    const [item] = await h.engine.claim({ workerId, capabilities: ['op'] });
    expect(await h.engine.complete(item!.attemptId, { leaseToken: item!.leaseToken, output: 1 })).toEqual({
      status: 'ACCEPTED',
    });
    expect(await h.engine.complete(item!.attemptId, { leaseToken: item!.leaseToken, output: 1 })).toEqual({
      status: 'ALREADY_ACCEPTED',
    });
    const n = await h.pool.query(
      `SELECT count(*)::int AS n FROM task_history WHERE step_id = $1 AND event_type = 'step.completed'`,
      [item!.stepId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('completion racing the reaper: exactly one wins', async () => {
    await readyWide();
    const { workerId } = await h.engine.registerWorker('w', ['op']);
    const items = await h.engine.claim({ workerId, capabilities: ['op'], maxItems: 20 });
    h.clock.advance(10_001);
    const results = await Promise.allSettled([
      h.engine.reapExpiredLeases(100),
      ...items.map((i) => h.engine.complete(i.attemptId, { leaseToken: i.leaseToken, output: 'x' })),
    ]);
    const completed = results.slice(1).filter((r) => r.status === 'fulfilled').length;
    const reaped = (results[0] as PromiseFulfilledResult<number>).value;
    expect(completed + reaped).toBe(20);
    const r = await h.pool.query(
      `SELECT count(*) FILTER (WHERE status = 'COMPLETED')::int AS c, count(*) FILTER (WHERE status = 'EXPIRED')::int AS e FROM attempts`,
    );
    expect(r.rows[0]).toEqual({ c: completed, e: reaped });
  });
});
