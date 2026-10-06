import {
  ConfiguredFailureInjector,
  FakeClock,
  seededRandom,
  type CompiledWorkflow,
  type CrashPoint,
  WorkflowRegistry,
} from '@durable/core';
import type { Pool } from '@durable/db';
import { Engine, type TaskRow } from '@durable/engine';
import { ExternalSystem, createExampleRegistry, exampleHandlers } from '@durable/examples';
import { WorkerRuntime, type WorkerHandler } from '@durable/sdk';
import { createTestPool, InProcessTransport, truncateAll } from '@durable/testkit';
import { afterAll, beforeAll, beforeEach } from 'vitest';

export interface Harness {
  pool: Pool;
  clock: FakeClock;
  registry: WorkflowRegistry;
  engine: Engine;
  external: ExternalSystem;
  /** Another engine instance sharing the DB (a second "process"). */
  newEngine(opts?: { crashAt?: Partial<Record<CrashPoint, number>> }): Engine;
  worker(
    handlers?: Record<string, WorkerHandler<any, any>>,
    opts?: { crashAt?: Partial<Record<CrashPoint, number>>; leaseMs?: number },
  ): WorkerRuntime; // eslint-disable-line @typescript-eslint/no-explicit-any
  task(id: string): Promise<TaskRow>;
  steps(id: string): Promise<Array<{ key: string; status: string; attempt_count: number; output: unknown }>>;
  history(id: string): Promise<string[]>;
  /** Run orchestrator ticks and worker polls until the task is terminal or no progress. */
  drive(
    taskId: string,
    workers: WorkerRuntime[],
    opts?: { maxRounds?: number; advanceMs?: number },
  ): Promise<TaskRow>;
}

const injector = (crashAt?: Partial<Record<CrashPoint, number>>) =>
  new ConfiguredFailureInjector(new Map(Object.entries(crashAt ?? {}) as Array<[CrashPoint, number]>));

/** Shared per-file setup: real PostgreSQL, fake clock, deterministic jitter. */
export function useHarness(extra: CompiledWorkflow[] = []): Harness {
  const h = {} as Harness;
  beforeAll(() => {
    h.pool = createTestPool();
    h.external = new ExternalSystem(h.pool);
  });
  afterAll(async () => {
    await h.pool.end();
  });
  beforeEach(async () => {
    await truncateAll(h.pool);
    h.clock = new FakeClock('2026-01-01T00:00:00.000Z');
    h.registry = createExampleRegistry();
    if (extra.length) h.registry.register(...extra);
    const mk = (crashAt?: Partial<Record<CrashPoint, number>>) =>
      new Engine({
        pool: h.pool,
        registry: h.registry,
        clock: h.clock,
        random: seededRandom(42),
        injector: injector(crashAt),
        leaseMs: 10_000,
      });
    h.engine = mk();
    h.newEngine = (o) => mk(o?.crashAt);
    h.worker = (handlers, o) =>
      new WorkerRuntime({
        transport: new InProcessTransport(h.engine),
        name: 'test-worker',
        handlers: handlers ?? exampleHandlers(h.external),
        concurrency: 10,
        leaseMs: o?.leaseMs ?? 10_000,
        injector: injector(o?.crashAt),
      });
    h.task = async (id) => (await h.pool.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id])).rows[0]!;
    h.steps = async (id) =>
      (
        await h.pool.query(
          `SELECT key, status, attempt_count, output FROM steps WHERE task_id = $1 ORDER BY created_at, item_index NULLS FIRST, key`,
          [id],
        )
      ).rows;
    h.history = async (id) =>
      (
        await h.pool.query<{ e: string }>(
          `SELECT event_type || coalesce(':' || new_state, '') AS e FROM task_history WHERE task_id = $1 ORDER BY id`,
          [id],
        )
      ).rows.map((r) => r.e);
    h.drive = async (taskId, workers, o = {}) => {
      for (let round = 0; round < (o.maxRounds ?? 200); round++) {
        let work = await h.engine.tick();
        for (const w of workers) work += (await w.pollOnce()).length;
        const t = await h.task(taskId);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status)) return t;
        if (work === 0) {
          if (!o.advanceMs) return t;
          h.clock.advance(o.advanceMs);
        }
      }
      return h.task(taskId);
    };
  });
  return h;
}
