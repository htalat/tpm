import { SimulatedCrash } from '@durable/core';
import { describe, expect, it } from 'vitest';
import { useHarness } from '../support/harness';

describe('durable timers and external events', () => {
  const h = useHarness();

  it('Example D: a sleep survives a full restart and fires after its time', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sleep', input: { sleepMs: 60_000 } });
    let t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('WAITING');
    const timer = (await h.pool.query(`SELECT status, fire_at FROM timers WHERE task_id = $1`, [task.id]))
      .rows[0];
    expect(timer.status).toBe('SCHEDULED');
    expect(timer.fire_at.getTime() - h.clock.now().getTime()).toBe(60_000);
    // "Kill everything": discard engine & worker objects. Only PostgreSQL remains.
    h.clock.advance(59_000);
    const e2 = h.newEngine();
    await e2.tick();
    expect((await h.task(task.id)).status).toBe('WAITING');
    h.clock.advance(5_000);
    const e3 = h.newEngine();
    expect(await e3.fireDueTimers()).toBe(1);
    expect(await e3.fireDueTimers()).toBe(0); // fires once
    t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('COMPLETED');
    const hist = await h.pool.query(
      `SELECT payload FROM task_history WHERE task_id = $1 AND event_type = 'timer.fired'`,
      [task.id],
    );
    expect(hist.rows[0].payload.latencyMs).toBe(4_000);
  });

  it('crash BEFORE_TIMER_REGISTRATION rolls back; the next orchestrator registers exactly one timer', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sleep', input: { sleepMs: 1000 } });
    await h.drive(task.id, []);
    await h.worker().pollOnce();
    const crashing = h.newEngine({ crashAt: { BEFORE_TIMER_REGISTRATION: 1 } });
    await expect(crashing.runOrchestrationPass()).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM timers`)).rows[0].n).toBe(0);
    expect((await h.task(task.id)).wake_at).not.toBeNull();
    await h.newEngine().runOrchestrationPass();
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM timers`)).rows[0].n).toBe(1);
  });

  it('crash AFTER_TIMER_REGISTRATION: the timer is durable and still fires', async () => {
    const { task } = await h.engine.createTask({ type: 'example-sleep', input: { sleepMs: 1000 } });
    await h.drive(task.id, []);
    await h.worker().pollOnce();
    const crashing = h.newEngine({ crashAt: { AFTER_TIMER_REGISTRATION: 1 } });
    await expect(crashing.runOrchestrationPass()).rejects.toBeInstanceOf(SimulatedCrash);
    expect(
      (await h.pool.query(`SELECT count(*)::int AS n FROM timers WHERE status = 'SCHEDULED'`)).rows[0].n,
    ).toBe(1);
    const t = await h.drive(task.id, [h.worker()], { advanceMs: 1000 });
    expect(t.status).toBe('COMPLETED');
  });

  it('Example E: approval via signal after a restart; duplicate signals do not duplicate transitions', async () => {
    const { task } = await h.engine.createTask({ type: 'example-approval', input: null });
    let t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('WAITING');
    h.clock.advance(3 * 3600_000); // hours later, new processes
    const e2 = h.newEngine();
    const sig = {
      type: 'approval',
      payload: { approved: true, by: 'alice' },
      deduplicationKey: 'approval-1',
    };
    const [r1, r2, r3] = await Promise.all([
      e2.signal(task.id, sig),
      e2.signal(task.id, sig),
      h.engine.signal(task.id, sig),
    ]);
    expect([r1, r2, r3].filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set([r1.eventId, r2.eventId, r3.eventId]).size).toBe(1);
    t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('COMPLETED');
    expect(t.output).toMatchObject({ published: true });
    // A late duplicate is still recognised as a duplicate, even for a finished task.
    expect((await e2.signal(task.id, sig)).duplicate).toBe(true);
    const hist = await h.history(task.id);
    expect(hist.filter((e) => e.startsWith('signal.received'))).toHaveLength(1);
    expect((await h.external.stats()).effects).toBe(1);
  });

  it('an event that arrives before the step waits is buffered durably', async () => {
    const { task } = await h.engine.createTask({ type: 'example-approval', input: null });
    await h.engine.signal(task.id, { type: 'approval', payload: { approved: false } });
    const t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('COMPLETED');
    expect(t.output).toMatchObject({ published: false });
  });

  it('correlation keys route events to the matching wait only', async () => {
    const { defineWorkflow, waitForEvent } = await import('@durable/core');
    h.registry.register(
      defineWorkflow({
        name: 'test-corr',
        steps: { w: waitForEvent('reply', { correlationKey: () => 'order-7' }) },
      }),
    );
    const { task } = await h.engine.createTask({ type: 'test-corr', input: null });
    await h.engine.runUntilIdle();
    await h.engine.signal(task.id, { type: 'reply', correlationKey: 'order-8', payload: 'wrong' });
    await h.engine.runUntilIdle();
    expect((await h.task(task.id)).status).toBe('WAITING');
    await h.engine.signal(task.id, { type: 'reply', correlationKey: 'order-7', payload: 'right' });
    await h.engine.runUntilIdle();
    const t = await h.task(task.id);
    expect(t.status).toBe('COMPLETED');
    expect(t.output).toEqual({ w: 'right' });
  });

  it('rejects reserved event types', async () => {
    const { SignalRequestSchema } = await import('@durable/core');
    expect(SignalRequestSchema.safeParse({ type: '__timer.fired' }).success).toBe(false);
  });
});
