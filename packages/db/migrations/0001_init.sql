-- Durable orchestration engine schema.
-- All timestamps are timestamptz and are written in UTC by the engine.
-- Constraints here are part of the correctness model, not decoration.

CREATE TABLE workers (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  capabilities  text[] NOT NULL,
  registered_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL
);

CREATE TABLE tasks (
  id                  uuid PRIMARY KEY,
  type                text NOT NULL,
  workflow_version    integer NOT NULL CHECK (workflow_version > 0),
  status              text NOT NULL CHECK (status IN
                        ('PENDING','READY','RUNNING','WAITING','BLOCKED','RETRYING','PAUSED','COMPLETED','FAILED','CANCELLED')),
  input               jsonb NOT NULL DEFAULT 'null',
  output              jsonb,
  error               jsonb,
  metadata            jsonb NOT NULL DEFAULT '{}',
  parent_task_id      uuid REFERENCES tasks(id),
  parent_step_id      uuid,
  failure             jsonb,
  compensation_status text CHECK (compensation_status IN ('RUNNING','COMPLETED','FAILED')),
  -- When set and <= now, an orchestrator must run a cycle for this task.
  wake_at             timestamptz,
  version             integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  started_at          timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL),
  CHECK (status NOT IN ('COMPLETED','FAILED') OR completed_at IS NOT NULL),
  CHECK ((parent_task_id IS NULL) = (parent_step_id IS NULL))
);
CREATE INDEX tasks_wake_idx ON tasks (wake_at) WHERE wake_at IS NOT NULL;
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX tasks_status_idx ON tasks (status);
-- A step spawns at most one child task, so a crash-and-retry spawn cannot duplicate children.
CREATE UNIQUE INDEX tasks_parent_step_uniq ON tasks (parent_step_id) WHERE parent_step_id IS NOT NULL;

CREATE TABLE steps (
  id              uuid PRIMARY KEY,
  task_id         uuid NOT NULL REFERENCES tasks(id),
  key             text NOT NULL,
  type            text NOT NULL CHECK (type IN ('task','map','wait_event','sleep','child','compensation')),
  status          text NOT NULL CHECK (status IN
                    ('PENDING','READY','RUNNING','WAITING','RETRYING','BLOCKED','COMPLETED','FAILED','SKIPPED','CANCELLED')),
  input           jsonb,
  output          jsonb,
  error           jsonb,
  executor_type   text,
  dependencies    text[] NOT NULL DEFAULT '{}',
  parent_step_id  uuid REFERENCES steps(id),
  item_index      integer,
  config          jsonb,
  wait            jsonb,
  retry_policy    jsonb NOT NULL,
  timeout_ms      integer NOT NULL CHECK (timeout_ms > 0),
  effect          text NOT NULL CHECK (effect IN ('pure','idempotent','unsafe')),
  idempotency_key text NOT NULL,
  attempt_count   integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at    timestamptz NOT NULL,
  version         integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  started_at      timestamptz,
  completed_at    timestamptz,
  UNIQUE (task_id, key),
  UNIQUE (idempotency_key),
  CHECK (type NOT IN ('task','compensation') OR executor_type IS NOT NULL),
  CHECK ((parent_step_id IS NULL) = (item_index IS NULL)),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)
);
CREATE INDEX steps_claim_idx ON steps (executor_type, available_at) WHERE status = 'READY';
CREATE INDEX steps_retry_idx ON steps (available_at) WHERE status = 'RETRYING';
CREATE INDEX steps_task_idx ON steps (task_id);

ALTER TABLE tasks ADD CONSTRAINT tasks_parent_step_fk FOREIGN KEY (parent_step_id) REFERENCES steps(id);

