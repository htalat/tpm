# Failure model

The rule: **a process may crash after any durable operation; after restart the
system determines the correct state from PostgreSQL and continues safely.**

PostgreSQL is the only component trusted to keep data. Every other process can
be killed with SIGKILL at any line. Every correctness-relevant fact is written
in a transaction before anyone acts on it.

## Invariants

| #   | Invariant                                                           | Enforced by                                                                                                                                           | Tested in                                                                         |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Completed steps are never silently returned to READY.               | `STEP_TRANSITIONS.COMPLETED = []`; all writes go through `transitionStep`.                                                                            | `tests/unit/state-machine.test.ts`                                                |
| 2   | Only the holder of the authoritative lease may complete an attempt. | complete/fail lock the attempt and require `status = RUNNING AND lease_token = $token`.                                                               | `queue.test.ts` (stale worker, forged token, completion vs reaper race)           |
| 3   | Duplicate external events cannot cause duplicate state transitions. | `UNIQUE (task_id, deduplication_key)`; a waiting step consumes one event (`UNIQUE consumed_by_step_id`); consumption is CAS on `consumed_at IS NULL`. | `timers-and-signals.test.ts`, chaos test                                          |
| 4   | Task state can be reconstructed entirely from durable data.         | `decide()` is pure over (task, steps, unconsumed events, children); nothing is cached in memory.                                                      | every test creates fresh `Engine` instances ("restart")                           |
| 5   | No timer depends on a continuously running process.                 | timers are rows; any orchestrator fires overdue timers.                                                                                               | `timers-and-signals.test.ts`, durability demo (all processes dead past `fire_at`) |
| 6   | Retry scheduling survives process restart.                          | the retry time is `steps.available_at`, written with the failure.                                                                                     | `retry-and-ambiguity.test.ts` (restart before retry time)                         |
| 7   | A stale worker cannot overwrite newer work.                         | Invariant 2 + attempts are never reused (new attempt = new token) + one RUNNING attempt per step (partial unique index).                              | `queue.test.ts`, durability demo step 24                                          |

Additional constraints used as part of the model: one child task per step
(`UNIQUE parent_step_id`), one timer per sleep step, `UNIQUE (step_id,
attempt_number)`, `UNIQUE steps.idempotency_key`, CHECK constraints on all
status columns, append-only history (trigger).

## What happens when …

### … the orchestrator dies

- Mid-cycle: the transaction rolls back. `wake_at` is still set. The next
  orchestrator (another replica, or the same one after restart) redoes the whole
  cycle. Because `decide()` is deterministic over durable data, the result is
  the same. Test: `MID_ORCHESTRATION_CYCLE`.
- Before a timer is registered: nothing was written; the next cycle registers
  it once. Test: `BEFORE_TIMER_REGISTRATION`.
- After a timer is registered: the timer row is durable and will fire. Test:
  `AFTER_TIMER_REGISTRATION`.
- Between cycles: nothing is lost; due work waits until an orchestrator runs.
- Several orchestrators: `FOR NO KEY UPDATE SKIP LOCKED` gives each task to one
  of them at a time. Test: "many orchestrators running at once".

### … a worker dies

- Before it claimed: nothing happened.
- After the claim committed (`AFTER_WORK_CLAIMED`): the attempt holds a lease.
  No heartbeat arrives, the lease expires, the reaper marks the attempt
  `EXPIRED` and schedules a retry (new attempt, new token). Other workers claim
  it.
- During execution: the same. The reaper does **not** assume the work failed:
  - `effect: 'pure'` → classified `TIMEOUT`, retried.
  - `effect: 'idempotent'` (default) → classified `AMBIGUOUS`, retried; the next
    attempt has `context.recoveringAmbiguous = true` and the worker's
    `reconcile` hook runs first.
  - `effect: 'unsafe'` → classified `AMBIGUOUS`, step `BLOCKED` for an operator
    (`POST /v1/tasks/:id/steps/:key/resolve`).
- After the side effect, before reporting (`AFTER_SIDE_EFFECT`): see
  [idempotency.md](idempotency.md).
