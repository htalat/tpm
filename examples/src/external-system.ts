import type { Pool } from '@durable/db';

/**
 * Client for the SIMULATED external system (schema `example_external`).
 *
 * It behaves like a well-designed third-party API: every mutating call takes
 * an idempotency key, and a repeated key returns the original result instead
 * of applying the effect again. It also offers a lookup by key, which is what
 * makes reconciliation of ambiguous attempts possible.
 *
 * Calls are autocommitted and are NOT part of any engine transaction. The gap
 * between "effect applied here" and "completion recorded in the engine" is the
 * real-world failure window this example exists to demonstrate.
 */
export class ExternalSystem {
  constructor(private readonly pool: Pool) {}

  async apply(
    idempotencyKey: string,
    operation: string,
    payload: unknown,
  ): Promise<{ applied: boolean; result: Record<string, unknown> }> {
    const result = { operation, confirmation: `${operation}-${idempotencyKey.slice(-12)}`, payload };
    // One statement = one transaction: the effect and its call-log row are
    // written together, as a real external system would keep its own log.
    // (Two statements could be split by a SIGKILL: effect without log row.)
    const res = await this.pool.query<{ applied: boolean; result: Record<string, unknown> | null }>(
      `WITH ins AS (
         INSERT INTO example_external.operations (idempotency_key, operation, payload, result)
         VALUES ($1, $2, $3, $4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING result
       ), log AS (
         INSERT INTO example_external.call_log (idempotency_key, operation, applied)
         SELECT $1, $2, EXISTS (SELECT 1 FROM ins)
       )
       SELECT EXISTS (SELECT 1 FROM ins) AS applied, (SELECT result FROM ins) AS result`,
      [idempotencyKey, operation, JSON.stringify(payload ?? null), JSON.stringify(result)],
    );
    const row = res.rows[0]!;
    if (row.applied) return { applied: true, result: row.result! };
    return { applied: false, result: (await this.lookup(idempotencyKey))! };
  }

  async lookup(idempotencyKey: string): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query<{ result: Record<string, unknown> }>(
      `SELECT result FROM example_external.operations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return r.rows[0]?.result ?? null;
  }

  /** Effects applied (rows) and calls made per idempotency key. */
  async stats(): Promise<{ effects: number; calls: number; duplicateEffects: number }> {
    const r = await this.pool.query<{ effects: number; calls: number }>(
      `SELECT (SELECT count(*)::int FROM example_external.operations) AS effects,
              (SELECT count(*)::int FROM example_external.call_log) AS calls`,
    );
    const dup = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (SELECT idempotency_key FROM example_external.call_log WHERE applied
        GROUP BY idempotency_key HAVING count(*) > 1) d`,
    );
    return { ...r.rows[0]!, duplicateEffects: dup.rows[0]!.n };
  }
}
