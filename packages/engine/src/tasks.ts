import { createHash } from 'node:crypto';
import {
  assertPayloadSize,
  DomainError,
  initialSteps,
  isTerminalTask,
  NotFoundError,
  type NewStep,
  type StepError,
} from '@durable/core';
import type { Queryable } from '@durable/db';
import type { EngineDeps } from './deps';
import { j, type StepRow, type TaskRow } from './rows';
import { lockTask, recordHistory, transitionStep, transitionTask, wakeTask } from './transitions';

export interface CreateTaskInput {
  type: string;
  input: unknown;
  metadata?: Record<string, unknown>;
  parent?: { taskId: string; stepId: string };
}

/** Insert a task and all of its initial steps. Must run inside a transaction. */
export async function createTaskTx(
  tx: Queryable,
  deps: EngineDeps,
  req: CreateTaskInput,
  id = deps.ids.next(),
): Promise<TaskRow> {
  const def = deps.registry.get(req.type);
  if (!def)
    throw new DomainError('VALIDATION_ERROR', `unknown workflow type "${req.type}"`, { type: req.type });
  assertPayloadSize('input', req.input);
  assertPayloadSize('metadata', req.metadata ?? {});
  let input: unknown = req.input ?? null;
  if (def.spec.input) {
    const parsed = def.spec.input.safeParse(input);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', `invalid input for ${req.type}`, {
        issues: parsed.error.issues,
      });
    }
    input = parsed.data;
  }
  const now = deps.clock.now();
  const res = await tx.query<TaskRow>(
    `INSERT INTO tasks (id, type, workflow_version, status, input, metadata, parent_task_id, parent_step_id,
                        wake_at, version, created_at, updated_at)
     VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,0,$8,$8) RETURNING *`,
    [
      id,
      def.name,
      def.version,
      j(input),
      j(req.metadata ?? {}),
      req.parent?.taskId ?? null,
      req.parent?.stepId ?? null,
      now,
    ],
  );
  await insertSteps(tx, deps, id, initialSteps(def), now);
  await recordHistory(tx, now, {
    taskId: id,
    eventType: 'task.created',
    newState: 'PENDING',
    payload: { type: def.name, workflowVersion: def.version, parentTaskId: req.parent?.taskId ?? null },
  });
  deps.metrics.tasksCreated.inc({ type: def.name });
  return res.rows[0]!;
}

export async function insertSteps(
  tx: Queryable,
  deps: EngineDeps,
  taskId: string,
  steps: NewStep[],
  now: Date,
): Promise<void> {
  for (const s of steps) {
    await tx.query(
      `INSERT INTO steps (id, task_id, key, type, status, input, executor_type, dependencies, parent_step_id, item_index,
                          config, retry_policy, timeout_ms, effect, idempotency_key, available_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$15)`,
      [
        deps.ids.next(),
        taskId,
        s.key,
        s.type,
        j(s.input),
        s.executorType,
        s.dependencies,
        s.parentStepId,
        s.itemIndex,
        s.config ? j(s.config) : null,
        j(s.retryPolicy),
        s.timeoutMs,
        s.effect,
        // Stable across attempts and restarts: the key workers hand to external systems.
        `${taskId}:${s.key}`,
        now,
      ],
    );
  }
}

const requestHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * Create a task, optionally idempotently. The idempotency record is inserted
 * first: a concurrent duplicate blocks on the unique key until we commit, then
 * observes our record and returns the same task.
 */
