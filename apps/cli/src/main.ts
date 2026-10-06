import { readFileSync, existsSync } from 'node:fs';
import { loadEnv } from '@durable/db';
import { ApiClient } from './client';

loadEnv();

const HELP = `durable CLI

Usage: npm run cli -- <command> [args]

  task create <type> [input.json | 'json'] [--idempotency-key K]
  task list [--status S]
  task get <task-id>
  task history <task-id>
  task signal <task-id> <event-type> ['payload-json'] [--correlation K] [--dedup K]
  task cancel <task-id> [reason]
  task pause <task-id>
  task resume <task-id>
  task resolve <task-id> <step-key> <retry|complete|fail> ['output-json']
  task wait <task-id> [--status COMPLETED] [--timeout-ms 60000]
  workflows
  worker run [--capabilities a,b] [--name N]     (runs an example worker in this process)
  db migrate
  demo durability [--sleep-ms 20000]             (the full crash/restart demonstration)

Environment: API_URL (default http://localhost:3000), API_TOKEN.`;

function flags(args: string[]): { pos: string[]; f: Record<string, string> } {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      f[a.slice(2)] = args[i + 1] ?? '';
      i++;
    } else pos.push(a);
  }
  return { pos, f };
}

function json(v: string | undefined): unknown {
  if (v === undefined) return null;
  if (existsSync(v)) return JSON.parse(readFileSync(v, 'utf8'));
  return JSON.parse(v);
}

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  const api = new ApiClient(
    process.env.API_URL ?? 'http://localhost:3000',
    process.env.API_TOKEN || undefined,
  );
  const { pos, f } = flags(rest);

  if (cmd === 'task') {
    switch (sub) {
      case 'create': {
        const headers: Record<string, string> = f['idempotency-key']
          ? { 'idempotency-key': f['idempotency-key'] }
          : {};
        const r = await api.ok<{ task: { id: string; status: string } }>(
          'POST',
          '/tasks',
          { type: pos[0], input: json(pos[1]) },
          headers,
        );
        print(r);
        return 0;
      }
      case 'list':
        print(await api.ok('GET', `/tasks${f.status ? `?status=${encodeURIComponent(f.status)}` : ''}`));
        return 0;
      case 'get':
        print(await api.ok('GET', `/tasks/${pos[0]}`));
        return 0;
      case 'history': {
        const r = await api.ok<{ history: Array<Record<string, unknown>> }>(
          'GET',
          `/tasks/${pos[0]}/history`,
        );
        for (const h of r.history) {
          const p = h.payload as Record<string, unknown>;
          console.log(
            `${String(h.timestamp)}  ${String(h.event_type).padEnd(26)} ${String(h.previous_state ?? '').padStart(9)} -> ${String(h.new_state ?? '').padEnd(9)} ${p.stepKey ? `[${String(p.stepKey)}]` : ''} ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'stepKey')))}`,
          );
        }
        return 0;
      }
      case 'signal':
        print(
          await api.ok('POST', `/tasks/${pos[0]}/signals`, {
            type: pos[1],
            payload: json(pos[2]),
            correlationKey: f.correlation,
            deduplicationKey: f.dedup,
          }),
        );
        return 0;
      case 'cancel':
        print(await api.ok('POST', `/tasks/${pos[0]}/cancel`, { reason: pos[1] }));
        return 0;
      case 'pause':
      case 'resume':
        print(await api.ok('POST', `/tasks/${pos[0]}/${sub}`, {}));
        return 0;
      case 'resolve':
        print(
          await api.ok('POST', `/tasks/${pos[0]}/steps/${encodeURIComponent(pos[1]!)}/resolve`, {
            action: pos[2],
            output: pos[3] ? json(pos[3]) : undefined,
          }),
        );
        return 0;
      case 'wait': {
        const want = f.status ?? 'COMPLETED';
        const deadline = Date.now() + Number(f['timeout-ms'] ?? 60_000);
        for (;;) {
          const t = await api.ok<{ task: { status: string } }>('GET', `/tasks/${pos[0]}`);
          if (t.task.status === want) {
            print(t.task);
            return 0;
          }
          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.task.status) || Date.now() > deadline) {
            console.error(`task is ${t.task.status}`);
            return 1;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }
  if (cmd === 'workflows') {
    print(await api.ok('GET', '/workflows'));
    return 0;
  }
  if (cmd === 'worker' && sub === 'run') {
    if (f.capabilities) process.env.WORKER_CAPABILITIES = f.capabilities;
    if (f.name) process.env.WORKER_NAME = f.name;
    await import('../../worker/src/main');
    return -1; // keep running
  }
  if (cmd === 'db' && sub === 'migrate') {
    await import('../../../packages/db/src/migrate-cli');
    return 0;
  }
  if (cmd === 'demo' && sub === 'durability') {
    const { runDurabilityDemo } = await import('./demo');
    const ok = await runDurabilityDemo({
      databaseUrl: process.env.DATABASE_URL!,
      apiPort: Number(process.env.DEMO_API_PORT ?? 3100),
      sleepMs: Number(f['sleep-ms'] ?? 20_000),
      log: console.log,
    });
    return ok ? 0 : 1;
  }
  console.log(HELP);
  return cmd ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
