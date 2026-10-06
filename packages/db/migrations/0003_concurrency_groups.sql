-- Concurrency groups: at most `concurrency_limit` RUNNING steps share a
-- `concurrency_key` (e.g. "one agent per git checkout"). Enforced at claim time
-- under a transaction-scoped advisory lock on the key.
ALTER TABLE steps ADD COLUMN concurrency_key text;
ALTER TABLE steps ADD COLUMN concurrency_limit integer;
ALTER TABLE steps ADD CONSTRAINT steps_concurrency_pair
  CHECK ((concurrency_key IS NULL) = (concurrency_limit IS NULL) AND (concurrency_limit IS NULL OR concurrency_limit > 0));
CREATE INDEX steps_concurrency_running_idx ON steps (concurrency_key) WHERE status = 'RUNNING' AND concurrency_key IS NOT NULL;

-- Failures the worker reports as not chargeable (e.g. the account hit a
-- provider usage limit: the step itself did nothing wrong). They do not count
-- toward retry_policy.maxAttempts, up to a hard cap enforced by the engine.
ALTER TABLE steps ADD COLUMN uncharged_attempts integer NOT NULL DEFAULT 0 CHECK (uncharged_attempts >= 0);