export async function createTaskIdempotent(
  tx: Queryable,
  deps: EngineDeps,
  req: CreateTaskInput,
  idempotencyKey?: string,
): Promise<{ task: TaskRow; created: boolean }> {
  if (!idempotencyKey) return { task: await createTaskTx(tx, deps, req), created: true };
  const id = deps.ids.next();
  const hash = requestHash({ type: req.type, input: req.input ?? null, metadata: req.metadata ?? {} });
  const ins = await tx.query(
    `INSERT INTO idempotency_records (scope, key, request_hash, response, created_at)
     VALUES ('tasks.create', $1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING key`,
    [idempotencyKey, hash, j({ taskId: id }), deps.clock.now()],
  );
  if (ins.rowCount === 1) return { task: await createTaskTx(tx, deps, req, id), created: true };
  const existing = await tx.query<{ request_hash: string; response: { taskId: string } }>(
    `SELECT request_hash, response FROM idempotency_records WHERE scope = 'tasks.create' AND key = $1`,
    [idempotencyKey],
  );
  const rec = existing.rows[0]!;
  if (rec.request_hash !== hash) {
    throw new DomainError('IDEMPOTENCY_MISMATCH', 'idempotency key was used with a different request', {
      idempotencyKey,
    });
  }
  const task = await tx.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [rec.response.taskId]);
  return { task: task.rows[0]!, created: false };
}

const CANCELLABLE_STEP = new Set(['PENDING', 'READY', 'WAITING', 'RETRYING', 'BLOCKED']);

/**
 * Cancel a task (and, recursively, its non-terminal children).
 * - persists intent (task -> CANCELLED) so no new work is claimed or scheduled
 * - cancels not-yet-running steps and their timers
 * - leaves RUNNING attempts alone: their workers learn about the cancellation
 *   on the next heartbeat; a completion that still arrives is recorded truthfully
 * - never pretends completed side effects were undone
 */
export async function cancelTaskTx(
  tx: Queryable,
  deps: EngineDeps,
  taskId: string,
  reason: string,
): Promise<{ task: TaskRow; alreadyCancelled: boolean }> {
  const now = deps.clock.now();
  const task = await lockTask(tx, taskId);
  if (!task) throw new NotFoundError('task', taskId);
  if (task.status === 'CANCELLED') return { task, alreadyCancelled: true };
  if (isTerminalTask(task.status)) {
    throw new DomainError('TASK_TERMINAL', `task ${taskId} is already ${task.status}`, {
      status: task.status,
    });
  }
  const cancelled = await transitionTask(tx, { task, to: 'CANCELLED', now, reason });
  const steps = (
    await tx.query<StepRow>(`SELECT * FROM steps WHERE task_id = $1 ORDER BY created_at FOR NO KEY UPDATE`, [
      taskId,
    ])
  ).rows;
  for (const s of steps) {
    if (CANCELLABLE_STEP.has(s.status)) {
      await transitionStep(tx, { step: s, to: 'CANCELLED', now, reason: 'task cancelled' });
      await cancelStepResources(tx, deps, s, 'parent task cancelled');
    } else if (s.status === 'RUNNING') {
      await recordHistory(tx, now, {
        taskId,
        stepId: s.id,
        eventType: 'step.cancel_requested',
        newState: 'RUNNING',
        payload: { stepKey: s.key, note: 'worker will observe cancellation on heartbeat' },
      });
    }
  }
  if (task.parent_task_id) await wakeTask(tx, task.parent_task_id, now);
  deps.metrics.tasksCancelled.inc({ type: task.type });
  return { task: cancelled, alreadyCancelled: false };
}

/** Release what a non-running step holds: its timer or its child task. */
export async function cancelStepResources(
  tx: Queryable,
  deps: EngineDeps,
  s: StepRow,
  reason: string,
): Promise<void> {
  if (s.type === 'sleep') {
    await tx.query(`UPDATE timers SET status = 'CANCELLED' WHERE step_id = $1 AND status = 'SCHEDULED'`, [
      s.id,
    ]);
  }
  if (s.type === 'child') {
    const child = await tx.query<{ id: string; status: TaskRow['status'] }>(
      `SELECT id, status FROM tasks WHERE parent_step_id = $1`,
      [s.id],
    );
    const c = child.rows[0];
    if (c && !isTerminalTask(c.status)) await cancelTaskTx(tx, deps, c.id, reason);
  }
}

const PAUSABLE = new Set(['PENDING', 'READY', 'RUNNING', 'WAITING', 'RETRYING', 'BLOCKED']);

