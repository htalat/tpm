import type { FastifyInstance } from 'fastify';
import { silentLogger } from '@durable/observability';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { useHarness } from '../support/harness';

describe('REST API', () => {
  const h = useHarness();
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  const make = async (opts: { apiToken?: string; workerToken?: string } = {}) => {
    app = await buildServer({ engine: h.engine, logger: silentLogger, validateResponses: true, ...opts });
    return app;
  };

  it('health, readiness and metrics', async () => {
    await make();
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.body).toContain('durable_tasks_created_total');
  });

  it('task lifecycle and worker protocol over HTTP', async () => {
    await make();
    const c = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { type: 'example-approval', input: null },
      headers: { 'idempotency-key': 'k1' },
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().task.id;
    const again = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { type: 'example-approval', input: null },
      headers: { 'idempotency-key': 'k1' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().task.id).toBe(id);
    await h.engine.runUntilIdle();

    const reg = await app.inject({
      method: 'POST',
      url: '/v1/workers/register',
      payload: { name: 'w', capabilities: ['compute'] },
    });
    const { workerId } = reg.json();
    const claim = await app.inject({
      method: 'POST',
      url: '/v1/workers/claim',
      payload: { workerId, capabilities: ['compute'], maxItems: 5 },
    });
    const [item] = claim.json().items;
    expect(item).toMatchObject({ stepKey: 'generate', attemptNumber: 1, idempotencyKey: `${id}:generate` });
    const hb = await app.inject({
      method: 'POST',
      url: `/v1/attempts/${item.attemptId}/heartbeat`,
      payload: { leaseToken: item.leaseToken },
    });
    expect(hb.json().cancelRequested).toBe(false);
    const done = await app.inject({
      method: 'POST',
      url: `/v1/attempts/${item.attemptId}/complete`,
      payload: {
        leaseToken: item.leaseToken,
        output: { ok: 1 },
        artifacts: [{ type: 'report', uri: 's3://bucket/x' }],
      },
    });
    expect(done.json()).toEqual({ status: 'ACCEPTED' });
    const wrongToken = await app.inject({
      method: 'POST',
      url: `/v1/attempts/${item.attemptId}/complete`,
      payload: { leaseToken: '00000000-0000-4000-8000-000000000000', output: null },
    });
    expect(wrongToken.statusCode).toBe(409);
    expect(wrongToken.json().error.code).toBe('LEASE_LOST');

    await h.engine.runUntilIdle();
    const s1 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${id}/signals`,
      payload: { type: 'approval', payload: { approved: false }, deduplicationKey: 'd' },
    });
    expect(s1.statusCode).toBe(202);
    const s2 = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${id}/signals`,
      payload: { type: 'approval', payload: { approved: false }, deduplicationKey: 'd' },
    });
    expect(s2.statusCode).toBe(200);
    expect(s2.json().duplicate).toBe(true);

    const hist = await app.inject({ method: 'GET', url: `/v1/tasks/${id}/history` });
    expect(hist.json().history.map((e: { eventType: string }) => e.eventType)).toContain('signal.received');
    const get = await app.inject({ method: 'GET', url: `/v1/tasks/${id}` });
    expect(get.json().artifacts).toHaveLength(1);
    const cancel = await app.inject({ method: 'POST', url: `/v1/tasks/${id}/cancel`, payload: {} });
    expect(cancel.json().task.status).toBe('CANCELLED');
  });

  it('serves the OpenAPI document; old unversioned paths are gone', async () => {
    await make();
    const doc = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/tasks/{id}');
    expect(doc.paths['/v1/workers/claim'].post.security).toEqual([{ workerToken: [] }]);
    expect((await app.inject({ method: 'GET', url: '/tasks' })).statusCode).toBe(404);
  });

  it('returns structured validation and not-found errors', async () => {
    await make();
    const bad = await app.inject({ method: 'POST', url: '/v1/tasks', payload: { input: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    const nf = await app.inject({ method: 'GET', url: '/v1/tasks/00000000-0000-4000-8000-000000000000' });
    expect(nf.statusCode).toBe(404);
    const badId = await app.inject({ method: 'GET', url: '/v1/tasks/not-a-uuid' });
    expect(badId.statusCode).toBe(400);
    const reserved = await app.inject({
      method: 'POST',
      url: '/v1/tasks/00000000-0000-4000-8000-000000000000/signals',
      payload: { type: '__timer.fired' },
    });
    expect(reserved.statusCode).toBe(400);
  });

  it('limits payload sizes', async () => {
    await make();
    const big = 'x'.repeat(300 * 1024);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { type: 'example-sequence', input: { big } },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    const huge = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { type: 'example-sequence', input: { big: 'x'.repeat(2 * 1024 * 1024) } },
    });
    expect(huge.statusCode).toBe(413);
  });

  it('enforces separate admin and worker tokens when configured', async () => {
    await make({ apiToken: 'admin-secret', workerToken: 'worker-secret' });
    expect((await app.inject({ method: 'GET', url: '/v1/tasks' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/tasks',
          headers: { authorization: 'Bearer worker-secret' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/tasks',
          headers: { authorization: 'Bearer admin-secret' },
        })
      ).statusCode,
    ).toBe(200);
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/workers/register',
      payload: { name: 'w', capabilities: ['x'] },
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(reg.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
