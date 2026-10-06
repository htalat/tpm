import {
  assertPayloadSize,
  CLAIMABLE_TASK_STATUSES,
  computeBackoffMs,
  isRetryable,
  LeaseLostError,
  NotFoundError,
  type ArtifactRef,
  type CompletionResponse,
  type FailureCategory,
  type HeartbeatResponse,
  type WorkItem,
} from '@durable/core';
import { withRetryingTransaction, type Queryable } from '@durable/db';
import { leaseId, withSpan } from '@durable/observability';
import type { EngineDeps } from './deps';
import { j, type AttemptRow, type StepRow, type TaskRow } from './rows';
import {
  lockAttempt,
  lockStep,
  lockTask,
  recordHistory,
  transitionAttempt,
  transitionStep,
  wakeTask,
} from './transitions';

export async function registerWorker(
  deps: EngineDeps,
  name: string,
  capabilities: string[],
): Promise<{ workerId: string }> {
  const id = deps.ids.next();
  const now = deps.clock.now();
  await deps.pool.query(
    `INSERT INTO workers (id, name, capabilities, registered_at, last_seen_at) VALUES ($1,$2,$3,$4,$4)`,
    [id, name, capabilities, now],
  );
  deps.logger.info({ worker_id: id, worker_name: name, capabilities }, 'worker registered');
  return { workerId: id };
}

interface ClaimRow extends StepRow {
  task_type: string;
}

/**
 * Atomically claim up to `maxItems` READY steps. In ONE transaction:
 * select eligible steps with FOR UPDATE SKIP LOCKED (concurrent claimers skip
 * each other's rows instead of blocking or double-claiming), create an attempt
 * with a fresh lease token and expiry, and move the step READY -> RUNNING.
 * If the process dies before COMMIT nothing happened; after COMMIT the lease
 * is durable and the reaper will recover it if the worker vanishes.
 */
