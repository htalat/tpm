# durable — a durable task orchestrator on PostgreSQL

## What this is

A small **durable execution engine**. It runs multi-step workflows whose steps
are done by arbitrary **workers**: TypeScript functions, HTTP services,
subprocesses, other workflows, humans, and AI agents.

It is **not** an AI agent framework. The core has no LLM, prompt or provider
code. An agent is one more worker.

## Why it exists

Long-running work (research over 100 companies, a payment saga, a report that
waits hours for approval) must not depend on one process staying alive.
Here, every fact needed to continue is in PostgreSQL. You can `kill -9` any
process at any moment: the API, an orchestrator, a worker, or all of them.
After restart the work continues from the last committed state.

## Core model

```
Task ──< Step ──< Attempt
  │        │
  │        ├── Event   (external signal, deduplicated)
  │        ├── Timer   (durable sleep)
  │        └── Artifact (reference to large output)
  └── History (append-only audit of every transition)
```

- **Task**: one execution of a workflow definition (`type` + `version`).
- **Step**: one node of the workflow graph (worker step, map, wait, sleep,
  child task, compensation). Has a stable **idempotency key**.
- **Attempt**: one leased try of a worker step. A retry is a new attempt with a
  new lease token.
- **Event**: a persisted external signal (`type`, `correlationKey`, `payload`,
  `deduplicationKey`).
- **Timer**: a row with `fire_at`. No process sleeps.
- **Artifact**: a URI to output stored outside the database.
- **History**: `task_history`, append-only (enforced by a trigger).

The engine is a **persisted state machine**, not a code-replay engine. An
orchestrator cycle is: load task snapshot → `decide()` (pure) → persist the
transitions in one transaction → commit. See
[docs/architecture.md](docs/architecture.md).

```ts
defineWorkflow({
  name: 'company-research',
  steps: {
    loadCompanies: step({ executor: 'echo', input: (ctx) => ctx.input }),
    researchCompanies: map({
      items: (ctx) => ctx.outputs.loadCompanies.companies,
      executor: 'agent',
      concurrency: 10,
    }),
    approval: waitForEvent('approval'),
    generateReport: step({
      executor: 'aggregate',
      input: (ctx) => ({ values: ctx.outputs.researchCompanies }),
    }),
  },
  flow: sequence('loadCompanies', 'researchCompanies', 'approval', 'generateReport'),
});
```

Primitives: `step`, `sequence`, `parallel`, `map` (fan-out with a concurrency
limit, to workers or child workflows), `waitForEvent`, `sleep`, `childTask`,
plus per-step `retry`, `timeoutMs`, `effect` and `compensate`.

## Execution guarantee

**At-least-once execution** of every step. **Exactly-once state transitions**
inside PostgreSQL (unique constraints, row locks, compare-and-set).

Exactly-once **side effects** in another system are not something the engine
can promise alone: if a worker charges a card and dies before the engine
records it, the engine cannot know whether the charge happened. Therefore:

- every step has a stable idempotency key (`<task_id>:<step_key>`) to pass to
  the external system, which must deduplicate by it;
- a lost lease on a step with side effects is classified **AMBIGUOUS**, never
  silently "failed";
- the next attempt runs the worker's **reconcile** hook first ("did my effect
  already happen?");
- steps marked `effect: 'unsafe'` (no dedup, no lookup possible) **block** for
  an operator instead of guessing.

See [docs/idempotency.md](docs/idempotency.md).

## Failure model (short)

| Event                                       | What happens                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator dies                           | Its open transaction rolls back; `wake_at` stays set; any orchestrator redoes the cycle. Many orchestrators can run (SKIP LOCKED). |
| Worker dies                                 | No heartbeat → lease expires → reaper marks the attempt EXPIRED (TIMEOUT or AMBIGUOUS) → retry on another worker.                  |
| Database temporarily unavailable            | Every operation is one transaction; nothing partial. Processes back off and retry. Leases may expire → safe retry.                 |
| Response lost                               | Create task (Idempotency-Key), complete/fail (same token) and signals (deduplicationKey) are all safe to retry.                    |
| Side effect succeeded, acknowledgement lost | AMBIGUOUS → reconcile with the external system → complete with the existing result. Effect happens once if the system cooperates.  |

Full details, the seven invariants, and crash points:
[docs/failure-model.md](docs/failure-model.md).

## Agent integration

An agent is simply a `Worker<AgentInput, AgentOutput>`:

