import { isTerminalTask } from '@durable/core';
import type { Engine } from '@durable/engine';
import { repoConfig, type AgentRunnerConfig, type RepoConfig } from './config';
import { decideFactory, type FactoryDecision } from './factory';
import { loadPolicy } from './factory-handlers';
import { classifyPullRequest } from './pr-signal';
import type { AgentPolicy } from './policy';
import { LABELS, type SourceResolver } from './source';
import { PR_OUTCOME_EVENT } from './workflow';

/**
 * PR watcher: for every agent-run waiting in its `review` step, read the PR
 * and, if something actionable happened, signal the run.
 *
 * Without the factory, the outcome is the platform state (merged, CI red,
 * changes requested, ...). With the factory, it is `decideFactory` over the
 * durable evidence (statuses on the reviewed commit, policy, approvals), which
 * can also say `ready-to-merge`.
 *
 * Correctness does not depend on this loop: the wait lives in PostgreSQL and
 * every signal is deduplicated by `<pr>:<outcome>:<head sha>`, so polling the
 * same state twice (or from two processes) causes at most one transition.
 */
export async function pollPullRequestsOnce(
  engine: Engine,
  sources: SourceResolver,
  config: AgentRunnerConfig,
): Promise<{ checked: number; signalled: number; duplicates: number; errors: number }> {
  const waiting = (
    await engine.deps.pool.query<{
      task_id: string;
      url: string;
      task_status: string;
      repo: string;
      reviewed_sha: string | null;
    }>(
      `SELECT s.task_id, s.wait->>'correlationKey' AS url, t.status AS task_status, t.input->>'repo' AS repo,
              (SELECT a.output->>'headSha' FROM steps a WHERE a.task_id = s.task_id AND a.key = 'agent') AS reviewed_sha
       FROM steps s JOIN tasks t ON t.id = s.task_id
       WHERE t.type = 'agent-run' AND s.status = 'WAITING' AND s.type = 'wait_event'
         AND s.wait->>'eventType' = $1`,
      [PR_OUTCOME_EVENT],
    )
  ).rows;
  const r = { checked: 0, signalled: 0, duplicates: 0, errors: 0 };
  const policies = new Map<string, AgentPolicy | null>(); // one read per repo per pass
  for (const w of waiting) {
    if (!w.url || isTerminalTask(w.task_status as never)) continue;
    const repo = repoConfig(config, w.repo);
    if (!repo) continue; // repo removed from config: leave the run waiting
    r.checked++;
    try {
      const source = sources(repo);
      const pr = await source.getPullRequest(w.url);
      let outcome: FactoryDecision;
      if (repo.factory && source.factory) {
        const factory = source.factory;
        if (!policies.has(repo.name)) policies.set(repo.name, await loadPolicy(factory, repo));
        outcome = decideFactory({
          pr,
          reviewedSha: w.reviewed_sha ?? '',
          policy: policies.get(repo.name)!,
          changes: await factory.getChanges(w.url),
          statuses: await factory.getStatuses(repo, pr.headSha),
          approvals: await factory.labelEvents(w.url, LABELS.approve),
          autoMergesToday: await autoMergesInLastDay(engine, repo),
        });
      } else {
        outcome = classifyPullRequest(pr);
      }
      // For UIs only: why is this run waiting? (overwritten on every poll)
      await engine.deps.pool.query(
        `INSERT INTO agent_run_watch (task_id, kind, reason, level, head_sha, checked_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (task_id) DO UPDATE SET kind = $2, reason = $3, level = $4, head_sha = $5, checked_at = $6`,
        [
          w.task_id,
          outcome.kind,
          outcome.reason,
          outcome.level ?? null,
          outcome.headSha,
          engine.deps.clock.now(),
        ],
      );
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

/** Factory auto-merges for this repo in the last 24 hours (from durable task outputs). */
async function autoMergesInLastDay(engine: Engine, repo: RepoConfig): Promise<number> {
  const since = new Date(engine.deps.clock.now().getTime() - 24 * 3600_000);
  const res = await engine.deps.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks
     WHERE type = 'agent-run' AND input->>'repo' = $1 AND completed_at >= $2
       AND output->'next'->>'decision' = 'merged' AND output->'next'->>'level' = 'auto-merge'`,
    [repo.name, since],
  );
  return res.rows[0]!.n;
}
