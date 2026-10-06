import {
  noFailureInjection,
  WorkerError,
  type ArtifactRef,
  type CrashPoint,
  type FailureCategory,
  type FailureInjector,
  type WorkItem,
} from '@durable/core';
import { leaseId, silentLogger, type Logger } from '@durable/observability';
import { MemoryArtifactStore, type ArtifactStore } from './artifacts';
import { LeaseLost, TransportUnavailable, type WorkerTransport } from './transport';

export type ReconcileResult<O = unknown> =
  /** The side effect already happened; this is its result. The step completes without re-executing. */
  | { outcome: 'APPLIED'; output: O }
  /** The side effect provably did not happen; execute normally. */
  | { outcome: 'NOT_APPLIED' }
  /** Cannot tell. The attempt fails as AMBIGUOUS and the engine's policy decides (retry or block). */
  | { outcome: 'UNKNOWN'; reason?: string };

export interface WorkContext {
  item: WorkItem;
  /** Aborted on cancellation, lease loss, or timeout. Long-running handlers should observe it. */
  signal: AbortSignal;
  /** Stable across attempts: pass it to external systems to deduplicate side effects. */
  idempotencyKey: string;
  attemptNumber: number;
  logger: Logger;
  artifacts: ArtifactStore;
  /** Attach an artifact reference; persisted atomically with the completion. */
  addArtifact(ref: ArtifactRef): void;
  /** Failure-injection hook for crash testing. */
  crashPoint(point: CrashPoint): void;
}

export interface WorkerHandler<I = unknown, O = unknown> {
  execute(input: I, ctx: WorkContext): Promise<O>;
  /**
   * Called instead of blindly re-executing when a previous attempt's outcome
   * is unknown (it expired after possibly performing its side effect).
   */
  reconcile?(input: I, ctx: WorkContext): Promise<ReconcileResult<O>>;
}

/** Type helper: `Worker<AgentInput, AgentOutput>` is just a handler. */
export type Worker<I, O> = WorkerHandler<I, O>;

export interface WorkerRuntimeOptions {
  transport: WorkerTransport;
  name: string;
  handlers: Record<string, WorkerHandler<any, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- handlers are heterogeneous by design; inputs are validated inside each handler
  concurrency?: number;
  pollIntervalMs?: number;
  /** Lease requested on claim; heartbeats are sent every leaseMs/3. */
  leaseMs?: number;
  logger?: Logger;
  artifacts?: ArtifactStore;
  injector?: FailureInjector;
  /** Classify non-WorkerError exceptions. Default: TRANSIENT. */
  classifyError?: (e: unknown) => FailureCategory;
}

type Outcome = 'completed' | 'failed' | 'lost' | 'crashed';

/**
 * Worker runtime: poll -> claim -> heartbeat while executing -> complete/fail.
 * The runtime never sleeps to implement retry backoff; a failed attempt is
 * reported and control returns to the engine, which persists the retry time.
 */
export class WorkerRuntime {
  private workerId: string | null = null;
  private running = false;
  private inFlight = new Set<Promise<Outcome>>();
  private loop: Promise<void> | null = null;
  private readonly o: Required<Omit<WorkerRuntimeOptions, 'leaseMs'>> & { leaseMs?: number };
  /** When true the runtime behaves like a dead process: no more heartbeats or reports. */
  private dead = false;

  constructor(opts: WorkerRuntimeOptions) {
    this.o = {
      concurrency: 1,
      pollIntervalMs: 250,
      logger: silentLogger,
      artifacts: new MemoryArtifactStore(),
      injector: noFailureInjection,
      classifyError: () => 'TRANSIENT',
      ...opts,
    };
  }

  get capabilities(): string[] {
    return Object.keys(this.o.handlers);
  }

  get id(): string | null {
    return this.workerId;
  }

  async register(): Promise<string> {
    if (!this.workerId)
      this.workerId = (await this.o.transport.register(this.o.name, this.capabilities)).workerId;
    return this.workerId;
  }