- A worker that is only slow (GC pause, network partition) and comes back after
  its lease was reaped: its heartbeat and completion get `409 LEASE_LOST`. It
  must stop. Its late result is discarded.

### … the API dies

Workers and the CLI get connection errors. Workers retry `complete`/`fail`
(they are idempotent for the same attempt + token). If the API died before
commit (`BEFORE_COMPLETION_COMMIT`) the retry is a normal completion; if it died
after commit (`AFTER_COMPLETION_COMMIT`) the retry returns `ALREADY_ACCEPTED`.
If the worker gives up, the lease expires and the step is retried (with
reconciliation).

### … the database is temporarily unavailable

- Every operation is a transaction; a failed one changed nothing.
- The orchestrator loop logs, backs off (up to 10 s) and retries.
- Workers cannot claim, heartbeat or complete. Heartbeat failures that are not
  `LEASE_LOST` do not abort work. If the outage is longer than the lease, the
  lease expires (by the engine clock, after recovery) and the step is retried
  as AMBIGUOUS. A completion that arrives first still wins: authority ends only
  when the reaper commits.
- Deadlocks and serialization failures (`40P01`, `40001`) are retried
  automatically.

### … a response is lost

| Lost response of | Effect                                                                            |
| ---------------- | --------------------------------------------------------------------------------- |
| create task      | retry with the same `Idempotency-Key` header → same task.                         |
| claim            | the attempt exists but the worker does not know it; the lease expires; retried.   |
| heartbeat        | harmless; the next heartbeat extends the lease.                                   |
| complete / fail  | retry → `ALREADY_ACCEPTED` (same token) or normal acceptance.                     |
| signal           | retry with the same `deduplicationKey` → `duplicate: true`, no second transition. |

### … an external side effect succeeds but the acknowledgement is lost

The engine cannot know whether the effect happened. It records `AMBIGUOUS`
(never "failed") and retries with reconciliation, or blocks. Details and limits
in [idempotency.md](idempotency.md).

### … a task is cancelled while work runs

Intent is persisted first (`task -> CANCELLED`). Not-yet-running steps are
cancelled, timers cancelled, children cancelled. Running workers see
`cancelRequested: true` on their next heartbeat and their `AbortSignal` fires.
If the worker still completes, the result is stored (it really happened) and
nothing new is scheduled. Completed side effects are **not** undone; use
compensation steps for that.

## Clock assumptions

Lease expiry and timers use the engine's clock (`Clock` port). With several
engine processes (API + orchestrators), their clocks must be close (NTP).
Skew of _d_ ms can make a lease look expired up to _d_ ms early. Keep
`LEASE_MS` much larger than expected skew. Workers do not depend on their own
clock for correctness: they use relative durations. An alternative design is to
use `now()` from PostgreSQL for all comparisons; the port makes that a local
change.

## Crash points

`CRASH_AT=<POINT>[:n]` (comma-separated) makes a process SIGKILL itself on the
n-th time it reaches the point. In tests the same points throw `SimulatedCrash`
(inside a transaction this produces the same rollback as a dead connection).

| Point                       | Process      | Where                                            |
| --------------------------- | ------------ | ------------------------------------------------ |
| `AFTER_WORK_CLAIMED`        | worker       | claim committed, before execution                |
| `AFTER_SIDE_EFFECT`         | worker       | external effect applied, before reporting        |
| `BEFORE_COMPLETION_SEND`    | worker       | result computed, before calling complete         |
| `BEFORE_COMPLETION_COMMIT`  | api          | inside the completion transaction                |
| `AFTER_COMPLETION_COMMIT`   | api          | completion committed, before the response        |
| `BEFORE_TIMER_REGISTRATION` | orchestrator | inside the cycle, before the timer insert        |
| `AFTER_TIMER_REGISTRATION`  | orchestrator | cycle with a new timer committed                 |
| `MID_ORCHESTRATION_CYCLE`   | orchestrator | after the first batch of commands, before commit |
| `BEFORE_TIMER_FIRE_COMMIT`  | orchestrator | inside the timer-firing transaction              |

Example:

```bash
CRASH_AT=AFTER_SIDE_EFFECT WORKER_CAPABILITIES=side-effect npm run worker
```
