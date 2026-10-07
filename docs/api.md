# API v1

The REST API is defined in one place, `packages/contract`:

- **Schemas** (`schemas.ts`): every response body as zod schemas. Field names
  are camelCase; timestamps are ISO-8601 UTC strings.
- **Route table** (`routes.ts`): method, path, auth, params, query, body and
  response for every route. The server registers its handlers from this table
  (so path, validation and auth cannot drift), and in tests every response is
  validated against it.
- **OpenAPI 3.1** (`openapi.ts`): generated from the table and the schemas,
  committed as [openapi.json](openapi.json) and served at `GET /v1/openapi.json`.
  A unit test fails when the committed file is out of date:

  ```bash
  npm run cli -- openapi docs/openapi.json
  ```

- **Typed client** (`client.ts`): `createClient({ baseUrl, token })` gives
  `client.call('<operationId>', { params, query, body })` with typed inputs and
  outputs, and validates every response. The CLI, the worker SDK and the tests
  use it. The Swift menu bar app has its own models, checked against fixtures
  written from the real API.

## Compatibility rule

Within v1, fields and routes may be **added**. Nothing is renamed, removed or
changes meaning without a `/v2`. Clients must ignore fields they do not know.
Operational endpoints (`/health`, `/ready`, `/metrics`) are not versioned.

## Routes

| Group      | Routes                                                                                                                                                | Auth   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| tasks      | `GET/POST /v1/tasks`, `GET /v1/tasks/{id}`, `…/history`, `…/cancel`, `…/pause`, `…/resume`, `…/signals`, `…/steps/{key}/resolve`, `GET /v1/workflows` | admin  |
| workers    | `POST /v1/workers/register`, `/v1/workers/claim`, `/v1/attempts/{id}/heartbeat`, `…/complete`, `…/fail`                                               | worker |
| agent-runs | `GET /v1/agent-runs`, `GET /v1/agent-runs/{id}`, `POST …/approve`, `…/retry`, `…/cancel`                                                              | admin  |
| events     | `GET /v1/events`                                                                                                                                      | admin  |

`admin` = `API_TOKEN`, `worker` = `WORKER_TOKEN` (bearer). Both are optional
today; see [security.md](security.md) and issue #193.

Errors are always `{"error": {"code", "message", "details?"}}`:
`VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404, `LEASE_LOST` /
`TASK_TERMINAL` / `CONFLICT` / `INVALID_TRANSITION` 409, `PAYLOAD_TOO_LARGE`
413, `IDEMPOTENCY_MISMATCH` 422. Retry on 5xx and on network errors: creates
(with `Idempotency-Key`), completions, failures and signals are idempotent.

## Live events: `GET /v1/events`

Server-sent events, one per committed change:

```
retry: 3000
event: ready
data: {}

id: 1234
event: history
data: {"id":1234,"kind":"history","taskId":"…","taskType":"agent-run","stepId":"…","eventType":"step.completed","newState":"COMPLETED","at":"…"}

event: watch
data: {"id":0,"kind":"watch","taskId":"…","eventType":"watch.no-action","newState":"policy: waiting for approval by htalat",…}
```

- `history` is sent for every row added to the durable history (every task,
  step and attempt transition). `watch` is sent when the PR watcher's reason
  for a waiting agent-run changes.
- Events are sent only after the change is **committed** (PostgreSQL
  `NOTIFY`), never for a rollback.
- Events are hints, not a log: after `ready` (every connect and reconnect),
  fetch a snapshot, then apply events. Events missed while disconnected are
  not replayed.
- Filters: `?taskId=<uuid>`, `?taskType=agent-run`.
- A keep-alive comment is sent every 15 seconds.

```bash
npm run cli -- events --type agent-run     # live tail
```
