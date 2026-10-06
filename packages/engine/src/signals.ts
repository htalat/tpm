import { assertPayloadSize, DomainError, isTerminalTask, NotFoundError } from '@durable/core';
import { withRetryingTransaction } from '@durable/db';
import type { EngineDeps } from './deps';
import { j } from './rows';
import { lockTask, recordHistory, wakeTask } from './transitions';

export interface SignalInput {
  type: string;
  correlationKey?: string | null;
  payload: unknown;
  deduplicationKey?: string;
}

/**
 * Persist an external event, then wake the task. The event row is the source
 * of truth; processing happens later in an orchestrator cycle. Duplicate
 * deliveries with the same deduplication key hit the UNIQUE constraint and
 * return the original event (Invariant 3).
 */
export async function signalTask(
  deps: EngineDeps,
  taskId: string,
  sig: SignalInput,
): Promise<{ eventId: string; duplicate: boolean }> {
  assertPayloadSize('payload', sig.payload);
  const dedup = sig.deduplicationKey ?? deps.ids.next();
  const result = await withRetryingTransaction(deps.pool, async (tx) => {
    const now = deps.clock.now();
    const task = await lockTask(tx, taskId);
    if (!task) throw new NotFoundError('task', taskId);
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM events WHERE task_id = $1 AND deduplication_key = $2`,
      [taskId, dedup],
    );
    if (existing.rows[0]) return { eventId: existing.rows[0].id, duplicate: true };
    if (isTerminalTask(task.status)) {
      throw new DomainError('TASK_TERMINAL', `task ${taskId} is ${task.status}; signal not accepted`, {
        status: task.status,
      });
    }
    const id = deps.ids.next();
    await tx.query(
      `INSERT INTO events (id, task_id, event_type, correlation_key, deduplication_key, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, taskId, sig.type, sig.correlationKey ?? null, dedup, j(sig.payload), now],
    );
    await recordHistory(tx, now, {
      taskId,
      eventType: 'signal.received',
      payload: {
        eventId: id,
        type: sig.type,
        correlationKey: sig.correlationKey ?? null,
        deduplicationKey: dedup,
      },
    });
    await wakeTask(tx, taskId, now);
    return { eventId: id, duplicate: false };
  });
  if (result.duplicate) deps.metrics.duplicateSignals.inc();
  deps.logger.info(
    {
      task_id: taskId,
      event_type: 'signal',
      signal_type: sig.type,
      correlation_id: sig.correlationKey ?? undefined,
      duplicate: result.duplicate,
    },
    'signal received',
  );
  return result;
}
