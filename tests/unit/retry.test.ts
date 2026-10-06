import { describe, expect, it } from 'vitest';
import { computeBackoffMs, isRetryable, resolveRetryPolicy, seededRandom } from '@durable/core';

describe('retry policy', () => {
  const p = resolveRetryPolicy({
    initialDelayMs: 1000,
    backoffCoefficient: 2,
    maxDelayMs: 5000,
    jitter: 0,
    maxAttempts: 4,
  });

  it('grows exponentially and caps at maxDelay', () => {
    const r = () => 0.5;
    expect([1, 2, 3, 4, 5].map((n) => computeBackoffMs(p, n, r))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });

  it('applies bounded jitter deterministically with a seeded random', () => {
    const j = resolveRetryPolicy({ initialDelayMs: 1000, jitter: 0.5 });
    const a = computeBackoffMs(j, 1, seededRandom(7));
    const b = computeBackoffMs(j, 1, seededRandom(7));
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(500);
    expect(a).toBeLessThanOrEqual(1000);
  });

  it('respects categories and max attempts', () => {
    expect(isRetryable(p, 'TRANSIENT', 1)).toBe(true);
    expect(isRetryable(p, 'TRANSIENT', 4)).toBe(false);
    expect(isRetryable(p, 'PERMANENT', 1)).toBe(false);
    expect(isRetryable(resolveRetryPolicy({ retryOn: ['PERMANENT', 'POLICY'] }), 'PERMANENT', 1)).toBe(false);
  });
});