export async function pauseTaskTx(tx: Queryable, deps: EngineDeps, taskId: string): Promise<TaskRow> {
  const task = await lockTask(tx, taskId);
  if (!task) throw new NotFoundError('task', taskId);
  if (task.status === 'PAUSED') return task;
  if (!PAUSABLE.has(task.status))
    throw new DomainError('TASK_TERMINAL', `cannot pause a ${task.status} task`);
  return transitionTask(tx, { task, to: 'PAUSED', now: deps.clock.now(), reason: 'pause requested' });
}

export async function resumeTaskTx(tx: Queryable, deps: EngineDeps, taskId: string): Promise<TaskRow> {
  const task = await lockTask(tx, taskId);
  if (!task) throw new NotFoundError('task', taskId);
  if (task.status !== 'PAUSED') {
    if (isTerminalTask(task.status))
      throw new DomainError('TASK_TERMINAL', `cannot resume a ${task.status} task`);
    return task;
  }
  const now = deps.clock.now();
  const resumed = await transitionTask(tx, { task, to: 'READY', now, reason: 'resume requested' });
  await wakeTask(tx, taskId, now);
  return resumed;
}

/** Operator resolution of a BLOCKED step (an ambiguous outcome nobody could reconcile). */
export async function resolveStepTx(
  tx: Queryable,
  deps: EngineDeps,
  taskId: string,
  stepKey: string,
  action: 'retry' | 'complete' | 'fail',
  output: unknown,
  reason: string,
): Promise<StepRow> {
  const now = deps.clock.now();
  const task = await lockTask(tx, taskId);
  if (!task) throw new NotFoundError('task', taskId);
  const s = (
    await tx.query<StepRow>(`SELECT * FROM steps WHERE task_id = $1 AND key = $2 FOR NO KEY UPDATE`, [
      taskId,
      stepKey,
    ])
  ).rows[0];
  if (!s) throw new NotFoundError('step', stepKey);
  if (s.status !== 'BLOCKED')
    throw new DomainError('CONFLICT', `step ${stepKey} is ${s.status}, not BLOCKED`);
  const error: StepError = { category: 'POLICY', message: `operator: ${reason}` };
  const step =
    action === 'retry'
      ? await transitionStep(tx, { step: s, to: 'READY', now, reason, patch: { available_at: now } })
      : action === 'complete'
        ? await transitionStep(tx, {
            step: s,
            to: 'COMPLETED',
            now,
            reason,
            patch: { output: output ?? null },
          })
        : await transitionStep(tx, { step: s, to: 'FAILED', now, reason, patch: { error } });
  if (task.status === 'BLOCKED')
    await transitionTask(tx, { task, to: 'READY', now, reason: 'blocked step resolved' });
  await wakeTask(tx, taskId, now);
  return step;
}

export async function getTaskDetails(db: Queryable, taskId: string) {
  const task = (await db.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
  if (!task) throw new NotFoundError('task', taskId);
  const [steps, attempts, children, events, timers, artifacts] = await Promise.all([
    db.query(`SELECT * FROM steps WHERE task_id = $1 ORDER BY created_at, item_index NULLS FIRST, key`, [
      taskId,
    ]),
    db.query(
      `SELECT id, step_id, attempt_number, worker_id, status, lease_expires_at, heartbeat_at, started_at, completed_at,
              error_type, error_message
       FROM attempts WHERE task_id = $1 ORDER BY started_at, attempt_number`,
      [taskId],
    ),
    db.query(
      `SELECT id, type, status, parent_step_id, output, created_at, completed_at FROM tasks WHERE parent_task_id = $1 ORDER BY created_at`,
      [taskId],
    ),
    db.query(
      `SELECT id, event_type, correlation_key, deduplication_key, created_at, consumed_at, consumed_by_step_id FROM events WHERE task_id = $1 ORDER BY created_at`,
      [taskId],
    ),
    db.query(`SELECT * FROM timers WHERE task_id = $1 ORDER BY created_at`, [taskId]),
    db.query(`SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at`, [taskId]),
  ]);
  return {
    task,
    steps: steps.rows,
    attempts: attempts.rows,
    children: children.rows,
    events: events.rows,
    timers: timers.rows,
    artifacts: artifacts.rows,
  };
}
