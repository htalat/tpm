# State machines

All status changes go through three functions in
`packages/engine/src/transitions.ts`: `transitionTask`, `transitionStep`,
`transitionAttempt`. Each one:

1. checks `from -> to` against the tables in `packages/core/src/status.ts`
   (`InvalidTransitionError` if not allowed),
2. runs `UPDATE … WHERE id = $id AND status = $from AND version = $version`
   (`ConcurrencyConflictError` if no row matched),
3. inserts a `task_history` row in the same transaction.

No other code writes a `status` column.

## Task

READY, RUNNING, WAITING and RETRYING are **summary statuses** derived by the
orchestrator from the steps. Claims do not update the task row (to avoid a
lock on every claim), so the summary can lag by one cycle. The authoritative
progress is in the steps.

```mermaid
stateDiagram-v2
  [*] --> PENDING: created
  PENDING --> READY
  state Active {
    READY --> RUNNING
    RUNNING --> WAITING
    WAITING --> READY
    RUNNING --> RETRYING
    RETRYING --> READY
  }
  Active --> BLOCKED: a step has an unresolved AMBIGUOUS outcome
  BLOCKED --> Active: operator resolves the step
  Active --> PAUSED: pause
  BLOCKED --> PAUSED
  PAUSED --> READY: resume
  Active --> COMPLETED: all steps completed
  Active --> FAILED: a step failed (after compensation)
  Active --> CANCELLED: cancel
  BLOCKED --> CANCELLED
  PAUSED --> CANCELLED
  BLOCKED --> FAILED
  COMPLETED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
```

Derivation (first match): any step BLOCKED → BLOCKED; RUNNING → RUNNING;
READY → READY; RETRYING → RETRYING; WAITING → WAITING.

Terminal: COMPLETED, FAILED, CANCELLED. No outgoing edges.

## Step

```mermaid
stateDiagram-v2
  [*] --> PENDING
  PENDING --> READY: dependencies completed (worker step)
  PENDING --> WAITING: wait / sleep / child / map started
  PENDING --> FAILED: input function threw
  READY --> RUNNING: claimed (attempt created)
  RUNNING --> COMPLETED: authoritative completion
  RUNNING --> RETRYING: retryable failure / expired lease (retry time persisted)
  RUNNING --> FAILED: permanent / retries exhausted
  RUNNING --> BLOCKED: ambiguous and not safely retryable
  RETRYING --> READY: available_at reached
  WAITING --> COMPLETED: event consumed / timer fired / child or map done
  WAITING --> FAILED: child failed / map item failed
  BLOCKED --> READY: operator "retry"
  BLOCKED --> COMPLETED: operator "complete"
  BLOCKED --> FAILED: operator "fail"
  PENDING --> SKIPPED: task failed elsewhere
  READY --> SKIPPED
  WAITING --> SKIPPED
  RETRYING --> SKIPPED
  PENDING --> CANCELLED: task cancelled
  READY --> CANCELLED
  WAITING --> CANCELLED
  RETRYING --> CANCELLED
  BLOCKED --> CANCELLED
  RUNNING --> CANCELLED: worker gave up after cancellation
  COMPLETED --> [*]
  FAILED --> [*]
  SKIPPED --> [*]
  CANCELLED --> [*]
```

There is **no edge out of COMPLETED** (Invariant 1).

Step types: `task` (worker), `map` (fan-out parent), `wait_event`, `sleep`,
`child`, `compensation` (worker). Map items are `task` or `child` steps with a
`parent_step_id`.

## Attempt

```mermaid
stateDiagram-v2
  [*] --> RUNNING: claim (lease token + lease expiry + deadline)
  RUNNING --> COMPLETED: complete with matching token
  RUNNING --> FAILED: fail with matching token
  RUNNING --> EXPIRED: reaper (lease or deadline passed)
  COMPLETED --> [*]
  FAILED --> [*]
  EXPIRED --> [*]
```

A retry never reuses an attempt: it creates attempt `n+1` with a new token.
A partial unique index allows at most one RUNNING attempt per step.

## Timer

`SCHEDULED -> FIRED` (scheduler) or `SCHEDULED -> CANCELLED` (step skipped or
task cancelled). One timer per sleep step (unique index).

## Event

Inserted unconsumed. `consumed_at`/`consumed_by_step_id` are set once, in the
orchestration cycle that completes the waiting step. A step consumes at most one
event (unique index on `consumed_by_step_id`).

## Failure and compensation flow

```mermaid
flowchart TD
  F[step FAILED] --> R[task.failure recorded]
  R --> S[skip PENDING/READY/WAITING/RETRYING steps]
  S --> W{any step RUNNING?}
  W -- yes --> WAIT[wait for it to finish or expire]
  WAIT --> W
  W -- no --> C{completed steps with compensate?}
  C -- no --> TF[task FAILED]
  C -- yes --> CS[create compensation steps<br/>reverse completion order, chained]
  CS --> CR[run them as normal durable work]
  CR --> OK{all completed?}
  OK -- yes --> TF2[task FAILED, compensation_status COMPLETED]
  OK -- a compensation failed --> TF3[task FAILED, compensation_status FAILED]
```