```ts
interface AgentAdapter {
  execute(input: unknown, opts: { signal: AbortSignal; idempotencyKey: string }): Promise<unknown>;
}
const handlers = { agent: createAgentHandler(new MockAgentAdapter()) };
```

It claims, heartbeats, completes and stores artifacts through exactly the same
protocol as every other worker. No agent framework is required. The mock
adapter needs no API key. An optional Anthropic adapter
(`examples/src/anthropic-adapter.ts`) is loaded only with
`AGENT_ADAPTER=anthropic`. See [docs/worker-protocol.md](docs/worker-protocol.md).

## agent-runner: coding agents on GitHub Issues

`packages/agent-runner` + `apps/agent-runner` use the engine to run coding
agents (Claude Code, Copilot CLI) on GitHub issues labelled (or Azure Boards work items tagged) `tpm:agent:ready`, one
agent per checkout, and hand the result back as a PR (`tpm:agent:review`). The run
then waits durably for the PR outcome: merged → `tpm:agent:done`; CI red, conflict
or new review comments → next round with the feedback in the prompt (up to
`maxRounds`). A crash after the agent pushed reconciles instead of running the
agent again.
See [docs/agent-runner.md](docs/agent-runner.md).

```bash
npm run agent-runner -- labels   # once per repo
npm run agent-runner -- sync     # GitHub -> runs, PR outcomes -> signals
npm run agent-runner -- worker   # runs agents
```

### Menu bar app (macOS)

`npm run menubar` builds `Factory.app`: it starts and supervises the factory
processes, shows which runs need you, and lets you approve, retry or cancel
runs and see their history. See [apps/menubar/README.md](apps/menubar/README.md).

---

## Run it

Requirements: Node.js ≥ 22.12 (tested on 24), PostgreSQL ≥ 14 (Docker or local).

```bash
cp .env.example .env
docker compose up -d postgres        # PostgreSQL 17 with databases durable + durable_test
npm install
npm run db:migrate                   # main database
npm run db:migrate -- --test         # test database (tests also reset it themselves)
npm run dev                          # API :3000 + orchestrator + 2 workers, prefixed logs
```

With an existing local PostgreSQL instead of Docker, set `DATABASE_URL` and
`TEST_DATABASE_URL` in `.env` and create the two databases (`createdb durable` and
`createdb durable_test`). If port 5432 is taken, `POSTGRES_PORT=5433 docker compose up -d postgres` and change the URLs.

Run components separately (each is a separate process; start as many as you like):

```bash
npm run api
npm run orchestrator
npm run worker                       # WORKER_CAPABILITIES=agent,compute WORKER_NAME=w1 npm run worker
```

Everything in containers: `docker compose --profile app up --build`.

### CLI

```bash
npm run cli -- workflows
npm run cli -- task create example-sequence '{"start":1}'
npm run cli -- task create company-research examples/inputs/company-research.json
npm run cli -- task create example-sleep examples/inputs/sleep.json --idempotency-key my-key
npm run cli -- task list --status WAITING
npm run cli -- task get <task-id>
npm run cli -- task history <task-id>
npm run cli -- task signal <task-id> approval '{"approved":true}' --dedup approval-1
npm run cli -- task wait <task-id> --status COMPLETED --timeout-ms 120000
npm run cli -- task cancel <task-id> "no longer needed"
npm run cli -- task pause <task-id>
npm run cli -- task resume <task-id>
npm run cli -- task resolve <task-id> <step-key> retry|complete|fail '{"note":"checked"}'
npm run cli -- worker run --capabilities agent,compute --name cli-worker
npm run cli -- db migrate
npm run doctor                     # read-only health check (exit 1 on failures; --json for tools)
```

### REST API

| Method | Path                                            | Purpose                                                               |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------- |
| POST   | `/tasks`                                        | create (`Idempotency-Key` header optional)                            |
| GET    | `/tasks`, `/tasks/:id`                          | list / details (steps, attempts, children, events, timers, artifacts) |
| GET    | `/tasks/:id/history`                            | durable history                                                       |
| POST   | `/tasks/:id/cancel`, `/pause`, `/resume`        | control                                                               |
| POST   | `/tasks/:id/signals`                            | external event `{type, correlationKey, payload, deduplicationKey}`    |
| POST   | `/tasks/:id/steps/:key/resolve`                 | operator decision for a BLOCKED step                                  |
| POST   | `/workers/register`, `/workers/claim`           | worker protocol                                                       |
| POST   | `/attempts/:id/heartbeat`, `/complete`, `/fail` | worker protocol                                                       |
| GET    | `/health`, `/ready`, `/metrics`, `/workflows`   | operations                                                            |

