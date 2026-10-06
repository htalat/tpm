import { createServer } from 'node:http';
import { ConfiguredFailureInjector, parseCrashRules } from '@durable/core';
import { createPool, loadEnv } from '@durable/db';
import { Engine } from '@durable/engine';
import { createRegistry } from '@durable/workflows';
import { createLogger, MetricsRegistry } from '@durable/observability';

/**
 * The orchestrator process. It keeps NO correctness-critical state in memory:
 * each loop iteration reads due work from PostgreSQL and persists its results
 * before moving on. Kill it at any moment; start one or many again.
 */
loadEnv();
const logger = createLogger('orchestrator');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = createPool({ connectionString: url, applicationName: 'durable-orchestrator', max: 5 });
const metrics = new MetricsRegistry();
const engine = new Engine({
  pool,
  registry: createRegistry(),
  logger,
  metrics,
  leaseMs: Number(process.env.LEASE_MS ?? 30_000),
  injector: new ConfiguredFailureInjector(parseCrashRules(process.env.CRASH_AT), (p) => {
    logger.fatal({ point: p }, 'CRASH INJECTED: killing orchestrator');
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  }),
});
engine.registerGauges();
const pollMs = Number(process.env.ORCHESTRATOR_POLL_MS ?? 200);

const metricsPort = Number(process.env.ORCHESTRATOR_METRICS_PORT ?? 0);
if (metricsPort) {
  createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', 'text/plain; version=0.0.4');
      res.end(await metrics.render());
    } else res.writeHead(req.url === '/health' ? 200 : 404).end();
  }).listen(metricsPort);
}

let running = true;
const stop = () => {
  running = false;
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

logger.info({ poll_ms: pollMs }, 'orchestrator started');
let backoff = pollMs;
while (running) {
  try {
    const work = await engine.tick();
    backoff = pollMs;
    if (work === 0) await new Promise((r) => setTimeout(r, pollMs));
  } catch (e) {
    // e.g. database temporarily unavailable: nothing is lost, just retry later.
    logger.error({ err: e }, 'tick failed; backing off');
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 10_000);
  }
}
await pool.end();
logger.info('orchestrator stopped');
