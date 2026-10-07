-- Live events for UIs: every committed history row and every change of the
-- PR watcher's waiting reason is announced on channel `durable_events`.
-- NOTIFY is delivered only when the transaction commits, so listeners never
-- see a change that was rolled back. Payloads are small (well below the 8 kB
-- NOTIFY limit); clients fetch details through the API.
CREATE FUNCTION durable_notify_history() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('durable_events', json_build_object(
    'id', NEW.id,
    'kind', 'history',
    'taskId', NEW.task_id,
    'taskType', (SELECT type FROM tasks WHERE id = NEW.task_id),
    'stepId', NEW.step_id,
    'eventType', NEW.event_type,
    'newState', NEW.new_state,
    'at', to_char(NEW."timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_history_notify AFTER INSERT ON task_history
  FOR EACH ROW EXECUTE FUNCTION durable_notify_history();

CREATE FUNCTION durable_notify_watch() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind IS NOT DISTINCT FROM NEW.kind AND OLD.reason IS NOT DISTINCT FROM NEW.reason THEN
    RETURN NULL; -- the watcher re-polls every few seconds; only changes are news
  END IF;
  PERFORM pg_notify('durable_events', json_build_object(
    'id', 0,
    'kind', 'watch',
    'taskId', NEW.task_id,
    'taskType', (SELECT type FROM tasks WHERE id = NEW.task_id),
    'stepId', NULL,
    'eventType', 'watch.' || NEW.kind,
    'newState', NEW.reason,
    'at', to_char(NEW.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_run_watch_notify AFTER INSERT OR UPDATE ON agent_run_watch
  FOR EACH ROW EXECUTE FUNCTION durable_notify_watch();