CREATE TABLE attempts (
  id               uuid PRIMARY KEY,
  task_id          uuid NOT NULL REFERENCES tasks(id),
  step_id          uuid NOT NULL REFERENCES steps(id),
  attempt_number   integer NOT NULL CHECK (attempt_number > 0),
  worker_id        uuid NOT NULL REFERENCES workers(id),
  status           text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED','EXPIRED')),
  lease_token      uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  deadline_at      timestamptz NOT NULL,
  heartbeat_at     timestamptz,
  started_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  output           jsonb,
  error_type       text CHECK (error_type IN ('TRANSIENT','PERMANENT','AMBIGUOUS','DEPENDENCY','POLICY','TIMEOUT')),
  error_message    text,
  metadata         jsonb NOT NULL DEFAULT '{}',
  version          integer NOT NULL DEFAULT 0,
  UNIQUE (step_id, attempt_number),
  CHECK (status = 'RUNNING' OR completed_at IS NOT NULL)
);
-- Invariant: at most one live (leased) attempt per step.
CREATE UNIQUE INDEX attempts_one_running_per_step ON attempts (step_id) WHERE status = 'RUNNING';
CREATE INDEX attempts_lease_idx ON attempts (lease_expires_at) WHERE status = 'RUNNING';
CREATE INDEX attempts_deadline_idx ON attempts (deadline_at) WHERE status = 'RUNNING';

CREATE TABLE events (
  id                  uuid PRIMARY KEY,
  task_id             uuid NOT NULL REFERENCES tasks(id),
  step_id             uuid REFERENCES steps(id),
  event_type          text NOT NULL,
  correlation_key     text,
  deduplication_key   text NOT NULL,
  payload             jsonb NOT NULL DEFAULT 'null',
  created_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  consumed_by_step_id uuid REFERENCES steps(id),
  -- Invariant 3: duplicate deliveries collapse into one row.
  UNIQUE (task_id, deduplication_key),
  CHECK ((consumed_at IS NULL) = (consumed_by_step_id IS NULL))
);
-- A waiting step consumes at most one event.
CREATE UNIQUE INDEX events_consumer_uniq ON events (consumed_by_step_id) WHERE consumed_by_step_id IS NOT NULL;
CREATE INDEX events_unconsumed_idx ON events (task_id, created_at) WHERE consumed_at IS NULL;

CREATE TABLE timers (
  id         uuid PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES tasks(id),
  step_id    uuid REFERENCES steps(id),
  timer_type text NOT NULL CHECK (timer_type IN ('SLEEP')),
  fire_at    timestamptz NOT NULL,
  status     text NOT NULL CHECK (status IN ('SCHEDULED','FIRED','CANCELLED')),
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  fired_at   timestamptz,
  CHECK (status <> 'FIRED' OR fired_at IS NOT NULL)
);
-- A sleep step registers exactly one timer, even if registration is retried.
CREATE UNIQUE INDEX timers_step_type_uniq ON timers (step_id, timer_type) WHERE step_id IS NOT NULL;
CREATE INDEX timers_due_idx ON timers (fire_at) WHERE status = 'SCHEDULED';

CREATE TABLE artifacts (
  id         uuid PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES tasks(id),
  step_id    uuid REFERENCES steps(id),
  attempt_id uuid REFERENCES attempts(id),
  type       text NOT NULL,
  uri        text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);
CREATE INDEX artifacts_task_idx ON artifacts (task_id);

CREATE TABLE task_history (
  id             bigserial PRIMARY KEY,
  task_id        uuid NOT NULL REFERENCES tasks(id),
  step_id        uuid,
  attempt_id     uuid,
  event_type     text NOT NULL,
  previous_state text,
  new_state      text,
  payload        jsonb NOT NULL DEFAULT '{}',
  "timestamp"    timestamptz NOT NULL
);
CREATE INDEX task_history_task_idx ON task_history (task_id, id);

-- History is append-only application data.
CREATE FUNCTION task_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'task_history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER task_history_no_update BEFORE UPDATE OR DELETE ON task_history
  FOR EACH ROW EXECUTE FUNCTION task_history_append_only();

CREATE TABLE idempotency_records (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
