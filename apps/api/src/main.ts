import { ConfiguredFailureInjector, parseCrashRules } from '@durable/core';
import { createPool, loadEnv } from '@durable/db';
import { Engine } from '@durable/engine';
import { createExampleRegistry } from '@durable/examples';
import { createLogger, MetricsRegistry } from '@durable/observability';
import { buildServer } from './server';

loadEnv();
const logger = createLogger('api');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const pool = createPool({ connectionString: url, applicationName: 'durable-api', max: 20 });
const engine = new Engine({
  pool,
  registry: createExampleRegistry(),
  logger,
  metrics: new MetricsRegistry(),
  leaseMs: Number(process.env.LEASE_MS ?? 30_000),
  injector: new ConfiguredFailureInjector(parseCrashRules(process.env.CRASH_AT), (p) => {
    logger.fatal({ point: p }, 'CRASH INJECTED: killing api process');
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  }),
});
engine.registerGauges();
const app = await buildServer({
  engine,
  logger,
  apiToken: process.env.API_TOKEN || undefined,
  workerToken: process.env.WORKER_TOKEN || undefined,
});
const port = Number(process.env.API_PORT ?? 3000);
await app.listen({ port, host: process.env.API_HOST ?? '0.0.0.0' });

const shutdown = async () => {
  logger.info('shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
