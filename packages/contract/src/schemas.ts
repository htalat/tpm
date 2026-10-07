import { z } from 'zod';
import {
  ATTEMPT_STATUSES,
  FAILURE_CATEGORIES,
  STEP_STATUSES,
  STEP_TYPES,
  TASK_STATUSES,
} from '@durable/core';

/**
 * The v1 API contract: every response body, as zod schemas. Field names are
 * camelCase; timestamps are ISO-8601 UTC strings. These schemas generate the
 * OpenAPI document and validate responses in tests and in the typed client.
 *
 * Compatibility rule for v1: fields may be ADDED; nothing is renamed, removed
 * or changes meaning without a /v2.
 */
const ts = z.iso.datetime();
const tsN = ts.nullable();
const uuid = z.uuid();
const json = z.unknown();
const record = z.record(z.string(), z.unknown());

export const ErrorBody = z
  .object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) })
  .meta({ id: 'Error', description: 'Every non-2xx response.' });

export const StepError = z
  .object({
    category: z.enum(FAILURE_CATEGORIES),
    message: z.string(),
    attempt: z.number().int().optional(),
    stepKey: z.string().optional(),
  })
  .meta({ id: 'StepError' });

export const Task = z
  .object({
    id: uuid,
    type: z.string(),
    workflowVersion: z.number().int(),
    status: z.enum(TASK_STATUSES),
    input: json,
    output: json,
    error: StepError.nullable(),
    metadata: record,
    parentTaskId: uuid.nullable(),
    parentStepId: uuid.nullable(),
    failure: StepError.nullable(),
    compensationStatus: z.enum(['RUNNING', 'COMPLETED', 'FAILED']).nullable(),
    version: z.number().int(),
    wakeAt: tsN,
    createdAt: ts,
    updatedAt: ts,
    startedAt: tsN,
    completedAt: tsN,
    cancelledAt: tsN,
  })
  .meta({ id: 'Task' });

export const Step = z
  .object({
    id: uuid,
    taskId: uuid,
    key: z.string(),
    type: z.enum(STEP_TYPES),
    status: z.enum(STEP_STATUSES),
    input: json,
    output: json,
    error: StepError.nullable(),
    executorType: z.string().nullable(),
    dependencies: z.array(z.string()),
    parentStepId: uuid.nullable(),
    itemIndex: z.number().int().nullable(),
    attemptCount: z.number().int(),
    availableAt: ts,
    concurrencyKey: z.string().nullable(),
    createdAt: ts,
    updatedAt: ts,
    startedAt: tsN,
    completedAt: tsN,
  })
  .meta({ id: 'Step' });

export const Attempt = z
  .object({
    id: uuid,
    stepId: uuid,
    attemptNumber: z.number().int(),
    workerId: uuid,
    status: z.enum(ATTEMPT_STATUSES),
    leaseExpiresAt: ts,
    heartbeatAt: tsN,
    startedAt: ts,
    completedAt: tsN,
    errorType: z.enum(FAILURE_CATEGORIES).nullable(),
    errorMessage: z.string().nullable(),
  })
  .meta({ id: 'Attempt' });

export const ChildTask = z
  .object({
    id: uuid,
    type: z.string(),
    status: z.enum(TASK_STATUSES),
    parentStepId: uuid.nullable(),
    output: json,
    createdAt: ts,
    completedAt: tsN,
  })
  .meta({ id: 'ChildTask' });

export const TaskEvent = z
  .object({
    id: uuid,
    eventType: z.string(),
    correlationKey: z.string().nullable(),
    deduplicationKey: z.string(),
    createdAt: ts,
    consumedAt: tsN,
    consumedByStepId: uuid.nullable(),
  })
  .meta({ id: 'TaskEvent' });

export const Timer = z
  .object({
    id: uuid,
    stepId: uuid.nullable(),
    timerType: z.string(),
    fireAt: ts,
    status: z.enum(['SCHEDULED', 'FIRED', 'CANCELLED']),
    createdAt: ts,
    firedAt: tsN,
  })
  .meta({ id: 'Timer' });

export const Artifact = z
  .object({
    id: uuid,
    stepId: uuid.nullable(),
    attemptId: uuid.nullable(),
    type: z.string(),
    uri: z.string(),
    metadata: record,
    createdAt: ts,
  })
  .meta({ id: 'Artifact' });

