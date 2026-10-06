import {
  noFailureInjection,
  systemClock,
  uuidGenerator,
  type ArtifactRef,
  type Clock,
  type FailureCategory,
  type FailureInjector,
  type IdGenerator,
  type Random,
  type WorkflowRegistry,
} from '@durable/core';
import { withRetryingTransaction, type Pool } from '@durable/db';
import { MetricsRegistry, silentLogger, type Logger } from '@durable/observability';
import type { EngineDeps } from './deps';
import { runOrchestrationPass } from './orchestrator';
import { claim, complete, fail, heartbeat, reapExpiredLeases, registerWorker } from './queue';
import type { HistoryRow, TaskRow } from './rows';
import { fireDueTimers, promoteDueRetries } from './scheduler';
import { signalTask, type SignalInput } from './signals';
import {
  cancelTaskTx,
  createTaskIdempotent,
  getTaskDetails,
  pauseTaskTx,
  resolveStepTx,
  resumeTaskTx,
  type CreateTaskInput,
} from './tasks';

export interface EngineOptions {
  pool: Pool;
  registry: WorkflowRegistry;
  clock?: Clock;
  ids?: IdGenerator;
  random?: Random;
  logger?: Logger;
  metrics?: MetricsRegistry;
  injector?: FailureInjector;
  leaseMs?: number;
}

/**
 * Facade over the engine's transactional operations. Holds no
 * correctness-critical state: every method reads and writes PostgreSQL, so
 * any number of Engine instances in any number of processes may coexist.
 */
export class Engine {
  readonly deps: EngineDeps;

  constructor(o: EngineOptions) {
    this.deps = {
      pool: o.pool,
      registry: o.registry,
      clock: o.clock ?? systemClock,
      ids: o.ids ?? uuidGenerator,
      random: o.random ?? Math.random,
      logger: o.logger ?? silentLogger,
      metrics: o.metrics ?? new MetricsRegistry(),
      injector: o.injector ?? noFailureInjection,
      leaseMs: o.leaseMs ?? 30_000,
    };
  }

  // ---- tasks -------------------------------------------------------------

  async createTask(
    req: CreateTaskInput,
    idempotencyKey?: string,
  ): Promise<{ task: TaskRow; created: boolean }> {
    const r = await withRetryingTransaction(this.deps.pool, (tx) =>
      createTaskIdempotent(tx, this.deps, req, idempotencyKey),
    );
    this.deps.logger.info(
      { task_id: r.task.id, event_type: 'task.created', created: r.created },
      'task created',
    );
    return r;
  }

  getTask(taskId: string) {
    return getTaskDetails(this.deps.pool, taskId);
  }

  async getHistory(taskId: string): Promise<HistoryRow[]> {
    const r = await this.deps.pool.query<HistoryRow>(
      `SELECT * FROM task_history WHERE task_id = $1 ORDER BY id`,
      [taskId],
    );
    return r.rows;
  }

  async listTasks(opts: { status?: string; limit?: number } = {}): Promise<TaskRow[]> {
    const r = await this.deps.pool.query<TaskRow>(
      `SELECT * FROM tasks WHERE ($1::text IS NULL OR status = $1) AND parent_task_id IS NULL
       ORDER BY created_at DESC LIMIT $2`,
      [opts.status ?? null, Math.min(opts.limit ?? 50, 500)],
    );
    return r.rows;
  }

  cancelTask(taskId: string, reason = 'cancel requested') {
    return withRetryingTransaction(this.deps.pool, (tx) => cancelTaskTx(tx, this.deps, taskId, reason));
  }

  pauseTask(taskId: string) {
    return withRetryingTransaction(this.deps.pool, (tx) => pauseTaskTx(tx, this.deps, taskId));
  }

  resumeTask(taskId: string) {
    return withRetryingTransaction(this.deps.pool, (tx) => resumeTaskTx(tx, this.deps, taskId));
  }

  resolveStep(
    taskId: string,
    stepKey: string,
    action: 'retry' | 'complete' | 'fail',
    output?: unknown,
    reason = 'operator',
  ) {
    return withRetryingTransaction(this.deps.pool, (tx) =>
      resolveStepTx(tx, this.deps, taskId, stepKey, action, output, reason),
    );
  }

  signal(taskId: string, sig: SignalInput) {
    return signalTask(this.deps, taskId, sig);
  }

  // ---- worker protocol ---------------------------------------------------

  registerWorker(name: string, capabilities: string[]) {
    return registerWorker(this.deps, name, capabilities);
  }

  claim(req: { workerId: string; capabilities: string[]; maxItems?: number; leaseMs?: number }) {
    return claim(this.deps, { maxItems: 1, ...req });
  }

  heartbeat(attemptId: string, leaseToken: string, leaseMs?: number) {
    return heartbeat(this.deps, attemptId, leaseToken, leaseMs);
  }

  complete(attemptId: string, req: { leaseToken: string; output?: unknown; artifacts?: ArtifactRef[] }) {
    return complete(this.deps, attemptId, {
      leaseToken: req.leaseToken,
      output: req.output ?? null,
      artifacts: req.artifacts ?? [],
    });
  }

  fail(
    attemptId: string,
    req: { leaseToken: string; error: { category: FailureCategory; message: string }; retryAfterMs?: number },
  ) {
    return fail(this.deps, attemptId, req);
  }

  // ---- background duties (run by the orchestrator process) ---------------

  reapExpiredLeases(max?: number) {
    return reapExpiredLeases(this.deps, max);
  }
  fireDueTimers(max?: number) {
    return fireDueTimers(this.deps, max);
  }
  promoteDueRetries(max?: number) {
    return promoteDueRetries(this.deps, max);
  }
  runOrchestrationPass(max?: number) {
    return runOrchestrationPass(this.deps, max);
  }

  /** One full background tick. Returns the amount of work done. */
  async tick(): Promise<number> {
    let n = 0;
    n += await this.promoteDueRetries();
    n += await this.fireDueTimers();
    n += await this.reapExpiredLeases();
    n += await this.runOrchestrationPass();
    return n;
  }

  /** Tick until nothing changes (tests and tooling). */
  async runUntilIdle(maxTicks = 100): Promise<void> {
    for (let i = 0; i < maxTicks; i++) if ((await this.tick()) === 0) return;
    throw new Error('engine did not become idle');
  }

  /** Register DB-backed gauges on the metrics registry. */
  registerGauges(): void {
    this.deps.metrics.gauge('durable_tasks', 'Tasks by status', async () => {
      const r = await this.deps.pool.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM tasks GROUP BY status`,
      );
      return r.rows.map((x) => ({ labels: { status: x.status }, value: x.n }));
    });
    this.deps.metrics.gauge('durable_attempts_running', 'Attempts holding a lease', async () => {
      const r = await this.deps.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attempts WHERE status = 'RUNNING'`,
      );
      return [{ labels: {}, value: r.rows[0]!.n }];
    });
  }
}
