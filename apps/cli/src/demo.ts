import { join } from 'node:path';
import { createPool, migrate } from '@durable/db';
import { ProcessSupervisor, REPO_ROOT, waitFor, delay } from '@durable/testkit';
import { ApiClient } from './client';

/**
 * The durability demonstration (README "Definition of Done").
 *
 * Runs REAL processes (API, orchestrator, two workers) and kills them with
 * SIGKILL at the interesting moments. Every check at the end is made against
 * PostgreSQL, the only thing that survives.
 */
export interface DemoOptions {
  databaseUrl: string;
  apiPort: number;
  sleepMs: number;
  log: (m: string) => void;
  echoProcessLogs?: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDurabilityDemo(o: DemoOptions): Promise<boolean> {
  const log = (m: string) => o.log(`\n▶ ${m}`);
  const info = (m: string) => o.log(`  ${m}`);
  const pool = createPool({ connectionString: o.databaseUrl, applicationName: 'durable-demo', max: 4 });
  const api = new ApiClient(`http://127.0.0.1:${o.apiPort}`);
  const logFile = join(REPO_ROOT, 'data', 'logs', `demo-${Date.now()}.log`);
  const sup = new ProcessSupervisor(
    {
      DATABASE_URL: o.databaseUrl,
      API_PORT: String(o.apiPort),
      API_HOST: '127.0.0.1',
      API_URL: `http://127.0.0.1:${o.apiPort}`,
      LEASE_MS: '4000',
      ORCHESTRATOR_POLL_MS: '150',
      ORCHESTRATOR_METRICS_PORT: '0',
      WORKER_CONCURRENCY: '2',
      WORKER_POLL_MS: '150',
      LOG_LEVEL: 'info',
      CRASH_AT: '',
      API_TOKEN: '',
      WORKER_TOKEN: '',
    },
    logFile,
    o.echoProcessLogs,
  );
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    checks.push({ name, ok, detail });
    info(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows as T[];
  const GENERAL = 'compute,echo,aggregate,flaky,slow,publish';
  const startWorker = (name: string, env: Record<string, string> = {}) =>
    sup.start(name, 'apps/worker/src/main.ts', { WORKER_NAME: name, WORKER_CAPABILITIES: GENERAL, ...env });
  const startAll = async (paymentsCrash = false) => {
    if (!sup.isRunning('api')) sup.start('api', 'apps/api/src/main.ts');
    if (!sup.isRunning('orchestrator')) sup.start('orchestrator', 'apps/orchestrator/src/main.ts');
    for (const w of ['worker-1', 'worker-2']) if (!sup.isRunning(w)) startWorker(w);
    // A dedicated worker owns the side-effecting "side-effect" capability.
    if (!sup.isRunning('payments')) {
      startWorker('payments', {
        WORKER_CAPABILITIES: 'side-effect',
        ...(paymentsCrash ? { CRASH_AT: 'AFTER_SIDE_EFFECT' } : {}),
      });
    }
    await waitFor(
      async () => (await api.request('GET', '/ready').catch(() => ({ status: 0 }))).status === 200,
      {
        timeoutMs: 30_000,
        message: 'API ready',
      },
    );
  };
  const stepStatus = async (taskId: string, key: string) =>
    (
      await q<{ status: string }>(`SELECT status FROM steps WHERE task_id = $1 AND key = $2`, [taskId, key])
    )[0]?.status;

  try {
    log('1. Migrate database and start PostgreSQL-backed processes');
    await migrate(pool);
    info(`process logs: ${logFile}`);
    await startAll(true);
    info(`running: ${[...sup.procs.keys()].join(', ')}`);
    info('payments worker started with CRASH_AT=AFTER_SIDE_EFFECT');

    log('2-4. Submit the durability-demo workflow');
    const created = await api.ok<{ task: { id: string } }>('POST', '/tasks', {
      type: 'durability-demo',
      input: { items: 4, workMs: 3000, sleepMs: o.sleepMs },
    });
    const taskId = created.task.id;
    info(`task ${taskId}`);

    log('5. Observe steps completing');
    await waitFor(async () => (await stepStatus(taskId, 'prepare')) === 'COMPLETED', {
      message: 'prepare completed',
    });
    info('prepare: COMPLETED');

    log('6. Kill a worker while it executes a slow map item');
    const victim = await waitFor(
      async () =>
        (
          await q<{ attempt_id: string; lease_token: string; step_id: string; key: string; worker: string }>(
            `SELECT a.id AS attempt_id, a.lease_token, a.step_id, s.key, w.name AS worker
             FROM attempts a JOIN steps s ON s.id = a.step_id JOIN workers w ON w.id = a.worker_id
             WHERE a.task_id = $1 AND a.status = 'RUNNING' AND s.key LIKE 'process[%' AND w.name LIKE 'worker-%'
             ORDER BY a.started_at LIMIT 1`,
            [taskId],
          )
        )[0],
      { message: 'a running map item' },
    );
    await delay(500);
    await sup.kill(victim.worker);
    info(`SIGKILL ${victim.worker} while it held ${victim.key} (attempt ${victim.attempt_id.slice(0, 8)})`);

    log('7-8. Observe the lease expire and another worker recover the item');
    await waitFor(
      async () =>
        (await q(`SELECT 1 FROM attempts WHERE id = $1 AND status = 'EXPIRED'`, [victim.attempt_id])).length >
        0,
      {
        message: 'lease expiry',
      },
    );
    const expired = (
      await q<{ error_type: string }>(`SELECT error_type FROM attempts WHERE id = $1`, [victim.attempt_id])
    )[0]!;
    info(`attempt ${victim.attempt_id.slice(0, 8)} EXPIRED (classified ${expired.error_type})`);
    const recovered = await waitFor(
      async () =>
        (
          await q<{ attempt_number: number; worker: string }>(
            `SELECT a.attempt_number, w.name AS worker FROM attempts a JOIN workers w ON w.id = a.worker_id
             WHERE a.step_id = $1 AND a.status = 'COMPLETED'`,
            [victim.step_id],
          )
        )[0],
      { message: 'recovery', timeoutMs: 60_000 },
    );
    check(
      'killed worker’s item recovered by another worker',
      recovered.worker !== victim.worker,
      `${victim.key} attempt ${recovered.attempt_number} by ${recovered.worker}`,
    );
    startWorker(victim.worker);

    log('8b. The payments worker charges the card, then crashes before reporting success');
    await waitFor(async () => !sup.isRunning('payments'), {
      message: 'payments worker crash',
      timeoutMs: 90_000,
    });
    const chargeAttempt = await waitFor(
      async () =>
        (
          await q<{ id: string; error_type: string }>(
            `SELECT a.id, a.error_type FROM attempts a JOIN steps s ON s.id = a.step_id
             WHERE s.task_id = $1 AND s.key = 'charge' AND a.status = 'EXPIRED'`,
            [taskId],
          )
        )[0],
      { message: 'charge lease expiry' },
    );
    const effectsBefore = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM example_external.operations WHERE idempotency_key = $1`,
        [`${taskId}:charge`],
      )
    )[0]!.n;
    info(
      `external system shows ${effectsBefore} charge; engine classified the lost attempt as ${chargeAttempt.error_type}`,
    );
    check(
      'crash after side effect classified AMBIGUOUS, not failed',
      chargeAttempt.error_type === 'AMBIGUOUS' && effectsBefore === 1,
    );
    startWorker('payments', { WORKER_CAPABILITIES: 'side-effect' });
    await waitFor(async () => (await stepStatus(taskId, 'charge')) === 'COMPLETED', {
      message: 'charge completed',
      timeoutMs: 60_000,
    });
    const chargeOut = (
      await q<{ output: { reconciled?: boolean } }>(
        `SELECT output FROM steps WHERE task_id = $1 AND key = 'charge'`,
        [taskId],
      )
    )[0]!;
    check(
      'retry reconciled with the external system instead of charging again',
      chargeOut.output.reconciled === true,
    );

    log('9. Enter the durable timer');
    await waitFor(async () => (await stepStatus(taskId, 'cooldown')) === 'WAITING', {
      message: 'cooldown waiting',
      timeoutMs: 90_000,
    });
    const timer = (
      await q<{ fire_at: Date; status: string }>(`SELECT fire_at, status FROM timers WHERE task_id = $1`, [
        taskId,
      ])
    )[0]!;
    info(`timer SCHEDULED, fires at ${timer.fire_at.toISOString()}`);

    log('10-11. Kill EVERY Node.js process and wait past the timer');
    await sup.killAll();
    info('all application processes are dead; only PostgreSQL remains');
    const waitMs = Math.max(0, timer.fire_at.getTime() - Date.now()) + 2000;
    info(`waiting ${Math.round(waitMs / 1000)}s ...`);
    await delay(waitMs);
    const stillScheduled = (
      await q<{ status: string }>(`SELECT status FROM timers WHERE task_id = $1`, [taskId])
    )[0]!.status;
    check(
      'timer did not depend on a live process (still SCHEDULED, now overdue)',
      stillScheduled === 'SCHEDULED',
    );

    log('12-13. Restart everything; the timer fires and the workflow resumes');
    await startAll();
    await waitFor(async () => (await stepStatus(taskId, 'cooldown')) === 'COMPLETED', {
      message: 'timer fired',
      timeoutMs: 30_000,
    });
    const fired = (
      await q<{ payload: { latencyMs: number } }>(
        `SELECT payload FROM task_history WHERE task_id = $1 AND event_type = 'timer.fired'`,
        [taskId],
      )
    )[0]!;
    check(
      'timer fired after restart',
      true,
      `latency ${fired.payload.latencyMs}ms (processes were down at fire time)`,
    );

    log('14. Reach the human-approval step');
    await waitFor(async () => (await stepStatus(taskId, 'approval')) === 'WAITING', {
      message: 'approval waiting',
    });
    info('approval: WAITING');

    log('15-16. Kill everything again, then restart later');
    await sup.killAll();
    await delay(3000);
    await startAll();

    log('17. Send the approval event — twice, same deduplication key');
    const sig = {
      type: 'approval',
      payload: { approved: true, by: 'demo-operator' },
      deduplicationKey: `approval-${taskId}`,
    };
    const s1 = await api.ok<{ eventId: string; duplicate: boolean }>('POST', `/tasks/${taskId}/signals`, sig);
    const s2 = await api.ok<{ eventId: string; duplicate: boolean }>('POST', `/tasks/${taskId}/signals`, sig);
    info(`first: duplicate=${s1.duplicate}; second: duplicate=${s2.duplicate}`);
    check('duplicate signal recognised', !s1.duplicate && s2.duplicate && s1.eventId === s2.eventId);

    log('18-20. Execution continues; the unreliable step fails twice with persisted backoff');
    await waitFor(async () => (await stepStatus(taskId, 'unreliable')) === 'COMPLETED', {
      message: 'unreliable completed',
      timeoutMs: 60_000,
    });
    const retries = await q<{ payload: { nextAttemptAt: string; delayMs: number } }>(
      `SELECT h.payload FROM task_history h JOIN steps s ON s.id = h.step_id
       WHERE h.task_id = $1 AND s.key = 'unreliable' AND h.event_type = 'step.retrying' ORDER BY h.id`,
      [taskId],
    );
    for (const r of retries) info(`retry scheduled in ${r.payload.delayMs}ms at ${r.payload.nextAttemptAt}`);
    check(
      'retryable failure retried with persisted backoff',
      retries.length === 2,
      `${retries.length} retries`,
    );

    log('21. Complete the workflow');
    const final = await waitFor(
      async () => {
        const t = (await q<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [taskId]))[0]!;
        return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status) ? t : undefined;
      },
      { message: 'task finished', timeoutMs: 60_000 },
    );
    check('workflow COMPLETED', final.status === 'COMPLETED', final.status);

    log('22. Full durable history');
    const history = await api.ok<{
      history: Array<{ event_type: string; new_state: string | null; payload: { stepKey?: string } }>;
    }>('GET', `/tasks/${taskId}/history`);
    for (const h of history.history)
      info(`${h.event_type.padEnd(24)} ${(h.new_state ?? '').padEnd(10)} ${h.payload.stepKey ?? ''}`);

    log('23-25. Verify invariants against PostgreSQL');
    const received = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM task_history WHERE task_id = $1 AND event_type = 'signal.received'`,
        [taskId],
      )
    )[0]!.n;
    const approvalCompletions = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM task_history h JOIN steps s ON s.id = h.step_id WHERE h.task_id = $1 AND s.key = 'approval' AND h.event_type = 'step.completed'`,
        [taskId],
      )
    )[0]!.n;
    check(
      'duplicate signals did not duplicate execution',
      received === 1 && approvalCompletions === 1,
      `${received} event(s), ${approvalCompletions} approval transition(s)`,
    );

    const stale = await api.request<{ error: { code: string } }>(
      'POST',
      `/attempts/${victim.attempt_id}/complete`,
      {
        leaseToken: victim.lease_token,
        output: { stale: true },
      },
    );
    const victimStep = (
      await q<{ output: { stale?: boolean } }>(`SELECT output FROM steps WHERE id = $1`, [victim.step_id])
    )[0]!;
    check(
      'stale worker could not overwrite the newer attempt',
      stale.status === 409 && stale.body.error.code === 'LEASE_LOST' && !victimStep.output?.stale,
      `HTTP ${stale.status} ${stale.body.error?.code}`,
    );

    const multi = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM (SELECT step_id FROM attempts WHERE task_id = $1 AND status = 'COMPLETED' GROUP BY step_id HAVING count(*) > 1) x`,
        [taskId],
      )
    )[0]!.n;
    check('no step has more than one completed attempt', multi === 0);

    const chargeKey = `${taskId}:charge`;
    const effects = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM example_external.operations WHERE idempotency_key = $1`,
        [chargeKey],
      )
    )[0]!.n;
    const calls = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM example_external.call_log WHERE idempotency_key = $1`,
        [chargeKey],
      )
    )[0]!.n;
    check(
      'charge side effect occurred exactly once (idempotency key cooperation)',
      effects === 1,
      `${effects} effect(s) from ${calls} call(s)`,
    );
    const publishEffects = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM example_external.operations WHERE idempotency_key = $1`,
        [`${taskId}:publish`],
      )
    )[0]!.n;
    check('publish side effect occurred exactly once', publishEffects === 1);

    const failed = checks.filter((c) => !c.ok);
    log(failed.length === 0 ? 'DEMO PASSED' : `DEMO FAILED: ${failed.map((c) => c.name).join('; ')}`);
    info(`inspect: npm run cli -- task history ${taskId}`);
    return failed.length === 0;
  } finally {
    await sup.killAll();
    sup.close();
    await pool.end();
  }
}
