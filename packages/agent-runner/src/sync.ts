import { isTerminalTask, type TaskStatus } from '@durable/core';
import type { Engine } from '@durable/engine';
import type { AgentRunnerConfig } from './config';
import type { TaskSource } from './source';
import type { AgentRunInput } from './workflow';

/**
 * Turn tracker items labelled `tpm:agent:ready` into `agent-run` tasks.
 *
 * Safe to run from several processes at once and to crash at any point: the
 * create uses the idempotency key `agent-run:<ref>:<round>`, where round =
 * number of runs already created for the item + 1, so two syncers that race
 * create the same task. An item with a non-terminal run is skipped.
 */
export async function syncOnce(
  engine: Engine,
  source: TaskSource,
  config: AgentRunnerConfig,
): Promise<{ created: string[]; skipped: number }> {
  const ready = await source.listReady(config.repos.map((r) => r.name));
  const created: string[] = [];
  let skipped = 0;
  for (const item of ready) {
    const runs = (
      await engine.deps.pool.query<{ id: string; status: TaskStatus }>(
        `SELECT id, status FROM tasks WHERE type = 'agent-run' AND metadata->>'sourceRef' = $1 ORDER BY created_at`,
        [item.ref],
      )
    ).rows;
    if (runs.some((r) => !isTerminalTask(r.status))) {
      skipped++;
      continue;
    }
    const round = runs.length + 1;
    const repo = config.repos.find((r) => r.name === item.repo)!;
    const input: AgentRunInput = {
      maxRounds: repo.maxRounds,
      ref: item.ref,
      repo: item.repo,
      number: item.number,
      title: item.title,
      url: item.url,
      round,
    };
    const { task, created: isNew } = await engine.createTask(
      { type: 'agent-run', input, metadata: { sourceRef: item.ref, round } },
      `agent-run:${item.ref}:${round}`,
    );
    if (isNew) created.push(task.id);
  }
  return { created, skipped };
}
