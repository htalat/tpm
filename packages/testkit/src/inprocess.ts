import { isDomainError, type ArtifactRef, type FailureCategory } from '@durable/core';
import type { Engine } from '@durable/engine';
import { LeaseLost, TransportUnavailable, type WorkerTransport } from '@durable/sdk';

/** Worker transport that calls an Engine directly (tests, single-process deployments). */
export class InProcessTransport implements WorkerTransport {
  constructor(private readonly engine: Engine) {}

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isDomainError(e) && e.code === 'LEASE_LOST') throw new LeaseLost(e.message);
      if (e instanceof Error && e.name === 'SimulatedCrash') throw e;
      if (isDomainError(e)) throw e;
      throw new TransportUnavailable((e as Error).message);
    }
  }

  register(name: string, capabilities: string[]) {
    return this.wrap(() => this.engine.registerWorker(name, capabilities));
  }
  claim(req: { workerId: string; capabilities: string[]; maxItems: number; leaseMs?: number }) {
    return this.wrap(() => this.engine.claim(req));
  }
  heartbeat(attemptId: string, leaseToken: string) {
    return this.wrap(() => this.engine.heartbeat(attemptId, leaseToken));
  }
  complete(attemptId: string, req: { leaseToken: string; output: unknown; artifacts: ArtifactRef[] }) {
    return this.wrap(() => this.engine.complete(attemptId, req));
  }
  fail(
    attemptId: string,
    req: {
      leaseToken: string;
      error: { category: FailureCategory; message: string };
      retryAfterMs?: number;
      chargeAttempt?: boolean;
    },
  ) {
    return this.wrap(() => this.engine.fail(attemptId, req));
  }
}