  /** Claim and fully process up to `max` items. Returns outcomes (useful in tests). */
  async pollOnce(max = this.o.concurrency): Promise<Outcome[]> {
    if (this.dead) return [];
    const workerId = await this.register();
    const items = await this.o.transport.claim({
      workerId,
      capabilities: this.capabilities,
      maxItems: max,
      leaseMs: this.o.leaseMs,
    });
    return Promise.all(items.map((i) => this.process(i)));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      await this.register();
      while (this.running && !this.dead) {
        const free = this.o.concurrency - this.inFlight.size;
        let claimed = 0;
        if (free > 0) {
          try {
            const items = await this.o.transport.claim({
              workerId: this.workerId!,
              capabilities: this.capabilities,
              maxItems: free,
              leaseMs: this.o.leaseMs,
            });
            claimed = items.length;
            for (const item of items) {
              const p = this.process(item).finally(() => this.inFlight.delete(p));
              this.inFlight.add(p);
            }
          } catch (e) {
            this.o.logger.warn({ err: e, worker_id: this.workerId }, 'claim failed; will retry');
          }
        }
        if (claimed === 0) await new Promise((r) => setTimeout(r, this.o.pollIntervalMs));
      }
    })();
  }

  /** Stop claiming; wait for in-flight items to finish. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    await Promise.all(this.inFlight);
  }

  async process(item: WorkItem): Promise<Outcome> {
    const handler = this.o.handlers[item.type];
    const log = this.o.logger.child({
      task_id: item.taskId,
      step_id: item.stepId,
      attempt_id: item.attemptId,
      worker_id: this.workerId,
      lease_id: leaseId(item.leaseToken),
      step_key: item.stepKey,
      attempt_number: item.attemptNumber,
    });
    const controller = new AbortController();
    let lost = false;
    const artifacts: ArtifactRef[] = [];
    // Relative durations only: the worker's clock may differ from the engine's.
    const leaseMs = Math.max(1000, item.leaseMs);
    const hb = setInterval(
      () => {
        if (this.dead) return;
        this.o.transport.heartbeat(item.attemptId, item.leaseToken).then(
          (r) => {
            if (r.cancelRequested && !controller.signal.aborted) {
              log.info({ event_type: 'attempt.cancel_observed' }, 'cancellation observed on heartbeat');
              controller.abort(new WorkerError('POLICY', 'task cancelled'));
            }
          },
          (e) => {
            if (e instanceof LeaseLost) {
              lost = true;
              log.warn({ event_type: 'attempt.lease_lost' }, 'lease lost; abandoning work');
              controller.abort(new LeaseLost('lease lost'));
            }
          },
        );
      },
      Math.max(200, Math.floor(leaseMs / 3)),
    );
    const timeout = setTimeout(
      () => controller.abort(new WorkerError('TIMEOUT', `exceeded ${item.timeoutMs}ms`)),
      item.timeoutMs,
    );
    const ctx: WorkContext = {
      item,
      signal: controller.signal,
      idempotencyKey: item.idempotencyKey,
      attemptNumber: item.attemptNumber,
      logger: log,
      artifacts: this.o.artifacts,
      addArtifact: (a) => artifacts.push(a),
      crashPoint: (p) => this.o.injector.hit(p),
    };
    try {
      this.o.injector.hit('AFTER_WORK_CLAIMED');
      if (!handler) throw new WorkerError('POLICY', `no handler for ${item.type}`);
      let output: unknown;
      let reconciled = false;
      if (item.context.recoveringAmbiguous) {
        if (handler.reconcile) {
          const r = await handler.reconcile(item.input, ctx);
          log.info(
            { event_type: 'attempt.reconciled', outcome: r.outcome },
            'reconciled ambiguous previous attempt',
          );
          if (r.outcome === 'APPLIED') {
            output = r.output;
            reconciled = true;
          } else if (r.outcome === 'UNKNOWN') {
            throw new WorkerError('AMBIGUOUS', `reconciliation inconclusive: ${r.reason ?? 'unknown'}`);
          }
        } else {
          log.warn(
            { event_type: 'attempt.reexecute_ambiguous' },
            'no reconcile hook; re-executing with idempotency key',
          );
        }
      }
      if (!reconciled) output = await raceAbort(handler.execute(item.input, ctx), controller.signal);
      if (lost) return 'lost';
      this.o.injector.hit('BEFORE_COMPLETION_SEND');
      await this.report(() =>
        this.o.transport.complete(item.attemptId, { leaseToken: item.leaseToken, output, artifacts }),
      );
      log.info({ event_type: 'attempt.completed' }, 'completed');
      return 'completed';
    } catch (e) {
      if (isSimulatedCrash(e)) {
        // Behave exactly like a killed process: stop heartbeating, report nothing.
        this.dead = true;
        this.running = false;
        log.warn({ event_type: 'worker.simulated_crash', point: (e as Error).message }, 'simulated crash');
        return 'crashed';
      }
      if (lost || e instanceof LeaseLost) return 'lost';
      const err =
        e instanceof WorkerError
          ? e
          : new WorkerError(this.o.classifyError(e), e instanceof Error ? e.message : String(e));
      try {
        await this.report(() =>
          this.o.transport.fail(item.attemptId, {
            leaseToken: item.leaseToken,
            error: { category: err.category, message: err.message },
            retryAfterMs: err.retryAfterMs,
          }),
        );
      } catch (re) {
        if (isSimulatedCrash(re)) return 'crashed';
        if (!(re instanceof LeaseLost)) log.error({ err: re }, 'could not report failure; lease will expire');
        return 'lost';
      }
      log.warn({ event_type: 'attempt.failed', category: err.category, message: err.message }, 'failed');
      return 'failed';
    } finally {
      clearInterval(hb);
      clearTimeout(timeout);
    }
  }

  /**
   * Report an outcome, retrying while the engine is unreachable. Completion
   * and failure are idempotent on the server (same attempt + token => same
   * answer), so retrying after a lost response is safe.
   */
  private async report<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      if (this.dead) throw new LeaseLost('worker is dead');
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof TransportUnavailable) || i >= 5) throw e;
        await new Promise((r) => setTimeout(r, 200 * 2 ** i));
      }
    }
  }
}

function isSimulatedCrash(e: unknown): boolean {
  return e instanceof Error && e.name === 'SimulatedCrash';
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
