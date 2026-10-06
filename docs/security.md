# Security

## What the MVP does

- **Input validation**: every HTTP body, path parameter and query is parsed with
  Zod. Workflow inputs are validated against the workflow's own schema when it
  has one.
- **Size limits**: request body ≤ 1 MiB (Fastify `bodyLimit`); task input,
  metadata, worker output and signal payload ≤ 256 KiB each (HTTP 413, `PAYLOAD_TOO_LARGE`); map fan-out ≤ 1000 items by default.
- **No code from the network**: workflow definitions are TypeScript modules
  deployed with the service and registered in a `WorkflowRegistry`. The API
  accepts only a workflow _name_. Nothing is `eval`'d or deserialized into code.
- **SQL**: all values are bind parameters. The only dynamic SQL is the `SET`
  list in the transition functions, built from a fixed column whitelist.
- **Secrets in logs**: `input`, `output`, `payload`, lease tokens and
  `authorization` headers are redacted by the logger. Lease tokens appear only
  as a one-way `lease_id` hash.
- **Separate identities**: workers register and get a `workerId`; tasks have
  their own ids. Worker endpoints and admin endpoints take different bearer
  tokens (`WORKER_TOKEN`, `API_TOKEN`), compared in constant time.
- **Reserved event types**: clients cannot send `__*` events (used for timers).
- **Lease tokens** are random UUIDs; a worker cannot act on an attempt without
  its token.

## Before exposing the service publicly

1. **Authentication**: replace the shared tokens with real identities (OIDC/JWT
   for users and services, mTLS or short-lived signed credentials for workers).
2. **Authorization**:
   - per-tenant data isolation (a `tenant_id` on tasks and every query, or
     row-level security),
   - which principals may create which workflow types, signal which tasks,
     cancel/pause/resolve,
   - which workers may claim which capabilities (today any authenticated worker
     may claim any capability it names).
3. **Signal authenticity**: approvals should be bound to an authenticated
   approver identity and recorded in history; consider signed approval links.
4. **Rate limiting and quotas** per principal (task creation, signals, claims).
5. **TLS** everywhere; PostgreSQL with TLS and least-privilege roles (API and
   orchestrator need DML only, migrations a separate role).
6. **Payload policy**: encrypt sensitive inputs/outputs at rest, or store them
   in an external store and keep only references; add retention/purging
   (history is append-only by design, so plan for archival).
7. **Artifact URIs**: validate allowed schemes/buckets; never let the engine
   fetch arbitrary URIs.
8. **Audit**: ship `task_history` and auth events to a tamper-evident store.
9. **Supply chain**: build a bundled production image without dev dependencies;
   pin and scan dependencies.