Errors are `{"error": {"code", "message", "details"}}` with codes such as
`VALIDATION_ERROR` (400), `NOT_FOUND` (404), `LEASE_LOST` / `TASK_TERMINAL` /
`INVALID_TRANSITION` (409), `PAYLOAD_TOO_LARGE` (413), `IDEMPOTENCY_MISMATCH` (422).

### Example workflows

| Type                   | Shows                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `example-sequence`     | A → B → C                                                                                |
| `example-parallel`     | A → (B1, B2, B3) → aggregate                                                             |
| `example-retry`        | fails twice, succeeds on attempt 3 (`task history` shows the backoff)                    |
| `example-sleep`        | A → durable sleep (default 60 s) → B; kill everything during the wait                    |
| `example-approval`     | generate → wait for `approval` → publish                                                 |
| `example-agent`        | request → mock AI agent (artifact) → summarize                                           |
| `company-research`     | 1 agent step per company, at most 10 in flight, approval, report                         |
| `saga-order`           | reserve → charge → ship fails → refund → release                                         |
| `parent-with-children` | map of child workflows + a single child task                                             |
| `durability-demo`      | everything above in one run; used by the demo                                            |
| `chaos`                | 80 idempotent side effects + duplicate events; used by the chaos test                    |
| `agent-run`            | one coding-agent run for one GitHub issue ([docs/agent-runner.md](docs/agent-runner.md)) |

Workers: `compute`/`echo`/`aggregate` (deterministic), `flaky` (deterministic
failure injection), `slow` (heartbeats), `side-effect`/`charge`/`reserve`/…
(idempotent external effects with reconcile), `agent` (mock LLM),
`chaos-effect`.

---

## Tests

Integration and e2e tests use a **real PostgreSQL** (`TEST_DATABASE_URL`). The
database is dropped and migrated at the start of each run.

```bash
npm run typecheck
npm run format:check
npm test                 # unit + integration (~10 s)
npm run test:unit
npm run test:integration
npm run test:e2e         # real processes + SIGKILL: chaos test and durability demo (~70 s)
CHAOS_SEED=7 npm run test:e2e -- chaos   # replay a specific chaos seed
npm run check            # format + typecheck + unit + integration
```

Coverage (by file): concurrent claims and SKIP LOCKED, one running attempt per
step, lease expiry, heartbeat renewal, stale and forged completions, completion
vs reaper race, duplicate completion, worker crash at each point, orchestrator
crash mid-cycle and around timer registration, crash before/after completion
commit, crash after side effect (with and without reconcile), ambiguous on
unsafe steps (BLOCKED → operator), retries, persisted backoff across restart,
retry exhaustion, permanent failure, durable timers across restart, events
before/after the wait, correlation keys, duplicate signals (concurrent),
fan-out of 100 with concurrency 10 and fan-in, child tasks, unique child spawn,
cancellation (heartbeat notification, preserved results, children), pause and
resume, saga compensation order, optimistic-concurrency conflicts, six
simultaneous orchestrators, REST validation/auth/size limits.

The **chaos test** (`tests/e2e/chaos.test.ts`) runs the API, 2 orchestrators and
4 workers as real processes, randomly SIGKILLs workers, orchestrators and the
API for 25 s (seeded), lets some workers crash right after their side effect,
sends duplicate events, then stops injecting and verifies: task COMPLETED, every
step completed exactly once, one completed attempt per step, one applied
external effect per idempotency key, one consumed event.

## Durability demo

```bash
npm run demo:durability                      # uses DATABASE_URL, API on :3100
npm run demo:durability -- --sleep-ms 60000  # longer timer
```

It starts real processes and prints each step with a ✔/✘ check:

1–5. start API, orchestrator, two general workers and a payments worker; submit
`durability-demo`; steps complete.
6–8. SIGKILL the worker holding a slow item; its lease expires; another worker
recovers it.
8b. the payments worker charges, then crashes before reporting (`CRASH_AT=AFTER_SIDE_EFFECT`);
the engine classifies AMBIGUOUS; the restarted worker reconciles instead of
charging again.
9–13. the workflow enters a durable timer; **every** process is killed; the demo
waits past `fire_at`; the timer is still SCHEDULED; restart; it fires.
14–18. approval step; kill everything again; restart; send the approval twice
with the same deduplication key; execution continues.
19–21. the unreliable step fails twice with persisted backoff and completes. 22. full durable history is printed.
23–25. checks: duplicate signal caused one transition; the dead worker's stale
completion is rejected with `409 LEASE_LOST`; no step has two completed
attempts; the charge and publish effects each happened once.

