/**
 * `npm run dev`: API + orchestrator + two workers with prefixed logs.
 * Ctrl-C stops everything. Each component is a separate OS process, exactly as
 * in production, so you can `kill -9` any of them and watch recovery.
 */
import { loadEnv } from '@durable/db';
import { ProcessSupervisor } from '@durable/testkit';

loadEnv();
const sup = new ProcessSupervisor({}, undefined, true);
sup.start('api', 'apps/api/src/main.ts');
sup.start('orchestrator', 'apps/orchestrator/src/main.ts');
sup.start('worker-1', 'apps/worker/src/main.ts', { WORKER_NAME: 'worker-1' });
sup.start('worker-2', 'apps/worker/src/main.ts', { WORKER_NAME: 'worker-2' });
for (const [name, p] of sup.procs) console.log(`[dev] ${name} pid=${p.child.pid}`);
const stop = async () => {
  for (const p of sup.procs.values()) p.child.kill('SIGTERM');
  await Promise.race([
    Promise.all([...sup.procs.values()].map((p) => p.exited)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  await sup.killAll();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
