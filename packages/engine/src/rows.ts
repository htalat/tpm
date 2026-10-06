import type {
  AttemptStatus,
  ChildState,
  EventState,
  FailureCategory,
  RetryPolicy,
  StepError,
  StepState,
  StepStatus,
  StepType,
  TaskState,
  TaskStatus,
} from '@durable/core';

export interface TaskRow {
  id: string;
  type: string;
  workflow_version: number;
  status: TaskStatus;
  input: unknown;
  output: unknown;
  error: StepError | null;
  metadata: Record<string, unknown>;
  parent_task_id: string | null;
  parent_step_id: string | null;
  failure: (StepError & { stepKey: string }) | null;
  compensation_status: 'RUNNING' | 'COMPLETED' | 'FAILED' | null;
  wake_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

export interface StepRow {
  id: string;
  task_id: string;
  key: string;
  type: StepType;
  status: StepStatus;
  input: unknown;
  output: unknown;
  error: StepError | null;
  executor_type: string | null;
  dependencies: string[];
  parent_step_id: string | null;
  item_index: number | null;
  config: { workflow?: string } | null;
  wait: { eventType: string; correlationKey: string | null } | null;
  retry_policy: RetryPolicy;
  timeout_ms: number;
  effect: 'pure' | 'idempotent' | 'unsafe';
  idempotency_key: string;
  attempt_count: number;
  uncharged_attempts: number;
  concurrency_key: string | null;
  concurrency_limit: number | null;
  available_at: Date;
  version: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface AttemptRow {
  id: string;
  task_id: string;
  step_id: string;
  attempt_number: number;
  worker_id: string;
  status: AttemptStatus;
  lease_token: string;
  lease_expires_at: Date;
  deadline_at: Date;
  heartbeat_at: Date | null;
  started_at: Date;
  completed_at: Date | null;
  output: unknown;
  error_type: FailureCategory | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  version: number;
}

export interface EventRow {
  id: string;
  task_id: string;
  step_id: string | null;
  event_type: string;
  correlation_key: string | null;
  deduplication_key: string;
  payload: unknown;
  created_at: Date;
  consumed_at: Date | null;
  consumed_by_step_id: string | null;
}

export interface TimerRow {
  id: string;
  task_id: string;
  step_id: string | null;
  timer_type: 'SLEEP';
  fire_at: Date;
  status: 'SCHEDULED' | 'FIRED' | 'CANCELLED';
  payload: unknown;
  created_at: Date;
  fired_at: Date | null;
}

export interface HistoryRow {
  id: number;
  task_id: string;
  step_id: string | null;
  attempt_id: string | null;
  event_type: string;
  previous_state: string | null;
  new_state: string | null;
  payload: Record<string, unknown>;
  timestamp: Date;
}

export const toTaskState = (t: TaskRow): TaskState => ({
  id: t.id,
  type: t.type,
  status: t.status,
  input: t.input,
  failure: t.failure,
  compensationStatus: t.compensation_status,
});

export const toStepState = (s: StepRow): StepState => ({
  id: s.id,
  key: s.key,
  type: s.type,
  status: s.status,
  input: s.input,
  output: s.output,
  error: s.error,
  dependencies: s.dependencies,
  parentStepId: s.parent_step_id,
  itemIndex: s.item_index,
  wait: s.wait,
  config: s.config,
  completedAt: s.completed_at,
});

export const toEventState = (e: EventRow): EventState => ({
  id: e.id,
  eventType: e.event_type,
  correlationKey: e.correlation_key,
  payload: e.payload,
});

export const toChildState = (t: TaskRow): ChildState => ({
  id: t.id,
  parentStepId: t.parent_step_id,
  status: t.status,
  output: t.output,
});

/** jsonb parameters are always serialized explicitly (pg would turn JS arrays into SQL arrays). */
export const j = (v: unknown): string => JSON.stringify(v === undefined ? null : v);
