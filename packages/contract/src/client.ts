import type { z } from 'zod';
import { routes, type RouteDef, type RouteId, type Routes } from './routes';
import { LiveEvent as LiveEventSchema } from './schemas';

type In<T> = T extends z.ZodType ? z.input<T> : never;
type ParamsOf<K extends RouteId> = Routes[K] extends { params: infer P }
  ? { params: In<P> }
  : { params?: undefined };
type QueryOf<K extends RouteId> = Routes[K] extends { query: infer Q }
  ? { query?: In<Q> }
  : { query?: undefined };
type BodyOf<K extends RouteId> = Routes[K] extends { body: infer B }
  ? { body?: In<B> }
  : { body?: undefined };
export type CallInput<K extends RouteId> = ParamsOf<K> &
  QueryOf<K> &
  BodyOf<K> & { headers?: Record<string, string> };
export type CallOutput<K extends RouteId> = z.output<Routes[K]['response']>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server could not be reached, or did not answer (the outcome of a write is unknown). */
export class ApiUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiUnavailable';
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** Validate responses against the contract (default true). */
  validate?: boolean;
  fetch?: typeof fetch;
}

/** Typed v1 client generated from the route table: one method per route, responses validated by zod. */
export function createClient(o: ClientOptions) {
  const doFetch = o.fetch ?? fetch;
  async function call<K extends RouteId>(
    id: K,
    input: CallInput<K> = {} as CallInput<K>,
  ): Promise<CallOutput<K>> {
    const r = routes[id] as RouteDef;
    const i = input as {
      params?: Record<string, string>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
    };
    let path = r.path.replace(/:([A-Za-z]+)/g, (_, k: string) =>
      encodeURIComponent(String(i.params?.[k] ?? '')),
    );
    const qs = new URLSearchParams(
      Object.entries(i.query ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    if ([...qs].length) path += `?${qs}`;
    let res: Response;
    try {
      res = await doFetch(`${o.baseUrl}${path}`, {
        method: r.method,
        headers: {
          ...(r.method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
          ...(i.headers ?? {}),
        },
        body: r.method === 'POST' ? JSON.stringify(i.body ?? {}) : undefined,
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new ApiUnavailable(`${r.method} ${path}: ${(e as Error).message}`);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      if (res.status >= 500)
        throw new ApiUnavailable(`${r.method} ${path}: HTTP ${res.status} ${err?.message ?? ''}`);
      throw new ApiError(
        res.status,
        err?.code ?? 'HTTP_ERROR',
        err?.message ?? `HTTP ${res.status}`,
        err?.details,
      );
    }
    return (o.validate === false ? json : r.response.parse(json)) as CallOutput<K>;
  }
  return { call };
}

export type ApiClient = ReturnType<typeof createClient>;

export type StreamItem = { type: 'ready' } | { type: 'event'; event: z.output<typeof LiveEventSchema> };

/**
 * Read GET /v1/events. Yields `ready` once connected (fetch a snapshot then),
 * then one item per committed change. Ends when `signal` aborts or the
 * connection closes; reconnecting is the caller's choice.
 */
export async function* streamEvents(o: {
  baseUrl: string;
  token?: string;
  query?: { taskId?: string; taskType?: string };
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): AsyncGenerator<StreamItem> {
  const qs = new URLSearchParams(
    Object.entries(o.query ?? {}).filter(([, v]) => v) as Array<[string, string]>,
  );
  const res = await (o.fetch ?? fetch)(`${o.baseUrl}/v1/events${[...qs].length ? `?${qs}` : ''}`, {
    headers: { accept: 'text/event-stream', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    signal: o.signal,
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, 'HTTP_ERROR', `events: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (event === 'ready') yield { type: 'ready' };
        else if (data) {
          const parsed = LiveEventSchema.safeParse(JSON.parse(data));
          if (parsed.success) yield { type: 'event', event: parsed.data };
        }
        event = 'message';
        data = '';
      } else if (line.startsWith(':')) {
        // keep-alive comment
      } else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
  }
}
