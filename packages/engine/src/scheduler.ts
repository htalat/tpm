import { TIMER_EVENT_TYPE } from '@durable/core';
import { withRetryingTransaction } from '@durable/db';
import type { EngineDeps } from './deps';
import { j, type StepRow, type TimerRow } from './rows';
import { lockTask, recordHistory, transitionStep, wakeTask } from './transitions';

/**
 * Fire due timers. Firing = persist a `__timer.fired` event (deduplicated by
 * timer id), mark the timer FIRED and wake the task, in one transaction. No
 * process ever sleeps for a timer (Invariant 5): whichever orchestrator polls
 * after fire_at does the work, even if every process was down at fire_at.
 */
export async function fireDueTimers(deps: EngineDeps, max = 100): Promise<number> {
  const now = deps.clock.now();
  const due = (
    await deps.pool.query<{ id: string; task_id: string }>(
      `SELECT id, task_id FROM timers WHERE status = 'SCHEDULED' AND fire_at <= $1 ORDER BY fire_at LIMIT $2`,
      [now, max],
    )
  ).rows;
  let fired = 0;
  for (const d of due) {
    const latency = await withRetryingTransaction(deps.pool, async (tx) => {
      const t = deps.clock.now();
      await lockTask(tx, d.task_id);
      const timer = (await tx.query<TimerRow>(`SELECT * FROM timers WHERE id = $1 FOR UPDATE`, [d.id]))
        .rows[0];
      if (!timer || timer.status !== 'SCHEDULED') return null;
      await tx.query(
        `INSERT INTO events (id, task_id, step_id, event_type, correlation_key, deduplication_key, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (task_id, deduplication_key) DO NOTHING`,
        [
          deps.ids.next(),
          timer.task_id,
          timer.step_id,
          TIMER_EVENT_TYPE,
          timer.step_id,
          `timer:${timer.id}`,
          j({ timerId: timer.id, fireAt: timer.fire_at, firedAt: t }),
          t,
        ],
      );
      await tx.query(`UPDATE timers SET status = 'FIRED', fired_at = $2 WHERE id = $1`, [timer.id, t]);
      const latencyMs = t.getTime() - timer.fire_at.getTime();
      await recordHistory(tx, t, {
        taskId: timer.task_id,
        stepId: timer.step_id,
        eventType: 'timer.fired',
        previousState: 'SCHEDULED',
        newState: 'FIRED',
        payload: { timerId: timer.id, fireAt: timer.fire_at, latencyMs },
      });
      await wakeTask(tx, timer.task_id, t);
      deps.injector.hit('BEFORE_TIMER_FIRE_COMMIT');
      deps.logger.info(
        { task_id: timer.task_id, step_id: timer.step_id, event_type: 'timer.fired', latency_ms: latencyMs },
        'timer fired',
      );
      return latencyMs;
    });
    if (latency !== null) {
      fired++;
      deps.metrics.timerLatency.observe(latency);
    }
  }
  return fired;
}

/**
 * Make RETRYING steps claimable once their persisted retry time arrives
 * (Invariant 6: retry scheduling survives restarts, because it is just a
 * timestamp in the step row).
 */
export async function promoteDueRetries(deps: EngineDeps, max = 100): Promise<number> {
  const now = deps.clock.now();
  const due = (
    await deps.pool.query<{ id: string; task_id: string }>(
      `SELECT id, task_id FROM steps WHERE status = 'RETRYING' AND available_at <= $1 ORDER BY available_at LIMIT $2`,
      [now, max],
    )
  ).rows;
  let promoted = 0;
  for (const d of due) {
    const ok = await withRetryingTransaction(deps.pool, async (tx) => {
      const t = deps.clock.now();
      await lockTask(tx, d.task_id);
      const s = (await tx.query<StepRow>(`SELECT * FROM steps WHERE id = $1 FOR NO KEY UPDATE`, [d.id]))
        .rows[0];
      if (!s || s.status !== 'RETRYING' || s.available_at > t) return false;
      await transitionStep(tx, { step: s, to: 'READY', now: t, reason: 'retry backoff elapsed' });
      await wakeTask(tx, d.task_id, t);
      return true;
    });
    if (ok) promoted++;
  }
  return promoted;
}
