import {
  assertAttemptTransition,
  assertStepTransition,
  assertTaskTransition,
  ConcurrencyConflictError,
  type AttemptStatus,
  type StepStatus,
  type TaskStatus,
} from '@durable/core';
import type { Queryable } from '@durable/db';
import { j, type AttemptRow, type StepRow, type TaskRow } from './rows';

/**
 * The ONLY place where task/step/attempt status changes are written.
 *
 * Each transition:
 *  1. validates (from -> to) against the state machine in @durable/core,
 *  2. performs a compare-and-set UPDATE on (id, status, version),
 *  3. appends a task_history row in the same transaction.
 *
 * Callers hold row locks in the order task -> step -> attempt, so the version
 * check normally always succeeds; if it does not, someone violated the locking
 * protocol and we fail loudly (ConcurrencyConflictError) and roll back.
 */

export interface HistoryEntry {
  taskId: string;
  stepId?: string | null;
  attemptId?: string | null;
  eventType: string;
  previousState?: string | null;
  newState?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordHistory(tx: Queryable, now: Date, h: HistoryEntry): Promise<void> {
  await tx.query(
    `INSERT INTO task_history (task_id, step_id, attempt_id, event_type, previous_state, new_state, payload, "timestamp")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      h.taskId,
      h.stepId ?? null,
      h.attemptId ?? null,
      h.eventType,
      h.previousState ?? null,
      h.newState ?? null,
      j(h.payload ?? {}),
      now,
    ],
  );
}

type Patch = Record<string, unknown>;

/** Column whitelist per table: patch keys are never interpolated from user data. */
const TASK_PATCH = ['output', 'error', 'failure', 'compensation_status', 'wake_at'] as const;
const STEP_PATCH = [
  'input',
  'output',
  'error',
  'wait',
  'available_at',
  'attempt_count',
  'started_at',
  'completed_at',
  'concurrency_key',
  'concurrency_limit',
  'uncharged_attempts',
] as const;
const ATTEMPT_PATCH = ['output', 'error_type', 'error_message', 'completed_at', 'metadata'] as const;
const JSON_COLUMNS = new Set(['output', 'error', 'failure', 'input', 'wait', 'metadata']);

function buildSet(
  patch: Patch,
  allowed: readonly string[],
  startIndex: number,
): { sql: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (!allowed.includes(k)) throw new Error(`column ${k} is not patchable`);
    values.push(JSON_COLUMNS.has(k) ? j(v) : v);
    parts.push(`${k} = $${startIndex + values.length - 1}`);
  }
  return { sql: parts.map((p) => `, ${p}`).join(''), values };
}

export interface TaskTransition {
  task: Pick<TaskRow, 'id' | 'status' | 'version'>;
  to: TaskStatus;
  now: Date;
  patch?: Partial<Record<(typeof TASK_PATCH)[number], unknown>>;
  reason?: string;
  payload?: Record<string, unknown>;
}

export async function transitionTask(tx: Queryable, t: TaskTransition): Promise<TaskRow> {
  assertTaskTransition(t.task.id, t.task.status, t.to);
  const set = buildSet(t.patch ?? {}, TASK_PATCH, 6);
  const terminal = t.to === 'COMPLETED' || t.to === 'FAILED';
  const res = await tx.query<TaskRow>(
    `UPDATE tasks SET status = $1, version = version + 1, updated_at = $2,
       started_at = CASE WHEN $1 IN ('READY','RUNNING','WAITING','RETRYING') THEN COALESCE(started_at, $2) ELSE started_at END,
       completed_at = CASE WHEN ${terminal} THEN $2 ELSE completed_at END,
       cancelled_at = CASE WHEN $1 = 'CANCELLED' THEN $2 ELSE cancelled_at END
       ${set.sql}
     WHERE id = $3 AND status = $4 AND version = $5 RETURNING *`,
    [t.to, t.now, t.task.id, t.task.status, t.task.version, ...set.values],
  );
  if (res.rowCount !== 1)
    throw new ConcurrencyConflictError('task', t.task.id, { status: t.task.status, version: t.task.version });
  await recordHistory(tx, t.now, {
    taskId: t.task.id,
    eventType: `task.${t.to.toLowerCase()}`,
    previousState: t.task.status,
    newState: t.to,
    payload: { ...(t.reason ? { reason: t.reason } : {}), ...(t.payload ?? {}) },
  });
  return res.rows[0]!;
}

/** Non-status task field update (still versioned and audited). */
export async function updateTaskFields(
  tx: Queryable,
  task: Pick<TaskRow, 'id' | 'version' | 'status'>,
  now: Date,
  patch: Partial<Record<(typeof TASK_PATCH)[number], unknown>>,
  history: { eventType: string; payload?: Record<string, unknown> },
): Promise<TaskRow> {
  const set = buildSet(patch, TASK_PATCH, 4);
  const res = await tx.query<TaskRow>(
    `UPDATE tasks SET version = version + 1, updated_at = $1 ${set.sql} WHERE id = $2 AND version = $3 RETURNING *`,
    [now, task.id, task.version, ...set.values],
  );
  if (res.rowCount !== 1) throw new ConcurrencyConflictError('task', task.id, { version: task.version });
  await recordHistory(tx, now, {
    taskId: task.id,
    eventType: history.eventType,
    newState: task.status,
    payload: history.payload,
  });
  return res.rows[0]!;
}

export interface StepTransition {
  step: Pick<StepRow, 'id' | 'task_id' | 'key' | 'status' | 'version'>;
  to: StepStatus;
  now: Date;
  attemptId?: string | null;
  patch?: Partial<Record<(typeof STEP_PATCH)[number], unknown>>;
  reason?: string;
  payload?: Record<string, unknown>;
}

export async function transitionStep(tx: Queryable, t: StepTransition): Promise<StepRow> {
  assertStepTransition(t.step.id, t.step.status, t.to);
  const patch = { ...(t.patch ?? {}) };
  if (t.to === 'COMPLETED' && patch.completed_at === undefined) patch.completed_at = t.now;
  const set = buildSet(patch, STEP_PATCH, 6);
  const res = await tx.query<StepRow>(
    `UPDATE steps SET status = $1, version = version + 1, updated_at = $2 ${set.sql}
     WHERE id = $3 AND status = $4 AND version = $5 RETURNING *`,
    [t.to, t.now, t.step.id, t.step.status, t.step.version, ...set.values],
  );
  if (res.rowCount !== 1)
    throw new ConcurrencyConflictError('step', t.step.id, { status: t.step.status, version: t.step.version });
  await recordHistory(tx, t.now, {
    taskId: t.step.task_id,
    stepId: t.step.id,
    attemptId: t.attemptId ?? null,
    eventType: `step.${t.to.toLowerCase()}`,
    previousState: t.step.status,
    newState: t.to,
    payload: { stepKey: t.step.key, ...(t.reason ? { reason: t.reason } : {}), ...(t.payload ?? {}) },
  });
  return res.rows[0]!;
}

export interface AttemptTransition {
  attempt: Pick<AttemptRow, 'id' | 'task_id' | 'step_id' | 'status' | 'version' | 'attempt_number'>;
  to: AttemptStatus;
  now: Date;
  patch?: Partial<Record<(typeof ATTEMPT_PATCH)[number], unknown>>;
  payload?: Record<string, unknown>;
}

export async function transitionAttempt(tx: Queryable, t: AttemptTransition): Promise<AttemptRow> {
  assertAttemptTransition(t.attempt.id, t.attempt.status, t.to);
  const patch = { completed_at: t.now, ...(t.patch ?? {}) };
  const set = buildSet(patch, ATTEMPT_PATCH, 5);
  const res = await tx.query<AttemptRow>(
    `UPDATE attempts SET status = $1, version = version + 1 ${set.sql}
     WHERE id = $2 AND status = $3 AND version = $4 RETURNING *`,
    [t.to, t.attempt.id, t.attempt.status, t.attempt.version, ...set.values],
  );
  if (res.rowCount !== 1)
    throw new ConcurrencyConflictError('attempt', t.attempt.id, { status: t.attempt.status });
  await recordHistory(tx, t.now, {
    taskId: t.attempt.task_id,
    stepId: t.attempt.step_id,
    attemptId: t.attempt.id,
    eventType: `attempt.${t.to.toLowerCase()}`,
    previousState: t.attempt.status,
    newState: t.to,
    payload: { attemptNumber: t.attempt.attempt_number, ...(t.payload ?? {}) },
  });
  return res.rows[0]!;
}

/** Ask an orchestrator to run a cycle for this task. Caller must hold (or be allowed to take) the task row lock. */
export async function wakeTask(tx: Queryable, taskId: string, now: Date): Promise<void> {
  await tx.query(`UPDATE tasks SET wake_at = LEAST(COALESCE(wake_at, $2), $2) WHERE id = $1`, [taskId, now]);
}

export async function lockTask(tx: Queryable, taskId: string): Promise<TaskRow | undefined> {
  const r = await tx.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 FOR NO KEY UPDATE`, [taskId]);
  return r.rows[0];
}

export async function lockStep(tx: Queryable, stepId: string): Promise<StepRow | undefined> {
  const r = await tx.query<StepRow>(`SELECT * FROM steps WHERE id = $1 FOR NO KEY UPDATE`, [stepId]);
  return r.rows[0];
}

export async function lockAttempt(tx: Queryable, attemptId: string): Promise<AttemptRow | undefined> {
  const r = await tx.query<AttemptRow>(`SELECT * FROM attempts WHERE id = $1 FOR UPDATE`, [attemptId]);
  return r.rows[0];
}
