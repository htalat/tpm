import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.PoolClient, 'query'>;

// Return bigint (int8) as number for counts; ids that are bigserial stay small in practice.
pg.types.setTypeParser(20, (v) => Number(v));

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'durable',
    // All sessions use UTC so timestamps are unambiguous.
    options: '-c timezone=UTC',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // A broken idle connection must not crash the process; the pool replaces it.
  pool.on('error', () => undefined);
  return pool;
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization failure, deadlock detected

export function isRetryableDbError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return !!code && RETRYABLE_SQLSTATES.has(code);
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === '23505' && (!constraint || err.constraint === constraint);
}

/**
 * Run `fn` in a READ COMMITTED transaction. Any throw rolls back. If the
 * process dies mid-transaction, PostgreSQL rolls back when the connection
 * drops: nothing partial is ever visible.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // connection is unusable; destroy it on release
    }
    throw e;
  } finally {
    client.release(broken);
  }
}

/** Retry a transaction on deadlock / serialization failure. */
export async function withRetryingTransaction<T>(
  pool: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<T>,
  attempts = 5,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await withTransaction(pool, fn);
    } catch (e) {
      if (i >= attempts || !isRetryableDbError(e)) throw e;
      await new Promise((r) => setTimeout(r, 10 * i + Math.random() * 20));
    }
  }
}
