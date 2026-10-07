import type { z } from 'zod';
import { routes, type RouteDef, type RouteId, type Routes } from './routes';

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
