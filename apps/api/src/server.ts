import { timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';
import { isDomainError, type ErrorCode } from '@durable/core';
import {
  buildOpenApi,
  routes,
  toHistoryEvent,
  toStep,
  toTask,
  toTaskDetail,
  type CallOutput,
  type RouteDef,
  type RouteId,
  type RouteInputBase,
} from '@durable/contract';
import type { Engine } from '@durable/engine';
import type { Logger } from '@durable/observability';

export interface RouteInput<K extends RouteId> extends RouteInputBase<K> {
  req: FastifyRequest;
  reply: FastifyReply;
}
/** Register a handler for a contract route. Path, validation and auth come from the route table. */
export type Register = <K extends RouteId>(
  id: K,
  handler: (input: RouteInput<K>) => Promise<CallOutput<K> | void>,
) => void;

export interface ServerOptions {
  engine: Engine;
  logger: Logger;
  /** If set, required as a Bearer token on task/admin endpoints. */
  apiToken?: string;
  /** If set, required as a Bearer token on worker endpoints. */
  workerToken?: string;
  bodyLimitBytes?: number;
  /** Validate every response against the contract (tests; off in production). */
  validateResponses?: boolean;
  /** More contract routes (e.g. the agent-runner read model and live events). */
  extend?: (register: Register, app: FastifyInstance) => void;
}

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  CONCURRENCY_CONFLICT: 409,
  LEASE_LOST: 409,
  TASK_TERMINAL: 409,
  CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 422,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHORIZED: 401,
};

function tokenMatches(header: string | undefined, expected: string): boolean {
  const got = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

class ContractViolation extends Error {}

export async function buildServer(o: ServerOptions): Promise<FastifyInstance> {
  const { engine } = o;
  const app = Fastify({
    loggerInstance: o.logger as FastifyBaseLogger,
    bodyLimit: o.bodyLimitBytes ?? 1024 * 1024,
  });

  const guard = (token: string | undefined) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (token && !tokenMatches(req.headers.authorization, token)) {
      await reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' } });
    }
  };
  const guards = { admin: guard(o.apiToken), worker: guard(o.workerToken), none: undefined };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ContractViolation) {
      req.log.error({ err }, 'response violates the API contract');
      return reply.code(500).send({ error: { code: 'CONTRACT_VIOLATION', message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'invalid request', details: { issues: err.issues } },
      });
    }
    if (isDomainError(err)) {
      return reply
        .code(STATUS[err.code])
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) {
      const code = e.statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
      return reply.code(e.statusCode).send({ error: { code, message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  const register: Register = (id, handler) => {
    const r = routes[id] as RouteDef;
    const guardFn = guards[r.auth];
    app.route({
      method: r.method,
      url: r.path,
      ...(guardFn ? { preHandler: guardFn } : {}),
      handler: async (req, reply) => {
        const input = {
          params: r.params ? r.params.parse(req.params ?? {}) : undefined,
          query: r.query ? r.query.parse(req.query ?? {}) : undefined,
          body: r.body ? r.body.parse(req.body ?? undefined) : undefined,
          req,
          reply,
        } as never;
        const out = await handler(input);
        if (reply.sent || out === undefined) return reply;
        if (o.validateResponses) {
          const check = r.response.safeParse(out);
          if (!check.success) throw new ContractViolation(`${id}: ${check.error.message.slice(0, 2000)}`);
        }
        if (reply.statusCode === 200 && r.status[0] !== 200) reply.code(r.status[0]!);
        return out;
      },
    });
  };

  // ---- operational (not versioned) --------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    try {
      await engine.deps.pool.query(`SELECT 1 FROM schema_migrations LIMIT 1`);
      return { status: 'ready' };
    } catch (e) {
      return reply.code(503).send({ status: 'not-ready', reason: (e as Error).message });
    }
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(await engine.deps.metrics.render()),
  );
  const openapi = buildOpenApi();
  app.get('/v1/openapi.json', async () => openapi);

  // ---- tasks -------------------------------------------------------------------------------------
  register('listWorkflows', async () => ({
    workflows: engine.deps.registry.list().map((w) => ({
      name: w.name,
      version: w.version,
      description: w.spec.description ?? null,
      steps: [...w.order],
    })),
  }));
  register('createTask', async ({ body, req, reply }) => {
    const key = req.headers['idempotency-key'];
    const idem = typeof key === 'string' && key.length > 0 && key.length <= 256 ? key : undefined;
    const { task, created } = await engine.createTask(body, idem);
    reply.code(created ? 201 : 200);
    return { task: toTask(task as never), created } as never;
  });
  register(
    'listTasks',
    async ({ query }) => ({ tasks: (await engine.listTasks(query)).map((t) => toTask(t as never)) }) as never,
  );
  register(
    'getTask',
    async ({ params }) => toTaskDetail((await engine.getTask(params.id)) as never) as never,
  );
  register('getTaskHistory', async ({ params }) => {
    await engine.getTask(params.id); // 404 for unknown tasks
    return { history: (await engine.getHistory(params.id)).map((h) => toHistoryEvent(h as never)) };
  });
  register('cancelTask', async ({ params, body }) => {
    const r = await engine.cancelTask(params.id, body.reason);
    return { task: toTask(r.task as never), alreadyCancelled: r.alreadyCancelled } as never;
  });
  register(
    'pauseTask',
    async ({ params }) => ({ task: toTask((await engine.pauseTask(params.id)) as never) }) as never,
  );
  register(
    'resumeTask',
    async ({ params }) => ({ task: toTask((await engine.resumeTask(params.id)) as never) }) as never,
  );
  register('signalTask', async ({ params, body, reply }) => {
    const r = await engine.signal(params.id, body);
    reply.code(r.duplicate ? 200 : 202);
    return r;
  });
  register(
    'resolveStep',
    async ({ params, body }) =>
      ({
        step: toStep(
          (await engine.resolveStep(params.id, params.key, body.action, body.output, body.reason)) as never,
        ),
      }) as never,
  );

  // ---- worker protocol -----------------------------------------------------------------------------
  register('registerWorker', async ({ body }) => engine.registerWorker(body.name, body.capabilities));
  register('claim', async ({ body }) => ({ items: await engine.claim(body) }));
  register('heartbeat', async ({ params, body }) => engine.heartbeat(params.id, body.leaseToken));
  register('complete', async ({ params, body }) => engine.complete(params.id, body));
  register('fail', async ({ params, body }) => engine.fail(params.id, body));

  o.extend?.(register, app);
  return app;
}
