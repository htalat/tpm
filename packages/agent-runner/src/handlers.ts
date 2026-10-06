import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerError } from '@durable/core';
import type { WorkerHandler } from '@durable/sdk';
import { AGENT_CLIS, resolveAgentCli, runAgentProcess, type AgentCli } from './agent-cli';
import { checkCheckout } from './checkout';
import { repoConfig, type AgentRunnerConfig } from './config';
import { buildPrompt } from './prompt';
import { detectRateLimit } from './rate-limit';
import type { PrOutcome } from './pr-signal';
import { branchFor, LABELS, type PullRequestState, type TaskSource } from './source';
import type { AgentRunInput, RoundBaseline } from './workflow';

export interface AgentRunOutput {
  prUrl: string;
  prState: string;
  headSha: string;
  branch: string;
  exitCode: number | null;
  reconciled?: boolean;
}

type TrackerInput =
  | { op: 'start'; ref: string; round: number }
  | { op: 'snapshot'; ref: string; round: number }
  | { op: 'finish'; ref: string; round: number; agent: AgentRunOutput }
  | { op: 'fail'; ref: string; round: number; reason?: string }
  | { op: 'close'; ref: string; round: number; maxRounds: number; outcome: PrOutcome };

export type CloseDecision = 'done' | 'next-round' | 'human' | 'failed';

/**
 * Tracker side effects. Each op is idempotent: label edits converge, and the
 * comment marker is the step's idempotency key, so a retried attempt never
 * posts twice.
 */
export function createTrackerHandler(source: TaskSource): WorkerHandler<TrackerInput, unknown> {
  return {
    async execute(input, ctx) {
      const marker = ctx.idempotencyKey;
      switch (input.op) {
        case 'start':
          await source.updateLabels(input.ref, {
            add: [LABELS.running],
            remove: [LABELS.ready, LABELS.failed, LABELS.review, LABELS.done],
          });
          await source.comment(input.ref, `🤖 Agent run started (round ${input.round}).`, marker);
          return { ok: true };

        case 'snapshot': {
          // Read-only: the baseline this round is measured against.
          const task = await source.get(input.ref);
          const prs = await source.findPullRequests(input.ref, branchFor(task));
          if (prs.length === 0) return { pr: null, feedback: null } satisfies RoundBaseline;
          const pr = await source.getPullRequest(prs[0]!.url);
          const feedback = input.round > 1 ? await source.getFeedback(pr.url) : null;
          return {
            pr: { url: pr.url, headSha: pr.headSha, state: pr.state },
            feedback,
          } satisfies RoundBaseline;
        }

        case 'finish':
          await source.updateLabels(input.ref, { add: [LABELS.review], remove: [LABELS.running] });
          await source.comment(
            input.ref,
            `🤖 Round ${input.round} done: ${input.agent.prUrl} (head ${input.agent.headSha.slice(0, 7)}) — ready for review.`,
            marker,
          );
          return { ok: true };

        case 'fail':
          await source.updateLabels(input.ref, {
            add: [LABELS.failed],
            remove: [LABELS.running, LABELS.ready],
          });
          await source.comment(
            input.ref,
            `🤖 Agent run failed (round ${input.round}).\n\n${input.reason ?? ''}\n\nAdd \`${LABELS.ready}\` to try again.`,
            marker,
          );
          return { ok: true };

        case 'close':
          return closeRound(source, input, marker);
      }
    },
  };
}

async function closeRound(
  source: TaskSource,
  input: Extract<TrackerInput, { op: 'close' }>,
  marker: string,
): Promise<{ decision: CloseDecision }> {
  const o = input.outcome;
  switch (o.kind) {
    case 'merged':
      await source.updateLabels(input.ref, { add: [LABELS.done], remove: [LABELS.review, LABELS.running] });
      await source.comment(input.ref, `✅ ${o.url} merged.`, marker);
      return { decision: 'done' };
    case 'abandoned':
      await source.updateLabels(input.ref, { add: [LABELS.failed], remove: [LABELS.review] });
      await source.comment(input.ref, `🛑 ${o.url}: ${o.reason}.`, marker);
      return { decision: 'failed' };
    case 'needs-agent':
      if (input.round < input.maxRounds) {
        // Handing the item back to the queue starts the next round (a new task).
        await source.updateLabels(input.ref, { add: [LABELS.ready], remove: [LABELS.review] });
        await source.comment(
          input.ref,
          `🔁 ${o.reason}. Starting round ${input.round + 1} of ${input.maxRounds}.`,
          marker,
        );
        return { decision: 'next-round' };
      }
      await source.comment(
        input.ref,
        `👀 ${o.reason}, but the agent already used ${input.maxRounds} round(s). A human needs to look; add \`${LABELS.ready}\` to allow one more round.`,
        marker,
      );
      return { decision: 'human' };
    default:
      await source.comment(input.ref, `👀 ${o.url}: ${o.reason}. Waiting for a human.`, marker);
      return { decision: 'human' };
  }
}

export interface AgentCliHandlerDeps {
  source: TaskSource;
  config: AgentRunnerConfig;
  /** Override or extend the agent CLI registry (tests add a fake agent). */
  agents?: Record<string, AgentCli>;
  killGraceMs?: number;
}

