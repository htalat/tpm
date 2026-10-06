import { hashString, seededRandom, WorkerError } from '@durable/core';
import type { WorkerHandler } from '@durable/sdk';
import { createAgentHandler, MockAgentAdapter, type AgentAdapter } from './agent';
import type { ExternalSystem } from './external-system';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** Deterministic worker: a plain TypeScript function. */
export const computeHandler: WorkerHandler<
  { label?: string; value?: number },
  { label: string; value: number; step: string }
> = {
  async execute(input, ctx) {
    return {
      label: input?.label ?? ctx.item.stepKey,
      value: (input?.value ?? 0) + 1,
      step: ctx.item.stepKey,
    };
  },
};

export const echoHandler: WorkerHandler = { execute: async (input) => input };

export const aggregateHandler: WorkerHandler<{ values?: unknown[] }, { count: number; values: unknown[] }> = {
  async execute(input) {
    const values = Array.isArray(input?.values) ? input.values : [];
    return { count: values.length, values };
  },
};

/**
 * Unreliable worker. Deterministic by default: fails with TRANSIENT until
 * `failUntilAttempt`. With `failureRate`, failures are pseudo-random but seeded
 * by idempotency key + attempt, so runs are reproducible.
 */
export const flakyHandler: WorkerHandler<
  { failUntilAttempt?: number; failureRate?: number; category?: 'TRANSIENT' | 'PERMANENT' },
  { succeededOnAttempt: number }
> = {
  async execute(input, ctx) {
    const until = input?.failUntilAttempt ?? 3;
    if (ctx.attemptNumber < until) {
      throw new WorkerError(
        input?.category ?? 'TRANSIENT',
        `injected failure on attempt ${ctx.attemptNumber}`,
      );
    }
    if (
      input?.failureRate &&
      seededRandom(hashString(`${ctx.idempotencyKey}#${ctx.attemptNumber}`))() < input.failureRate
    ) {
      throw new WorkerError('TRANSIENT', `random failure on attempt ${ctx.attemptNumber}`);
    }
    return { succeededOnAttempt: ctx.attemptNumber };
  },
};

/** Slow worker: runs long enough to need heartbeats; observes cancellation via ctx.signal. */
export const slowHandler: WorkerHandler<
  { durationMs?: number; label?: string },
  { sleptMs: number; label?: string }
> = {
  async execute(input, ctx) {
    const total = input?.durationMs ?? 5000;
    let slept = 0;
    while (slept < total) {
      const chunk = Math.min(100, total - slept);
      await sleep(chunk, ctx.signal);
      slept += chunk;
    }
    return { sleptMs: slept, label: input?.label };
  },
};

/**
 * Side-effect worker. The external system deduplicates by the step's stable
 * idempotency key, and `reconcile` asks it whether the effect already happened.
 */
export function sideEffectHandler(
  external: ExternalSystem,
  operation = 'charge',
): WorkerHandler<Record<string, unknown> | null, Record<string, unknown>> {
  return {
    async execute(input, ctx) {
      const r = await external.apply(ctx.idempotencyKey, operation, input);
      ctx.crashPoint('AFTER_SIDE_EFFECT');
      return { ...r.result, deduplicated: !r.applied };
    },
    async reconcile(_input, ctx) {
      const existing = await external.lookup(ctx.idempotencyKey);
      return existing
        ? { outcome: 'APPLIED', output: { ...existing, reconciled: true } }
        : { outcome: 'NOT_APPLIED' };
    },
  };
}

/** Chaos worker: random (seeded) latency, then an idempotent external effect. */
export function chaosEffectHandler(
  external: ExternalSystem,
): WorkerHandler<{ index: number; maxDelayMs?: number }, unknown> {
  const inner = sideEffectHandler(external, 'chaos-op');
  return {
    async execute(input, ctx) {
      const r = seededRandom(hashString(`${ctx.idempotencyKey}#${ctx.attemptNumber}`));
      await sleep(Math.floor(r() * (input?.maxDelayMs ?? 300)), ctx.signal);
      return inner.execute(input as Record<string, unknown>, ctx);
    },
    reconcile: (input, ctx) => inner.reconcile!(input as Record<string, unknown>, ctx),
  };
}

export function shipHandler(external: ExternalSystem): WorkerHandler<{ fail?: boolean }, unknown> {
  return {
    async execute(input, ctx) {
      if (input?.fail) throw new WorkerError('PERMANENT', 'carrier rejected shipment');
      return (await external.apply(ctx.idempotencyKey, 'ship', input)).result;
    },
  };
}

export function publishHandler(
  external: ExternalSystem,
): WorkerHandler<{ approval?: { approved?: boolean } }, unknown> {
  return {
    async execute(input, ctx) {
      if (input?.approval?.approved === false) return { published: false, reason: 'rejected by approver' };
      const r = await external.apply(ctx.idempotencyKey, 'publish', input);
      return { published: true, ...r.result };
    },
    async reconcile(_i, ctx) {
      const e = await external.lookup(ctx.idempotencyKey);
      return e ? { outcome: 'APPLIED', output: { published: true, ...e } } : { outcome: 'NOT_APPLIED' };
    },
  };
}

/** All example capabilities. A worker process may advertise any subset. */
export function exampleHandlers(external: ExternalSystem, agent: AgentAdapter = new MockAgentAdapter()) {
  return {
    compute: computeHandler,
    echo: echoHandler,
    aggregate: aggregateHandler,
    flaky: flakyHandler,
    slow: slowHandler,
    'side-effect': sideEffectHandler(external, 'charge'),
    'chaos-effect': chaosEffectHandler(external),
    agent: createAgentHandler(agent),
    reserve: sideEffectHandler(external, 'reserve'),
    charge: sideEffectHandler(external, 'charge'),
    ship: shipHandler(external),
    release: sideEffectHandler(external, 'release'),
    refund: sideEffectHandler(external, 'refund'),
    publish: publishHandler(external),
  } satisfies Record<string, WorkerHandler<never, unknown>>;
}
