import { defineWorkflow, sequence, step, waitForEvent } from '@durable/core';

export interface AgentRunInput {
  ref: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  round: number;
  maxRounds: number;
}

/** Durable snapshot of the PR before the agent runs; the round is measured against it. */
export interface RoundBaseline {
  pr: { url: string; headSha: string; state: string } | null;
  feedback: string | null;
}

export const PR_OUTCOME_EVENT = 'pr.outcome';

const inp = (ctx: { input: unknown }) => ctx.input as AgentRunInput;
const factoryInput = (ctx: { input: unknown; outputs: Readonly<Record<string, unknown>> }) => ({
  repo: inp(ctx).repo,
  ref: inp(ctx).ref,
  round: inp(ctx).round,
  agent: ctx.outputs.agent,
});

/**
 * One round of agent work on one tracker item:
 *
 *   start    tracker: ready -> running, comment          compensate: running -> failed, comment
 *   prepare  snapshot the PR (head SHA + review feedback) BEFORE the agent runs
 *   agent    agent CLI in the checkout (one per repo); succeeds only if the PR exists
 *            and its head moved past the baseline; reconcile uses the same rule
 *   finish   tracker: running -> review, comment with PR
 *   verify   factory: run the policy's verify command at the agent's commit -> status tpm/verify
 *   reviewA  factory: independent agent reviewer #1 (read-only) -> status tpm/review-<name>
 *   reviewB  factory: independent agent reviewer #2 -> status tpm/review-<name>
 *   review   durable wait for a `pr.outcome` signal from the PR watcher (days are fine)
 *   close    ready-to-merge -> merge exactly the reviewed commit; merged -> done | needs agent -> ready (next round, capped)
 *            | needs human -> stay in review | abandoned -> failed
 *
 * The baseline is its own step: if the agent step took it, a retry after a
 * crash would snapshot the agent's own push and wrongly see "no change".
 * A new round is a new task (continue-as-new), triggered by the label.
 */
export const agentRunWorkflow = defineWorkflow({
  name: 'agent-run',
  version: 4,
  description: 'One round of coding-agent work on a tracker item, through PR review',
  steps: {
    start: step({
      executor: 'tracker',
      input: (ctx) => ({ op: 'start', repo: inp(ctx).repo, ref: inp(ctx).ref, round: inp(ctx).round }),
      retry: { maxAttempts: 5, initialDelayMs: 5000 },
      compensate: {
        executor: 'tracker',
        input: (ctx) => ({
          op: 'fail',
          repo: inp(ctx).repo,
          ref: inp(ctx).ref,
          round: inp(ctx).round,
          reason: ctx.failure
            ? `${ctx.failure.stepKey}: ${ctx.failure.category} — ${ctx.failure.message}`
            : 'unknown',
        }),
        retry: { maxAttempts: 10, initialDelayMs: 5000 },
      },
    }),
    prepare: step({
      executor: 'tracker',
      input: (ctx) => ({ op: 'snapshot', repo: inp(ctx).repo, ref: inp(ctx).ref, round: inp(ctx).round }),
      effect: 'pure',
      retry: { maxAttempts: 5, initialDelayMs: 5000 },
    }),
    agent: step({
      executor: 'agent-cli',
      input: (ctx) => ({ ...inp(ctx), baseline: ctx.outputs.prepare as RoundBaseline }),
      // One agent per checkout at a time (tpm's same_repo_strategy: serialize).
      concurrencyGroup: { key: (input) => `repo:${(input as AgentRunInput).repo}`, limit: 1 },
      effect: 'idempotent',
      // Backstop only: the worker enforces the per-repo time bound itself.
      timeoutMs: 6 * 3600_000,
      retry: {
        maxAttempts: 3,
        initialDelayMs: 60_000,
        maxDelayMs: 15 * 60_000,
        retryOn: ['TRANSIENT', 'TIMEOUT', 'AMBIGUOUS'],
      },
    }),
    finish: step({
      executor: 'tracker',
      input: (ctx) => ({
        op: 'finish',
        repo: inp(ctx).repo,
        ref: inp(ctx).ref,
        round: inp(ctx).round,
        agent: ctx.outputs.agent,
      }),
      retry: { maxAttempts: 10, initialDelayMs: 5000 },
    }),
    // Software factory gates (no-ops when the repo's factory is off). They share
    // the read-only review checkout, so they run one at a time per repo.
    verify: step({
      executor: 'verify',
      input: (ctx) => factoryInput(ctx),
      concurrencyGroup: { key: (input) => `review:${(input as { repo: string }).repo}`, limit: 1 },
      timeoutMs: 4 * 3600_000,
      retry: { maxAttempts: 3, initialDelayMs: 30_000 },
    }),
    reviewA: step({
      executor: 'reviewer',
      input: (ctx) => ({ ...factoryInput(ctx), slot: 0 }),
      concurrencyGroup: { key: (input) => `review:${(input as { repo: string }).repo}`, limit: 1 },
      timeoutMs: 2 * 3600_000,
      retry: { maxAttempts: 3, initialDelayMs: 30_000 },
    }),
    reviewB: step({
      executor: 'reviewer',
      input: (ctx) => ({ ...factoryInput(ctx), slot: 1 }),
      concurrencyGroup: { key: (input) => `review:${(input as { repo: string }).repo}`, limit: 1 },
      timeoutMs: 2 * 3600_000,
      retry: { maxAttempts: 3, initialDelayMs: 30_000 },
    }),
    review: waitForEvent(PR_OUTCOME_EVENT, {
      correlationKey: (ctx) => (ctx.outputs.agent as { prUrl: string }).prUrl,
    }),
    close: step({
      executor: 'tracker',
      input: (ctx) => ({
        op: 'close',
        repo: inp(ctx).repo,
        ref: inp(ctx).ref,
        round: inp(ctx).round,
        maxRounds: inp(ctx).maxRounds,
        outcome: ctx.outputs.review,
      }),
      retry: { maxAttempts: 10, initialDelayMs: 5000 },
    }),
  },
  flow: sequence('start', 'prepare', 'agent', 'finish', 'verify', 'reviewA', 'reviewB', 'review', 'close'),
  output: (ctx) => ({ pr: ctx.outputs.agent, outcome: ctx.outputs.review, next: ctx.outputs.close }),
});
