import { ApiError, ApiUnavailable, createClient, type ApiClient } from '@durable/contract';
import type {
  ArtifactRef,
  CompletionResponse,
  FailureCategory,
  HeartbeatResponse,
  WorkItem,
} from '@durable/core';

/**
 * How a worker talks to the engine. The worker runtime depends only on this
 * interface, so a worker can run over HTTP, in-process, or (later) any other
 * transport without changing handler code.
 */
export interface WorkerTransport {
  register(name: string, capabilities: string[]): Promise<{ workerId: string }>;
  claim(req: {
    workerId: string;
    capabilities: string[];
    maxItems: number;
    leaseMs?: number;
  }): Promise<WorkItem[]>;
  heartbeat(attemptId: string, leaseToken: string): Promise<HeartbeatResponse>;
  complete(
    attemptId: string,
    req: { leaseToken: string; output: unknown; artifacts: ArtifactRef[] },
  ): Promise<CompletionResponse>;
  fail(
    attemptId: string,
    req: {
      leaseToken: string;
      error: { category: FailureCategory; message: string };
      retryAfterMs?: number;
      chargeAttempt?: boolean;
    },
  ): Promise<CompletionResponse>;
}

/** Raised by transports when the engine says the lease is no longer authoritative. */
export class LeaseLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLost';
  }
}

/** Raised when the engine could not be reached or answered with a server error: the outcome is unknown. */
export class TransportUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportUnavailable';
  }
}

/** Worker protocol over the v1 HTTP API (typed, response-validated client from @durable/contract). */
export class HttpTransport implements WorkerTransport {
  private readonly api: ApiClient;

  constructor(baseUrl: string, token?: string, timeoutMs = 10_000) {
    this.api = createClient({ baseUrl, token, timeoutMs });
  }

  /** Map client errors to the worker runtime's vocabulary. */
  private async wrap<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'LEASE_LOST') throw new LeaseLost(e.message);
      if (e instanceof ApiUnavailable) throw new TransportUnavailable(e.message);
      throw e;
    }
  }

  register(name: string, capabilities: string[]) {
    return this.wrap(() => this.api.call('registerWorker', { body: { name, capabilities } }));
  }
  async claim(req: { workerId: string; capabilities: string[]; maxItems: number; leaseMs?: number }) {
    return (await this.wrap(() => this.api.call('claim', { body: req }))).items as WorkItem[];
  }
  heartbeat(attemptId: string, leaseToken: string) {
    return this.wrap(() => this.api.call('heartbeat', { params: { id: attemptId }, body: { leaseToken } }));
  }
  complete(attemptId: string, req: { leaseToken: string; output: unknown; artifacts: ArtifactRef[] }) {
    return this.wrap(() => this.api.call('complete', { params: { id: attemptId }, body: req }));
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
    return this.wrap(() => this.api.call('fail', { params: { id: attemptId }, body: req }));
  }
}
