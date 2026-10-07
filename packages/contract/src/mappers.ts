/**
 * Database rows (snake_case, Date) -> v1 DTOs (camelCase, ISO strings).
 * Inputs are structural so the contract does not depend on the engine.
 */
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const isoN = (d: Date | string | null | undefined) => (d ? iso(d) : null);

type Row = Record<string, unknown>;
const r = <T>(row: Row, k: string) => row[k] as T;

export function toTask(row: Row) {
  return {
    id: r<string>(row, 'id'),
    type: r<string>(row, 'type'),
    workflowVersion: r<number>(row, 'workflow_version'),
    status: r<string>(row, 'status'),
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    parentTaskId: (row.parent_task_id ?? null) as string | null,
    parentStepId: (row.parent_step_id ?? null) as string | null,
    failure: row.failure ?? null,
    compensationStatus: (row.compensation_status ?? null) as string | null,
    version: r<number>(row, 'version'),
    wakeAt: isoN(row.wake_at as Date | null),
    createdAt: iso(row.created_at as Date),
    updatedAt: iso(row.updated_at as Date),
    startedAt: isoN(row.started_at as Date | null),
    completedAt: isoN(row.completed_at as Date | null),
    cancelledAt: isoN(row.cancelled_at as Date | null),
  };
}

export function toStep(row: Row) {
  return {
    id: r<string>(row, 'id'),
    taskId: r<string>(row, 'task_id'),
    key: r<string>(row, 'key'),
    type: r<string>(row, 'type'),
    status: r<string>(row, 'status'),
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    executorType: (row.executor_type ?? null) as string | null,
    dependencies: (row.dependencies ?? []) as string[],
    parentStepId: (row.parent_step_id ?? null) as string | null,
    itemIndex: (row.item_index ?? null) as number | null,
    attemptCount: r<number>(row, 'attempt_count'),
    availableAt: iso(row.available_at as Date),
    concurrencyKey: (row.concurrency_key ?? null) as string | null,
    createdAt: iso(row.created_at as Date),
    updatedAt: iso(row.updated_at as Date),
    startedAt: isoN(row.started_at as Date | null),
    completedAt: isoN(row.completed_at as Date | null),
  };
}

export function toAttempt(row: Row) {
  return {
    id: r<string>(row, 'id'),
    stepId: r<string>(row, 'step_id'),
    attemptNumber: r<number>(row, 'attempt_number'),
    workerId: r<string>(row, 'worker_id'),
    status: r<string>(row, 'status'),
    leaseExpiresAt: iso(row.lease_expires_at as Date),
    heartbeatAt: isoN(row.heartbeat_at as Date | null),
    startedAt: iso(row.started_at as Date),
    completedAt: isoN(row.completed_at as Date | null),
    errorType: (row.error_type ?? null) as string | null,
    errorMessage: (row.error_message ?? null) as string | null,
  };
}

export const toChildTask = (row: Row) => ({
  id: r<string>(row, 'id'),
  type: r<string>(row, 'type'),
  status: r<string>(row, 'status'),
  parentStepId: (row.parent_step_id ?? null) as string | null,
  output: row.output ?? null,
  createdAt: iso(row.created_at as Date),
  completedAt: isoN(row.completed_at as Date | null),
});

export const toTaskEvent = (row: Row) => ({
  id: r<string>(row, 'id'),
  eventType: r<string>(row, 'event_type'),
  correlationKey: (row.correlation_key ?? null) as string | null,
  deduplicationKey: r<string>(row, 'deduplication_key'),
  createdAt: iso(row.created_at as Date),
  consumedAt: isoN(row.consumed_at as Date | null),
  consumedByStepId: (row.consumed_by_step_id ?? null) as string | null,
});

export const toTimer = (row: Row) => ({
  id: r<string>(row, 'id'),
  stepId: (row.step_id ?? null) as string | null,
  timerType: r<string>(row, 'timer_type'),
  fireAt: iso(row.fire_at as Date),
  status: r<string>(row, 'status'),
  createdAt: iso(row.created_at as Date),
  firedAt: isoN(row.fired_at as Date | null),
});

export const toArtifact = (row: Row) => ({
  id: r<string>(row, 'id'),
  stepId: (row.step_id ?? null) as string | null,
  attemptId: (row.attempt_id ?? null) as string | null,
  type: r<string>(row, 'type'),
  uri: r<string>(row, 'uri'),
  metadata: (row.metadata ?? {}) as Record<string, unknown>,
  createdAt: iso(row.created_at as Date),
});

export const toHistoryEvent = (row: Row) => ({
  id: Number(row.id),
  taskId: r<string>(row, 'task_id'),
  stepId: (row.step_id ?? null) as string | null,
  attemptId: (row.attempt_id ?? null) as string | null,
  eventType: r<string>(row, 'event_type'),
  previousState: (row.previous_state ?? null) as string | null,
  newState: (row.new_state ?? null) as string | null,
  payload: (row.payload ?? {}) as Record<string, unknown>,
  timestamp: iso(row.timestamp as Date),
});

export function toTaskDetail(d: {
  task: Row;
  steps: Row[];
  attempts: Row[];
  children: Row[];
  events: Row[];
  timers: Row[];
  artifacts: Row[];
}) {
  return {
    task: toTask(d.task),
    steps: d.steps.map(toStep),
    attempts: d.attempts.map(toAttempt),
    children: d.children.map(toChildTask),
    events: d.events.map(toTaskEvent),
    timers: d.timers.map(toTimer),
    artifacts: d.artifacts.map(toArtifact),
  };
}
