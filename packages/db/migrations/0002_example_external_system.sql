-- SIMULATED EXTERNAL SYSTEM used by the example side-effect workers.
-- It lives in its own schema to make clear that it is NOT engine state: the
-- engine never reads or writes it, and writes to it are not part of any engine
-- transaction. It models a third-party API (payments, inventory, email) that
-- accepts an idempotency key, like Stripe's Idempotency-Key header.
CREATE SCHEMA example_external;

CREATE TABLE example_external.operations (
  id              bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  operation       text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  result          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Every call (including deduplicated repeats) is logged, so tests can prove
-- that retries happened while the effect happened once.
CREATE TABLE example_external.call_log (
  id              bigserial PRIMARY KEY,
  idempotency_key text NOT NULL,
  operation       text NOT NULL,
  applied         boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
