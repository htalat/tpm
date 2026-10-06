import { join } from 'node:path';
import { ConfiguredFailureInjector, parseCrashRules } from '@durable/core';
import { createPool, loadEnv } from '@durable/db';
import { ExternalSystem, exampleHandlers } from '@durable/examples';
import { createLogger } from '@durable/observability';
import { FileArtifactStore, HttpTransport, WorkerRuntime, type WorkerHandler } from '@durable/sdk';

/**
 * Example worker process. Talks to the engine ONLY through the HTTP worker
 * protocol. The pool here is for the simulated external system, not the engine.
 */
loadEnv();
const name = process.env.WORKER_NAME ?? `worker-${process.pid}`;
const logger = createLogger('worker').child({ worker_name: name });
const external = new ExternalSystem(
  createPool({
    connectionString: process.env.DATABASE_URL!,
    applicationName: 'example-external-client',
    max: 4,
  }),
);
const all: Record<string, WorkerHandler<never, unknown>> = exampleHandlers(external);
const wanted = (process.env.WORKER_CAPABILITIES ?? Object.keys(all).join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const handlers = Object.fromEntries(wanted.filter((c) => all[c]).map((c) => [c, all[c]!]));

const runtime = new WorkerRuntime({
  transport: new HttpTransport(
    process.env.API_URL ?? 'http://localhost:3000',
    process.env.WORKER_TOKEN || undefined,
  ),
  name,
  handlers,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  leaseMs: Number(process.env.LEASE_MS ?? 10_000),
  pollIntervalMs: Number(process.env.WORKER_POLL_MS ?? 250),
  logger,
  artifacts: new FileArtifactStore(process.env.ARTIFACT_DIR ?? join(process.cwd(), 'data', 'artifacts')),
  injector: new ConfiguredFailureInjector(parseCrashRules(process.env.CRASH_AT), (p) => {
    logger.fatal({ point: p }, 'CRASH INJECTED: killing worker');
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  }),
});

// Registration retries until the API is reachable.
for (;;) {
  try {
    await runtime.register();
    break;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'register failed; retrying');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
logger.info({ worker_id: runtime.id, capabilities: runtime.capabilities }, 'worker started');
runtime.start();
const stop = async () => {
  logger.info('draining');
  await runtime.stop();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
