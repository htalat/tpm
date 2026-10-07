import { seededRandom } from '@durable/core';
import {
  createTestPool,
  delay,
  ProcessSupervisor,
  REPO_ROOT,
  testDatabaseUrl,
  truncateAll,
  waitFor,
} from '@durable/testkit';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, createClient, isReady } from '../../apps/cli/src/client';

/**
 * Chaos test with REAL processes. Seeded: the same CHAOS_SEED replays the same
 * sequence of kills/restarts/duplicate signals (process timing still varies,
 * but every injected decision is reproducible).
 */
const SEED = Number(process.env.CHAOS_SEED ?? 20261006);
const ITEMS = 80;
const API_PORT = 3211;

describe('chaos', () => {
  it(`reaches the correct final state under random process kills (seed ${SEED})`, async () => {
    const rng = seededRandom(SEED);
    const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)]!;
    const pool = createTestPool(4);
    await truncateAll(pool);
    const baseUrl = `http://127.0.0.1:${API_PORT}`;
    const api = createClient({ baseUrl });
    const sup = new ProcessSupervisor(
      {
        DATABASE_URL: testDatabaseUrl(),
        API_PORT: String(API_PORT),
        API_HOST: '127.0.0.1',
        API_URL: `http://127.0.0.1:${API_PORT}`,
        LEASE_MS: '2000',
        ORCHESTRATOR_POLL_MS: '100',
        ORCHESTRATOR_METRICS_PORT: '0',
        WORKER_CAPABILITIES: 'chaos-effect',
        WORKER_CONCURRENCY: '3',
        WORKER_POLL_MS: '100',
        LOG_LEVEL: 'warn',
        CRASH_AT: '',
        API_TOKEN: '',
        WORKER_TOKEN: '',
      },
      join(REPO_ROOT, 'data', 'logs', `chaos-${SEED}-${Date.now()}.log`),
    );
    const orchestrators = ['orch-1', 'orch-2'];
    const workers = ['w-1', 'w-2', 'w-3', 'w-4'];
    const startWorker = (name: string) =>
      sup.start(name, 'apps/worker/src/main.ts', {
        WORKER_NAME: name,
        // Some incarnations crash right after their side effect (ambiguous outcomes).
        CRASH_AT: rng() < 0.3 ? `AFTER_SIDE_EFFECT:${1 + Math.floor(rng() * 4)}` : '',
      });
    const ensureAll = () => {
      if (!sup.isRunning('api')) sup.start('api', 'apps/api/src/main.ts');
      for (const o of orchestrators) if (!sup.isRunning(o)) sup.start(o, 'apps/orchestrator/src/main.ts');
      for (const w of workers) if (!sup.isRunning(w)) startWorker(w);
    };
    const stats = { workerKills: 0, orchestratorKills: 0, apiKills: 0, duplicateSignals: 0 };
    try {
      ensureAll();
      await waitFor(async () => isReady(baseUrl), { timeoutMs: 30_000 });
      const { task } = await api.call('createTask', {
        body: { type: 'chaos', input: { items: ITEMS, maxDelayMs: 2500 } },
      });
      const go = (n: number, key: string) =>
        api.call('signalTask', {
          params: { id: task.id },
          body: { type: 'go', payload: { n }, deduplicationKey: key },
        });

      // --- chaos phase -------------------------------------------------------
      const until = Date.now() + 25_000;
      while (Date.now() < until) {
        await delay(300 + Math.floor(rng() * 700));
        const r = rng();
        if (r < 0.45) {
          const w = pick(workers);
          if (sup.isRunning(w)) {
            await sup.kill(w);
            stats.workerKills++;
          }
        } else if (r < 0.65) {
          const o = pick(orchestrators);
          if (sup.isRunning(o)) {
            await sup.kill(o);
            stats.orchestratorKills++;
          }
        } else if (r < 0.72) {
          await sup.kill('api');
          stats.apiKills++;
        } else if (r < 0.85) {
          // duplicate deliveries of the same event, sometimes before the step waits for it
          const res = await go(1, 'go-1').catch(() => null);
          if (res) stats.duplicateSignals++;
        }
        if (rng() < 0.6) ensureAll();
      }

      // --- recovery phase: stop injecting, everything up --------------------
      ensureAll();
      await waitFor(async () => isReady(baseUrl), { timeoutMs: 30_000 });
      for (let i = 0; i < 3; i++) {
        await go(1, 'go-1'); // a known duplicate is accepted even after completion (no throw)
      }
      // A second, distinct "go" must not drive the single wait step twice
      // (409 if the task already finished, which is also correct).
      const go2 = await go(2, 'go-2').then(
        () => 202,
        (e: unknown) => (e instanceof ApiError ? e.status : 0),
      );
      expect([202, 409]).toContain(go2);

      const final = await waitFor(
        async () => {
          if (Math.random() < 0.2) ensureAll(); // processes that crashed via CRASH_AT come back
          const t = (await pool.query(`SELECT status, output FROM tasks WHERE id = $1`, [task.id])).rows[0];
          return ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(t.status) ? t : undefined;
        },
        { timeoutMs: 180_000, intervalMs: 500, message: 'chaos task to finish' },
      );

      // --- verification ------------------------------------------------------
      expect(final.status).toBe('COMPLETED');
      expect(final.output).toEqual({ items: ITEMS });

      const steps = (await pool.query(`SELECT key, status FROM steps WHERE task_id = $1`, [task.id])).rows;
      expect(steps.filter((s) => s.status !== 'COMPLETED')).toEqual([]);
      expect(steps).toHaveLength(4 + ITEMS);

      // every step completed exactly once (history) and by exactly one attempt
      const perStep = (
        await pool.query(
          `SELECT s.key,
                  (SELECT count(*)::int FROM task_history h WHERE h.step_id = s.id AND h.event_type = 'step.completed') AS completions,
                  (SELECT count(*)::int FROM attempts a WHERE a.step_id = s.id AND a.status = 'COMPLETED') AS completed_attempts
           FROM steps s WHERE s.task_id = $1`,
          [task.id],
        )
      ).rows;
      expect(perStep.filter((r) => r.completions !== 1)).toEqual([]);
      expect(perStep.filter((r) => r.completed_attempts > 1)).toEqual([]);

      // idempotent side effects: one applied effect per step key, despite retries
      const effects = (
        await pool.query(
          `SELECT idempotency_key, count(*) FILTER (WHERE applied)::int AS applied, count(*)::int AS calls
           FROM example_external.call_log GROUP BY idempotency_key`,
        )
      ).rows;
      expect(effects).toHaveLength(ITEMS + 1);
      expect(effects.filter((e) => e.applied !== 1)).toEqual([]);
      const ops = (await pool.query(`SELECT count(*)::int AS n FROM example_external.operations`)).rows[0].n;
      expect(ops).toBe(ITEMS + 1);

      // duplicate events: one stored event for go-1, the wait step consumed exactly one event
      const events = (
        await pool.query(
          `SELECT deduplication_key, consumed_at FROM events WHERE task_id = $1 AND event_type = 'go'`,
          [task.id],
        )
      ).rows;
      expect(events.filter((e) => e.deduplication_key === 'go-1')).toHaveLength(1);
      expect(events.filter((e) => e.consumed_at !== null)).toHaveLength(1);

      const attempts = (
        await pool.query(
          `SELECT status, count(*)::int AS n FROM attempts WHERE task_id = $1 GROUP BY status`,
          [task.id],
        )
      ).rows;
      const expired = attempts.find((a) => a.status === 'EXPIRED')?.n ?? 0;
      console.log(
        JSON.stringify({
          seed: SEED,
          ...stats,
          attempts,
          totalCalls: effects.reduce((s, e) => s + e.calls, 0),
        }),
      );
      // chaos actually happened
      expect(stats.workerKills + stats.orchestratorKills).toBeGreaterThan(5);
      expect(expired).toBeGreaterThan(0);
    } finally {
      await sup.killAll();
      sup.close();
      await pool.end();
    }
  });
});
