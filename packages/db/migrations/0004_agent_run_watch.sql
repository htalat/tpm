-- Latest PR-watcher decision per waiting agent-run, for UIs ("waiting for your
-- approval"). Not part of the correctness model: the run's progress is driven
-- only by deduplicated signals; this row is overwritten on every poll.
CREATE TABLE agent_run_watch (
  task_id    uuid PRIMARY KEY REFERENCES tasks(id),
  kind       text NOT NULL,
  reason     text NOT NULL,
  level      text,
  head_sha   text,
  checked_at timestamptz NOT NULL
);
