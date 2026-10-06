import { z } from 'zod';
import {
  childTask,
  defineWorkflow,
  map,
  parallel,
  sequence,
  sleep,
  step,
  waitForEvent,
  WorkflowRegistry,
  type WorkflowContext,
} from '@durable/core';

type Obj = Record<string, unknown>;
const out = (ctx: WorkflowContext, key: string): Obj => (ctx.outputs[key] ?? {}) as Obj;
const inp = (ctx: WorkflowContext): Obj => (ctx.input ?? {}) as Obj;

/** Example A — sequence: A -> B -> C. */
export const exampleSequence = defineWorkflow({
  name: 'example-sequence',
  description: 'Three deterministic steps in order',
  steps: {
    a: step({ executor: 'compute', input: (ctx) => ({ label: 'A', value: Number(inp(ctx).start ?? 0) }) }),
    b: step({ executor: 'compute', input: (ctx) => ({ label: 'B', value: out(ctx, 'a').value }) }),
    c: step({ executor: 'compute', input: (ctx) => ({ label: 'C', value: out(ctx, 'b').value }) }),
  },
  flow: sequence('a', 'b', 'c'),
  output: (ctx) => ctx.outputs.c,
});

/** Example B — parallel: A -> (B1 | B2 | B3) -> aggregate. */
export const exampleParallel = defineWorkflow({
  name: 'example-parallel',
  steps: {
    a: step({ executor: 'compute', input: () => ({ label: 'A', value: 0 }) }),
    b1: step({ executor: 'compute', input: (ctx) => ({ label: 'B1', value: out(ctx, 'a').value }) }),
    b2: step({
      executor: 'compute',
      input: (ctx) => ({ label: 'B2', value: Number(out(ctx, 'a').value) + 10 }),
    }),
    b3: step({
      executor: 'compute',
      input: (ctx) => ({ label: 'B3', value: Number(out(ctx, 'a').value) + 100 }),
    }),
    aggregate: step({
      executor: 'aggregate',
      input: (ctx) => ({ values: [out(ctx, 'b1').value, out(ctx, 'b2').value, out(ctx, 'b3').value] }),
    }),
  },
  flow: sequence('a', parallel('b1', 'b2', 'b3'), 'aggregate'),
  output: (ctx) => ctx.outputs.aggregate,
});

/** Example C — retry: the worker fails twice and succeeds on attempt 3. */
export const exampleRetry = defineWorkflow({
  name: 'example-retry',
  steps: {
    unreliable: step({
      executor: 'flaky',
      input: (ctx) => ({ failUntilAttempt: Number(inp(ctx).failUntilAttempt ?? 3) }),
      retry: { maxAttempts: 5, initialDelayMs: 1000, backoffCoefficient: 2, jitter: 0.1 },
    }),
  },
  output: (ctx) => ctx.outputs.unreliable,
});

/** Example D — durable sleep: A -> wait 60s -> B. Kill everything during the wait. */
export const exampleSleep = defineWorkflow({
  name: 'example-sleep',
  input: z
    .object({
      sleepMs: z
        .number()
        .int()
        .min(0)
        .max(7 * 24 * 3600_000)
        .default(60_000),
    })
    .default({ sleepMs: 60_000 }),
  steps: {
    a: step({ executor: 'compute', input: () => ({ label: 'before-sleep' }) }),
    wait: sleep((ctx) => Number(inp(ctx).sleepMs)),
    b: step({ executor: 'compute', input: () => ({ label: 'after-sleep' }) }),
  },
  flow: sequence('a', 'wait', 'b'),
});

/** Example E — human approval through the external-event primitive. */
export const exampleApproval = defineWorkflow({
  name: 'example-approval',
  steps: {
    generate: step({ executor: 'compute', input: () => ({ label: 'report-draft' }) }),
    approval: waitForEvent('approval'),
    publish: step({
      executor: 'publish',
      input: (ctx) => ({ report: ctx.outputs.generate, approval: ctx.outputs.approval }),
    }),
  },
  flow: sequence('generate', 'approval', 'publish'),
  output: (ctx) => ctx.outputs.publish,
});

/** Example F — an AI agent worker. The engine only sees the capability name "agent". */
export const exampleAgent = defineWorkflow({
  name: 'example-agent',
  steps: {
    request: step({
      executor: 'echo',
      input: (ctx) => ({ task: 'summarise', subject: inp(ctx).subject ?? 'Acme Corp' }),
    }),
    research: step({ executor: 'agent', input: (ctx) => ctx.outputs.request, timeoutMs: 120_000 }),
    summarize: step({
      executor: 'compute',
      input: (ctx) => ({ label: String(out(ctx, 'research').summary) }),
    }),
  },
  flow: sequence('request', 'research', 'summarize'),
});

/** Fan-out/fan-in with a concurrency limit, plus human approval. */
export const companyResearch = defineWorkflow({
  name: 'company-research',
  input: z.object({ companies: z.array(z.string().min(1)).min(1).max(1000) }),
  steps: {
    loadCompanies: step({ executor: 'echo', input: (ctx) => ({ companies: inp(ctx).companies }) }),
    researchCompanies: map({
      items: (ctx) => out(ctx, 'loadCompanies').companies as string[],
      executor: 'agent',
      itemInput: (company) => ({ task: 'company profile', subject: company }),
      concurrency: 10,
    }),
    approval: waitForEvent('approval'),
    generateReport: step({
      executor: 'aggregate',
      input: (ctx) => ({ values: (ctx.outputs.researchCompanies as Obj[]).map((r) => r.summary) }),
    }),
  },
  flow: sequence('loadCompanies', 'researchCompanies', 'approval', 'generateReport'),
});