export const HistoryEvent = z
  .object({
    id: z.number().int(),
    taskId: uuid,
    stepId: uuid.nullable(),
    attemptId: uuid.nullable(),
    eventType: z.string(),
    previousState: z.string().nullable(),
    newState: z.string().nullable(),
    payload: record,
    timestamp: ts,
  })
  .meta({ id: 'HistoryEvent', description: 'One durable, append-only history row.' });

export const TaskDetail = z
  .object({
    task: Task,
    steps: z.array(Step),
    attempts: z.array(Attempt),
    children: z.array(ChildTask),
    events: z.array(TaskEvent),
    timers: z.array(Timer),
    artifacts: z.array(Artifact),
  })
  .meta({ id: 'TaskDetail' });

export const Workflow = z
  .object({
    name: z.string(),
    version: z.number().int(),
    description: z.string().nullable(),
    steps: z.array(z.string()),
  })
  .meta({ id: 'Workflow' });

export const WorkItem = z
  .object({
    taskId: uuid,
    stepId: uuid,
    stepKey: z.string(),
    attemptId: uuid,
    attemptNumber: z.number().int(),
    type: z.string(),
    input: json,
    context: z.object({
      taskType: z.string(),
      previousAttempt: z
        .object({
          attemptNumber: z.number().int(),
          status: z.string(),
          errorType: z.string().nullable(),
          errorMessage: z.string().nullable(),
        })
        .nullable(),
      recoveringAmbiguous: z.boolean(),
    }),
    idempotencyKey: z.string(),
    leaseToken: uuid,
    leaseExpiresAt: ts,
    leaseMs: z.number().int(),
    timeoutMs: z.number().int(),
    deadlineAt: ts,
  })
  .meta({ id: 'WorkItem' });

export const HeartbeatResponse = z
  .object({ leaseExpiresAt: ts, cancelRequested: z.boolean() })
  .meta({ id: 'HeartbeatResponse' });
export const CompletionResponse = z
  .object({ status: z.enum(['ACCEPTED', 'ALREADY_ACCEPTED']) })
  .meta({ id: 'CompletionResponse' });

// ---- agent runs (software factory read model) ----------------------------------------------------

export const AgentRun = z
  .object({
    id: uuid,
    ref: z.string(),
    repo: z.string(),
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    round: z.number().int(),
    maxRounds: z.number().int().optional(),
    status: z.enum(TASK_STATUSES),
    step: z.object({ key: z.string(), status: z.string() }).nullable(),
    steps: z.array(z.object({ key: z.string(), status: z.string() })),
    prUrl: z.string().nullable(),
    headSha: z.string().nullable(),
    watch: z
      .object({ kind: z.string(), reason: z.string(), level: z.string().nullable(), checkedAt: ts })
      .nullable(),
    outcome: z.object({ kind: z.string(), reason: z.string() }).nullable(),
    decision: z.string().nullable(),
    attention: z
      .object({ kind: z.enum(['approve', 'human', 'failed', 'blocked']), reason: z.string() })
      .nullable(),
    costUsd: z.number(),
    createdAt: ts,
    updatedAt: ts,
    completedAt: tsN,
  })
  .meta({ id: 'AgentRun', description: 'One round of agent work on one tracker item.' });

export const AgentRunsOverview = z
  .object({
    active: z.number().int(),
    attention: z.number().int(),
    mergedLast24h: z.number().int(),
    failedLast24h: z.number().int(),
    costLast24hUsd: z.number(),
  })
  .meta({ id: 'AgentRunsOverview' });

export const AgentRunList = z
  .object({
    runs: z.array(AgentRun),
    overview: AgentRunsOverview,
    repos: z.array(z.object({ name: z.string(), factory: z.boolean() })),
  })
  .meta({ id: 'AgentRunList' });

export const AgentRunDetail = z
  .object({ run: AgentRun, history: z.array(HistoryEvent) })
  .meta({ id: 'AgentRunDetail' });

export const Ok = z.object({ ok: z.literal(true) }).meta({ id: 'Ok' });

// ---- live events (SSE) ----------------------------------------------------------------------------

export const LiveEvent = z
  .object({
    /** task_history id ("history" events) or a sequence number. */
    id: z.number().int(),
    kind: z.enum(['history', 'watch']),
    taskId: uuid,
    taskType: z.string(),
    stepId: uuid.nullable(),
    eventType: z.string(),
    newState: z.string().nullable(),
    at: ts,
  })
  .meta({ id: 'LiveEvent', description: 'Pushed on GET /v1/events after the change is committed.' });
