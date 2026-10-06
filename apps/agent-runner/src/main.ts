import { resolve } from 'node:path';
import { ConfiguredFailureInjector, parseCrashRules } from '@durable/core';
import { createPool, loadEnv } from '@durable/db';
import { Engine } from '@durable/engine';
import {
  createAgentRunnerHandlers,
  AdoPrHost,
  AzureBoardsTracker,
  createSourceResolver,
  GitHubIssuesTracker,
  GitHubPrHost,
  loadAgentRunnerConfig,
  pollPullRequestsOnce,
  syncOnce,
  type Tracker,
} from '@durable/agent-runner';
import { createLogger } from '@durable/observability';
import { HttpTransport, WorkerRuntime } from '@durable/sdk';
import { createRegistry } from '@durable/workflows';

/**
 * agent-runner: GitHub issues labelled / Azure Boards work items tagged `tpm:agent:ready` -> `agent-run` tasks ->
 * coding agent in the local checkout -> PR -> issue labelled `tpm:agent:review`.
 *
 *   sync    poll the tracker (create runs) and the PRs of runs in review (signal outcomes)
 *   worker  execute run steps (talks to the API over HTTP, like any worker)
 *   labels  create the tpm:agent:* labels in every configured GitHub repo (ADO tags need no setup)
 */
loadEnv();
const [cmd] = process.argv.slice(2);
const configPath = resolve(process.env.AGENT_RUNNER_CONFIG ?? 'agent-runner.config.json');
const config = loadAgentRunnerConfig(configPath);
// Trackers (where items come from) and PR hosts (where PRs live); each repo
// in the config picks one of each.
const trackers: Record<string, Tracker> = {
  github: new GitHubIssuesTracker(),
  'azure-boards': new AzureBoardsTracker(),
};
const sources = createSourceResolver({
  trackers,
  hosts: { github: new GitHubPrHost(), ado: new AdoPrHost() },
});
const logger = createLogger(`agent-runner-${cmd ?? 'help'}`);

if (cmd === 'labels') {
  for (const r of config.repos) {
    const tracker = trackers[r.tracker]!;
    if (tracker.ensureLabels) {
      await tracker.ensureLabels(r);
      console.log(`labels ready in ${r.name}`);
    } else {
      console.log(
        `${r.name}: ${r.tracker} uses tags; nothing to create (add the tag tpm:agent:ready to a work item)`,
      );
    }
  }
} else if (cmd === 'sync') {
  const pool = createPool({
    connectionString: process.env.DATABASE_URL!,
    applicationName: 'agent-runner-sync',
    max: 3,
  });
  const engine = new Engine({ pool, registry: createRegistry(), logger });
  let running = true;
  process.on('SIGTERM', () => (running = false));
  process.on('SIGINT', () => (running = false));
  logger.info({ repos: config.repos.map((r) => r.name), interval_ms: config.syncIntervalMs }, 'sync started');
  while (running) {
    try {
      const r = await syncOnce(engine, sources, config);
      if (r.created.length) logger.info({ created: r.created, skipped: r.skipped }, 'runs created');
      const p = await pollPullRequestsOnce(engine, sources, config);
      if (p.signalled || p.errors) logger.info(p, 'pull requests polled');
    } catch (e) {
      logger.error({ err: e }, 'sync failed; will retry');
    }
    if (process.argv.includes('--once')) break;
    await new Promise((r) => setTimeout(r, config.syncIntervalMs));
  }
  await pool.end();
} else if (cmd === 'worker') {
  const runtime = new WorkerRuntime({
    transport: new HttpTransport(
      process.env.API_URL ?? 'http://localhost:3000',
      process.env.WORKER_TOKEN || undefined,
    ),
    name: process.env.WORKER_NAME ?? `agent-runner-${process.pid}`,
    handlers: createAgentRunnerHandlers({ sources, config }),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    leaseMs: Number(process.env.LEASE_MS ?? 60_000),
    logger,
    injector: new ConfiguredFailureInjector(parseCrashRules(process.env.CRASH_AT), (p) => {
      logger.fatal({ point: p }, 'CRASH INJECTED: killing agent-runner worker');
      process.kill(process.pid, 'SIGKILL');
      throw new Error('unreachable');
    }),
  });
  for (;;) {
    try {
      await runtime.register();
      break;
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'register failed; retrying');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  runtime.start();
  logger.info({ worker_id: runtime.id, capabilities: runtime.capabilities }, 'agent-runner worker started');
  const stop = async () => {
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  console.log(`usage: npm run agent-runner -- <sync [--once] | worker | labels>
config: ${configPath} (AGENT_RUNNER_CONFIG)`);
  process.exit(cmd ? 1 : 0);
}