/** Saga: reserve -> charge -> ship; ship fails permanently -> refund -> release. */
export const sagaOrder = defineWorkflow({
  name: 'saga-order',
  steps: {
    reserve: step({
      executor: 'reserve',
      input: (ctx) => ({ sku: inp(ctx).sku ?? 'SKU-1', qty: 1 }),
      compensate: { executor: 'release', input: (ctx) => ({ reservation: ctx.outputs.reserve }) },
    }),
    charge: step({
      executor: 'charge',
      input: (ctx) => ({ amountCents: inp(ctx).amountCents ?? 1999 }),
      compensate: { executor: 'refund', input: (ctx) => ({ charge: ctx.outputs.charge }) },
    }),
    ship: step({ executor: 'ship', input: (ctx) => ({ fail: inp(ctx).failShipping ?? true }) }),
  },
  flow: sequence('reserve', 'charge', 'ship'),
});

/** Parent/child tasks: a map of child workflows plus a single child. */
export const parentWithChildren = defineWorkflow({
  name: 'parent-with-children',
  steps: {
    batches: map({
      items: (ctx) => (inp(ctx).starts as number[] | undefined) ?? [1, 2, 3],
      workflow: 'example-sequence',
      itemInput: (start) => ({ start }),
      concurrency: 2,
    }),
    single: childTask('example-parallel'),
    combine: step({
      executor: 'aggregate',
      input: (ctx) => ({
        values: [...(ctx.outputs.batches as Obj[]).map((b) => b.value), out(ctx, 'single').count],
      }),
    }),
  },
  flow: sequence(parallel('batches', 'single'), 'combine'),
});

/** The end-to-end durability demonstration workflow. */
export const durabilityDemo = defineWorkflow({
  name: 'durability-demo',
  input: z.object({
    items: z.number().int().min(1).max(50).default(4),
    workMs: z.number().int().min(0).default(4000),
    sleepMs: z.number().int().min(0).default(30_000),
  }),
  steps: {
    prepare: step({ executor: 'echo', input: (ctx) => ({ items: inp(ctx).items }), effect: 'pure' }),
    process: map({
      items: (ctx) => Array.from({ length: Number(out(ctx, 'prepare').items) }, (_, i) => i),
      executor: 'slow',
      itemInput: (i, _n, ctx) => ({ label: `item-${i}`, durationMs: inp(ctx).workMs }),
      concurrency: 2,
      effect: 'pure',
      retry: { maxAttempts: 5, initialDelayMs: 500 },
    }),
    charge: step({ executor: 'side-effect', input: () => ({ amountCents: 4200, currency: 'EUR' }) }),
    cooldown: sleep((ctx) => Number(inp(ctx).sleepMs)),
    approval: waitForEvent('approval'),
    unreliable: step({
      executor: 'flaky',
      input: () => ({ failUntilAttempt: 3 }),
      retry: { maxAttempts: 5, initialDelayMs: 2000, backoffCoefficient: 2, jitter: 0 },
    }),
    publish: step({
      executor: 'publish',
      input: (ctx) => ({ approval: ctx.outputs.approval, charge: ctx.outputs.charge }),
    }),
  },
  flow: sequence('prepare', 'process', 'charge', 'cooldown', 'approval', 'unreliable', 'publish'),
});

/** Many-step workflow for the chaos test. */
export const chaosWorkflow = defineWorkflow({
  name: 'chaos',
  input: z.object({
    items: z.number().int().min(1).max(500).default(40),
    maxDelayMs: z.number().int().default(300),
  }),
  steps: {
    fanOut: map({
      items: (ctx) => Array.from({ length: Number(inp(ctx).items) }, (_, i) => i),
      executor: 'chaos-effect',
      itemInput: (i, _n, ctx) => ({ index: i, maxDelayMs: inp(ctx).maxDelayMs }),
      concurrency: 8,
      retry: { maxAttempts: 20, initialDelayMs: 200, maxDelayMs: 2000 },
    }),
    gate: waitForEvent('go'),
    nap: sleep(500),
    final: step({
      executor: 'chaos-effect',
      input: () => ({ index: -1, maxDelayMs: 50 }),
      retry: { maxAttempts: 20, initialDelayMs: 200, maxDelayMs: 2000 },
    }),
  },
  flow: sequence('fanOut', 'gate', 'nap', 'final'),
  output: (ctx) => ({ items: (ctx.outputs.fanOut as unknown[]).length }),
});

export function createExampleRegistry(): WorkflowRegistry {
  return new WorkflowRegistry()
    .register(
      exampleSequence,
      exampleParallel,
      exampleRetry,
      exampleSleep,
      exampleApproval,
      exampleAgent,
      companyResearch,
      sagaOrder,
      parentWithChildren,
      durabilityDemo,
      chaosWorkflow,
    )
    .validate();
}
