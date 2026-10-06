import {
  ConcurrencyConflictError,
  decide,
  TIMER_EVENT_TYPE,
  type Command,
  type CompiledWorkflow,
  type Snapshot,
} from '@durable/core';
import { withRetryingTransaction, type Queryable } from '@durable/db';
import { withSpan } from '@durable/observability';
import type { EngineDeps } from './deps';
import {
  j,
  toChildState,
  toEventState,
  toStepState,
  toTaskState,
  type EventRow,
  type StepRow,
  type TaskRow,
} from './rows';
import { cancelStepResources, createTaskTx, insertSteps } from './tasks';
import { recordHistory, transitionStep, transitionTask, updateTaskFields, wakeTask } from './transitions';

const MAX_ITERATIONS_PER_CYCLE = 25;
const POISON_BACKOFF_MS = 30_000;

/**
 * One orchestration pass: repeatedly pick a task whose wake_at is due (SKIP
 * LOCKED, so many orchestrators can run side by side without coordinating),
 * run a full cycle for it in a single transaction, and commit.
 *
 * Cycle = LOAD -> RECONCILE/DECIDE -> PERSIST, looped until `decide` has
 * nothing left to do. If the process dies mid-cycle the transaction rolls back
 * and wake_at is still set, so the next orchestrator simply redoes the cycle.
 */
export async function runOrchestrationPass(deps: EngineDeps, maxTasks = 50): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxTasks; i++) {
    const st = { picked: null as string | null, timerRegistered: false };
    try {
      const id = await withRetryingTransaction(deps.pool, async (tx) => {
        st.timerRegistered = false;
        const now = deps.clock.now();
        const task = (
          await tx.query<TaskRow>(
            `SELECT * FROM tasks WHERE wake_at <= $1 ORDER BY wake_at LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED`,
            [now],
          )
        ).rows[0];
        if (!task) return null;
        st.picked = task.id;
        const res = await withSpan('durable.orchestrate', { 'durable.task_id': task.id }, () =>
          runCycle(tx, deps, task),
        );
        st.timerRegistered = res.timerRegistered;
        return task.id;
      });
      if (!id) break;
      processed++;
      if (st.timerRegistered) deps.injector.hit('AFTER_TIMER_REGISTRATION');
    } catch (e) {
      const picked = st.picked;
      if (!picked || (e instanceof Error && e.name === 'SimulatedCrash')) throw e;
      // A task whose cycle keeps failing (bug, missing definition) must not
      // starve the others: log it and postpone it.
      deps.logger.error(
        { task_id: picked, err: e, event_type: 'orchestration.error' },
        'orchestration cycle failed',
      );
      if (!(e instanceof ConcurrencyConflictError)) {
        await deps.pool.query(`UPDATE tasks SET wake_at = $2 WHERE id = $1`, [
          picked,
          new Date(deps.clock.now().getTime() + POISON_BACKOFF_MS),
        ]);
      }
    }
  }
  return processed;
}

async function loadSnapshot(
  tx: Queryable,
  task: TaskRow,
  now: Date,
): Promise<{ snap: Snapshot; steps: Map<string, StepRow> }> {
  const steps = (
    await tx.query<StepRow>(
      `SELECT * FROM steps WHERE task_id = $1 ORDER BY created_at, item_index NULLS FIRST, key FOR NO KEY UPDATE`,
      [task.id],
    )
  ).rows;
  const events = (
    await tx.query<EventRow>(
      `SELECT * FROM events WHERE task_id = $1 AND consumed_at IS NULL ORDER BY created_at, id`,
      [task.id],
    )
  ).rows;
  const children = (await tx.query<TaskRow>(`SELECT * FROM tasks WHERE parent_task_id = $1`, [task.id])).rows;
  return {
    snap: {
      task: toTaskState(task),
      steps: steps.map(toStepState),
      events: events.map(toEventState),
      children: children.map(toChildState),
      now,
    },
    steps: new Map(steps.map((s) => [s.id, s])),
  };
}

export async function runCycle(
  tx: Queryable,
  deps: EngineDeps,
  initial: TaskRow,
): Promise<{ timerRegistered: boolean }> {
  const def = deps.registry.get(initial.type, initial.workflow_version);
  if (!def)
    throw new Error(`workflow ${initial.type}@${initial.workflow_version} is not registered in this process`);
  let task = initial;
  let timerRegistered = false;
  let settled = false;
  for (let i = 0; i < MAX_ITERATIONS_PER_CYCLE; i++) {
    const now = deps.clock.now();
    const { snap, steps } = await loadSnapshot(tx, task, now);
    const commands = decide(def, snap);
    if (commands.length === 0) {
      settled = true;
      break;
    }
    for (const cmd of commands) {
      const r = await applyCommand(tx, deps, def, task, steps, cmd, now);
      task = r.task;
      timerRegistered ||= r.timerRegistered;
    }
    deps.injector.hit('MID_ORCHESTRATION_CYCLE');
  }
  // Only clear the wake flag when the task has reached a fixed point.
  if (settled) await tx.query(`UPDATE tasks SET wake_at = NULL WHERE id = $1`, [task.id]);
  return { timerRegistered };
}

