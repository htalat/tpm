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

## The agent factory

The factory lets agents change code, and — where the repository policy says
so — merge it. Its safety rests on these rules:

- **The merge decision is not an LLM.** A pure function decides from durable
  evidence (commit statuses on the reviewed commit, the policy file, approvals)
  and merges exactly that commit (`sha` guard). A push after the reviews
  invalidates them.
- **The policy lives in the repository**, is read only from the default
  branch, and a change to `.tpm/**` or `.github/**` always needs a human merge:
  an agent cannot raise its own autonomy or change CI.
- **Reviewers are read-only by CLI tool permissions** and work in a separate
  clone. A reviewer that fails or returns unreadable output counts as
  "needs a human", never as "approve".
- **Who may start a run** can be limited (`starters` in the policy); approvals
  count only from listed `approvers` and only after the newest commit.
- **Known gap (accepted for single-person repositories):** the author agent
  runs with the operator's own CLI permissions (`gh`, `git`), so it could in
  principle merge or push itself. In team repositories, branch protection or
  rulesets (required reviews and checks) are the guard that enforces this;
  turn them on before enabling auto-merge for others' code.
- **Issue text is untrusted input** to the agent (prompt injection). Limit
  `starters` to people you trust, and do not run the factory on public
  repositories where anyone can open issues without that limit.

## CI

GitHub Actions run with a read-only token, no secrets, `pull_request` only
(never `pull_request_target`), and actions and images pinned by digest. Tests
use fake `gh` and fake agents, so a malicious pull request has nothing to
steal. Require approval for workflows from outside collaborators in the
repository settings.
