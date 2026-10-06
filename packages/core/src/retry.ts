import { z } from 'zod';
import { FailureCategorySchema, type FailureCategory } from './failure';
import type { Random } from './ports';

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(100),
  initialDelayMs: z.number().int().min(0),
  backoffCoefficient: z.number().min(1).max(10),
  maxDelayMs: z.number().int().min(0),
  /** Fraction of the delay that may be randomly removed (0 = no jitter, 1 = full jitter). */
  jitter: z.number().min(0).max(1),
  retryOn: z.array(FailureCategorySchema),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  backoffCoefficient: 2,
  maxDelayMs: 60_000,
  jitter: 0.2,
  retryOn: ['TRANSIENT', 'TIMEOUT', 'AMBIGUOUS', 'DEPENDENCY'],
};

/** Categories that are never retried automatically, whatever the policy says. */
const NEVER_RETRY: ReadonlySet<FailureCategory> = new Set(['PERMANENT', 'POLICY']);

export function resolveRetryPolicy(...overrides: Array<Partial<RetryPolicy> | undefined>): RetryPolicy {
  const merged = Object.assign({}, DEFAULT_RETRY_POLICY, ...overrides.filter(Boolean));
  return RetryPolicySchema.parse(merged);
}

/**
 * Delay before attempt `failedAttemptNumber + 1`.
 * base = min(maxDelay, initial * coefficient^(n-1)); delay = base * (1 - jitter * r).
 */
export function computeBackoffMs(policy: RetryPolicy, failedAttemptNumber: number, random: Random): number {
  const exp =
    policy.initialDelayMs * Math.pow(policy.backoffCoefficient, Math.max(0, failedAttemptNumber - 1));
  const base = Math.min(policy.maxDelayMs, exp);
  return Math.max(0, Math.round(base * (1 - policy.jitter * random())));
}

export function isRetryable(
  policy: RetryPolicy,
  category: FailureCategory,
  failedAttemptNumber: number,
): boolean {
  if (NEVER_RETRY.has(category)) return false;
  if (!policy.retryOn.includes(category)) return false;
  return failedAttemptNumber < policy.maxAttempts;
}