async function applyCommand(
  tx: Queryable,
  deps: EngineDeps,
  def: CompiledWorkflow,
  task: TaskRow,
  steps: Map<string, StepRow>,
  cmd: Command,
  now: Date,
): Promise<{ task: TaskRow; timerRegistered: boolean }> {
  const stepOf = (id: string) => {
    const s = steps.get(id);
    if (!s) throw new Error(`command ${cmd.kind} references unknown step ${id}`);
    return s;
  };
  const same = { task, timerRegistered: false };
  switch (cmd.kind) {
    case 'promote':
      await transitionStep(tx, {
        step: stepOf(cmd.stepId),
        to: 'READY',
        now,
        patch: { input: cmd.input, available_at: now },
      });
      return same;

    case 'startWait':
      await transitionStep(tx, {
        step: stepOf(cmd.stepId),
        to: 'WAITING',
        now,
        patch: { input: cmd.input, wait: { eventType: cmd.eventType, correlationKey: cmd.correlationKey } },
        payload: { waitingFor: cmd.eventType, correlationKey: cmd.correlationKey },
      });
      return same;

    case 'startSleep': {
      const s = stepOf(cmd.stepId);
      deps.injector.hit('BEFORE_TIMER_REGISTRATION');
      const timerId = deps.ids.next();
      await tx.query(
        `INSERT INTO timers (id, task_id, step_id, timer_type, fire_at, status, payload, created_at)
         VALUES ($1,$2,$3,'SLEEP',$4,'SCHEDULED',$5,$6)
         ON CONFLICT (step_id, timer_type) WHERE step_id IS NOT NULL DO NOTHING`,
        [timerId, task.id, s.id, cmd.fireAt, j({ durationMs: cmd.durationMs }), now],
      );
      await recordHistory(tx, now, {
        taskId: task.id,
        stepId: s.id,
        eventType: 'timer.scheduled',
        newState: 'SCHEDULED',
        payload: { stepKey: s.key, fireAt: cmd.fireAt, durationMs: cmd.durationMs },
      });
      await transitionStep(tx, {
        step: s,
        to: 'WAITING',
        now,
        patch: {
          input: { durationMs: cmd.durationMs, fireAt: cmd.fireAt },
          wait: { eventType: TIMER_EVENT_TYPE, correlationKey: s.id },
        },
        payload: { waitingFor: 'timer', fireAt: cmd.fireAt },
      });
      return { task, timerRegistered: true };
    }

    case 'spawnChild': {
      const s = stepOf(cmd.stepId);
      const child = await createTaskTx(tx, deps, {
        type: cmd.workflow,
        input: cmd.input,
        metadata: { parentTaskId: task.id, parentStepKey: s.key },
        parent: { taskId: task.id, stepId: s.id },
      });
      await recordHistory(tx, now, {
        taskId: task.id,
        stepId: s.id,
        eventType: 'child.spawned',
        payload: { stepKey: s.key, childTaskId: child.id, workflow: cmd.workflow },
      });
      await transitionStep(tx, {
        step: s,
        to: 'WAITING',
        now,
        patch: { input: cmd.input },
        payload: { childTaskId: child.id },
      });
      return same;
    }

    case 'expandMap': {
      const s = stepOf(cmd.stepId);
      await insertSteps(tx, deps, task.id, cmd.items, now);
      await transitionStep(tx, {
        step: s,
        to: 'WAITING',
        now,
        patch: { input: { itemCount: cmd.items.length } },
        payload: { itemCount: cmd.items.length },
      });
      return same;
    }

    case 'completeStep': {
      const s = stepOf(cmd.stepId);
      if (cmd.consumeEventId) {
        const r = await tx.query(
          `UPDATE events SET consumed_at = $2, consumed_by_step_id = $3 WHERE id = $1 AND consumed_at IS NULL`,
          [cmd.consumeEventId, now, s.id],
        );
        if (r.rowCount !== 1) throw new ConcurrencyConflictError('event', cmd.consumeEventId, 'unconsumed');
      }
      await transitionStep(tx, {
        step: s,
        to: 'COMPLETED',
        now,
        patch: { output: cmd.output },
        payload: cmd.consumeEventId ? { eventId: cmd.consumeEventId } : {},
      });
      return same;
    }

    case 'failStep':
      await transitionStep(tx, {
        step: stepOf(cmd.stepId),
        to: 'FAILED',
        now,
        patch: { error: cmd.error },
        reason: cmd.error.message,
      });
      return same;

    case 'skipStep': {
      const s = stepOf(cmd.stepId);
      await transitionStep(tx, { step: s, to: 'SKIPPED', now, reason: cmd.reason });
      await cancelStepResources(tx, deps, s, cmd.reason);
      return same;
    }

    case 'recordFailure':
      return {
        task: await updateTaskFields(
          tx,
          task,
          now,
          { failure: cmd.failure },
          { eventType: 'task.failure_recorded', payload: { ...cmd.failure } },
        ),
        timerRegistered: false,
      };

    case 'startCompensation': {
      await insertSteps(tx, deps, task.id, cmd.steps, now);
      return {
        task: await updateTaskFields(
          tx,
          task,
          now,
          { compensation_status: 'RUNNING' },
          { eventType: 'task.compensation_started', payload: { steps: cmd.steps.map((s) => s.key) } },
        ),
        timerRegistered: false,
      };
    }

    case 'setTaskStatus':
      return { task: await transitionTask(tx, { task, to: cmd.to, now }), timerRegistered: false };

    case 'finishTask': {
      const finished = await transitionTask(tx, {
        task,
        to: cmd.to,
        now,
        patch: { output: cmd.output, error: cmd.error, compensation_status: cmd.compensationStatus },
        payload: cmd.compensationStatus ? { compensation: cmd.compensationStatus } : {},
      });
      if (cmd.to === 'COMPLETED') deps.metrics.tasksCompleted.inc({ type: def.name });
      else deps.metrics.tasksFailed.inc({ type: def.name });
      deps.logger.info(
        { task_id: task.id, event_type: `task.${cmd.to.toLowerCase()}` },
        `task ${cmd.to.toLowerCase()}`,
      );
      if (task.parent_task_id) await wakeTask(tx, task.parent_task_id, now);
      return { task: finished, timerRegistered: false };
    }
  }
}
