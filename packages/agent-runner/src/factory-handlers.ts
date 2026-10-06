import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerError } from '@durable/core';
import type { WorkerHandler, WorkContext } from '@durable/sdk';
import { runAgentProcess } from './agent-cli';
import { prepareReviewClone } from './checkout';
import { repoConfig, type AgentRunnerConfig, type RepoConfig } from './config';
import { STATUS } from './factory';
import { evaluatePolicy, parsePolicy, POLICY_PATH, type AgentPolicy } from './policy';
import { detectRateLimit } from './rate-limit';
import {
  buildReviewPrompt,
  REVIEWER_CLIS,
  resolveReviewerCli,
  type ReviewerCli,
  type ReviewVerdict,
} from './reviewers';
import type { FactoryHost, SourceResolver, TaskSource } from './source';

interface AgentResult {
  prUrl: string;
  headSha: string;
  branch: string;
}

export interface FactoryStepInput {
  repo: string;
  ref: string;
  round: number;
  agent: AgentResult;
  /** Reviewer slot (0 or 1) for review steps. */
  slot?: number;
}

export interface FactoryDeps {
  sources: SourceResolver;
  config: AgentRunnerConfig;
  /** Override the reviewer CLI registry (tests). */
  reviewers?: Record<string, ReviewerCli>;
  killGraceMs?: number;
}

/** Policy from the default branch. An unreadable or invalid file counts as "no policy" (= a human merges). */
export async function loadPolicy(
  factory: FactoryHost,
  repo: RepoConfig,
  log?: WorkContext['logger'],
): Promise<AgentPolicy | null> {
  const text = await factory.readPolicy(repo, POLICY_PATH);
  if (text === null) return null;
  try {
    return parsePolicy(text);
  } catch (e) {
    log?.warn({ err: (e as Error).message }, `invalid ${POLICY_PATH}; treating as no policy`);
    return null;
  }
}

const reviewPathOf = (repo: RepoConfig) => repo.reviewPath ?? `${repo.path}.review`;

interface Ctx {
  repo: RepoConfig;
  source: TaskSource;
  factory: FactoryHost;
  policy: AgentPolicy | null;
}

async function context(
  deps: FactoryDeps,
  input: FactoryStepInput,
  ctx: WorkContext,
): Promise<Ctx | { skipped: string }> {
  const repo = repoConfig(deps.config, input.repo);
  if (!repo) throw new WorkerError('PERMANENT', `repo ${input.repo} is not configured`);
  if (!repo.factory) return { skipped: 'factory is off for this repo' };
  const source = deps.sources(repo);
  if (!source.factory) return { skipped: `PR host ${repo.host} does not support the factory` };
  return {
    repo,
    source,
    factory: source.factory,
    policy: await loadPolicy(source.factory, repo, ctx.logger),
  };
}

/**
 * Runs the policy's verify command (e.g. the Playwright gate) in the review
 * checkout at the agent's commit, when the changed files require it, and
 * records the result as the `tpm/verify` commit status.
 */
