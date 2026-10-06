import { isTerminalTask } from '@durable/core';
import type { Engine } from '@durable/engine';
import { classifyPullRequest } from './pr-signal';
import type { TaskSource } from './source';
import { PR_OUTCOME_EVENT } from './workflow';

/**
 * PR watcher: for every agent-run waiting in its `review` step, read the PR
 * and, if something actionable happened, signal the run.
 *
 * Correctness does not depend on this loop: the wait lives in PostgreSQL, the
 * signal is deduplicated by `<pr>:<outcome>:<head sha>`, so polling the same
 * state twice (or from two processes) causes at most one transition, and a new
 * push produces a new, distinct event.
 */
export async function pollPullRequestsOnce(
  engine: Engine,
  source: TaskSource,
): Promise<{ checked: number; signalled: number; duplicates: number; errors: number }> {
  const waiting = (
    await engine.deps.pool.query<{ task_id: string; url: string; task_status: string }>(
      `SELECT s.task_id, s.wait->>'correlationKey' AS url, t.status AS task_status
       FROM steps s JOIN tasks t ON t.id = s.task_id
       WHERE t.type = 'agent-run' AND s.status = 'WAITING' AND s.type = 'wait_event'
         AND s.wait->>'eventType' = $1`,
      [PR_OUTCOME_EVENT],
    )
  ).rows;
  const r = { checked: 0, signalled: 0, duplicates: 0, errors: 0 };
  for (const w of waiting) {
    if (!w.url || isTerminalTask(w.task_status as never)) continue;
    r.checked++;
    try {
      const outcome = classifyPullRequest(await source.getPullRequest(w.url));
      if (outcome.kind === 'no-action') continue;
      const res = await engine.signal(w.task_id, {
        type: PR_OUTCOME_EVENT,
        correlationKey: w.url,
        payload: outcome,
        deduplicationKey: `${outcome.url}:${outcome.kind}:${outcome.headSha}`,
      });
      if (res.duplicate) r.duplicates++;
      else r.signalled++;
    } catch (e) {
      r.errors++;
      engine.deps.logger.warn(
        { task_id: w.task_id, err: (e as Error).message },
        'PR poll failed; will retry',
      );
    }
  }
  return r;
}
