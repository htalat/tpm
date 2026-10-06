import { testDatabaseUrl } from '@durable/testkit';
import { describe, expect, it } from 'vitest';
import { runDurabilityDemo } from '../../apps/cli/src/demo';

describe('durability demo (real processes, SIGKILL)', () => {
  it('passes every check', async () => {
    const lines: string[] = [];
    const ok = await runDurabilityDemo({
      databaseUrl: testDatabaseUrl(),
      apiPort: 3212,
      sleepMs: 4000,
      log: (m) => lines.push(m),
    });
    if (!ok) console.log(lines.join('\n'));
    expect(ok).toBe(true);
  });
});
