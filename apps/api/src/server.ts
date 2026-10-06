import { timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z, ZodError, type ZodType } from 'zod';
import {
  ClaimRequestSchema,
  CompleteRequestSchema,
  CreateTaskRequestSchema,
  FailRequestSchema,
  isDomainError,
  LeaseRequestSchema,
  RegisterWorkerRequestSchema,
  ResolveStepRequestSchema,
  SignalRequestSchema,
  type ErrorCode,
} from '@durable/core';
import type { Engine } from '@durable/engine';
import type { Logger } from '@durable/observability';

export interface ServerOptions {
  engine: Engine;
  logger: Logger;
  /** If set, required as a Bearer token on task/admin endpoints. */
  apiToken?: string;
  /** If set, required as a Bearer token on worker endpoints. */
  workerToken?: string;
  bodyLimitBytes?: number;
  /** Extra routes (e.g. the agent-runner read model), registered with the admin guard. */
  extend?: (
    app: FastifyInstance,
    adminGuard: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
  ) => void;
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

const IdParams = z.object({ id: z.string().uuid() });
const StepParams = z.object({ id: z.string().uuid(), key: z.string().min(1).max(200) });
const CancelBody = z.object({ reason: z.string().max(1000).optional() }).default({});
const ListQuery = z.object({
  status: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const parse = <T>(schema: ZodType<T>, v: unknown): T => schema.parse(v ?? undefined);

function tokenMatches(header: string | undefined, expected: string): boolean {
  const got = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  const admin = { preHandler: guard(o.apiToken) };
  const workerAuth = { preHandler: guard(o.workerToken) };

  app.setErrorHandler((err, req, reply) => {
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

  // ---- health ----------------------------------------------------------------
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
  app.get('/workflows', admin, async () => ({
    workflows: engine.deps.registry.list().map((w) => ({
      name: w.name,
      version: w.version,
      description: w.spec.description ?? null,
      steps: w.order,
    })),
  }));

  // ---- tasks -----------------------------------------------------------------
  app.post('/tasks', admin, async (req, reply) => {
    const body = parse(CreateTaskRequestSchema, req.body);
    const key = req.headers['idempotency-key'];
    const idem = typeof key === 'string' && key.length > 0 && key.length <= 256 ? key : undefined;
    const { task, created } = await engine.createTask(body, idem);
    return reply.code(created ? 201 : 200).send({ task, created });
  });
  app.get('/tasks', admin, async (req) => {
    const q = parse(ListQuery, req.query);
    return { tasks: await engine.listTasks(q) };
  });
  app.get('/tasks/:id', admin, async (req) => engine.getTask(parse(IdParams, req.params).id));
  app.get('/tasks/:id/history', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    await engine.getTask(id); // 404 for unknown tasks
    return { history: await engine.getHistory(id) };
  });
  app.post('/tasks/:id/cancel', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { reason } = parse(CancelBody, req.body);
    return engine.cancelTask(id, reason);
  });
  app.post('/tasks/:id/pause', admin, async (req) => ({
    task: await engine.pauseTask(parse(IdParams, req.params).id),
  }));
  app.post('/tasks/:id/resume', admin, async (req) => ({
    task: await engine.resumeTask(parse(IdParams, req.params).id),
  }));
  app.post('/tasks/:id/signals', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const sig = parse(SignalRequestSchema, req.body);
    const r = await engine.signal(id, sig);
    return reply.code(r.duplicate ? 200 : 202).send(r);
  });
  app.post('/tasks/:id/steps/:key/resolve', admin, async (req) => {
    const { id, key } = parse(StepParams, req.params);
    const b = parse(ResolveStepRequestSchema, req.body);
    return { step: await engine.resolveStep(id, key, b.action, b.output, b.reason) };
  });

  // ---- worker protocol ---------------------------------------------------------
  app.post('/workers/register', workerAuth, async (req, reply) => {
    const b = parse(RegisterWorkerRequestSchema, req.body);
    return reply.code(201).send(await engine.registerWorker(b.name, b.capabilities));
  });
  app.post('/workers/claim', workerAuth, async (req) => ({
    items: await engine.claim(parse(ClaimRequestSchema, req.body)),
  }));
  app.post('/attempts/:id/heartbeat', workerAuth, async (req) => {
    const { id } = parse(IdParams, req.params);
    return engine.heartbeat(id, parse(LeaseRequestSchema, req.body).leaseToken);
  });
  app.post('/attempts/:id/complete', workerAuth, async (req) => {
    const { id } = parse(IdParams, req.params);
    return engine.complete(id, parse(CompleteRequestSchema, req.body));
  });
  app.post('/attempts/:id/fail', workerAuth, async (req) => {
    const { id } = parse(IdParams, req.params);
    return engine.fail(id, parse(FailRequestSchema, req.body));
  });

  o.extend?.(app, guard(o.apiToken));
  return app;
}
