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
    req: { leaseToken: string; error: { category: FailureCategory; message: string }; retryAfterMs?: number },
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

export class HttpTransport implements WorkerTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new TransportUnavailable(`${path}: ${(e as Error).message}`);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { error?: { code: string; message: string } }) : {};
    if (res.ok) return json as T;
    if (json.error?.code === 'LEASE_LOST') throw new LeaseLost(json.error.message);
    if (res.status >= 500)
      throw new TransportUnavailable(`${path}: HTTP ${res.status} ${json.error?.message ?? ''}`);
    throw new Error(`${path}: HTTP ${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? text}`);
  }

  register(name: string, capabilities: string[]) {
    return this.call<{ workerId: string }>('/workers/register', { name, capabilities });
  }
  async claim(req: { workerId: string; capabilities: string[]; maxItems: number; leaseMs?: number }) {
    return (await this.call<{ items: WorkItem[] }>('/workers/claim', req)).items;
  }
  heartbeat(attemptId: string, leaseToken: string) {
    return this.call<HeartbeatResponse>(`/attempts/${attemptId}/heartbeat`, { leaseToken });
  }
  complete(attemptId: string, req: { leaseToken: string; output: unknown; artifacts: ArtifactRef[] }) {
    return this.call<CompletionResponse>(`/attempts/${attemptId}/complete`, req);
  }
  fail(
    attemptId: string,
    req: { leaseToken: string; error: { category: FailureCategory; message: string }; retryAfterMs?: number },
  ) {
    return this.call<CompletionResponse>(`/attempts/${attemptId}/fail`, req);
  }
}
