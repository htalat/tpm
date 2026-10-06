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
import { branchFor, LABELS, type TaskSource } from './source';
import type { AgentRunInput } from './workflow';

export interface AgentRunOutput {
  prUrl: string;
  prState: string;
  branch: string;
  exitCode: number | null;
  reconciled?: boolean;
}

interface TrackerInput {
  op: 'start' | 'finish' | 'fail';
  ref: string;
  round: number;
  reason?: string;
  agent?: AgentRunOutput;
}

/**
 * Tracker side effects. Each op is idempotent: label edits converge, and the
 * comment marker is the step's idempotency key, so a retried attempt never
 * posts twice.
 */
export function createTrackerHandler(source: TaskSource): WorkerHandler<TrackerInput, { ok: true }> {
  return {
    async execute(input, ctx) {
      const marker = ctx.idempotencyKey;
      switch (input.op) {
        case 'start':
          await source.updateLabels(input.ref, {
            add: [LABELS.running],
            remove: [LABELS.ready, LABELS.failed, LABELS.review],
          });
          await source.comment(input.ref, `🤖 Agent run started (round ${input.round}).`, marker);
          break;
        case 'finish':
          await source.updateLabels(input.ref, { add: [LABELS.review], remove: [LABELS.running] });
          await source.comment(
            input.ref,
            `🤖 Agent finished: ${input.agent?.prUrl ?? '(no PR)'} — ready for review.`,
            marker,
          );
          break;
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
          break;
      }
      return { ok: true };
    },
  };
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
export function createAgentCliHandler(
  deps: AgentCliHandlerDeps,
): WorkerHandler<AgentRunInput, AgentRunOutput> {
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
          args: cli.buildArgs(buildPrompt(task, repo, branch, input.round), repo.path, repo.model),
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

      const prs = await deps.source.findPullRequests(input.ref, branch);
      if (prs.length > 0) {
        // The PR exists in the tracker now; from here on, a crash is AMBIGUOUS and reconcile will find it.
        ctx.crashPoint('AFTER_SIDE_EFFECT');
        return { prUrl: prs[0]!.url, prState: prs[0]!.state, branch, exitCode: res.exitCode };
      }
      const lastLine = res.tail.trim().split('\n').pop()?.slice(0, 300) ?? '';
      throw new WorkerError(
        'TRANSIENT',
        `agent exited (code ${res.exitCode ?? res.signal}) without a pull request on ${branch}. Log: ${logFile}. Last output: ${lastLine}`,
      );
    },

    async reconcile(input) {
      const task = await deps.source.get(input.ref);
      const branch = branchFor(task);
      const prs = await deps.source.findPullRequests(input.ref, branch);
      if (prs.length === 0) return { outcome: 'NOT_APPLIED' };
      return {
        outcome: 'APPLIED',
        output: { prUrl: prs[0]!.url, prState: prs[0]!.state, branch, exitCode: null, reconciled: true },
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