/**
 * Runs the configured agent CLI in the repo checkout. Success is defined by
 * durable evidence, not by the exit code: a PR on the run's branch.
 */
type AgentStepInput = AgentRunInput & { baseline: RoundBaseline };

/**
 * The round's durable evidence of work: a PR on the branch whose head moved
 * past the baseline taken before the agent started. Used by both execute and
 * reconcile, so a crash right after the push is recognised as done.
 */
async function roundResult(
  source: TaskSource,
  ref: string,
  branch: string,
  baseline: RoundBaseline,
): Promise<{ pr: PullRequestState } | { missing: string }> {
  const prs = await source.findPullRequests(ref, branch);
  if (prs.length === 0) return { missing: `no pull request on ${branch}` };
  const pr = await source.getPullRequest(prs[0]!.url);
  if (baseline.pr && pr.headSha === baseline.pr.headSha) {
    return {
      missing: `no new commits on ${pr.url} since the round started (head ${pr.headSha.slice(0, 7)})`,
    };
  }
  return { pr };
}

export function createAgentCliHandler(
  deps: AgentCliHandlerDeps,
): WorkerHandler<AgentStepInput, AgentRunOutput> {
  const agents = { ...AGENT_CLIS, ...(deps.agents ?? {}) };
  return {
    async execute(input, ctx) {
      const repo = repoConfig(deps.config, input.repo);
      if (!repo) throw new WorkerError('PERMANENT', `repo ${input.repo} is not configured`);
      if (!existsSync(repo.path)) throw new WorkerError('POLICY', `checkout ${repo.path} does not exist`);
      const check = await checkCheckout(repo.path, repo.defaultBranch);
      if (!check.ok) throw new WorkerError('POLICY', check.reason);

      const task = await deps.source.get(input.ref);
      const branch = branchFor(task);
      const cli = resolveAgentCli(repo.agent, agents);
      const logFile = join(
        deps.config.runsDir,
        input.ref.replace(/[^A-Za-z0-9._-]+/g, '_'),
        `${ctx.item.attemptId}.log`,
      );
      ctx.logger.info(
        { agent: cli.name, cwd: repo.path, log_file: logFile, event_type: 'agent.start' },
        'starting agent',
      );

      const bound = new AbortController();
      const timer = setTimeout(
        () =>
          bound.abort(new WorkerError('TIMEOUT', `agent exceeded its ${repo.timeBoundMinutes}m time bound`)),
        repo.timeBoundMinutes * 60_000,
      );
      let res;
      try {
        res = await runAgentProcess({
          bin: cli.bin,
          args: cli.buildArgs(
            buildPrompt(task, repo, branch, input.round, input.baseline?.feedback ?? null),
            repo.path,
            repo.model,
          ),
          cwd: repo.path,
          logFile,
          signal: AbortSignal.any([ctx.signal, bound.signal]),
          killGraceMs: deps.killGraceMs,
          env: { DURABLE_IDEMPOTENCY_KEY: ctx.idempotencyKey },
        });
      } finally {
        clearTimeout(timer);
      }
      ctx.addArtifact({ type: 'agent-log', uri: pathToFileURL(logFile).href, metadata: { agent: cli.name } });
      if (res.spawnError) throw new WorkerError('PERMANENT', `could not start ${cli.bin}: ${res.spawnError}`);

      const limit = detectRateLimit(res.tail, Date.now());
      if (limit.limited) {
        // The account is out of usage, not the task: retry later without using an attempt.
        throw new WorkerError('TRANSIENT', 'agent provider usage limit reached', limit.retryAfterMs, false);
      }

      const result = await roundResult(
        deps.source,
        input.ref,
        branch,
        input.baseline ?? { pr: null, feedback: null },
      );
      if ('pr' in result) {
        // The work is visible in the tracker now; from here on a crash is AMBIGUOUS and reconcile will find it.
        ctx.crashPoint('AFTER_SIDE_EFFECT');
        return {
          prUrl: result.pr.url,
          prState: result.pr.state,
          headSha: result.pr.headSha,
          branch,
          exitCode: res.exitCode,
        };
      }
      const lastLine = res.tail.trim().split('\n').pop()?.slice(0, 300) ?? '';
      throw new WorkerError(
        'TRANSIENT',
        `agent exited (code ${res.exitCode ?? res.signal}) with ${result.missing}. Log: ${logFile}. Last output: ${lastLine}`,
      );
    },

    async reconcile(input) {
      const task = await deps.source.get(input.ref);
      const branch = branchFor(task);
      const result = await roundResult(
        deps.source,
        input.ref,
        branch,
        input.baseline ?? { pr: null, feedback: null },
      );
      if (!('pr' in result)) return { outcome: 'NOT_APPLIED' };
      return {
        outcome: 'APPLIED',
        output: {
          prUrl: result.pr.url,
          prState: result.pr.state,
          headSha: result.pr.headSha,
          branch,
          exitCode: null,
          reconciled: true,
        },
      };
    },
  };
}

export function createAgentRunnerHandlers(deps: AgentCliHandlerDeps) {
  return {
    tracker: createTrackerHandler(deps.source),
    'agent-cli': createAgentCliHandler(deps),
  };
}
