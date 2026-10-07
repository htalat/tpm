import type { FastifyInstance } from 'fastify';
import { streamEvents, type StreamItem } from '@durable/contract';
import { silentLogger } from '@durable/observability';
import { testDatabaseUrl, waitFor } from '@durable/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveEvents } from '../../apps/api/src/live';
import { buildServer } from '../../apps/api/src/server';
import { useHarness } from '../support/harness';

describe('live events (GET /v1/events)', () => {
  const h = useHarness();
  let app: FastifyInstance;
  let live: LiveEvents;
  let baseUrl: string;
  const streams: AbortController[] = [];

  beforeEach(async () => {
    live = new LiveEvents(testDatabaseUrl(), silentLogger);
    await live.start();
    app = await buildServer({
      engine: h.engine,
      logger: silentLogger,
      live,
      keepAliveMs: 200,
      validateResponses: true,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(async () => {
    for (const s of streams.splice(0)) s.abort();
    await app.close();
    await live.stop();
  });

  /** Open a stream and collect items in the background. */
  async function open(query: { taskId?: string; taskType?: string } = {}) {
    const ac = new AbortController();
    streams.push(ac);
    const items: StreamItem[] = [];
    void (async () => {
      try {
        for await (const item of streamEvents({ baseUrl, query, signal: ac.signal })) items.push(item);
      } catch {
        // aborted
      }
    })();
    await waitFor(async () => items[0]?.type === 'ready', { timeoutMs: 5000, message: 'ready' });
    await waitFor(async () => live.subscribers > 0 && live.connected, { timeoutMs: 5000 });
    const events = () => items.flatMap((i) => (i.type === 'event' ? [i.event] : []));
    return { items, events };
  }

  it('streams every committed transition of a task, in order', async () => {
    const s = await open({ taskType: 'example-sequence' });
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    await h.drive(task.id, [h.worker()]);
    await waitFor(async () => s.events().some((e) => e.eventType === 'task.completed'), {
      timeoutMs: 10_000,
      message: 'task.completed event',
    });
    const mine = s.events().filter((e) => e.taskId === task.id);
    expect(mine[0]).toMatchObject({
      kind: 'history',
      eventType: 'task.created',
      taskType: 'example-sequence',
    });
    expect(mine.at(-1)).toMatchObject({ eventType: 'task.completed', newState: 'COMPLETED' });
    // Same order as the durable history.
    const history = (await h.engine.getHistory(task.id)).map((r) => Number(r.id));
    expect(mine.map((e) => e.id)).toEqual(history);
  });

  it('filters by task id and task type', async () => {
    const a = await h.engine.createTask({ type: 'example-sequence', input: null });
    const byTask = await open({ taskId: a.task.id });
    const byType = await open({ taskType: 'example-parallel' });
    await h.engine.cancelTask(a.task.id, 'test');
    const b = await h.engine.createTask({ type: 'example-parallel', input: null });
    await waitFor(async () => byType.events().length > 0 && byTask.events().length > 0, { timeoutMs: 5000 });
    expect(new Set(byTask.events().map((e) => e.taskId))).toEqual(new Set([a.task.id]));
    expect(new Set(byType.events().map((e) => e.taskId))).toEqual(new Set([b.task.id]));
  });

  it('a rolled-back change is never announced', async () => {
    const s = await open();
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    const c = await h.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO task_history (task_id, event_type, payload, "timestamp") VALUES ($1, 'test.rolled_back', '{}', now())`,
        [task.id],
      );
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    await h.engine.cancelTask(task.id, 'after the rollback');
    await waitFor(async () => s.events().some((e) => e.eventType === 'task.cancelled'), { timeoutMs: 5000 });
    expect(s.events().map((e) => e.eventType)).not.toContain('test.rolled_back');
  });

  it('announces watcher decisions only when they change', async () => {
    const s = await open();
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    const upsert = (reason: string) =>
      h.pool.query(
        `INSERT INTO agent_run_watch (task_id, kind, reason, checked_at) VALUES ($1, 'no-action', $2, now())
         ON CONFLICT (task_id) DO UPDATE SET reason = $2, checked_at = now()`,
        [task.id, reason],
      );
    await upsert('waiting for tpm/review-claude');
    await upsert('waiting for tpm/review-claude'); // same: not news
    await upsert('policy: waiting for approval by htalat');
    await waitFor(async () => s.events().filter((e) => e.kind === 'watch').length >= 2, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(
      s
        .events()
        .filter((e) => e.kind === 'watch')
        .map((e) => e.newState),
    ).toEqual(['waiting for tpm/review-claude', 'policy: waiting for approval by htalat']);
  });

  it('requires the admin token when one is configured', async () => {
    await app.close();
    app = await buildServer({ engine: h.engine, logger: silentLogger, live, apiToken: 'secret' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const res = await fetch(`${baseUrl}/v1/events`);
    expect(res.status).toBe(401);
  });
});
