# tpm — a durable agent factory on PostgreSQL

tpm runs coding agents (Claude Code, Copilot CLI) on your repositories, hands
the result back as pull requests, and — where your policy allows — has other
agents review and merge them. It is built on a small **durable execution
engine**: every step is stored in PostgreSQL, so any process can be killed at
any moment and the work continues where it stopped.

| Layer         | What it does                                                                  | Code                                         |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| Tracker       | **What** to do: GitHub Issues or Azure Boards items tagged `tpm:agent:ready`  | `packages/agent-runner` (adapters)           |
| Agent factory | **How**: agent CLI per item, reviews, policy-based merge, PR watching, rounds | `packages/agent-runner`, `apps/agent-runner` |
| Engine        | **Reliably**: tasks, steps, leases, retries, timers, events, compensation     | `packages/core`, `packages/engine`           |
| Storage       | The only state that survives: PostgreSQL                                      | `packages/db`                                |
| Interfaces    | Menu bar app, CLI, versioned REST API with OpenAPI and live events            | `apps/menubar`, `apps/cli`, `apps/api`       |

## Quick start

Full guide: [docs/setup.md](docs/setup.md). In short (macOS, Node ≥ 22.12, PostgreSQL ≥ 14):

```bash
cp .env.example .env              # set DATABASE_URL / TEST_DATABASE_URL
npm install
npm run db:migrate
npm run doctor                    # read-only health check; fix what it reports
npm run menubar && open apps/menubar/build/Factory.app   # starts and supervises everything
```

Then add the label `tpm:agent:ready` to an issue in a configured repository.

## How the factory works

```
issue (tpm:agent:ready)
  → start → prepare → agent → finish → verify → reviewA → reviewB → review (wait) → close
```

1. **The author agent** runs in its own clone, on branch `agent/issue-<n>`, one
   agent per repository at a time. Success means durable evidence: a pull
   request whose head moved past the round's baseline — not an exit code.
2. **Gates** run on that exact commit, in a separate read-only clone: the
   repo's verify command (for example a Playwright suite) and one or two
   independent agent reviewers (Claude, Copilot). Results are commit statuses
   (`tpm/verify`, `tpm/review-<name>`), so a new push never inherits them.
3. **A policy in the repository** (`.tpm/agent-policy.yml`) decides per path:
   `auto-merge`, `human-approve` (you add `tpm:agent:approve`) or
   `human-merge`. `.tpm/**` and `.github/**` always need a human.
4. **A watcher** turns PR state into durable signals: merged → done; CI red,
   conflicts or review findings → the next round with that feedback (up to
   `maxRounds`); changes requested → a human.

A crash at any point — even right after the agent pushed — is recovered by
reconciling against GitHub, never by running the agent twice.
Details: [docs/agent-runner.md](docs/agent-runner.md).

## The engine

A persisted state machine, not code replay. An orchestrator cycle loads a
task's durable state, calls a pure `decide()` function, and stores the
transitions in one transaction. Workers pull leased work over HTTP.

```
Task ──< Step ──< Attempt        plus Event (deduplicated signals), Timer,
                                  Artifact, and an append-only History
```

- **Guarantee:** at-least-once execution of every step; exactly-once state
  transitions inside PostgreSQL. Exactly-once side effects need the external
  system's cooperation (idempotency keys); the engine supplies a stable key per
  step, classifies unknown outcomes as **AMBIGUOUS**, and runs a reconcile hook
  before any retry. See [docs/idempotency.md](docs/idempotency.md).
- **Primitives:** `step`, `sequence`, `parallel`, `map` (with a concurrency
  limit), `waitForEvent`, `sleep` (durable timers), `childTask`, retries with
  persisted backoff, concurrency groups, compensation (sagas), cancel/pause.

| If this dies…                     | then…                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| an orchestrator                   | its transaction rolls back; any orchestrator redoes the cycle             |
| a worker                          | its lease expires; the step is retried (AMBIGUOUS if it had side effects) |
| every process                     | timers, waits and retries are rows; they continue after restart           |
| the response to a worker / client | complete, fail, create (Idempotency-Key) and signals are safe to repeat   |
| the database, briefly             | every operation is one transaction; processes back off and retry          |

Read more: [architecture](docs/architecture.md) · [state machines](docs/state-machine.md) ·
[failure model](docs/failure-model.md) · [worker protocol](docs/worker-protocol.md).

## Interfaces

- **Menu bar app** (macOS): supervises the processes, shows what needs you,
  approve / retry / cancel, history, notifications. [apps/menubar/README.md](apps/menubar/README.md)
- **CLI:** `npm run cli` (lists commands) — tasks, signals, `events` (live tail), `doctor`, `openapi`.
- **REST API v1:** every route under `/v1`, described in
  [docs/openapi.json](docs/openapi.json) (also served at `GET /v1/openapi.json`),
  with a typed TypeScript client in `@durable/contract`. Live updates:
  `GET /v1/events` (server-sent events). See [docs/api.md](docs/api.md).

## Development

```bash
npm run check            # format + typecheck + unit + integration (real PostgreSQL)
npm run test:e2e         # real processes + SIGKILL: chaos, durability demo, agent-runner
CHAOS_SEED=7 npm run test:e2e -- chaos
cd apps/menubar && swift test
npm run demo:durability  # the crash/restart demonstration with ✔/✘ checks
```

CI (GitHub Actions) runs the checks on PostgreSQL 14 and 17, the end-to-end
tests, and the Swift tests when the app changes. Tests use fake `gh` and fake
agents; CI needs no secrets.

## Repository layout

```
apps/
  api/            REST API v1 (routes from the contract), live events
  orchestrator/   background loop: retries, timers, reaper, orchestration cycles
  agent-runner/   factory processes: sync (tracker + PR watcher), worker
  worker/         example worker process
  cli/            CLI, doctor, durability demo
  menubar/        macOS menu bar app (SwiftUI)
packages/
  core/           pure domain: state machines, retry, workflow DSL, decide(), ports
  db/             pool, transactions, SQL migrations
  engine/         transactional operations over PostgreSQL
  contract/       API v1: schemas, route table, OpenAPI, typed client
  agent-runner/   trackers, PR hosts, agent/reviewer CLIs, policy, factory workflow
  workflows/      the registry the API and orchestrator load
  sdk/            worker runtime and HTTP transport
  observability/  logging, metrics, tracing
  testkit/        test helpers and process supervisor
examples/         demo workflows and workers
docs/             setup, architecture, API, factory, security, failure model, …
```

## Status

The engine, the factory (GitHub), the menu bar app and the v1 API are in use
on single-person repositories. Planned work is in
[issues labelled `backlog`](https://github.com/htalat/tpm/issues?q=is%3Aissue+is%3Aopen+label%3Abacklog).
Known limits:

- Single machine assumptions: engine clocks must agree; metrics counters are per process.
- Agents run with the operator's CLI permissions (fine for one person; teams
  should rely on branch protection / rulesets as the second guard).
- Azure DevOps adapters are tested with a fake `az` only; the factory itself
  supports GitHub PR hosts only.
- No wait timeouts, spending caps, retention or backups yet (see backlog).
- The previous Markdown task tracker (tpm v0.x) is in this repository's
  history and tags.
