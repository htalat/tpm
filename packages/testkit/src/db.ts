import { createPool, loadEnv, migrate, resetDatabase, type Pool } from '@durable/db';

export function testDatabaseUrl(): string {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return url;
}

export async function prepareTestDatabase(url = testDatabaseUrl()): Promise<void> {
  const pool = createPool({ connectionString: url, max: 1 });
  try {
    await resetDatabase(pool);
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

export function createTestPool(max = 20): Pool {
  return createPool({ connectionString: testDatabaseUrl(), max, applicationName: 'durable-test' });
}

/** Remove all rows. TRUNCATE does not fire the history append-only row trigger. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE task_history, artifacts, timers, events, attempts, steps, tasks, workers, idempotency_records,
                    example_external.operations, example_external.call_log RESTART IDENTITY CASCADE`);
}