Process logs go to `data/logs/demo-*.log`. The same demo runs as
`tests/e2e/durability-demo.test.ts`.

### Manual crash experiments

```bash
npm run dev                                  # terminal 1
npm run cli -- task create example-sleep '{"sleepMs":60000}'
# Ctrl-C terminal 1 (or kill -9 the pids it printed), wait > 60 s, run npm run dev again
npm run cli -- task history <task-id>        # timer.fired with latency > 0, task completed

CRASH_AT=AFTER_SIDE_EFFECT WORKER_CAPABILITIES=side-effect WORKER_NAME=payments npm run worker
```

---

## Repository layout

```
apps/
  api/            Fastify REST API (server.ts = routes, main.ts = process)
  orchestrator/   background loop: retries, timers, reaper, orchestration cycles
  worker/         example worker process (HTTP transport)
  cli/            CLI + durability demo
packages/
  core/           pure domain: state machines, retry, workflow DSL, decide(), protocol, ports, crash points
  db/             pg pool, transactions, migrations (SQL in packages/db/migrations)
  engine/         transactional operations over PostgreSQL
  sdk/            worker runtime, HTTP transport, artifact stores
  observability/  JSON logging, metrics, OpenTelemetry spans
  testkit/        in-process transport, test DB helpers, process supervisor
examples/         workflows, workers, simulated external system, agent adapters, inputs/
tests/            unit/, integration/, e2e/, support/
docs/             architecture, state-machine, failure-model, idempotency, worker-protocol, security
tools/dev.ts      npm run dev
```

## Known limitations

- **Polling**: orchestrators and workers poll (default 150–250 ms). Fine for
  this scale; adds latency and DB load at high scale (see next steps).
- **Task summary status lags**: claims do not touch the task row, so
  READY/RUNNING can lag by one cycle. Step status is authoritative.
- **One snapshot per cycle loads all steps of the task** (fan-out up to 1000
  items by default). Very large fan-outs need batching/pagination.
- **Engine clocks must be synchronized** (API and orchestrators). Workers do not
  need it.
- **Definitions are code**. Changing a published version in place can break
  running tasks; there is no automatic versioning check beyond name+version.
- **Compensation** runs on failure only (not on cancellation), for top-level
  steps only (not individual map items), sequentially.
- **Cancellation is cooperative** for running work.
- **Metrics counters are per process**; only the DB-backed gauges are global.
- **Auth** is two shared bearer tokens. Not suitable for public exposure (see
  [docs/security.md](docs/security.md)).
- **No history retention / archival**; history grows forever.
- The Docker image runs TypeScript via `tsx`; no production bundle yet. The
  Compose stack was validated with `docker compose config`; the test suite and
  the demo in this repo were run against a local PostgreSQL 14.
- Waiting for an event has no timeout primitive yet (combine with `sleep` in a
  later version via "first of").

## Recommended production-hardening steps

1. `LISTEN/NOTIFY` (or a wake table) to cut polling latency; keep polling as
   the safety net.
2. Use PostgreSQL `now()` (or a single time authority) for lease/timer
   comparisons; add clock-skew alarms.
3. Partition `task_history`, `attempts`, `events` by time; add retention and
   archival; index review under load.
4. Real authN/Z (OIDC, mTLS for workers, tenant isolation, capability ACLs).
5. Event wait timeouts and "first-of" (race) composition; cron/schedules.
6. Cancellation-triggered compensation and per-item compensation for maps.
7. Workflow version pinning checks and a migration story for in-flight tasks.
8. Bundle to JS (esbuild), distroless image, health/readiness probes in K8s,
   PgBouncer (transaction mode works: no session state is used except the
   migration advisory lock).
9. OpenTelemetry SDK wiring with trace context propagated through work items
   and events; dashboards for lease expirations, retry rates, timer latency,
   queue depth per capability.
10. Load and soak tests (thousands of concurrent tasks), plus a long-running
    chaos job in CI with random seeds recorded.
11. Back-pressure: per-capability concurrency limits and fair scheduling across
    tasks/tenants.
