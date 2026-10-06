import { defineWorkflow, sequence, step } from '@durable/core';

export interface AgentRunInput {
  ref: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  round: number;
}

const inp = (ctx: { input: unknown }) => ctx.input as AgentRunInput;

/**
 * One agent run for one tracker item:
 *
 *   start   (tracker: ready -> running, comment)       compensate: running -> failed, comment
 *   agent   (agent CLI in the checkout; one per repo)   reconcile: did a PR appear on the branch?
 *   finish  (tracker: running -> review, comment with PR)
 *
 * The agent step is `idempotent`: a lost lease is AMBIGUOUS and the retry
 * first asks the tracker for a PR on the deterministic branch, so a crash
 * after the agent opened its PR never starts a second agent.
 */
export const agentRunWorkflow = defineWorkflow({
  name: 'agent-run',
  description: 'Run a coding agent for one tracker item and hand the PR back to a human',
  steps: {
    start: step({
      executor: 'tracker',
      input: (ctx) => ({ op: 'start', ref: inp(ctx).ref, round: inp(ctx).round }),
      retry: { maxAttempts: 5, initialDelayMs: 5000 },
      compensate: {
        executor: 'tracker',
        input: (ctx) => ({
          op: 'fail',
          ref: inp(ctx).ref,
          round: inp(ctx).round,
          reason: ctx.failure
            ? `${ctx.failure.stepKey}: ${ctx.failure.category} — ${ctx.failure.message}`
            : 'unknown',
        }),
        retry: { maxAttempts: 10, initialDelayMs: 5000 },
      },
    }),
    agent: step({
      executor: 'agent-cli',
      input: (ctx) => ({ ...inp(ctx) }),
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
      input: (ctx) => ({ op: 'finish', ref: inp(ctx).ref, round: inp(ctx).round, agent: ctx.outputs.agent }),
      retry: { maxAttempts: 10, initialDelayMs: 5000 },
    }),
  },
  flow: sequence('start', 'agent', 'finish'),
  output: (ctx) => ctx.outputs.agent,
});