export function createVerifyHandler(deps: FactoryDeps): WorkerHandler<FactoryStepInput, unknown> {
  return {
    async execute(input, ctx) {
      const c = await context(deps, input, ctx);
      if ('skipped' in c) return c;
      const changes = await c.factory.getChanges(input.agent.prUrl);
      const ev = evaluatePolicy(c.policy, changes);
      if (!ev.verifyRequired || !c.policy?.verify) return { skipped: 'no changed file requires verify' };

      const sha = input.agent.headSha;
      await c.factory.setStatus(c.repo, sha, STATUS.verify, 'pending', 'running verify');
      const reviewPath = reviewPathOf(c.repo);
      await prepareReviewClone({
        authorPath: c.repo.path,
        reviewPath,
        branch: input.agent.branch,
        defaultBranch: c.repo.defaultBranch,
        sha,
      });
      const logFile = join(
        deps.config.runsDir,
        input.ref.replace(/[^A-Za-z0-9._-]+/g, '_'),
        `${ctx.item.attemptId}.verify.log`,
      );
      const bound = new AbortController();
      const timer = setTimeout(
        () => bound.abort(new WorkerError('TIMEOUT', `verify exceeded ${c.policy!.verify!.timeoutMinutes}m`)),
        c.policy.verify.timeoutMinutes * 60_000,
      );
      let res;
      try {
        res = await runAgentProcess({
          bin: 'bash',
          args: ['-lc', c.policy.verify.command],
          cwd: reviewPath,
          logFile,
          signal: AbortSignal.any([ctx.signal, bound.signal]),
          killGraceMs: deps.killGraceMs,
        });
      } catch (e) {
        if (e instanceof WorkerError && e.category === 'TIMEOUT') {
          await c.factory.setStatus(c.repo, sha, STATUS.verify, 'failure', 'verify timed out');
          return { passed: false, timedOut: true, logFile };
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
      ctx.addArtifact({ type: 'verify-log', uri: pathToFileURL(logFile).href });
      const passed = res.exitCode === 0;
      await c.factory.setStatus(
        c.repo,
        sha,
        STATUS.verify,
        passed ? 'success' : 'failure',
        passed ? 'verify passed' : `verify failed (exit ${res.exitCode})`,
      );
      if (!passed) {
        await c.factory.commentOnPr(
          input.agent.prUrl,
          `🧪 \`${c.policy.verify.command}\` failed on ${sha.slice(0, 7)} (exit ${res.exitCode}).\n\n\`\`\`\n${res.tail.slice(-3000)}\n\`\`\``,
          `review:verify:${sha}`,
        );
      }
      return { passed, exitCode: res.exitCode, logFile };
    },
  };
}

const STATE: Record<ReviewVerdict['verdict'], 'success' | 'failure' | 'error'> = {
  approve: 'success',
  'request-changes': 'failure',
  'needs-human': 'error',
};

function renderReview(name: string, sha: string, v: ReviewVerdict, costUsd?: number): string {
  const icon = v.verdict === 'approve' ? '✅' : v.verdict === 'request-changes' ? '✋' : '👀';
  const findings = v.findings
    .map(
      (f) =>
        `- **${f.severity}**${f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.comment}`,
    )
    .join('\n');
  return `${icon} **${name} review of ${sha.slice(0, 7)}: ${v.verdict}**\n\n${v.summary}${findings ? `\n\n${findings}` : ''}${
    costUsd !== undefined ? `\n\n<sub>cost $${costUsd.toFixed(2)}</sub>` : ''
  }`;
}

/**
 * One agent reviewer (slot 0 or 1 of the policy's reviewers). Read-only, in
 * the review checkout at the agent's commit. The verdict becomes the
 * `tpm/review-<name>` status on that commit plus a PR comment with findings
 * (which are the feedback for the next round). Any reviewer malfunction is
 * "needs-human", never "approve".
 */
export function createReviewerHandler(deps: FactoryDeps): WorkerHandler<FactoryStepInput, unknown> {
  const registry = { ...REVIEWER_CLIS, ...(deps.reviewers ?? {}) };
  return {
    async execute(input, ctx) {
      const c = await context(deps, input, ctx);
      if ('skipped' in c) return c;
      const slot = input.slot ?? 0;
      const spec = c.policy?.reviewers[slot];
      if (!spec) return { skipped: `no reviewer in slot ${slot}` };
      const sha = input.agent.headSha;

      // Do not spend a review when the outcome is already decided.
      const statuses = await c.factory.getStatuses(c.repo, sha);
      const changes = await c.factory.getChanges(input.agent.prUrl);
      const ev = evaluatePolicy(c.policy, changes);
      if (ev.verifyRequired && statuses[STATUS.verify]?.state !== 'success')
        return { skipped: 'verify did not pass' };
      const earlier = c
        .policy!.reviewers.slice(0, slot)
        .find((r) => statuses[STATUS.review(r.name)]?.state !== 'success');
      if (earlier) return { skipped: `${earlier.name} did not approve` };
      const existing = statuses[STATUS.review(spec.name)];
      if (existing && existing.state !== 'pending')
        return { reused: true, state: existing.state, description: existing.description };

      await c.factory.setStatus(c.repo, sha, STATUS.review(spec.name), 'pending', 'reviewing');
      const reviewPath = reviewPathOf(c.repo);
      await prepareReviewClone({
        authorPath: c.repo.path,
        reviewPath,
        branch: input.agent.branch,
        defaultBranch: c.repo.defaultBranch,
        sha,
      });
      const cli = resolveReviewerCli(spec.name, registry);
      const task = await c.source.get(input.ref);
      const prompt = buildReviewPrompt({
        task,
        defaultBranch: c.repo.defaultBranch,
        branch: input.agent.branch,
        sha,
        level: ev.level,
        format: cli.format,
      });
      const logFile = join(
        deps.config.runsDir,
        input.ref.replace(/[^A-Za-z0-9._-]+/g, '_'),
        `${ctx.item.attemptId}.review-${spec.name}.log`,
      );
      const res = await runAgentProcess({
        bin: cli.bin,
        args: cli.buildArgs(prompt, { model: spec.model, maxBudgetUsd: spec.maxBudgetUsd }),
        cwd: reviewPath,
        logFile,
        signal: ctx.signal,
        killGraceMs: deps.killGraceMs,
        env: { DURABLE_REVIEWER: spec.name },
      });
      ctx.addArtifact({
        type: 'review-log',
        uri: pathToFileURL(logFile).href,
        metadata: { reviewer: spec.name },
      });

      let verdict = res.spawnError ? null : cli.parse(res.tail);
      if (!verdict) {
        const limit = detectRateLimit(res.tail, Date.now());
        if (limit.limited)
          throw new WorkerError('TRANSIENT', `${spec.name} usage limit reached`, limit.retryAfterMs, false);
        verdict = {
          verdict: 'needs-human',
          summary: res.spawnError
            ? `reviewer could not start: ${res.spawnError}`
            : `reviewer output could not be read (exit ${res.exitCode}); see ${logFile}`,
          findings: [],
        };
      }
      const cost = (() => {
        try {
          return (JSON.parse(res.tail.trim().split('\n').pop() ?? '{}') as { total_cost_usd?: number })
            .total_cost_usd;
        } catch {
          return undefined;
        }
      })();
      // Comment first, status last: the status is what the decision reads.
      await c.factory.commentOnPr(
        input.agent.prUrl,
        renderReview(spec.name, sha, verdict, cost),
        `review:${sha}:${spec.name}`,
      );
      await c.factory.setStatus(
        c.repo,
        sha,
        STATUS.review(spec.name),
        STATE[verdict.verdict],
        `${verdict.verdict}: ${verdict.summary}`,
      );
      return { reviewer: spec.name, sha, ...verdict, costUsd: cost };
    },
  };
}
