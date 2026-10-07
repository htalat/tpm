import { toHistoryEvent, type RegisterRoute } from '@durable/contract';
import { z } from 'zod';
import { DomainError, isTerminalTask, NotFoundError, type TaskStatus } from '@durable/core';
import type { Engine } from '@durable/engine';
import { repoConfig, type AgentRunnerConfig } from './config';
import { LABELS, type SourceResolver } from './source';

/**
 * Read model and actions for UIs (the menu bar app). Everything here is
 * derived from durable data (tasks, steps, the watcher's latest decision);
 * actions go through the same paths as a human would (labels, cancel).
 */
const STEP_ORDER = ['start', 'prepare', 'agent', 'finish', 'verify', 'reviewA', 'reviewB', 'review', 'close'];

export type AttentionKind = 'approve' | 'human' | 'failed' | 'blocked';

export interface AgentRunSummary {
  id: string;
  ref: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  round: number;
  status: TaskStatus;
  /** The step the run is at (first one not finished). */
  step: { key: string; status: string } | null;
  steps: Array<{ key: string; status: string }>;
  prUrl: string | null;
  headSha: string | null;
  watch: { kind: string; reason: string; level: string | null; checkedAt: string } | null;
  outcome: { kind: string; reason: string } | null;
  decision: string | null;
  attention: { kind: AttentionKind; reason: string } | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface Row {
  id: string;
  status: TaskStatus;
  input: { ref: string; repo: string; number: number; title: string; url: string; round: number };
  output: { outcome?: { kind: string; reason: string }; next?: { decision: string } } | null;
  error: { message?: string } | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  newer: boolean;
  w_kind: string | null;
  w_reason: string | null;
  w_level: string | null;
  w_checked: Date | null;
}

interface StepRow {
  task_id: string;
  key: string;
  status: string;
  output: Record<string, unknown> | null;
  error: { message?: string } | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function summarize(r: Row, steps: StepRow[]): AgentRunSummary {
  const top = STEP_ORDER.map((k) => steps.find((s) => s.key === k)).filter((s): s is StepRow => !!s);
  const current = top.find((s) => !['COMPLETED', 'SKIPPED'].includes(s.status)) ?? null;
  const agent = top.find((s) => s.key === 'agent')?.output as {
    prUrl?: string;
    headSha?: string;
    costUsd?: number;
  } | null;
  const cost =
    num(agent?.costUsd) +
    top.filter((s) => s.key.startsWith('review')).reduce((n, s) => n + num(s.output?.costUsd), 0);
  const watch = r.w_kind
    ? { kind: r.w_kind, reason: r.w_reason ?? '', level: r.w_level, checkedAt: r.w_checked!.toISOString() }
    : null;
  const decision = r.output?.next?.decision ?? null;
  let attention: AgentRunSummary['attention'] = null;
  if (!r.newer) {
    // A newer round for the same item supersedes anything older asked of you.
    if (r.status === 'FAILED') attention = { kind: 'failed', reason: r.error?.message ?? 'run failed' };
    else if (r.status === 'BLOCKED')
      attention = { kind: 'blocked', reason: 'a step needs an operator decision' };
    else if (r.status === 'COMPLETED' && decision === 'human')
      attention = { kind: 'human', reason: r.output?.outcome?.reason ?? 'needs a human' };
    else if (r.status === 'COMPLETED' && decision === 'failed')
      attention = { kind: 'failed', reason: r.output?.outcome?.reason ?? 'failed' };
    else if (
      r.status === 'WAITING' &&
      watch?.kind === 'no-action' &&
      watch.reason.startsWith('policy: waiting for approval')
    ) {
      attention = { kind: 'approve', reason: watch.reason };
    }
  }
  return {
    id: r.id,
    ...r.input,
    status: r.status,
    step: current ? { key: current.key, status: current.status } : null,
    steps: top.map((s) => ({ key: s.key, status: s.status })),
    prUrl: agent?.prUrl ?? null,
    headSha: agent?.headSha ?? null,
    watch,
    outcome: r.output?.outcome ?? null,
    decision,
    attention,
    costUsd: Math.round(cost * 10000) / 10000,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
  };
}

export async function listAgentRuns(engine: Engine, limit = 50, ids?: string[]): Promise<AgentRunSummary[]> {
  const rows = (
    await engine.deps.pool.query<Row>(
      `SELECT t.id, t.status, t.input, t.output, t.error, t.created_at, t.updated_at, t.completed_at,
              EXISTS (SELECT 1 FROM tasks n WHERE n.type = 'agent-run' AND n.metadata->>'sourceRef' = t.metadata->>'sourceRef'
                      AND n.created_at > t.created_at) AS newer,
              w.kind AS w_kind, w.reason AS w_reason, w.level AS w_level, w.checked_at AS w_checked
       FROM tasks t LEFT JOIN agent_run_watch w ON w.task_id = t.id
       WHERE t.type = 'agent-run' AND ($2::uuid[] IS NULL OR t.id = ANY($2::uuid[]))
       ORDER BY t.created_at DESC LIMIT $1`,
      [limit, ids ?? null],
    )
  ).rows;
  if (rows.length === 0) return [];
  const steps = (
    await engine.deps.pool.query<StepRow>(
      `SELECT task_id, key, status, output, error FROM steps WHERE task_id = ANY($1::uuid[]) AND parent_step_id IS NULL`,
      [rows.map((r) => r.id)],
    )
  ).rows;
  return rows.map((r) =>
    summarize(
      r,
      steps.filter((s) => s.task_id === r.id),
    ),
  );
}

export function overview(runs: AgentRunSummary[], now: Date) {
  const day = now.getTime() - 24 * 3600_000;
  const recent = runs.filter((r) => Date.parse(r.createdAt) >= day);
  return {
    active: runs.filter((r) => !isTerminalTask(r.status)).length,
    attention: runs.filter((r) => r.attention).length,
    mergedLast24h: runs.filter(
      (r) =>
        r.completedAt &&
        Date.parse(r.completedAt) >= day &&
        (r.decision === 'merged' || r.decision === 'done'),
    ).length,
    failedLast24h: runs.filter(
      (r) => r.completedAt && Date.parse(r.completedAt) >= day && r.attention?.kind === 'failed',
    ).length,
    costLast24hUsd: Math.round(recent.reduce((n, r) => n + r.costUsd, 0) * 100) / 100,
  };
}

export function registerAgentRunRoutes(
  register: RegisterRoute,
  deps: { engine: Engine; config: AgentRunnerConfig; sources: SourceResolver },
): void {
  const one = async (id: string) => {
    const [run] = await listAgentRuns(deps.engine, 1, [id]);
    if (!run) throw new NotFoundError('agent-run', id);
    const repo = repoConfig(deps.config, run.repo);
    if (!repo) throw new DomainError('CONFLICT', `repo ${run.repo} is not configured`);
    return { run, repo, source: deps.sources(repo) };
  };

  register('listAgentRuns', async ({ query }) => {
    const runs = await listAgentRuns(deps.engine, query.limit);
    return {
      runs,
      overview: overview(runs, deps.engine.deps.clock.now()),
      repos: deps.config.repos.map((r) => ({ name: r.name, factory: r.factory })),
    };
  });

  register('getAgentRun', async ({ params }) => {
    const { run } = await one(params.id);
    return { run, history: (await deps.engine.getHistory(params.id)).map((h) => toHistoryEvent(h as never)) };
  });

  /** Add the approve label to the run's PR, as the human approver would. */
  register('approveAgentRun', async ({ params }) => {
    const { run, source } = await one(params.id);
    if (run.attention?.kind !== 'approve' || !run.prUrl)
      throw new DomainError('CONFLICT', 'this run is not waiting for an approval');
    if (!source.factory) throw new DomainError('CONFLICT', 'the PR host does not support approvals');
    await source.factory.addPrLabel(run.prUrl, LABELS.approve);
    return { ok: true as const };
  });

  /** Put the item back in the queue (a new round starts on the next sync). */
  register('retryAgentRun', async ({ params }) => {
    const { run, source } = await one(params.id);
    if (!isTerminalTask(run.status) && run.status !== 'BLOCKED')
      throw new DomainError('CONFLICT', 'the run is still active; cancel it first');
    await source.updateLabels(run.ref, {
      add: [LABELS.ready],
      remove: [LABELS.failed, LABELS.review, LABELS.done],
    });
    return { ok: true as const };
  });

  /** Cancel the run and tell the tracker. Completed side effects are not undone. */
  register('cancelAgentRun', async ({ params }) => {
    const { run, source } = await one(params.id);
    await deps.engine.cancelTask(run.id, 'cancelled from the menu bar');
    await source.updateLabels(run.ref, {
      add: [LABELS.failed],
      remove: [LABELS.running, LABELS.review, LABELS.ready, LABELS.done],
    });
    await source.comment(
      run.ref,
      `🛑 Agent run cancelled by a human (round ${run.round}).`,
      `cancel:${run.id}`,
    );
    return { ok: true as const };
  });
}