export async function claim(
  deps: EngineDeps,
  req: { workerId: string; capabilities: string[]; maxItems: number; leaseMs?: number },
): Promise<WorkItem[]> {
  return withSpan('durable.claim', { 'durable.worker_id': req.workerId }, () =>
    withRetryingTransaction(deps.pool, async (tx) => {
      const now = deps.clock.now();
      const leaseMs = req.leaseMs ?? deps.leaseMs;
      const w = await tx.query(`UPDATE workers SET last_seen_at = $2 WHERE id = $1 RETURNING id`, [
        req.workerId,
        now,
      ]);
      if (w.rowCount !== 1) throw new NotFoundError('worker', req.workerId);
      const rows = (
        await tx.query<ClaimRow>(
          `SELECT s.*, t.type AS task_type FROM steps s JOIN tasks t ON t.id = s.task_id
           WHERE s.status = 'READY' AND s.available_at <= $1 AND s.executor_type = ANY($2::text[])
             AND t.status = ANY($3::text[])
           ORDER BY s.available_at, s.created_at
           LIMIT $4
           FOR UPDATE OF s SKIP LOCKED`,
          [now, req.capabilities, CLAIMABLE_TASK_STATUSES, req.maxItems],
        )
      ).rows;
      const items: WorkItem[] = [];
      for (const s of rows) {
        const prev = (
          await tx.query<Pick<AttemptRow, 'attempt_number' | 'status' | 'error_type' | 'error_message'>>(
            `SELECT attempt_number, status, error_type, error_message FROM attempts
             WHERE step_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
            [s.id],
          )
        ).rows[0];
        const attemptId = deps.ids.next();
        const leaseToken = deps.ids.next();
        const attemptNumber = s.attempt_count + 1;
        const leaseExpiresAt = new Date(now.getTime() + leaseMs);
        const deadlineAt = new Date(now.getTime() + s.timeout_ms);
        await tx.query(
          `INSERT INTO attempts (id, task_id, step_id, attempt_number, worker_id, status, lease_token, lease_expires_at,
                                 deadline_at, heartbeat_at, started_at)
           VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,$7,$8,$9,$9)`,
          [
            attemptId,
            s.task_id,
            s.id,
            attemptNumber,
            req.workerId,
            leaseToken,
            leaseExpiresAt,
            deadlineAt,
            now,
          ],
        );
        await transitionStep(tx, {
          step: s,
          to: 'RUNNING',
          now,
          attemptId,
          patch: { attempt_count: attemptNumber, started_at: s.started_at ?? now },
          payload: { attemptNumber, workerId: req.workerId, leaseId: leaseId(leaseToken), leaseExpiresAt },
        });
        items.push({
          taskId: s.task_id,
          stepId: s.id,
          stepKey: s.key,
          attemptId,
          attemptNumber,
          type: s.executor_type!,
          input: s.input,
          context: {
            taskType: s.task_type,
            previousAttempt: prev
              ? {
                  attemptNumber: prev.attempt_number,
                  status: prev.status,
                  errorType: prev.error_type,
                  errorMessage: prev.error_message,
                }
              : null,
            recoveringAmbiguous: prev?.error_type === 'AMBIGUOUS',
          },
          idempotencyKey: s.idempotency_key,
          leaseToken,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          timeoutMs: s.timeout_ms,
          deadlineAt: deadlineAt.toISOString(),
        });
        deps.metrics.workClaimed.inc({ executor: s.executor_type! });
        deps.logger.info(
          {
            task_id: s.task_id,
            step_id: s.id,
            attempt_id: attemptId,
            worker_id: req.workerId,
            lease_id: leaseId(leaseToken),
            event_type: 'attempt.claimed',
            attempt_number: attemptNumber,
          },
          'work claimed',
        );
      }
      return items;
    }),
  );
}

/**
 * Extend a lease. Authority = attempt is RUNNING and the token matches. Only
 * the reaper (or a completion/failure) ends that authority, under the same row
 * lock, so heartbeat vs. reaper is linearizable: whichever commits first wins.
 */
export async function heartbeat(
  deps: EngineDeps,
  attemptId: string,
  leaseToken: string,
  leaseMs = deps.leaseMs,
): Promise<HeartbeatResponse> {
  const now = deps.clock.now();
  const expires = new Date(now.getTime() + leaseMs);
  const r = await deps.pool.query<{ lease_expires_at: Date; task_status: string }>(
    `UPDATE attempts a SET heartbeat_at = $3, lease_expires_at = $4
     FROM tasks t
     WHERE a.id = $1 AND a.lease_token = $2 AND a.status = 'RUNNING' AND t.id = a.task_id
     RETURNING a.lease_expires_at, t.status AS task_status`,
    [attemptId, leaseToken, now, expires],
  );
  const row = r.rows[0];
  if (!row) {
    const exists = await deps.pool.query<{ status: string }>(`SELECT status FROM attempts WHERE id = $1`, [
      attemptId,
    ]);
    if (!exists.rows[0]) throw new NotFoundError('attempt', attemptId);
    throw new LeaseLostError(attemptId, `attempt is ${exists.rows[0].status} or token does not match`);
  }
  return {
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    cancelRequested: row.task_status === 'CANCELLED',
  };
}

interface Locked {
  task: TaskRow;
  step: StepRow;
  attempt: AttemptRow;
}

/** Lock task -> step -> attempt (the global lock order) for an attempt. */
async function lockForAttempt(tx: Queryable, attemptId: string): Promise<Locked> {
  const ref = (
    await tx.query<{ task_id: string; step_id: string }>(
      `SELECT task_id, step_id FROM attempts WHERE id = $1`,
      [attemptId],
    )
  ).rows[0];
  if (!ref) throw new NotFoundError('attempt', attemptId);
  const task = (await lockTask(tx, ref.task_id))!;
  const step = (await lockStep(tx, ref.step_id))!;
  const attempt = (await lockAttempt(tx, attemptId))!;
  return { task, step, attempt };
}

export async function complete(
  deps: EngineDeps,
  attemptId: string,
  req: { leaseToken: string; output: unknown; artifacts: ArtifactRef[] },
): Promise<CompletionResponse> {
  assertPayloadSize('output', req.output);
  const res = await withSpan('durable.complete', { 'durable.attempt_id': attemptId }, () =>
    withRetryingTransaction(deps.pool, async (tx) => {
      const now = deps.clock.now();
      const { task, step, attempt } = await lockForAttempt(tx, attemptId);
      const log = { task_id: task.id, step_id: step.id, attempt_id: attemptId, worker_id: attempt.worker_id };
      if (attempt.lease_token !== req.leaseToken.toLowerCase()) {
        deps.metrics.staleCompletions.inc();
        throw new LeaseLostError(attemptId, 'lease token does not match');
      }
      // Lost-response retry of a completion we already committed: acknowledge, change nothing.
      if (attempt.status === 'COMPLETED') return { status: 'ALREADY_ACCEPTED' as const, durationMs: 0 };
      if (attempt.status !== 'RUNNING') {
        deps.metrics.staleCompletions.inc();
        deps.logger.warn(
          { ...log, event_type: 'completion.rejected', attempt_status: attempt.status },
          'stale completion rejected',
        );
        throw new LeaseLostError(attemptId, `attempt is ${attempt.status}`);
      }
      await transitionAttempt(tx, { attempt, to: 'COMPLETED', now, patch: { output: req.output } });
      for (const a of req.artifacts) {
        await tx.query(
          `INSERT INTO artifacts (id, task_id, step_id, attempt_id, type, uri, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [deps.ids.next(), task.id, step.id, attemptId, a.type, a.uri, j(a.metadata ?? {}), now],
        );
      }
      await transitionStep(tx, {
        step,
        to: 'COMPLETED',
        now,
        attemptId,
        patch: { output: req.output },
        payload:
          task.status === 'CANCELLED' ? { note: 'completed after task cancellation; result preserved' } : {},
      });
      await wakeTask(tx, task.id, now);
      deps.injector.hit('BEFORE_COMPLETION_COMMIT');
      deps.logger.info({ ...log, event_type: 'attempt.completed' }, 'attempt completed');
      return { status: 'ACCEPTED' as const, durationMs: now.getTime() - attempt.started_at.getTime() };
    }),
  );
  if (res.status === 'ACCEPTED') deps.metrics.stepDuration.observe(res.durationMs);
  deps.injector.hit('AFTER_COMPLETION_COMMIT');
  return { status: res.status };
}

export async function fail(
  deps: EngineDeps,
  attemptId: string,
  req: {
    leaseToken: string;
    error: { category: FailureCategory; message: string; type?: string };
    retryAfterMs?: number;
  },
): Promise<CompletionResponse> {
  return withRetryingTransaction(deps.pool, async (tx) => {
    const now = deps.clock.now();
    const { task, step, attempt } = await lockForAttempt(tx, attemptId);
    if (attempt.lease_token !== req.leaseToken.toLowerCase())
      throw new LeaseLostError(attemptId, 'lease token does not match');
    if (attempt.status === 'FAILED') return { status: 'ALREADY_ACCEPTED' as const };
    if (attempt.status !== 'RUNNING') throw new LeaseLostError(attemptId, `attempt is ${attempt.status}`);
    await transitionAttempt(tx, {
      attempt,
      to: 'FAILED',
      now,
      patch: { error_type: req.error.category, error_message: req.error.message.slice(0, 4000) },
    });
    deps.metrics.attemptFailures.inc({ category: req.error.category });
    deps.logger.warn(
      {
        task_id: task.id,
        step_id: step.id,
        attempt_id: attemptId,
        worker_id: attempt.worker_id,
        event_type: 'attempt.failed',
        category: req.error.category,
      },
      'attempt failed',
    );
    await handleStepFailure(
      tx,
      deps,
      task,
      step,
      attempt,
      req.error.category,
      req.error.message,
      now,
      req.retryAfterMs,
    );
    return { status: 'ACCEPTED' as const };
  });
}

/**
 * Decide what a failed/expired attempt means for its step. The retry time is
 * persisted on the step (available_at); nobody sleeps. Ambiguous outcomes are
 * never silently turned into "failed": if they cannot be retried with
 * reconciliation they BLOCK for an operator.
 */
export async function handleStepFailure(
  tx: Queryable,
  deps: EngineDeps,
  task: TaskRow,
  step: StepRow,
  attempt: AttemptRow,
  category: FailureCategory,
  message: string,
  now: Date,
  retryAfterMs?: number,
): Promise<void> {
  const error = { category, message: message.slice(0, 4000), attempt: attempt.attempt_number };
  const base = { step, now, attemptId: attempt.id };
  if (task.status === 'CANCELLED') {
    await transitionStep(tx, { ...base, to: 'CANCELLED', reason: 'task cancelled', patch: { error } });
  } else if (category === 'AMBIGUOUS' && step.effect === 'unsafe') {
    await transitionStep(tx, {
      ...base,
      to: 'BLOCKED',
      reason: 'ambiguous outcome on unsafe step',
      patch: { error },
    });
  } else if (isRetryable(step.retry_policy, category, attempt.attempt_number)) {
    const delayMs = retryAfterMs ?? computeBackoffMs(step.retry_policy, attempt.attempt_number, deps.random);
    const nextAttemptAt = new Date(now.getTime() + delayMs);
    await transitionStep(tx, {
      ...base,
      to: 'RETRYING',
      reason: `${category} failure`,
      patch: { error, available_at: nextAttemptAt },
      payload: { delayMs, nextAttemptAt, nextAttemptNumber: attempt.attempt_number + 1 },
    });
    deps.metrics.retries.inc({ category });
  } else if (category === 'AMBIGUOUS') {
    await transitionStep(tx, {
      ...base,
      to: 'BLOCKED',
      reason: 'ambiguous outcome; retries exhausted',
      patch: { error },
    });
  } else {
    await transitionStep(tx, { ...base, to: 'FAILED', reason: `${category} failure`, patch: { error } });
  }
  await wakeTask(tx, task.id, now);
}

/**
 * Recover attempts whose lease or deadline passed. An expired lease does NOT
 * prove the work did not happen: for steps with side effects the outcome is
 * classified AMBIGUOUS, and the next attempt is told so it can reconcile.
 */
export async function reapExpiredLeases(deps: EngineDeps, max = 50): Promise<number> {
  const now = deps.clock.now();
  const candidates = (
    await deps.pool.query<{ id: string }>(
      `SELECT id FROM attempts WHERE status = 'RUNNING' AND (lease_expires_at < $1 OR deadline_at < $1)
       ORDER BY lease_expires_at LIMIT $2`,
      [now, max],
    )
  ).rows;
  let reaped = 0;
  for (const { id } of candidates) {
    const done = await withRetryingTransaction(deps.pool, async (tx) => {
      const { task, step, attempt } = await lockForAttempt(tx, id);
      const t = deps.clock.now();
      const leaseGone = attempt.lease_expires_at < t;
      const deadlineGone = attempt.deadline_at < t;
      if (attempt.status !== 'RUNNING' || (!leaseGone && !deadlineGone)) return false; // heartbeat or completion won
      const category: FailureCategory = step.effect === 'pure' ? 'TIMEOUT' : 'AMBIGUOUS';
      const message = deadlineGone
        ? `attempt exceeded its ${step.timeout_ms}ms timeout; outcome unknown`
        : 'lease expired before completion was recorded; outcome unknown';
      await transitionAttempt(tx, {
        attempt,
        to: 'EXPIRED',
        now: t,
        patch: { error_type: category, error_message: message },
        payload: { reason: deadlineGone ? 'deadline' : 'lease', workerId: attempt.worker_id },
      });
      await handleStepFailure(tx, deps, task, step, attempt, category, message, t);
      deps.logger.warn(
        {
          task_id: task.id,
          step_id: step.id,
          attempt_id: id,
          worker_id: attempt.worker_id,
          event_type: 'attempt.expired',
          category,
        },
        'lease expired',
      );
      return true;
    });
    if (done) {
      reaped++;
      deps.metrics.leaseExpirations.inc();
      deps.metrics.attemptFailures.inc({ category: 'EXPIRED' });
    }
  }
  return reaped;
}
